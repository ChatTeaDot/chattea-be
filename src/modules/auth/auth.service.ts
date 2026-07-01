import { randomUUID } from "node:crypto";
import { dbQuery, sql, type Database } from "../../db/client.js";
import type { KakaoClient } from "./kakao.strategy.js";
import type { Session, SessionStoreLike, User } from "./session.repository.js";

export type KakaoLoginResult =
  | { requiresPhone: false; session: Session; user: User }
  | { requiresPhone: true; kakaoToken: string; nickname: string | null };

export class AuthService {
  private readonly pendingKakaoByToken = new Map<
    string,
    { kakaoId: string; nickname: string | null; expiresAt: Date }
  >();

  constructor(
    private readonly kakaoClient: KakaoClient,
    private readonly db: Database,
    private readonly sessionStore: SessionStoreLike,
  ) {}

  async loginWithKakao(accessToken: string, now = new Date()): Promise<KakaoLoginResult> {
    const profile = await this.kakaoClient.getProfile(accessToken);
    const existing = await dbQuery<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>(
      this.db,
      sql`
        SELECT users.id::text, users.phone_e164, users.nickname, users.intro
        FROM auth_identities
        JOIN users ON users.id = auth_identities.user_id
        WHERE auth_identities.provider = 'kakao'
          AND auth_identities.provider_user_id = ${profile.id}
      `,
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

    await dbQuery(
      this.db,
      sql`
        INSERT INTO auth_identities (user_id, provider, provider_user_id)
        VALUES (${user.id}, 'kakao', ${pending.kakaoId})
        ON CONFLICT (provider, provider_user_id) DO UPDATE
        SET user_id = EXCLUDED.user_id
      `,
    );
    this.pendingKakaoByToken.delete(kakaoToken);

    return this.sessionStore.createSession(user);
  }
}
