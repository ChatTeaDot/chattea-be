import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { CommunityService } from "./community.service";
import {
  CommunityCommentPayload,
  CommunityPostPayload,
  CreateCommunityCommentInput,
  CreateCommunityPostInput,
  ReportCommunityPostInput,
} from "./community.types";

@Resolver()
export class CommunityResolver {
  /**
   * CommunityResolver에서 사용할 CommunityService 의존성을 주입한다.
   *
   * @param communityService 커뮤니티 서비스
   */
  constructor(private readonly communityService: CommunityService) {}

  /**
   * 커뮤니티 게시글 목록을 조회한다.
   *
   * @returns 게시글 목록
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [CommunityPostPayload])
  communityPosts() {
    return this.communityService.posts();
  }

  /**
   * 커뮤니티 댓글 목록을 조회한다.
   *
   * @param postId 게시글 ID
   * @returns 댓글 목록
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [CommunityCommentPayload])
  communityComments(@Args("postId") postId: string) {
    return this.communityService.comments(postId);
  }

  /**
   * 커뮤니티 게시글을 생성한다.
   *
   * @param req 인증 요청 객체
   * @param input 게시글 작성 입력값
   * @returns 생성된 게시글
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => CommunityPostPayload)
  createCommunityPost(@Context("req") req: AuthRequest, @Args("input") input: CreateCommunityPostInput) {
    return this.communityService.createPost(req.user.userId, input);
  }

  /**
   * 커뮤니티 댓글을 생성한다.
   *
   * @param req 인증 요청 객체
   * @param input 댓글 작성 입력값
   * @returns 생성된 댓글
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => CommunityCommentPayload)
  createCommunityComment(@Context("req") req: AuthRequest, @Args("input") input: CreateCommunityCommentInput) {
    return this.communityService.createComment(req.user.userId, input.postId, input.body);
  }

  /**
   * 커뮤니티 게시글을 신고한다.
   *
   * @param req 인증 요청 객체
   * @param input 게시글 신고 입력값
   * @returns 처리 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  reportCommunityPost(@Context("req") req: AuthRequest, @Args("input") input: ReportCommunityPostInput) {
    return this.communityService.reportPost(req.user.userId, input.postId, input.reason);
  }
}
