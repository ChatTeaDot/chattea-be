import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, lt, or } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  authIdentities,
  communityCommentReports,
  communityPostReports,
  communityProfiles,
  matchActions,
  matches,
  messageReports,
  notifications,
  phoneVerificationTokens,
  pushTokens,
  refreshTokens,
  rooms,
  userBlocks,
  userBoosts,
  userConsumableBalances,
  userLikedMeAccesses,
  userLikes,
  userProfilePhotos,
  userSubscriptions,
  users,
  type PhoneVerificationToken,
  type User,
  type UserSubscription,
} from "src/modules/database/schema";
import { UpdateEmailRepositoryInput, UpdatePasswordRepositoryInput } from "./user.types";

@Injectable()
export class UserRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  findUser(userId: string): Promise<User | undefined> {
    return this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  }

  findProfilePhotos(userId: string) {
    return this.db.query.userProfilePhotos.findMany({
      where: eq(userProfilePhotos.userId, userId),
      orderBy: (photos, { asc }) => [asc(photos.position)],
    });
  }

  async findUserProfile(userId: string) {
    const [user, photos] = await Promise.all([this.findUser(userId), this.findProfilePhotos(userId)]);
    if (!user) return undefined;
    return { ...user, photos };
  }

  findCurrentSubscription(userId: string): Promise<UserSubscription | undefined> {
    return this.db.query.userSubscriptions.findFirst({
      where: and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.status, "active"),
        or(isNull(userSubscriptions.currentPeriodEndsAt), gt(userSubscriptions.currentPeriodEndsAt, new Date())),
      ),
      orderBy: desc(userSubscriptions.createdAt),
    });
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

  updateEmail(input: UpdateEmailRepositoryInput): Promise<User[]> {
    const { userId, email } = input;
    return this.db.update(users).set({ email, updatedAt: new Date() }).where(eq(users.userId, userId)).returning();
  }

  updatePassword(input: UpdatePasswordRepositoryInput): Promise<User[]> {
    const { userId, password } = input;
    return this.db.update(users).set({ password, updatedAt: new Date() }).where(eq(users.userId, userId)).returning();
  }

  async replaceProfile(input: {
    userId: string;
    userName: string;
    birthDate: string;
    region: string;
    interestedGender: string;
    intro: string;
    photoUrls: readonly string[];
  }) {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [user] = await tx
        .update(users)
        .set({
          userName: input.userName,
          birthDate: input.birthDate,
          region: input.region,
          interestedGender: input.interestedGender,
          intro: input.intro,
          profileCompletedAt: now,
          updatedAt: now,
        })
        .where(eq(users.userId, input.userId))
        .returning();

      if (!user) throw new Error("USER_NOT_FOUND");

      await tx.delete(userProfilePhotos).where(eq(userProfilePhotos.userId, input.userId));
      const photos = await tx
        .insert(userProfilePhotos)
        .values(input.photoUrls.map((url, position) => ({ userId: input.userId, url, position })))
        .returning();

      return { ...user, photos };
    });
  }

  async scheduleDeletion(userId: string, scheduledFor: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ hiddenAt: new Date(), deletionScheduledAt: scheduledFor, updatedAt: new Date() })
        .where(and(eq(users.userId, userId), isNull(users.deletedAt)));
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      await tx.delete(pushTokens).where(eq(pushTokens.userId, userId));
    });
  }

  async restoreScheduledDeletion(userId: string): Promise<boolean> {
    const [user] = await this.db
      .update(users)
      .set({ hiddenAt: null, deletionScheduledAt: null, updatedAt: new Date() })
      .where(and(eq(users.userId, userId), gt(users.deletionScheduledAt, new Date()), isNull(users.deletedAt)))
      .returning({ userId: users.userId });
    return Boolean(user);
  }

  findDueDeletionUserIds(now: Date): Promise<{ userId: string }[]> {
    return this.db
      .select({ userId: users.userId })
      .from(users)
      .where(and(lt(users.deletionScheduledAt, now), isNull(users.deletedAt)));
  }

  async anonymizeDeletedAccount(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date();
      const matchRooms = await tx
        .select({ roomId: matches.roomId })
        .from(matches)
        .where(or(eq(matches.userLowId, userId), eq(matches.userHighId, userId)));

      await tx.delete(userProfilePhotos).where(eq(userProfilePhotos.userId, userId));
      await tx.delete(pushTokens).where(eq(pushTokens.userId, userId));
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      await tx.delete(authIdentities).where(eq(authIdentities.userId, userId));
      await tx.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
      await tx.delete(userConsumableBalances).where(eq(userConsumableBalances.userId, userId));
      await tx.delete(userBoosts).where(eq(userBoosts.userId, userId));
      await tx.delete(userLikedMeAccesses).where(eq(userLikedMeAccesses.userId, userId));
      await tx.delete(userLikes).where(or(eq(userLikes.likerUserId, userId), eq(userLikes.likedUserId, userId)));
      await tx
        .delete(matchActions)
        .where(or(eq(matchActions.actorUserId, userId), eq(matchActions.targetUserId, userId)));
      await tx.delete(userBlocks).where(or(eq(userBlocks.blockerUserId, userId), eq(userBlocks.blockedUserId, userId)));
      await tx.delete(notifications).where(eq(notifications.userId, userId));
      await tx.delete(communityPostReports).where(eq(communityPostReports.reporterUserId, userId));
      await tx.delete(communityCommentReports).where(eq(communityCommentReports.reporterUserId, userId));
      await tx.delete(messageReports).where(eq(messageReports.reporterUserId, userId));
      if (matchRooms.length > 0) {
        await tx.delete(rooms).where(
          inArray(
            rooms.id,
            matchRooms.map(({ roomId }) => roomId),
          ),
        );
      }
      await tx
        .update(communityProfiles)
        .set({ name: "익명", updatedAt: now })
        .where(eq(communityProfiles.userId, userId));
      await tx
        .update(users)
        .set({
          email: `deleted-${userId}@chattea.invalid`,
          phone: null,
          password: "",
          userName: "탈퇴한 사용자",
          intro: "",
          birthDate: null,
          region: null,
          interestedGender: null,
          profileCompletedAt: null,
          deletionScheduledAt: null,
          deletedAt: now,
          updatedAt: now,
        })
        .where(eq(users.userId, userId));
    });
  }
}
