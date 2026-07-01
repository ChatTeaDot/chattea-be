import { describe, expect, it } from "vitest";
import { buildUnreadMessageSummary } from "../src/modules/subscription/ai-summary.service.js";

describe("AI summary rules", () => {
  it("gates unread summaries to enabled Gold or Black plans and 30+ chars", () => {
    expect(
      buildUnreadMessageSummary({
        planId: "free",
        unreadTexts: ["안읽은 메시지가 충분히 길어도 무료 플랜은 사용할 수 없음"],
        enabled: true,
      }),
    ).toMatchObject({ available: false, reason: "SUMMARY_PLAN_REQUIRED" });

    expect(
      buildUnreadMessageSummary({
        planId: "gold",
        unreadTexts: ["짧음"],
        enabled: true,
      }),
    ).toMatchObject({ available: false, reason: "SUMMARY_TEXT_TOO_SHORT" });

    expect(
      buildUnreadMessageSummary({
        planId: "gold",
        unreadTexts: ["오늘 대화가 길어져서 안읽은 메시지 요약을 보여줄 수 있습니다."],
        enabled: true,
      }),
    ).toMatchObject({ available: true, reason: null });
  });

  it("uses only the latest 180 unread characters", () => {
    const result = buildUnreadMessageSummary({
      planId: "black",
      unreadTexts: ["a".repeat(200)],
      enabled: true,
    });

    expect(result.sourceText).toHaveLength(180);
    expect(result.summary).toContain(result.sourceText);
  });
});
