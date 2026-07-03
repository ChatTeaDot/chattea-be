import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import cookieParser from "cookie-parser";
import passport from "passport";
import request from "supertest";
import { AppModule } from "src/modules/app.module";
import { AuthService } from "src/modules/auth/auth.service";
import { PhoneService } from "src/modules/phone/phone.service";

describe("auth flows (http e2e)", () => {
  let app: INestApplication;
  let authService: Partial<Record<keyof AuthService, jest.Mock>>;
  let phoneService: Partial<Record<keyof PhoneService, jest.Mock>>;
  const jwtService = new JwtService();

  const issueTokens = async (deviceId = "device") => ({
    accessToken: await jwtService.signAsync(
      { userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0" },
      { secret: "access-secret", expiresIn: "15m" },
    ),
    refreshToken: await jwtService.signAsync(
      { userId: "553a6422-2525-4bd5-a5ce-5af75ea475c0", deviceId },
      { secret: "refresh-secret", expiresIn: "15m" },
    ),
  });

  const graphql = (query: string) =>
    request(app.getHttpServer()).post("/graphql").set("x-device-id", "device").send({ query });

  beforeEach(async () => {
    process.env.CLIENT_URL = "http://localhost:3000";
    process.env.JWT_ACCESS_TOKEN_SECRET = "access-secret";
    process.env.JWT_ACCESS_TOKEN_EXP = "15m";
    process.env.JWT_REFRESH_TOKEN_SECRET = "refresh-secret";
    process.env.JWT_REFRESH_TOKEN_EXP = "15m";
    process.env.KAKAO_CLIENT_ID = "test";
    process.env.KAKAO_CALLBACK_URL = "http://localhost/api/auth/kakao/callback";
    process.env.KAKAO_SIGNUP_TOKEN_SECRET = "kakao-secret";

    authService = {
      signin: jest.fn(() => issueTokens()),
      refresh: jest.fn(() => issueTokens()),
      logout: jest.fn(async () => true),
      compareUserRefreshToken: jest.fn(async () => true),
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

  it("phone signup goes through GraphQL resolver and sets auth cookies", async () => {
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
        completePhoneSignup(input: { email: "user@example.com", password: "password", phoneVerificationToken: "signup-token" }) {
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

  it("signin refresh logout goes through cookies and refresh guard", async () => {
    const signedIn = await graphql(`
      mutation {
        signin(input: { email: "user@example.com", password: "password", phoneVerificationToken: "signup-token" }) {
          accessToken
          refreshToken
        }
      }
    `).expect(200);
    const cookies = signedIn.headers["set-cookie"];
    expect(cookies).toEqual(expect.arrayContaining([expect.stringContaining("refresh_token=")]));

    const refreshed = await request(app.getHttpServer())
      .post("/graphql")
      .set("Cookie", cookies)
      .send({ query: "mutation { refresh { accessToken refreshToken } }" })
      .expect(200);
    expect(refreshed.body.errors).toBeUndefined();
    expect(authService.compareUserRefreshToken).toHaveBeenCalled();

    const loggedOut = await request(app.getHttpServer())
      .post("/graphql")
      .set("Cookie", refreshed.headers["set-cookie"])
      .send({ query: "mutation { logout }" })
      .expect(200);
    expect(loggedOut.body.data.logout).toBe(true);
    expect(String(loggedOut.headers["set-cookie"])).toContain("refresh_token=;");
  });

  it("kakao phone signup goes through GraphQL resolver and sets auth cookies", async () => {
    const response = await graphql(`
      mutation {
        completeKakaoPhoneSignup(input: { phoneVerificationToken: "signup-token", kakaoPhoneVerificationToken: "kakao-token" }) {
          accessToken
          refreshToken
        }
      }
    `).expect(200);

    expect(response.headers["set-cookie"]).toEqual(
      expect.arrayContaining([expect.stringContaining("access_token="), expect.stringContaining("refresh_token=")]),
    );
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
