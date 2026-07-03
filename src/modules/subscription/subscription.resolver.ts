import { Args, Context, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { SubscriptionService } from "./subscription.service";
import {
  AiSummaryPreviewPayload,
  CurrentSubscriptionPayload,
  SubscriptionPlanPayload,
  UnreadMessageSummaryInput,
} from "./subscription.types";

@Resolver()
export class SubscriptionResolver {
  /**
   * SubscriptionResolver에서 사용할 SubscriptionService 의존성을 주입한다.
   *
   * @param subscriptionService 구독 서비스
   */
  constructor(private readonly subscriptionService: SubscriptionService) {}

  /**
   * 구독 플랜 목록을 조회한다.
   *
   * @returns 구독 플랜 목록
   */
  @Query(() => [SubscriptionPlanPayload])
  subscriptionPlans() {
    return this.subscriptionService.plans();
  }

  /**
   * 현재 사용자의 구독 상태를 조회한다.
   *
   * @param req 인증 요청 객체
   * @returns 현재 구독 상태
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => CurrentSubscriptionPayload)
  currentSubscription(@Context("req") req: AuthRequest) {
    return this.subscriptionService.current(req.user.userId);
  }

  /**
   * 안읽은 메시지 요약 미리보기를 조회한다.
   *
   * @param input 요약 미리보기 입력값
   * @returns AI 요약 미리보기
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => AiSummaryPreviewPayload)
  unreadMessageSummary(@Args("input") input: UnreadMessageSummaryInput) {
    return this.subscriptionService.unreadMessageSummary(input);
  }
}
