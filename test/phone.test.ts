import { describe, expect, it } from "vitest";
import { hashPhoneCode, isExpired, verifyPhoneCodeHash } from "../src/modules/auth/phone-code.service.js";
import { normalizeKoreanPhone } from "../src/modules/auth/normalize-phone.service.js";

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
