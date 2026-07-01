import { describe, expect, it } from "vitest";
import { R2UploadSigner, UploadService, type UploadSigner } from "../src/modules/upload/upload.service.js";

describe("UploadService", () => {
  it("creates presigned image uploads through signer", async () => {
    const signer: UploadSigner = {
      async createPresignedPutUrl(input) {
        return `https://r2.example/${input.objectKey}?type=${input.contentType}`;
      },
    };
    const service = new UploadService(signer);

    const upload = await service.createUpload({ filename: "photo.jpg", contentType: "image/jpeg" });

    expect(upload.id).toBeTruthy();
    expect(upload.putUrl).toContain("uploads/");
    expect(upload.putUrl).toContain("type=image/jpeg");
  });

  it("rejects missing filename and unsupported content type", async () => {
    const service = new UploadService({ createPresignedPutUrl: async () => "unused" });

    await expect(service.createUpload({ filename: "", contentType: "image/jpeg" })).rejects.toThrow(
      "UPLOAD_FILENAME_REQUIRED",
    );
    await expect(service.createUpload({ filename: "doc.pdf", contentType: "application/pdf" })).rejects.toThrow(
      "UPLOAD_CONTENT_TYPE_UNSUPPORTED",
    );
  });

  it("creates Cloudflare R2 presigned PUT URLs", async () => {
    const signer = new R2UploadSigner({
      accountId: "account",
      accessKeyId: "access-key",
      secretAccessKey: "secret",
      bucket: "chattea",
      now: () => new Date("2026-06-25T00:00:00.000Z"),
    });

    const url = await signer.createPresignedPutUrl({
      objectKey: "uploads/file.jpg",
      contentType: "image/jpeg",
    });

    expect(url).toContain("https://account.r2.cloudflarestorage.com/chattea/uploads/file.jpg?");
    expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(url).toContain("X-Amz-Credential=access-key%2F20260625%2Fauto%2Fs3%2Faws4_request");
    expect(url).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
    expect(url).toContain("X-Amz-Signature=");
  });
});
