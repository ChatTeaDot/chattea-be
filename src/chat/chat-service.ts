import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ChatEventBus } from "./chat-events.js";

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
  private readonly rooms = new Map<string, Room>([
    [
      "demo-room",
      {
        id: "demo-room",
        name: "오늘의 대화",
        lastMessage: "첫 메시지는 30자 안으로 가볍게.",
      },
    ],
  ]);
  private readonly messagesByRoom = new Map<string, Message[]>([
    [
      "demo-room",
      [
        {
          id: "welcome",
          roomId: "demo-room",
          text: "반가워요. ChatTea v1 skeleton입니다.",
          idempotencyKey: null,
          createdAt: new Date("2026-06-25T00:00:00.000Z").toISOString(),
        },
      ],
    ],
  ]);
  private readonly messagesByIdempotencyKey = new Map<string, Message>();
  private readonly readRooms = new Set<string>();
  private readonly blockedUsers = new Set<string>();
  private readonly messageReports = new Set<string>();

  constructor(private readonly events: ChatEventBus = new ChatEventBus()) {}

  listRooms(): Room[] {
    return [...this.rooms.values()];
  }

  listMessages(input: {
    roomId: string;
    first?: number | null;
    after?: string | null;
  }): Message[] {
    const messages = this.messagesByRoom.get(input.roomId) ?? [];
    const startIndex = input.after
      ? messages.findIndex((message) => message.id === input.after) + 1
      : 0;
    const limit = Math.min(input.first ?? 50, 100);

    return messages.slice(
      Math.max(startIndex, 0),
      Math.max(startIndex, 0) + limit,
    );
  }

  sendMessage(
    input: { roomId: string; text: string; idempotencyKey?: string | null },
    now = new Date(),
  ): Message {
    const text = this.validateText(input.text);
    const messages = this.messagesByRoom.get(input.roomId) ?? [];

    validateFirstMessageText(text, messages.length === 0);

    if (!this.rooms.has(input.roomId)) {
      this.rooms.set(input.roomId, {
        id: input.roomId,
        name: "대화",
        lastMessage: "",
      });
    }

    if (input.idempotencyKey) {
      const existing = this.messagesByIdempotencyKey.get(input.idempotencyKey);
      if (existing) {
        return existing;
      }
    }

    const message: Message = {
      id: randomUUID(),
      roomId: input.roomId,
      text,
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: now.toISOString(),
    };

    messages.push(message);
    this.messagesByRoom.set(input.roomId, messages);
    this.rooms.set(input.roomId, {
      ...this.rooms.get(input.roomId)!,
      lastMessage: text,
    });

    if (input.idempotencyKey) {
      this.messagesByIdempotencyKey.set(input.idempotencyKey, message);
    }

    this.events.publish("messageCreated", { ...message });
    return message;
  }

  editMessage(input: { messageId: string; text: string }): Message {
    const text = this.validateText(input.text);
    const message = this.findMessage(input.messageId);

    message.text = text;
    this.refreshLastMessage(message.roomId);
    this.events.publish("messageUpdated", { ...message });

    return message;
  }

  deleteMessage(messageId: string): boolean {
    for (const [roomId, messages] of this.messagesByRoom) {
      const nextMessages = messages.filter(
        (message) => message.id !== messageId,
      );
      if (nextMessages.length === messages.length) {
        continue;
      }

      this.messagesByRoom.set(roomId, nextMessages);
      this.refreshLastMessage(roomId);
      this.events.publish("messageDeleted", { roomId, messageId });
      return true;
    }

    return false;
  }

  markRoomRead(roomId: string): boolean {
    if (!this.rooms.has(roomId)) {
      return false;
    }

    this.readRooms.add(roomId);
    this.events.publish("readReceiptUpdated", { roomId, read: true });
    return true;
  }

  isRoomRead(roomId: string): boolean {
    return this.readRooms.has(roomId);
  }

  setTyping(roomId: string, typing: boolean): boolean {
    if (!this.rooms.has(roomId)) {
      return false;
    }

    this.events.publish("typingChanged", { roomId, typing });
    return true;
  }

  blockUser(blockerUserId: string, blockedUserId: string): boolean {
    if (blockerUserId === blockedUserId) {
      throw new Error("BLOCK_SELF_NOT_ALLOWED");
    }

    this.blockedUsers.add(`${blockerUserId}:${blockedUserId}`);
    return true;
  }

  reportMessage(reporterUserId: string, messageId: string, reason: string): boolean {
    this.findMessage(messageId);
    this.messageReports.add(`${messageId}:${reporterUserId}:${validateReportReason(reason)}`);
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

  private findMessage(messageId: string): Message {
    for (const messages of this.messagesByRoom.values()) {
      const message = messages.find((item) => item.id === messageId);
      if (message) {
        return message;
      }
    }

    throw new Error("MESSAGE_NOT_FOUND");
  }

  private refreshLastMessage(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }

    const messages = this.messagesByRoom.get(roomId) ?? [];
    this.rooms.set(roomId, {
      ...room,
      lastMessage: messages.at(-1)?.text ?? "",
    });
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
}

export class PostgresChatService {
  constructor(
    private readonly pool: Pool,
    private readonly events: ChatEventBus = new ChatEventBus(),
  ) {}

  async listRooms(): Promise<Room[]> {
    const result = await this.pool.query<{
      id: string;
      name: string;
      last_message: string | null;
    }>(
      `
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
      ? await this.pool.query<{ created_at: Date }>(
          "SELECT created_at FROM messages WHERE id = $1",
          [input.after],
        )
      : null;
    const result = await this.pool.query<{
      id: string;
      room_id: string;
      text: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      `
        SELECT id::text, room_id::text, text, idempotency_key, created_at
        FROM messages
        WHERE room_id = $1
          AND deleted_at IS NULL
          AND ($2::timestamptz IS NULL OR created_at > $2)
        ORDER BY created_at ASC
        LIMIT $3
      `,
      [input.roomId, cursor?.rows[0]?.created_at ?? null, limit],
    );

    return result.rows.map(rowToMessage);
  }

  async sendMessage(
    input: { roomId: string; text: string; idempotencyKey?: string | null },
    now = new Date(),
  ): Promise<Message> {
    const text = this.validateText(input.text);
    this.validateUuid(input.roomId);

    await this.pool.query(
      "INSERT INTO rooms (id, name) VALUES ($1, '대화') ON CONFLICT (id) DO NOTHING",
      [input.roomId],
    );

    if (input.idempotencyKey) {
      const existing = await this.pool.query<{
        id: string;
        room_id: string;
        text: string;
        idempotency_key: string | null;
        created_at: Date;
      }>(
        "SELECT id::text, room_id::text, text, idempotency_key, created_at FROM messages WHERE idempotency_key = $1",
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return rowToMessage(existing.rows[0]);
      }
    }

    const count = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM messages WHERE room_id = $1 AND deleted_at IS NULL",
      [input.roomId],
    );
    validateFirstMessageText(text, count.rows[0]?.count === "0");

    const result = await this.pool.query<{
      id: string;
      room_id: string;
      text: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      `
        INSERT INTO messages (room_id, text, idempotency_key, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $4)
        RETURNING id::text, room_id::text, text, idempotency_key, created_at
      `,
      [input.roomId, text, input.idempotencyKey ?? null, now],
    );
    await this.pool.query("UPDATE rooms SET updated_at = $1 WHERE id = $2", [
      now,
      input.roomId,
    ]);
    const message = rowToMessage(result.rows[0]!);

    this.events.publish("messageCreated", { ...message });
    return message;
  }

  async editMessage(input: { messageId: string; text: string }): Promise<Message> {
    const text = this.validateText(input.text);
    const result = await this.pool.query<{
      id: string;
      room_id: string;
      text: string;
      idempotency_key: string | null;
      created_at: Date;
    }>(
      `
        UPDATE messages
        SET text = $2, updated_at = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id::text, room_id::text, text, idempotency_key, created_at
      `,
      [input.messageId, text],
    );

    if (!result.rows[0]) {
      throw new Error("MESSAGE_NOT_FOUND");
    }

    const message = rowToMessage(result.rows[0]);
    await this.pool.query("UPDATE rooms SET updated_at = now() WHERE id = $1", [
      message.roomId,
    ]);
    this.events.publish("messageUpdated", { ...message });
    return message;
  }

  async deleteMessage(messageId: string): Promise<boolean> {
    const result = await this.pool.query<{ room_id: string }>(
      "UPDATE messages SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING room_id::text",
      [messageId],
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
    const room = await this.pool.query("SELECT 1 FROM rooms WHERE id = $1", [
      roomId,
    ]);
    if (!room.rows[0]) {
      return false;
    }

    this.events.publish("readReceiptUpdated", { roomId, read: true });
    return true;
  }

  async isRoomRead(roomId: string): Promise<boolean> {
    this.validateUuid(roomId);
    const room = await this.pool.query("SELECT 1 FROM rooms WHERE id = $1", [
      roomId,
    ]);
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

    await this.pool.query(
      `
        INSERT INTO user_blocks (blocker_user_id, blocked_user_id)
        VALUES ($1, $2)
        ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING
      `,
      [blockerUserId, blockedUserId],
    );
    return true;
  }

  async reportMessage(reporterUserId: string, messageId: string, reason: string): Promise<boolean> {
    this.validateUuid(reporterUserId);
    this.validateUuid(messageId);
    await this.pool.query(
      `
        INSERT INTO message_reports (message_id, reporter_user_id, reason)
        VALUES ($1, $2, $3)
        ON CONFLICT (message_id, reporter_user_id)
        DO UPDATE SET reason = EXCLUDED.reason, created_at = now()
      `,
      [messageId, reporterUserId, validateReportReason(reason)],
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
