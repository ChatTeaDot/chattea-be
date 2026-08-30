import { randomUUID } from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "src/modules/database/schema";
import { CommunityRepository } from "src/modules/community/community.repository";
import { CommunityService } from "src/modules/community/community.service";
import { NotificationService } from "src/modules/notification/notification.service";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

describePostgres("Community PostgreSQL idempotency", () => {
  const namespace = randomUUID().replaceAll("-", "").slice(0, 12);
  const authorUserId = randomUUID();
  const commenterUserId = randomUUID();
  let pool: Pool;
  let repository: CommunityRepository;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
      max: 8,
    });
    repository = new CommunityRepository(drizzle(pool, { schema }));
    for (const [index, userId] of [authorUserId, commenterUserId].entries()) {
      await pool.query('INSERT INTO users ("userId", email, password, "userName", gender) VALUES ($1,$2,$3,$4,$5)', [
        userId,
        `${namespace}-${index}@example.test`,
        "hash",
        `community-user-${index}`,
        "female",
      ]);
    }
  });

  beforeEach(async () => {
    await pool.query(
      'DELETE FROM community_comments WHERE "authorUserId" = ANY($1::uuid[]) OR "postId" IN (SELECT id FROM community_posts WHERE "authorUserId" = ANY($1::uuid[]))',
      [[authorUserId, commenterUserId]],
    );
    await pool.query('DELETE FROM community_posts WHERE "authorUserId" = ANY($1::uuid[])', [
      [authorUserId, commenterUserId],
    ]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(
      'DELETE FROM community_comments WHERE "authorUserId" = ANY($1::uuid[]) OR "postId" IN (SELECT id FROM community_posts WHERE "authorUserId" = ANY($1::uuid[]))',
      [[authorUserId, commenterUserId]],
    );
    await pool.query('DELETE FROM community_posts WHERE "authorUserId" = ANY($1::uuid[])', [
      [authorUserId, commenterUserId],
    ]);
    await pool.query('DELETE FROM users WHERE "userId" = ANY($1::uuid[])', [[authorUserId, commenterUserId]]);
    await pool.end();
  });

  it("replays concurrent post creation and rejects key reuse for a different payload", async () => {
    const service = new CommunityService(repository);
    const idempotencyKey = randomUUID();
    const createPost = service.createPost.bind(service) as (
      userId: string,
      input: { body: string; idempotencyKey: string; title: string },
    ) => ReturnType<CommunityService["createPost"]>;
    const input = { idempotencyKey, title: "같은 제목", body: "같은 본문" };

    const retries = await Promise.all(Array.from({ length: 8 }, () => createPost(authorUserId, input)));

    expect(new Set(retries.map((post) => post.id))).toEqual(new Set([idempotencyKey]));
    await expect(createPost(authorUserId, { ...input, body: "다른 본문" })).rejects.toThrow(
      "COMMUNITY_POST_IDEMPOTENCY_KEY_ALREADY_USED",
    );
  });

  it("replays concurrent comment creation, notifies once, and rejects cross-owner key reuse", async () => {
    const postId = randomUUID();
    await pool.query('INSERT INTO community_posts (id, "authorUserId", title, body) VALUES ($1,$2,$3,$4)', [
      postId,
      authorUserId,
      "부모 글",
      "본문",
    ]);
    const notify = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    const service = new CommunityService(repository, { notify } as unknown as NotificationService);
    const createComment = service.createComment.bind(service) as (
      userId: string,
      postId: string,
      body: string,
      idempotencyKey: string,
    ) => ReturnType<CommunityService["createComment"]>;
    const idempotencyKey = randomUUID();

    const retries = await Promise.all(
      Array.from({ length: 8 }, () => createComment(commenterUserId, postId, "같은 댓글", idempotencyKey)),
    );

    expect(new Set(retries.map((comment) => comment.id))).toEqual(new Set([idempotencyKey]));
    expect(notify).toHaveBeenCalledTimes(1);
    await expect(createComment(authorUserId, postId, "같은 댓글", idempotencyKey)).rejects.toThrow(
      "COMMUNITY_COMMENT_IDEMPOTENCY_KEY_ALREADY_USED",
    );
  });
});
