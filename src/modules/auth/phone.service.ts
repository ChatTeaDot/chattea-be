import { createHash, randomUUID } from "node:crypto";
import { dbQuery, sql, type Database } from "../../db/client.js";
import { createPhoneCode, hashPhoneCode, isExpired, verifyPhoneCodeHash } from "./phone-code.service.js";
import { normalizeKoreanPhone } from "./normalize-phone.service.js";
import { hashToken, type Session, type SessionStoreLike, type User } from "./session.repository.js";
import type { SmsSender } from "./sms-sender.service.js";

const NICKNAME_MAX_LENGTH = 20;
const PROFILE_INTRO_MAX_LENGTH = 60;

type Verification = {
  id: string;
  phoneE164: string;
  codeHash: string;
  requestIpHash: string | null;
  userAgentHash: string | null;
  expiresAt: Date;
  attemptCount: number;
  verifiedAt: Date | null;
};

export type VerifyPhoneResult =
  | { status: "LOGIN"; session: Session; user: User }
  | { status: "SIGNUP_REQUIRED"; signupToken: string };

export type PhoneRequestMetadata = {
  ip?: string | null;
  userAgent?: string | null;
};

export class PhoneService {
  constructor(
    private readonly db: Database,
    private readonly smsSender: SmsSender,
    private readonly pepper: string,
    private readonly sessionStore: SessionStoreLike,
  ) {}

  async requestPhoneCode(phone: string, now = new Date(), metadata: PhoneRequestMetadata = {}): Promise<{ ok: true }> {
    const phoneE164 = normalizeKoreanPhone(phone);
    const requestIpHash = metadata.ip ? this.hashMetadata(metadata.ip) : null;
    const userAgentHash = metadata.userAgent ? this.hashMetadata(metadata.userAgent) : null;
    const recent = await dbQuery<{ created_at: Date }>(
      this.db,
      sql`
        SELECT created_at
        FROM phone_verifications
        WHERE phone_e164 = ${phoneE164}
          AND created_at > ${new Date(now.getTime() - 60 * 60 * 1000)}
        ORDER BY created_at ASC
      `,
    );
    const recentIp = requestIpHash
      ? await dbQuery(
          this.db,
          sql`
            SELECT 1
            FROM phone_verifications
            WHERE request_ip_hash = ${requestIpHash}
              AND created_at > ${new Date(now.getTime() - 60 * 60 * 1000)}
          `,
        )
      : { rows: [] };
    const latestRequest = recent.rows.at(-1)?.created_at;

    if (latestRequest && now.getTime() - latestRequest.getTime() < 60 * 1000) {
      throw new Error("PHONE_CODE_COOLDOWN");
    }

    if (recent.rows.length >= 5) {
      throw new Error("PHONE_CODE_RATE_LIMITED");
    }

    if (recentIp.rows.length >= 20) {
      throw new Error("PHONE_CODE_IP_RATE_LIMITED");
    }

    const code = createPhoneCode();
    await dbQuery(
      this.db,
      sql`
        INSERT INTO phone_verifications (
          phone_e164,
          code_hash,
          purpose,
          expires_at,
          request_ip_hash,
          user_agent_hash,
          created_at
        )
        VALUES (
          ${phoneE164},
          ${hashPhoneCode(code, phoneE164, this.pepper)},
          'login',
          ${new Date(now.getTime() + 5 * 60 * 1000)},
          ${requestIpHash},
          ${userAgentHash},
          ${now}
        )
      `,
    );
    await this.smsSender.sendPhoneCode({ phoneE164, code });
    return { ok: true };
  }

  async verifyPhoneCode(phone: string, code: string, now = new Date()): Promise<VerifyPhoneResult> {
    const phoneE164 = normalizeKoreanPhone(phone);
    const verification = await dbQuery<{
      id: string;
      code_hash: string;
      expires_at: Date;
      verified_at: Date | null;
      attempt_count: number;
    }>(
      this.db,
      sql`
        SELECT id::text, code_hash, expires_at, verified_at, attempt_count
        FROM phone_verifications
        WHERE phone_e164 = ${phoneE164}
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );
    const row = verification.rows[0];

    if (!row || isExpired(row.expires_at, now)) {
      throw new Error("PHONE_CODE_EXPIRED");
    }

    if (row.verified_at) {
      throw new Error("PHONE_CODE_ALREADY_USED");
    }

    if (row.attempt_count >= 5) {
      throw new Error("PHONE_CODE_LOCKED");
    }

    await dbQuery(this.db, sql`UPDATE phone_verifications SET attempt_count = attempt_count + 1 WHERE id = ${row.id}`);

    if (!verifyPhoneCodeHash(code, row.code_hash, phoneE164, this.pepper)) {
      throw new Error("PHONE_CODE_INVALID");
    }

    await dbQuery(this.db, sql`UPDATE phone_verifications SET verified_at = ${now} WHERE id = ${row.id}`);

    const user = await this.findUserByPhone(phoneE164);
    if (user) {
      return { status: "LOGIN", ...(await this.sessionStore.createSession(user)) };
    }

    const signupToken = randomUUID();
    await dbQuery(
      this.db,
      sql`
        INSERT INTO signup_tokens (token_hash, phone_e164, phone_verification_id, expires_at, created_at)
        VALUES (${hashToken(signupToken)}, ${phoneE164}, ${row.id}, ${new Date(now.getTime() + 15 * 60 * 1000)}, ${now})
      `,
    );

    return { status: "SIGNUP_REQUIRED", signupToken };
  }

  async completePhoneSignup(signupToken: string, nickname: string, termsAccepted: boolean, now = new Date(), intro = "") {
    if (!termsAccepted) {
      throw new Error("TERMS_REQUIRED");
    }

    const cleanNickname = validateNickname(nickname);
    const cleanIntro = validateIntro(intro);

    return this.db.transaction(async (tx) => {
      const token = await tx.execute<{ phone_e164: string }>(
        sql`
          SELECT phone_e164
          FROM signup_tokens
          WHERE token_hash = ${hashToken(signupToken)}
            AND expires_at > ${now}
            AND used_at IS NULL
          FOR UPDATE
        `,
      );
      const phoneE164 = token.rows[0]?.phone_e164;
      if (!phoneE164) {
        throw new Error("SIGNUP_TOKEN_EXPIRED");
      }

      const existing = await tx.execute(sql`SELECT 1 FROM users WHERE phone_e164 = ${phoneE164}`);
      if (existing.rows[0]) {
        throw new Error("PHONE_ALREADY_REGISTERED");
      }

      const user = await this.insertUser(tx, phoneE164, cleanNickname, cleanIntro, now);
      await tx.execute(sql`UPDATE signup_tokens SET used_at = ${now} WHERE token_hash = ${hashToken(signupToken)}`);

      return this.sessionStore.createSession(user);
    });
  }

  async verifyExistingPhone(phone: string, code: string, now = new Date()): Promise<User> {
    const phoneE164 = normalizeKoreanPhone(phone);
    const existing = await this.findUserByPhone(phoneE164);
    if (!existing) {
      throw new Error("PHONE_SIGNUP_REQUIRED");
    }

    const result = await this.verifyPhoneCode(phone, code, now);
    if (result.status !== "LOGIN") {
      throw new Error("PHONE_SIGNUP_REQUIRED");
    }

    return result.user;
  }

  private async findUserByPhone(phoneE164: string): Promise<User | null> {
    const result = await dbQuery<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>(this.db, sql`SELECT id::text, phone_e164, nickname, intro FROM users WHERE phone_e164 = ${phoneE164}`);

    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  }

  private async insertUser(
    client: { execute: Database["execute"] },
    phoneE164: string,
    nickname: string,
    intro: string,
    now: Date,
  ): Promise<User> {
    const result = await client.execute<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>(
      sql`
        INSERT INTO users (phone_e164, nickname, intro, terms_accepted_at, created_at, updated_at)
        VALUES (${phoneE164}, ${nickname}, ${intro}, ${now}, ${now}, ${now})
        RETURNING id::text, phone_e164, nickname, intro
      `,
    );

    return rowToUser(result.rows[0]!);
  }

  private hashMetadata(value: string): string {
    return createHash("sha256").update(`${value}:${this.pepper}`).digest("hex");
  }
}

function rowToUser(row: { id: string; phone_e164: string; nickname: string; intro: string }): User {
  return {
    id: row.id,
    phoneE164: row.phone_e164,
    nickname: row.nickname,
    intro: row.intro,
  };
}

function validateNickname(input: string): string {
  const nickname = input.trim();
  if (!nickname) {
    throw new Error("NICKNAME_REQUIRED");
  }

  if (nickname.length > NICKNAME_MAX_LENGTH) {
    throw new Error("NICKNAME_TOO_LONG");
  }

  return nickname;
}

function validateIntro(input: string): string {
  const intro = input.trim();
  if (intro.length > PROFILE_INTRO_MAX_LENGTH) {
    throw new Error("PROFILE_INTRO_TOO_LONG");
  }

  return intro;
}
