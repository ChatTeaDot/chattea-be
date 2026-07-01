import { dbQuery, sql, type Database } from "../../db/client.js";

export type ProfileRatingSummary = {
  userId: string;
  averageScore: number;
  ratingCount: number;
};

export class ProfileRatingService {
  constructor(private readonly db: Database) {}

  async rateProfile(raterUserId: string, ratedUserId: string, score: number): Promise<ProfileRatingSummary> {
    validateUuid(raterUserId);
    validateUuid(ratedUserId);
    validateRating(raterUserId, ratedUserId, score);
    await dbQuery(
      this.db,
      sql`
        INSERT INTO profile_ratings (rater_user_id, rated_user_id, score)
        VALUES (${raterUserId}, ${ratedUserId}, ${score})
        ON CONFLICT (rater_user_id, rated_user_id)
        DO UPDATE SET score = EXCLUDED.score, updated_at = now()
      `,
    );

    return this.getSummary(ratedUserId);
  }

  async getSummary(userId: string): Promise<ProfileRatingSummary> {
    validateUuid(userId);
    const result = await dbQuery<{ average_score: string | null; rating_count: string }>(
      this.db,
      sql`
        SELECT AVG(score)::text AS average_score,
               COUNT(*)::text AS rating_count
        FROM profile_ratings
        WHERE rated_user_id = ${userId}
      `,
    );

    return {
      userId,
      averageScore: Number(result.rows[0]?.average_score ?? 0),
      ratingCount: Number(result.rows[0]?.rating_count ?? 0),
    };
  }
}

function validateRating(raterUserId: string, ratedUserId: string, score: number): void {
  if (raterUserId === ratedUserId) {
    throw new Error("PROFILE_RATE_SELF_NOT_ALLOWED");
  }

  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error("PROFILE_RATING_SCORE_INVALID");
  }
}

function validateUuid(input: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("USER_ID_INVALID");
  }
}
