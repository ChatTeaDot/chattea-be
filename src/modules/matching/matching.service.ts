import { dbQuery, sql, type Database } from "../../db/client.js";

export type MatchCandidate = {
  id: string;
  nickname: string;
  intro: string;
  likedByMe: boolean;
  planId: string;
  blackRecommended: boolean;
};

export type LikeUserResult = {
  matched: boolean;
  roomId: string | null;
};

export const DAILY_LIKE_LIMITS_BY_PLAN: Record<string, number | null> = {
  free: 10,
  basic: 20,
  gold: 40,
  black: null,
};

const LIKED_ME_LIMITS_BY_PLAN: Record<string, number | null> = {
  free: null,
  basic: 3,
  gold: 10,
  black: null,
};

const LIKED_ME_WINDOW_HOURS = 3;

export class MatchingService {
  constructor(private readonly db: Database) {}

  async listCandidates(userId: string): Promise<MatchCandidate[]> {
    validateUuid(userId);
    const result = await dbQuery<{
      id: string;
      nickname: string;
      intro: string;
      liked_by_me: boolean;
      plan_id: string;
    }>(
      this.db,
      sql`
        SELECT users.id::text,
               users.nickname,
               users.intro,
               COALESCE(active_subscription.plan_id, 'free') AS plan_id,
               EXISTS (
                 SELECT 1
                 FROM user_likes
                 WHERE user_likes.liker_user_id = ${userId}
                   AND user_likes.liked_user_id = users.id
               ) AS liked_by_me
        FROM users
        LEFT JOIN LATERAL (
          SELECT plan_id
          FROM user_subscriptions
          WHERE user_subscriptions.user_id = users.id
            AND user_subscriptions.status = 'active'
            AND (user_subscriptions.current_period_ends_at IS NULL OR user_subscriptions.current_period_ends_at > now())
          ORDER BY user_subscriptions.created_at DESC
          LIMIT 1
        ) active_subscription ON true
        WHERE users.id <> ${userId}
          AND NOT EXISTS (
            SELECT 1
            FROM user_blocks
            WHERE user_blocks.blocker_user_id = ${userId}
              AND user_blocks.blocked_user_id = users.id
          )
        ORDER BY users.created_at DESC
        LIMIT 50
      `,
    );

    return result.rows.map((row) => ({
      id: row.id,
      nickname: row.nickname,
      intro: row.intro,
      likedByMe: row.liked_by_me,
      planId: row.plan_id,
      blackRecommended: row.plan_id === "black",
    }));
  }

  async listBlackCandidates(userId: string, viewerPlanId: string): Promise<MatchCandidate[]> {
    if (viewerPlanId !== "black") {
      return [];
    }

    const candidates = await this.listCandidates(userId);
    return candidates.filter((candidate) => candidate.blackRecommended);
  }

  async listLikedMeCandidates(userId: string, viewerPlanId: string, now = new Date()): Promise<MatchCandidate[]> {
    validateUuid(userId);
    if (viewerPlanId === "free") {
      throw new Error("LIKED_ME_NOT_AVAILABLE");
    }

    await this.enforceLikedMeWindow(userId, viewerPlanId, now);
    const limit = getLikedMeLimit(viewerPlanId);

    const result = await dbQuery<{
      id: string;
      nickname: string;
      intro: string;
      liked_by_me: boolean;
      plan_id: string;
    }>(
      this.db,
      sql`
        SELECT users.id::text,
               users.nickname,
               users.intro,
               COALESCE(active_subscription.plan_id, 'free') AS plan_id,
               EXISTS (
                 SELECT 1
                 FROM user_likes
                 WHERE user_likes.liker_user_id = ${userId}
                   AND user_likes.liked_user_id = users.id
               ) AS liked_by_me,
               liked.created_at
        FROM user_likes liked
        JOIN users ON users.id = liked.liker_user_id
        LEFT JOIN LATERAL (
          SELECT plan_id
          FROM user_subscriptions
          WHERE user_subscriptions.user_id = users.id
            AND user_subscriptions.status = 'active'
            AND (user_subscriptions.current_period_ends_at IS NULL OR user_subscriptions.current_period_ends_at > now())
          ORDER BY user_subscriptions.created_at DESC
          LIMIT 1
        ) active_subscription ON true
        WHERE liked.liked_user_id = ${userId}
          AND users.id <> ${userId}
          AND NOT EXISTS (
            SELECT 1
            FROM user_blocks
            WHERE user_blocks.blocker_user_id = ${userId}
              AND user_blocks.blocked_user_id = users.id
          )
        ORDER BY liked.created_at DESC
      `,
    );

    const rows = limit === null ? result.rows : result.rows.slice(0, limit);
    return rows.map((row) => ({
      id: row.id,
      nickname: row.nickname,
      intro: row.intro,
      likedByMe: row.liked_by_me,
      planId: row.plan_id,
      blackRecommended: row.plan_id === "black",
    }));
  }

  async likeUser(
    userId: string,
    likedUserId: string,
    planId = "free",
    now = new Date(),
  ): Promise<LikeUserResult> {
    validateUuid(userId);
    validateUuid(likedUserId);
    if (userId === likedUserId) {
      throw new Error("LIKE_SELF_NOT_ALLOWED");
    }

    return this.db.transaction(async (tx) => {
      const target = await tx.execute(sql`SELECT 1 FROM users WHERE id = ${likedUserId}`);
      if (!target.rows[0]) {
        throw new Error("USER_NOT_FOUND");
      }

      const existingLike = await tx.execute(
        sql`SELECT 1 FROM user_likes WHERE liker_user_id = ${userId} AND liked_user_id = ${likedUserId}`,
      );
      if (!existingLike.rows[0]) {
        const limit = getDailyLikeLimit(planId);
        if (limit !== null) {
          const { rows } = await tx.execute<{ count: string }>(
            sql`
              SELECT COUNT(*)::text AS count
              FROM user_likes
              WHERE liker_user_id = ${userId}
                AND created_at >= ${startOfUtcDay(now)}::timestamptz
                AND created_at < ${nextUtcDay(now)}::timestamptz
            `,
          );
          if (Number(rows[0]?.count ?? 0) >= limit) {
            throw new Error("LIKE_LIMIT_REACHED");
          }
        }
      }

      await tx.execute(
        sql`
          INSERT INTO user_likes (liker_user_id, liked_user_id)
          VALUES (${userId}, ${likedUserId})
          ON CONFLICT (liker_user_id, liked_user_id) DO NOTHING
        `,
      );

      const reverse = await tx.execute(
        sql`SELECT 1 FROM user_likes WHERE liker_user_id = ${likedUserId} AND liked_user_id = ${userId}`,
      );
      if (!reverse.rows[0]) {
        return { matched: false, roomId: null };
      }

      const [userLowId, userHighId] = [userId, likedUserId].sort();
      const existing = await tx.execute<{ room_id: string }>(
        sql`SELECT room_id::text FROM matches WHERE user_low_id = ${userLowId} AND user_high_id = ${userHighId}`,
      );
      if (existing.rows[0]) {
        return { matched: true, roomId: existing.rows[0].room_id };
      }

      const room = await tx.execute<{ id: string }>(
        sql`INSERT INTO rooms (name) VALUES ('매칭 대화') RETURNING id::text`,
      );
      const roomId = room.rows[0]!.id;
      await tx.execute(
        sql`
          INSERT INTO room_members (room_id, user_id)
          VALUES (${roomId}, ${userId}), (${roomId}, ${likedUserId})
          ON CONFLICT (room_id, user_id) DO NOTHING
        `,
      );
      await tx.execute(
        sql`INSERT INTO matches (user_low_id, user_high_id, room_id) VALUES (${userLowId}, ${userHighId}, ${roomId})`,
      );

      return { matched: true, roomId };
    });
  }

  private async enforceLikedMeWindow(userId: string, viewerPlanId: string, now: Date): Promise<void> {
    const limit = getLikedMeLimit(viewerPlanId);
    if (limit === null) {
      return;
    }

    const periodStart = startOfLikedMeWindow(now);
    await this.db.transaction(async (tx) => {
      const current = await tx.execute<{ viewed_count: string }>(
        sql`
          SELECT viewed_count
          FROM user_liked_me_accesses
          WHERE user_id = ${userId}
            AND period_start = ${periodStart}
          FOR UPDATE
        `,
      );

      if (current.rows[0]) {
        const next = Number(current.rows[0].viewed_count) + 1;
        if (next > limit) {
          throw new Error("LIKED_ME_LIMIT_REACHED");
        }

        await tx.execute(
          sql`UPDATE user_liked_me_accesses SET viewed_count = ${next}, updated_at = now() WHERE user_id = ${userId} AND period_start = ${periodStart}`,
        );
      } else {
        await tx.execute(
          sql`
            INSERT INTO user_liked_me_accesses (user_id, period_start, viewed_count, updated_at)
            VALUES (${userId}, ${periodStart}, 1, now())
          `,
        );
      }
    });
  }
}

function likeKey(userId: string, likedUserId: string): string {
  return `${userId}:${likedUserId}`;
}

function validateUuid(input: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("USER_ID_INVALID");
  }
}

function getDailyLikeLimit(planId: string): number | null {
  return DAILY_LIKE_LIMITS_BY_PLAN[planId] ?? DAILY_LIKE_LIMITS_BY_PLAN.free;
}

function getLikedMeLimit(planId: string): number | null {
  return LIKED_ME_LIMITS_BY_PLAN[planId] ?? LIKED_ME_LIMITS_BY_PLAN.basic;
}

function toLikedMeWindow(now: Date): string {
  return startOfLikedMeWindow(now).toISOString();
}

function toUtcDay(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(
    now.getUTCDate(),
  ).padStart(2, "0")}`;
}

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 24));
}

function startOfLikedMeWindow(now: Date): Date {
  const hour = now.getUTCHours();
  const windowStartHour = Math.floor(hour / LIKED_ME_WINDOW_HOURS) * LIKED_ME_WINDOW_HOURS;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), windowStartHour));
}
