import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  phoneVerifications,
  phoneVerificationTokens,
  refreshTokens,
  users,
  type PhoneVerification,
  type PhoneVerificationToken,
  type User,
} from "src/modules/database/schema";

type PhoneTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

type VerificationReservation =
  { status: "reserved"; verification: PhoneVerification } | { status: "retry_too_soon" | "phone_limit" | "ip_limit" };

const lockVerificationQuotaKey = (tx: PhoneTransaction, key: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

const isLatestVerification = () => sql`NOT EXISTS (
  SELECT 1
  FROM "phoneVerification" AS newer
  WHERE newer."phoneE164" = ${phoneVerifications.phoneE164}
    AND (
      newer."createdAt" > ${phoneVerifications.createdAt}
      OR (newer."createdAt" = ${phoneVerifications.createdAt} AND newer.id > ${phoneVerifications.id})
    )
)`;

@Injectable()
export class PhoneRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  findUserByPhone(phoneE164: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.phone, phoneE164) });
  }

  reserveVerification = async (input: {
    phoneE164: string;
    purpose: string;
    requestIpHash: string;
    userAgentHash: string;
    cooldownMs: number;
    phoneLimit: number;
    ipLimit: number;
  }): Promise<VerificationReservation> =>
    this.db.transaction(async (tx) => {
      const quotaKeys = [`phone:${input.phoneE164}`, `ip:${input.requestIpHash}`].sort();
      for (const key of quotaKeys) await lockVerificationQuotaKey(tx, key);
      const clock = await tx.execute<{ nowMs: string }>(
        sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs"`,
      );
      const nowMs = Number(clock.rows[0]?.nowMs);
      if (!Number.isSafeInteger(nowMs)) throw new Error("DATABASE_CLOCK_UNAVAILABLE");
      const now = new Date(nowMs);

      const latest = await tx.query.phoneVerifications.findFirst({
        where: eq(phoneVerifications.phoneE164, input.phoneE164),
        orderBy: [desc(phoneVerifications.createdAt), desc(phoneVerifications.id)],
      });
      if (latest && now.getTime() - latest.createdAt.getTime() < input.cooldownMs) {
        return { status: "retry_too_soon" };
      }

      const since = new Date(now.getTime() - 60 * 60 * 1000);
      const [phoneRequests] = await tx
        .select({ count: count() })
        .from(phoneVerifications)
        .where(and(eq(phoneVerifications.phoneE164, input.phoneE164), gt(phoneVerifications.createdAt, since)));
      if (Number(phoneRequests?.count ?? 0) >= input.phoneLimit) return { status: "phone_limit" };

      const [ipRequests] = await tx
        .select({ count: count() })
        .from(phoneVerifications)
        .where(and(eq(phoneVerifications.requestIpHash, input.requestIpHash), gt(phoneVerifications.createdAt, since)));
      if (Number(ipRequests?.count ?? 0) >= input.ipLimit) return { status: "ip_limit" };

      const [verification] = await tx
        .insert(phoneVerifications)
        .values({
          phoneE164: input.phoneE164,
          codeHash: "pending",
          purpose: input.purpose,
          expiresAt: now,
          requestIpHash: input.requestIpHash,
          userAgentHash: input.userAgentHash,
          createdAt: now,
        })
        .returning();
      if (!verification) throw new Error("PHONE_VERIFICATION_CREATE_FAILED");
      return { status: "reserved", verification };
    });

  async activateVerification(id: string, codeHash: string, ttlMs: number): Promise<PhoneVerification | undefined> {
    const [verification] = await this.db
      .update(phoneVerifications)
      .set({ codeHash, expiresAt: sql`clock_timestamp() + (${ttlMs} * interval '1 millisecond')` })
      .where(and(eq(phoneVerifications.id, id), eq(phoneVerifications.codeHash, "pending"), isLatestVerification()))
      .returning();
    return verification;
  }

  async deleteVerification(id: string): Promise<void> {
    await this.db.delete(phoneVerifications).where(eq(phoneVerifications.id, id));
  }

  latestVerification(phoneE164: string): Promise<PhoneVerification | undefined> {
    return this.db.query.phoneVerifications.findFirst({
      where: eq(phoneVerifications.phoneE164, phoneE164),
      orderBy: [desc(phoneVerifications.createdAt), desc(phoneVerifications.id)],
    });
  }

  claimVerificationAttempt = async (input: {
    id: string;
    phoneE164: string;
    purposes: string[];
  }): Promise<PhoneVerification | undefined> => {
    const [claimed] = await this.db
      .update(phoneVerifications)
      .set({ attemptCount: sql`${phoneVerifications.attemptCount} + 1` })
      .where(
        and(
          eq(phoneVerifications.id, input.id),
          eq(phoneVerifications.phoneE164, input.phoneE164),
          inArray(phoneVerifications.purpose, input.purposes),
          isNull(phoneVerifications.verifiedAt),
          gt(phoneVerifications.expiresAt, sql`clock_timestamp()`),
          lt(phoneVerifications.attemptCount, 5),
          isLatestVerification(),
        ),
      )
      .returning();

    return claimed;
  };

  markVerified = async (id: string): Promise<PhoneVerification | undefined> => {
    const [updated] = await this.db
      .update(phoneVerifications)
      .set({ verifiedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(phoneVerifications.id, id),
          isNull(phoneVerifications.verifiedAt),
          gt(phoneVerifications.expiresAt, sql`clock_timestamp()`),
          gt(phoneVerifications.attemptCount, 0),
          isLatestVerification(),
        ),
      )
      .returning();

    return updated;
  };

  async createPhoneVerificationToken(input: {
    token: string;
    phoneE164: string;
    verificationId: string;
    expiresAt: Date;
  }): Promise<void> {
    const { token, ...values } = input;
    await this.db.insert(phoneVerificationTokens).values({ ...values, tokenHash: hashToken(token) });
  }

  findPhoneVerificationToken(token: string): Promise<PhoneVerificationToken | undefined> {
    return this.db.query.phoneVerificationTokens.findFirst({
      where: and(
        eq(phoneVerificationTokens.tokenHash, hashToken(token)),
        isNull(phoneVerificationTokens.usedAt),
        gt(phoneVerificationTokens.expiresAt, new Date()),
      ),
    });
  }

  resetPasswordWithVerification = async (input: {
    verificationId: string;
    phoneE164: string;
    password: string;
  }): Promise<User | undefined> =>
    this.db.transaction(async (tx) => {
      const [lockedUser] = await tx
        .select({ userId: users.userId })
        .from(users)
        .where(eq(users.phone, input.phoneE164))
        .for("update");
      if (!lockedUser) return undefined;

      const [verified] = await tx
        .update(phoneVerifications)
        .set({ verifiedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(phoneVerifications.id, input.verificationId),
            eq(phoneVerifications.phoneE164, input.phoneE164),
            eq(phoneVerifications.purpose, "password_reset"),
            isNull(phoneVerifications.verifiedAt),
            gt(phoneVerifications.expiresAt, sql`clock_timestamp()`),
            gt(phoneVerifications.attemptCount, 0),
            isLatestVerification(),
          ),
        )
        .returning({ id: phoneVerifications.id });
      if (!verified) return undefined;

      const [user] = await tx
        .update(users)
        .set({ password: input.password, updatedAt: new Date() })
        .where(eq(users.userId, lockedUser.userId))
        .returning();
      if (!user) throw new Error("PASSWORD_RESET_USER_UPDATE_FAILED");

      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.userId));
      return user;
    });
}
