import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { ScoreService } from "./score.service";
import { RateScoreInput, ScoreSummaryPayload } from "./score.types";

@Resolver()
export class ScoreResolver {
  constructor(private readonly scoreService: ScoreService) {}

  /**
   * 점수 요약을 조회한다.
   *
   * @param userId 채점 대상 사용자 ID
   * @returns 점수 요약
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => ScoreSummaryPayload)
  scoreSummary(@Args("userId") userId: string) {
    return this.scoreService.summary(userId);
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
    return this.scoreService.rateScore(req.user.userId, input.userId, input.score);
  }
}
