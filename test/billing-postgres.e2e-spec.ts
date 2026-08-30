import { randomUUID } from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "src/modules/database/schema";
import { BillingRepository } from "src/modules/billing/billing.repository";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

describePostgres("Billing PostgreSQL ordering", () => {
  const namespace = randomUUID().replaceAll("-", "").slice(0, 8);
  const userId = randomUUID();
  const otherUserId = randomUUID();
  let pool: Pool;
  let repository: BillingRepository;

  const applySubscription = (event: string, eventTimestampMs: number, status: "active" | "expired", planId: string) =>
    repository.applyRevenueCatEvent({
      providerEventId: `${namespace}-${event}`,
      payloadHash: `${namespace}-${event}-hash`,
      userId,
      subscription: {
        planId,
        providerCustomerId: `${namespace}-transaction`,
        providerProductId: `chattea_${planId}_monthly`,
        eventTimestampMs,
        startsAt: new Date(eventTimestampMs - 1_000),
        endsAt: new Date(eventTimestampMs + 86_400_000),
        status,
      },
    });

  const applyConsumable = (input: {
    event: string;
    eventTimestampMs: number;
    providerTransactionId: string;
    targetState: "granted" | "refunded";
    userId?: string;
    canonicalProductId?: string;
    providerProductId?: string;
    superLikeCredits?: number;
    boostCredits?: number;
    payloadHash?: string;
  }) =>
    repository.applyRevenueCatEvent({
      providerEventId: `${namespace}-${input.event}`,
      payloadHash: input.payloadHash ?? `${namespace}-${input.event}-hash`,
      consumableTransition: {
        providerTransactionId: `${namespace}-${input.providerTransactionId}`,
        originalTransactionId: `${namespace}-${input.providerTransactionId}-original`,
        userId: input.userId ?? userId,
        canonicalProductId: input.canonicalProductId ?? "chattea_superlikes_5",
        providerProductId: input.providerProductId ?? "chattea_superlikes_5",
        eventTimestampMs: input.eventTimestampMs,
        targetState: input.targetState,
        units: {
          superLikeCredits: input.superLikeCredits ?? 5,
          boostCredits: input.boostCredits ?? 0,
        },
      },
    });

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
      max: 8,
    });
    repository = new BillingRepository(drizzle(pool, { schema }));
    await pool.query('INSERT INTO users ("userId", email, password, "userName", gender) VALUES ($1,$2,$3,$4,$5)', [
      userId,
      `${namespace}@example.test`,
      "hash",
      "billing-user",
      "female",
    ]);
    await pool.query('INSERT INTO users ("userId", email, password, "userName", gender) VALUES ($1,$2,$3,$4,$5)', [
      otherUserId,
      `${namespace}-other@example.test`,
      "hash",
      "billing-other-user",
      "female",
    ]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM user_boosts WHERE "userId" = $1', [userId]);
    await pool.query('DELETE FROM revenuecat_transaction_ledger WHERE "providerEventId" LIKE $1', [`${namespace}-%`]);
    await pool.query('DELETE FROM revenuecat_transactions WHERE "providerTransactionId" LIKE $1', [`${namespace}-%`]);
    await pool.query('DELETE FROM user_consumable_balances WHERE "userId" = ANY($1::uuid[])', [[userId, otherUserId]]);
    await pool.query('DELETE FROM user_subscriptions WHERE "userId" = $1', [userId]);
    await pool.query('DELETE FROM billing_events WHERE "providerEventId" LIKE $1', [`${namespace}-%`]);
    await pool.query('DELETE FROM users WHERE "userId" = ANY($1::uuid[])', [[userId, otherUserId]]);
    await pool.end();
  });

  it("returns the latest active boost and ignores expired boosts", async () => {
    const now = Date.now();
    const expiredAt = new Date(now - 60_000);
    const firstActiveAt = new Date(now + 60_000);
    const latestActiveAt = new Date(now + 120_000);
    await pool.query(
      'INSERT INTO user_boosts ("userId", source, "startsAt", "endsAt") VALUES ($1,$2,$3,$4),($1,$2,$3,$5),($1,$2,$3,$6)',
      [
        userId,
        "billing-balance-test",
        new Date(now - 120_000).toISOString(),
        expiredAt.toISOString(),
        firstActiveAt.toISOString(),
        latestActiveAt.toISOString(),
      ],
    );

    const result = await repository.balance(userId);

    expect(result.activeBoostUntil).toEqual(latestActiveAt);
  });

  it("ignores an older event and applies only a newer expiration", async () => {
    await expect(applySubscription("renewal-new", 2_000, "active", "gold")).resolves.toEqual(
      expect.objectContaining({ outcome: "applied" }),
    );
    await expect(applySubscription("renewal-old", 1_000, "active", "basic")).resolves.toEqual(
      expect.objectContaining({ outcome: "stale" }),
    );

    const active = await pool.query<{
      planId: string;
      status: string;
      providerEventTimestampMs: string;
    }>(
      'SELECT "planId", status, "providerEventTimestampMs" FROM user_subscriptions WHERE "userId" = $1 AND provider = $2',
      [userId, "revenuecat"],
    );
    expect(active.rows).toEqual([{ planId: "gold", status: "active", providerEventTimestampMs: "2000" }]);

    await expect(applySubscription("expiration-new", 3_000, "expired", "gold")).resolves.toEqual(
      expect.objectContaining({ outcome: "applied" }),
    );
    const expired = await pool.query<{ status: string; providerEventTimestampMs: string }>(
      'SELECT status, "providerEventTimestampMs" FROM user_subscriptions WHERE "userId" = $1 AND provider = $2',
      [userId, "revenuecat"],
    );
    expect(expired.rows).toEqual([{ status: "expired", providerEventTimestampMs: "3000" }]);
  });

  it("serializes distinct concurrent events and keeps the newest state", async () => {
    const results = await Promise.all([
      applySubscription("concurrent-old", 4_000, "active", "basic"),
      applySubscription("concurrent-new", 5_000, "active", "black"),
    ]);
    expect(results.map(({ outcome }) => outcome)).toContain("applied");

    const subscriptions = await pool.query<{
      planId: string;
      status: string;
      providerEventTimestampMs: string;
    }>(
      'SELECT "planId", status, "providerEventTimestampMs" FROM user_subscriptions WHERE "userId" = $1 AND provider = $2',
      [userId, "revenuecat"],
    );
    expect(subscriptions.rows).toEqual([{ planId: "black", status: "active", providerEventTimestampMs: "5000" }]);
  });

  it("applies purchase, refund debt, debt repayment, and refund reversal exactly once", async () => {
    const purchase = {
      event: "credits-purchase",
      eventTimestampMs: 10_000,
      providerTransactionId: "credits-transaction",
      targetState: "granted" as const,
    };
    await expect(applyConsumable(purchase)).resolves.toEqual(
      expect.objectContaining({ outcome: "applied", balanceDelta: { boostCredits: 0, superLikeCredits: 5 } }),
    );
    await expect(applyConsumable(purchase)).resolves.toEqual(expect.objectContaining({ outcome: "duplicate" }));
    await pool.query('UPDATE user_consumable_balances SET "superLikeCredits" = 0 WHERE "userId" = $1', [userId]);

    const refund = {
      event: "credits-refund",
      eventTimestampMs: 11_000,
      providerTransactionId: "credits-transaction",
      targetState: "refunded" as const,
    };
    await expect(applyConsumable(refund)).resolves.toEqual(
      expect.objectContaining({ balanceDelta: { boostCredits: 0, superLikeCredits: -5 } }),
    );
    await expect(applyConsumable(refund)).resolves.toEqual(expect.objectContaining({ outcome: "duplicate" }));

    await applyConsumable({
      event: "debt-repayment-purchase",
      eventTimestampMs: 12_000,
      providerTransactionId: "debt-repayment-transaction",
      targetState: "granted",
    });
    const repaid = await pool.query<{ superLikeCredits: number }>(
      'SELECT "superLikeCredits" FROM user_consumable_balances WHERE "userId" = $1',
      [userId],
    );
    expect(repaid.rows).toEqual([{ superLikeCredits: 0 }]);

    await expect(
      applyConsumable({
        event: "credits-refund-reversed",
        eventTimestampMs: 13_000,
        providerTransactionId: "credits-transaction",
        targetState: "granted",
      }),
    ).resolves.toEqual(expect.objectContaining({ balanceDelta: { boostCredits: 0, superLikeCredits: 5 } }));
    const restored = await pool.query<{ superLikeCredits: number }>(
      'SELECT "superLikeCredits" FROM user_consumable_balances WHERE "userId" = $1',
      [userId],
    );
    expect(restored.rows).toEqual([{ superLikeCredits: 5 }]);
  });

  it("records stale transitions and rejects conflicting states at the same timestamp", async () => {
    await applyConsumable({
      event: "ordering-refund",
      eventTimestampMs: 20_000,
      providerTransactionId: "ordering-transaction",
      targetState: "refunded",
    });
    await expect(
      applyConsumable({
        event: "ordering-stale-purchase",
        eventTimestampMs: 19_000,
        providerTransactionId: "ordering-transaction",
        targetState: "granted",
      }),
    ).resolves.toEqual(expect.objectContaining({ outcome: "stale" }));
    await expect(
      applyConsumable({
        event: "ordering-conflict",
        eventTimestampMs: 20_000,
        providerTransactionId: "ordering-transaction",
        targetState: "granted",
      }),
    ).rejects.toThrow("REVENUECAT_EVENT_TIMESTAMP_CONFLICT");

    const ledger = await pool.query<{ applied: boolean; effectiveState: string; superLikeDelta: number }>(
      `SELECT applied, "effectiveState", "superLikeDelta"
       FROM revenuecat_transaction_ledger
       WHERE "providerEventId" = $1`,
      [`${namespace}-ordering-stale-purchase`],
    );
    expect(ledger.rows).toEqual([{ applied: false, effectiveState: "refunded", superLikeDelta: 0 }]);
  });

  it("rejects owner, product, unit, and event-payload identity conflicts", async () => {
    await applyConsumable({
      event: "identity-purchase",
      eventTimestampMs: 30_000,
      providerTransactionId: "identity-transaction",
      targetState: "granted",
    });
    await expect(
      applyConsumable({
        event: "identity-owner",
        eventTimestampMs: 31_000,
        providerTransactionId: "identity-transaction",
        targetState: "refunded",
        userId: otherUserId,
      }),
    ).rejects.toThrow("REVENUECAT_TRANSACTION_OWNER_CONFLICT");
    await expect(
      applyConsumable({
        event: "identity-product",
        eventTimestampMs: 31_000,
        providerTransactionId: "identity-transaction",
        targetState: "refunded",
        canonicalProductId: "chattea_boost_30m",
        providerProductId: "chattea_boost_30m",
      }),
    ).rejects.toThrow("REVENUECAT_TRANSACTION_PRODUCT_CONFLICT");
    await expect(
      applyConsumable({
        event: "identity-units",
        eventTimestampMs: 31_000,
        providerTransactionId: "identity-transaction",
        targetState: "refunded",
        superLikeCredits: 10,
      }),
    ).rejects.toThrow("REVENUECAT_TRANSACTION_UNITS_CONFLICT");

    const event = {
      event: "payload-conflict",
      eventTimestampMs: 40_000,
      providerTransactionId: "payload-transaction",
      targetState: "granted" as const,
      payloadHash: "first-hash",
    };
    await applyConsumable(event);
    await expect(applyConsumable({ ...event, payloadHash: "different-hash" })).rejects.toThrow(
      "REVENUECAT_EVENT_PAYLOAD_CONFLICT",
    );
  });

  it("serializes concurrent consumable transitions and keeps the newest state", async () => {
    await Promise.all([
      applyConsumable({
        event: "concurrent-consumable-purchase",
        eventTimestampMs: 50_000,
        providerTransactionId: "concurrent-consumable-transaction",
        targetState: "granted",
      }),
      applyConsumable({
        event: "concurrent-consumable-refund",
        eventTimestampMs: 51_000,
        providerTransactionId: "concurrent-consumable-transaction",
        targetState: "refunded",
      }),
    ]);
    const transaction = await pool.query<{ state: string; stateEventTimestampMs: string }>(
      `SELECT state, "stateEventTimestampMs"
       FROM revenuecat_transactions
       WHERE provider = 'revenuecat' AND "providerTransactionId" = $1`,
      [`${namespace}-concurrent-consumable-transaction`],
    );
    expect(transaction.rows).toEqual([{ state: "refunded", stateEventTimestampMs: "51000" }]);
  });
});
