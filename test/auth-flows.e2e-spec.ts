import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import cookieParser from "cookie-parser";
import passport from "passport";
import request from "supertest";
import { AuthService } from "src/modules/auth/auth.service";
import { AuthRepository } from "src/modules/auth/auth.repository";
import { PhoneService } from "src/modules/phone/phone.service";
import { PhoneRepository } from "src/modules/phone/phone.repository";
import { SmsSender } from "src/modules/phone/sms.sender";
import { CompleteKakaoPhoneSignupInput } from "src/modules/phone/phone.types";
import { UserService } from "src/modules/user/user.service";
import { AUTH_TOKEN_AUDIENCE, AUTH_TOKEN_ISSUER } from "src/modules/auth/token-claims";
import { RefreshToken } from "src/modules/database/schema";

describe("auth flows (http e2e)", () => {
  let app: INestApplication;
  let authService: Partial<Record<keyof AuthService, jest.Mock>>;
  let phoneService: Partial<Record<keyof PhoneService, jest.Mock>>;
  const jwtService = new JwtService();
  const deviceId = "1b223347-6810-4d82-bb0b-562623490c75";
  const validatedRefreshToken: RefreshToken = {
    id: "df881b8f-90ed-4358-8581-5e5c132ac02d",
    userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0",
    deviceId,
    refreshToken: "saved-refresh-token-hash",
    refreshTokenExp: new Date("2999-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  const issueTokens = async (sessionDeviceId = deviceId) => ({
    accessToken: await jwtService.signAsync(
      { userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0", tokenType: "access" },
      { secret: "access-secret", expiresIn: "15m", audience: AUTH_TOKEN_AUDIENCE, issuer: AUTH_TOKEN_ISSUER },
    ),
    refreshToken: await jwtService.signAsync(
      { userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0", deviceId: sessionDeviceId, tokenType: "refresh" },
      { secret: "refresh-secret", expiresIn: "15m", audience: AUTH_TOKEN_AUDIENCE, issuer: AUTH_TOKEN_ISSUER },
    ),
  });

  const graphql = (query: string) =>
    request(app.getHttpServer()).post("/graphql").set("x-device-id", deviceId).send({ query });

  beforeEach(async () => {
    process.env.CLIENT_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_TOKEN_SECRET = "access-secret";
    process.env.JWT_ACCESS_TOKEN_EXP = "15m";
    process.env.JWT_REFRESH_TOKEN_SECRET = "refresh-secret";
    process.env.JWT_REFRESH_TOKEN_EXP = "15m";
    process.env.KAKAO_CLIENT_ID = "test";
    process.env.KAKAO_CALLBACK_URL = "http://localhost/api/auth/kakao/callback";
    process.env.KAKAO_SIGNUP_TOKEN_SECRET = "kakao-secret";
    const { AppModule } = await import("src/modules/app.module");

    authService = {
      loginWithKakaoAccessToken: jest.fn(async () => ({
        requiresPhone: false,
        session: await issueTokens(),
      })),
      refresh: jest.fn(() => issueTokens()),
      logout: jest.fn(async () => true),
      validateUserRefreshToken: jest.fn(async () => validatedRefreshToken),
    };
    phoneService = {
      requestPhoneCode: jest.fn(async () => ({ ok: true })),
      verifyPhoneCode: jest.fn(async () => ({ existingUser: false, phoneVerificationToken: "signup-token" })),
      completePhoneSignup: jest.fn(() => issueTokens()),
      completeKakaoPhoneSignup: jest.fn(() => issueTokens()),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(AuthService)
      .useValue(authService)
      .overrideProvider(PhoneService)
      .useValue(phoneService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().set("trust proxy", true);
    app.use(cookieParser());
    app.use(passport.initialize());
    app.enableCors({
      origin: process.env.CLIENT_URL,
      methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
      credentials: true,
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects a malformed installation id before authentication", async () => {
    const response = await request(app.getHttpServer())
      .post("/graphql")
      .set("x-device-id", "not-an-installation-id")
      .send({
        query: 'mutation { loginWithKakao(accessToken: "kakao-token") { __typename } }',
      })
      .expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors).toHaveLength(1);
    expect(authService.loginWithKakaoAccessToken).not.toHaveBeenCalled();
  });

  it("phone signup goes through GraphQL resolver and sets auth cookies", async () => {
    const schema = await graphql(`
      query {
        __type(name: "CompletePhoneSignupInput") {
          inputFields {
            name
            type {
              kind
              name
              ofType {
                kind
                name
              }
            }
          }
        }
      }
    `).expect(200);
    const termsAccepted = schema.body.data.__type.inputFields.find(
      (field: { name: string }) => field.name === "termsAccepted",
    );
    expect(termsAccepted.type).toEqual({
      kind: "NON_NULL",
      name: null,
      ofType: { kind: "SCALAR", name: "Boolean" },
    });

    await graphql(`
      mutation {
        requestPhoneCode(input: { phone: "01012345678", purpose: Signup }) {
          ok
        }
      }
    `).expect(200);

    const verified = await graphql(`
      mutation {
        verifyPhoneCode(input: { phone: "01012345678", code: "123456" }) {
          existingUser
          phoneVerificationToken
        }
      }
    `).expect(200);
    expect(verified.body.data.verifyPhoneCode.phoneVerificationToken).toBe("signup-token");

    const signedUp = await graphql(`
      mutation {
        completePhoneSignup(
          input: {
            email: "user@example.com"
            password: "password"
            phoneVerificationToken: "signup-token"
            gender: "female"
            termsAccepted: true
          }
        ) {
          accessToken
          refreshToken
        }
      }
    `).expect(200);

    expect(signedUp.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("access_token="), expect.stringContaining("refresh_token=")]),
    );
    expect(signedUp.headers.authorization).toMatch(/^Bearer /);
  });

  it("Kakao login refresh logout goes through cookies and refresh guard", async () => {
    const signedIn = await graphql(`
      mutation {
        loginWithKakao(accessToken: "kakao-token") {
          ... on KakaoLoginSuccessPayload {
            session {
              accessToken
              refreshToken
            }
          }
        }
      }
    `).expect(200);
    const cookies = signedIn.headers["set-cookie"];
    expect(cookies).toEqual(expect.arrayContaining([expect.stringContaining("refresh_token=")]));
    if (!cookies) throw new Error("REFRESH_COOKIE_REQUIRED");

    const refreshed = await request(app.getHttpServer())
      .post("/graphql")
      .set("Cookie", cookies)
      .send({ query: "mutation { refresh { accessToken refreshToken } }" })
      .expect(200);
    expect(refreshed.body.errors).toBeUndefined();
    expect(authService.validateUserRefreshToken).toHaveBeenCalled();

    const refreshedCookies = refreshed.headers["set-cookie"];
    if (!refreshedCookies) throw new Error("REFRESH_COOKIE_REQUIRED");
    const loggedOut = await request(app.getHttpServer())
      .post("/graphql")
      .set("Cookie", refreshedCookies)
      .send({ query: "mutation { logout }" })
      .expect(200);
    expect(loggedOut.body.data.logout).toBe(true);
    expect(String(loggedOut.headers["set-cookie"])).toContain("refresh_token=;");
  });

  it("refreshes and logs out a native session with bearer refresh tokens", async () => {
    const initialTokens = await issueTokens();
    const refreshed = await request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${initialTokens.refreshToken}`)
      .send({ query: "mutation { refresh { accessToken refreshToken } }" })
      .expect(200);

    expect(refreshed.body.errors).toBeUndefined();
    expect(authService.refresh).toHaveBeenCalledWith(validatedRefreshToken);

    const rotatedRefreshToken = refreshed.body.data.refresh.refreshToken as string;
    const loggedOut = await request(app.getHttpServer())
      .post("/graphql")
      .set("Authorization", `Bearer ${rotatedRefreshToken}`)
      .send({ query: "mutation { logout }" })
      .expect(200);

    expect(loggedOut.body.data.logout).toBe(true);
    expect(authService.logout).toHaveBeenCalledWith("553a6422-2525-4bd5-a5ce-5af75ea475c0", deviceId);
  });

  it("kakao phone signup goes through GraphQL resolver and sets auth cookies", async () => {
    const response = await graphql(`
      mutation {
        completeKakaoPhoneSignup(
          input: {
            phoneVerificationToken: "signup-token"
            kakaoPhoneVerificationToken: "kakao-token"
            userName: "tea"
            gender: "female"
            termsAccepted: true
          }
        ) {
          accessToken
          refreshToken
        }
      }
    `).expect(200);

    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("access_token="), expect.stringContaining("refresh_token=")]),
    );
  });

  it.each([
    [
      "phone",
      `mutation {
        completePhoneSignup(input: {
          email: "user@example.com"
          password: "password"
          phoneVerificationToken: "signup-token"
          termsAccepted: true
        }) { accessToken }
      }`,
      "completePhoneSignup" as const,
    ],
    [
      "Kakao",
      `mutation {
        completeKakaoPhoneSignup(input: {
          phoneVerificationToken: "signup-token"
          kakaoPhoneVerificationToken: "kakao-token"
          userName: "tea"
          termsAccepted: true
        }) { accessToken }
      }`,
      "completeKakaoPhoneSignup" as const,
    ],
  ])("requires gender at the %s signup GraphQL boundary", async (_flow, mutation, method) => {
    const response = await graphql(mutation).expect(400);

    expect(response.body.errors).toHaveLength(1);
    expect(phoneService[method]).not.toHaveBeenCalled();
  });

  it("rejects Kakao phone signup without terms before token or user mutation", async () => {
    const repository = {
      findPhoneVerificationToken: jest.fn(),
      findKakaoPhoneVerificationToken: jest.fn(),
      createKakaoPhoneUserWithTokens: jest.fn(),
      attachPhoneWithKakaoPhoneVerificationTokens: jest.fn(),
      consumePhoneVerificationToken: jest.fn(),
      consumeKakaoPhoneVerificationToken: jest.fn(),
    } as unknown as AuthRepository;
    const realAuthService = new AuthService(repository, {} as JwtService, {} as ConfigService, {} as UserService);
    const realPhoneService = new PhoneService(
      {} as PhoneRepository,
      realAuthService,
      {} as ConfigService,
      {} as JwtService,
      {} as SmsSender,
    );
    const completeKakaoPhoneSignup = phoneService.completeKakaoPhoneSignup;
    if (!completeKakaoPhoneSignup) throw new Error("KAKAO_PHONE_SIGNUP_MOCK_REQUIRED");
    completeKakaoPhoneSignup.mockImplementation((input, deviceId) =>
      realPhoneService.completeKakaoPhoneSignup(input as CompleteKakaoPhoneSignupInput, deviceId as string),
    );

    const response = await graphql(`
      mutation {
        completeKakaoPhoneSignup(
          input: {
            phoneVerificationToken: "signup-token"
            kakaoPhoneVerificationToken: "kakao-token"
            userName: "tea"
            gender: "female"
            termsAccepted: false
          }
        ) {
          accessToken
          refreshToken
        }
      }
    `).expect(200);

    expect(response.body.data).toBeNull();
    expect(response.body.errors).toHaveLength(1);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(repository.findPhoneVerificationToken).not.toHaveBeenCalled();
    expect(repository.findKakaoPhoneVerificationToken).not.toHaveBeenCalled();
    expect(repository.createKakaoPhoneUserWithTokens).not.toHaveBeenCalled();
    expect(repository.attachPhoneWithKakaoPhoneVerificationTokens).not.toHaveBeenCalled();
    expect(repository.consumePhoneVerificationToken).not.toHaveBeenCalled();
    expect(repository.consumeKakaoPhoneVerificationToken).not.toHaveBeenCalled();
  });

  it("native Kakao login is exposed through GraphQL and sets auth cookies", async () => {
    const response = await graphql(`
      mutation {
        loginWithKakao(accessToken: "native-access-token") {
          __typename
          ... on KakaoLoginSuccessPayload {
            requiresPhone
            session {
              accessToken
              refreshToken
            }
          }
          ... on KakaoRequiresPhonePayload {
            requiresPhone
            kakaoPhoneVerificationToken
            userName
          }
        }
      }
    `).expect(200);

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.loginWithKakao).toMatchObject({
      __typename: "KakaoLoginSuccessPayload",
      requiresPhone: false,
      session: { accessToken: expect.any(String), refreshToken: expect.any(String) },
    });
    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("access_token="), expect.stringContaining("refresh_token=")]),
    );
    expect(authService.loginWithKakaoAccessToken).toHaveBeenCalledWith("native-access-token", deviceId);
  });

  it("rejects kakao callback without oauth state cookie", async () => {
    await request(app.getHttpServer()).get("/api/auth/kakao/callback?code=abc").expect(401);
  });

  it("allows configured CORS origin with credentials", async () => {
    const response = await request(app.getHttpServer())
      .options("/graphql")
      .set("Origin", "http://localhost:3000")
      .expect(204);

    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });
});
