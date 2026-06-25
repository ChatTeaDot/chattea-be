import { createHash, randomInt, timingSafeEqual } from "node:crypto";

const CODE_PATTERN = /^\d{6}$/;

export function createPhoneCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashPhoneCode(code: string, phoneE164: string, pepper: string): string {
  return createHash("sha256").update(`${phoneE164}:${code}:${pepper}`).digest("hex");
}

export function verifyPhoneCodeHash(
  candidate: string,
  expectedHash: string,
  phoneE164: string,
  pepper: string,
): boolean {
  if (!CODE_PATTERN.test(candidate)) {
    return false;
  }

  const candidateHash = hashPhoneCode(candidate, phoneE164, pepper);
  return timingSafeEqual(Buffer.from(candidateHash, "hex"), Buffer.from(expectedHash, "hex"));
}

export function isExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
