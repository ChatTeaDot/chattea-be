export type KakaoProfile = {
  id: string;
  nickname: string | null;
};

export type KakaoClient = {
  getProfile(accessToken: string): Promise<KakaoProfile>;
};

export class KakaoRestClient implements KakaoClient {
  constructor(
    private readonly endpoint = "https://kapi.kakao.com/v2/user/me",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getProfile(accessToken: string): Promise<KakaoProfile> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error("KAKAO_TOKEN_INVALID");
    }

    const data = (await response.json()) as {
      id?: number | string;
      properties?: { nickname?: string };
      kakao_account?: { profile?: { nickname?: string } };
    };
    if (!data.id) {
      throw new Error("KAKAO_PROFILE_INVALID");
    }

    return {
      id: String(data.id),
      nickname: data.kakao_account?.profile?.nickname ?? data.properties?.nickname ?? null,
    };
  }
}
