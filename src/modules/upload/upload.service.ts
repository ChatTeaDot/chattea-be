import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "crypto";
import sharp from "sharp";
import { validate as isUuid } from "uuid";
import { R2ObjectStore, UploadObjectValidationError } from "./r2-object-store";
import { UploadRepository } from "./upload.repository";
import { UploadMaintenanceBatchResult } from "./upload-state.types";
import { CreateUploadPayload, VerifiedUploadPayload } from "./upload.types";

@Injectable()
export class UploadService {
  constructor(
    private readonly uploadRepository: UploadRepository,
    private readonly objectStore: R2ObjectStore,
    private readonly configService: ConfigService,
  ) {}

  createUpload = async (input: {
    userId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<CreateUploadPayload> => {
    const metadata = validateUploadInput(input);
    this.profilePublicBaseUrl();
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + UPLOAD_URL_TTL_MS);
    const stagingKey = `profile-staging/${input.userId}/${id}.${metadata.extension}`;
    const putUrl = await this.objectStore.createPresignedPutUrl({
      key: stagingKey,
      contentType: metadata.contentType,
      sizeBytes: metadata.sizeBytes,
      expiresInSeconds: UPLOAD_URL_TTL_MS / 1000,
    });
    await this.uploadRepository.createPending({
      id,
      userId: input.userId,
      stagingKey,
      expectedContentType: metadata.contentType,
      expectedSizeBytes: metadata.sizeBytes,
      expiresAt,
      now,
    });
    return { id, putUrl, expiresAt: expiresAt.toISOString() };
  };

  finalizeUpload = async (userId: string, uploadId: string): Promise<VerifiedUploadPayload> => {
    if (!isUuid(userId)) throw new Error("UPLOAD_USER_ID_INVALID");
    if (!isUuid(uploadId)) throw new Error("UPLOAD_ID_INVALID");
    const now = new Date();
    const claim = await this.uploadRepository.claimFinalize({
      userId,
      uploadId,
      now,
      leaseExpiresAt: new Date(now.getTime() + FINALIZE_LEASE_MS),
    });
    if (claim.kind === "verified") return finalizedPayload(claim.upload);
    if (claim.kind === "expired") throw new Error("UPLOAD_EXPIRED");
    if (claim.kind === "busy") throw new Error("UPLOAD_PROCESSING");

    const upload = claim.upload;
    const processingLeaseExpiresAt = finalizeLease(upload);
    let inputBytes: Buffer;
    try {
      inputBytes = await this.objectStore.readStagingObject({
        key: upload.stagingKey,
        expectedContentType: upload.expectedContentType,
        expectedSizeBytes: upload.expectedSizeBytes,
      });
    } catch (error) {
      if (error instanceof UploadObjectValidationError) {
        await this.uploadRepository.markFailed({
          uploadId: upload.id,
          failureCode: error.message,
          processingLeaseExpiresAt,
          now,
        });
        throw error;
      }
      await this.uploadRepository.releaseFinalizeLease({ uploadId: upload.id, processingLeaseExpiresAt, now });
      throw new Error("UPLOAD_OBJECT_UNAVAILABLE");
    }

    let normalized: Buffer;
    try {
      normalized = await normalizeProfileImage(inputBytes, upload.expectedContentType);
    } catch {
      await this.uploadRepository.markFailed({
        uploadId: upload.id,
        failureCode: "UPLOAD_IMAGE_INVALID",
        processingLeaseExpiresAt,
        now,
      });
      throw new Error("UPLOAD_IMAGE_INVALID");
    }

    const contentHash = createHash("sha256").update(normalized).digest("hex");
    const finalKey = `profiles/${userId}/${upload.id}/${contentHash}.jpg`;
    const publicUrl = `${this.profilePublicBaseUrl()}/${finalKey}`;
    await this.uploadRepository.prepareFinalObject({
      uploadId: upload.id,
      userId,
      finalKey,
      publicUrl,
      finalContentType: FINAL_CONTENT_TYPE,
      finalSizeBytes: normalized.byteLength,
      processingLeaseExpiresAt,
      now,
    });
    try {
      await this.objectStore.putFinalObject({ key: finalKey, body: normalized, contentType: FINAL_CONTENT_TYPE });
    } catch {
      await this.uploadRepository.releaseFinalizeLease({ uploadId: upload.id, processingLeaseExpiresAt, now });
      throw new Error("UPLOAD_FINAL_WRITE_FAILED");
    }
    const verified = await this.uploadRepository.markVerified({
      uploadId: upload.id,
      userId,
      finalKey,
      publicUrl,
      finalContentType: FINAL_CONTENT_TYPE,
      finalSizeBytes: normalized.byteLength,
      processingLeaseExpiresAt,
      now,
    });
    const stagingDeleted = await this.objectStore.deleteObject(upload.stagingKey).then(
      () => true,
      () => false,
    );
    if (stagingDeleted) await this.uploadRepository.markStagingDeleted(upload.id, now);
    return finalizedPayload(verified);
  };

  cleanupExpiredStagingBatch = async (input: { now: Date; limit: number }): Promise<UploadMaintenanceBatchResult> => {
    const limit = validateBatchLimit(input.limit);
    const claimed = await this.uploadRepository.claimCleanupBatch({
      now: input.now,
      limit,
      leaseExpiresAt: new Date(input.now.getTime() + CLEANUP_LEASE_MS),
    });
    const settledOutcomes = await Promise.allSettled(
      claimed.jobs.map(async (upload) => {
        const stagingRequired = !upload.stagingDeletedAt;
        const finalRequired = Boolean(upload.finalDeletionPendingAt && !upload.finalDeletedAt);
        const [stagingDeleted, finalDeleted] = await Promise.all([
          stagingRequired ? deleteObject(this.objectStore, upload.stagingKey) : true,
          finalRequired && upload.finalKey ? deleteObject(this.objectStore, upload.finalKey) : true,
        ]);
        const completed = stagingDeleted && finalDeleted;
        const cleanupLeaseExpiresAt = upload.cleanupLeaseExpiresAt;
        if (!cleanupLeaseExpiresAt) throw new Error("UPLOAD_CLEANUP_LEASE_INVALID");
        await this.uploadRepository.applyCleanupResult({
          uploadId: upload.id,
          cleanupLeaseExpiresAt,
          stagingDeleted: stagingRequired && stagingDeleted,
          finalDeleted: finalRequired && finalDeleted,
          nextAttemptAt: completed ? null : new Date(input.now.getTime() + cleanupRetryDelay(upload.cleanupAttempts)),
          now: input.now,
        });
        return completed ? ("succeeded" as const) : ("retry" as const);
      }),
    );
    const outcomes = settledOutcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
    return {
      claimed: outcomes.length,
      succeeded: outcomes.filter((outcome) => outcome === "succeeded").length,
      retryScheduled: outcomes.filter((outcome) => outcome === "retry").length,
      permanentlyFailed: 0,
      hasMore: claimed.hasMore,
    };
  };

  private profilePublicBaseUrl = (): string => {
    const configured = this.configService.get<string>("R2_PUBLIC_BASE_URL")?.trim().replace(/\/+$/, "");
    if (!configured) throw new Error("R2_CONFIG_REQUIRED");
    try {
      const parsed = new URL(`${configured}/`);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        parsed.href !== `${configured}/`
      ) {
        throw new Error("R2_CONFIG_REQUIRED");
      }
    } catch {
      throw new Error("R2_CONFIG_REQUIRED");
    }
    return configured;
  };
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 24_000_000;
const MAX_IMAGE_DIMENSION = 4096;
const MAX_OUTPUT_DIMENSION = 2048;
const UPLOAD_URL_TTL_MS = 5 * 60 * 1000;
const FINALIZE_LEASE_MS = 2 * 60 * 1000;
const CLEANUP_LEASE_MS = 60 * 1000;
const FINAL_CONTENT_TYPE = "image/jpeg";
const ALLOWED_IMAGE_TYPES = new Map<string, readonly [string, ...string[]]>([
  ["image/jpeg", ["jpg", "jpeg"]],
  ["image/png", ["png"]],
  ["image/webp", ["webp"]],
  ["image/gif", ["gif"]],
]);
const DECODED_FORMAT_BY_CONTENT_TYPE = new Map([
  ["image/jpeg", "jpeg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

const validateUploadInput = (input: {
  userId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): { contentType: string; extension: string; sizeBytes: number } => {
  const filename = input.filename.trim();
  const contentType = input.contentType.trim().toLowerCase();
  if (!filename) throw new Error("UPLOAD_FILENAME_REQUIRED");
  if (!isUuid(input.userId)) throw new Error("UPLOAD_USER_ID_INVALID");
  const allowedExtensions = ALLOWED_IMAGE_TYPES.get(contentType);
  if (!allowedExtensions) throw new Error("UPLOAD_CONTENT_TYPE_UNSUPPORTED");
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error("UPLOAD_SIZE_INVALID");
  }
  const extension = safeExtension(filename);
  if (!extension || !allowedExtensions.includes(extension)) throw new Error("UPLOAD_EXTENSION_UNSUPPORTED");
  return { contentType, extension: allowedExtensions[0], sizeBytes: input.sizeBytes };
};

const normalizeProfileImage = async (bytes: Buffer, expectedContentType: string): Promise<Buffer> => {
  const image = sharp(bytes, { animated: false, failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS });
  const metadata = await image.metadata();
  if (!metadata.format || metadata.format !== DECODED_FORMAT_BY_CONTENT_TYPE.get(expectedContentType)) {
    throw new Error("UPLOAD_IMAGE_INVALID");
  }
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width > MAX_IMAGE_DIMENSION ||
    metadata.height > MAX_IMAGE_DIMENSION
  ) {
    throw new Error("UPLOAD_IMAGE_DIMENSIONS_INVALID");
  }
  return image
    .rotate()
    .resize({ width: MAX_OUTPUT_DIMENSION, height: MAX_OUTPUT_DIMENSION, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
};

const finalizedPayload = (upload: {
  id: string;
  publicUrl: string | null;
  finalContentType: string | null;
  finalSizeBytes: number | null;
}): VerifiedUploadPayload => {
  if (!upload.publicUrl || !upload.finalContentType || !upload.finalSizeBytes) {
    throw new Error("UPLOAD_VERIFIED_METADATA_INVALID");
  }
  return {
    id: upload.id,
    publicUrl: upload.publicUrl,
    contentType: upload.finalContentType,
    sizeBytes: upload.finalSizeBytes,
  };
};

const finalizeLease = (upload: { processingLeaseExpiresAt: Date | null }): Date => {
  if (!upload.processingLeaseExpiresAt) throw new Error("UPLOAD_PROCESSING_LEASE_INVALID");
  return upload.processingLeaseExpiresAt;
};

const validateBatchLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("UPLOAD_BATCH_LIMIT_INVALID");
  return limit;
};

const cleanupRetryDelay = (attempt: number): number => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000);

const deleteObject = (objectStore: R2ObjectStore, key: string): Promise<boolean> =>
  objectStore.deleteObject(key).then(
    () => true,
    () => false,
  );

const safeExtension = (filename: string): string | null => {
  if (filename.length > 255 || filename.includes("/") || filename.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(filename) || filename.includes("..")) return null;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 1) return null;
  const extension = filename.slice(dotIndex + 1);
  return /^[A-Za-z0-9]{1,5}$/.test(extension) ? extension.toLowerCase() : null;
};
