import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { communityComments, communityPostReports, communityPosts, communityProfiles } from "src/modules/database/schema";

@Injectable()
export class CommunityRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /**
   * 삭제되지 않은 커뮤니티 게시글 목록을 댓글 수와 함께 조회한다.
   *
   * @returns 커뮤니티 게시글 목록
   */
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

  /**
   * 게시글의 삭제되지 않은 댓글 목록을 조회한다.
   *
   * @param postId 게시글 ID
   * @returns 댓글 목록
   */
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

  /**
   * 커뮤니티 게시글을 생성한다.
   *
   * @param input 작성자 ID와 게시글 본문
   * @returns 생성된 게시글
   */
  async createPost(input: { userId: string; title: string; body: string }) {
    const [post] = await this.db
      .insert(communityPosts)
      .values({
        authorUserId: input.userId,
        title: input.title,
        body: input.body,
      })
      .returning();

    return post;
  }

  /**
   * 삭제되지 않은 게시글을 ID로 조회한다.
   *
   * @param postId 게시글 ID
   * @returns 게시글 또는 undefined
   */
  async findPost(postId: string) {
    return this.db.query.communityPosts.findFirst({
      where: and(eq(communityPosts.id, postId), isNull(communityPosts.deletedAt)),
    });
  }

  /**
   * 커뮤니티 댓글을 생성한다.
   *
   * @param input 작성자 ID, 게시글 ID, 댓글 본문
   * @returns 생성된 댓글
   */
  async createComment(input: { userId: string; postId: string; body: string }) {
    const [comment] = await this.db
      .insert(communityComments)
      .values({
        postId: input.postId,
        authorUserId: input.userId,
        body: input.body,
      })
      .returning();

    return comment;
  }

  /**
   * 게시글 신고 사유를 저장하거나 갱신한다.
   *
   * @param input 신고자 ID, 게시글 ID, 신고 사유
   * @returns 저장 완료 Promise
   */
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

  /**
   * 커뮤니티 프로필을 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 커뮤니티 프로필 또는 undefined
   */
  findProfile(userId: string) {
    return this.db.query.communityProfiles.findFirst({ where: eq(communityProfiles.userId, userId) });
  }

  /**
   * 커뮤니티 프로필 이름을 생성하거나 갱신한다.
   *
   * @param input 사용자 ID와 커뮤니티 이름
   * @returns 커뮤니티 프로필
   */
  async upsertProfile(input: { userId: string; name: string }) {
    const [profile] = await this.db
      .insert(communityProfiles)
      .values(input)
      .onConflictDoUpdate({
        target: communityProfiles.userId,
        set: { name: input.name, updatedAt: new Date() },
      })
      .returning();

    return profile;
  }
}
