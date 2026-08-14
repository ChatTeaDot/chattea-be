import { ConfigService } from "@nestjs/config";
import { describe, expect, it, jest } from "@jest/globals";
import { UploadService } from "./upload.service";

describe("UploadService", () => {
  it("rejects non-image content types", async () => {
    const service = new UploadService({} as ConfigService);

    await expect(
      service.createUpload({
        userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
        filename: "file.txt",
        contentType: "text/plain",
      }),
    ).rejects.toThrow("UPLOAD_CONTENT_TYPE_UNSUPPORTED");
  });

  it("requires configured object storage instead of returning a fake upload URL", async () => {
    const configService = {
      get: jest.fn<() => undefined>().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new UploadService(configService);

    await expect(
      service.createUpload({
        userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
        filename: "photo.JPG",
        contentType: " image/jpeg ",
      }),
    ).rejects.toThrow("R2_CONFIG_REQUIRED");
  });

  it("returns an object-scoped public URL with complete R2 configuration", async () => {
    const configService = {
      get: jest.fn<(key: string) => string | undefined>().mockImplementation((key) => {
        const config: Record<string, string> = {
          R2_ACCOUNT_ID: "account",
          R2_ACCESS_KEY_ID: "access",
          R2_SECRET_ACCESS_KEY: "secret",
          R2_BUCKET: "chattea",
          R2_PUBLIC_BASE_URL: "https://images.chattea.example",
        };
        return config[key];
      }),
    } as unknown as ConfigService;
    const service = new UploadService(configService);

    const result = await service.createUpload({
      userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
      filename: "photo.JPG",
      contentType: "image/jpeg",
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.putUrl).toContain("https://account.r2.cloudflarestorage.com/chattea/profiles/");
    expect(result.publicUrl).toContain("https://images.chattea.example/profiles/");
  });
});
