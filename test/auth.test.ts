import { describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth-service.js";
import type { KakaoClient } from "../src/kakao/kakao-client.js";

describe("AuthService", () => {
  it("requires phone verification for a new Kakao profile", async () => {
    const kakaoClient: KakaoClient = {
      getProfile: async () => ({ id: "kakao-1", nickname: "tea" }),
    };
    const auth = new AuthService(kakaoClient);

    const result = await auth.loginWithKakao("access-token");

    expect(result.requiresPhone).toBe(true);
    if (result.requiresPhone) {
      expect(result.kakaoToken).toBeTruthy();
      expect(result.nickname).toBe("tea");
    }
  });

  it("links a verified phone user to Kakao and logs in next time", async () => {
    const kakaoClient: KakaoClient = {
      getProfile: async () => ({ id: "kakao-1", nickname: "tea" }),
    };
    const auth = new AuthService(kakaoClient);
    const login = await auth.loginWithKakao("access-token", new Date("2026-06-25T00:00:00.000Z"));

    if (!login.requiresPhone) {
      throw new Error("expected phone requirement");
    }

    const linked = await auth.attachPhoneUser(
      login.kakaoToken,
      { id: "user-1", phoneE164: "+821012345678", nickname: "tea", intro: "" },
      new Date("2026-06-25T00:01:00.000Z"),
    );
    const nextLogin = await auth.loginWithKakao("access-token", new Date("2026-06-25T00:02:00.000Z"));

    expect(linked.session.userId).toBe("user-1");
    expect(nextLogin.requiresPhone).toBe(false);
    if (!nextLogin.requiresPhone) {
      expect(nextLogin.user.phoneE164).toBe("+821012345678");
    }
  });

  it("rejects expired Kakao phone-link tokens", async () => {
    const auth = new AuthService({
      getProfile: async () => ({ id: "kakao-1", nickname: "tea" }),
    });
    const login = await auth.loginWithKakao("access-token", new Date("2026-06-25T00:00:00.000Z"));

    if (!login.requiresPhone) {
      throw new Error("expected phone requirement");
    }

    await expect(
      auth.attachPhoneUser(
        login.kakaoToken,
        { id: "user-1", phoneE164: "+821012345678", nickname: "tea", intro: "" },
        new Date("2026-06-25T00:16:00.000Z"),
      ),
    ).rejects.toThrow("KAKAO_TOKEN_EXPIRED");
  });
});
