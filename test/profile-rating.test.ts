import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresProfileRatingService, ProfileRatingService } from "../src/profile/profile-rating-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describe("ProfileRatingService", () => {
  it("upserts profile ratings without exposing them as public profile scores", () => {
    const service = new ProfileRatingService();

    expect(service.rateProfile("user-1", "user-2", 4)).toEqual({ userId: "user-2", averageScore: 4, ratingCount: 1 });
    expect(service.rateProfile("user-1", "user-2", 5)).toEqual({ userId: "user-2", averageScore: 5, ratingCount: 1 });
    expect(() => service.rateProfile("user-1", "user-1", 5)).toThrow("PROFILE_RATE_SELF_NOT_ALLOWED");
    expect(() => service.rateProfile("user-1", "user-2", 6)).toThrow("PROFILE_RATING_SCORE_INVALID");
  });
});

describeIfDb("PostgresProfileRatingService", () => {
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://localhost/unused");
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const userA = "00000000-0000-4000-8000-000000000401";
  const userB = "00000000-0000-4000-8000-000000000402";
  let service: PostgresProfileRatingService;

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: databaseUrl });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    await setupPool.end();
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));
    await pool.query(
      `
        INSERT INTO users (id, phone_e164, nickname, terms_accepted_at)
        VALUES
          ($1, '+821044440401', 'rater', now()),
          ($2, '+821044440402', 'rated', now())
      `,
      [userA, userB],
    );
    service = new PostgresProfileRatingService(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("persists one rating per rater and rated user", async () => {
    expect(await service.rateProfile(userA, userB, 4)).toEqual({ userId: userB, averageScore: 4, ratingCount: 1 });
    expect(await service.rateProfile(userA, userB, 5)).toEqual({ userId: userB, averageScore: 5, ratingCount: 1 });

    const stored = await pool.query("SELECT score FROM profile_ratings WHERE rater_user_id = $1 AND rated_user_id = $2", [userA, userB]);
    expect(stored.rows[0]?.score).toBe(5);
  });
});
