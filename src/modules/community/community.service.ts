import { Injectable } from "@nestjs/common";
import { CommunityRepository } from "./community.repository";
import { CommunityCommentPayload, CommunityPostPayload } from "./community.types";

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
  constructor(private readonly communityRepository: CommunityRepository) {}

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
   * 커뮤니티 게시글을 생성한다.
   *
   * @param userId 작성자 ID
   * @param input 게시글 작성 입력값
   * @returns 생성된 게시글
   */
  async createPost(userId: string, input: { title: string; body: string }): Promise<CommunityPostPayload> {
    validateUuid(userId, "USER_ID_INVALID");
    const post = await this.communityRepository.createPost({
      userId,
      title: validateText(input.title, TITLE_MAX_LENGTH, "COMMUNITY_TITLE"),
      body: validateText(input.body, BODY_MAX_LENGTH, "COMMUNITY_BODY"),
    });

    return rowToPost({ ...post, id: post.id, commentCount: "0" });
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
    if (!(await this.communityRepository.findPost(postId))) throw new Error("COMMUNITY_POST_NOT_FOUND");
    const comment = await this.communityRepository.createComment({
      userId,
      postId,
      body: validateText(body, COMMENT_MAX_LENGTH, "COMMUNITY_COMMENT"),
    });
    return rowToComment(comment);
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
}

type PostRow = {
  id: string;
  anonymousName: string;
  title: string;
  body: string;
  commentCount: number | string;
  createdAt: Date;
};

type CommentRow = {
  id: string;
  postId: string;
  anonymousName: string;
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
  anonymousName: row.anonymousName,
  title: row.title,
  body: row.body,
  commentCount: Number(row.commentCount),
  createdAt: row.createdAt.toISOString(),
});

const rowToComment = (row: CommentRow): CommunityCommentPayload => ({
  id: row.id,
  postId: row.postId,
  anonymousName: row.anonymousName,
  body: row.body,
  createdAt: row.createdAt.toISOString(),
});
