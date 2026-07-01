import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SubscriptionService } from "../src/modules/subscription/subscription.service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("SubscriptionService", () => {
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://localhost/unused");
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const userId = "00000000-0000-4000-8000-000000000301";
  let service: SubscriptionService;

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: databaseUrl });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    await setupPool.end();
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));
    await pool.query(
      "INSERT INTO users (id, phone_e164, nickname, intro, terms_accepted_at) VALUES ($1, '+821033330301', 'tea', '', now())",
      [userId],
    );
    service = new SubscriptionService(drizzle(pool));
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
