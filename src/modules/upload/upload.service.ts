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
  async createUpload(input: { userId: string; filename: string; contentType: string }): Promise<UploadPayload> {
    const filename = input.filename.trim();
    const contentType = input.contentType.trim().toLowerCase();
    if (!filename) throw new Error("UPLOAD_FILENAME_REQUIRED");
    if (!PROFILE_IMAGE_CONTENT_TYPES.has(contentType)) throw new Error("UPLOAD_CONTENT_TYPE_UNSUPPORTED");
    if (!isUuid(input.userId)) throw new Error("UPLOAD_USER_ID_INVALID");

    const id = randomUUID();
    const extension = filename.includes(".") ? filename.split(".").at(-1) : "bin";
    const objectKey = `profiles/${input.userId}/${id}.${extension}`;
    const publicBaseUrl = this.configService.get<string>("R2_PUBLIC_BASE_URL")?.replace(/\/+$/, "");
    if (!publicBaseUrl) throw new Error("R2_CONFIG_REQUIRED");

    return {
      id,
      putUrl: await this.createPresignedPutUrl({ objectKey, contentType }),
      publicUrl: `${publicBaseUrl}/${objectKey.split("/").map(encodeURIComponent).join("/")}`,
    };
  }

  /**
   * R2 업로드용 presigned PUT URL을 생성한다.
   *
   * @param input 오브젝트 키와 content type
   * @returns presigned PUT URL
   */
  private async createPresignedPutUrl(input: { objectKey: string; contentType: string }): Promise<string> {
    const accountId = this.configService.get<string>("R2_ACCOUNT_ID");
    const accessKeyId = this.configService.get<string>("R2_ACCESS_KEY_ID");
    const secretAccessKey = this.configService.get<string>("R2_SECRET_ACCESS_KEY");
    const bucket = this.configService.get<string>("R2_BUCKET");
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
      "X-Amz-SignedHeaders": "content-type;host",
    });
    const canonicalRequest = [
      "PUT",
      pathname,
      params.toString(),
      `content-type:${input.contentType}\nhost:${host}\n`,
      "content-type;host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", date, credentialScope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, shortDate), region), service), "aws4_request");
    params.set("X-Amz-Signature", hmacHex(signingKey, stringToSign));

    return `https://${host}${pathname}?${params.toString()}`;
  }
}

const toAmzDate = (date: Date): string => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string): Buffer => createHmac("sha256", key).update(value).digest();
const hmacHex = (key: string | Buffer, value: string): string => createHmac("sha256", key).update(value).digest("hex");
const PROFILE_IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
