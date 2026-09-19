import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { describe, expect, it, jest } from "@jest/globals";
import { AuthService } from "src/modules/auth/auth.service";
import { AuthRequest, RefreshAuthRequest } from "src/modules/auth/auth.types";
import { RefreshToken } from "src/modules/database/schema";
import { UserRepository } from "src/modules/user/user.repository";
import { JwtAccessTokenStrategy } from "./access-token.strategy";
import { JwtRefreshTokenStrategy } from "./refresh-token.strategy";

describe("JWT token strategies", () => {
  const config = { getOrThrow: () => "separate-secret" } as unknown as ConfigService;
  const savedRefreshToken: RefreshToken = {
    id: "df881b8f-90ed-4358-8581-5e5c132ac02d",
    userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
    deviceId: "37e62526-6f75-4fbc-9df8-10fabd98929b",
    refreshToken: "saved-refresh-token-hash",
    refreshTokenExp: new Date("2999-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("rejects refresh claims at the access-token boundary", async () => {
    const findUser = jest.fn<UserRepository["findUser"]>();
    const strategy = new JwtAccessTokenStrategy(config, { findUser } as unknown as UserRepository);

    await expect(
      strategy.validate({} as AuthRequest, {
        userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
        deviceId: "37e62526-6f75-4fbc-9df8-10fabd98929b",
        tokenType: "refresh",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findUser).not.toHaveBeenCalled();
  });

  it("rejects access claims at the refresh-token boundary", async () => {
    const validateUserRefreshToken = jest.fn<AuthService["validateUserRefreshToken"]>();
    const strategy = new JwtRefreshTokenStrategy(config, {
      validateUserRefreshToken,
    } as unknown as AuthService);
    const request = { cookies: { refresh_token: "refresh-token" } } as RefreshAuthRequest;

    await expect(
      strategy.validate(request, {
        userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
        tokenType: "access",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(validateUserRefreshToken).not.toHaveBeenCalled();
  });

  it("validates and publishes the native bearer refresh token instead of a stale cookie", async () => {
    const validateUserRefreshToken = jest
      .fn<AuthService["validateUserRefreshToken"]>()
      .mockResolvedValue(savedRefreshToken);
    const strategy = new JwtRefreshTokenStrategy(config, {
      validateUserRefreshToken,
    } as unknown as AuthService);
    const request = {
      cookies: { refresh_token: "stale-cookie-token" },
      headers: { authorization: "Bearer native-refresh-token" },
    } as RefreshAuthRequest;
    const payload = {
      deviceId: "37e62526-6f75-4fbc-9df8-10fabd98929b",
      tokenType: "refresh" as const,
      userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
    };

    await expect(strategy.validate(request, payload)).resolves.toEqual(payload);

    expect(validateUserRefreshToken).toHaveBeenCalledWith(payload.userId, payload.deviceId, "native-refresh-token");
    expect(request.validatedRefreshToken).toBe(savedRefreshToken);
  });

  it("keeps the web refresh cookie fallback when no bearer token is present", async () => {
    const validateUserRefreshToken = jest
      .fn<AuthService["validateUserRefreshToken"]>()
      .mockResolvedValue(savedRefreshToken);
    const strategy = new JwtRefreshTokenStrategy(config, {
      validateUserRefreshToken,
    } as unknown as AuthService);
    const request = {
      cookies: { refresh_token: "web-refresh-token" },
      headers: {},
    } as RefreshAuthRequest;
    const payload = {
      deviceId: "37e62526-6f75-4fbc-9df8-10fabd98929b",
      tokenType: "refresh" as const,
      userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
    };

    await expect(strategy.validate(request, payload)).resolves.toEqual(payload);

    expect(validateUserRefreshToken).toHaveBeenCalledWith(payload.userId, payload.deviceId, "web-refresh-token");
    expect(request.validatedRefreshToken).toBe(savedRefreshToken);
  });
});
