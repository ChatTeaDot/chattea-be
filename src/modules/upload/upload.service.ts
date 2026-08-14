import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, randomUUID } from "crypto";
import { UploadPayload } from "./upload.types";

@Injectable()
export class UploadService {
  /**
   * UploadService에서 사용할 ConfigService 의존성을 주입한다.
   *
   * @param configService 환경 설정 서비스
   */
  constructor(private readonly configService: ConfigService) {}

  /**
   * 이미지 업로드용 presigned PUT URL을 생성한다.
   *
   * @param input 파일명과 content type
   * @returns 업로드 ID와 PUT URL
   */
  async createUpload(input: { filename: string; contentType: string; sizeBytes: number }): Promise<UploadPayload> {
    const filename = input.filename.trim();
    const contentType = input.contentType.trim().toLowerCase();
    if (!filename) throw new Error("UPLOAD_FILENAME_REQUIRED");
    const allowedExtension = ALLOWED_IMAGE_TYPES.get(contentType);
    if (!allowedExtension) throw new Error("UPLOAD_CONTENT_TYPE_UNSUPPORTED");
    const sizeBytes = input.sizeBytes;
    if (
      typeof sizeBytes !== "number" ||
      !Number.isSafeInteger(sizeBytes) ||
      sizeBytes < 1 ||
      sizeBytes > MAX_UPLOAD_BYTES
    ) {
      throw new Error("UPLOAD_SIZE_INVALID");
    }

    const id = randomUUID();
    const suppliedExtension = safeExtension(filename);
    if (!suppliedExtension || !allowedExtension.includes(suppliedExtension))
      throw new Error("UPLOAD_EXTENSION_UNSUPPORTED");
    const objectKey = `uploads/${id}.${allowedExtension[0]}`;

    return {
      id,
      putUrl: await this.createPresignedPutUrl({ objectKey, contentType, sizeBytes }),
    };
  }

  /**
   * R2 업로드용 presigned PUT URL을 생성한다.
   *
   * @param input 오브젝트 키와 content type
   * @returns presigned PUT URL
   */
  private async createPresignedPutUrl(input: {
    objectKey: string;
    contentType: string;
    sizeBytes: number;
  }): Promise<string> {
    const accountId = this.configService.get<string>("R2_ACCOUNT_ID");
    const accessKeyId = this.configService.get<string>("R2_ACCESS_KEY_ID");
    const secretAccessKey = this.configService.get<string>("R2_SECRET_ACCESS_KEY");
    const bucket = this.configService.get<string>("R2_BUCKET");
    if (!accountId && !accessKeyId && !secretAccessKey && !bucket) {
      return `https://uploads.invalid/${encodeURIComponent(input.objectKey)}?contentType=${encodeURIComponent(input.contentType)}&sizeBytes=${input.sizeBytes}`;
    }
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) throw new Error("R2_CONFIG_REQUIRED");

    const date = toAmzDate(new Date());
    const shortDate = date.slice(0, 8);
    const region = "auto";
    const service = "s3";
    const credentialScope = `${shortDate}/${region}/${service}/aws4_request`;
    const host = `${accountId}.r2.cloudflarestorage.com`;
    const pathname = `/${bucket}/${input.objectKey.split("/").map(encodeURIComponent).join("/")}`;
    const params = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${accessKeyId}/${credentialScope}`,
      "X-Amz-Date": date,
      "X-Amz-Expires": "300",
      "X-Amz-SignedHeaders": "content-length;content-type;host",
    });
    const canonicalRequest = [
      "PUT",
      pathname,
      params.toString(),
      `content-length:${input.sizeBytes}\ncontent-type:${input.contentType}\nhost:${host}\n`,
      "content-length;content-type;host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", date, credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, shortDate), region), service), "aws4_request");
    params.set("X-Amz-Signature", hmacHex(signingKey, stringToSign));

    return `https://${host}${pathname}?${params.toString()}`;
  }
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Map<string, readonly string[]>([
  ["image/jpeg", ["jpg", "jpeg"]],
  ["image/png", ["png"]],
  ["image/webp", ["webp"]],
  ["image/gif", ["gif"]],
]);
const safeExtension = (filename: string): string | null => {
  if (filename.length > 255 || filename.includes("/") || filename.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f]/.test(filename) || filename.includes("..")) return null;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex < 1) return null;
  const extension = filename.slice(dotIndex + 1);
  return /^[A-Za-z0-9]{1,5}$/.test(extension) ? extension.toLowerCase() : null;
};

const toAmzDate = (date: Date): string => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string): Buffer => createHmac("sha256", key).update(value).digest();
const hmacHex = (key: string | Buffer, value: string): string => createHmac("sha256", key).update(value).digest("hex");
