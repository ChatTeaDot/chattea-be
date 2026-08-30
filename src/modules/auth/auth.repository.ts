import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  authIdentities,
  kakaoPhoneVerificationTokens,
  refreshTokens,
  phoneVerificationTokens,
  users,
  type AuthIdentity,
  type Gender,
  type KakaoPhoneVerificationToken,
  type RefreshToken,
  type PhoneVerificationToken,
  type User,
} from "src/modules/database/schema";
import { SigninAuthInput, SignupAuthRepositoryInput } from "./auth.types";

export class PhoneVerificationTokenConsumeFailedError extends Error {}
export class KakaoPhoneVerificationTokenConsumeFailedError extends Error {}

@Injectable()
export class AuthRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async signupWithPhoneVerificationToken(
    input: Omit<SignupAuthRepositoryInput, "phone">,
    token: string,
  ): Promise<User | undefined> {
    return this.db.transaction(async (tx) => {
      const [phoneVerificationToken] = await tx
        .update(phoneVerificationTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(phoneVerificationTokens.tokenHash, hashToken(token)),
            isNull(phoneVerificationTokens.usedAt),
            gt(phoneVerificationTokens.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!phoneVerificationToken) return undefined;

      const [user] = await tx
        .insert(users)
        .values({
          userId: input.userId,
          email: input.email,
          phone: phoneVerificationToken.phoneE164,
          password: input.password,
          userName: input.userName,
          gender: input.gender,
        })
        .returning();

      return user;
    });
  }

  signin(input: SigninAuthInput): Promise<User | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.email, input.email) });
  }

  async saveRefreshToken(input: { userId: string; deviceId: string; refreshToken: string; refreshTokenExp: Date }) {
    await this.db
      .insert(refreshTokens)
      .values(input)
      .onConflictDoUpdate({
        target: [refreshTokens.userId, refreshTokens.deviceId],
        set: {
          refreshToken: input.refreshToken,
          refreshTokenExp: input.refreshTokenExp,
          updatedAt: new Date(),
        },
      });
  }

  async rotateRefreshToken(input: {
    userId: string;
    deviceId: string;
    expectedRefreshToken: string;
    refreshToken: string;
    refreshTokenExp: Date;
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .select({ userId: users.userId })
        .from(users)
        .where(eq(users.userId, input.userId))
        .for("update");
      if (!user) return false;

      const [rotated] = await tx
        .update(refreshTokens)
        .set({
          refreshToken: input.refreshToken,
          refreshTokenExp: input.refreshTokenExp,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(refreshTokens.userId, input.userId),
            eq(refreshTokens.deviceId, input.deviceId),
            eq(refreshTokens.refreshToken, input.expectedRefreshToken),
            gt(refreshTokens.refreshTokenExp, new Date()),
          ),
        )
        .returning({ id: refreshTokens.id });
      return Boolean(rotated);
    });
  }

  findRefreshToken(userId: string, deviceId: string): Promise<RefreshToken | undefined> {
    return this.db.query.refreshTokens.findFirst({
      where: and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId)),
    });
  }

  async deleteRefreshToken(userId: string, deviceId: string): Promise<void> {
    await this.db
      .delete(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId)));
  }

  async findUserByIdentity(provider: string, providerUserId: string): Promise<User | null | undefined> {
    const identity: AuthIdentity | undefined = await this.db.query.authIdentities.findFirst({
      where: and(eq(authIdentities.provider, provider), eq(authIdentities.providerUserId, providerUserId)),
    });
    if (!identity) return null;

    return this.db.query.users.findFirst({ where: eq(users.userId, identity.userId) });
  }

  async createKakaoPhoneVerificationToken(input: {
    token: string;
    userId?: string;
    providerUserId: string;
    email?: string;
    expiresAt: Date;
  }): Promise<void> {
    const { token, ...values } = input;
    await this.db.insert(kakaoPhoneVerificationTokens).values({ ...values, tokenHash: hashToken(token) });
  }

  async consumeKakaoPhoneVerificationToken(token: string): Promise<KakaoPhoneVerificationToken | undefined> {
    const [savedToken] = await this.db
      .update(kakaoPhoneVerificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(kakaoPhoneVerificationTokens.tokenHash, hashToken(token)),
          isNull(kakaoPhoneVerificationTokens.usedAt),
          gt(kakaoPhoneVerificationTokens.expiresAt, new Date()),
        ),
      )
      .returning();

    return savedToken;
  }

  findKakaoPhoneVerificationToken(token: string): Promise<KakaoPhoneVerificationToken | undefined> {
    return this.db.query.kakaoPhoneVerificationTokens.findFirst({
      where: and(
        eq(kakaoPhoneVerificationTokens.tokenHash, hashToken(token)),
        isNull(kakaoPhoneVerificationTokens.usedAt),
        gt(kakaoPhoneVerificationTokens.expiresAt, new Date()),
      ),
    });
  }

  async consumePhoneVerificationToken(token: string): Promise<PhoneVerificationToken | undefined> {
    const [savedToken] = await this.db
      .update(phoneVerificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(phoneVerificationTokens.tokenHash, hashToken(token)),
          isNull(phoneVerificationTokens.usedAt),
          gt(phoneVerificationTokens.expiresAt, new Date()),
        ),
      )
      .returning();

    return savedToken;
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

  findUser(userId: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  }

  async attachPhone(userId: string, phone: string): Promise<User | undefined> {
    const [user] = await this.db
      .update(users)
      .set({ phone, updatedAt: new Date() })
      .where(eq(users.userId, userId))
      .returning();

    return user;
  }

  async attachPhoneWithKakaoPhoneVerificationTokens(input: {
    userId: string;
    phone: string;
    phoneVerificationToken: string;
    kakaoPhoneVerificationToken: string;
  }): Promise<User | undefined> {
    return this.db.transaction(async (tx) => {
      const [phoneVerificationToken, kakaoToken] = await Promise.all([
        tx
          .update(phoneVerificationTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(phoneVerificationTokens.tokenHash, hashToken(input.phoneVerificationToken)),
              isNull(phoneVerificationTokens.usedAt),
              gt(phoneVerificationTokens.expiresAt, new Date()),
            ),
          )
          .returning(),
        tx
          .update(kakaoPhoneVerificationTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(kakaoPhoneVerificationTokens.tokenHash, hashToken(input.kakaoPhoneVerificationToken)),
              isNull(kakaoPhoneVerificationTokens.usedAt),
              gt(kakaoPhoneVerificationTokens.expiresAt, new Date()),
            ),
          )
          .returning(),
      ]);
      if (!phoneVerificationToken[0]) throw new PhoneVerificationTokenConsumeFailedError();
      if (!kakaoToken[0]) throw new KakaoPhoneVerificationTokenConsumeFailedError();

      const [user] = await tx
        .update(users)
        .set({ phone: input.phone, updatedAt: new Date() })
        .where(eq(users.userId, input.userId))
        .returning();

      return user;
    });
  }

  async createKakaoPhoneUser(input: {
    userId: string;
    providerUserId: string;
    email: string;
    password: string;
    phone: string;
    gender: Gender;
  }): Promise<User> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          userId: input.userId,
          email: input.email,
          password: input.password,
          phone: input.phone,
          userName: input.email.split("@")[0] || "kakao",
          gender: input.gender,
        })
        .returning();
      if (!user) throw new Error("USER_CREATE_FAILED");

      await tx.insert(authIdentities).values({
        userId: input.userId,
        provider: "kakao",
        providerUserId: input.providerUserId,
      });

      return user;
    });
  }

  async createKakaoPhoneUserWithTokens(
    input: {
      userId: string;
      providerUserId: string;
      email: string;
      userName: string;
      password: string;
      phone: string;
      gender: Gender;
    },
    tokens: { phoneVerificationToken: string; kakaoPhoneVerificationToken: string },
  ): Promise<User> {
    return this.db.transaction(async (tx) => {
      const [phoneVerificationToken, kakaoToken] = await Promise.all([
        tx
          .update(phoneVerificationTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(phoneVerificationTokens.tokenHash, hashToken(tokens.phoneVerificationToken)),
              isNull(phoneVerificationTokens.usedAt),
              gt(phoneVerificationTokens.expiresAt, new Date()),
            ),
          )
          .returning(),
        tx
          .update(kakaoPhoneVerificationTokens)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(kakaoPhoneVerificationTokens.tokenHash, hashToken(tokens.kakaoPhoneVerificationToken)),
              isNull(kakaoPhoneVerificationTokens.usedAt),
              gt(kakaoPhoneVerificationTokens.expiresAt, new Date()),
            ),
          )
          .returning(),
      ]);
      if (!phoneVerificationToken[0]) throw new PhoneVerificationTokenConsumeFailedError();
      if (!kakaoToken[0]) throw new KakaoPhoneVerificationTokenConsumeFailedError();

      const [user] = await tx
        .insert(users)
        .values({
          userId: input.userId,
          email: input.email,
          password: input.password,
          phone: input.phone,
          userName: input.userName,
          gender: input.gender,
        })
        .returning();
      if (!user) throw new Error("USER_CREATE_FAILED");

      await tx.insert(authIdentities).values({
        userId: input.userId,
        provider: "kakao",
        providerUserId: input.providerUserId,
      });

      return user;
    });
  }
}
