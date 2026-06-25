import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChatService } from "../src/chat/chat-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("PostgresChatService", () => {
  const schema = `test_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://localhost/unused");
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  const roomId = "00000000-0000-4000-8000-000000000001";
  const userId = "00000000-0000-4000-8000-000000000101";
  const blockedUserId = "00000000-0000-4000-8000-000000000102";
  let service: PostgresChatService;

  beforeAll(async () => {
    const setupPool = new Pool({ connectionString: databaseUrl });
    await setupPool.query(`CREATE SCHEMA ${schema}`);
    await setupPool.end();
    await pool.query(readFileSync("migrations/001_initial_schema.sql", "utf8"));
    await pool.query(
      `
        INSERT INTO users (id, phone_e164, nickname, terms_accepted_at)
        VALUES
          ($1, '+821011110101', 'reporter', now()),
          ($2, '+821011110102', 'blocked', now())
      `,
      [userId, blockedUserId],
    );
    service = new PostgresChatService(pool);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  });

  it("persists messages and dedupes by idempotency key", async () => {
    const first = await service.sendMessage(
      { roomId, text: "안녕하세요", idempotencyKey: "pg-temp-1" },
      new Date("2026-06-25T00:00:01.000Z"),
    );
    const duplicate = await service.sendMessage(
      { roomId, text: "안녕하세요", idempotencyKey: "pg-temp-1" },
      new Date("2026-06-25T00:00:02.000Z"),
    );

    expect(duplicate).toEqual(first);
    expect((await service.listMessages({ roomId })).filter((message) => message.text === "안녕하세요")).toHaveLength(1);
    expect((await service.listRooms())[0]!.lastMessage).toBe("안녕하세요");
  });

  it("edits, deletes, and marks rooms read", async () => {
    const message = await service.sendMessage({ roomId, text: "before" });

    expect((await service.editMessage({ messageId: message.id, text: "after" })).text).toBe("after");
    expect(await service.markRoomRead(roomId)).toBe(true);
    expect(await service.isRoomRead(roomId)).toBe(true);
    expect(await service.deleteMessage(message.id)).toBe(true);
    expect((await service.listMessages({ roomId })).some((item) => item.id === message.id)).toBe(false);
  });

  it("persists user blocks and message reports", async () => {
    const message = await service.sendMessage({ roomId, text: "신고 대상" });

    expect(await service.blockUser(userId, blockedUserId)).toBe(true);
    expect(await service.reportMessage(userId, message.id, "불쾌한 메시지")).toBe(true);

    const block = await pool.query("SELECT 1 FROM user_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2", [userId, blockedUserId]);
    const report = await pool.query("SELECT reason FROM message_reports WHERE reporter_user_id = $1 AND message_id = $2", [userId, message.id]);

    expect(block.rowCount).toBe(1);
    expect(report.rows[0]?.reason).toBe("불쾌한 메시지");
  });
});
