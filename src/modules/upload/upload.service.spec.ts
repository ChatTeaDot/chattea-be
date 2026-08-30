import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { createHash } from "crypto";
import sharp from "sharp";
import { ProfileUpload } from "src/modules/database/schema";
import { R2ObjectStore, UploadObjectValidationError } from "./r2-object-store";
import { UploadRepository } from "./upload.repository";
import { UploadService } from "./upload.service";

const USER_ID = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
const UPLOAD_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-08-29T00:00:00.000Z");

const createDeferred = () => {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      if (!resolvePromise) throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise();
    },
  };
};

const uploadRow = (input: Partial<ProfileUpload> = {}): ProfileUpload => ({
  id: UPLOAD_ID,
  userId: USER_ID,
  status: "processing",
  stagingKey: `profile-staging/${USER_ID}/${UPLOAD_ID}.png`,
  finalKey: null,
  expectedContentType: "image/png",
  expectedSizeBytes: 68,
  finalContentType: null,
  finalSizeBytes: null,
  publicUrl: null,
  expiresAt: new Date("2026-08-29T00:05:00.000Z"),
  processingLeaseExpiresAt: new Date("2026-08-29T00:02:00.000Z"),
  cleanupLeaseExpiresAt: null,
  cleanupAttempts: 0,
  failureCode: null,
  stagingDeletedAt: null,
  finalDeletionPendingAt: null,
  finalDeletedAt: null,
  verifiedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...input,
});

const createService = () => {
  const repository = {
    applyCleanupResult: jest.fn<UploadRepository["applyCleanupResult"]>().mockResolvedValue(undefined),
    claimCleanupBatch: jest.fn<UploadRepository["claimCleanupBatch"]>().mockResolvedValue({ jobs: [], hasMore: false }),
    claimFinalize: jest.fn<UploadRepository["claimFinalize"]>(),
    createPending: jest.fn<UploadRepository["createPending"]>(),
    markFailed: jest.fn<UploadRepository["markFailed"]>().mockResolvedValue(undefined),
    markStagingDeleted: jest.fn<UploadRepository["markStagingDeleted"]>().mockResolvedValue(undefined),
    markVerified: jest.fn<UploadRepository["markVerified"]>(),
    prepareFinalObject: jest.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined),
    releaseFinalizeLease: jest.fn<UploadRepository["releaseFinalizeLease"]>().mockResolvedValue(undefined),
  };
  const objectStore = {
    createPresignedPutUrl: jest
      .fn<R2ObjectStore["createPresignedPutUrl"]>()
      .mockResolvedValue("https://account.r2.cloudflarestorage.com/staging?signed=1"),
    deleteObject: jest.fn<R2ObjectStore["deleteObject"]>().mockResolvedValue(undefined),
    putFinalObject: jest.fn<R2ObjectStore["putFinalObject"]>().mockResolvedValue(undefined),
    readStagingObject: jest.fn<R2ObjectStore["readStagingObject"]>(),
  };
  const config = {
    get: (key: string) => (key === "R2_PUBLIC_BASE_URL" ? "https://images.example.com" : undefined),
  } as ConfigService;
  const service = new UploadService(
    repository as unknown as UploadRepository,
    objectStore as unknown as R2ObjectStore,
    config,
  );
  return { objectStore, repository, service };
};

describe("UploadService", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("creates an expiring staging upload without exposing a public URL", async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { objectStore, repository, service } = createService();

    const result = await service.createUpload({
      userId: USER_ID,
      filename: "photo.png",
      contentType: "image/png",
      sizeBytes: 68,
    });

    expect(result).toEqual({
      id: expect.any(String),
      putUrl: "https://account.r2.cloudflarestorage.com/staging?signed=1",
      expiresAt: "2026-08-29T00:05:00.000Z",
    });
    expect(result).not.toHaveProperty("publicUrl");
    expect(objectStore.createPresignedPutUrl).toHaveBeenCalledWith({
      key: `profile-staging/${USER_ID}/${result.id}.png`,
      contentType: "image/png",
      sizeBytes: 68,
      expiresInSeconds: 300,
    });
    expect(repository.createPending).toHaveBeenCalledWith({
      id: result.id,
      userId: USER_ID,
      stagingKey: `profile-staging/${USER_ID}/${result.id}.png`,
      expectedContentType: "image/png",
      expectedSizeBytes: 68,
      expiresAt: new Date("2026-08-29T00:05:00.000Z"),
      now: NOW,
    });
    jest.useRealTimers();
  });

  it.each([
    ["unsupported MIME", { filename: "photo.svg", contentType: "image/svg+xml", sizeBytes: 68 }],
    ["mismatched extension", { filename: "photo.jpg", contentType: "image/png", sizeBytes: 68 }],
    ["unsafe filename", { filename: "../photo.png", contentType: "image/png", sizeBytes: 68 }],
    ["empty body", { filename: "photo.png", contentType: "image/png", sizeBytes: 0 }],
    ["oversized body", { filename: "photo.png", contentType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 }],
  ])("rejects %s before creating a pending upload", async (_label, metadata) => {
    const { objectStore, repository, service } = createService();

    await expect(service.createUpload({ userId: USER_ID, ...metadata })).rejects.toThrow(/^UPLOAD_/);
    expect(objectStore.createPresignedPutUrl).not.toHaveBeenCalled();
    expect(repository.createPending).not.toHaveBeenCalled();
  });

  it("verifies, normalizes, stores, and returns only final metadata", async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    const { objectStore, repository, service } = createService();
    const inputBytes = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const claimed = uploadRow({ expectedSizeBytes: inputBytes.byteLength });
    const verified = uploadRow({
      status: "verified",
      expectedSizeBytes: inputBytes.byteLength,
      finalKey: `profiles/${USER_ID}/${UPLOAD_ID}.jpg`,
      publicUrl: `https://images.example.com/profiles/${USER_ID}/${UPLOAD_ID}.jpg`,
      finalContentType: "image/jpeg",
      finalSizeBytes: 300,
      verifiedAt: NOW,
      processingLeaseExpiresAt: null,
    });
    repository.claimFinalize.mockResolvedValue({ kind: "claimed", upload: claimed });
    repository.markVerified.mockImplementation(async (input) => ({
      ...verified,
      finalKey: input.finalKey,
      publicUrl: input.publicUrl,
      finalSizeBytes: input.finalSizeBytes,
    }));
    objectStore.readStagingObject.mockResolvedValue(inputBytes);

    const result = await service.finalizeUpload(USER_ID, UPLOAD_ID);
    const put = objectStore.putFinalObject.mock.calls[0]?.[0];
    if (!put) throw new Error("FINAL_OBJECT_FIXTURE_REQUIRED");
    const digest = createHash("sha256").update(put.body).digest("hex");
    const expectedKey = `profiles/${USER_ID}/${UPLOAD_ID}/${digest}.jpg`;
    const metadata = await sharp(put.body).metadata();
    expect(metadata).toEqual(expect.objectContaining({ format: "jpeg" }));
    expect(metadata.orientation).toBeUndefined();
    expect(put.key).toBe(expectedKey);
    expect(put.contentType).toBe("image/jpeg");
    expect(repository.prepareFinalObject).toHaveBeenCalledWith({
      uploadId: UPLOAD_ID,
      userId: USER_ID,
      finalKey: expectedKey,
      publicUrl: `https://images.example.com/${expectedKey}`,
      finalContentType: "image/jpeg",
      finalSizeBytes: put.body.byteLength,
      processingLeaseExpiresAt: new Date("2026-08-29T00:02:00.000Z"),
      now: NOW,
    });
    expect(repository.prepareFinalObject.mock.invocationCallOrder[0]).toBeLessThan(
      objectStore.putFinalObject.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(result).toEqual({
      id: UPLOAD_ID,
      publicUrl: `https://images.example.com/${expectedKey}`,
      contentType: "image/jpeg",
      sizeBytes: put.body.byteLength,
    });
    expect(repository.markStagingDeleted).toHaveBeenCalledWith(UPLOAD_ID, NOW);
    jest.useRealTimers();
  });

  it("returns a verified upload idempotently without reading or writing R2", async () => {
    const { objectStore, repository, service } = createService();
    const verified = uploadRow({
      status: "verified",
      finalKey: `profiles/${USER_ID}/${UPLOAD_ID}.jpg`,
      publicUrl: `https://images.example.com/profiles/${USER_ID}/${UPLOAD_ID}.jpg`,
      finalContentType: "image/jpeg",
      finalSizeBytes: 300,
      verifiedAt: NOW,
      processingLeaseExpiresAt: null,
    });
    repository.claimFinalize.mockResolvedValue({ kind: "verified", upload: verified });

    await expect(service.finalizeUpload(USER_ID, UPLOAD_ID)).resolves.toEqual({
      id: UPLOAD_ID,
      publicUrl: verified.publicUrl,
      contentType: "image/jpeg",
      sizeBytes: 300,
    });
    expect(objectStore.readStagingObject).not.toHaveBeenCalled();
    expect(objectStore.putFinalObject).not.toHaveBeenCalled();
  });

  it("marks declared size and MIME mismatches as failed", async () => {
    const { objectStore, repository, service } = createService();
    repository.claimFinalize.mockResolvedValue({ kind: "claimed", upload: uploadRow() });
    objectStore.readStagingObject.mockRejectedValue(new UploadObjectValidationError("UPLOAD_OBJECT_SIZE_MISMATCH"));

    await expect(service.finalizeUpload(USER_ID, UPLOAD_ID)).rejects.toThrow("UPLOAD_OBJECT_SIZE_MISMATCH");
    expect(repository.markFailed).toHaveBeenCalledWith({
      uploadId: UPLOAD_ID,
      failureCode: "UPLOAD_OBJECT_SIZE_MISMATCH",
      processingLeaseExpiresAt: new Date("2026-08-29T00:02:00.000Z"),
      now: expect.any(Date),
    });
  });

  it("marks undecodable input as failed without writing a final object", async () => {
    const { objectStore, repository, service } = createService();
    repository.claimFinalize.mockResolvedValue({ kind: "claimed", upload: uploadRow() });
    objectStore.readStagingObject.mockResolvedValue(Buffer.from("not-an-image"));

    await expect(service.finalizeUpload(USER_ID, UPLOAD_ID)).rejects.toThrow("UPLOAD_IMAGE_INVALID");
    expect(repository.markFailed).toHaveBeenCalledWith({
      uploadId: UPLOAD_ID,
      failureCode: "UPLOAD_IMAGE_INVALID",
      processingLeaseExpiresAt: new Date("2026-08-29T00:02:00.000Z"),
      now: expect.any(Date),
    });
    expect(objectStore.putFinalObject).not.toHaveBeenCalled();
  });

  it("does not revoke verification when staging deletion fails", async () => {
    const { objectStore, repository, service } = createService();
    const inputBytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const claimed = uploadRow({ expectedSizeBytes: inputBytes.byteLength });
    const verified = uploadRow({
      ...claimed,
      status: "verified",
      finalKey: `profiles/${USER_ID}/${UPLOAD_ID}.jpg`,
      publicUrl: `https://images.example.com/profiles/${USER_ID}/${UPLOAD_ID}.jpg`,
      finalContentType: "image/jpeg",
      finalSizeBytes: 200,
      verifiedAt: NOW,
    });
    repository.claimFinalize.mockResolvedValue({ kind: "claimed", upload: claimed });
    repository.markVerified.mockResolvedValue(verified);
    objectStore.readStagingObject.mockResolvedValue(inputBytes);
    objectStore.deleteObject.mockRejectedValue(new Error("R2 unavailable"));

    await expect(service.finalizeUpload(USER_ID, UPLOAD_ID)).resolves.toEqual(
      expect.objectContaining({ id: UPLOAD_ID, publicUrl: verified.publicUrl }),
    );
    expect(repository.markVerified).toHaveBeenCalled();
    expect(repository.markStagingDeleted).not.toHaveBeenCalled();
  });

  it("cleans bounded staging rows and schedules failed deletions for retry", async () => {
    const { objectStore, repository, service } = createService();
    const cleanupLeaseExpiresAt = new Date("2026-08-29T00:01:00.000Z");
    const succeeded = uploadRow({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb31",
      status: "failed",
      cleanupAttempts: 1,
      cleanupLeaseExpiresAt,
    });
    const retry = uploadRow({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb32",
      status: "verified",
      cleanupAttempts: 2,
      cleanupLeaseExpiresAt,
    });
    repository.claimCleanupBatch.mockResolvedValue({ jobs: [succeeded, retry], hasMore: true });
    objectStore.deleteObject.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("R2 unavailable"));

    await expect(service.cleanupExpiredStagingBatch({ now: NOW, limit: 2 })).resolves.toEqual({
      claimed: 2,
      succeeded: 1,
      retryScheduled: 1,
      permanentlyFailed: 0,
      hasMore: true,
    });
    expect(repository.applyCleanupResult).toHaveBeenCalledWith({
      uploadId: succeeded.id,
      cleanupLeaseExpiresAt,
      stagingDeleted: true,
      finalDeleted: false,
      nextAttemptAt: null,
      now: NOW,
    });
    expect(repository.applyCleanupResult).toHaveBeenCalledWith({
      uploadId: retry.id,
      cleanupLeaseExpiresAt,
      stagingDeleted: false,
      finalDeleted: false,
      nextAttemptAt: new Date("2026-08-29T00:01:00.000Z"),
      now: NOW,
    });
  });

  it("deletes a queued final object instead of re-deleting completed staging", async () => {
    const { objectStore, repository, service } = createService();
    const finalKey = `profiles/${USER_ID}/${UPLOAD_ID}/final.jpg`;
    const cleanupLeaseExpiresAt = new Date("2026-08-29T00:01:00.000Z");
    const queued = uploadRow({
      status: "failed",
      finalKey,
      publicUrl: `https://images.example.com/${finalKey}`,
      finalContentType: "image/jpeg",
      finalSizeBytes: 300,
      verifiedAt: NOW,
      stagingDeletedAt: NOW,
      finalDeletionPendingAt: NOW,
      cleanupLeaseExpiresAt,
      cleanupAttempts: 1,
    });
    repository.claimCleanupBatch.mockResolvedValue({ jobs: [queued], hasMore: false });

    await expect(service.cleanupExpiredStagingBatch({ now: NOW, limit: 1 })).resolves.toEqual(
      expect.objectContaining({ claimed: 1, succeeded: 1, retryScheduled: 0 }),
    );
    expect(objectStore.deleteObject).toHaveBeenCalledWith(finalKey);
    expect(objectStore.deleteObject).not.toHaveBeenCalledWith(queued.stagingKey);
    expect(repository.applyCleanupResult).toHaveBeenCalledWith({
      uploadId: queued.id,
      cleanupLeaseExpiresAt,
      stagingDeleted: false,
      finalDeleted: true,
      nextAttemptAt: null,
      now: NOW,
    });
  });

  it("keeps final deletion metadata durable and schedules retry when R2 is unavailable", async () => {
    const { objectStore, repository, service } = createService();
    const cleanupLeaseExpiresAt = new Date("2026-08-29T00:01:00.000Z");
    const queued = uploadRow({
      status: "failed",
      finalKey: `profiles/${USER_ID}/${UPLOAD_ID}/final.jpg`,
      stagingDeletedAt: NOW,
      finalDeletionPendingAt: NOW,
      cleanupLeaseExpiresAt,
      cleanupAttempts: 2,
    });
    repository.claimCleanupBatch.mockResolvedValue({ jobs: [queued], hasMore: false });
    objectStore.deleteObject.mockRejectedValue(new Error("R2 unavailable"));

    await expect(service.cleanupExpiredStagingBatch({ now: NOW, limit: 1 })).resolves.toEqual(
      expect.objectContaining({ claimed: 1, succeeded: 0, retryScheduled: 1 }),
    );
    expect(repository.applyCleanupResult).toHaveBeenCalledWith({
      uploadId: queued.id,
      cleanupLeaseExpiresAt,
      stagingDeleted: false,
      finalDeleted: false,
      nextAttemptAt: new Date("2026-08-29T00:01:00.000Z"),
      now: NOW,
    });
  });

  it("waits for every claimed cleanup job before propagating a database apply failure", async () => {
    const { repository, service } = createService();
    const cleanupLeaseExpiresAt = new Date("2026-08-29T00:01:00.000Z");
    const failed = uploadRow({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb41",
      status: "failed",
      cleanupLeaseExpiresAt,
    });
    const deferred = uploadRow({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb42",
      status: "failed",
      cleanupLeaseExpiresAt,
    });
    const siblingStarted = createDeferred();
    const sibling = createDeferred();
    repository.claimCleanupBatch.mockResolvedValue({ jobs: [failed, deferred], hasMore: false });
    repository.applyCleanupResult.mockImplementation((input) => {
      if (input.uploadId === failed.id) return Promise.reject(new Error("UPLOAD_CLEANUP_APPLY_FAILED"));
      siblingStarted.resolve();
      return sibling.promise;
    });

    const batch = service.cleanupExpiredStagingBatch({ now: NOW, limit: 2 });
    let settled = false;
    void batch.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await siblingStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    sibling.resolve();
    await expect(batch).rejects.toThrow("UPLOAD_CLEANUP_APPLY_FAILED");
    expect(settled).toBe(true);
  });
});
