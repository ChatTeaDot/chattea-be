import { isIP } from "node:net";
import { createPostgresSslOptions } from "./postgres";

const REQUIRED_PRODUCTION_KEYS = [
  "POSTGRES_HOST",
  "POSTGRES_PORT",
  "POSTGRES_USERNAME",
  "POSTGRES_PASSWORD",
  "POSTGRES_DATABASE",
  "POSTGRES_SSL",
  "JWT_ACCESS_TOKEN_SECRET",
  "JWT_REFRESH_TOKEN_SECRET",
  "JWT_ACCESS_TOKEN_EXP",
  "JWT_REFRESH_TOKEN_EXP",
  "SIGNUP_TOKEN_SECRET",
  "KAKAO_SIGNUP_TOKEN_SECRET",
  "KAKAO_CLIENT_ID",
  "KAKAO_CALLBACK_URL",
  "PHONE_CODE_PEPPER",
  "SMS_PROVIDER_URL",
  "SMS_PROVIDER_AUTHORIZATION",
  "SMS_SENDER_ID",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
  "REVENUECAT_WEBHOOK_SECRET",
  "REVENUECAT_IOS_APP_ID",
  "REVENUECAT_ANDROID_APP_ID",
  "CLIENT_URL",
  "TRUST_PROXY",
] as const;

const PRODUCTION_SECRET_KEYS = [
  "POSTGRES_PASSWORD",
  "JWT_ACCESS_TOKEN_SECRET",
  "JWT_REFRESH_TOKEN_SECRET",
  "SIGNUP_TOKEN_SECRET",
  "KAKAO_SIGNUP_TOKEN_SECRET",
  "PHONE_CODE_PEPPER",
  "SMS_PROVIDER_AUTHORIZATION",
  "R2_SECRET_ACCESS_KEY",
  "REVENUECAT_WEBHOOK_SECRET",
] as const;

const HTTPS_URL_KEYS = ["KAKAO_CALLBACK_URL", "SMS_PROVIDER_URL", "R2_PUBLIC_BASE_URL", "CLIENT_URL"] as const;
const PRODUCTION_IDENTIFIER_KEYS = [
  "KAKAO_CLIENT_ID",
  "SMS_SENDER_ID",
  "REVENUECAT_IOS_APP_ID",
  "REVENUECAT_ANDROID_APP_ID",
] as const;
const TRUST_PROXY_NAMES = new Set(["loopback", "linklocal", "uniquelocal"]);
const TOKEN_LIFETIME_MAX_SECONDS = 365 * 24 * 60 * 60;
const TOKEN_LIFETIME_MULTIPLIERS = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 } as const;

const tokenLifetimeMultiplier = (unit: string | undefined): number | undefined => {
  if (unit === "") return 1;
  if (unit === "s" || unit === "m" || unit === "h" || unit === "d") {
    return TOKEN_LIFETIME_MULTIPLIERS[unit];
  }
  return undefined;
};

const valueFor = (config: Record<string, unknown>, key: string): string =>
  typeof config[key] === "string" ? config[key].trim() : "";

const isHttpsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
};

export const parseTrustedProxy = (value: unknown): false | string[] | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "false") return false;
  if (!normalized) return undefined;
  const entries = normalized.split(",").map((entry) => entry.trim());
  const valid = entries.every((entry) => {
    if (!entry) return false;
    if (TRUST_PROXY_NAMES.has(entry) || isIP(entry)) return true;

    const separator = entry.lastIndexOf("/");
    if (separator <= 0 || !/^\d+$/.test(entry.slice(separator + 1))) return false;
    const family = isIP(entry.slice(0, separator));
    const prefix = Number(entry.slice(separator + 1));
    return prefix > 0 && prefix <= (family === 4 ? 32 : family === 6 ? 128 : 0);
  });
  return valid ? entries : undefined;
};

const parsePort = (value: unknown): number | undefined => {
  const parsed = typeof value === "number" ? value : Number(valueFor({ value }, "value"));
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : undefined;
};

const parseTokenLifetime = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= TOKEN_LIFETIME_MAX_SECONDS ? value : undefined;
  }
  if (typeof value !== "string") return undefined;

  const match = /^(\d+)([smhd]?)$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const multiplier = tokenLifetimeMultiplier(match[2]);
  if (multiplier === undefined) return undefined;
  const seconds = amount * multiplier;
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= TOKEN_LIFETIME_MAX_SECONDS ? seconds : undefined;
};

export const validateEnvironment = (config: Record<string, unknown>): Record<string, unknown> => {
  const invalid = new Set<string>();
  const normalized = { ...config };
  const postgresPort = parsePort(config.POSTGRES_PORT);
  const accessTokenLifetime = parseTokenLifetime(config.JWT_ACCESS_TOKEN_EXP);
  const refreshTokenLifetime = parseTokenLifetime(config.JWT_REFRESH_TOKEN_EXP);
  const trustProxy = parseTrustedProxy(config.TRUST_PROXY);
  const expoPushEnabled = config.EXPO_PUSH_ENABLED === undefined ? false : config.EXPO_PUSH_ENABLED;

  if (config.POSTGRES_PORT !== undefined) {
    if (postgresPort === undefined) invalid.add("POSTGRES_PORT");
    else normalized.POSTGRES_PORT = postgresPort;
  }
  if (config.JWT_ACCESS_TOKEN_EXP !== undefined) {
    if (accessTokenLifetime === undefined) invalid.add("JWT_ACCESS_TOKEN_EXP");
    else normalized.JWT_ACCESS_TOKEN_EXP = accessTokenLifetime;
  }
  if (config.JWT_REFRESH_TOKEN_EXP !== undefined) {
    if (refreshTokenLifetime === undefined) invalid.add("JWT_REFRESH_TOKEN_EXP");
    else normalized.JWT_REFRESH_TOKEN_EXP = refreshTokenLifetime;
  }
  if (config.POSTGRES_SSL !== undefined) {
    const postgresSsl = config.POSTGRES_SSL;
    if (typeof postgresSsl !== "boolean" && typeof postgresSsl !== "string") {
      invalid.add("POSTGRES_SSL");
    } else {
      try {
        createPostgresSslOptions(postgresSsl, valueFor(config, "POSTGRES_SSL_CA"));
        normalized.POSTGRES_SSL = postgresSsl === true || postgresSsl === "true";
      } catch {
        invalid.add("POSTGRES_SSL");
      }
    }
  }
  if (expoPushEnabled === true || expoPushEnabled === false) {
    normalized.EXPO_PUSH_ENABLED = expoPushEnabled;
  } else if (expoPushEnabled === "true" || expoPushEnabled === "false") {
    normalized.EXPO_PUSH_ENABLED = expoPushEnabled === "true";
  } else {
    invalid.add("EXPO_PUSH_ENABLED");
  }
  if (config.TRUST_PROXY !== undefined) {
    if (trustProxy === undefined) invalid.add("TRUST_PROXY");
    else normalized.TRUST_PROXY = trustProxy === false ? "false" : trustProxy.join(",");
  }

  if (config.NODE_ENV !== "production") {
    if (invalid.size) throw new Error(`CONFIG_INVALID:${[...invalid].sort().join(",")}`);
    return normalized;
  }

  for (const key of REQUIRED_PRODUCTION_KEYS) {
    if (!valueFor(config, key)) invalid.add(key);
  }
  for (const key of PRODUCTION_SECRET_KEYS) {
    const value = valueFor(config, key);
    if (value.length < 16 || /^(?:dev|test)(?:-|$)/i.test(value) || value === "chattea-dev") {
      invalid.add(key);
    }
  }
  for (const key of HTTPS_URL_KEYS) {
    if (!isHttpsUrl(valueFor(config, key))) invalid.add(key);
  }
  for (const key of PRODUCTION_IDENTIFIER_KEYS) {
    if (/^(?:dev|test)(?:-|$)/i.test(valueFor(config, key))) invalid.add(key);
  }
  if (valueFor(config, "REVENUECAT_IOS_APP_ID") === valueFor(config, "REVENUECAT_ANDROID_APP_ID")) {
    invalid.add("REVENUECAT_IOS_APP_ID");
    invalid.add("REVENUECAT_ANDROID_APP_ID");
  }
  if (valueFor(config, "JWT_ACCESS_TOKEN_SECRET") === valueFor(config, "JWT_REFRESH_TOKEN_SECRET")) {
    invalid.add("JWT_ACCESS_TOKEN_SECRET");
    invalid.add("JWT_REFRESH_TOKEN_SECRET");
  }
  if (trustProxy === undefined) invalid.add("TRUST_PROXY");
  if (normalized.POSTGRES_SSL === false && valueFor(config, "POSTGRES_HOST") !== "postgres") {
    invalid.add("POSTGRES_SSL");
  }
  if (invalid.size) throw new Error(`PRODUCTION_CONFIG_INVALID:${[...invalid].sort().join(",")}`);
  return normalized;
};
