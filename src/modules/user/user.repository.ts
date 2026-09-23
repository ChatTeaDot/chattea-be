import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
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
  profileUploads,
  pushOutbox,
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
  type InterestedGender,
  type User,
  type UserSubscription,
} from "src/modules/database/schema";

@Injectable()
export class UserRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  findUser = (userId: string): Promise<User | undefined> => {
    return this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  };

  findProfilePhotos = (userId: string) => {
    return this.db.query.userProfilePhotos.findMany({
      where: eq(userProfilePhotos.userId, userId),
      orderBy: (photos, { asc }) => [asc(photos.position)],
    });
  };

  findUserProfile = async (userId: string) => {
    const [user, photos] = await Promise.all([this.findUser(userId), this.findProfilePhotos(userId)]);
    if (!user) return undefined;
    return { ...user, photos };
  };

  findCurrentSubscription = (userId: string): Promise<UserSubscription | undefined> => {
    return this.db.query.userSubscriptions.findFirst({
      where: and(
        eq(userSubscriptions.userId, userId),
        eq(userSubscriptions.status, "active"),
        or(isNull(userSubscriptions.currentPeriodEndsAt), gt(userSubscriptions.currentPeriodEndsAt, new Date())),
      ),
      orderBy: desc(userSubscriptions.createdAt),
    });
  };

  replaceProfile = async (input: {
    userId: string;
    userName: string;
    birthDate: string;
    region: string;
    interestedGender: InterestedGender;
    intro: string;
    photoUploadIds: readonly string[];
  }) => {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      if (input.photoUploadIds.length === 0) throw new Error("PROFILE_PHOTO_UPLOAD_INVALID");
      const uploads = await tx
        .select({ id: profileUploads.id, publicUrl: profileUploads.publicUrl })
        .from(profileUploads)
        .where(
          and(
            eq(profileUploads.userId, input.userId),
            eq(profileUploads.status, "verified"),
            inArray(profileUploads.id, [...input.photoUploadIds]),
          ),
        )
        .for("share");
      const legacyPhotos = await tx
        .select({ id: userProfilePhotos.id, url: userProfilePhotos.url })
        .from(userProfilePhotos)
        .where(
          and(
            eq(userProfilePhotos.userId, input.userId),
            isNull(userProfilePhotos.uploadId),
            inArray(userProfilePhotos.id, [...input.photoUploadIds]),
          ),
        )
        .for("share");
      const authorityById = new Map<string, { photoId?: string; uploadId?: string; url: string }>();
      for (const upload of uploads) {
        if (!upload.publicUrl || authorityById.has(upload.id)) throw new Error("PROFILE_PHOTO_UPLOAD_INVALID");
        authorityById.set(upload.id, { uploadId: upload.id, url: upload.publicUrl });
      }
      for (const legacyPhoto of legacyPhotos) {
        if (authorityById.has(legacyPhoto.id)) throw new Error("PROFILE_PHOTO_UPLOAD_INVALID");
        authorityById.set(legacyPhoto.id, { photoId: legacyPhoto.id, url: legacyPhoto.url });
      }
      const orderedPhotos = input.photoUploadIds.map((authorityId) => authorityById.get(authorityId));
      if (orderedPhotos.some((photo) => !photo)) throw new Error("PROFILE_PHOTO_UPLOAD_INVALID");
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
        .values(
          orderedPhotos.map((photo, position) => {
            if (!photo) throw new Error("PROFILE_PHOTO_UPLOAD_INVALID");
            return {
              id: photo.photoId,
              userId: input.userId,
              uploadId: photo.uploadId,
              url: photo.url,
              position,
            };
          }),
        )
        .returning();

      return { ...user, photos };
    });
  };

  scheduleDeletion = (userId: string, scheduledFor: Date): Promise<Date> => {
    return this.db.transaction(async (tx) => {
      const now = new Date();
      const [scheduled] = await tx
        .update(users)
        .set({
          hiddenAt: now,
          deletionScheduledAt: scheduledFor,
          updatedAt: now,
        })
        .where(and(eq(users.userId, userId), isNull(users.deletedAt), isNull(users.deletionScheduledAt)))
        .returning({ deletionScheduledAt: users.deletionScheduledAt });
      const account =
        scheduled ??
        (await tx.query.users.findFirst({
          columns: { deletionScheduledAt: true },
          where: and(eq(users.userId, userId), isNull(users.deletedAt)),
        }));
      if (!account?.deletionScheduledAt) throw new Error("ACCOUNT_DELETION_SCHEDULE_FAILED");
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
      const tokenRows = await tx.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.userId, userId));
      const tokenIds = tokenRows.map(({ id }) => id);
      if (tokenIds.length > 0) {
        await tx
          .update(pushOutbox)
          .set({ status: "cancelled", completedAt: new Date(), leaseExpiresAt: null, updatedAt: new Date() })
          .where(
            and(
              inArray(pushOutbox.pushTokenId, tokenIds),
              inArray(pushOutbox.status, ["queued", "sending", "receipt_pending", "receipt_checking"]),
            ),
          );
      }
      await tx.delete(pushTokens).where(eq(pushTokens.userId, userId));
      return account.deletionScheduledAt;
    });
  };

  restoreScheduledDeletion = async (userId: string): Promise<boolean> => {
    const [user] = await this.db
      .update(users)
      .set({
        hiddenAt: null,
        deletionScheduledAt: null,
        deletionLeaseExpiresAt: null,
        deletionAttempts: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(users.userId, userId), gt(users.deletionScheduledAt, new Date()), isNull(users.deletedAt)))
      .returning({ userId: users.userId });
    return Boolean(user);
  };

  claimDueDeletionBatch = (input: { now: Date; leaseExpiresAt: Date; limit: number }) =>
    this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ userId: users.userId })
        .from(users)
        .where(
          and(
            lte(users.deletionScheduledAt, input.now),
            isNull(users.deletedAt),
            or(isNull(users.deletionLeaseExpiresAt), lte(users.deletionLeaseExpiresAt, input.now)),
          ),
        )
        .orderBy(asc(users.deletionScheduledAt), asc(users.userId))
        .limit(input.limit)
        .for("update", { skipLocked: true });
      const userIds = candidates.map(({ userId }) => userId);
      if (userIds.length === 0) return { jobs: [], hasMore: false };
      await tx
        .update(users)
        .set({
          deletionLeaseExpiresAt: input.leaseExpiresAt,
          deletionAttempts: sql`${users.deletionAttempts} + 1`,
          updatedAt: input.now,
        })
        .where(inArray(users.userId, userIds));
      const [remaining] = await tx
        .select({ userId: users.userId })
        .from(users)
        .where(
          and(
            lte(users.deletionScheduledAt, input.now),
            isNull(users.deletedAt),
            or(isNull(users.deletionLeaseExpiresAt), lte(users.deletionLeaseExpiresAt, input.now)),
          ),
        )
        .limit(1);
      return {
        jobs: userIds.map((userId) => ({ userId, deletionLeaseExpiresAt: input.leaseExpiresAt })),
        hasMore: Boolean(remaining),
      };
    });

  releaseDeletionLease = async (input: { userId: string; deletionLeaseExpiresAt: Date; now: Date }): Promise<void> => {
    await this.db
      .update(users)
      .set({ deletionLeaseExpiresAt: null, updatedAt: input.now })
      .where(
        and(
          eq(users.userId, input.userId),
          eq(users.deletionLeaseExpiresAt, input.deletionLeaseExpiresAt),
          isNull(users.deletedAt),
        ),
      );
  };

  anonymizeDeletedAccount = async (input: {
    userId: string;
    deletionLeaseExpiresAt: Date;
    now: Date;
  }): Promise<void> => {
    await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .select({ userId: users.userId })
        .from(users)
        .where(
          and(
            eq(users.userId, input.userId),
            isNull(users.deletedAt),
            lte(users.deletionScheduledAt, input.now),
            eq(users.deletionLeaseExpiresAt, input.deletionLeaseExpiresAt),
            gt(users.deletionLeaseExpiresAt, input.now),
          ),
        )
        .for("update");
      if (!claimed) throw new Error("ACCOUNT_DELETION_CLAIM_REQUIRED");
      const matchRooms = await tx
        .select({ roomId: matches.roomId })
        .from(matches)
        .where(or(eq(matches.userLowId, input.userId), eq(matches.userHighId, input.userId)));

      await tx
        .update(profileUploads)
        .set({
          status: "failed",
          failureCode: "UPLOAD_OWNER_DELETED",
          processingLeaseExpiresAt: null,
          cleanupLeaseExpiresAt: sql`CASE
            WHEN ${profileUploads.status} = 'processing'
              AND ${profileUploads.finalKey} IS NOT NULL
              AND ${profileUploads.processingLeaseExpiresAt} IS NOT NULL
            THEN ${profileUploads.processingLeaseExpiresAt}
            ELSE NULL
          END`,
          cleanupAttempts: 0,
          updatedAt: input.now,
        })
        .where(eq(profileUploads.userId, input.userId));
      await tx
        .update(profileUploads)
        .set({ finalDeletionPendingAt: input.now, updatedAt: input.now })
        .where(
          and(
            eq(profileUploads.userId, input.userId),
            isNotNull(profileUploads.finalKey),
            isNull(profileUploads.finalDeletedAt),
          ),
        );
      await tx.delete(userProfilePhotos).where(eq(userProfilePhotos.userId, input.userId));
      await tx.delete(pushTokens).where(eq(pushTokens.userId, input.userId));
      await tx.delete(refreshTokens).where(eq(refreshTokens.userId, input.userId));
      await tx.delete(authIdentities).where(eq(authIdentities.userId, input.userId));
      await tx.delete(userSubscriptions).where(eq(userSubscriptions.userId, input.userId));
      await tx.delete(userConsumableBalances).where(eq(userConsumableBalances.userId, input.userId));
      await tx.delete(userBoosts).where(eq(userBoosts.userId, input.userId));
      await tx.delete(userLikedMeAccesses).where(eq(userLikedMeAccesses.userId, input.userId));
      await tx
        .delete(userLikes)
        .where(or(eq(userLikes.likerUserId, input.userId), eq(userLikes.likedUserId, input.userId)));
      await tx
        .delete(matchActions)
        .where(or(eq(matchActions.actorUserId, input.userId), eq(matchActions.targetUserId, input.userId)));
      await tx
        .delete(userBlocks)
        .where(or(eq(userBlocks.blockerUserId, input.userId), eq(userBlocks.blockedUserId, input.userId)));
      await tx.delete(notifications).where(eq(notifications.userId, input.userId));
      await tx.delete(communityPostReports).where(eq(communityPostReports.reporterUserId, input.userId));
      await tx.delete(communityCommentReports).where(eq(communityCommentReports.reporterUserId, input.userId));
      await tx.delete(messageReports).where(eq(messageReports.reporterUserId, input.userId));
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
        .set({ name: "익명", updatedAt: input.now })
        .where(eq(communityProfiles.userId, input.userId));
      await tx
        .update(users)
        .set({
          email: `deleted-${input.userId}@chattea.invalid`,
          phone: null,
          password: "",
          userName: "탈퇴한 사용자",
          intro: "",
          birthDate: null,
          region: null,
          interestedGender: null,
          profileCompletedAt: null,
          deletionScheduledAt: null,
          deletionLeaseExpiresAt: null,
          deletedAt: input.now,
          updatedAt: input.now,
        })
        .where(eq(users.userId, input.userId));
    });
  };
}
