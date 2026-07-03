import { ConfigService } from "@nestjs/config";
import { describe, expect, it, jest } from "@jest/globals";
import { UploadService } from "./upload.service";

describe("UploadService", () => {
  it("rejects non-image content types", async () => {
    const service = new UploadService({} as ConfigService);

    await expect(service.createUpload({ filename: "file.txt", contentType: "text/plain" })).rejects.toThrow(
      "UPLOAD_CONTENT_TYPE_UNSUPPORTED",
    );
  });

  it("creates a fallback upload URL without R2 config", async () => {
    const configService = {
      get: jest.fn<() => undefined>().mockReturnValue(undefined),
    } as unknown as ConfigService;
    const service = new UploadService(configService);

    const result = await service.createUpload({ filename: "photo.JPG", contentType: " image/jpeg " });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.putUrl).toContain("https://uploads.invalid/uploads%2F");
    expect(result.putUrl).toContain(".JPG?contentType=image%2Fjpeg");
  });
});
