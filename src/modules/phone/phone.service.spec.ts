import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { describe, expect, it, jest } from "@jest/globals";
import * as bcrypt from "bcrypt";
import { AuthService } from "src/modules/auth/auth.service";
import { PhoneVerification } from "src/modules/database/schema";
import { PhoneRepository } from "./phone.repository";
import { PhoneService } from "./phone.service";
import { PhoneVerificationPurpose } from "./phone.types";
import { SmsSender } from "./sms.sender";

describe("PhoneService", () => {
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
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(undefined),
      verificationsSinceByPhone: jest.fn<() => Promise<PhoneVerification[]>>().mockResolvedValue([]),
      verificationsSinceByIp: jest.fn<() => Promise<PhoneVerification[]>>().mockResolvedValue([]),
      createVerification: jest.fn<() => Promise<PhoneVerification>>().mockResolvedValue({} as PhoneVerification),
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

    expect(repository.verificationsSinceByPhone).toHaveBeenCalledWith(
      "+821012345678",
      PhoneVerificationPurpose.Signup,
      expect.any(Date),
    );
    expect(repository.verificationsSinceByIp).toHaveBeenCalledWith(
      expect.any(String),
      PhoneVerificationPurpose.Signup,
      expect.any(Date),
    );
    expect(repository.createVerification).toHaveBeenCalledWith(
      expect.objectContaining({ requestIpHash: expect.any(String) }),
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
      latestVerification: jest.fn<() => Promise<PhoneVerification | undefined>>().mockResolvedValue(undefined),
      verificationsSinceByPhone: jest.fn<() => Promise<PhoneVerification[]>>().mockResolvedValue([]),
      verificationsSinceByIp: jest.fn<() => Promise<PhoneVerification[]>>().mockResolvedValue([]),
      createVerification: jest.fn<() => Promise<PhoneVerification>>().mockResolvedValue(verification),
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
        { email: "user@example.com", password: "password", gender: "female", phoneVerificationToken: "signup-token" },
        "device",
      ),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh" });
  });
});
