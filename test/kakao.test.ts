import { describe, expect, it } from "vitest";
import { KakaoRestClient } from "../src/modules/auth/kakao.strategy.js";

describe("KakaoRestClient", () => {
  it("loads profile from Kakao user info endpoint with bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new KakaoRestClient(
      "https://kapi.kakao.com/v2/user/me",
      async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return Response.json({
          id: 12345,
          kakao_account: { profile: { nickname: "tea" } },
        });
      },
    );

    const profile = await client.getProfile("access-token");

    expect(calls[0]!.url).toBe("https://kapi.kakao.com/v2/user/me");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer access-token");
    expect(profile).toEqual({ id: "12345", nickname: "tea" });
  });

  it("falls back to properties nickname", async () => {
    const client = new KakaoRestClient("https://kapi.kakao.com/v2/user/me", async () =>
      Response.json({
        id: "abc",
        properties: { nickname: "chattea" },
      }),
    );

    await expect(client.getProfile("token")).resolves.toEqual({
      id: "abc",
      nickname: "chattea",
    });
  });

  it("rejects invalid tokens and malformed profiles", async () => {
    const invalidToken = new KakaoRestClient(
      "https://kapi.kakao.com/v2/user/me",
      async () => new Response("Unauthorized", { status: 401 }),
    );
    const malformedProfile = new KakaoRestClient("https://kapi.kakao.com/v2/user/me", async () => Response.json({}));

    await expect(invalidToken.getProfile("bad-token")).rejects.toThrow("KAKAO_TOKEN_INVALID");
    await expect(malformedProfile.getProfile("token")).rejects.toThrow("KAKAO_PROFILE_INVALID");
  });
});
