export const AUTH_TOKEN_ISSUER = "chattea-api";
export const AUTH_TOKEN_AUDIENCE = "chattea-mobile";

export type AccessTokenClaims = { userId: string; tokenType: "access" };
export type RefreshTokenClaims = { userId: string; deviceId: string; tokenType: "refresh" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isAccessTokenClaims = (value: unknown): value is AccessTokenClaims =>
  isRecord(value) && value.tokenType === "access" && typeof value.userId === "string" && Boolean(value.userId);

export const isRefreshTokenClaims = (value: unknown): value is RefreshTokenClaims =>
  isRecord(value) &&
  value.tokenType === "refresh" &&
  typeof value.userId === "string" &&
  Boolean(value.userId) &&
  typeof value.deviceId === "string" &&
  Boolean(value.deviceId);
