import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { CommunityService } from "./community.service";
import {
  CommunityCommentPayload,
  CommunityPostPayload,
  CreateCommunityCommentInput,
  CreateCommunityPostInput,
  ReportCommunityCommentInput,
  ReportCommunityPostInput,
} from "./community.types";

@Resolver()
export class CommunityResolver {
  constructor(private readonly communityService: CommunityService) {}

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [CommunityPostPayload])
  communityPosts() {
    return this.communityService.posts();
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [CommunityCommentPayload])
  communityComments(@Args("postId") postId: string) {
    return this.communityService.comments(postId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => CommunityPostPayload)
  createCommunityPost(@Context("req") req: AuthRequest, @Args("input") input: CreateCommunityPostInput) {
    return this.communityService.createPost(req.user.userId, input);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => CommunityCommentPayload)
  createCommunityComment(@Context("req") req: AuthRequest, @Args("input") input: CreateCommunityCommentInput) {
    return this.communityService.createComment(req.user.userId, input.postId, input.body, input.idempotencyKey);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  reportCommunityPost(@Context("req") req: AuthRequest, @Args("input") input: ReportCommunityPostInput) {
    return this.communityService.reportPost(req.user.userId, input.postId, input.reason);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  reportCommunityComment(@Context("req") req: AuthRequest, @Args("input") input: ReportCommunityCommentInput) {
    return this.communityService.reportComment(req.user.userId, input.commentId, input.reason);
  }
}
