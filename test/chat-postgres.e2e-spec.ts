import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { Pool } from "pg";
import * as schema from "src/modules/database/schema";
import { ChatRepository } from "src/modules/chat/chat.repository";
import { ChatService } from "src/modules/chat/chat.service";
import { NotificationRepository } from "src/modules/notification/notification.repository";
import { NotificationService } from "src/modules/notification/notification.service";

const configured = Boolean(process.env.POSTGRES_DATABASE && process.env.POSTGRES_USERNAME);
const describePostgres = configured ? describe : describe.skip;

describePostgres("Chat PostgreSQL integrity", () => {
  const namespace = randomUUID().slice(0, 8);
  const makeId = (group: number, item: number) =>
    `${namespace}-${group.toString(16).padStart(4, "0")}-4000-8000-${item.toString(16).padStart(12, "0")}`;
  const ids = {
    member: makeId(1, 1),
    other: makeId(1, 2),
    outsider: makeId(1, 3),
    roomA: makeId(2, 1),
    roomB: makeId(2, 2),
  };
  let pool: Pool;
  let repository: ChatRepository;
  let service: ChatService;

  beforeAll(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USERNAME,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
    });
    repository = new ChatRepository(drizzle(pool, { schema }));
    service = new ChatService(repository);
    await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [[ids.roomA, ids.roomB]]);
    await pool.query('DELETE FROM "users" WHERE "userId" = ANY($1::uuid[])', [[ids.member, ids.other, ids.outsider]]);
    for (const [index, userId] of [ids.member, ids.other, ids.outsider].entries()) {
      await pool.query(
        'INSERT INTO "users" ("userId", email, password, gender, "userName") VALUES ($1, $2, $3, $4, $5)',
        [userId, `pg-chat-${namespace}-${index}@example.test`, "hash", "male", `user-${index}`],
      );
    }
    await pool.query("INSERT INTO rooms (id, name) VALUES ($1, $3), ($2, $4)", [ids.roomA, ids.roomB, "A", "B"]);
    await pool.query('INSERT INTO room_members ("roomId", "userId") VALUES ($1,$2),($1,$3),($4,$2)', [
      ids.roomA,
      ids.member,
      ids.other,
      ids.roomB,
    ]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM rooms WHERE id = ANY($1::uuid[])", [[ids.roomA, ids.roomB]]);
    await pool.query('DELETE FROM "users" WHERE "userId" = ANY($1::uuid[])', [[ids.member, ids.other, ids.outsider]]);
    await pool.end();
  });

  it("atomically hides cross-room, outsider, missing, and deleted report targets", async () => {
    const { message } = await repository.createMessage({
      roomId: ids.roomA,
      senderUserId: ids.other,
      text: "report me",
    });
    expect(message).toBeDefined();
    if (!message) throw new Error("MESSAGE_FIXTURE_CREATE_FAILED");
    await expect(service.reportMessage(ids.member, message.id, "valid")).resolves.toBe(true);
    await expect(service.reportMessage(ids.outsider, message.id, "outsider")).rejects.toThrow(
      "MESSAGE_NOT_FOUND_OR_FORBIDDEN",
    );
    await expect(service.reportMessage(ids.member, makeId(3, 1), "missing")).rejects.toThrow(
      "MESSAGE_NOT_FOUND_OR_FORBIDDEN",
    );
    await repository.deleteMessage(message.id, ids.other);
    await expect(service.reportMessage(ids.member, message.id, "deleted")).rejects.toThrow(
      "MESSAGE_NOT_FOUND_OR_FORBIDDEN",
    );

    const { message: roomBMessage } = await repository.createMessage({
      roomId: ids.roomB,
      senderUserId: ids.member,
      text: "other room",
    });
    if (!roomBMessage) throw new Error("MESSAGE_FIXTURE_CREATE_FAILED");
    await expect(service.reportMessage(ids.other, roomBMessage.id, "cross room")).rejects.toThrow(
      "MESSAGE_NOT_FOUND_OR_FORBIDDEN",
    );
  });

  it("scopes idempotency, makes concurrent retries atomic, and never reuses deleted keys", async () => {
    const input = { roomId: ids.roomA, text: "only once", idempotencyKey: "concurrent-key" };
    const retries = await Promise.all(Array.from({ length: 8 }, () => service.sendMessage(ids.member, input)));
    const [firstRetry] = retries;
    if (!firstRetry) throw new Error("MESSAGE_RETRY_FIXTURE_REQUIRED");
    expect(new Set(retries.map((message) => message.id)).size).toBe(1);

    const otherSender = await service.sendMessage(ids.other, input);
    expect(otherSender.id).not.toBe(firstRetry.id);
    const otherRoom = await service.sendMessage(ids.member, { ...input, roomId: ids.roomB });
    expect(otherRoom.id).not.toBe(firstRetry.id);

    await repository.deleteMessage(firstRetry.id, ids.member);
    await expect(service.sendMessage(ids.member, input)).rejects.toThrow("IDEMPOTENCY_KEY_ALREADY_USED");
  });

  it("rolls back a message when updating its room fails", async () => {
    const functionName = `chat_touch_failure_${namespace}`;
    const triggerName = `chat_touch_failure_${namespace}`;
    const idempotencyKey = `room-touch-failure-${namespace}`;
    await pool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced room touch failure'; END $$`,
    );
    await pool.query(
      `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );

    try {
      await expect(
        repository.createMessage({
          roomId: ids.roomA,
          senderUserId: ids.member,
          text: "must roll back",
          idempotencyKey,
        }),
      ).rejects.toBeDefined();
    } finally {
      await pool.query(`DROP TRIGGER ${triggerName} ON rooms`);
      await pool.query(`DROP FUNCTION ${functionName}()`);
    }

    const persisted = await pool.query<{ id: string }>(
      'SELECT id FROM messages WHERE "roomId" = $1 AND "senderUserId" = $2 AND "idempotencyKey" = $3',
      [ids.roomA, ids.member, idempotencyKey],
    );
    expect(persisted.rows).toHaveLength(0);
  });

  it("persists one notification for concurrent same-key retries", async () => {
    const db = drizzle(pool, { schema });
    const notificationService = new NotificationService(
      new NotificationRepository(db),
      new ConfigService({ EXPO_PUSH_ENABLED: "false" }),
    );
    const notifyingService = new ChatService(repository, notificationService);
    const input = { roomId: ids.roomA, text: "notify once", idempotencyKey: "notification-concurrent-key" };

    const retries = await Promise.all(Array.from({ length: 8 }, () => notifyingService.sendMessage(ids.member, input)));
    const [firstRetry] = retries;
    if (!firstRetry) throw new Error("MESSAGE_RETRY_FIXTURE_REQUIRED");
    const notificationCount = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM notifications WHERE "sourceId" = $1',
      [firstRetry.id],
    );

    expect(new Set(retries.map((message) => message.id)).size).toBe(1);
    expect(notificationCount.rows[0]?.count).toBe(1);
  });

  it("pages every equal-timestamp message using the id tie-breaker", async () => {
    await pool.query('DELETE FROM messages WHERE "roomId" = $1', [ids.roomA]);
    const timestamp = "2026-07-01 12:00:00.000123";
    const cursorId = makeId(4, 0);
    const messageIds = [makeId(4, 1), makeId(4, 2), makeId(4, 3)];
    await pool.query(
      'INSERT INTO messages (id, "roomId", "senderUserId", text, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$5)',
      [cursorId, ids.roomA, ids.member, "cursor", timestamp],
    );
    for (const [index, id] of messageIds.entries()) {
      await pool.query(
        'INSERT INTO messages (id, "roomId", "senderUserId", text, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$5)',
        [id, ids.roomA, ids.member, `tie-${index}`, timestamp],
      );
    }
    const first = await service.messages(ids.member, {
      roomId: ids.roomA,
      first: 1,
      after: cursorId,
    });
    const firstMessage = first[0];
    if (!firstMessage) throw new Error("FIRST_PAGE_EMPTY");
    const second = await service.messages(ids.member, {
      roomId: ids.roomA,
      first: 1,
      after: firstMessage.id,
    });
    const secondMessage = second[0];
    if (!secondMessage) throw new Error("SECOND_PAGE_EMPTY");
    const third = await service.messages(ids.member, {
      roomId: ids.roomA,
      first: 1,
      after: secondMessage.id,
    });
    const thirdMessage = third[0];
    if (!thirdMessage) throw new Error("THIRD_PAGE_EMPTY");
    expect([firstMessage.id, secondMessage.id, thirdMessage.id]).toEqual(messageIds);
  });

  it("returns the newest initial page in ascending UI order and only newer rows after its cursor", async () => {
    await pool.query('DELETE FROM messages WHERE "roomId" = $1', [ids.roomA]);
    const messageIds = Array.from({ length: 105 }, (_, index) => makeId(7, index + 1));
    for (const [index, id] of messageIds.entries()) {
      const createdAt = new Date(Date.UTC(2026, 7, 2, 0, 0, index));
      await pool.query(
        'INSERT INTO messages (id, "roomId", "senderUserId", text, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$5)',
        [id, ids.roomA, ids.other, `message-${index + 1}`, createdAt],
      );
    }

    const latest = await service.messages(ids.member, { roomId: ids.roomA, first: 100 });
    expect(latest.map((message) => message.id)).toEqual(messageIds.slice(5));
    expect(latest.every((message) => message.senderUserId === ids.other)).toBe(true);

    const reconnectIds = [makeId(7, 106), makeId(7, 107), makeId(7, 108)];
    for (const [index, id] of reconnectIds.entries()) {
      const createdAt = new Date(Date.UTC(2026, 7, 2, 0, 2, index));
      await pool.query(
        'INSERT INTO messages (id, "roomId", "senderUserId", text, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$5)',
        [id, ids.roomA, ids.other, `reconnect-${index + 1}`, createdAt],
      );
    }

    const newer = await service.messages(ids.member, { roomId: ids.roomA, first: 100, after: messageIds[104] });
    expect(newer.map((message) => message.id)).toEqual(reconnectIds);
  });

  it("stores an idempotent read receipt at the latest visible message boundary", async () => {
    await pool.query('DELETE FROM messages WHERE "roomId" = $1', [ids.roomA]);
    await pool.query(
      'INSERT INTO matches ("userLowId", "userHighId", "roomId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [ids.member, ids.other, ids.roomA],
    );
    const firstId = makeId(8, 1);
    const laterId = makeId(8, 2);
    const firstCreatedAt = new Date("2026-08-03T00:00:00.000Z");
    const laterCreatedAt = new Date("2026-08-03T00:00:01.000Z");
    await pool.query(
      'INSERT INTO messages (id, "roomId", "senderUserId", text, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$5)',
      [firstId, ids.roomA, ids.other, "read me", firstCreatedAt],
    );

    const concurrentWriter = await pool.connect();
    let committed = false;
    try {
      await concurrentWriter.query("BEGIN");
      await concurrentWriter.query(
        'INSERT INTO messages (id, "roomId", "senderUserId", text, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$5)',
        [laterId, ids.roomA, ids.other, "still unread", laterCreatedAt],
      );
      await expect(service.markRoomRead(ids.member, ids.roomA)).resolves.toBe(true);
      await expect(service.markRoomRead(ids.member, ids.roomA)).resolves.toBe(true);
      expect((await repository.rooms(ids.member)).find((room) => room.id === ids.roomA)?.unreadCount).toBe(0);
      await concurrentWriter.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await concurrentWriter.query("ROLLBACK");
      concurrentWriter.release();
    }
    const receipt = await pool.query<{ lastReadMessageId: string; readAt: Date }>(
      'SELECT "lastReadMessageId", "readAt" FROM read_receipts WHERE "roomId" = $1 AND "userId" = $2',
      [ids.roomA, ids.member],
    );
    expect(receipt.rows).toEqual([{ lastReadMessageId: firstId, readAt: firstCreatedAt }]);

    const unread = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM messages WHERE "roomId" = $1 AND "senderUserId" <> $2 AND "deletedAt" IS NULL AND ("createdAt", id) > ($3, $4)',
      [ids.roomA, ids.member, firstCreatedAt, firstId],
    );
    expect(unread.rows[0]?.count).toBe(1);
    expect((await repository.rooms(ids.member)).find((room) => room.id === ids.roomA)?.unreadCount).toBe(1);
  });

  it("does not regress a receipt whose boundary message was deleted", async () => {
    await pool.query('DELETE FROM messages WHERE "roomId" = $1', [ids.roomA]);
    const olderId = makeId(9, 1);
    const newerId = makeId(9, 2);
    const olderCreatedAt = new Date("2026-08-04T00:00:00.000Z");
    const newerCreatedAt = new Date("2026-08-04T00:00:01.000Z");
    await pool.query(
      'INSERT INTO messages (id, "roomId", "senderUserId", text, "createdAt", "updatedAt") VALUES ($1,$3,$4,$5,$7,$7),($2,$3,$4,$6,$8,$8)',
      [olderId, newerId, ids.roomA, ids.other, "older", "newer", olderCreatedAt, newerCreatedAt],
    );
    await service.markRoomRead(ids.member, ids.roomA);
    await pool.query("DELETE FROM messages WHERE id = $1", [newerId]);

    await service.markRoomRead(ids.member, ids.roomA);

    const receipt = await pool.query<{ lastReadMessageId: string | null; readAt: Date }>(
      'SELECT "lastReadMessageId", "readAt" FROM read_receipts WHERE "roomId" = $1 AND "userId" = $2',
      [ids.roomA, ids.member],
    );
    expect(receipt.rows).toEqual([{ lastReadMessageId: null, readAt: newerCreatedAt }]);
  });

  it("uses id as the deterministic last-message tie-breaker", async () => {
    await pool.query('DELETE FROM messages WHERE "roomId" = $1', [ids.roomA]);
    await pool.query(
      'INSERT INTO matches ("userLowId", "userHighId", "roomId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [ids.member, ids.other, ids.roomA],
    );
    const timestamp = new Date("2026-08-01T00:00:00.000Z");
    await pool.query(
      'INSERT INTO messages (id,"roomId","senderUserId",text,"createdAt","updatedAt") VALUES ($1,$3,$4,$5,$7,$7),($2,$3,$4,$6,$7,$7)',
      [makeId(5, 1), makeId(5, 2), ids.roomA, ids.member, "older id", "newer id", timestamp],
    );
    const rooms = await repository.rooms(ids.member);
    expect(rooms.find((room) => room.id === ids.roomA)?.lastMessage).toBe("newer id");
  });

  it("normalizes legacy invalid keys before enforcing limits for new rows", async () => {
    const client = await pool.connect();
    const migrations = await Promise.all(
      ["0006a_prepare_chat_integrity.sql", "0007_chat_integrity.sql", "0008_normalize_idempotency_keys.sql"].map(
        (file) => readFile(resolve(process.cwd(), "migrations", file), "utf8"),
      ),
    );
    const migrationSchema = `migration_${namespace}`;

    try {
      await client.query(`CREATE SCHEMA "${migrationSchema}"`);
      await client.query(`SET search_path TO "${migrationSchema}"`);
      await client.query(`
        CREATE TABLE messages (
          id uuid PRIMARY KEY,
          "roomId" uuid NOT NULL,
          "senderUserId" uuid,
          "idempotencyKey" text,
          "createdAt" timestamp NOT NULL
        );
        ALTER TABLE messages
          ADD CONSTRAINT "messages_idempotencyKey_key" UNIQUE ("idempotencyKey");
      `);
      await client.query(
        'INSERT INTO messages (id, "roomId", "senderUserId", "idempotencyKey", "createdAt") VALUES ($1,$2,$3,$4,now()),($5,$2,$3,$6,now()),($7,$2,$3,$8,now()),($9,$2,$3,$10,now()),($11,$2,$3,$12,now())',
        [
          makeId(6, 1),
          ids.roomA,
          ids.member,
          "",
          makeId(6, 2),
          "x".repeat(129),
          makeId(6, 3),
          "   ",
          makeId(6, 4),
          " key ",
          makeId(6, 5),
          "key",
        ],
      );
      await client.query(
        'INSERT INTO messages (id, "roomId", "senderUserId", "idempotencyKey", "createdAt") VALUES ($1,$2,$3,$4,now()),($5,$2,$3,$6,now())',
        [makeId(6, 6), ids.roomA, ids.member, "\tkey2\u00a0", makeId(6, 7), "key2"],
      );

      for (const migration of migrations) await client.query(migration);

      const legacy = await client.query(
        'SELECT count(*)::int AS count, count("idempotencyKey")::int AS keyed, array_agg("idempotencyKey" ORDER BY "idempotencyKey") FILTER (WHERE "idempotencyKey" IS NOT NULL) AS normalized_keys FROM messages',
      );
      const constraint = await client.query<{ convalidated: boolean }>(
        "SELECT convalidated FROM pg_constraint WHERE conrelid = 'messages'::regclass AND conname = 'messages_idempotency_key_length_check'",
      );
      expect(legacy.rows[0]?.count).toBe(7);
      expect(legacy.rows[0]?.keyed).toBe(2);
      expect(legacy.rows[0]?.normalized_keys).toEqual(["key", "key2"]);
      expect(constraint.rows[0]?.convalidated).toBe(true);
      await expect(
        client.query(
          'INSERT INTO messages (id, "roomId", "senderUserId", "idempotencyKey", "createdAt") VALUES ($1,$2,$3,$4,now())',
          [makeId(6, 8), ids.roomA, ids.member, " new-key "],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("RESET search_path");
      await client.query(`DROP SCHEMA IF EXISTS "${migrationSchema}" CASCADE`);
      client.release();
    }
  });
});
