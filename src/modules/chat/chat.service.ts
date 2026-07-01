import { dbQuery, sql, type Database } from "../../db/client.js";
import { ChatEventBus } from "./chat-events.service.js";

const FIRST_MESSAGE_MAX_LENGTH = 30;
const MESSAGE_MAX_LENGTH = 90;
const REPORT_REASON_MAX_LENGTH = 120;

export type Room = {
  id: string;
  name: string;
  lastMessage: string;
};

export type Message = {
  id: string;
  roomId: string;
  text: string;
  idempotencyKey: string | null;
  createdAt: string;
};

export class ChatService {
  constructor(
    private readonly db: Database,
    private readonly events: ChatEventBus = new ChatEventBus(),
  ) {}

  async listRooms(): Promise<Room[]> {
    const result = await dbQuery<{
      id: string;
      name: string;
      last_message: string | null;
    }>(
      this.db,
      sql`
        SELECT rooms.id::text, rooms.name, latest.text AS last_message
        FROM rooms
        LEFT JOIN LATERAL (
          SELECT text
          FROM messages
          WHERE messages.room_id = rooms.id
            AND messages.deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 1
        ) latest ON true
        ORDER BY rooms.updated_at DESC
      `,
    );

    return result.rows.map((room) => ({
      id: room.id,
      name: room.name,
      lastMessage: room.last_message ?? "",
    }));
  }

  async listMessages(input: {
    roomId: string;
    first?: number | null;
    after?: string | null;
  }): Promise<Message[]> {
    this.validateUuid(input.roomId);
    const limit = Math.min(input.first ?? 50, 100);
    const cursor = input.after
      ? await dbQuery<{ created_at: Date }>(
          this.db,
          sql`SELECT created_at FROM messages WHERE id = ${input.after}`,
        )
      : null;
    const result = await dbQuery<{
      id: string;
      room_id: string;
      text: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      this.db,
      sql`
        SELECT id::text, room_id::text, text, idempotency_key, created_at
        FROM messages
        WHERE room_id = ${input.roomId}
          AND deleted_at IS NULL
          AND (${cursor?.rows[0]?.created_at ?? null}::timestamptz IS NULL OR created_at > ${cursor?.rows[0]?.created_at ?? null})
        ORDER BY created_at ASC
        LIMIT ${limit}
      `,
    );

    return result.rows.map(rowToMessage);
  }

  async sendMessage(
    input: { roomId: string; text: string; idempotencyKey?: string | null },
    now = new Date(),
  ): Promise<Message> {
    const text = this.validateText(input.text);
    this.validateUuid(input.roomId);

    await dbQuery(
      this.db,
      sql`INSERT INTO rooms (id, name) VALUES (${input.roomId}, '대화') ON CONFLICT (id) DO NOTHING`,
    );

    if (input.idempotencyKey) {
      const existing = await dbQuery<{
        id: string;
        room_id: string;
        text: string;
        idempotency_key: string | null;
        created_at: Date;
      }>(
        this.db,
        sql`SELECT id::text, room_id::text, text, idempotency_key, created_at FROM messages WHERE idempotency_key = ${input.idempotencyKey}`,
      );
      if (existing.rows[0]) {
        return rowToMessage(existing.rows[0]);
      }
    }

    const count = await dbQuery<{ count: string }>(
      this.db,
      sql`SELECT COUNT(*)::text AS count FROM messages WHERE room_id = ${input.roomId} AND deleted_at IS NULL`,
    );
    validateFirstMessageText(text, count.rows[0]?.count === "0");

    const result = await dbQuery<{
      id: string;
      room_id: string;
      text: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      this.db,
      sql`
        INSERT INTO messages (room_id, text, idempotency_key, created_at, updated_at)
        VALUES (${input.roomId}, ${text}, ${input.idempotencyKey ?? null}, ${now}, ${now})
        RETURNING id::text, room_id::text, text, idempotency_key, created_at
      `,
    );
    await dbQuery(this.db, sql`UPDATE rooms SET updated_at = ${now} WHERE id = ${input.roomId}`);
    const message = rowToMessage(result.rows[0]!);

    this.events.publish("messageCreated", { ...message });
    return message;
  }

  async editMessage(input: { messageId: string; text: string }): Promise<Message> {
    const text = this.validateText(input.text);
    const result = await dbQuery<{
      id: string;
      room_id: string;
      text: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      this.db,
      sql`
        UPDATE messages
        SET text = ${text}, updated_at = now()
        WHERE id = ${input.messageId} AND deleted_at IS NULL
        RETURNING id::text, room_id::text, text, idempotency_key, created_at
      `,
    );

    if (!result.rows[0]) {
      throw new Error("MESSAGE_NOT_FOUND");
    }

    const message = rowToMessage(result.rows[0]);
    await dbQuery(this.db, sql`UPDATE rooms SET updated_at = now() WHERE id = ${message.roomId}`);
    this.events.publish("messageUpdated", { ...message });
    return message;
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    const result = await dbQuery<{ room_id: string }>(
      this.db,
      sql`UPDATE messages SET deleted_at = now(), updated_at = now() WHERE id = ${messageId} AND deleted_at IS NULL RETURNING room_id::text`,
    );

    if (!result.rows[0]) {
      return false;
    }

    this.events.publish("messageDeleted", {
      roomId: result.rows[0].room_id,
      messageId,
    });
    return true;
  }

  async markRoomRead(roomId: string): Promise<boolean> {
    this.validateUuid(roomId);
    const room = await dbQuery(this.db, sql`SELECT 1 FROM rooms WHERE id = ${roomId}`);
    if (!room.rows[0]) {
      return false;
    }

    this.events.publish("readReceiptUpdated", { roomId, read: true });
    return true;
  }

  async isRoomRead(roomId: string): Promise<boolean> {
    this.validateUuid(roomId);
    const room = await dbQuery(this.db, sql`SELECT 1 FROM rooms WHERE id = ${roomId}`);
    return Boolean(room.rows[0]);
  }

  setTyping(roomId: string, typing: boolean): boolean {
    this.validateUuid(roomId);
    this.events.publish("typingChanged", { roomId, typing });
    return true;
  }

  async blockUser(blockerUserId: string, blockedUserId: string): Promise<boolean> {
    this.validateUuid(blockerUserId);
    this.validateUuid(blockedUserId);
    if (blockerUserId === blockedUserId) {
      throw new Error("BLOCK_SELF_NOT_ALLOWED");
    }

    await dbQuery(
      this.db,
      sql`
        INSERT INTO user_blocks (blocker_user_id, blocked_user_id)
        VALUES (${blockerUserId}, ${blockedUserId})
        ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING
      `,
    );
    return true;
  }

  async reportMessage(reporterUserId: string, messageId: string, reason: string): Promise<boolean> {
    this.validateUuid(reporterUserId);
    this.validateUuid(messageId);
    await dbQuery(
      this.db,
      sql`
        INSERT INTO message_reports (message_id, reporter_user_id, reason)
        VALUES (${messageId}, ${reporterUserId}, ${validateReportReason(reason)})
        ON CONFLICT (message_id, reporter_user_id)
        DO UPDATE SET reason = EXCLUDED.reason, created_at = now()
      `,
    );
    return true;
  }

  subscribeMessageCreated(roomId: string) {
    return this.events.subscribe("messageCreated", roomId);
  }

  subscribeMessageUpdated(roomId: string) {
    return this.events.subscribe("messageUpdated", roomId);
  }

  subscribeMessageDeleted(roomId: string) {
    return this.events.subscribe("messageDeleted", roomId);
  }

  subscribeTypingChanged(roomId: string) {
    return this.events.subscribe("typingChanged", roomId);
  }

  subscribeReadReceiptUpdated(roomId: string) {
    return this.events.subscribe("readReceiptUpdated", roomId);
  }

  private validateText(input: string): string {
    const text = input.trim();
    if (!text) {
      throw new Error("MESSAGE_TEXT_REQUIRED");
    }

    if (text.length > MESSAGE_MAX_LENGTH) {
      throw new Error("MESSAGE_TEXT_TOO_LONG");
    }

    return text;
  }

  private validateUuid(input: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
      throw new Error("ROOM_ID_INVALID");
    }
  }
}

function validateFirstMessageText(text: string, isFirstMessage: boolean): void {
  if (isFirstMessage && text.length > FIRST_MESSAGE_MAX_LENGTH) {
    throw new Error("FIRST_MESSAGE_TEXT_TOO_LONG");
  }
}

function validateReportReason(input: string): string {
  const reason = input.trim();
  if (!reason) {
    throw new Error("REPORT_REASON_REQUIRED");
  }

  if (reason.length > REPORT_REASON_MAX_LENGTH) {
    throw new Error("REPORT_REASON_TOO_LONG");
  }

  return reason;
}

function rowToMessage(row: {
  id: string;
  room_id: string;
  text: string;
  idempotency_key: string | null;
  created_at: Date;
}): Message {
  return {
    id: row.id,
    roomId: row.room_id,
    text: row.text,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at.toISOString(),
  };
}
