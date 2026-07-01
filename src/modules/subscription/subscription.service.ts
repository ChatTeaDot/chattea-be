import { dbQuery, sql, type Database } from "../../db/client.js";

export type CurrentSubscription = {
  planId: string;
};

export class SubscriptionService {
  constructor(private readonly db: Database) {}

  async getCurrentSubscription(userId: string): Promise<CurrentSubscription> {
    validateUuid(userId);
    const result = await dbQuery<{ plan_id: string }>(
      this.db,
      sql`
        SELECT plan_id
        FROM user_subscriptions
        WHERE user_id = ${userId}
          AND status = 'active'
          AND (current_period_ends_at IS NULL OR current_period_ends_at > now())
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );

    return { planId: result.rows[0]?.plan_id ?? "free" };
  }
}

function validateUuid(input: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("USER_ID_INVALID");
  }
}
