import { Inject, Injectable } from "@nestjs/common";
import { and, avg, count, desc, eq, gt, gte, isNull, lt, ne, notExists, or } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  matches,
  roomMembers,
  rooms,
  scores,
  userBlocks,
  userLikedMeAccesses,
  userLikes,
  userSubscriptions,
  users,
} from "src/modules/database/schema";

@Injectable()
export class MatchingRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * 사용자가 볼 수 있는 매칭 후보 목록을 조회한다.
   *
   * @param userId 조회 사용자 ID
   * @returns 매칭 후보 목록
   */
  async candidates(userId: string) {
    const rows = await this.db
      .select({
        id: users.userId,
        userName: users.userName,
        gender: users.gender,
        intro: users.intro,
      })
      .from(users)
      .where(
        and(
          ne(users.userId, userId),
          notExists(
            this.db
              .select()
              .from(userBlocks)
              .where(and(eq(userBlocks.blockerUserId, userId), eq(userBlocks.blockedUserId, users.userId))),
          ),
        ),
      )
      .orderBy(desc(users.createdAt))
      .limit(50);

    return Promise.all(rows.map((row) => this.withPlanId(userId, row)));
  }

  /**
   * 나를 좋아한 사용자 목록을 조회한다.
   *
   * @param userId 조회 사용자 ID
   * @returns 나를 좋아한 후보 목록
   */
  async likedMeCandidates(userId: string) {
    const rows = await this.db
      .select({
        id: users.userId,
        userName: users.userName,
        gender: users.gender,
        intro: users.intro,
      })
      .from(userLikes)
      .innerJoin(users, eq(users.userId, userLikes.likerUserId))
      .where(and(eq(userLikes.likedUserId, userId), ne(users.userId, userId)))
      .orderBy(desc(userLikes.createdAt));

    return Promise.all(rows.map((row) => this.withPlanId(userId, row)));
  }

  /**
   * 나를 좋아한 사람 보기 접근 횟수를 저장하거나 갱신한다.
   *
   * @param input 사용자 ID, 기간 시작 시각, 조회 횟수
   * @returns 저장 완료 Promise
   */
  async createLikedMeAccess(input: { userId: string; periodStart: Date; viewedCount: number }) {
    await this.db
      .insert(userLikedMeAccesses)
      .values({ ...input, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [userLikedMeAccesses.userId, userLikedMeAccesses.periodStart],
        set: { viewedCount: input.viewedCount, updatedAt: new Date() },
      });
  }

  /**
   * 특정 기간의 나를 좋아한 사람 보기 접근 기록을 조회한다.
   *
   * @param userId 사용자 ID
   * @param periodStart 기간 시작 시각
   * @returns 접근 기록 또는 undefined
   */
  async findLikedMeAccess(userId: string, periodStart: Date) {
    return this.db.query.userLikedMeAccesses.findFirst({
      where: and(eq(userLikedMeAccesses.userId, userId), eq(userLikedMeAccesses.periodStart, periodStart)),
    });
  }

  /**
   * 좋아요를 저장하고 상호 좋아요인 경우 매칭방을 생성한다.
   *
   * @param input 좋아요 요청 정보와 일일 제한 정보
   * @returns 매칭 여부와 매칭방 ID
   */
  likeUser(input: { userId: string; likedUserId: string; dailyLimit: number | null; dayStart: Date; dayEnd: Date }) {
    return this.db.transaction(async (tx) => {
      const target = await tx.query.users.findFirst({ where: eq(users.userId, input.likedUserId) });
      if (!target) throw new Error("USER_NOT_FOUND");

      const existingLike = await tx.query.userLikes.findFirst({
        where: and(eq(userLikes.likerUserId, input.userId), eq(userLikes.likedUserId, input.likedUserId)),
      });
      if (!existingLike) {
        const likeCount = await tx
          .select({ count: count() })
          .from(userLikes)
          .where(
            and(
              eq(userLikes.likerUserId, input.userId),
              gte(userLikes.createdAt, input.dayStart),
              lt(userLikes.createdAt, input.dayEnd),
            ),
          );
        const dailyLikeCount = likeCount[0]?.count ?? 0;
        if (input.dailyLimit !== null && dailyLikeCount >= input.dailyLimit) throw new Error("LIKE_LIMIT_REACHED");
        await tx
          .insert(userLikes)
          .values({ likerUserId: input.userId, likedUserId: input.likedUserId })
          .onConflictDoNothing();
        return { matched: await this.matchIfReverseExists(tx, input) };
      }

      return { matched: await this.matchIfReverseExists(tx, input) };
    });
  }

  /**
   * 점수를 생성하거나 갱신한다.
   *
   * @param input 채점자 ID, 채점 대상 ID, 점수
   * @returns 저장 완료 Promise
   */
  async upsertScore(input: { scorerUserId: string; scoredUserId: string; score: number }) {
    await this.db
      .insert(scores)
      .values(input)
      .onConflictDoUpdate({
        target: [scores.scorerUserId, scores.scoredUserId],
        set: { score: input.score, updatedAt: new Date() },
      });
  }

  /**
   * 점수 요약을 조회한다.
   *
   * @param userId 채점 대상 사용자 ID
   * @returns 평균 점수와 채점 수
   */
  async scoreSummary(userId: string) {
    const [row] = await this.db
      .select({
        averageScore: avg(scores.score),
        scoreCount: count(),
      })
      .from(scores)
      .where(eq(scores.scoredUserId, userId));

    return row;
  }

  private async matchIfReverseExists(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    input: { userId: string; likedUserId: string },
  ) {
    const reverse = await tx.query.userLikes.findFirst({
      where: and(eq(userLikes.likerUserId, input.likedUserId), eq(userLikes.likedUserId, input.userId)),
    });
    if (!reverse) return { matched: false, roomId: undefined };

    const [userLowId, userHighId] = [input.userId, input.likedUserId].sort();
    const existing = await tx.query.matches.findFirst({
      where: and(eq(matches.userLowId, userLowId), eq(matches.userHighId, userHighId)),
    });
    if (existing) return { matched: true, roomId: existing.roomId };

    const [room] = await tx.insert(rooms).values({ name: "매칭 대화" }).returning();
    await tx
      .insert(roomMembers)
      .values([
        { roomId: room.id, userId: input.userId },
        { roomId: room.id, userId: input.likedUserId },
      ])
      .onConflictDoNothing();
    await tx.insert(matches).values({ userLowId, userHighId, roomId: room.id });
    return { matched: true, roomId: room.id };
  }

  private async withPlanId(userId: string, row: Omit<CandidateRow, "planId" | "likedByMe">): Promise<CandidateRow> {
    const [subscription, like] = await Promise.all([
      this.db.query.userSubscriptions.findFirst({
        columns: { planId: true },
        where: and(
          eq(userSubscriptions.userId, row.id),
          eq(userSubscriptions.status, "active"),
          or(isNull(userSubscriptions.currentPeriodEndsAt), gt(userSubscriptions.currentPeriodEndsAt, new Date())),
        ),
        orderBy: desc(userSubscriptions.createdAt),
      }),
      this.db.query.userLikes.findFirst({
        columns: { likerUserId: true },
        where: and(eq(userLikes.likerUserId, userId), eq(userLikes.likedUserId, row.id)),
      }),
    ]);

    return { ...row, likedByMe: Boolean(like), planId: subscription?.planId ?? "free" };
  }
}

type CandidateRow = {
  id: string;
  userName: string;
  intro: string;
  likedByMe: boolean;
  planId: string;
};
