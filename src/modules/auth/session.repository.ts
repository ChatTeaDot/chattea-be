import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { dbQuery, sql, type Database } from "../../db/client.js";

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

export class SessionStore implements SessionStoreLike {
  constructor(private readonly db: Database) {}

  async createSession(user: User): Promise<{ session: Session; user: User }> {
    const token = randomUUID();

    await dbQuery(
      this.db,
      sql`
        INSERT INTO users (id, phone_e164, nickname, intro, terms_accepted_at)
        VALUES (${user.id}, ${user.phoneE164}, ${user.nickname}, ${user.intro}, now())
        ON CONFLICT (id) DO UPDATE
        SET phone_e164 = EXCLUDED.phone_e164,
            nickname = EXCLUDED.nickname,
            intro = EXCLUDED.intro,
            updated_at = now()
      `,
    );
    await dbQuery(
      this.db,
      sql`
        INSERT INTO sessions (user_id, token_hash, expires_at)
        VALUES (${user.id}, ${hashToken(token)}, now() + interval '30 days')
      `,
    );

    return { session: { token, userId: user.id }, user };
  }

  async getUser(token: string | null): Promise<User | null> {
    if (!token) {
      return null;
    }

    const result = await dbQuery<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>(
      this.db,
      sql`
        SELECT users.id::text, users.phone_e164, users.nickname, users.intro
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ${hashToken(token)}
          AND sessions.expires_at > now()
      `,
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
