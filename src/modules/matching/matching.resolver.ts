import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { MatchingService } from "./matching.service";
import { LikeUserPayload, MatchCandidatePayload, RateScoreInput, ScoreSummaryPayload } from "./matching.types";

@Resolver()
export class MatchingResolver {
  /**
   * MatchingResolver에서 사용할 서비스 의존성을 주입한다.
   *
   * @param matchingService 매칭 서비스
   */
  constructor(private readonly matchingService: MatchingService) {}

  /**
   * 현재 사용자의 매칭 후보 목록을 조회한다.
   *
   * @param req 인증 요청 객체
   * @returns 매칭 후보 목록
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [MatchCandidatePayload])
  matchCandidates(@Context("req") req: AuthRequest) {
    return this.matchingService.candidates(req.user.userId);
  }

  /**
   * 현재 사용자의 Black 전용 후보 목록을 조회한다.
   *
   * @param req 인증 요청 객체
   * @returns Black 후보 목록
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [MatchCandidatePayload])
  async blackMatchCandidates(@Context("req") req: AuthRequest) {
    return this.matchingService.blackCandidates(req.user.userId);
  }

  /**
   * 현재 사용자를 좋아한 후보 목록을 조회한다.
   *
   * @param req 인증 요청 객체
   * @returns 나를 좋아한 후보 목록
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [MatchCandidatePayload])
  async likedMeCandidates(@Context("req") req: AuthRequest) {
    return this.matchingService.likedMeCandidates(req.user.userId);
  }

  /**
   * 대상 사용자에게 좋아요를 보낸다.
   *
   * @param req 인증 요청 객체
   * @param userId 좋아요 대상 사용자 ID
   * @returns 매칭 결과
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => LikeUserPayload)
  async likeUser(@Context("req") req: AuthRequest, @Args("userId") userId: string) {
    return this.matchingService.likeUser(req.user.userId, userId);
  }

  /**
   * 점수 요약을 조회한다.
   *
   * @param userId 채점 대상 사용자 ID
   * @returns 점수 요약
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => ScoreSummaryPayload)
  scoreSummary(@Args("userId") userId: string) {
    return this.matchingService.scoreSummary(userId);
  }

  /**
   * 점수를 등록하거나 갱신한다.
   *
   * @param req 인증 요청 객체
   * @param input 점수 입력값
   * @returns 점수 요약
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => ScoreSummaryPayload)
  rateScore(@Context("req") req: AuthRequest, @Args("input") input: RateScoreInput) {
    return this.matchingService.rateScore(req.user.userId, input.userId, input.score);
  }
}
