import { describe, expect, it } from "vitest";
import { createRedactingLogger } from "../src/observability/logger.js";
import { redactPii } from "../src/observability/redaction.js";
import { HttpReporter } from "../src/observability/reporter.js";

describe("PII redaction", () => {
  it("redacts phone, code, tokens, signupToken, session, and content", () => {
    const redacted = redactPii({
      phoneE164: "+821012345678",
      code: "123456",
      signupToken: "signup-token",
      session: { token: "session-token" },
      messageContent: "hello",
      nested: {
        authorization: "Bearer secret-token",
        note: "call 010-1234-5678 with 654321",
      },
    });

    expect(JSON.stringify(redacted)).not.toContain("+821012345678");
    expect(JSON.stringify(redacted)).not.toContain("123456");
    expect(JSON.stringify(redacted)).not.toContain("signup-token");
    expect(JSON.stringify(redacted)).not.toContain("session-token");
    expect(JSON.stringify(redacted)).not.toContain("hello");
    expect(JSON.stringify(redacted)).not.toContain("010-1234-5678");
    expect(JSON.stringify(redacted)).not.toContain("654321");
  });

  it("redacts Yoga logger arguments before writing", () => {
    const calls: unknown[][] = [];
    const logger = createRedactingLogger({
      debug: (...args: unknown[]) => calls.push(args),
      info: (...args: unknown[]) => calls.push(args),
      warn: (...args: unknown[]) => calls.push(args),
      error: (...args: unknown[]) => calls.push(args),
    });

    logger.error("failed for 01012345678 code 123456", {
      signupToken: "signup-token",
      authorization: "Bearer auth-token",
    });

    const output = JSON.stringify(calls);
    expect(output).not.toContain("01012345678");
    expect(output).not.toContain("123456");
    expect(output).not.toContain("signup-token");
    expect(output).not.toContain("auth-token");
  });

  it("sends redacted warn/error payloads to observability reporters", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const reporter = new HttpReporter({
      endpoint: "https://logs.example",
      service: "datadog",
      apiKey: "api-key",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return new Response(null, { status: 202 });
      },
    });

    reporter.capture("error", ["failed for 01012345678", { authorization: "Bearer secret-token" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const body = calls[0]!.init.body as string;
    expect(calls[0]!.url).toBe("https://logs.example");
    expect((calls[0]!.init.headers as Record<string, string>)["dd-api-key"]).toBe("api-key");
    expect(body).toContain("datadog");
    expect(body).not.toContain("01012345678");
    expect(body).not.toContain("secret-token");
  });
});
