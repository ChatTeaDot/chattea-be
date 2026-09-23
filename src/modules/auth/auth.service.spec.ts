import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { describe, expect, it, jest } from "@jest/globals";
import * as bcrypt from "bcrypt";
import { KakaoPhoneVerificationToken, RefreshToken, PhoneVerificationToken, User } from "src/modules/database/schema";
import { UserService } from "src/modules/user/user.service";
import { AuthRepository, KakaoPhoneVerificationTokenConsumeFailedError } from "./auth.repository";
import { AuthService } from "./auth.service";

describe("AuthService", () => {
  const user: User = {
    userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0",
    email: "user@example.com",
    phone: "+821011111111",
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
  const phoneVerificationToken: PhoneVerificationToken = {
    tokenHash: "signup-token",
    phoneE164: user.phone!,
    verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
    expiresAt: new Date(Date.now() + 60_000),
    usedAt: null,
    createdAt: new Date(),
  };

  const tokenServices = () => {
    const repository = {
      saveRefreshToken: jest.fn<() => Promise<void>>(),
    } as unknown as AuthRepository;
    const jwtService = {
      signAsync: jest.fn<() => Promise<string>>().mockResolvedValueOnce("access").mockResolvedValueOnce("refresh"),
      decode: jest.fn<() => { exp: number }>().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("secret"),
    } as unknown as ConfigService;

    return { repository, jwtService, configService };
  };

  it("completes phone signup and issues tokens", async () => {
    const services = tokenServices();
    const repository = {
      ...services.repository,
      findPhoneVerificationToken: jest
        .fn<AuthRepository["findPhoneVerificationToken"]>()
        .mockResolvedValue(phoneVerificationToken),
      signupWithPhoneVerificationToken: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
    } as unknown as AuthRepository;
    const service = new AuthService(repository, services.jwtService, services.configService, {} as UserService);

    await expect(
      service.signup(
        {
          email: user.email,
          password: "password",
          userName: user.userName,
          gender: "female",
          phoneVerificationToken: "signup-token",
          termsAccepted: true,
        },
        "device",
      ),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh" });
  });

  it.each([
    ["empty password", { password: "" }],
    ["short password", { password: "1234567" }],
    ["password over 72 UTF-8 bytes", { password: "가".repeat(25) }],
    ["invalid email", { email: "not-an-email" }],
    ["email with an empty local segment", { email: "user..name@example.com" }],
    ["email with an empty domain segment", { email: "user@example..com" }],
    ["email over 255 characters", { email: `${"a".repeat(244)}@example.com` }],
    ["empty user name", { userName: "   " }],
    ["user name over 40 characters", { userName: "가".repeat(41) }],
  ])("rejects signup with %s before consuming its phone token", async (_label, override) => {
    const repository = {
      signupWithPhoneVerificationToken: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
    } as unknown as AuthRepository;
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(
      service.signup(
        {
          email: user.email,
          password: "password",
          userName: user.userName,
          gender: user.gender,
          phoneVerificationToken: "signup-token",
          termsAccepted: true,
          ...override,
        },
        "device",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.signupWithPhoneVerificationToken).not.toHaveBeenCalled();
  });

  it("rejects an invalid phone token before hashing the password", async () => {
    const bcryptModule = jest.requireActual<typeof bcrypt>("bcrypt");
    const hashPassword = jest.spyOn(bcryptModule, "hash").mockImplementation(async () => "hash");
    const repository = {
      findPhoneVerificationToken: jest.fn<AuthRepository["findPhoneVerificationToken"]>().mockResolvedValue(undefined),
      signupWithPhoneVerificationToken: jest
        .fn<AuthRepository["signupWithPhoneVerificationToken"]>()
        .mockResolvedValue(undefined),
    } as unknown as AuthRepository;
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    try {
      await expect(
        service.signup(
          {
            email: user.email,
            password: "password",
            userName: user.userName,
            gender: user.gender,
            phoneVerificationToken: "invalid-token",
            termsAccepted: true,
          },
          "device",
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(hashPassword).not.toHaveBeenCalled();
    } finally {
      hashPassword.mockRestore();
    }
  });

  it("normalizes signup identity fields and preserves a 72-byte password", async () => {
    const services = tokenServices();
    const signupWithPhoneVerificationToken = jest
      .fn<AuthRepository["signupWithPhoneVerificationToken"]>()
      .mockResolvedValue(user);
    const repository = {
      ...services.repository,
      findPhoneVerificationToken: jest
        .fn<AuthRepository["findPhoneVerificationToken"]>()
        .mockResolvedValue(phoneVerificationToken),
      signupWithPhoneVerificationToken,
    } as unknown as AuthRepository;
    const service = new AuthService(repository, services.jwtService, services.configService, {} as UserService);
    const email = `${"a".repeat(243)}@example.com`;
    const password = "가".repeat(24);

    await service.signup(
      {
        email: `  ${email}  `,
        password,
        userName: `  ${"가".repeat(40)}  `,
        gender: user.gender,
        phoneVerificationToken: "signup-token",
        termsAccepted: true,
      },
      "device",
    );

    const saved = signupWithPhoneVerificationToken.mock.calls[0]?.[0];
    expect(saved).toEqual(expect.objectContaining({ email, userName: "가".repeat(40) }));
    expect(saved && (await bcrypt.compare(password, saved.password))).toBe(true);
  });

  it.each([
    ["short password", "short", user.email],
    ["over 72 UTF-8 byte password", "가".repeat(25), user.email],
    ["whitespace-padded stored email", "short", "  user@example.com  "],
  ])("keeps a legacy %s usable", async (_label, password, storedEmail) => {
    const services = tokenServices();
    const legacyUser = { ...user, email: storedEmail, password: await bcrypt.hash(password, 10) };
    const phoneVerificationToken: PhoneVerificationToken = {
      tokenHash: "signup-token",
      phoneE164: user.phone!,
      verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const signin = jest
      .fn<AuthRepository["signin"]>()
      .mockImplementation(async (candidate) => (candidate.email === storedEmail ? legacyUser : undefined));
    const repository = {
      ...services.repository,
      signin,
      findPhoneVerificationToken: jest
        .fn<() => Promise<PhoneVerificationToken | undefined>>()
        .mockResolvedValue(phoneVerificationToken),
      consumePhoneVerificationToken: jest
        .fn<() => Promise<PhoneVerificationToken | undefined>>()
        .mockResolvedValue(phoneVerificationToken),
    } as unknown as AuthRepository;
    const userService = {
      restoreIfWithinGrace: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    } as unknown as UserService;
    const service = new AuthService(repository, services.jwtService, services.configService, userService);

    await expect(
      service.signin(
        { email: "  user@example.com  ", password, phoneVerificationToken: phoneVerificationToken.tokenHash },
        "device",
      ),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(signin).toHaveBeenCalledWith(expect.objectContaining({ email: storedEmail, password }));
  });

  it("maps duplicate signup to bad request", async () => {
    const repository = {
      findPhoneVerificationToken: jest
        .fn<AuthRepository["findPhoneVerificationToken"]>()
        .mockResolvedValue(phoneVerificationToken),
      signupWithPhoneVerificationToken: async () => {
        throw { code: "23505" };
      },
    } as unknown as AuthRepository;
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(
      service.signup(
        {
          email: user.email,
          password: "password",
          userName: user.userName,
          gender: "female",
          phoneVerificationToken: "signup-token",
          termsAccepted: true,
        },
        "device",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not create a phone user without explicit terms acceptance", async () => {
    const services = tokenServices();
    const repository = {
      ...services.repository,
      signupWithPhoneVerificationToken: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
    } as unknown as AuthRepository;
    const service = new AuthService(repository, services.jwtService, services.configService, {} as UserService);
    const input = {
      email: user.email,
      password: "password",
      userName: user.userName,
      gender: user.gender,
      phoneVerificationToken: "signup-token",
      termsAccepted: false,
    };

    await expect(service.signup(input, "device")).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.signupWithPhoneVerificationToken).not.toHaveBeenCalled();
  });

  it("rejects signin with a phoneVerificationToken for another phone", async () => {
    const user: User = {
      userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0",
      email: "user@example.com",
      phone: "+821011111111",
      password: await bcrypt.hash("password", 10),
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
    const phoneVerificationToken: PhoneVerificationToken = {
      tokenHash: "token",
      phoneE164: "+821022222222",
      verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const consumePhoneVerificationToken = jest
      .fn<() => Promise<PhoneVerificationToken | undefined>>()
      .mockResolvedValue(phoneVerificationToken);
    const repository = {
      signin: async () => user,
      findPhoneVerificationToken: async () => phoneVerificationToken,
      consumePhoneVerificationToken,
    } as unknown as AuthRepository;
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(
      service.signin(
        {
          email: user.email,
          password: "password",
          phoneVerificationToken: phoneVerificationToken.tokenHash,
        },
        "device",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(consumePhoneVerificationToken).not.toHaveBeenCalled();
  });

  it("does not consume kakao phone signup tokens on phone mismatch", async () => {
    const user: User = {
      userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0",
      email: "user@example.com",
      phone: "+821011111111",
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
    const phoneVerificationToken: PhoneVerificationToken = {
      tokenHash: "signup-token",
      phoneE164: "+821022222222",
      verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const kakaoToken: KakaoPhoneVerificationToken = {
      tokenHash: "kakao-token",
      userId: user.userId,
      providerUserId: "kakao-user",
      email: user.email,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const consumePhoneVerificationToken = jest
      .fn<() => Promise<PhoneVerificationToken | undefined>>()
      .mockResolvedValue(phoneVerificationToken);
    const consumeKakaoPhoneVerificationToken = jest
      .fn<() => Promise<KakaoPhoneVerificationToken | undefined>>()
      .mockResolvedValue(kakaoToken);
    const repository = {
      findPhoneVerificationToken: async () => phoneVerificationToken,
      findKakaoPhoneVerificationToken: async () => kakaoToken,
      findUser: async () => user,
      consumePhoneVerificationToken,
      consumeKakaoPhoneVerificationToken,
    } as unknown as AuthRepository;
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(
      service.completeKakaoPhoneSignup(
        {
          phoneVerificationToken: phoneVerificationToken.tokenHash,
          kakaoPhoneVerificationToken: kakaoToken.tokenHash,
          userName: user.userName,
          gender: "female",
          termsAccepted: true,
        },
        "device",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(consumePhoneVerificationToken).not.toHaveBeenCalled();
    expect(consumeKakaoPhoneVerificationToken).not.toHaveBeenCalled();
  });

  it("maps kakao token consume race to unauthorized", async () => {
    const phoneVerificationToken: PhoneVerificationToken = {
      tokenHash: "signup-token",
      phoneE164: "+821011111111",
      verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const kakaoToken: KakaoPhoneVerificationToken = {
      tokenHash: "kakao-token",
      userId: null,
      providerUserId: "kakao-user",
      email: "user@example.com",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const repository = {
      findPhoneVerificationToken: async () => phoneVerificationToken,
      findKakaoPhoneVerificationToken: async () => kakaoToken,
      createKakaoPhoneUserWithTokens: async () => {
        throw new KakaoPhoneVerificationTokenConsumeFailedError();
      },
    } as unknown as AuthRepository;
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(
      service.completeKakaoPhoneSignup(
        {
          phoneVerificationToken: phoneVerificationToken.tokenHash,
          kakaoPhoneVerificationToken: kakaoToken.tokenHash,
          userName: user.userName,
          gender: "female",
          termsAccepted: true,
        },
        "device",
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rotates refresh token on refresh", async () => {
    const user: User = {
      userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0",
      email: "user@example.com",
      phone: "+821011111111",
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
    const savedToken: RefreshToken = {
      id: "d9d93b89-f8f4-4596-840a-82b167f0f91c",
      userId: user.userId,
      deviceId: "device",
      refreshToken: await bcrypt.hash("old-refresh", 10),
      refreshTokenExp: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const repository = {
      findRefreshToken: jest.fn<() => Promise<RefreshToken | undefined>>().mockResolvedValue(savedToken),
      rotateRefreshToken: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    } as unknown as AuthRepository;
    const jwtService = {
      signAsync: jest
        .fn<() => Promise<string>>()
        .mockResolvedValueOnce("new-access")
        .mockResolvedValueOnce("new-refresh"),
      decode: jest.fn<() => { exp: number }>().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    } as unknown as JwtService;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("secret"),
    } as unknown as ConfigService;
    const userService = {
      findUser: jest.fn<() => Promise<User>>().mockResolvedValue(user),
    } as unknown as UserService;
    const service = new AuthService(repository, jwtService, configService, userService);

    await expect(service.refresh(savedToken)).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(repository.rotateRefreshToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.userId,
        deviceId: "device",
        expectedRefreshToken: savedToken.refreshToken,
        refreshTokenExp: expect.any(Date),
      }),
    );
  });

  it("logs out by deleting device refresh token", async () => {
    const repository = {
      deleteRefreshToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as AuthRepository;
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(service.logout(user.userId, "device")).resolves.toBe(true);
    expect(repository.deleteRefreshToken).toHaveBeenCalledWith(user.userId, "device");
  });

  it("completes kakao phone signup and issues tokens", async () => {
    const phoneVerificationToken: PhoneVerificationToken = {
      tokenHash: "signup-token",
      phoneE164: "+821011111111",
      verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const kakaoToken: KakaoPhoneVerificationToken = {
      tokenHash: "kakao-token",
      userId: null,
      providerUserId: "kakao-user",
      email: "user@example.com",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const services = tokenServices();
    const createKakaoPhoneUserWithTokens = jest
      .fn<AuthRepository["createKakaoPhoneUserWithTokens"]>()
      .mockResolvedValue(user);
    const repository = {
      ...services.repository,
      findPhoneVerificationToken: jest
        .fn<() => Promise<PhoneVerificationToken | undefined>>()
        .mockResolvedValue(phoneVerificationToken),
      findKakaoPhoneVerificationToken: jest
        .fn<() => Promise<KakaoPhoneVerificationToken | undefined>>()
        .mockResolvedValue(kakaoToken),
      createKakaoPhoneUserWithTokens,
    } as unknown as AuthRepository;
    const service = new AuthService(repository, services.jwtService, services.configService, {} as UserService);

    await expect(
      service.completeKakaoPhoneSignup(
        {
          phoneVerificationToken: "signup-token",
          kakaoPhoneVerificationToken: "kakao-token",
          userName: "  tea  ",
          gender: "female",
          termsAccepted: true,
        },
        "device",
      ),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(createKakaoPhoneUserWithTokens).toHaveBeenCalledWith(
      expect.objectContaining({ userName: "tea" }),
      expect.any(Object),
    );
  });

  it.each([
    [`${"a".repeat(45)}@example.com`, `${"a".repeat(45)}@example.com`, "a".repeat(40), "kakao-user"],
    [
      null,
      "kakao_d361b4eae5f14c74887f7c320ee243e8@kakao.local",
      "kakao_d361b4eae5f14c74887f7c320ee243e8",
      "bad provider@id",
    ],
  ])(
    "bounds Kakao identity fields before creating a phone user from %p",
    async (sourceEmail, email, userName, providerUserId) => {
      const phoneVerificationToken: PhoneVerificationToken = {
        tokenHash: "signup-token",
        phoneE164: user.phone!,
        verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        createdAt: new Date(),
      };
      const kakaoToken: KakaoPhoneVerificationToken = {
        tokenHash: "kakao-token",
        userId: null,
        providerUserId,
        email: sourceEmail,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        createdAt: new Date(),
      };
      const services = tokenServices();
      const createKakaoPhoneUserWithTokens = jest
        .fn<AuthRepository["createKakaoPhoneUserWithTokens"]>()
        .mockResolvedValue(user);
      const repository = {
        ...services.repository,
        findPhoneVerificationToken: jest
          .fn<AuthRepository["findPhoneVerificationToken"]>()
          .mockResolvedValue(phoneVerificationToken),
        findKakaoPhoneVerificationToken: jest
          .fn<AuthRepository["findKakaoPhoneVerificationToken"]>()
          .mockResolvedValue(kakaoToken),
        createKakaoPhoneUserWithTokens,
      } as unknown as AuthRepository;
      const service = new AuthService(repository, services.jwtService, services.configService, {} as UserService);

      await service.completeKakaoPhoneSignup(
        {
          phoneVerificationToken: phoneVerificationToken.tokenHash,
          kakaoPhoneVerificationToken: kakaoToken.tokenHash,
          userName,
          gender: user.gender,
          termsAccepted: true,
        },
        "device",
      );

      expect(createKakaoPhoneUserWithTokens).toHaveBeenCalledWith(
        expect.objectContaining({ email, userName, providerUserId, phone: user.phone }),
        expect.objectContaining({
          phoneVerificationToken: phoneVerificationToken.tokenHash,
          kakaoPhoneVerificationToken: kakaoToken.tokenHash,
        }),
      );
    },
  );

  it("discards a malformed optional Kakao email before storing a signup token", async () => {
    const createKakaoPhoneVerificationToken = jest
      .fn<AuthRepository["createKakaoPhoneVerificationToken"]>()
      .mockResolvedValue(undefined);
    const repository = {
      findUserByIdentity: jest.fn<AuthRepository["findUserByIdentity"]>().mockResolvedValue(undefined),
      createKakaoPhoneVerificationToken,
    } as unknown as AuthRepository;
    const jwtService = {
      signAsync: jest.fn<() => Promise<string>>().mockResolvedValue("kakao-token"),
    } as unknown as JwtService;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("secret"),
    } as unknown as ConfigService;
    const service = new AuthService(repository, jwtService, configService, {} as UserService);

    await service.loginWithKakao({ providerUserId: "123", email: "not-an-email" });

    expect(createKakaoPhoneVerificationToken).toHaveBeenCalledWith(
      expect.objectContaining({ providerUserId: "123", email: undefined }),
    );
  });

  it.each([
    ["creating", null],
    ["attaching", user.userId],
  ])("rejects terms before %s a Kakao phone user", async (_operation, userId) => {
    const phoneVerificationToken: PhoneVerificationToken = {
      tokenHash: "signup-token",
      phoneE164: user.phone!,
      verificationId: "df881b8f-90ed-4358-8581-5e5c132ac01d",
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const kakaoToken: KakaoPhoneVerificationToken = {
      tokenHash: "kakao-token",
      userId,
      providerUserId: "kakao-user",
      email: user.email,
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
      createdAt: new Date(),
    };
    const services = tokenServices();
    const repository = {
      ...services.repository,
      findPhoneVerificationToken: jest
        .fn<() => Promise<PhoneVerificationToken | undefined>>()
        .mockResolvedValue(phoneVerificationToken),
      findKakaoPhoneVerificationToken: jest
        .fn<() => Promise<KakaoPhoneVerificationToken | undefined>>()
        .mockResolvedValue(kakaoToken),
      findUser: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
      createKakaoPhoneUserWithTokens: jest.fn<() => Promise<User>>().mockResolvedValue(user),
      attachPhoneWithKakaoPhoneVerificationTokens: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
      consumePhoneVerificationToken: jest.fn(),
      consumeKakaoPhoneVerificationToken: jest.fn(),
    } as unknown as AuthRepository;
    const userService = {
      restoreIfWithinGrace: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    } as unknown as UserService;
    const service = new AuthService(repository, services.jwtService, services.configService, userService);
    const input = {
      phoneVerificationToken: "signup-token",
      kakaoPhoneVerificationToken: "kakao-token",
      userName: user.userName,
      gender: "female" as const,
      termsAccepted: false,
    };

    await expect(service.completeKakaoPhoneSignup(input, "device")).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.findPhoneVerificationToken).not.toHaveBeenCalled();
    expect(repository.findKakaoPhoneVerificationToken).not.toHaveBeenCalled();
    expect(repository.createKakaoPhoneUserWithTokens).not.toHaveBeenCalled();
    expect(repository.attachPhoneWithKakaoPhoneVerificationTokens).not.toHaveBeenCalled();
    expect(repository.consumePhoneVerificationToken).not.toHaveBeenCalled();
    expect(repository.consumeKakaoPhoneVerificationToken).not.toHaveBeenCalled();
  });

  it("validates a native Kakao access token before issuing an existing user session", async () => {
    const services = tokenServices();
    const repository = {
      ...services.repository,
      findUserByIdentity: jest.fn<() => Promise<User | undefined>>().mockResolvedValue(user),
    } as unknown as AuthRepository;
    const userService = {
      restoreIfWithinGrace: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    } as unknown as UserService;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 123456789,
          connected_at: "2026-08-28T00:00:00Z",
          properties: {
            nickname: "tea",
            profile_image: "https://example.com/profile.jpg",
            thumbnail_image: "https://example.com/thumbnail.jpg",
          },
          kakao_account: {
            profile_nickname_needs_agreement: false,
            profile_image_needs_agreement: false,
            profile: {
              nickname: "tea",
              thumbnail_image_url: "https://example.com/thumbnail.jpg",
              profile_image_url: "https://example.com/profile.jpg",
              is_default_image: false,
              is_default_nickname: false,
            },
            has_email: true,
            email_needs_agreement: false,
            is_email_valid: true,
            is_email_verified: true,
            email: "user@example.com",
          },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
    const service = new AuthService(repository, services.jwtService, services.configService, userService);

    await expect(service.loginWithKakaoAccessToken("native-access-token", "device")).resolves.toEqual({
      requiresPhone: false,
      session: { accessToken: "access", refreshToken: "refresh" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://kapi.kakao.com/v2/user/me",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer native-access-token" }),
        signal: expect.any(AbortSignal),
      }),
    );

    fetchMock.mockRestore();
  });

  it("bounds a native Kakao nickname before returning it to the client", async () => {
    const repository = {
      findUserByIdentity: jest.fn<AuthRepository["findUserByIdentity"]>().mockResolvedValue(undefined),
      createKakaoPhoneVerificationToken: jest
        .fn<AuthRepository["createKakaoPhoneVerificationToken"]>()
        .mockResolvedValue(undefined),
    } as unknown as AuthRepository;
    const jwtService = {
      signAsync: jest.fn<() => Promise<string>>().mockResolvedValue("kakao-token"),
    } as unknown as JwtService;
    const configService = {
      getOrThrow: jest.fn<() => string>().mockReturnValue("secret"),
    } as unknown as ConfigService;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 123456789,
          properties: { nickname: "가".repeat(41) },
          kakao_account: { email: "user@example.com" },
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
    const service = new AuthService(repository, jwtService, configService, {} as UserService);

    await expect(service.loginWithKakaoAccessToken("native-access-token", "device")).resolves.toEqual({
      requiresPhone: true,
      kakaoPhoneVerificationToken: "kakao-token",
      userName: "가".repeat(40),
    });

    fetchMock.mockRestore();
  });

  it("rejects a native Kakao token rejected by Kakao", async () => {
    const repository = {
      findUserByIdentity: jest.fn<() => Promise<User | undefined>>(),
    } as unknown as AuthRepository;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: -401, msg: "this access token does not exist" }), {
        headers: { "content-type": "application/json" },
        status: 401,
      }),
    );
    const service = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(service.loginWithKakaoAccessToken("invalid-token", "device")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.findUserByIdentity).not.toHaveBeenCalled();

    fetchMock.mockRestore();
  });

  it("maps a Kakao profile timeout to unauthorized", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const service = new AuthService({} as AuthRepository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(service.loginWithKakaoAccessToken("native-access-token", "device")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://kapi.kakao.com/v2/user/me",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    fetchMock.mockRestore();
  });

  it.each([
    ["malformed JSON", new Response("{", { headers: { "content-type": "application/json" }, status: 200 })],
    [
      "missing id",
      new Response(JSON.stringify({ connected_at: "2026-08-28T00:00:00Z", kakao_account: {} }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    ],
  ])("maps a Kakao profile with %s to unauthorized", async (_case, response) => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response);
    const service = new AuthService({} as AuthRepository, {} as JwtService, {} as ConfigService, {} as UserService);

    await expect(service.loginWithKakaoAccessToken("native-access-token", "device")).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    fetchMock.mockRestore();
  });
});
