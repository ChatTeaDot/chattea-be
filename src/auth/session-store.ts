import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type User = {
  id: string;
  phoneE164: string;
  nickname: string;
  intro: string;
};

export type Session = {
  token: string;
  userId: string;
};

export type SessionStoreLike = {
  createSession(user: User): { session: Session; user: User } | Promise<{ session: Session; user: User }>;
  getUser(token: string | null): User | null | Promise<User | null>;
};

export class SessionStore {
  private readonly usersById = new Map<string, User>();
  private readonly sessionsByToken = new Map<string, Session>();

  createSession(user: User): { session: Session; user: User } {
    const session = { token: randomUUID(), userId: user.id };

    this.usersById.set(user.id, user);
    this.sessionsByToken.set(session.token, session);

    return { session, user };
  }

  getUser(token: string | null): User | null {
    if (!token) {
      return null;
    }

    const session = this.sessionsByToken.get(token);
    return session ? (this.usersById.get(session.userId) ?? null) : null;
  }
}

export class PostgresSessionStore implements SessionStoreLike {
  constructor(private readonly pool: Pool) {}

  async createSession(user: User): Promise<{ session: Session; user: User }> {
    const token = randomUUID();

    await this.pool.query(
      `
        INSERT INTO users (id, phone_e164, nickname, intro, terms_accepted_at)
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT (id) DO UPDATE
        SET phone_e164 = EXCLUDED.phone_e164,
            nickname = EXCLUDED.nickname,
            intro = EXCLUDED.intro,
            updated_at = now()
      `,
      [user.id, user.phoneE164, user.nickname, user.intro],
    );
    await this.pool.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days')",
      [user.id, hashToken(token)],
    );

    return { session: { token, userId: user.id }, user };
  }

  async getUser(token: string | null): Promise<User | null> {
    if (!token) {
      return null;
    }

    const result = await this.pool.query<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>(
      `
        SELECT users.id::text, users.phone_e164, users.nickname, users.intro
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = $1
          AND sessions.expires_at > now()
      `,
      [hashToken(token)],
    );

    return result.rows[0]
      ? {
          id: result.rows[0].id,
          phoneE164: result.rows[0].phone_e164,
          nickname: result.rows[0].nickname,
          intro: result.rows[0].intro,
        }
      : null;
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
