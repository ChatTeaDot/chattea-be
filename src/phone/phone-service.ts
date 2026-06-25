import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createPhoneCode, hashPhoneCode, isExpired, verifyPhoneCodeHash } from "./code.js";
import { normalizeKoreanPhone } from "./normalize-phone.js";
import { hashToken, type Session, type SessionStoreLike, type User } from "../auth/session-store.js";
import { SessionStore } from "../auth/session-store.js";
import type { SmsSender } from "../sms/sms-sender.js";

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
  private readonly verifications = new Map<string, Verification>();
  private readonly requestHistory = new Map<string, Date[]>();
  private readonly ipRequestHistory = new Map<string, Date[]>();
  private readonly signupTokens = new Map<string, { phoneE164: string; verificationId: string; expiresAt: Date }>();
  private readonly usersByPhone = new Map<string, User>();

  constructor(
    private readonly smsSender: SmsSender,
    private readonly pepper: string,
    private readonly sessionStore: SessionStoreLike = new SessionStore(),
  ) {}

  async requestPhoneCode(phone: string, now = new Date(), metadata: PhoneRequestMetadata = {}): Promise<{ ok: true }> {
    const phoneE164 = normalizeKoreanPhone(phone);
    const requestIpHash = metadata.ip ? this.hashMetadata(metadata.ip) : null;
    const userAgentHash = metadata.userAgent ? this.hashMetadata(metadata.userAgent) : null;
    const recentRequests = (this.requestHistory.get(phoneE164) ?? []).filter(
      (requestedAt) => now.getTime() - requestedAt.getTime() < 60 * 60 * 1000,
    );
    const recentIpRequests = requestIpHash
      ? (this.ipRequestHistory.get(requestIpHash) ?? []).filter(
          (requestedAt) => now.getTime() - requestedAt.getTime() < 60 * 60 * 1000,
        )
      : [];
    const latestRequest = recentRequests.at(-1);

    if (latestRequest && now.getTime() - latestRequest.getTime() < 60 * 1000) {
      throw new Error("PHONE_CODE_COOLDOWN");
    }

    if (recentRequests.length >= 5) {
      throw new Error("PHONE_CODE_RATE_LIMITED");
    }

    if (recentIpRequests.length >= 20) {
      throw new Error("PHONE_CODE_IP_RATE_LIMITED");
    }

    const code = createPhoneCode();
    const verification: Verification = {
      id: randomUUID(),
      phoneE164,
      codeHash: hashPhoneCode(code, phoneE164, this.pepper),
      requestIpHash,
      userAgentHash,
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
      attemptCount: 0,
      verifiedAt: null,
    };

    this.verifications.set(phoneE164, verification);
    this.requestHistory.set(phoneE164, [...recentRequests, now]);
    if (requestIpHash) {
      this.ipRequestHistory.set(requestIpHash, [...recentIpRequests, now]);
    }
    await this.smsSender.sendPhoneCode({ phoneE164, code });
    return { ok: true };
  }

  async verifyPhoneCode(phone: string, code: string, now = new Date()): Promise<VerifyPhoneResult> {
    const phoneE164 = normalizeKoreanPhone(phone);
    const verification = this.verifications.get(phoneE164);

    if (!verification || isExpired(verification.expiresAt, now)) {
      throw new Error("PHONE_CODE_EXPIRED");
    }

    if (verification.verifiedAt) {
      throw new Error("PHONE_CODE_ALREADY_USED");
    }

    if (verification.attemptCount >= 5) {
      throw new Error("PHONE_CODE_LOCKED");
    }

    verification.attemptCount += 1;

    if (!verifyPhoneCodeHash(code, verification.codeHash, phoneE164, this.pepper)) {
      throw new Error("PHONE_CODE_INVALID");
    }

    verification.verifiedAt = now;

    const user = this.usersByPhone.get(phoneE164);
    if (user) {
      return { status: "LOGIN", ...(await this.sessionStore.createSession(user)) };
    }

    const signupToken = randomUUID();
    this.signupTokens.set(signupToken, {
      phoneE164,
      verificationId: verification.id,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    });

    return { status: "SIGNUP_REQUIRED", signupToken };
  }

  async completePhoneSignup(signupToken: string, nickname: string, termsAccepted: boolean, now = new Date(), intro = "") {
    if (!termsAccepted) {
      throw new Error("TERMS_REQUIRED");
    }

    const token = this.signupTokens.get(signupToken);
    if (!token || isExpired(token.expiresAt, now)) {
      throw new Error("SIGNUP_TOKEN_EXPIRED");
    }

    if (this.usersByPhone.has(token.phoneE164)) {
      throw new Error("PHONE_ALREADY_REGISTERED");
    }

    const user: User = {
      id: randomUUID(),
      phoneE164: token.phoneE164,
      nickname: validateNickname(nickname),
      intro: validateIntro(intro),
    };

    this.usersByPhone.set(user.phoneE164, user);
    this.signupTokens.delete(signupToken);

    return this.sessionStore.createSession(user);
  }

  async verifyExistingPhone(phone: string, code: string, now = new Date()): Promise<User> {
    const phoneE164 = normalizeKoreanPhone(phone);
    if (!this.usersByPhone.has(phoneE164)) {
      throw new Error("PHONE_SIGNUP_REQUIRED");
    }

    const result = await this.verifyPhoneCode(phone, code, now);
    if (result.status !== "LOGIN") {
      throw new Error("PHONE_SIGNUP_REQUIRED");
    }

    return result.user;
  }

  private hashMetadata(value: string): string {
    return createHash("sha256").update(`${value}:${this.pepper}`).digest("hex");
  }
}

export class PostgresPhoneService {
  constructor(
    private readonly pool: Pool,
    private readonly smsSender: SmsSender,
    private readonly pepper: string,
    private readonly sessionStore: SessionStoreLike,
  ) {}

  async requestPhoneCode(phone: string, now = new Date(), metadata: PhoneRequestMetadata = {}): Promise<{ ok: true }> {
    const phoneE164 = normalizeKoreanPhone(phone);
    const requestIpHash = metadata.ip ? this.hashMetadata(metadata.ip) : null;
    const userAgentHash = metadata.userAgent ? this.hashMetadata(metadata.userAgent) : null;
    const recent = await this.pool.query<{ created_at: Date }>(
      `
        SELECT created_at
        FROM phone_verifications
        WHERE phone_e164 = $1
          AND created_at > $2
        ORDER BY created_at ASC
      `,
      [phoneE164, new Date(now.getTime() - 60 * 60 * 1000)],
    );
    const recentIp = requestIpHash
      ? await this.pool.query(
          `
            SELECT 1
            FROM phone_verifications
            WHERE request_ip_hash = $1
              AND created_at > $2
          `,
          [requestIpHash, new Date(now.getTime() - 60 * 60 * 1000)],
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
    await this.pool.query(
      `
        INSERT INTO phone_verifications (
          phone_e164,
          code_hash,
          purpose,
          expires_at,
          request_ip_hash,
          user_agent_hash,
          created_at
        )
        VALUES ($1, $2, 'login', $3, $4, $5, $6)
      `,
      [
        phoneE164,
        hashPhoneCode(code, phoneE164, this.pepper),
        new Date(now.getTime() + 5 * 60 * 1000),
        requestIpHash,
        userAgentHash,
        now,
      ],
    );
    await this.smsSender.sendPhoneCode({ phoneE164, code });
    return { ok: true };
  }

  async verifyPhoneCode(phone: string, code: string, now = new Date()): Promise<VerifyPhoneResult> {
    const phoneE164 = normalizeKoreanPhone(phone);
    const verification = await this.pool.query<{
      id: string;
      code_hash: string;
      expires_at: Date;
      verified_at: Date | null;
      attempt_count: number;
    }>(
      `
        SELECT id::text, code_hash, expires_at, verified_at, attempt_count
        FROM phone_verifications
        WHERE phone_e164 = $1
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [phoneE164],
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

    await this.pool.query("UPDATE phone_verifications SET attempt_count = attempt_count + 1 WHERE id = $1", [row.id]);

    if (!verifyPhoneCodeHash(code, row.code_hash, phoneE164, this.pepper)) {
      throw new Error("PHONE_CODE_INVALID");
    }

    await this.pool.query("UPDATE phone_verifications SET verified_at = $2 WHERE id = $1", [row.id, now]);

    const user = await this.findUserByPhone(phoneE164);
    if (user) {
      return { status: "LOGIN", ...(await this.sessionStore.createSession(user)) };
    }

    const signupToken = randomUUID();
    await this.pool.query(
      `
        INSERT INTO signup_tokens (token_hash, phone_e164, phone_verification_id, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [hashToken(signupToken), phoneE164, row.id, new Date(now.getTime() + 15 * 60 * 1000), now],
    );

    return { status: "SIGNUP_REQUIRED", signupToken };
  }

  async completePhoneSignup(signupToken: string, nickname: string, termsAccepted: boolean, now = new Date(), intro = "") {
    if (!termsAccepted) {
      throw new Error("TERMS_REQUIRED");
    }

    const cleanNickname = validateNickname(nickname);
    const cleanIntro = validateIntro(intro);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const token = await client.query<{ phone_e164: string }>(
        `
          SELECT phone_e164
          FROM signup_tokens
          WHERE token_hash = $1
            AND expires_at > $2
            AND used_at IS NULL
          FOR UPDATE
        `,
        [hashToken(signupToken), now],
      );
      const phoneE164 = token.rows[0]?.phone_e164;
      if (!phoneE164) {
        throw new Error("SIGNUP_TOKEN_EXPIRED");
      }

      const existing = await client.query("SELECT 1 FROM users WHERE phone_e164 = $1", [phoneE164]);
      if (existing.rows[0]) {
        throw new Error("PHONE_ALREADY_REGISTERED");
      }

      const user = await this.insertUser(client, phoneE164, cleanNickname, cleanIntro, now);
      await client.query("UPDATE signup_tokens SET used_at = $2 WHERE token_hash = $1", [hashToken(signupToken), now]);
      await client.query("COMMIT");

      return this.sessionStore.createSession(user);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    const result = await this.pool.query<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>("SELECT id::text, phone_e164, nickname, intro FROM users WHERE phone_e164 = $1", [phoneE164]);

    return result.rows[0] ? rowToUser(result.rows[0]) : null;
  }

  private async insertUser(client: PoolClient, phoneE164: string, nickname: string, intro: string, now: Date): Promise<User> {
    const result = await client.query<{
      id: string;
      phone_e164: string;
      nickname: string;
      intro: string;
    }>(
      `
        INSERT INTO users (phone_e164, nickname, intro, terms_accepted_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4, $4)
        RETURNING id::text, phone_e164, nickname, intro
      `,
      [phoneE164, nickname, intro, now],
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
