import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, desc, eq, gt, gte, isNotNull, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  matchActions,
  matches,
  roomMembers,
  rooms,
  scores,
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

    return Promise.all(rows.map((row) => this.withCandidateDetails(userId, row)));
  }

  async likedMeCandidates(userId: string) {
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
        ),
      )
      .orderBy(desc(userLikes.createdAt));

    return Promise.all(rows.map((row) => this.withCandidateDetails(userId, row)));
  }

  async createLikedMeAccess(input: { userId: string; periodStart: Date; viewedCount: number }) {
    await this.db
      .insert(userLikedMeAccesses)
      .values({ ...input, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [userLikedMeAccesses.userId, userLikedMeAccesses.periodStart],
        set: { viewedCount: input.viewedCount, updatedAt: new Date() },
      });
  }

  async findLikedMeAccess(userId: string, periodStart: Date) {
    return this.db.query.userLikedMeAccesses.findFirst({
      where: and(eq(userLikedMeAccesses.userId, userId), eq(userLikedMeAccesses.periodStart, periodStart)),
    });
  }

  async actOnCandidate(input: {
    userId: string;
    targetUserId: string;
    action: "skip" | "like" | "superlike";
    dailyLimit: number | null;
    dayStart: Date;
    dayEnd: Date;
  }) {
    return this.db.transaction(async (tx) => {
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
          await tx.insert(userLikes).values({ likerUserId: input.userId, likedUserId: input.targetUserId });
        }
      }

      await tx.insert(matchActions).values({
        actorUserId: input.userId,
        targetUserId: input.targetUserId,
        action: input.action,
      });

      if (input.action === "skip") return { matched: false, roomId: undefined, remainingSuperLikeCredits: undefined };

      const matched = await this.matchIfReverseExists(tx, input.userId, input.targetUserId);
      const balance =
        input.action === "superlike"
          ? await tx.query.userConsumableBalances.findFirst({
              columns: { superLikeCredits: true },
              where: eq(userConsumableBalances.userId, input.userId),
            })
          : undefined;
      return { ...matched, remainingSuperLikeCredits: balance?.superLikeCredits };
    });
  }

  async undoLastAction(userId: string) {
    return this.db.transaction(async (tx) => {
      const action = await tx.query.matchActions.findFirst({
        where: and(eq(matchActions.actorUserId, userId), isNull(matchActions.revertedAt)),
        orderBy: desc(matchActions.createdAt),
      });
      if (!action) return undefined;

      const [userLowId, userHighId] = [action.actorUserId, action.targetUserId].sort();
      const existingMatch = await tx.query.matches.findFirst({
        where: and(eq(matches.userLowId, userLowId), eq(matches.userHighId, userHighId)),
      });
      if (existingMatch) throw new Error("UNDO_NOT_AVAILABLE_AFTER_MATCH");

      await tx.update(matchActions).set({ revertedAt: new Date() }).where(eq(matchActions.id, action.id));
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
      return action;
    });
  }

  async activateBoost(userId: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const credits = await tx
        .update(userConsumableBalances)
        .set({ boostCredits: sql`${userConsumableBalances.boostCredits} - 1`, updatedAt: now })
        .where(and(eq(userConsumableBalances.userId, userId), gt(userConsumableBalances.boostCredits, 0)))
        .returning({ boostCredits: userConsumableBalances.boostCredits });
      if (credits.length === 0) throw new Error("BOOST_CREDITS_REQUIRED");

      const endsAt = new Date(now.getTime() + 30 * 60 * 1000);
      await tx.insert(userBoosts).values({ userId, source: "consumable", startsAt: now, endsAt });
      return { endsAt, remainingBoostCredits: credits[0]!.boostCredits };
    });
  }

  async upsertScore(input: { scorerUserId: string; scoredUserId: string; score: number }) {
    await this.db
      .insert(scores)
      .values(input)
      .onConflictDoUpdate({
        target: [scores.scorerUserId, scores.scoredUserId],
        set: { score: input.score, updatedAt: new Date() },
      });
  }

  async scoreSummary(userId: string) {
    const [row] = await this.db
      .select({ averageScore: avg(scores.score), scoreCount: count() })
      .from(scores)
      .where(eq(scores.scoredUserId, userId));
    return row;
  }

  private async matchIfReverseExists(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    userId: string,
    targetUserId: string,
  ) {
    const reverse = await tx.query.userLikes.findFirst({
      where: and(eq(userLikes.likerUserId, targetUserId), eq(userLikes.likedUserId, userId)),
    });
    if (!reverse) return { matched: false, roomId: undefined };

    const [userLowId, userHighId] = [userId, targetUserId].sort();
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

  private async withCandidateDetails(userId: string, row: CandidateBase) {
    const now = new Date();
    const [subscription, like, photos, boost] = await Promise.all([
      this.db.query.userSubscriptions.findFirst({
        columns: { planId: true },
        where: and(
          eq(userSubscriptions.userId, row.id),
          eq(userSubscriptions.status, "active"),
          or(isNull(userSubscriptions.currentPeriodEndsAt), gt(userSubscriptions.currentPeriodEndsAt, now)),
        ),
        orderBy: desc(userSubscriptions.createdAt),
      }),
      this.db.query.userLikes.findFirst({
        columns: { likerUserId: true },
        where: and(eq(userLikes.likerUserId, userId), eq(userLikes.likedUserId, row.id)),
      }),
      this.db.query.userProfilePhotos.findMany({
        columns: { url: true, position: true },
        where: eq(userProfilePhotos.userId, row.id),
        orderBy: userProfilePhotos.position,
      }),
      this.db.query.userBoosts.findFirst({
        columns: { id: true },
        where: and(eq(userBoosts.userId, row.id), gt(userBoosts.endsAt, now)),
      }),
    ]);
    return {
      ...row,
      photos,
      likedByMe: Boolean(like),
      planId: subscription?.planId ?? "free",
      boostActive: Boolean(boost),
    };
  }
}
