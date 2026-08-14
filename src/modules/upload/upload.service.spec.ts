import { ConfigService } from "@nestjs/config";
import { describe, expect, it, jest } from "@jest/globals";
import { UploadService } from "./upload.service";

describe("UploadService", () => {
  it("rejects non-image content types", async () => {
    const service = new UploadService({} as ConfigService);

    await expect(
      service.createUpload({ filename: "file.txt", contentType: "text/plain", sizeBytes: 5 }),
    ).rejects.toThrow("UPLOAD_CONTENT_TYPE_UNSUPPORTED");
  });

  it("creates a fallback upload URL without R2 config", async () => {
    const configService = {
      get: jest.fn<() => undefined>().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new UploadService(configService);

    const result = await service.createUpload({
      filename: "내 사진.JPG",
      contentType: " image/jpeg ",
      sizeBytes: 5,
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.putUrl).toContain("https://uploads.invalid/uploads%2F");
    expect(result.putUrl).toContain(".jpg?contentType=image%2Fjpeg");
    expect(result.putUrl).toContain("sizeBytes=5");
  });

  it.each([
    { filename: "attack.svg", contentType: "image/svg+xml", sizeBytes: 5 },
    { filename: "attack.exe.jpg", contentType: "image/png", sizeBytes: 5 },
    { filename: "../photo.jpg", contentType: "image/jpeg", sizeBytes: 5 },
  ])("rejects untrusted upload metadata: $filename", async (input) => {
    const service = new UploadService({ get: () => undefined } as unknown as ConfigService);
    await expect(service.createUpload(input)).rejects.toThrow(/UPLOAD_(CONTENT_TYPE|EXTENSION)_UNSUPPORTED/);
  });

  it("rejects files over the allowlisted size", async () => {
    const service = new UploadService({ get: () => undefined } as unknown as ConfigService);
    await expect(
      service.createUpload({ filename: "photo.png", contentType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 }),
    ).rejects.toThrow("UPLOAD_SIZE_INVALID");
  });

  it("rejects uploads with an invalid declared byte length", async () => {
    const service = new UploadService({ get: () => undefined } as unknown as ConfigService);
    await expect(
      service.createUpload({ filename: "photo.png", contentType: "image/png", sizeBytes: 0 }),
    ).rejects.toThrow("UPLOAD_SIZE_INVALID");
  });

  it("binds the declared byte length to the signed upload request", async () => {
    const service = new UploadService({
      get: (key: string) =>
        ({
          R2_ACCESS_KEY_ID: "access",
          R2_ACCOUNT_ID: "account",
          R2_BUCKET: "bucket",
          R2_SECRET_ACCESS_KEY: "secret",
        })[key],
    } as unknown as ConfigService);

    const result = await service.createUpload({
      filename: "photo.jpg",
      contentType: "image/jpeg",
      sizeBytes: 4096,
    });
    const url = new URL(result.putUrl);

    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });
});
