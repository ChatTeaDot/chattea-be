import type { Pool } from "pg";

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
  private readonly dailyLikes = new Map<string, { day: string; count: number }>();
  private readonly likedMeViews = new Map<string, Map<string, number>>();
  private readonly candidates = new Map<string, Omit<MatchCandidate, "likedByMe">>([
    [
      "demo-match-user",
      {
        id: "demo-match-user",
        nickname: "차한잔",
        intro: "천천히 대화해요",
        planId: "black",
        blackRecommended: true,
      },
    ],
  ]);
  private readonly likes = new Set<string>();

  listCandidates(userId: string): MatchCandidate[] {
    return [...this.candidates.values()]
      .filter((user) => user.id !== userId)
      .map((user) => ({
        ...user,
        likedByMe: this.likes.has(likeKey(userId, user.id)),
      }));
  }

  listBlackCandidates(userId: string, viewerPlanId: string): MatchCandidate[] {
    if (viewerPlanId !== "black") {
      return [];
    }

    return this.listCandidates(userId).filter((candidate) => candidate.blackRecommended);
  }

  listLikedMeCandidates(userId: string, viewerPlanId: string, now = new Date()): MatchCandidate[] {
    if (viewerPlanId === "free") {
      throw new Error("LIKED_ME_NOT_AVAILABLE");
    }

    const limit = getLikedMeLimit(viewerPlanId);
    if (limit !== null) {
      const viewWindow = toLikedMeWindow(now);
      const windows = this.likedMeViews.get(userId) ?? new Map<string, number>();
      const viewed = windows.get(viewWindow) ?? 0;
      if (viewed >= limit) {
        throw new Error("LIKED_ME_LIMIT_REACHED");
      }

      windows.set(viewWindow, viewed + 1);
      this.likedMeViews.set(userId, windows);
    }

    const candidates = [...this.likes]
      .map((entry) => {
        const [likerUserId, likedUserId] = entry.split(":");
        if (likedUserId !== userId) {
          return null;
        }

        const candidate = this.candidates.get(likerUserId);
        if (!candidate) {
          return null;
        }

        return {
          ...candidate,
          likedByMe: this.likes.has(likeKey(userId, candidate.id)),
        };
      })
      .filter((candidate): candidate is MatchCandidate => candidate !== null);

    return candidates.slice(0, limit ?? 50);
  }

  likeUser(userId: string, likedUserId: string, planId = "free", now = new Date()): LikeUserResult {
    if (userId === likedUserId) {
      throw new Error("LIKE_SELF_NOT_ALLOWED");
    }

    if (!this.candidates.has(likedUserId)) {
      throw new Error("USER_NOT_FOUND");
    }

    const likeKeyForUser = `${userId}:${likedUserId}`;
    if (!this.likes.has(likeKeyForUser)) {
      const limit = getDailyLikeLimit(planId);
      if (limit !== null) {
        const day = toUtcDay(now);
        const daily = this.dailyLikes.get(userId);
        if (daily?.day === day && daily.count >= limit) {
          throw new Error("LIKE_LIMIT_REACHED");
        }
      }

      const day = toUtcDay(now);
      const current = this.dailyLikes.get(userId);
      if (current?.day === day) {
        this.dailyLikes.set(userId, { day, count: current.count + 1 });
      } else {
        this.dailyLikes.set(userId, { day, count: 1 });
      }
    }

    this.likes.add(likeKey(userId, likedUserId));
    const matched = this.likes.has(likeKey(likedUserId, userId));

    return {
      matched,
      roomId: matched ? `match-${[userId, likedUserId].sort().join("-")}` : null,
    };
  }
}

export class PostgresMatchingService {
  constructor(private readonly pool: Pool) {}

  async listCandidates(userId: string): Promise<MatchCandidate[]> {
    validateUuid(userId);
    const result = await this.pool.query<{
      id: string;
      nickname: string;
      intro: string;
      liked_by_me: boolean;
      plan_id: string;
    }>(
      `
        SELECT users.id::text,
               users.nickname,
               users.intro,
               COALESCE(active_subscription.plan_id, 'free') AS plan_id,
               EXISTS (
                 SELECT 1
                 FROM user_likes
                 WHERE user_likes.liker_user_id = $1
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
        WHERE users.id <> $1
          AND NOT EXISTS (
            SELECT 1
            FROM user_blocks
            WHERE user_blocks.blocker_user_id = $1
              AND user_blocks.blocked_user_id = users.id
          )
        ORDER BY users.created_at DESC
        LIMIT 50
      `,
      [userId],
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

    const result = await this.pool.query<{
      id: string;
      nickname: string;
      intro: string;
      liked_by_me: boolean;
      plan_id: string;
    }>(
      `
        SELECT users.id::text,
               users.nickname,
               users.intro,
               COALESCE(active_subscription.plan_id, 'free') AS plan_id,
               EXISTS (
                 SELECT 1
                 FROM user_likes
                 WHERE user_likes.liker_user_id = $1
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
        WHERE liked.liked_user_id = $1
          AND users.id <> $1
          AND NOT EXISTS (
            SELECT 1
            FROM user_blocks
            WHERE user_blocks.blocker_user_id = $1
              AND user_blocks.blocked_user_id = users.id
          )
        ORDER BY liked.created_at DESC
      `,
      [userId],
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

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const target = await client.query("SELECT 1 FROM users WHERE id = $1", [likedUserId]);
      if (!target.rows[0]) {
        throw new Error("USER_NOT_FOUND");
      }

      const existingLike = await client.query(
        "SELECT 1 FROM user_likes WHERE liker_user_id = $1 AND liked_user_id = $2",
        [userId, likedUserId],
      );
      if (!existingLike.rows[0]) {
        const limit = getDailyLikeLimit(planId);
        if (limit !== null) {
          const { rows } = await client.query<{ count: string }>(
            `
              SELECT COUNT(*)::text AS count
              FROM user_likes
              WHERE liker_user_id = $1
                AND created_at >= $2::timestamptz
                AND created_at < $3::timestamptz
            `,
            [userId, startOfUtcDay(now), nextUtcDay(now)],
          );
          if (Number(rows[0]?.count ?? 0) >= limit) {
            throw new Error("LIKE_LIMIT_REACHED");
          }
        }
      }

      await client.query(
        `
          INSERT INTO user_likes (liker_user_id, liked_user_id)
          VALUES ($1, $2)
          ON CONFLICT (liker_user_id, liked_user_id) DO NOTHING
        `,
        [userId, likedUserId],
      );

      const reverse = await client.query(
        "SELECT 1 FROM user_likes WHERE liker_user_id = $1 AND liked_user_id = $2",
        [likedUserId, userId],
      );
      if (!reverse.rows[0]) {
        await client.query("COMMIT");
        return { matched: false, roomId: null };
      }

      const [userLowId, userHighId] = [userId, likedUserId].sort();
      const existing = await client.query<{ room_id: string }>(
        "SELECT room_id::text FROM matches WHERE user_low_id = $1 AND user_high_id = $2",
        [userLowId, userHighId],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { matched: true, roomId: existing.rows[0].room_id };
      }

      const room = await client.query<{ id: string }>(
        "INSERT INTO rooms (name) VALUES ('매칭 대화') RETURNING id::text",
      );
      const roomId = room.rows[0]!.id;
      await client.query(
        `
          INSERT INTO room_members (room_id, user_id)
          VALUES ($1, $2), ($1, $3)
          ON CONFLICT (room_id, user_id) DO NOTHING
        `,
        [roomId, userId, likedUserId],
      );
      await client.query(
        "INSERT INTO matches (user_low_id, user_high_id, room_id) VALUES ($1, $2, $3)",
        [userLowId, userHighId, roomId],
      );
      await client.query("COMMIT");

      return { matched: true, roomId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async enforceLikedMeWindow(userId: string, viewerPlanId: string, now: Date): Promise<void> {
    const limit = getLikedMeLimit(viewerPlanId);
    if (limit === null) {
      return;
    }

    const periodStart = startOfLikedMeWindow(now);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const current = await client.query<{ viewed_count: string }>(
        `
          SELECT viewed_count
          FROM user_liked_me_accesses
          WHERE user_id = $1
            AND period_start = $2
          FOR UPDATE
        `,
        [userId, periodStart],
      );

      if (current.rows[0]) {
        const next = Number(current.rows[0].viewed_count) + 1;
        if (next > limit) {
          throw new Error("LIKED_ME_LIMIT_REACHED");
        }

        await client.query(
          "UPDATE user_liked_me_accesses SET viewed_count = $3, updated_at = now() WHERE user_id = $1 AND period_start = $2",
          [userId, periodStart, next],
        );
      } else {
        await client.query(
          `
            INSERT INTO user_liked_me_accesses (user_id, period_start, viewed_count, updated_at)
            VALUES ($1, $2, 1, now())
          `,
          [userId, periodStart],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
