import { describe, expect, it, jest } from "@jest/globals";
import { SubscriptionRepository } from "./subscription.repository";
import { SubscriptionService } from "./subscription.service";

describe("SubscriptionService", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";

  it("defaults current subscription to free", async () => {
    const repository = {
      findCurrent: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
    } as unknown as SubscriptionRepository;
    const service = new SubscriptionService(repository);

    await expect(service.current(userId)).resolves.toEqual({ planId: "free" });
  });

  it("blocks unread summaries for unsupported plans", () => {
    const service = new SubscriptionService({} as SubscriptionRepository);

    expect(service.unreadMessageSummary({ planId: "basic", unreadTexts: ["a".repeat(40)], enabled: true })).toEqual({
      available: false,
      reason: "SUMMARY_PLAN_REQUIRED",
      sourceText: "",
    });
  });
});
