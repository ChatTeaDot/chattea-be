import { describe, expect, it } from "vitest";
import { subscriptionPlans } from "../src/modules/subscription/plan-catalog.service.js";

describe("subscription plan catalog", () => {
  it("keeps documented plan names and monthly prices", () => {
    expect(subscriptionPlans.map((plan) => [plan.id, plan.monthlyPriceKrw])).toEqual([
      ["free", 0],
      ["basic", 4900],
      ["gold", 9900],
      ["black", 24900],
    ]);
  });
});
