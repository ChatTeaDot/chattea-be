import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { MatchingService } from "./matching.service";
import {
  BoostPayload,
  LikeUserPayload,
  MatchCandidatePayload,
  RateScoreInput,
  ScoreSummaryPayload,
  UndoMatchActionPayload,
} from "./matching.types";

@Resolver()
export class MatchingResolver {
  constructor(private readonly matchingService: MatchingService) {}

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [MatchCandidatePayload])
  matchCandidates(@Context("req") req: AuthRequest) {
    return this.matchingService.candidates(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [MatchCandidatePayload])
  blackMatchCandidates(@Context("req") req: AuthRequest) {
    return this.matchingService.blackCandidates(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [MatchCandidatePayload])
  likedMeCandidates(@Context("req") req: AuthRequest) {
    return this.matchingService.likedMeCandidates(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => LikeUserPayload)
  likeUser(@Context("req") req: AuthRequest, @Args("userId") userId: string) {
    return this.matchingService.likeUser(req.user.userId, userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  skipMatchCandidate(@Context("req") req: AuthRequest, @Args("userId") userId: string) {
    return this.matchingService.skipCandidate(req.user.userId, userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => LikeUserPayload)
  superLikeUser(@Context("req") req: AuthRequest, @Args("userId") userId: string) {
    return this.matchingService.superLikeUser(req.user.userId, userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => UndoMatchActionPayload)
  undoLastMatchAction(@Context("req") req: AuthRequest) {
    return this.matchingService.undoLastAction(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => BoostPayload)
  activateBoost(@Context("req") req: AuthRequest) {
    return this.matchingService.activateBoost(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => ScoreSummaryPayload)
  scoreSummary(@Args("userId") userId: string) {
    return this.matchingService.scoreSummary(userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => ScoreSummaryPayload)
  rateScore(@Context("req") req: AuthRequest, @Args("input") input: RateScoreInput) {
    return this.matchingService.rateScore(req.user.userId, input.userId, input.score);
  }
}
