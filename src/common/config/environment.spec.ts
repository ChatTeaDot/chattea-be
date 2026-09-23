import { describe, expect, it } from "@jest/globals";
import { validateEnvironment } from "./environment";

const productionEnvironment = {
  NODE_ENV: "production",
  POSTGRES_HOST: "postgres",
  POSTGRES_PORT: "5432",
  POSTGRES_USERNAME: "chattea",
  POSTGRES_PASSWORD: "database-secret-at-least-16",
  POSTGRES_DATABASE: "chattea",
  POSTGRES_SSL: "true",
  JWT_ACCESS_TOKEN_SECRET: "access-secret-at-least-16",
  JWT_REFRESH_TOKEN_SECRET: "refresh-secret-at-least-16",
  JWT_ACCESS_TOKEN_EXP: "15m",
  JWT_REFRESH_TOKEN_EXP: "30d",
  SIGNUP_TOKEN_SECRET: "signup-secret-at-least-16",
  KAKAO_SIGNUP_TOKEN_SECRET: "kakao-secret-at-least-16",
  KAKAO_CLIENT_ID: "kakao-client-id",
  KAKAO_CALLBACK_URL: "https://api.example.com/auth/kakao/callback",
  PHONE_CODE_PEPPER: "phone-pepper-at-least-16",
  SMS_PROVIDER_URL: "https://sms.example.com/send",
  SMS_PROVIDER_AUTHORIZATION: "sms-authorization-at-least-16",
  SMS_SENDER_ID: "chattea",
  R2_ACCOUNT_ID: "r2-account",
  R2_ACCESS_KEY_ID: "r2-access",
  R2_SECRET_ACCESS_KEY: "r2-secret-at-least-16",
  R2_BUCKET: "profile-images",
  R2_PUBLIC_BASE_URL: "https://images.example.com",
  REVENUECAT_WEBHOOK_SECRET: "revenuecat-secret-at-least-16",
  REVENUECAT_IOS_APP_ID: "app-chattea-ios",
  REVENUECAT_ANDROID_APP_ID: "app-chattea-android",
  CLIENT_URL: "https://app.example.com",
  TRUST_PROXY: "loopback",
};

describe("validateEnvironment", () => {
  it("accepts a complete production environment", () => {
    expect(validateEnvironment(productionEnvironment)).toEqual({
      ...productionEnvironment,
      EXPO_PUSH_ENABLED: false,
      POSTGRES_PORT: 5432,
      POSTGRES_SSL: true,
      JWT_ACCESS_TOKEN_EXP: 900,
      JWT_REFRESH_TOKEN_EXP: 2_592_000,
    });
  });

  it("rejects plaintext PostgreSQL connections to external production hosts", () => {
    expect(() =>
      validateEnvironment({
        ...productionEnvironment,
        POSTGRES_HOST: "database.example.com",
        POSTGRES_SSL: "false",
      }),
    ).toThrow("PRODUCTION_CONFIG_INVALID:POSTGRES_SSL");
  });

  it("allows plaintext PostgreSQL only for the exact private Compose service hostname", () => {
    expect(validateEnvironment({ ...productionEnvironment, POSTGRES_SSL: "false" })).toEqual(
      expect.objectContaining({ POSTGRES_HOST: "postgres", POSTGRES_SSL: false }),
    );
  });

  it.each([
    ["true", true],
    ["false", false],
    [true, true],
    [false, false],
  ])("normalizes EXPO_PUSH_ENABLED %p to a boolean", (configured, expected) => {
    expect(validateEnvironment({ NODE_ENV: "development", EXPO_PUSH_ENABLED: configured })).toEqual(
      expect.objectContaining({ EXPO_PUSH_ENABLED: expected }),
    );
  });

  it.each(["TRUE", "1", "yes", 1, null])("rejects ambiguous EXPO_PUSH_ENABLED value %p", (configured) => {
    expect(() => validateEnvironment({ NODE_ENV: "development", EXPO_PUSH_ENABLED: configured })).toThrow(
      "CONFIG_INVALID:EXPO_PUSH_ENABLED",
    );
  });

  it.each([
    ["missing secret", { JWT_ACCESS_TOKEN_SECRET: undefined }],
    ["development placeholder", { JWT_ACCESS_TOKEN_SECRET: "dev-access-secret" }],
    ["short secret", { PHONE_CODE_PEPPER: "short" }],
    ["non-HTTPS endpoint", { SMS_PROVIDER_URL: "http://sms.example.com/send" }],
    ["trust all proxies", { TRUST_PROXY: "true" }],
    ["trust all IPv4 proxies", { TRUST_PROXY: "0.0.0.0/0" }],
    ["trust all IPv6 proxies", { TRUST_PROXY: "::/0" }],
    ["empty proxy entry", { TRUST_PROXY: "loopback," }],
    ["false mixed with trusted proxies", { TRUST_PROXY: "false,loopback" }],
    ["invalid proxy range", { TRUST_PROXY: "10.0.0.0/33" }],
    ["invalid access token lifetime", { JWT_ACCESS_TOKEN_EXP: "banana" }],
    ["zero refresh token lifetime", { JWT_REFRESH_TOKEN_EXP: "0" }],
    ["excessive token lifetime", { JWT_REFRESH_TOKEN_EXP: "366d" }],
    ["non-numeric PostgreSQL port", { POSTGRES_PORT: "postgres" }],
    ["out-of-range PostgreSQL port", { POSTGRES_PORT: "65536" }],
    ["invalid PostgreSQL TLS mode", { POSTGRES_SSL: "prefer" }],
    ["development client identifier", { KAKAO_CLIENT_ID: "dev-kakao-client-id" }],
    ["test sender identifier", { SMS_SENDER_ID: "test-sender" }],
    ["missing RevenueCat iOS app identifier", { REVENUECAT_IOS_APP_ID: undefined }],
    ["missing RevenueCat Android app identifier", { REVENUECAT_ANDROID_APP_ID: undefined }],
    ["development RevenueCat iOS app identifier", { REVENUECAT_IOS_APP_ID: "dev-revenuecat-ios" }],
    ["test RevenueCat Android app identifier", { REVENUECAT_ANDROID_APP_ID: "test-revenuecat-android" }],
    [
      "shared RevenueCat platform app identifier",
      { REVENUECAT_ANDROID_APP_ID: productionEnvironment.REVENUECAT_IOS_APP_ID },
    ],
    ["shared access and refresh secret", { JWT_REFRESH_TOKEN_SECRET: productionEnvironment.JWT_ACCESS_TOKEN_SECRET }],
  ])("rejects production with a %s", (_label, override) => {
    expect(() => validateEnvironment({ ...productionEnvironment, ...override })).toThrow("PRODUCTION_CONFIG_INVALID");
  });

  it("accepts exact trusted proxy addresses and bounded ranges", () => {
    const environment = {
      ...productionEnvironment,
      TRUST_PROXY: "loopback,10.0.0.0/8,2001:db8::1",
    };

    expect(validateEnvironment(environment)).toEqual(expect.objectContaining({ TRUST_PROXY: environment.TRUST_PROXY }));
  });

  it("normalizes trusted proxy names before runtime use", () => {
    const environment = {
      ...productionEnvironment,
      TRUST_PROXY: " LOOPBACK,UniqueLocal ",
    };

    expect(validateEnvironment(environment)).toEqual(expect.objectContaining({ TRUST_PROXY: "loopback,uniquelocal" }));
  });

  it("does not allow a production validation bypass", () => {
    expect(() =>
      validateEnvironment({
        NODE_ENV: "production",
        ALLOW_INSECURE_DEV_DEFAULTS: "true",
        JWT_ACCESS_TOKEN_SECRET: "dev-access-secret",
      }),
    ).toThrow("PRODUCTION_CONFIG_INVALID");
  });

  it("does not require production services in a local process", () => {
    const localEnvironment = { NODE_ENV: "development" };

    expect(validateEnvironment(localEnvironment)).toEqual({ ...localEnvironment, EXPO_PUSH_ENABLED: false });
  });
});
