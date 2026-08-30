import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  communityCommentReports,
  communityComments,
  communityPostReports,
  communityPosts,
  communityProfiles,
} from "src/modules/database/schema";

@Injectable()
export class CommunityRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async posts() {
    return this.db
      .select({
        id: communityPosts.id,
        authorName: sql<string>`coalesce(${communityProfiles.name}, '익명')`,
        title: communityPosts.title,
        body: communityPosts.body,
        commentCount: count(communityComments.id),
        createdAt: communityPosts.createdAt,
      })
      .from(communityPosts)
      .leftJoin(
        communityComments,
        and(eq(communityComments.postId, communityPosts.id), isNull(communityComments.deletedAt)),
      )
      .leftJoin(communityProfiles, eq(communityProfiles.userId, communityPosts.authorUserId))
      .where(isNull(communityPosts.deletedAt))
      .groupBy(communityPosts.id, communityProfiles.name)
      .orderBy(desc(communityPosts.createdAt), desc(communityPosts.id))
      .limit(50);
  }

  async comments(postId: string) {
    return this.db
      .select({
        id: communityComments.id,
        postId: communityComments.postId,
        authorName: sql<string>`coalesce(${communityProfiles.name}, '익명')`,
        body: communityComments.body,
        createdAt: communityComments.createdAt,
      })
      .from(communityComments)
      .leftJoin(communityProfiles, eq(communityProfiles.userId, communityComments.authorUserId))
      .where(and(eq(communityComments.postId, postId), isNull(communityComments.deletedAt)))
      .orderBy(asc(communityComments.createdAt), asc(communityComments.id))
      .limit(100);
  }

  async createPost(input: { id: string; userId: string; title: string; body: string }) {
    const [post] = await this.db
      .insert(communityPosts)
      .values({
        id: input.id,
        authorUserId: input.userId,
        title: input.title,
        body: input.body,
      })
      .onConflictDoNothing({ target: communityPosts.id })
      .returning();

    if (post) return { post, created: true } as const;

    const replayedPost = await this.db.query.communityPosts.findFirst({
      where: eq(communityPosts.id, input.id),
    });
    if (
      !replayedPost ||
      replayedPost.authorUserId !== input.userId ||
      replayedPost.title !== input.title ||
      replayedPost.body !== input.body ||
      replayedPost.deletedAt
    ) {
      throw new Error("COMMUNITY_POST_IDEMPOTENCY_KEY_ALREADY_USED");
    }
    return { post: replayedPost, created: false } as const;
  }

  async findPost(postId: string) {
    return this.db.query.communityPosts.findFirst({
      where: and(eq(communityPosts.id, postId), isNull(communityPosts.deletedAt)),
    });
  }

  async createComment(input: { id: string; userId: string; postId: string; body: string }) {
    const [comment] = await this.db
      .insert(communityComments)
      .values({
        id: input.id,
        postId: input.postId,
        authorUserId: input.userId,
        body: input.body,
      })
      .onConflictDoNothing({ target: communityComments.id })
      .returning();

    if (comment) return { comment, created: true } as const;

    const replayedComment = await this.db.query.communityComments.findFirst({
      where: eq(communityComments.id, input.id),
    });
    if (
      !replayedComment ||
      replayedComment.authorUserId !== input.userId ||
      replayedComment.postId !== input.postId ||
      replayedComment.body !== input.body ||
      replayedComment.deletedAt
    ) {
      throw new Error("COMMUNITY_COMMENT_IDEMPOTENCY_KEY_ALREADY_USED");
    }
    return { comment: replayedComment, created: false } as const;
  }

  async findComment(commentId: string) {
    return this.db.query.communityComments.findFirst({
      where: and(eq(communityComments.id, commentId), isNull(communityComments.deletedAt)),
    });
  }

  async reportPost(input: { userId: string; postId: string; reason: string }) {
    await this.db
      .insert(communityPostReports)
      .values({
        postId: input.postId,
        reporterUserId: input.userId,
        reason: input.reason,
      })
      .onConflictDoUpdate({
        target: [communityPostReports.postId, communityPostReports.reporterUserId],
        set: { reason: input.reason, createdAt: new Date() },
      });
  }

  async reportComment(input: { userId: string; commentId: string; reason: string }) {
    await this.db
      .insert(communityCommentReports)
      .values({ commentId: input.commentId, reporterUserId: input.userId, reason: input.reason })
      .onConflictDoUpdate({
        target: [communityCommentReports.commentId, communityCommentReports.reporterUserId],
        set: { reason: input.reason, createdAt: new Date() },
      });
  }

  findProfile(userId: string) {
    return this.db.query.communityProfiles.findFirst({ where: eq(communityProfiles.userId, userId) });
  }
}
