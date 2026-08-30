import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { describe, expect, it, jest } from "@jest/globals";
import * as bcrypt from "bcrypt";
import { AuthService } from "src/modules/auth/auth.service";
import { PhoneVerification, User } from "src/modules/database/schema";
import { PhoneRepository } from "./phone.repository";
import { PhoneService } from "./phone.service";
import { PhoneVerificationPurpose } from "./phone.types";
import { SmsSender } from "./sms.sender";

describe("PhoneService", () => {
  it.each([
    ["retry_too_soon", "인증번호 재요청은 60초 후 가능합니다."],
    ["phone_limit", "전화번호 요청 횟수를 초과했습니다."],
    ["ip_limit", "IP 요청 횟수를 초과했습니다."],
  ])("returns the stable API error for an atomic %s reservation rejection", async (status, message) => {
    const repository = {
      reserveVerification: jest.fn<() => Promise<{ status: string }>>().mockResolvedValue({ status }),
    } as unknown as PhoneRepository;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("pepper"),
    } as unknown as ConfigService;
    const smsSender = {
      sendCode: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as SmsSender;
    const service = new PhoneService(repository, {} as AuthService, configService, {} as JwtService, smsSender);

    await expect(
      service.requestPhoneCode({ phone: "01012345678", purpose: PhoneVerificationPurpose.Signup }),
    ).rejects.toThrow(message);
  });

  it("rejects an over-limit request before hashing its code", async () => {
    const repository = {
      reserveVerification: jest
        .fn<() => Promise<{ status: "phone_limit" }>>()
        .mockResolvedValue({ status: "phone_limit" }),
    } as unknown as PhoneRepository;
    const configService = {
      getOrThrow: jest.fn<() => string>(() => {
        throw new Error("CODE_HASH_SHOULD_NOT_RUN");
      }),
    } as unknown as ConfigService;
    const service = new PhoneService(repository, {} as AuthService, configService, {} as JwtService, {} as SmsSender);

    await expect(
      service.requestPhoneCode({ phone: "01012345678", purpose: PhoneVerificationPurpose.Signup }),
    ).rejects.toThrow("전화번호 요청 횟수를 초과했습니다.");
  });

  it("rejects replayed verified phone codes", async () => {
    const verification: PhoneVerification = {
      id: "cce0f298-3313-4bd4-8138-c4d1fd959d09",
      phoneE164: "+821012345678",
      codeHash: "hash",
      purpose: "signup",
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: new Date(),
      attemptCount: 0,
      requestIpHash: null,
      userAgentHash: null,
      createdAt: new Date(),
    };
    const repository = {
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
    } as unknown as PhoneRepository;
    const service = new PhoneService(
      repository,
      {} as AuthService,
      {} as ConfigService,
      {} as JwtService,
      {} as SmsSender,
    );

    await expect(service.verifyPhoneCode({ phone: "01012345678", code: "123456" }, "device")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("rejects password reset with a non-reset phone code", async () => {
    const verification: PhoneVerification = {
      id: "cfba2a44-6f55-4514-a6b2-8e8db98778da",
      phoneE164: "+821012345678",
      codeHash: "hash",
      purpose: "signup",
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null,
      attemptCount: 0,
      requestIpHash: null,
      userAgentHash: null,
      createdAt: new Date(),
    };
    const repository = {
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
    } as unknown as PhoneRepository;
    const service = new PhoneService(
      repository,
      {} as AuthService,
      {} as ConfigService,
      {} as JwtService,
      {} as SmsSender,
    );

    await expect(
      service.resetPasswordWithPhone({
        phone: "01012345678",
        code: "123456",
        password: "new-password",
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rate limits missing IP requests by fallback bucket", async () => {
    const repository = {
      reserveVerification: jest
        .fn<() => Promise<{ status: "reserved"; verification: PhoneVerification }>>()
        .mockResolvedValue({ status: "reserved", verification: {} as PhoneVerification }),
      activateVerification: jest
        .fn<() => Promise<PhoneVerification | undefined>>()
        .mockResolvedValue({} as PhoneVerification),
      deleteVerification: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as PhoneRepository;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("pepper"),
    } as unknown as ConfigService;
    const smsSender = {
      sendCode: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as SmsSender;
    const service = new PhoneService(repository, {} as AuthService, configService, {} as JwtService, smsSender);

    await service.requestPhoneCode({ phone: "01012345678", purpose: PhoneVerificationPurpose.Signup });

    expect(repository.reserveVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: "+821012345678",
        purpose: PhoneVerificationPurpose.Signup,
        requestIpHash: expect.any(String),
      }),
    );
  });

  it("rejects arbitrary phone code purpose", async () => {
    const service = new PhoneService(
      {} as PhoneRepository,
      {} as AuthService,
      {} as ConfigService,
      {} as JwtService,
      {} as SmsSender,
    );

    await expect(
      service.requestPhoneCode({ phone: "01012345678", purpose: "admin" as PhoneVerificationPurpose }),
    ).rejects.toThrow("전화번호 인증 목적이 잘못되었습니다.");
  });

  it("deletes verification and returns unavailable when SMS send fails", async () => {
    const verification: PhoneVerification = {
      id: "cce0f298-3313-4bd4-8138-c4d1fd959d09",
      phoneE164: "+821012345678",
      codeHash: "hash",
      purpose: "signup",
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null,
      attemptCount: 0,
      requestIpHash: null,
      userAgentHash: null,
      createdAt: new Date(),
    };
    const repository = {
      reserveVerification: jest
        .fn<() => Promise<{ status: "reserved"; verification: PhoneVerification }>>()
        .mockResolvedValue({ status: "reserved", verification }),
      deleteVerification: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as PhoneRepository;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("pepper"),
    } as unknown as ConfigService;
    const smsSender = {
      sendCode: jest.fn<() => Promise<void>>().mockRejectedValue(new Error("provider failed")),
    } as unknown as SmsSender;
    const service = new PhoneService(repository, {} as AuthService, configService, {} as JwtService, smsSender);

    await expect(
      service.requestPhoneCode({ phone: "01012345678", purpose: PhoneVerificationPurpose.Signup }),
    ).rejects.toThrow("인증번호 발송에 실패했습니다.");
    expect(repository.deleteVerification).toHaveBeenCalledWith(verification.id);
  });

  it("returns signup token after verifying a new phone", async () => {
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
    const repository = {
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
      claimVerificationAttempt: jest
        .fn<() => Promise<PhoneVerification | undefined>>()
        .mockResolvedValue({ ...verification, attemptCount: 1 }),
      markVerified: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
      findUserByPhone: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
      createPhoneVerificationToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as PhoneRepository;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("pepper"),
    } as unknown as ConfigService;
    const jwtService = {
      signAsync: jest.fn<() => Promise<string>>().mockResolvedValue("signup-token"),
    } as unknown as JwtService;
    const service = new PhoneService(repository, {} as AuthService, configService, jwtService, {} as SmsSender);

    await expect(service.verifyPhoneCode({ phone: "01012345678", code: "123456" }, "device")).resolves.toEqual({
      existingUser: false,
      phoneVerificationToken: "signup-token",
    });
  });

  it("consumes the verification with the password and session update", async () => {
    const verification: PhoneVerification = {
      id: "cfba2a44-6f55-4514-a6b2-8e8db98778da",
      phoneE164: "+821012345678",
      codeHash: await bcrypt.hash("+821012345678:123456:pepper", 10),
      purpose: "password_reset",
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null,
      attemptCount: 0,
      requestIpHash: null,
      userAgentHash: null,
      createdAt: new Date(),
    };
    const repository = {
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
      claimVerificationAttempt: jest
        .fn<() => Promise<PhoneVerification | undefined>>()
        .mockResolvedValue({ ...verification, attemptCount: 1 }),
      resetPasswordWithVerification: jest.fn<() => Promise<User | undefined>>().mockResolvedValue({} as User),
    } as unknown as PhoneRepository;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("pepper"),
    } as unknown as ConfigService;
    const service = new PhoneService(repository, {} as AuthService, configService, {} as JwtService, {} as SmsSender);

    await expect(
      service.resetPasswordWithPhone({ phone: "01012345678", code: "123456", password: "new-password" }),
    ).resolves.toBe(true);
    expect(repository.resetPasswordWithVerification).toHaveBeenCalledWith(
      expect.objectContaining({ verificationId: verification.id, phoneE164: verification.phoneE164 }),
    );
  });

  it.each([
    ["empty", ""],
    ["short", "1234567"],
    ["over 72 UTF-8 bytes", "가".repeat(25)],
  ])("rejects an %s reset password before claiming a phone code", async (_label, password) => {
    const repository = {
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>(),
      claimVerificationAttempt: jest.fn<() => Promise<PhoneVerification | undefined>>(),
      resetPasswordWithVerification: jest.fn<() => Promise<User | undefined>>(),
    } as unknown as PhoneRepository;
    const service = new PhoneService(
      repository,
      {} as AuthService,
      {} as ConfigService,
      {} as JwtService,
      {} as SmsSender,
    );

    await expect(
      service.resetPasswordWithPhone({ phone: "01012345678", code: "123456", password }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.latestVerification).not.toHaveBeenCalled();
    expect(repository.claimVerificationAttempt).not.toHaveBeenCalled();
    expect(repository.resetPasswordWithVerification).not.toHaveBeenCalled();
  });

  it("accepts a 72-byte password reset without truncation", async () => {
    const verification: PhoneVerification = {
      id: "cfba2a44-6f55-4514-a6b2-8e8db98778da",
      phoneE164: "+821012345678",
      codeHash: await bcrypt.hash("+821012345678:123456:pepper", 10),
      purpose: "password_reset",
      expiresAt: new Date(Date.now() + 60_000),
      verifiedAt: null,
      attemptCount: 0,
      requestIpHash: null,
      userAgentHash: null,
      createdAt: new Date(),
    };
    const password = "가".repeat(24);
    const resetPasswordWithVerification = jest
      .fn<PhoneRepository["resetPasswordWithVerification"]>()
      .mockResolvedValue({} as User);
    const repository = {
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(verification),
      claimVerificationAttempt: jest
        .fn<() => Promise<PhoneVerification | undefined>>()
        .mockResolvedValue({ ...verification, attemptCount: 1 }),
      resetPasswordWithVerification,
    } as unknown as PhoneRepository;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("pepper"),
    } as unknown as ConfigService;
    const service = new PhoneService(repository, {} as AuthService, configService, {} as JwtService, {} as SmsSender);

    await service.resetPasswordWithPhone({ phone: "01012345678", code: "123456", password });

    const savedPassword = resetPasswordWithVerification.mock.calls[0]?.[0]?.password;
    expect(savedPassword && (await bcrypt.compare(password, savedPassword))).toBe(true);
  });

  it("delegates phone signup completion with device id", async () => {
    const authService = {
      signup: jest.fn<() => Promise<{ accessToken: string; refreshToken: string }>>().mockResolvedValue({
        accessToken: "access",
        refreshToken: "refresh",
      }),
    } as unknown as AuthService;
    const service = new PhoneService(
      {} as PhoneRepository,
      authService,
      {} as ConfigService,
      {} as JwtService,
      {} as SmsSender,
    );

    await expect(
      service.completePhoneSignup(
        {
          email: "user@example.com",
          password: "password",
          gender: "female",
          phoneVerificationToken: "signup-token",
          termsAccepted: true,
        },
        "device",
      ),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh" });
  });

  it("preserves the submitted user name when completing Kakao phone signup", async () => {
    const completeKakaoPhoneSignup = jest
      .fn<AuthService["completeKakaoPhoneSignup"]>()
      .mockResolvedValue({ accessToken: "access", refreshToken: "refresh" });
    const authService = { completeKakaoPhoneSignup } as unknown as AuthService;
    const service = new PhoneService(
      {} as PhoneRepository,
      authService,
      {} as ConfigService,
      {} as JwtService,
      {} as SmsSender,
    );

    await service.completeKakaoPhoneSignup(
      {
        phoneVerificationToken: "signup-token",
        kakaoPhoneVerificationToken: "kakao-token",
        userName: "  tea  ",
        gender: "female",
        termsAccepted: true,
      },
      "device",
    );

    expect(completeKakaoPhoneSignup).toHaveBeenCalledWith(expect.objectContaining({ userName: "  tea  " }), "device");
  });
});
