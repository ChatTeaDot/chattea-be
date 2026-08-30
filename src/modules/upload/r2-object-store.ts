import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export class UploadObjectValidationError extends Error {}

@Injectable()
export class R2ObjectStore {
  private client?: S3Client;
  private bucket?: string;

  constructor(private readonly configService: ConfigService) {}

  createPresignedPutUrl = async (input: {
    key: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds: number;
  }): Promise<string> => {
    const { client, bucket } = this.connection();
    return getSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.sizeBytes,
      }),
      {
        expiresIn: input.expiresInSeconds,
        signableHeaders: new Set(["content-type"]),
      },
    );
  };

  readStagingObject = async (input: {
    key: string;
    expectedContentType: string;
    expectedSizeBytes: number;
  }): Promise<Buffer> => {
    const { client, bucket } = this.connection();
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: input.key }));
    if (head.ContentLength !== input.expectedSizeBytes) {
      throw new UploadObjectValidationError("UPLOAD_OBJECT_SIZE_MISMATCH");
    }
    if (normalizeContentType(head.ContentType) !== input.expectedContentType) {
      throw new UploadObjectValidationError("UPLOAD_OBJECT_CONTENT_TYPE_MISMATCH");
    }
    if (!head.ETag) throw new UploadObjectValidationError("UPLOAD_OBJECT_ETAG_MISSING");
    const object = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: input.key,
        IfMatch: head.ETag,
        Range: `bytes=0-${input.expectedSizeBytes - 1}`,
      }),
    );
    if (!object.Body) throw new UploadObjectValidationError("UPLOAD_OBJECT_BODY_MISSING");
    if (object.ContentLength !== input.expectedSizeBytes) {
      throw new UploadObjectValidationError("UPLOAD_OBJECT_SIZE_MISMATCH");
    }
    const totalSize = contentRangeTotal(object.ContentRange);
    if (totalSize !== undefined && totalSize !== input.expectedSizeBytes) {
      throw new UploadObjectValidationError("UPLOAD_OBJECT_SIZE_MISMATCH");
    }
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    if (bytes.byteLength !== input.expectedSizeBytes) {
      throw new UploadObjectValidationError("UPLOAD_OBJECT_SIZE_MISMATCH");
    }
    return bytes;
  };

  putFinalObject = async (input: { key: string; body: Buffer; contentType: string }): Promise<void> => {
    const { client, bucket } = this.connection();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ContentLength: input.body.byteLength,
        CacheControl: "public, max-age=300, must-revalidate",
      }),
    );
  };

  deleteObject = async (key: string): Promise<void> => {
    const { client, bucket } = this.connection();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  };

  private connection = (): { client: S3Client; bucket: string } => {
    if (this.client && this.bucket) return { client: this.client, bucket: this.bucket };
    const accountId = this.configService.get<string>("R2_ACCOUNT_ID")?.trim();
    const accessKeyId = this.configService.get<string>("R2_ACCESS_KEY_ID")?.trim();
    const secretAccessKey = this.configService.get<string>("R2_SECRET_ACCESS_KEY")?.trim();
    const bucket = this.configService.get<string>("R2_BUCKET")?.trim();
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error("R2_CONFIG_REQUIRED");
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    this.client = client;
    this.bucket = bucket;
    return { client, bucket };
  };
}

const normalizeContentType = (value: string | undefined): string => value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const contentRangeTotal = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const match = /^bytes \d+-\d+\/(\d+)$/.exec(value);
  if (!match?.[1]) return undefined;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : undefined;
};
