import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { KakaoClient } from "../kakao/kakao-client.js";
import type { Session, SessionStoreLike, User } from "./session-store.js";
import { SessionStore } from "./session-store.js";

export type KakaoLoginResult =
  | { requiresPhone: false; session: Session; user: User }
  | { requiresPhone: true; kakaoToken: string; nickname: string | null };

export class AuthService {
  private readonly usersByKakaoId = new Map<string, User>();
  protected readonly pendingKakaoByToken = new Map<
    string,
    { kakaoId: string; nickname: string | null; expiresAt: Date }
  >();

  constructor(
    protected readonly kakaoClient: KakaoClient,
    protected readonly sessionStore: SessionStoreLike = new SessionStore(),
  ) {}

  async loginWithKakao(accessToken: string, now = new Date()): Promise<KakaoLoginResult> {
    const profile = await this.kakaoClient.getProfile(accessToken);
    const existingUser = this.usersByKakaoId.get(profile.id);

    if (existingUser) {
      return { requiresPhone: false, ...(await this.sessionStore.createSession(existingUser)) };
    }

    const kakaoToken = randomUUID();
    this.pendingKakaoByToken.set(kakaoToken, {
      kakaoId: profile.id,
      nickname: profile.nickname,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    });

    return {
      requiresPhone: true,
      kakaoToken,
      nickname: profile.nickname,
    };
  }

  async attachPhoneUser(kakaoToken: string, user: User, now = new Date()) {
    const pending = this.pendingKakaoByToken.get(kakaoToken);

    if (!pending || pending.expiresAt.getTime() <= now.getTime()) {
      throw new Error("KAKAO_TOKEN_EXPIRED");
    }

    this.usersByKakaoId.set(pending.kakaoId, user);
    this.pendingKakaoByToken.delete(kakaoToken);

    return this.sessionStore.createSession(user);
  }
}

export class PostgresAuthService extends AuthService {
  constructor(
    kakaoClient: KakaoClient,
    private readonly pool: Pool,
    sessionStore: SessionStoreLike,
  ) {
    super(kakaoClient, sessionStore);
  }

  override async loginWithKakao(accessToken: string, now = new Date()): Promise<KakaoLoginResult> {
    const profile = await this.kakaoClient.getProfile(accessToken);
    const existing = await this.pool.query<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>(
      `
        SELECT users.id::text, users.phone_e164, users.nickname, users.intro
        FROM auth_identities
        JOIN users ON users.id = auth_identities.user_id
        WHERE auth_identities.provider = 'kakao'
          AND auth_identities.provider_user_id = $1
      `,
      [profile.id],
    );

    if (existing.rows[0]) {
      return {
        requiresPhone: false,
        ...(await this.sessionStore.createSession({
          id: existing.rows[0].id,
          phoneE164: existing.rows[0].phone_e164,
          nickname: existing.rows[0].nickname,
          intro: existing.rows[0].intro,
        })),
      };
    }

    return super.loginWithKakao(accessToken, now);
  }

  override async attachPhoneUser(kakaoToken: string, user: User, now = new Date()) {
    const pending = this.pendingKakaoByToken.get(kakaoToken);

    if (!pending || pending.expiresAt.getTime() <= now.getTime()) {
      throw new Error("KAKAO_TOKEN_EXPIRED");
    }

    await this.pool.query(
      `
        INSERT INTO auth_identities (user_id, provider, provider_user_id)
        VALUES ($1, 'kakao', $2)
        ON CONFLICT (provider, provider_user_id) DO UPDATE
        SET user_id = EXCLUDED.user_id
      `,
      [user.id, pending.kakaoId],
    );
    this.pendingKakaoByToken.delete(kakaoToken);

    return this.sessionStore.createSession(user);
  }
}
