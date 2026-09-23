import { describe, expect, it, jest } from "@jest/globals";
import * as bcrypt from "bcrypt";
import { Response } from "express";
import { JwtRefreshTokenStrategy } from "src/strategys/refresh-token.strategy";
import { AuthResolver } from "src/modules/auth/auth.resolver";
import { AuthService } from "src/modules/auth/auth.service";
import { AuthRepository } from "src/modules/auth/auth.repository";
import { RefreshAuthRequest } from "src/modules/auth/auth.types";
import { PhoneService } from "src/modules/phone/phone.service";
import { PhoneRepository } from "src/modules/phone/phone.repository";
import { SmsSender } from "src/modules/phone/sms.sender";
import {
  KakaoPhoneVerificationToken,
  PhoneVerification,
  PhoneVerificationToken,
  RefreshToken,
  User,
} from "src/modules/database/schema";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { UserService } from "src/modules/user/user.service";

describe("auth flows (e2e)", () => {
  const phone = "+821012345678";
  const user: User = {
    userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0",
    email: "user@example.com",
    phone,
    password: "hash",
    userName: "user",
    gender: "female",
    intro: "",
    birthDate: null,
    region: null,
    interestedGender: null,
    profileCompletedAt: null,
    hiddenAt: null,
    deletionScheduledAt: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const tokenServices = () => {
    const jwtService = {
      signAsync: jest.fn<() => Promise<string>>().mockResolvedValueOnce("access").mockResolvedValueOnce("refresh"),
      decode: jest.fn<() => { exp: number }>().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("pepper"),
    } as unknown as ConfigService;

    return { jwtService, configService };
  };

  it("phone signup flow verifies phone then completes signup", async () => {
    const verification: PhoneVerification = {
      id: "cce0f298-3313-4bd4-8138-c4d1fd959d09",
      phoneE164: "+821012345678",
      codeHash: await bcrypt.hash("+821012345678:123456:pepper", 10),
      purpose: "signup",
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null,
      attemptCount: 0,
      requestIpHash: null,
      userAgentHash: null,
      createdAt: new Date(),
    };
    const phoneServices = tokenServices();
    const authServices = tokenServices();
    const authRepository = {
      findPhoneVerificationToken: jest.fn<() => Promise<PhoneVerificationToken | undefined>>().mockResolvedValue({
        tokenHash: "access",
        phoneE164: verification.phoneE164,
        verificationId: verification.id,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        createdAt: new Date(),
      }),
      signupWithPhoneVerificationToken: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
      saveRefreshToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as AuthRepository;
    const auth = new AuthService(
      authRepository,
      authServices.jwtService,
      authServices.configService,
      {} as UserService,
    );
    const phoneRepository = {
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
      claimVerificationAttempt: jest
        .fn<() => Promise<PhoneVerification | undefined>>()
        .mockResolvedValue({ ...verification, attemptCount: 1 }),
      markVerified: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
      findUserByPhone: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
      createPhoneVerificationToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as PhoneRepository;
    const phone = new PhoneService(
      phoneRepository,
      auth,
      phoneServices.configService,
      phoneServices.jwtService,
      {} as SmsSender,
    );

    await expect(phone.verifyPhoneCode({ phone: "01012345678", code: "123456" }, "device")).resolves.toEqual({
      existingUser: false,
      phoneVerificationToken: "access",
    });
    await expect(
      phone.completePhoneSignup(
        {
          email: user.email,
          password: "password",
          gender: "female",
          phoneVerificationToken: "access",
          termsAccepted: true,
        },
        "device",
      ),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh" });
  });

  it("signin refresh logout flow rotates then deletes refresh token", async () => {
    const services = tokenServices();
    const hashedPassword = await bcrypt.hash("password", 10);
    const savedRefresh = await bcrypt.hash("old-refresh", 10);
    const repository = {
      signin: jest.fn<() => Promise<User | undefined>>().mockResolvedValue({ ...user, password: hashedPassword }),
      findPhoneVerificationToken: jest.fn<() => Promise<PhoneVerificationToken | undefined>>().mockResolvedValue({
        tokenHash: "signup-token",
        phoneE164: phone,
        verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        createdAt: new Date(),
      }),
      consumePhoneVerificationToken: jest
        .fn<() => Promise<PhoneVerificationToken | undefined>>()
        .mockResolvedValue({} as PhoneVerificationToken),
      findRefreshToken: jest.fn<() => Promise<RefreshToken>>().mockResolvedValue({
        id: "df881b8f-90ed-4358-8581-5e5c132ac02d",
        userId: user.userId,
        deviceId: "device",
        refreshToken: savedRefresh,
        refreshTokenExp: new Date(Date.now() + 60_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      saveRefreshToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
      rotateRefreshToken: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
      deleteRefreshToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as AuthRepository;
    const userService = {
      findUser: jest.fn<() => Promise<User>>().mockResolvedValue(user),
      restoreIfWithinGrace: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    } as unknown as UserService;
    const auth = new AuthService(repository, services.jwtService, services.configService, userService);

    await expect(
      auth.signin({ email: user.email, password: "password", phoneVerificationToken: "signup-token" }, "device"),
    ).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
    });
    services.jwtService.signAsync = jest
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("new-access")
      .mockResolvedValueOnce("new-refresh");
    const request = { cookies: { refresh_token: "old-refresh" }, headers: {} } as RefreshAuthRequest;
    const response = { setHeader: jest.fn(), cookie: jest.fn() } as unknown as Response;
    const compare = jest.spyOn(jest.requireActual<typeof bcrypt>("bcrypt"), "compare");

    try {
      await new JwtRefreshTokenStrategy(services.configService, auth).validate(request, {
        userId: user.userId,
        deviceId: "device",
        tokenType: "refresh",
      });
      await expect(new AuthResolver(auth).refresh(request, response)).resolves.toEqual({
        accessToken: "new-access",
        refreshToken: "new-refresh",
      });
      expect(compare).toHaveBeenCalledTimes(1);
    } finally {
      compare.mockRestore();
    }
    await expect(auth.logout(user.userId, "device")).resolves.toBe(true);
  });

  it("kakao phone signup flow creates kakao user with verified phone", async () => {
    const services = tokenServices();
    const phoneVerificationToken: PhoneVerificationToken = {
      tokenHash: "signup-token",
      phoneE164: phone,
      verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const kakaoToken: KakaoPhoneVerificationToken = {
      tokenHash: "kakao-token",
      userId: null,
      providerUserId: "kakao-user",
      email: user.email,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const repository = {
      findPhoneVerificationToken: jest
        .fn<() => Promise<PhoneVerificationToken | undefined>>()
        .mockResolvedValue(phoneVerificationToken),
      findKakaoPhoneVerificationToken: jest
        .fn<() => Promise<KakaoPhoneVerificationToken | undefined>>()
        .mockResolvedValue(kakaoToken),
      createKakaoPhoneUserWithTokens: jest.fn<() => Promise<User>>().mockResolvedValue(user),
      saveRefreshToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as AuthRepository;
    const auth = new AuthService(repository, services.jwtService, services.configService, {} as UserService);

    await expect(
      auth.completeKakaoPhoneSignup(
        {
          phoneVerificationToken: "signup-token",
          kakaoPhoneVerificationToken: "kakao-token",
          userName: user.userName,
          gender: "female",
          termsAccepted: true,
        },
        "device",
      ),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh" });
  });
});
