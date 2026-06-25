const KOREAN_MOBILE = /^10\d{8}$/;

export function normalizeKoreanPhone(input: string): string {
  const compact = input.replace(/[\s-]/g, "");

  if (compact.startsWith("+82")) {
    const national = compact.slice(3);
    if (!KOREAN_MOBILE.test(national)) {
      throw new Error("INVALID_KOREAN_PHONE");
    }
    return `+82${national}`;
  }

  if (compact.startsWith("010")) {
    const national = compact.slice(1);
    if (!KOREAN_MOBILE.test(national)) {
      throw new Error("INVALID_KOREAN_PHONE");
    }
    return `+82${national}`;
  }

  throw new Error("INVALID_KOREAN_PHONE");
}
