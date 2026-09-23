import { Injectable, Logger, Optional } from "@nestjs/common";
import { NotificationService } from "src/modules/notification/notification.service";
import { CommunityRepository } from "./community.repository";
import { CommunityCommentPayload, CommunityPostPayload } from "./community.types";

const DEFAULT_COMMUNITY_NAME = "익명";
const TITLE_MAX_LENGTH = 80;
const BODY_MAX_LENGTH = 1000;
const COMMENT_MAX_LENGTH = 500;
const REPORT_REASON_MAX_LENGTH = 120;

@Injectable()
export class CommunityService {
  private readonly logger = new Logger(CommunityService.name);

  constructor(
    private readonly communityRepository: CommunityRepository,
    @Optional() private readonly notificationService?: NotificationService,
  ) {}

  async posts(): Promise<CommunityPostPayload[]> {
    const result = await this.communityRepository.posts();

    return result.map(rowToPost);
  }

  async comments(postId: string): Promise<CommunityCommentPayload[]> {
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    const result = await this.communityRepository.comments(postId);

    return result.map(rowToComment);
  }

  async createPost(
    userId: string,
    input: { idempotencyKey: string; title: string; body: string },
  ): Promise<CommunityPostPayload> {
    validateUuid(userId, "USER_ID_INVALID");
    validateUuid(input.idempotencyKey, "COMMUNITY_POST_IDEMPOTENCY_KEY_INVALID");
    const title = validateText(input.title, TITLE_MAX_LENGTH, "COMMUNITY_TITLE");
    const body = validateText(input.body, BODY_MAX_LENGTH, "COMMUNITY_BODY");
    const authorName = await this.authorName(userId);
    const { post } = await this.communityRepository.createPost({
      id: input.idempotencyKey,
      userId,
      title,
      body,
    });

    return rowToPost({ ...post, authorName, id: post.id, commentCount: "0" });
  }

  async createComment(
    userId: string,
    postId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<CommunityCommentPayload> {
    validateUuid(userId, "USER_ID_INVALID");
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    validateUuid(idempotencyKey, "COMMUNITY_COMMENT_IDEMPOTENCY_KEY_INVALID");
    const post = await this.communityRepository.findPost(postId);
    if (!post) throw new Error("COMMUNITY_POST_NOT_FOUND");
    const authorName = await this.authorName(userId);
    const result = await this.communityRepository.createComment({
      id: idempotencyKey,
      userId,
      postId,
      body: validateText(body, COMMENT_MAX_LENGTH, "COMMUNITY_COMMENT"),
    });
    const { comment } = result;
    if (result.created && this.notificationService && post.authorUserId !== userId) {
      try {
        await this.notificationService.notify({
          userId: post.authorUserId,
          type: "comment",
          title: "새 댓글이 달렸어요",
          body: "내 글에 남긴 댓글을 확인해 보세요.",
          route: `/community/${postId}`,
          sourceId: comment.id,
        });
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: "community_notification_failed",
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
    return rowToComment({ ...comment, authorName });
  }

  async reportPost(userId: string, postId: string, reason: string): Promise<boolean> {
    validateUuid(userId, "USER_ID_INVALID");
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    await this.communityRepository.reportPost({
      userId,
      postId,
      reason: validateText(reason, REPORT_REASON_MAX_LENGTH, "COMMUNITY_REPORT_REASON"),
    });
    return true;
  }

  async reportComment(userId: string, commentId: string, reason: string): Promise<boolean> {
    validateUuid(userId, "USER_ID_INVALID");
    validateUuid(commentId, "COMMUNITY_COMMENT_ID_INVALID");
    if (!(await this.communityRepository.findComment(commentId))) throw new Error("COMMUNITY_COMMENT_NOT_FOUND");
    await this.communityRepository.reportComment({
      userId,
      commentId,
      reason: validateText(reason, REPORT_REASON_MAX_LENGTH, "COMMUNITY_REPORT_REASON"),
    });
    return true;
  }

  private async authorName(userId: string): Promise<string> {
    return (await this.communityRepository.findProfile(userId))?.name ?? DEFAULT_COMMUNITY_NAME;
  }
}

type PostRow = {
  id: string;
  authorName: string;
  title: string;
  body: string;
  commentCount: number | string;
  createdAt: Date;
};

type CommentRow = {
  id: string;
  postId: string;
  authorName: string;
  body: string;
  createdAt: Date;
};

const validateText = (input: string, maxLength: number, field: string): string => {
  const value = input.trim();
  if (!value) throw new Error(`${field}_REQUIRED`);
  if (value.length > maxLength) throw new Error(`${field}_TOO_LONG`);
  return value;
};

const validateUuid = (input: string, error: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error(error);
  }
};

const rowToPost = (row: PostRow): CommunityPostPayload => ({
  id: row.id,
  authorName: row.authorName,
  title: row.title,
  body: row.body,
  commentCount: Number(row.commentCount),
  createdAt: row.createdAt.toISOString(),
});

const rowToComment = (row: CommentRow): CommunityCommentPayload => ({
  id: row.id,
  postId: row.postId,
  authorName: row.authorName,
  body: row.body,
  createdAt: row.createdAt.toISOString(),
});
