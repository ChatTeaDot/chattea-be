import type { Pool } from "pg";

export type CurrentSubscription = {
  planId: string;
};

export class SubscriptionService {
  private readonly plans = new Map<string, string>();

  getCurrentSubscription(userId: string): CurrentSubscription {
    return { planId: this.plans.get(userId) ?? "free" };
  }

  setCurrentPlanForTest(userId: string, planId: string): void {
    this.plans.set(userId, planId);
  }
}

export class PostgresSubscriptionService {
  constructor(private readonly pool: Pool) {}

  async getCurrentSubscription(userId: string): Promise<CurrentSubscription> {
    validateUuid(userId);
    const result = await this.pool.query<{ plan_id: string }>(
      `
        SELECT plan_id
        FROM user_subscriptions
        WHERE user_id = $1
          AND status = 'active'
          AND (current_period_ends_at IS NULL OR current_period_ends_at > now())
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [userId],
    );

    return { planId: result.rows[0]?.plan_id ?? "free" };
  }
}

function validateUuid(input: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("USER_ID_INVALID");
  }
}
