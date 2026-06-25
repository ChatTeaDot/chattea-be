import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommunityService, PostgresCommunityService } from "../src/community/community-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describe("CommunityService", () => {
  it("creates anonymous posts, comments, and reports without exposing author ids", () => {
    const service = new CommunityService();
    const post = service.createPost("user-1", { title: "연애 상담", body: "첫 대화가 어려워요" });
    const comment = service.createComment("user-2", post.id, "천천히 물어보세요");

    expect(post).toMatchObject({ anonymousNickname: "익명1", title: "연애 상담", commentCount: 0 });
    expect(comment).toMatchObject({ anonymousNickname: "익명1", body: "천천히 물어보세요" });
    expect(service.listPosts()[0]).toMatchObject({ id: post.id, commentCount: 1 });
    expect(service.listComments(post.id)[0]).toMatchObject({ id: comment.id });
    expect(service.reportPost("user-2", post.id, "신고 사유")).toBe(true);
    expect("authorUserId" in post).toBe(false);
  });
});

describeIfDb("PostgresCommunityService", () => {
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://localhost/unused");
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const userA = "00000000-0000-4000-8000-000000000301";
  const userB = "00000000-0000-4000-8000-000000000302";
  let service: PostgresCommunityService;

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: databaseUrl });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    await setupPool.end();
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));
    await pool.query(
      `
        INSERT INTO users (id, phone_e164, nickname, terms_accepted_at)
        VALUES
          ($1, '+821033330301', 'author', now()),
          ($2, '+821033330302', 'reporter', now())
      `,
      [userA, userB],
    );
    service = new PostgresCommunityService(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("persists anonymous posts, comments, author ids, and reports", async () => {
    const post = await service.createPost(userA, { title: "익명 고민", body: "매칭 후 첫 대화 고민" }, new Date("2026-06-25T00:00:00.000Z"));
    const comment = await service.createComment(userB, post.id, "가볍게 인사부터 해보세요", new Date("2026-06-25T00:01:00.000Z"));

    expect((await service.listPosts())[0]).toMatchObject({ id: post.id, anonymousNickname: "익명1", commentCount: 1 });
    expect((await service.listComments(post.id))[0]).toMatchObject({ id: comment.id, anonymousNickname: "익명2" });
    expect(await service.reportPost(userB, post.id, "부적절한 내용")).toBe(true);

    const stored = await pool.query("SELECT author_user_id::text FROM community_posts WHERE id = $1", [post.id]);
    const report = await pool.query("SELECT reason FROM community_post_reports WHERE post_id = $1 AND reporter_user_id = $2", [post.id, userB]);

    expect(stored.rows[0]?.author_user_id).toBe(userA);
    expect(report.rows[0]?.reason).toBe("부적절한 내용");
  });
});
