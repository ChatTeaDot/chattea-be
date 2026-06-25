import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MatchingService, PostgresMatchingService } from "../src/matching/matching-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describe("MatchingService", () => {
  function addSelfCandidate(service: MatchingService, userId: string) {
    service["candidates"].set(userId, {
      id: userId,
      nickname: "내 이름",
      intro: "내 소개",
      planId: "black",
      blackRecommended: false,
    });
  }

  it("lists candidates and marks liked users", () => {
    const service = new MatchingService();

    expect(service.listCandidates("me")[0]).toMatchObject({
      id: "demo-match-user",
      likedByMe: false,
      planId: "black",
      blackRecommended: true,
    });
    expect(service.likeUser("me", "demo-match-user")).toEqual({ matched: false, roomId: null });
    expect(service.listCandidates("me")[0]).toMatchObject({ id: "demo-match-user", likedByMe: true });
    expect(service.listBlackCandidates("me", "free")).toEqual([]);
    expect(service.listBlackCandidates("me", "black")[0]).toMatchObject({ id: "demo-match-user" });
  });

  it("counts likes once per target and rejects after daily free limit", () => {
    const service = new MatchingService();
    const now = new Date("2026-06-25T00:00:00.000Z");
    for (let i = 2; i <= 11; i++) {
      service["candidates"].set(`demo-match-user${i}`, {
        id: `demo-match-user${i}`,
        nickname: `차한잔${i}`,
        intro: `${i}번째`,
        planId: "free",
        blackRecommended: false,
      });
    }

    for (let i = 0; i < 10; i++) {
      service.likeUser(
        "me",
        i === 0 ? "demo-match-user" : `demo-match-user${i + 1}`,
        "free",
        now,
      );
    }

    expect(() => service.likeUser("me", "demo-match-user11", "free", now)).toThrow("LIKE_LIMIT_REACHED");
  });

  it("shows who liked me and enforces paid plan window limits", () => {
    const service = new MatchingService();
    addSelfCandidate(service, "me");
    service["candidates"].set("someone", {
      id: "someone",
      nickname: "누구",
      intro: "안녕하세요",
      planId: "free",
      blackRecommended: false,
    });

    service.likeUser("someone", "me", "free", new Date("2026-06-25T00:00:00.000Z"));
    expect(service.listLikedMeCandidates("me", "basic")).toMatchObject([
      {
        id: "someone",
        nickname: "누구",
        likedByMe: false,
        blackRecommended: false,
        planId: "free",
      },
    ]);

    service["likes"].add("me:someone");
    expect(() => service.listLikedMeCandidates("me", "basic")).not.toThrow();
    expect(() => service.listLikedMeCandidates("me", "basic")).not.toThrow();
    expect(() => service.listLikedMeCandidates("me", "basic")).toThrow("LIKED_ME_LIMIT_REACHED");
  });

  it("blocks liked-me visibility for free users", () => {
    const service = new MatchingService();
    addSelfCandidate(service, "me");
    service["candidates"].set("someone", {
      id: "someone",
      nickname: "누구",
      intro: "안녕하세요",
      planId: "free",
      blackRecommended: false,
    });

    service.likeUser("someone", "me", "free", new Date("2026-06-25T00:00:00.000Z"));

    expect(() => service.listLikedMeCandidates("me", "free")).toThrow("LIKED_ME_NOT_AVAILABLE");
  });
});

describeIfDb("PostgresMatchingService", () => {
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://localhost/unused");
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const userA = "00000000-0000-4000-8000-000000000201";
  const userB = "00000000-0000-4000-8000-000000000202";
  const userC = "00000000-0000-4000-8000-000000000203";
  let service: PostgresMatchingService;

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: databaseUrl });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    await setupPool.end();
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));

    const seedUsers = [
      [userA, "+821022220201", "tea-a", "안녕하세요"],
      [userB, "+821022220202", "tea-b", "반가워요"],
      [userC, "+821022220203", "tea-c", "오늘도 반가워요"],
      ["00000000-0000-4000-8000-000000000204", "+821022220204", "tea-d", "안내드려요"],
      ["00000000-0000-4000-8000-000000000205", "+821022220205", "tea-e", "반갑습니다"],
      ["00000000-0000-4000-8000-000000000206", "+821022220206", "tea-f", "잘부탁드려요"],
      ["00000000-0000-4000-8000-000000000207", "+821022220207", "tea-g", "천천히가요"],
      ["00000000-0000-4000-8000-000000000208", "+821022220208", "tea-h", "함께해요"],
      ["00000000-0000-4000-8000-000000000209", "+821022220209", "tea-i", "좋아요"],
      ["00000000-0000-4000-8000-000000000210", "+821022220210", "tea-j", "좋은하루"],
      ["00000000-0000-4000-8000-000000000211", "+821022220211", "tea-k", "좋았어요"],
      ["00000000-0000-4000-8000-000000000212", "+821022220212", "tea-l", "고마워요"],
    ];

    for (const [id, phone, nickname, intro] of seedUsers) {
      await pool.query(
        "INSERT INTO users (id, phone_e164, nickname, intro, terms_accepted_at) VALUES ($1, $2, $3, $4, now())",
        [id, phone, nickname, intro],
      );
    }

    await pool.query(
      "INSERT INTO user_subscriptions (user_id, plan_id, status) VALUES ($1, 'black', 'active')",
      [userB],
    );
    service = new PostgresMatchingService(pool);
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM user_likes");
    await pool.query("DELETE FROM matches");
    await pool.query("DELETE FROM room_members");
    await pool.query("DELETE FROM user_liked_me_accesses");
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("creates a chat room when likes are mutual", async () => {
    const candidates = await service.listCandidates(userA);
    expect(candidates.find((candidate) => candidate.id === userB)).toMatchObject({
      id: userB,
      nickname: "tea-b",
      intro: "반가워요",
      likedByMe: false,
      planId: "black",
      blackRecommended: true,
    });
    expect(await service.likeUser(userA, userB)).toEqual({ matched: false, roomId: null });
    const likedCandidates = await service.listCandidates(userA);
    expect(likedCandidates.find((candidate) => candidate.id === userB)).toMatchObject({
      id: userB,
      nickname: "tea-b",
      intro: "반가워요",
      likedByMe: true,
      planId: "black",
      blackRecommended: true,
    });
    expect(await service.listBlackCandidates(userA, "free")).toEqual([]);
    const blackCandidates = await service.listBlackCandidates(userA, "black");
    expect(blackCandidates.find((candidate) => candidate.id === userB)).toBeDefined();
    expect(blackCandidates).toHaveLength(1);
    expect(blackCandidates[0]).toMatchObject({
      id: userB,
      blackRecommended: true,
    });

    const matched = await service.likeUser(userB, userA);
    expect(matched.matched).toBe(true);
    expect(matched.roomId).toBeTruthy();

    const members = await pool.query("SELECT user_id::text FROM room_members WHERE room_id = $1 ORDER BY user_id", [matched.roomId]);
    expect(members.rows.map((row) => row.user_id)).toEqual([userA, userB]);
  });

  it("respects daily free like limit", async () => {
    const now = new Date("2026-06-25T00:00:00.000Z");
    const users = [
      userB,
      userC,
      "00000000-0000-4000-8000-000000000204",
      "00000000-0000-4000-8000-000000000205",
      "00000000-0000-4000-8000-000000000206",
      "00000000-0000-4000-8000-000000000207",
      "00000000-0000-4000-8000-000000000208",
      "00000000-0000-4000-8000-000000000209",
      "00000000-0000-4000-8000-000000000210",
      "00000000-0000-4000-8000-000000000211",
      "00000000-0000-4000-8000-000000000212",
    ];

    for (let i = 0; i < users.length - 1; i++) {
      await service.likeUser(userA, users[i], "free", now);
    }

    await expect(service.likeUser(userA, users[users.length - 1], "free", now)).rejects.toThrow(
      "LIKE_LIMIT_REACHED",
    );
  });

  it("returns liked-me candidates and enforces basic-plan window limits", async () => {
    const now = new Date("2026-06-25T01:00:00.000Z");
    await service.likeUser(userB, userA, "black", now);
    await service.likeUser(userC, userA, "black", now);

    const candidates = await service.listLikedMeCandidates(userA, "basic", now);
    expect(candidates.map((candidate) => candidate.id)).toEqual([userC, userB]);

    await service.listLikedMeCandidates(userA, "basic", now);
    await service.listLikedMeCandidates(userA, "basic", now);
    await expect(service.listLikedMeCandidates(userA, "basic", now)).rejects.toThrow(
      "LIKED_ME_LIMIT_REACHED",
    );
  });

  it("disallows liked-me visibility for free users", async () => {
    const now = new Date("2026-06-25T02:00:00.000Z");
    await service.likeUser(userB, userA, "black", now);
    await expect(service.listLikedMeCandidates(userA, "free", now)).rejects.toThrow(
      "LIKED_ME_NOT_AVAILABLE",
    );
  });
});
