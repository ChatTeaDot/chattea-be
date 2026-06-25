const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "authToken",
  "authorization",
  "code",
  "content",
  "file",
  "fileContent",
  "message",
  "messageContent",
  "phone",
  "phoneE164",
  "session",
  "signupToken",
  "token",
]);
const PHONE_PATTERN = /(\+82|0)10[-\s]?\d{4}[-\s]?\d{4}/g;
const SIX_DIGIT_CODE_PATTERN = /\b\d{6}\b/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactPii<T>(value: T): T {
  if (typeof value === "string") {
    return redactString(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactPii(item)) as T;
  }

  if (value instanceof Error) {
    const redacted = new Error(redactString(value.message));
    redacted.name = value.name;
    redacted.stack = value.stack ? redactString(value.stack) : undefined;
    return redacted as T;
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEYS.has(key) ? REDACTED : redactPii(item),
      ]),
    ) as T;
  }

  return value;
}

function redactString(value: string): string {
  return value.replace(BEARER_PATTERN, `Bearer ${REDACTED}`).replace(PHONE_PATTERN, REDACTED).replace(SIX_DIGIT_CODE_PATTERN, REDACTED);
}
