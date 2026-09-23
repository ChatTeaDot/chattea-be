import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  matchActions,
  matches,
  roomMembers,
  rooms,
  userBlocks,
  userBoosts,
  userConsumableBalances,
  userLikedMeAccesses,
  userLikes,
  userProfilePhotos,
  userSubscriptions,
  users,
} from "src/modules/database/schema";

type CandidateBase = {
  id: string;
  userName: string;
  gender: string;
  birthDate: string | null;
  region: string | null;
  intro: string;
};

type MatchingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const lockMatchingKey = (tx: MatchingTransaction, key: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
const orderedMatchingPair = (userId: string, targetUserId: string): [string, string] =>
  userId < targetUserId ? [userId, targetUserId] : [targetUserId, userId];
const matchingPairKey = (userId: string, targetUserId: string) =>
  `matching:pair:${orderedMatchingPair(userId, targetUserId).join(":")}`;

@Injectable()
export class MatchingRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async profileIsComplete(userId: string): Promise<boolean> {
    const user = await this.db.query.users.findFirst({
      columns: { profileCompletedAt: true, hiddenAt: true, deletedAt: true },
      where: eq(users.userId, userId),
    });
    return Boolean(user?.profileCompletedAt && !user.hiddenAt && !user.deletedAt);
  }

  async candidates(userId: string) {
    const viewer = await this.db.query.users.findFirst({
      columns: { gender: true, interestedGender: true },
      where: eq(users.userId, userId),
    });
    if (!viewer) return [];

    const viewerGenderFilter =
      viewer.interestedGender === "everyone"
        ? undefined
        : viewer.interestedGender
          ? eq(users.gender, viewer.interestedGender)
          : sql<boolean>`false`;
    const targetInterestFilter = or(eq(users.interestedGender, "everyone"), eq(users.interestedGender, viewer.gender));

    const rows = await this.db
      .select({
        id: users.userId,
        userName: users.userName,
        gender: users.gender,
        birthDate: users.birthDate,
        region: users.region,
        intro: users.intro,
      })
      .from(users)
      .where(
        and(
          ne(users.userId, userId),
          isNotNull(users.profileCompletedAt),
          isNull(users.hiddenAt),
          isNull(users.deletedAt),
          targetInterestFilter,
          viewerGenderFilter,
          notExists(
            this.db
              .select()
              .from(userBlocks)
              .where(
                or(
                  and(eq(userBlocks.blockerUserId, userId), eq(userBlocks.blockedUserId, users.userId)),
                  and(eq(userBlocks.blockerUserId, users.userId), eq(userBlocks.blockedUserId, userId)),
                ),
              ),
          ),
          notExists(
            this.db
              .select()
              .from(matchActions)
              .where(
                and(
                  eq(matchActions.actorUserId, userId),
                  eq(matchActions.targetUserId, users.userId),
                  isNull(matchActions.revertedAt),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(users.createdAt))
      .limit(50);

    return this.withCandidateDetails(userId, rows);
  }

  async likedMeCandidates(userId: string, limit: number) {
    const rows = await this.db
      .select({
        id: users.userId,
        userName: users.userName,
        gender: users.gender,
        birthDate: users.birthDate,
        region: users.region,
        intro: users.intro,
      })
      .from(userLikes)
      .innerJoin(users, eq(users.userId, userLikes.likerUserId))
      .where(
        and(
          eq(userLikes.likedUserId, userId),
          ne(users.userId, userId),
          isNotNull(users.profileCompletedAt),
          isNull(users.hiddenAt),
          isNull(users.deletedAt),
          notExists(
            this.db
              .select()
              .from(userBlocks)
              .where(
                or(
                  and(eq(userBlocks.blockerUserId, userId), eq(userBlocks.blockedUserId, users.userId)),
                  and(eq(userBlocks.blockerUserId, users.userId), eq(userBlocks.blockedUserId, userId)),
                ),
              ),
          ),
        ),
      )
      .orderBy(desc(userLikes.createdAt))
      .limit(limit);

    return this.withCandidateDetails(userId, rows);
  }

  async consumeLikedMeAccess(input: { userId: string; periodStart: Date; limit: number }) {
    const access = await this.db
      .insert(userLikedMeAccesses)
      .values({ userId: input.userId, periodStart: input.periodStart, viewedCount: 1, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [userLikedMeAccesses.userId, userLikedMeAccesses.periodStart],
        set: { viewedCount: sql`${userLikedMeAccesses.viewedCount} + 1`, updatedAt: new Date() },
        setWhere: lt(userLikedMeAccesses.viewedCount, input.limit),
      })
      .returning({ viewedCount: userLikedMeAccesses.viewedCount });
    return access.length > 0;
  }

  async actOnCandidate(input: {
    userId: string;
    targetUserId: string;
    action: "skip" | "like" | "superlike";
    dailyLimit: number | null;
    now: Date;
    dayStart: Date;
    dayEnd: Date;
  }) {
    return this.db.transaction(async (tx) => {
      await lockMatchingKey(tx, `matching:user:${input.userId}`);
      await lockMatchingKey(tx, matchingPairKey(input.userId, input.targetUserId));
      const existingAction = await tx.query.matchActions.findFirst({
        columns: { action: true },
        where: and(
          eq(matchActions.actorUserId, input.userId),
          eq(matchActions.targetUserId, input.targetUserId),
          isNull(matchActions.revertedAt),
        ),
        orderBy: desc(matchActions.createdAt),
      });
      if (existingAction) {
        if (existingAction.action !== input.action) throw new Error("MATCH_ACTION_CONFLICT");
        if (input.action === "skip") {
          return {
            matched: false,
            roomId: undefined,
            remainingSuperLikeCredits: undefined,
            created: false,
          } as const;
        }
        const [userLowId, userHighId] = orderedMatchingPair(input.userId, input.targetUserId);
        const [existingMatch, balance] = await Promise.all([
          tx.query.matches.findFirst({
            columns: { roomId: true },
            where: and(eq(matches.userLowId, userLowId), eq(matches.userHighId, userHighId)),
          }),
          input.action === "superlike"
            ? tx.query.userConsumableBalances.findFirst({
                columns: { superLikeCredits: true },
                where: eq(userConsumableBalances.userId, input.userId),
              })
            : undefined,
        ]);
        return {
          matched: Boolean(existingMatch),
          roomId: existingMatch?.roomId,
          remainingSuperLikeCredits: balance?.superLikeCredits,
          created: false,
        } as const;
      }
      const actor = await tx.query.users.findFirst({
        columns: { gender: true, interestedGender: true, hiddenAt: true, deletedAt: true, profileCompletedAt: true },
        where: eq(users.userId, input.userId),
      });
      const target = await tx.query.users.findFirst({
        columns: {
          userId: true,
          gender: true,
          interestedGender: true,
          hiddenAt: true,
          deletedAt: true,
          profileCompletedAt: true,
        },
        where: eq(users.userId, input.targetUserId),
      });
      if (!actor || actor.hiddenAt || actor.deletedAt || !actor.profileCompletedAt) {
        throw new Error("PROFILE_COMPLETION_REQUIRED");
      }
      if (!target || target.hiddenAt || target.deletedAt || !target.profileCompletedAt)
        throw new Error("USER_NOT_FOUND");
      const viewerAcceptsTarget = actor.interestedGender === "everyone" || actor.interestedGender === target.gender;
      const targetAcceptsViewer = target.interestedGender === "everyone" || target.interestedGender === actor.gender;
      if (!viewerAcceptsTarget || !targetAcceptsViewer) throw new Error("CANDIDATE_NOT_AVAILABLE");
      const blocked = await tx.query.userBlocks.findFirst({
        columns: { blockerUserId: true },
        where: or(
          and(eq(userBlocks.blockerUserId, input.userId), eq(userBlocks.blockedUserId, input.targetUserId)),
          and(eq(userBlocks.blockerUserId, input.targetUserId), eq(userBlocks.blockedUserId, input.userId)),
        ),
      });
      if (blocked) throw new Error("CANDIDATE_NOT_AVAILABLE");

      if (input.action === "superlike") {
        const credits = await tx
          .update(userConsumableBalances)
          .set({ superLikeCredits: sql`${userConsumableBalances.superLikeCredits} - 1`, updatedAt: new Date() })
          .where(and(eq(userConsumableBalances.userId, input.userId), gt(userConsumableBalances.superLikeCredits, 0)))
          .returning({ superLikeCredits: userConsumableBalances.superLikeCredits });
        if (credits.length === 0) throw new Error("SUPERLIKE_CREDITS_REQUIRED");
      }

      if (input.action !== "skip") {
        const existingLike = await tx.query.userLikes.findFirst({
          where: and(eq(userLikes.likerUserId, input.userId), eq(userLikes.likedUserId, input.targetUserId)),
        });
        if (!existingLike) {
          const [countRow] = await tx
            .select({ count: count() })
            .from(userLikes)
            .where(
              and(
                eq(userLikes.likerUserId, input.userId),
                gte(userLikes.createdAt, input.dayStart),
                lt(userLikes.createdAt, input.dayEnd),
              ),
            );
          if (input.dailyLimit !== null && Number(countRow?.count ?? 0) >= input.dailyLimit) {
            throw new Error("LIKE_LIMIT_REACHED");
          }
          await tx
            .insert(userLikes)
            .values({ likerUserId: input.userId, likedUserId: input.targetUserId, createdAt: input.now });
        }
      }

      await tx.insert(matchActions).values({
        actorUserId: input.userId,
        targetUserId: input.targetUserId,
        action: input.action,
        createdAt: input.now,
      });

      if (input.action === "skip") {
        return { matched: false, roomId: undefined, remainingSuperLikeCredits: undefined, created: true } as const;
      }

      const matched = await this.matchIfReverseExists(tx, input.userId, input.targetUserId);
      const balance =
        input.action === "superlike"
          ? await tx.query.userConsumableBalances.findFirst({
              columns: { superLikeCredits: true },
              where: eq(userConsumableBalances.userId, input.userId),
            })
          : undefined;
      return { ...matched, remainingSuperLikeCredits: balance?.superLikeCredits, created: true } as const;
    });
  }

  async undoLastAction(userId: string) {
    return this.db.transaction(async (tx) => {
      await lockMatchingKey(tx, `matching:user:${userId}`);
      const action = await tx.query.matchActions.findFirst({
        where: and(eq(matchActions.actorUserId, userId), isNull(matchActions.revertedAt)),
        orderBy: desc(matchActions.createdAt),
      });
      if (!action) return undefined;

      await lockMatchingKey(tx, matchingPairKey(action.actorUserId, action.targetUserId));
      const [claimedAction] = await tx
        .update(matchActions)
        .set({ revertedAt: new Date() })
        .where(and(eq(matchActions.id, action.id), isNull(matchActions.revertedAt)))
        .returning();
      if (!claimedAction) return undefined;

      const [userLowId, userHighId] = orderedMatchingPair(action.actorUserId, action.targetUserId);
      const existingMatch = await tx.query.matches.findFirst({
        where: and(eq(matches.userLowId, userLowId), eq(matches.userHighId, userHighId)),
      });
      if (existingMatch) throw new Error("UNDO_NOT_AVAILABLE_AFTER_MATCH");

      if (action.action === "like" || action.action === "superlike") {
        await tx
          .delete(userLikes)
          .where(and(eq(userLikes.likerUserId, userId), eq(userLikes.likedUserId, action.targetUserId)));
        if (action.action === "superlike") {
          await tx
            .insert(userConsumableBalances)
            .values({ userId, superLikeCredits: 1, boostCredits: 0 })
            .onConflictDoUpdate({
              target: userConsumableBalances.userId,
              set: { superLikeCredits: sql`${userConsumableBalances.superLikeCredits} + 1`, updatedAt: new Date() },
            });
        }
      }
      return claimedAction;
    });
  }

  async activateBoost(userId: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const credits = await tx
        .update(userConsumableBalances)
        .set({ boostCredits: sql`${userConsumableBalances.boostCredits} - 1`, updatedAt: now })
        .where(and(eq(userConsumableBalances.userId, userId), gt(userConsumableBalances.boostCredits, 0)))
        .returning({ boostCredits: userConsumableBalances.boostCredits });
      const [balance] = credits;
      if (!balance) throw new Error("BOOST_CREDITS_REQUIRED");

      const activeBoost = await tx.query.userBoosts.findFirst({
        columns: { id: true },
        where: and(eq(userBoosts.userId, userId), gt(userBoosts.endsAt, now)),
      });
      if (activeBoost) throw new Error("BOOST_ALREADY_ACTIVE");

      const endsAt = new Date(now.getTime() + 30 * 60 * 1000);
      await tx.insert(userBoosts).values({ userId, source: "consumable", startsAt: now, endsAt });
      return { endsAt, remainingBoostCredits: balance.boostCredits };
    });
  }

  private async matchIfReverseExists(tx: MatchingTransaction, userId: string, targetUserId: string) {
    const reverse = await tx.query.userLikes.findFirst({
      where: and(eq(userLikes.likerUserId, targetUserId), eq(userLikes.likedUserId, userId)),
    });
    if (!reverse) return { matched: false, roomId: undefined };

    const [userLowId, userHighId] = orderedMatchingPair(userId, targetUserId);
    const existing = await tx.query.matches.findFirst({
      where: and(eq(matches.userLowId, userLowId), eq(matches.userHighId, userHighId)),
    });
    if (existing) return { matched: true, roomId: existing.roomId };

    const [room] = await tx.insert(rooms).values({ name: "매칭 대화" }).returning();
    if (!room) throw new Error("ROOM_CREATE_FAILED");
    await tx
      .insert(roomMembers)
      .values([
        { roomId: room.id, userId },
        { roomId: room.id, userId: targetUserId },
      ])
      .onConflictDoNothing();
    await tx.insert(matches).values({ userLowId, userHighId, roomId: room.id });
    return { matched: true, roomId: room.id };
  }

  private async withCandidateDetails(userId: string, rows: CandidateBase[]) {
    if (rows.length === 0) return [];
    const now = new Date();
    const candidateIds = rows.map((row) => row.id);
    const [subscriptions, likes, photos, boosts] = await Promise.all([
      this.db
        .select({ userId: userSubscriptions.userId, planId: userSubscriptions.planId })
        .from(userSubscriptions)
        .where(
          and(
            inArray(userSubscriptions.userId, candidateIds),
            eq(userSubscriptions.status, "active"),
            or(isNull(userSubscriptions.currentPeriodEndsAt), gt(userSubscriptions.currentPeriodEndsAt, now)),
          ),
        )
        .orderBy(desc(userSubscriptions.updatedAt)),
      this.db
        .select({ likedUserId: userLikes.likedUserId })
        .from(userLikes)
        .where(and(eq(userLikes.likerUserId, userId), inArray(userLikes.likedUserId, candidateIds))),
      this.db
        .select({ userId: userProfilePhotos.userId, url: userProfilePhotos.url, position: userProfilePhotos.position })
        .from(userProfilePhotos)
        .where(inArray(userProfilePhotos.userId, candidateIds))
        .orderBy(userProfilePhotos.userId, userProfilePhotos.position),
      this.db
        .select({ userId: userBoosts.userId })
        .from(userBoosts)
        .where(and(inArray(userBoosts.userId, candidateIds), gt(userBoosts.endsAt, now))),
    ]);
    const plansByUser = new Map<string, string>();
    for (const subscription of subscriptions) {
      if (!plansByUser.has(subscription.userId)) plansByUser.set(subscription.userId, subscription.planId);
    }
    const likedUserIds = new Set(likes.map((like) => like.likedUserId));
    const boostedUserIds = new Set(boosts.map((boost) => boost.userId));
    const photosByUser = new Map<string, { url: string; position: number }[]>();
    for (const photo of photos) {
      const userPhotos = photosByUser.get(photo.userId) ?? [];
      userPhotos.push({ url: photo.url, position: photo.position });
      photosByUser.set(photo.userId, userPhotos);
    }

    return rows.map((row) => ({
      ...row,
      photos: photosByUser.get(row.id) ?? [],
      likedByMe: likedUserIds.has(row.id),
      planId: plansByUser.get(row.id) ?? "free",
      boostActive: boostedUserIds.has(row.id),
    }));
  }
}
