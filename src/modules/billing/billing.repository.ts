import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  billingEvents,
  revenueCatTransactionLedger,
  revenueCatTransactions,
  userBoosts,
  userConsumableBalances,
  userSubscriptions,
} from "src/modules/database/schema";
import {
  ConsumableUnits,
  RevenueCatApplyResult,
  RevenueCatConsumableTransition,
  RevenueCatEventInput,
  RevenueCatTransactionState,
} from "./revenuecat.types";

const ZERO_DELTA: ConsumableUnits = { boostCredits: 0, superLikeCredits: 0 };

@Injectable()
export class BillingRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  applyRevenueCatEvent = async (input: RevenueCatEventInput): Promise<RevenueCatApplyResult> =>
    this.db.transaction(async (tx) => {
      const insertedEvents = await tx
        .insert(billingEvents)
        .values({ providerEventId: input.providerEventId, provider: "revenuecat", payloadHash: input.payloadHash })
        .onConflictDoNothing()
        .returning({ id: billingEvents.id });
      if (insertedEvents.length === 0) {
        const existingEvent = await tx.query.billingEvents.findFirst({
          where: eq(billingEvents.providerEventId, input.providerEventId),
        });
        if (
          !existingEvent ||
          existingEvent.provider !== "revenuecat" ||
          existingEvent.payloadHash !== input.payloadHash
        ) {
          throw new Error("REVENUECAT_EVENT_PAYLOAD_CONFLICT");
        }
        return { outcome: "duplicate", balanceDelta: ZERO_DELTA };
      }

      if ("subscription" in input) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:${input.userId}:revenuecat`}, 0))`,
        );
        const current = await tx.query.userSubscriptions.findFirst({
          where: and(eq(userSubscriptions.userId, input.userId), eq(userSubscriptions.provider, "revenuecat")),
        });
        if ((current?.providerEventTimestampMs ?? -1) >= input.subscription.eventTimestampMs) {
          return { outcome: "stale", balanceDelta: ZERO_DELTA };
        }

        const values = {
          userId: input.userId,
          planId: input.subscription.planId,
          status: input.subscription.status,
          provider: "revenuecat",
          providerCustomerId: input.subscription.providerCustomerId,
          providerProductId: input.subscription.providerProductId,
          providerEventTimestampMs: input.subscription.eventTimestampMs,
          currentPeriodStartsAt: input.subscription.startsAt,
          currentPeriodEndsAt: input.subscription.endsAt,
          updatedAt: new Date(),
        };
        if (current) await tx.update(userSubscriptions).set(values).where(eq(userSubscriptions.id, current.id));
        else await tx.insert(userSubscriptions).values(values);
        return { outcome: "applied", balanceDelta: ZERO_DELTA };
      }

      if ("consumableTransition" in input) {
        return applyConsumableTransition(tx, input.providerEventId, input.consumableTransition);
      }

      return { outcome: "applied", balanceDelta: ZERO_DELTA };
    });

  balance = async (userId: string) => {
    const [balance, activeBoost] = await Promise.all([
      this.db.query.userConsumableBalances.findFirst({ where: eq(userConsumableBalances.userId, userId) }),
      this.db.query.userBoosts.findFirst({
        columns: { endsAt: true },
        where: and(eq(userBoosts.userId, userId), gt(userBoosts.endsAt, new Date())),
        orderBy: desc(userBoosts.endsAt),
      }),
    ]);
    return { balance, activeBoostUntil: activeBoost?.endsAt };
  };
}

type BillingTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const applyConsumableTransition = async (
  tx: BillingTransaction,
  providerEventId: string,
  transition: RevenueCatConsumableTransition,
): Promise<RevenueCatApplyResult> => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing:revenuecat:${transition.providerTransactionId}`}, 0))`,
  );
  const [current] = await tx
    .select()
    .from(revenueCatTransactions)
    .where(
      and(
        eq(revenueCatTransactions.provider, "revenuecat"),
        eq(revenueCatTransactions.providerTransactionId, transition.providerTransactionId),
      ),
    )
    .for("update");

  if (current) assertTransactionIdentity(current, transition);
  if (
    current &&
    current.stateEventTimestampMs === transition.eventTimestampMs &&
    current.state !== transition.targetState
  ) {
    throw new Error("REVENUECAT_EVENT_TIMESTAMP_CONFLICT");
  }

  const stale = Boolean(current && current.stateEventTimestampMs >= transition.eventTimestampMs);
  const effectiveState = stale ? current?.state : transition.targetState;
  if (!effectiveState) throw new Error("REVENUECAT_TRANSACTION_STATE_INVALID");
  const balanceDelta = stale ? ZERO_DELTA : transitionDelta(current?.state, transition.targetState, transition.units);
  const now = new Date();

  let transactionId = current?.id;
  if (!current) {
    const [created] = await tx
      .insert(revenueCatTransactions)
      .values({
        provider: "revenuecat",
        providerTransactionId: transition.providerTransactionId,
        originalTransactionId: transition.originalTransactionId,
        userId: transition.userId,
        canonicalProductId: transition.canonicalProductId,
        providerProductId: transition.providerProductId,
        superLikeUnits: transition.units.superLikeCredits,
        boostUnits: transition.units.boostCredits,
        state: transition.targetState,
        stateEventTimestampMs: transition.eventTimestampMs,
      })
      .returning({ id: revenueCatTransactions.id });
    transactionId = created?.id;
  } else if (!stale) {
    await tx
      .update(revenueCatTransactions)
      .set({ state: transition.targetState, stateEventTimestampMs: transition.eventTimestampMs, updatedAt: now })
      .where(eq(revenueCatTransactions.id, current.id));
  }
  if (!transactionId) throw new Error("REVENUECAT_TRANSACTION_CREATE_FAILED");

  if (balanceDelta.superLikeCredits !== 0 || balanceDelta.boostCredits !== 0) {
    await tx
      .insert(userConsumableBalances)
      .values({
        userId: transition.userId,
        superLikeCredits: balanceDelta.superLikeCredits,
        boostCredits: balanceDelta.boostCredits,
      })
      .onConflictDoUpdate({
        target: userConsumableBalances.userId,
        set: {
          superLikeCredits: sql`${userConsumableBalances.superLikeCredits} + ${balanceDelta.superLikeCredits}`,
          boostCredits: sql`${userConsumableBalances.boostCredits} + ${balanceDelta.boostCredits}`,
          updatedAt: now,
        },
      });
  }

  await tx.insert(revenueCatTransactionLedger).values({
    providerEventId,
    revenuecatTransactionId: transactionId,
    eventTimestampMs: transition.eventTimestampMs,
    requestedState: transition.targetState,
    effectiveState,
    superLikeDelta: balanceDelta.superLikeCredits,
    boostDelta: balanceDelta.boostCredits,
    applied: !stale,
  });

  return { outcome: stale ? "stale" : "applied", effectiveState, balanceDelta };
};

const assertTransactionIdentity = (
  current: typeof revenueCatTransactions.$inferSelect,
  transition: RevenueCatConsumableTransition,
): void => {
  if (current.userId !== transition.userId) throw new Error("REVENUECAT_TRANSACTION_OWNER_CONFLICT");
  if (
    current.originalTransactionId !== transition.originalTransactionId ||
    current.canonicalProductId !== transition.canonicalProductId ||
    current.providerProductId !== transition.providerProductId
  ) {
    throw new Error("REVENUECAT_TRANSACTION_PRODUCT_CONFLICT");
  }
  if (
    current.superLikeUnits !== transition.units.superLikeCredits ||
    current.boostUnits !== transition.units.boostCredits
  ) {
    throw new Error("REVENUECAT_TRANSACTION_UNITS_CONFLICT");
  }
};

const transitionDelta = (
  currentState: RevenueCatTransactionState | undefined,
  targetState: RevenueCatTransactionState,
  units: ConsumableUnits,
): ConsumableUnits => {
  if (currentState === targetState) return ZERO_DELTA;
  if (targetState === "granted") return units;
  if (currentState === "granted") {
    return {
      boostCredits: units.boostCredits === 0 ? 0 : -units.boostCredits,
      superLikeCredits: units.superLikeCredits === 0 ? 0 : -units.superLikeCredits,
    };
  }
  return ZERO_DELTA;
};
