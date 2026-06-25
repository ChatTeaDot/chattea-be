import { describe, expect, it } from "vitest";
import { hashPhoneCode, isExpired, verifyPhoneCodeHash } from "../src/phone/code.js";
import { normalizeKoreanPhone } from "../src/phone/normalize-phone.js";
import { PhoneService } from "../src/phone/phone-service.js";
import { InMemorySmsSender } from "../src/sms/sms-sender.js";

describe("normalizeKoreanPhone", () => {
  it("normalizes Korean mobile numbers to E.164", () => {
    expect(normalizeKoreanPhone("01012345678")).toBe("+821012345678");
    expect(normalizeKoreanPhone("010-1234-5678")).toBe("+821012345678");
    expect(normalizeKoreanPhone("+821012345678")).toBe("+821012345678");
  });

  it("rejects invalid or global phone numbers", () => {
    expect(() => normalizeKoreanPhone("+14155550100")).toThrow("INVALID_KOREAN_PHONE");
    expect(() => normalizeKoreanPhone("0212345678")).toThrow("INVALID_KOREAN_PHONE");
    expect(() => normalizeKoreanPhone("0101234567")).toThrow("INVALID_KOREAN_PHONE");
  });
});

describe("phone code helpers", () => {
  it("verifies hash success and failure without plaintext storage", () => {
    const hash = hashPhoneCode("123456", "+821012345678", "pepper");

    expect(verifyPhoneCodeHash("123456", hash, "+821012345678", "pepper")).toBe(true);
    expect(verifyPhoneCodeHash("000000", hash, "+821012345678", "pepper")).toBe(false);
    expect(verifyPhoneCodeHash("abc", hash, "+821012345678", "pepper")).toBe(false);
  });

  it("detects expired codes", () => {
    expect(isExpired(new Date("2026-06-25T00:00:00.000Z"), new Date("2026-06-25T00:00:00.000Z"))).toBe(true);
    expect(isExpired(new Date("2026-06-25T00:00:01.000Z"), new Date("2026-06-25T00:00:00.000Z"))).toBe(false);
  });
});

describe("PhoneService", () => {
  it("returns signup token before creating a user, then logs in existing phone", async () => {
    const sms = new InMemorySmsSender();
    const service = new PhoneService(sms, "pepper");

    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:00:00.000Z"));

    const first = await service.verifyPhoneCode("01012345678", sms.messages[0]!.code, new Date("2026-06-25T00:01:00.000Z"));
    expect(first.status).toBe("SIGNUP_REQUIRED");

    if (first.status !== "SIGNUP_REQUIRED") {
      throw new Error("expected signup token");
    }

    const signup = await service.completePhoneSignup(
      first.signupToken,
      "chattea",
      true,
      new Date("2026-06-25T00:02:00.000Z"),
      "차 한잔 같은 대화를 좋아해요",
    );
    expect(signup.user.phoneE164).toBe("+821012345678");
    expect(signup.user.intro).toBe("차 한잔 같은 대화를 좋아해요");

    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:02:00.000Z"));
    const second = await service.verifyPhoneCode("01012345678", sms.messages[1]!.code, new Date("2026-06-25T00:03:00.000Z"));

    expect(second.status).toBe("LOGIN");
  });

  it("rejects replaying an already verified phone code", async () => {
    const sms = new InMemorySmsSender();
    const service = new PhoneService(sms, "pepper");

    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:00:00.000Z"));

    expect((await service.verifyPhoneCode("01012345678", sms.messages[0]!.code, new Date("2026-06-25T00:01:00.000Z"))).status).toBe(
      "SIGNUP_REQUIRED",
    );
    await expect(
      service.verifyPhoneCode("01012345678", sms.messages[0]!.code, new Date("2026-06-25T00:02:00.000Z")),
    ).rejects.toThrow("PHONE_CODE_ALREADY_USED");
  });

  it("does not consume a new phone code when checking existing phone attach", async () => {
    const sms = new InMemorySmsSender();
    const service = new PhoneService(sms, "pepper");

    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:00:00.000Z"));

    await expect(
      service.verifyExistingPhone("01012345678", sms.messages[0]!.code, new Date("2026-06-25T00:01:00.000Z")),
    ).rejects.toThrow("PHONE_SIGNUP_REQUIRED");
    await expect(
      service.verifyPhoneCode("01012345678", sms.messages[0]!.code, new Date("2026-06-25T00:02:00.000Z")),
    ).resolves.toMatchObject({ status: "SIGNUP_REQUIRED" });
  });

  it("rejects empty and overlong nicknames", async () => {
    const sms = new InMemorySmsSender();
    const service = new PhoneService(sms, "pepper");

    await service.requestPhoneCode("01011112222", new Date("2026-06-25T00:00:00.000Z"));
    const empty = await service.verifyPhoneCode("01011112222", sms.messages[0]!.code, new Date("2026-06-25T00:01:00.000Z"));
    if (empty.status !== "SIGNUP_REQUIRED") {
      throw new Error("expected signup token");
    }
    await expect(
      service.completePhoneSignup(empty.signupToken, " ", true, new Date("2026-06-25T00:02:00.000Z")),
    ).rejects.toThrow("NICKNAME_REQUIRED");

    await service.requestPhoneCode("01033334444", new Date("2026-06-25T00:03:00.000Z"));
    const overlong = await service.verifyPhoneCode(
      "01033334444",
      sms.messages[1]!.code,
      new Date("2026-06-25T00:04:00.000Z"),
    );
    if (overlong.status !== "SIGNUP_REQUIRED") {
      throw new Error("expected signup token");
    }
    await expect(
      service.completePhoneSignup(overlong.signupToken, "a".repeat(21), true, new Date("2026-06-25T00:05:00.000Z")),
    ).rejects.toThrow("NICKNAME_TOO_LONG");

    await service.requestPhoneCode("01055556666", new Date("2026-06-25T00:06:00.000Z"));
    const overlongIntro = await service.verifyPhoneCode(
      "01055556666",
      sms.messages[2]!.code,
      new Date("2026-06-25T00:07:00.000Z"),
    );
    if (overlongIntro.status !== "SIGNUP_REQUIRED") {
      throw new Error("expected signup token");
    }
    await expect(
      service.completePhoneSignup(
        overlongIntro.signupToken,
        "tea",
        true,
        new Date("2026-06-25T00:08:00.000Z"),
        "a".repeat(61),
      ),
    ).rejects.toThrow("PROFILE_INTRO_TOO_LONG");
  });

  it("enforces resend cooldown and hourly phone limit", async () => {
    const sms = new InMemorySmsSender();
    const service = new PhoneService(sms, "pepper");

    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:00:00.000Z"));
    await expect(service.requestPhoneCode("01012345678", new Date("2026-06-25T00:00:59.000Z"))).rejects.toThrow(
      "PHONE_CODE_COOLDOWN",
    );

    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:01:00.000Z"));
    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:02:00.000Z"));
    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:03:00.000Z"));
    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:04:00.000Z"));
    await expect(service.requestPhoneCode("01012345678", new Date("2026-06-25T00:05:00.000Z"))).rejects.toThrow(
      "PHONE_CODE_RATE_LIMITED",
    );

    await expect(service.requestPhoneCode("01012345678", new Date("2026-06-25T01:00:01.000Z"))).resolves.toEqual({
      ok: true,
    });
  });

  it("enforces hourly IP request limit across phones", async () => {
    const sms = new InMemorySmsSender();
    const service = new PhoneService(sms, "pepper");
    const now = new Date("2026-06-25T00:00:00.000Z");

    for (let index = 0; index < 20; index += 1) {
      await service.requestPhoneCode(`010100000${String(index).padStart(2, "0")}`, now, {
        ip: "203.0.113.1",
        userAgent: "vitest",
      });
    }

    await expect(
      service.requestPhoneCode("01010000020", now, {
        ip: "203.0.113.1",
        userAgent: "vitest",
      }),
    ).rejects.toThrow("PHONE_CODE_IP_RATE_LIMITED");
  });

  it("locks verification after five failed code attempts until expiry", async () => {
    const sms = new InMemorySmsSender();
    const service = new PhoneService(sms, "pepper");

    await service.requestPhoneCode("01012345678", new Date("2026-06-25T00:00:00.000Z"));

    for (let index = 0; index < 5; index += 1) {
      await expect(service.verifyPhoneCode("01012345678", "000000", new Date("2026-06-25T00:01:00.000Z"))).rejects.toThrow(
        "PHONE_CODE_INVALID",
      );
    }

    await expect(
      service.verifyPhoneCode("01012345678", sms.messages[0]!.code, new Date("2026-06-25T00:02:00.000Z")),
    ).rejects.toThrow("PHONE_CODE_LOCKED");
  });
});
