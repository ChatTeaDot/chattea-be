import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresSubscriptionService, SubscriptionService } from "../src/subscription/subscription-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describe("SubscriptionService", () => {
  it("defaults to free and supports test overrides", () => {
    const service = new SubscriptionService();

    expect(service.getCurrentSubscription("user").planId).toBe("free");
    service.setCurrentPlanForTest("user", "black");
    expect(service.getCurrentSubscription("user").planId).toBe("black");
  });
});

describeIfDb("PostgresSubscriptionService", () => {
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://localhost/unused");
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const userId = "00000000-0000-4000-8000-000000000301";
  let service: PostgresSubscriptionService;

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: databaseUrl });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    await setupPool.end();
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));
    await pool.query(
      "INSERT INTO users (id, phone_e164, nickname, intro, terms_accepted_at) VALUES ($1, '+821033330301', 'tea', '', now())",
      [userId],
    );
    service = new PostgresSubscriptionService(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("returns free until an active subscription exists", async () => {
    expect(await service.getCurrentSubscription(userId)).toEqual({ planId: "free" });

    await pool.query(
      "INSERT INTO user_subscriptions (user_id, plan_id, status) VALUES ($1, 'black', 'active')",
      [userId],
    );

    expect(await service.getCurrentSubscription(userId)).toEqual({ planId: "black" });
  });
});
