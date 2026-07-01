import { createHash, createHmac, randomUUID } from "node:crypto";

export type Upload = {
  id: string;
  putUrl: string;
};

export type UploadSigner = {
  createPresignedPutUrl(input: { objectKey: string; contentType: string }): Promise<string>;
};

export class DevUploadSigner implements UploadSigner {
  async createPresignedPutUrl(input: { objectKey: string; contentType: string }): Promise<string> {
    return `https://uploads.invalid/${encodeURIComponent(input.objectKey)}?contentType=${encodeURIComponent(input.contentType)}`;
  }
}

export class R2UploadSigner implements UploadSigner {
  constructor(
    private readonly config: {
      accountId: string;
      accessKeyId: string;
      secretAccessKey: string;
      bucket: string;
      expiresSeconds?: number;
      now?: () => Date;
    },
  ) {}

  async createPresignedPutUrl(input: { objectKey: string; contentType: string }): Promise<string> {
    const now = this.config.now?.() ?? new Date();
    const date = toAmzDate(now);
    const shortDate = date.slice(0, 8);
    const region = "auto";
    const service = "s3";
    const credentialScope = `${shortDate}/${region}/${service}/aws4_request`;
    const host = `${this.config.accountId}.r2.cloudflarestorage.com`;
    const pathname = `/${this.config.bucket}/${input.objectKey.split("/").map(encodeURIComponent).join("/")}`;
    const params = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.config.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": date,
      "X-Amz-Expires": String(this.config.expiresSeconds ?? 300),
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
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      date,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, shortDate), region), service),
      "aws4_request",
    );
    params.set("X-Amz-Signature", hmacHex(signingKey, stringToSign));

    return `https://${host}${pathname}?${params.toString()}`;
  }
}

export class UploadService {
  constructor(private readonly signer: UploadSigner) {}

  async createUpload(input: { filename: string; contentType: string }): Promise<Upload> {
    const filename = input.filename.trim();
    const contentType = input.contentType.trim().toLowerCase();

    if (!filename) {
      throw new Error("UPLOAD_FILENAME_REQUIRED");
    }

    if (!contentType.startsWith("image/")) {
      throw new Error("UPLOAD_CONTENT_TYPE_UNSUPPORTED");
    }

    const id = randomUUID();
    const extension = filename.includes(".") ? filename.split(".").at(-1) : "bin";
    const objectKey = `uploads/${id}.${extension}`;

    return {
      id,
      putUrl: await this.signer.createPresignedPutUrl({ objectKey, contentType }),
    };
  }
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}
