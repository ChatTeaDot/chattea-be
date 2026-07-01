const SUMMARY_MIN_LENGTH = 30;
const SUMMARY_MAX_SOURCE_LENGTH = 180;
const SUMMARY_PLAN_IDS = new Set(["gold", "black"]);

export type AiSummaryPreview = {
  available: boolean;
  reason: string | null;
  sourceText: string;
  summary: string | null;
};

export function buildUnreadMessageSummary(input: {
  planId: string;
  unreadTexts: string[];
  enabled: boolean;
}): AiSummaryPreview {
  if (!input.enabled) {
    return unavailable("SUMMARY_DISABLED");
  }

  if (!SUMMARY_PLAN_IDS.has(input.planId.toLowerCase())) {
    return unavailable("SUMMARY_PLAN_REQUIRED");
  }

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
    reason: null,
    sourceText,
    summary: `최근 안읽은 대화 요약: ${sourceText}`,
  };
}

function unavailable(reason: string): AiSummaryPreview {
  return {
    available: false,
    reason,
    sourceText: "",
    summary: null,
  };
}
