import { describe, expect, it } from "vitest";
import { readEnv } from "../src/env.js";
import { MunjanaraSmsSender } from "../src/sms/sms-sender.js";

describe("SMS sender", () => {
  it("reads memory sender as default and munjanara when explicitly configured", () => {
    expect(readEnv({}).smsProvider).toBe("memory");
    expect(readEnv({ SMS_PROVIDER: "munjanara" }).smsProvider).toBe("munjanara");
    expect(readEnv({ R2_BUCKET: "chattea" }).r2Bucket).toBe("chattea");
    expect(readEnv({ SENTRY_DSN: "https://example@sentry.io/1" }).sentryDsn).toBe("https://example@sentry.io/1");
    expect(readEnv({ SENTRY_ENVELOPE_ENDPOINT: "https://sentry.example" }).sentryEnvelopeEndpoint).toBe(
      "https://sentry.example",
    );
    expect(readEnv({ DATADOG_APM_ENABLED: "true" }).datadogApmEnabled).toBe(true);
    expect(readEnv({ DD_TRACE_ENABLED: "true" }).datadogApmEnabled).toBe(true);
  });

  it("rejects unsafe production runtime config", () => {
    expect(() => readEnv({ SERVICE_ENV: "production" })).toThrow("DATABASE_URL_REQUIRED");
    expect(() =>
      readEnv({
        DATABASE_URL: "postgres://chattea:secret@postgres:5432/chattea",
        SERVICE_ENV: "production",
      }),
    ).toThrow("PHONE_CODE_PEPPER_REQUIRED");
    expect(() =>
      readEnv({
        DATABASE_URL: "postgres://chattea:secret@postgres:5432/chattea",
        PHONE_CODE_PEPPER: "pepper",
        SERVICE_ENV: "production",
      }),
    ).toThrow("MUNJANARA_CONFIG_REQUIRED");
    expect(() =>
      readEnv({
        DATABASE_URL: "postgres://chattea:secret@postgres:5432/chattea",
        MUNJANARA_API_KEY: "api-key",
        MUNJANARA_ENDPOINT: "https://sms.example",
        MUNJANARA_USER_ID: "user",
        PHONE_CODE_PEPPER: "pepper",
        SERVICE_ENV: "production",
        SMS_PROVIDER: "munjanara",
      }),
    ).toThrow("R2_CONFIG_REQUIRED");
  });

  it("sends phone code through Munjanara form payload", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sender = new MunjanaraSmsSender({
      endpoint: "https://sms.example/send",
      userId: "user",
      apiKey: "api-key",
      senderId: "0212345678",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response("OK", { status: 200 });
      },
    });

    await sender.sendPhoneCode({ phoneE164: "+821012345678", code: "123456" });

    const body = calls[0]!.init.body as URLSearchParams;
    expect(calls[0]!.url).toBe("https://sms.example/send");
    expect(calls[0]!.init.method).toBe("POST");
    expect(body.get("userid")).toBe("user");
    expect(body.get("passwd")).toBe("api-key");
    expect(body.get("sender")).toBe("0212345678");
    expect(body.get("receiver")).toBe("01012345678");
    expect(body.get("msg")).toBe("[채티] 인증번호는 123456입니다. 5분 안에 입력해주세요.");
  });

  it("fails closed on unsupported phone or provider error", async () => {
    const sender = new MunjanaraSmsSender({
      endpoint: "https://sms.example/send",
      userId: "user",
      apiKey: "api-key",
      senderId: "0212345678",
      fetchImpl: async () => new Response("FAIL", { status: 500 }),
    });

    await expect(sender.sendPhoneCode({ phoneE164: "+14155550100", code: "123456" })).rejects.toThrow(
      "SMS_PHONE_UNSUPPORTED",
    );
    await expect(sender.sendPhoneCode({ phoneE164: "+821012345678", code: "123456" })).rejects.toThrow(
      "SMS_SEND_FAILED",
    );
  });
});
