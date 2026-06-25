import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

const TITLE_MAX_LENGTH = 80;
const BODY_MAX_LENGTH = 1000;
const COMMENT_MAX_LENGTH = 500;
const REPORT_REASON_MAX_LENGTH = 120;

export type CommunityPost = {
  id: string;
  anonymousNickname: string;
  title: string;
  body: string;
  commentCount: number;
  createdAt: string;
};

export type CommunityComment = {
  id: string;
  postId: string;
  anonymousNickname: string;
  body: string;
  createdAt: string;
};

export class CommunityService {
  private readonly posts: Array<CommunityPost & { authorUserId: string }> = [];
  private readonly comments: Array<CommunityComment & { authorUserId: string }> = [];
  private readonly reports = new Set<string>();

  listPosts(): CommunityPost[] {
    return [...this.posts].reverse().map(stripPostAuthor);
  }

  listComments(postId: string): CommunityComment[] {
    return this.comments.filter((comment) => comment.postId === postId).map(stripCommentAuthor);
  }

  createPost(userId: string, input: { title: string; body: string }, now = new Date()): CommunityPost {
    const post = {
      id: randomUUID(),
      authorUserId: userId,
      anonymousNickname: buildAnonymousNickname(this.posts.length + 1),
      title: validateText(input.title, TITLE_MAX_LENGTH, "COMMUNITY_TITLE"),
      body: validateText(input.body, BODY_MAX_LENGTH, "COMMUNITY_BODY"),
      commentCount: 0,
      createdAt: now.toISOString(),
    };

    this.posts.push(post);
    return stripPostAuthor(post);
  }

  createComment(userId: string, postId: string, body: string, now = new Date()): CommunityComment {
    if (!this.posts.some((post) => post.id === postId)) {
      throw new Error("COMMUNITY_POST_NOT_FOUND");
    }

    const comment = {
      id: randomUUID(),
      postId,
      authorUserId: userId,
      anonymousNickname: buildAnonymousNickname(this.comments.length + 1),
      body: validateText(body, COMMENT_MAX_LENGTH, "COMMUNITY_COMMENT"),
      createdAt: now.toISOString(),
    };

    this.comments.push(comment);
    const post = this.posts.find((item) => item.id === postId);
    if (post) {
      post.commentCount += 1;
    }
    return stripCommentAuthor(comment);
  }

  reportPost(userId: string, postId: string, reason: string): boolean {
    if (!this.posts.some((post) => post.id === postId)) {
      throw new Error("COMMUNITY_POST_NOT_FOUND");
    }

    this.reports.add(`${postId}:${userId}:${validateText(reason, REPORT_REASON_MAX_LENGTH, "COMMUNITY_REPORT_REASON")}`);
    return true;
  }
}

export class PostgresCommunityService {
  constructor(private readonly pool: Pool) {}

  async listPosts(): Promise<CommunityPost[]> {
    const result = await this.pool.query<{
      id: string;
      anonymous_nickname: string;
      title: string;
      body: string;
      comment_count: string;
      created_at: Date;
    }>(
      `
        SELECT community_posts.id::text,
               community_posts.anonymous_nickname,
               community_posts.title,
               community_posts.body,
               COUNT(community_comments.id)::text AS comment_count,
               community_posts.created_at
        FROM community_posts
        LEFT JOIN community_comments ON community_comments.post_id = community_posts.id
        WHERE community_posts.deleted_at IS NULL
        GROUP BY community_posts.id
        ORDER BY community_posts.created_at DESC
        LIMIT 50
      `,
    );

    return result.rows.map(rowToPost);
  }

  async listComments(postId: string): Promise<CommunityComment[]> {
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    const result = await this.pool.query<{
      id: string;
      post_id: string;
      anonymous_nickname: string;
      body: string;
      created_at: Date;
    }>(
      `
        SELECT id::text, post_id::text, anonymous_nickname, body, created_at
        FROM community_comments
        WHERE post_id = $1
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 100
      `,
      [postId],
    );

    return result.rows.map(rowToComment);
  }

  async createPost(userId: string, input: { title: string; body: string }, now = new Date()): Promise<CommunityPost> {
    validateUuid(userId, "USER_ID_INVALID");
    const result = await this.pool.query<{
      id: string;
      anonymous_nickname: string;
      title: string;
      body: string;
      comment_count: string;
      created_at: Date;
    }>(
      `
        INSERT INTO community_posts (author_user_id, anonymous_nickname, title, body, created_at, updated_at)
        VALUES (
          $1,
          '익명' || nextval('community_anonymous_nickname_seq')::text,
          $2,
          $3,
          $4,
          $4
        )
        RETURNING id::text, anonymous_nickname, title, body, '0' AS comment_count, created_at
      `,
      [
        userId,
        validateText(input.title, TITLE_MAX_LENGTH, "COMMUNITY_TITLE"),
        validateText(input.body, BODY_MAX_LENGTH, "COMMUNITY_BODY"),
        now,
      ],
    );

    return rowToPost(result.rows[0]!);
  }

  async createComment(userId: string, postId: string, body: string, now = new Date()): Promise<CommunityComment> {
    validateUuid(userId, "USER_ID_INVALID");
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    const result = await this.pool.query<{
      id: string;
      post_id: string;
      anonymous_nickname: string;
      body: string;
      created_at: Date;
    }>(
      `
        INSERT INTO community_comments (post_id, author_user_id, anonymous_nickname, body, created_at, updated_at)
        SELECT $1, $2, '익명' || nextval('community_anonymous_nickname_seq')::text, $3, $4, $4
        WHERE EXISTS (
          SELECT 1
          FROM community_posts
          WHERE id = $1
            AND deleted_at IS NULL
        )
        RETURNING id::text, post_id::text, anonymous_nickname, body, created_at
      `,
      [postId, userId, validateText(body, COMMENT_MAX_LENGTH, "COMMUNITY_COMMENT"), now],
    );

    if (!result.rows[0]) {
      throw new Error("COMMUNITY_POST_NOT_FOUND");
    }

    return rowToComment(result.rows[0]);
  }

  async reportPost(userId: string, postId: string, reason: string): Promise<boolean> {
    validateUuid(userId, "USER_ID_INVALID");
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    await this.pool.query(
      `
        INSERT INTO community_post_reports (post_id, reporter_user_id, reason)
        VALUES ($1, $2, $3)
        ON CONFLICT (post_id, reporter_user_id)
        DO UPDATE SET reason = EXCLUDED.reason, created_at = now()
      `,
      [postId, userId, validateText(reason, REPORT_REASON_MAX_LENGTH, "COMMUNITY_REPORT_REASON")],
    );
    return true;
  }
}

function validateText(input: string, maxLength: number, field: string): string {
  const value = input.trim();
  if (!value) {
    throw new Error(`${field}_REQUIRED`);
  }

  if (value.length > maxLength) {
    throw new Error(`${field}_TOO_LONG`);
  }

  return value;
}

function validateUuid(input: string, error: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error(error);
  }
}

function buildAnonymousNickname(index: number): string {
  return `익명${index}`;
}

function stripPostAuthor(post: CommunityPost & { authorUserId: string }): CommunityPost {
  return {
    id: post.id,
    anonymousNickname: post.anonymousNickname,
    title: post.title,
    body: post.body,
    commentCount: post.commentCount,
    createdAt: post.createdAt,
  };
}

function stripCommentAuthor(comment: CommunityComment & { authorUserId: string }): CommunityComment {
  return {
    id: comment.id,
    postId: comment.postId,
    anonymousNickname: comment.anonymousNickname,
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

function rowToPost(row: {
  id: string;
  anonymous_nickname: string;
  title: string;
  body: string;
  comment_count: string;
  created_at: Date;
}): CommunityPost {
  return {
    id: row.id,
    anonymousNickname: row.anonymous_nickname,
    title: row.title,
    body: row.body,
    commentCount: Number(row.comment_count),
    createdAt: row.created_at.toISOString(),
  };
}

function rowToComment(row: {
  id: string;
  post_id: string;
  anonymous_nickname: string;
  body: string;
  created_at: Date;
}): CommunityComment {
  return {
    id: row.id,
    postId: row.post_id,
    anonymousNickname: row.anonymous_nickname,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}
