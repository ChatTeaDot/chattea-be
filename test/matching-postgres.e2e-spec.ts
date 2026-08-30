import { randomUUID } from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "src/modules/database/schema";
import { MatchingRepository } from "src/modules/matching/matching.repository";
import { MatchingService } from "src/modules/matching/matching.service";
import { UserRepository } from "src/modules/user/user.repository";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

describePostgres("Matching PostgreSQL integrity", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");
  const namespace = randomUUID().slice(0, 8);
  const makeId = (group: number, item: number) =>
    `${namespace}-${group.toString(16).padStart(4, "0")}-4000-8000-${item.toString(16).padStart(12, "0")}`;
  const ids = {
    superLikeActor: makeId(1, 1),
    superLikeTarget: makeId(1, 2),
    reciprocalA: makeId(2, 1),
    reciprocalB: makeId(2, 2),
    likedViewer: makeId(3, 1),
    visibleLiker: makeId(3, 2),
    viewerBlockedLiker: makeId(3, 3),
    likerBlockedViewer: makeId(3, 4),
    dailyActor: makeId(4, 1),
    dailyTargets: Array.from({ length: 8 }, (_, index) => makeId(4, index + 2)),
    boostActor: makeId(5, 1),
    retryActor: makeId(6, 1),
    retryTarget: makeId(6, 2),
  };
  const userIds = [
    ids.superLikeActor,
    ids.superLikeTarget,
    ids.reciprocalA,
    ids.reciprocalB,
    ids.likedViewer,
    ids.visibleLiker,
    ids.viewerBlockedLiker,
    ids.likerBlockedViewer,
    ids.dailyActor,
    ...ids.dailyTargets,
    ids.boostActor,
    ids.retryActor,
    ids.retryTarget,
  ];
  let pool: Pool;
  let repository: MatchingRepository;
  let service: MatchingService;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
    });
    const db = drizzle(pool, { schema });
    repository = new MatchingRepository(db);
    service = new MatchingService(repository, new UserRepository(db));
    await pool.query('DELETE FROM "users" WHERE "userId" = ANY($1::uuid[])', [userIds]);
    for (const [index, userId] of userIds.entries()) {
      await pool.query(
        'INSERT INTO "users" ("userId", email, password, gender, "userName", "interestedGender", "profileCompletedAt") VALUES ($1, $2, $3, $4, $5, $6, now())',
        [userId, `pg-matching-${namespace}-${index}@example.test`, "hash", "male", `user-${index}`, "everyone"],
      );
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(
      'DELETE FROM rooms WHERE id IN (SELECT "roomId" FROM matches WHERE "userLowId" = ANY($1::uuid[]) OR "userHighId" = ANY($1::uuid[]))',
      [userIds],
    );
    await pool.query('DELETE FROM "users" WHERE "userId" = ANY($1::uuid[])', [userIds]);
    await pool.end();
  });

  it("refunds a concurrently undone superlike exactly once", async () => {
    await pool.query(
      'INSERT INTO user_consumable_balances ("userId", "superLikeCredits", "boostCredits") VALUES ($1, 1, 0)',
      [ids.superLikeActor],
    );
    await repository.actOnCandidate({
      userId: ids.superLikeActor,
      targetUserId: ids.superLikeTarget,
      action: "superlike",
      dailyLimit: null,
      now,
      dayStart: new Date("2026-08-28T00:00:00.000Z"),
      dayEnd: new Date("2026-08-29T00:00:00.000Z"),
    });

    const undos = await Promise.all([
      repository.undoLastAction(ids.superLikeActor),
      repository.undoLastAction(ids.superLikeActor),
    ]);
    const balance = await pool.query<{ superLikeCredits: number }>(
      'SELECT "superLikeCredits" FROM user_consumable_balances WHERE "userId" = $1',
      [ids.superLikeActor],
    );
    const likes = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM user_likes WHERE "likerUserId" = $1 AND "likedUserId" = $2',
      [ids.superLikeActor, ids.superLikeTarget],
    );

    expect(undos.filter(Boolean)).toHaveLength(1);
    expect(balance.rows[0]?.superLikeCredits).toBe(1);
    expect(likes.rows[0]?.count).toBe(0);
  });

  it("replays the same superlike without spending or recording it twice", async () => {
    await pool.query(
      'INSERT INTO user_consumable_balances ("userId", "superLikeCredits", "boostCredits") VALUES ($1, 2, 0)',
      [ids.retryActor],
    );
    const input = {
      userId: ids.retryActor,
      targetUserId: ids.retryTarget,
      action: "superlike" as const,
      dailyLimit: null,
      now,
      dayStart: new Date("2026-08-28T00:00:00.000Z"),
      dayEnd: new Date("2026-08-29T00:00:00.000Z"),
    };

    const first = await repository.actOnCandidate(input);
    const replay = await repository.actOnCandidate(input);
    await expect(repository.actOnCandidate({ ...input, action: "like" })).rejects.toThrow("MATCH_ACTION_CONFLICT");
    const balance = await pool.query<{ superLikeCredits: number }>(
      'SELECT "superLikeCredits" FROM user_consumable_balances WHERE "userId" = $1',
      [ids.retryActor],
    );
    const actions = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM match_actions WHERE "actorUserId" = $1 AND "targetUserId" = $2 AND "revertedAt" IS NULL',
      [ids.retryActor, ids.retryTarget],
    );

    expect(first).toEqual(expect.objectContaining({ matched: false, created: true }));
    expect(replay).toEqual({ ...first, created: false });
    expect(balance.rows[0]?.superLikeCredits).toBe(1);
    expect(actions.rows[0]?.count).toBe(1);
  });

  it("creates one match room when reciprocal likes execute concurrently", async () => {
    const input = {
      action: "like" as const,
      dailyLimit: null,
      now,
      dayStart: new Date("2026-08-28T00:00:00.000Z"),
      dayEnd: new Date("2026-08-29T00:00:00.000Z"),
    };
    const functionName = `matching_delay_${namespace}`;
    const triggerName = `matching_delay_${namespace}`;
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} AFTER INSERT ON user_likes FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    let results;
    try {
      results = await Promise.all([
        repository.actOnCandidate({ ...input, userId: ids.reciprocalA, targetUserId: ids.reciprocalB }),
        repository.actOnCandidate({ ...input, userId: ids.reciprocalB, targetUserId: ids.reciprocalA }),
      ]);
    } finally {
      await pool.query(`DROP TRIGGER ${triggerName} ON user_likes`);
      await pool.query(`DROP FUNCTION ${functionName}()`);
    }
    const matches = await pool.query<{ roomId: string }>(
      'SELECT "roomId" FROM matches WHERE "userLowId" = $1 AND "userHighId" = $2',
      [ids.reciprocalA, ids.reciprocalB],
    );
    const roomMembers = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM room_members WHERE "roomId" = $1',
      [matches.rows[0]?.roomId],
    );

    expect(matches.rows).toHaveLength(1);
    expect(roomMembers.rows[0]?.count).toBe(2);
    expect(results.filter((result) => result.matched)).toHaveLength(1);
    expect(results.find((result) => result.matched)?.roomId).toBe(matches.rows[0]?.roomId);
  });

  it("hides pre-existing likes across both block directions", async () => {
    await pool.query('INSERT INTO user_likes ("likerUserId", "likedUserId") VALUES ($1,$4),($2,$4),($3,$4)', [
      ids.visibleLiker,
      ids.viewerBlockedLiker,
      ids.likerBlockedViewer,
      ids.likedViewer,
    ]);
    await pool.query('INSERT INTO user_blocks ("blockerUserId", "blockedUserId") VALUES ($1,$2),($3,$1)', [
      ids.likedViewer,
      ids.viewerBlockedLiker,
      ids.likerBlockedViewer,
    ]);

    const candidates = await repository.likedMeCandidates(ids.likedViewer, 50);

    expect(candidates.map((candidate) => candidate.id)).toEqual([ids.visibleLiker]);
  });

  it("loads recommendation details in a bounded number of queries", async () => {
    const query = jest.spyOn(pool, "query");
    try {
      const candidates = await repository.candidates(ids.likedViewer);

      expect(candidates.length).toBeGreaterThan(0);
      expect(query).toHaveBeenCalled();
      expect(query.mock.calls.length).toBeLessThanOrEqual(6);
    } finally {
      query.mockRestore();
    }
  });

  it("has indexes for reverse relationship and push-token lookups", async () => {
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[])",
      [
        [
          "user_blocks_blocked_blocker_idx",
          "matches_user_high_low_idx",
          "push_tokens_user_idx",
          "users_matching_visible_created_idx",
          "user_boosts_user_active_idx",
        ],
      ],
    );

    expect(indexes.rows.map(({ indexname }) => indexname).sort()).toEqual([
      "matches_user_high_low_idx",
      "push_tokens_user_idx",
      "user_blocks_blocked_blocker_idx",
      "user_boosts_user_active_idx",
      "users_matching_visible_created_idx",
    ]);
  });

  it("admits only one concurrent daily like at a limit of one", async () => {
    const attempts = await Promise.allSettled(
      ids.dailyTargets.map((targetUserId) =>
        repository.actOnCandidate({
          userId: ids.dailyActor,
          targetUserId,
          action: "like",
          dailyLimit: 1,
          now,
          dayStart: new Date("2026-08-28T00:00:00.000Z"),
          dayEnd: new Date("2026-08-29T00:00:00.000Z"),
        }),
      ),
    );
    const likes = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM user_likes WHERE "likerUserId" = $1',
      [ids.dailyActor],
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(likes.rows[0]?.count).toBe(1);
  });

  it("spends one credit when boost activation races", async () => {
    await pool.query(
      'INSERT INTO user_consumable_balances ("userId", "superLikeCredits", "boostCredits") VALUES ($1, 0, 2)',
      [ids.boostActor],
    );

    const attempts = await Promise.allSettled([
      repository.activateBoost(ids.boostActor, now),
      repository.activateBoost(ids.boostActor, now),
    ]);
    const balance = await pool.query<{ boostCredits: number }>(
      'SELECT "boostCredits" FROM user_consumable_balances WHERE "userId" = $1',
      [ids.boostActor],
    );
    const boosts = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM user_boosts WHERE "userId" = $1',
      [ids.boostActor],
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ message: "BOOST_ALREADY_ACTIVE" }),
    });
    expect(balance.rows[0]?.boostCredits).toBe(1);
    expect(boosts.rows[0]?.count).toBe(1);
  });

  it("admits only one concurrent liked-me view at the last window slot", async () => {
    const periodStart = new Date("2026-08-28T03:00:00.000Z");
    await pool.query('INSERT INTO user_subscriptions ("userId", "planId", status) VALUES ($1, $2, $3)', [
      ids.likedViewer,
      "basic",
      "active",
    ]);
    await service.likedMeCandidates(ids.likedViewer, periodStart);
    await service.likedMeCandidates(ids.likedViewer, periodStart);
    const functionName = `liked_view_delay_${namespace}`;
    const triggerName = `liked_view_delay_${namespace}`;
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON user_liked_me_accesses FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    let attempts;
    try {
      attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () => service.likedMeCandidates(ids.likedViewer, periodStart)),
      );
    } finally {
      await pool.query(`DROP TRIGGER ${triggerName} ON user_liked_me_accesses`);
      await pool.query(`DROP FUNCTION ${functionName}()`);
    }
    const access = await pool.query<{ viewedCount: number }>(
      'SELECT "viewedCount" FROM user_liked_me_accesses WHERE "userId" = $1',
      [ids.likedViewer],
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(access.rows[0]?.viewedCount).toBe(3);
  });
});
