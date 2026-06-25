import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuthService } from "../src/auth/auth-service.js";
import { PostgresSessionStore } from "../src/auth/session-store.js";
import { PostgresPhoneService } from "../src/phone/phone-service.js";
import { InMemorySmsSender } from "../src/sms/sms-sender.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("PostgreSQL auth and phone flow", () => {
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://localhost/unused");
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const sms = new InMemorySmsSender();
  let sessionStore: PostgresSessionStore;
  let phone: PostgresPhoneService;
  let auth: PostgresAuthService;

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: databaseUrl });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    await setupPool.end();
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));
    sessionStore = new PostgresSessionStore(pool);
    phone = new PostgresPhoneService(pool, sms, "pepper", sessionStore);
    auth = new PostgresAuthService(
      { getProfile: async () => ({ id: "kakao-1", nickname: "tea" }) },
      pool,
      sessionStore,
    );
  });

  afterAll(async () => {
    const teardownPool = new Pool({ connectionString: databaseUrl });
    await teardownPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await teardownPool.end();
    await pool.end();
  });

  it("persists phone signup, session lookup, and later login", async () => {
    await phone.requestPhoneCode("01012345678", new Date("2026-06-25T00:00:00.000Z"));
    const first = await phone.verifyPhoneCode("01012345678", sms.messages[0]!.code, new Date("2026-06-25T00:01:00.000Z"));

    expect(first.status).toBe("SIGNUP_REQUIRED");
    if (first.status !== "SIGNUP_REQUIRED") {
      throw new Error("expected signup token");
    }

    const signup = await phone.completePhoneSignup(
      first.signupToken,
      "chattea",
      true,
      new Date("2026-06-25T00:02:00.000Z"),
      "차 한잔 같은 대화",
    );
    expect((await sessionStore.getUser(signup.session.token))?.phoneE164).toBe("+821012345678");
    expect((await sessionStore.getUser(signup.session.token))?.intro).toBe("차 한잔 같은 대화");

    await phone.requestPhoneCode("01012345678", new Date("2026-06-25T00:03:00.000Z"));
    const second = await phone.verifyPhoneCode("01012345678", sms.messages[1]!.code, new Date("2026-06-25T00:04:00.000Z"));

    expect(second.status).toBe("LOGIN");
  });

  it("persists Kakao identity after phone user attach", async () => {
    const login = await auth.loginWithKakao("access-token", new Date("2026-06-25T00:05:00.000Z"));
    if (!login.requiresPhone) {
      throw new Error("expected phone requirement");
    }

    const user = await phone.verifyExistingPhone("01012345678", sms.messages[1]!.code, new Date("2026-06-25T00:06:00.000Z")).catch(
      async () => {
        await phone.requestPhoneCode("01012345678", new Date("2026-06-25T00:06:00.000Z"));
        return phone.verifyExistingPhone("01012345678", sms.messages.at(-1)!.code, new Date("2026-06-25T00:07:00.000Z"));
      },
    );

    await auth.attachPhoneUser(login.kakaoToken, user, new Date("2026-06-25T00:08:00.000Z"));
    const next = await auth.loginWithKakao("access-token", new Date("2026-06-25T00:09:00.000Z"));

    expect(next.requiresPhone).toBe(false);
  });

  it("persists verification lock after five failed attempts", async () => {
    await phone.requestPhoneCode("01099998888", new Date("2026-06-25T00:10:00.000Z"));

    for (let index = 0; index < 5; index += 1) {
      await expect(phone.verifyPhoneCode("01099998888", "000000", new Date("2026-06-25T00:11:00.000Z"))).rejects.toThrow(
        "PHONE_CODE_INVALID",
      );
    }

    await expect(
      phone.verifyPhoneCode("01099998888", sms.messages.at(-1)!.code, new Date("2026-06-25T00:12:00.000Z")),
    ).rejects.toThrow("PHONE_CODE_LOCKED");
  });
});
