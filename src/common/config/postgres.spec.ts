import { describe, expect, it } from "@jest/globals";
import { createPostgresSslOptions } from "./postgres";

describe("createPostgresSslOptions", () => {
  it("disables TLS only when explicitly false", () => {
    expect(createPostgresSslOptions("false")).toBeUndefined();
  });

  it("verifies the server certificate and expands an optional CA", () => {
    expect(createPostgresSslOptions("true", "certificate\\nbody")).toEqual({
      rejectUnauthorized: true,
      ca: "certificate\nbody",
    });
  });

  it("rejects ambiguous TLS values", () => {
    expect(() => createPostgresSslOptions("prefer")).toThrow("POSTGRES_SSL_INVALID");
  });
});
