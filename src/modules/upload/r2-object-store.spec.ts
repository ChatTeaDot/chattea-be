import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, jest } from "@jest/globals";
import { R2ObjectStore } from "./r2-object-store";

const config = {
  R2_ACCESS_KEY_ID: "access",
  R2_ACCOUNT_ID: "account",
  R2_BUCKET: "bucket",
  R2_SECRET_ACCESS_KEY: "secret",
};

const createStore = () =>
  new R2ObjectStore({
    get: (key: string) => config[key as keyof typeof config],
  } as unknown as ConfigService);

describe("R2ObjectStore", () => {
  it("presigns the official S3 PUT command without an empty-body checksum", async () => {
    const url = new URL(
      await createStore().createPresignedPutUrl({
        key: "profile-staging/user/upload.png",
        contentType: "image/png",
        sizeBytes: 68,
        expiresInSeconds: 300,
      }),
    );

    expect(url.hostname).toBe("bucket.account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/profile-staging/user/upload.png");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders")?.split(";");
    expect(signedHeaders).toContain("content-length");
    expect(signedHeaders).toContain("content-type");
    expect(url.searchParams.has("x-amz-checksum-crc32")).toBe(false);
  });

  it("reads exactly the declared byte range under the observed ETag", async () => {
    const store = createStore();
    const send = jest
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValueOnce({ ContentLength: 4, ContentType: "image/png", ETag: '"etag"' })
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3, 4]) },
        ContentLength: 4,
        ContentRange: "bytes 0-3/4",
      });
    const internal = store as unknown as { client: S3Client; bucket: string };
    internal.client = { send } as unknown as S3Client;
    internal.bucket = "bucket";

    await expect(
      store.readStagingObject({ key: "staging", expectedContentType: "image/png", expectedSizeBytes: 4 }),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    const get = send.mock.calls[1]?.[0];
    expect(get).toBeInstanceOf(GetObjectCommand);
    if (!(get instanceof GetObjectCommand)) throw new Error("GET_OBJECT_COMMAND_REQUIRED");
    expect(get.input).toEqual(
      expect.objectContaining({ Bucket: "bucket", Key: "staging", IfMatch: '"etag"', Range: "bytes=0-3" }),
    );
  });

  it("rejects oversized objects before issuing a body read", async () => {
    const store = createStore();
    const send = jest
      .fn<(command: unknown) => Promise<unknown>>()
      .mockResolvedValue({ ContentLength: 5, ContentType: "image/png", ETag: '"etag"' });
    const internal = store as unknown as { client: S3Client; bucket: string };
    internal.client = { send } as unknown as S3Client;
    internal.bucket = "bucket";

    await expect(
      store.readStagingObject({ key: "staging", expectedContentType: "image/png", expectedSizeBytes: 4 }),
    ).rejects.toThrow("UPLOAD_OBJECT_SIZE_MISMATCH");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses a short bounded public cache lifetime for deletable profile objects", async () => {
    const store = createStore();
    const send = jest.fn<(command: unknown) => Promise<unknown>>().mockResolvedValue({});
    const internal = store as unknown as { client: S3Client; bucket: string };
    internal.client = { send } as unknown as S3Client;
    internal.bucket = "bucket";

    await store.putFinalObject({
      key: "profiles/user/upload/final.jpg",
      body: Buffer.from([1]),
      contentType: "image/jpeg",
    });

    const put = send.mock.calls[0]?.[0];
    expect(put).toBeInstanceOf(PutObjectCommand);
    if (!(put instanceof PutObjectCommand)) throw new Error("PUT_OBJECT_COMMAND_REQUIRED");
    expect(put.input.CacheControl).toBe("public, max-age=300, must-revalidate");
  });
});
