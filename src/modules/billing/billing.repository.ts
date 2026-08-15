import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { billingEvents, userConsumableBalances, userSubscriptions } from "src/modules/database/schema";

@Injectable()
export class BillingRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async applyRevenueCatEvent(input: {
    providerEventId: string;
    payloadHash: string;
    userId: string;
    subscription?: {
      planId: string;
      providerCustomerId?: string;
      providerProductId: string;
      startsAt?: Date;
      endsAt?: Date;
      status: "active" | "expired";
    };
    consumable?: { superLikes: number; boosts: number };
  }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const events = await tx
        .insert(billingEvents)
        .values({ providerEventId: input.providerEventId, provider: "revenuecat", payloadHash: input.payloadHash })
        .onConflictDoNothing()
        .returning({ id: billingEvents.id });
      if (events.length === 0) return false;

      if (input.subscription) {
        if (input.subscription.status === "active") {
          await tx
            .update(userSubscriptions)
            .set({ status: "expired", updatedAt: new Date() })
            .where(and(eq(userSubscriptions.userId, input.userId), eq(userSubscriptions.status, "active")));
        }
        await tx.insert(userSubscriptions).values({
          userId: input.userId,
          planId: input.subscription.planId,
          status: input.subscription.status,
          provider: "revenuecat",
          providerCustomerId: input.subscription.providerCustomerId,
          providerProductId: input.subscription.providerProductId,
          currentPeriodStartsAt: input.subscription.startsAt,
          currentPeriodEndsAt: input.subscription.endsAt,
        });
      }

      if (input.consumable) {
        await tx
          .insert(userConsumableBalances)
          .values({
            userId: input.userId,
            superLikeCredits: input.consumable.superLikes,
            boostCredits: input.consumable.boosts,
          })
          .onConflictDoUpdate({
            target: userConsumableBalances.userId,
            set: {
              superLikeCredits: sql`${userConsumableBalances.superLikeCredits} + ${input.consumable.superLikes}`,
              boostCredits: sql`${userConsumableBalances.boostCredits} + ${input.consumable.boosts}`,
              updatedAt: new Date(),
            },
          });
      }
      return true;
    });
  }

  async balance(userId: string) {
    return this.db.query.userConsumableBalances.findFirst({
      where: eq(userConsumableBalances.userId, userId),
    });
  }
}
