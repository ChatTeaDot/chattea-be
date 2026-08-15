import { Injectable, Optional } from "@nestjs/common";
import { NotificationService } from "src/modules/notification/notification.service";
import { CommunityRepository } from "./community.repository";
import { CommunityCommentPayload, CommunityPostPayload, CommunityProfilePayload } from "./community.types";

const DEFAULT_COMMUNITY_NAME = "익명";
const COMMUNITY_NAME_MAX_LENGTH = 20;
const TITLE_MAX_LENGTH = 80;
const BODY_MAX_LENGTH = 1000;
const COMMENT_MAX_LENGTH = 500;
const REPORT_REASON_MAX_LENGTH = 120;

@Injectable()
export class CommunityService {
  /**
   * CommunityService에서 사용할 CommunityRepository 의존성을 주입한다.
   *
   * @param communityRepository 커뮤니티 저장소
   */
  constructor(
    private readonly communityRepository: CommunityRepository,
    @Optional() private readonly notificationService?: NotificationService,
  ) {}

  /**
   * 커뮤니티 게시글 목록을 조회한다.
   *
   * @returns 게시글 목록
   */
  async posts(): Promise<CommunityPostPayload[]> {
    const result = await this.communityRepository.posts();

    return result.map(rowToPost);
  }

  /**
   * 커뮤니티 댓글 목록을 조회한다.
   *
   * @param postId 게시글 ID
   * @returns 댓글 목록
   */
  async comments(postId: string): Promise<CommunityCommentPayload[]> {
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    const result = await this.communityRepository.comments(postId);

    return result.map(rowToComment);
  }

  /**
   * 사용자의 커뮤니티 프로필을 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 커뮤니티 프로필
   */
  async profile(userId: string): Promise<CommunityProfilePayload> {
    validateUuid(userId, "USER_ID_INVALID");
    return { name: (await this.communityRepository.findProfile(userId))?.name ?? DEFAULT_COMMUNITY_NAME };
  }

  /**
   * 사용자의 커뮤니티 프로필 이름을 변경한다.
   *
   * @param userId 사용자 ID
   * @param name 커뮤니티 이름
   * @returns 변경된 커뮤니티 프로필
   */
  async updateProfile(userId: string, name: string): Promise<CommunityProfilePayload> {
    validateUuid(userId, "USER_ID_INVALID");
    return this.communityRepository.upsertProfile({
      userId,
      name: validateText(name, COMMUNITY_NAME_MAX_LENGTH, "COMMUNITY_PROFILE_NAME"),
    });
  }

  /**
   * 커뮤니티 게시글을 생성한다.
   *
   * @param userId 작성자 ID
   * @param input 게시글 작성 입력값
   * @returns 생성된 게시글
   */
  async createPost(userId: string, input: { title: string; body: string }): Promise<CommunityPostPayload> {
    validateUuid(userId, "USER_ID_INVALID");
    const authorName = await this.authorName(userId);
    const post = await this.communityRepository.createPost({
      userId,
      title: validateText(input.title, TITLE_MAX_LENGTH, "COMMUNITY_TITLE"),
      body: validateText(input.body, BODY_MAX_LENGTH, "COMMUNITY_BODY"),
    });

    return rowToPost({ ...post, authorName, id: post.id, commentCount: "0" });
  }

  /**
   * 커뮤니티 댓글을 생성한다.
   *
   * @param userId 작성자 ID
   * @param postId 게시글 ID
   * @param body 댓글 본문
   * @returns 생성된 댓글
   */
  async createComment(userId: string, postId: string, body: string): Promise<CommunityCommentPayload> {
    validateUuid(userId, "USER_ID_INVALID");
    validateUuid(postId, "COMMUNITY_POST_ID_INVALID");
    const post = await this.communityRepository.findPost(postId);
    if (!post) throw new Error("COMMUNITY_POST_NOT_FOUND");
    const authorName = await this.authorName(userId);
    const comment = await this.communityRepository.createComment({
      userId,
      postId,
      body: validateText(body, COMMENT_MAX_LENGTH, "COMMUNITY_COMMENT"),
    });
    if (this.notificationService && post.authorUserId !== userId) {
      await this.notificationService.notify({
        userId: post.authorUserId,
        type: "comment",
        title: "새 댓글이 달렸어요",
        body: "내 글에 남긴 댓글을 확인해 보세요.",
        route: `/community/${postId}`,
        sourceId: comment.id,
      });
    }
    return rowToComment({ ...comment, authorName });
  }

  /**
   * 커뮤니티 게시글을 신고한다.
   *
   * @param userId 신고자 ID
   * @param postId 신고 대상 게시글 ID
   * @param reason 신고 사유
   * @returns 처리 성공 여부
   */
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

  /**
   * 사용자 커뮤니티 이름을 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 커뮤니티 이름
   */
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
