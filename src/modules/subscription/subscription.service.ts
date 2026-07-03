import { Injectable } from "@nestjs/common";
import { SubscriptionRepository } from "./subscription.repository";
import { AiSummaryPreviewPayload, CurrentSubscriptionPayload, SubscriptionPlanPayload } from "./subscription.types";

const SUMMARY_MIN_LENGTH = 30;
const SUMMARY_MAX_SOURCE_LENGTH = 180;
const SUMMARY_PLAN_IDS = new Set(["gold", "black"]);

const plans: SubscriptionPlanPayload[] = [
  {
    id: "free",
    name: "Free",
    monthlyPriceKrw: 0,
    benefits: ["기본 매칭", "하루 좋아요 10회 제한", "기본 필터", "나를 좋아했는지 일부 공개"],
  },
  {
    id: "basic",
    name: "Basic",
    monthlyPriceKrw: 4900,
    benefits: ["하루 좋아요 20회", "되돌리기", "광고 제거", "나를 좋아한 사람 보기: 3시간마다 3개", "약한 부스트"],
  },
  {
    id: "gold",
    name: "Gold",
    monthlyPriceKrw: 9900,
    benefits: ["고급 필터", "우선 추천", "프로필 조회 확장", "프로필 AI 요약", "안읽은 메시지 AI 요약"],
  },
  {
    id: "black",
    name: "Black",
    monthlyPriceKrw: 24900,
    benefits: ["하루 좋아요 무제한", "Black 전용 추천", "Black끼리 우선 매칭", "강한 부스트", "고급 인증 배지", "읽음 확인"],
  },
];

@Injectable()
export class SubscriptionService {
  /**
   * SubscriptionService에서 사용할 SubscriptionRepository 의존성을 주입한다.
   *
   * @param subscriptionRepository 구독 저장소
   */
  constructor(private readonly subscriptionRepository: SubscriptionRepository) {}

  /**
   * 구독 플랜 카탈로그를 조회한다.
   *
   * @returns 구독 플랜 목록
   */
  plans(): SubscriptionPlanPayload[] {
    return plans;
  }

  /**
   * 사용자의 현재 구독 상태를 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 현재 구독 상태
   */
  async current(userId: string): Promise<CurrentSubscriptionPayload> {
    validateUuid(userId);
    return { planId: (await this.subscriptionRepository.findCurrent(userId))?.planId ?? "free" };
  }

  /**
   * 안읽은 메시지 요약 미리보기를 생성한다.
   *
   * @param input 플랜 ID, 안읽은 메시지 목록, 활성화 여부
   * @returns AI 요약 미리보기
   */
  unreadMessageSummary(input: { planId: string; unreadTexts: string[]; enabled: boolean }): AiSummaryPreviewPayload {
    if (!input.enabled) return unavailable("SUMMARY_DISABLED");
    if (!SUMMARY_PLAN_IDS.has(input.planId.toLowerCase())) return unavailable("SUMMARY_PLAN_REQUIRED");

    const sourceText = input.unreadTexts
      .map((text) => text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(-SUMMARY_MAX_SOURCE_LENGTH);

    if (sourceText.length < SUMMARY_MIN_LENGTH) {
      return { ...unavailable("SUMMARY_TEXT_TOO_SHORT"), sourceText };
    }

    return {
      available: true,
      sourceText,
      summary: `최근 안읽은 대화 요약: ${sourceText}`,
    };
  }
}

const validateUuid = (input: string): void => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("USER_ID_INVALID");
  }
};

const unavailable = (reason: string): AiSummaryPreviewPayload => ({
  available: false,
  reason,
  sourceText: "",
});
