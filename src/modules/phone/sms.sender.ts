import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface SmsSender {
  sendCode(phoneE164: string, code: string): Promise<void>;
}

@Injectable()
export class DevSmsSender implements SmsSender {
  async sendCode(): Promise<void> {
    return;
  }
}

@Injectable()
export class HttpSmsSender implements SmsSender {
  private readonly logger = new Logger(HttpSmsSender.name);

  constructor(private readonly configService: ConfigService) {}

  sendCode = async (phoneE164: string, code: string): Promise<void> => {
    const url = this.configService.getOrThrow<string>("SMS_PROVIDER_URL");
    const authorization = this.configService.get<string>("SMS_PROVIDER_AUTHORIZATION");
    if (process.env.NODE_ENV === "production" && !authorization) {
      throw new Error("SMS_PROVIDER_AUTHORIZATION is required");
    }
    const timeoutMs = Number(this.configService.get<string>("SMS_PROVIDER_TIMEOUT_MS") ?? 3000);
    const body = JSON.stringify({
      to: phoneE164,
      text: `[Demo] 인증번호는 ${code}입니다.`,
      senderId: this.configService.get<string>("SMS_SENDER_ID"),
    });

    for (const attempt of [1, 2]) {
      try {
        await this.post(url, body, timeoutMs);
        return;
      } catch (error) {
        this.logger.warn(`sms_send_failed attempt=${attempt} provider=http`);
        if (attempt === 2) throw error;
      }
    }
  };

  private post = async (url: string, body: string, timeoutMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.configService.get<string>("SMS_PROVIDER_AUTHORIZATION")
            ? { authorization: this.configService.getOrThrow<string>("SMS_PROVIDER_AUTHORIZATION") }
            : {}),
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`SMS provider failed: ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  };
}
