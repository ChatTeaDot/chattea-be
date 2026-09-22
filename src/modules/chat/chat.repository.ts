import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  matches,
  messageReports,
  messages,
  readReceipts,
  roomMembers,
  rooms,
  userBlocks,
  users,
} from "src/modules/database/schema";

@Injectable()
export class ChatRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async rooms(userId: string) {
    const result = await this.db.execute<{
      id: string;
      name: string;
      lastMessage: string | null;
      unreadCount: number;
      updatedAt: Date;
    }>(sql`
      SELECT
        ${rooms.id} AS id,
        ${users.userName} AS name,
        latest.text AS "lastMessage",
        count(unread.id)::int AS "unreadCount",
        ${rooms.updatedAt} AS "updatedAt"
      FROM ${matches}
      INNER JOIN ${rooms} ON ${rooms.id} = ${matches.roomId}
      INNER JOIN ${users}
        ON ${users.userId} = CASE
          WHEN ${matches.userLowId} = ${userId} THEN ${matches.userHighId}
          ELSE ${matches.userLowId}
        END
      LEFT JOIN LATERAL (
        SELECT ${messages.text} AS text
        FROM ${messages}
        WHERE ${messages.roomId} = ${rooms.id} AND ${messages.deletedAt} IS NULL
        ORDER BY ${messages.createdAt} DESC, ${messages.id} DESC
        LIMIT 1
      ) latest ON true
      LEFT JOIN ${readReceipts} receipt
        ON receipt."roomId" = ${rooms.id} AND receipt."userId" = ${userId}
      LEFT JOIN ${messages} unread
        ON unread."roomId" = ${rooms.id}
       AND unread."senderUserId" <> ${userId}
       AND unread."deletedAt" IS NULL
       AND (
         receipt."userId" IS NULL
         OR (receipt."lastReadMessageId" IS NULL AND unread."createdAt" > receipt."readAt")
         OR (unread."createdAt", unread.id) > (receipt."readAt", receipt."lastReadMessageId")
       )
      WHERE ${matches.userLowId} = ${userId} OR ${matches.userHighId} = ${userId}
      GROUP BY ${rooms.id}, ${users.userName}, latest.text
      ORDER BY ${rooms.updatedAt} DESC, ${rooms.id} DESC
    `);

    return result.rows;
  }

  async findMessageCursor(messageId: string, roomId: string) {
    return this.db.query.messages.findFirst({
      columns: { id: true },
      where: and(eq(messages.id, messageId), eq(messages.roomId, roomId), isNull(messages.deletedAt)),
    });
  }

  async isRoomMember(roomId: string, userId: string): Promise<boolean> {
    const member = await this.db.query.roomMembers.findFirst({
      columns: { roomId: true },
      where: and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)),
    });
    return Boolean(member);
  }

  async otherRoomMemberIds(roomId: string, userId: string): Promise<string[]> {
    const members = await this.db.query.roomMembers.findMany({
      columns: { userId: true },
      where: and(eq(roomMembers.roomId, roomId), sql`${roomMembers.userId} <> ${userId}`),
    });
    return members.map((member) => member.userId);
  }

  async messages(input: { roomId: string; limit: number; after?: string | null; before?: string | null }) {
    const cursorId = input.after ?? input.before;
    const where = cursorId
      ? and(
          eq(messages.roomId, input.roomId),
          isNull(messages.deletedAt),
          sql<boolean>`(${messages.createdAt}, ${messages.id}) ${sql.raw(input.after ? ">" : "<")} (
            SELECT cursor."createdAt", cursor.id
            FROM ${messages} AS cursor
            WHERE cursor.id = ${cursorId}
              AND cursor."roomId" = ${input.roomId}
              AND cursor."deletedAt" IS NULL
          )`,
        )
      : and(eq(messages.roomId, input.roomId), isNull(messages.deletedAt));

    const rows = await this.db
      .select({
        id: messages.id,
        roomId: messages.roomId,
        senderUserId: messages.senderUserId,
        text: messages.text,
        idempotencyKey: messages.idempotencyKey,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(where)
      .orderBy(
        input.after ? messages.createdAt : desc(messages.createdAt),
        input.after ? messages.id : desc(messages.id),
      )
      .limit(input.limit);

    return input.after ? rows : rows.reverse();
  }

  markRoomRead = async (roomId: string, userId: string): Promise<void> => {
    await this.db.execute(sql`
      INSERT INTO ${readReceipts} ("roomId", "userId", "lastReadMessageId", "readAt")
      SELECT ${roomId}, ${userId}, ${messages.id}, ${messages.createdAt}
      FROM ${messages}
      WHERE ${messages.roomId} = ${roomId} AND ${messages.deletedAt} IS NULL
      ORDER BY ${messages.createdAt} DESC, ${messages.id} DESC
      LIMIT 1
      ON CONFLICT ("roomId", "userId") DO UPDATE
      SET
        "lastReadMessageId" = EXCLUDED."lastReadMessageId",
        "readAt" = EXCLUDED."readAt"
      WHERE EXCLUDED."readAt" > ${readReceipts.readAt}
         OR (
           EXCLUDED."readAt" = ${readReceipts.readAt}
           AND EXCLUDED."lastReadMessageId" IS NOT NULL
           AND ${readReceipts.lastReadMessageId} IS NOT NULL
           AND EXCLUDED."lastReadMessageId" > ${readReceipts.lastReadMessageId}
         )
    `);
  };

  async ensureRoom(roomId: string) {
    await this.db.insert(rooms).values({ id: roomId, name: "대화" }).onConflictDoNothing();
  }

  async findMessageByIdempotencyKey(idempotencyKey: string, roomId: string, senderUserId: string) {
    return this.db.query.messages.findFirst({
      where: and(
        eq(messages.idempotencyKey, idempotencyKey),
        eq(messages.roomId, roomId),
        eq(messages.senderUserId, senderUserId),
      ),
    });
  }

  async activeMessageCount(roomId: string) {
    const [row] = await this.db
      .select({ count: count() })
      .from(messages)
      .where(and(eq(messages.roomId, roomId), isNull(messages.deletedAt)));

    return row?.count ?? 0;
  }

  async createMessage(input: { roomId: string; senderUserId: string; text: string; idempotencyKey?: string | null }) {
    return this.db.transaction(async (tx) => {
      const [message] = await tx
        .insert(messages)
        .values({
          roomId: input.roomId,
          senderUserId: input.senderUserId,
          text: input.text,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: [messages.roomId, messages.senderUserId, messages.idempotencyKey] })
        .returning();

      if (message) {
        await tx.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, input.roomId));
        return { message, created: true } as const;
      }

      const replayedMessage = input.idempotencyKey
        ? await tx.query.messages.findFirst({
            where: and(
              eq(messages.idempotencyKey, input.idempotencyKey),
              eq(messages.roomId, input.roomId),
              eq(messages.senderUserId, input.senderUserId),
            ),
          })
        : undefined;
      return { message: replayedMessage, created: false } as const;
    });
  }

  async editMessage(input: { messageId: string; senderUserId: string; text: string }) {
    const [message] = await this.db
      .update(messages)
      .set({ text: input.text, updatedAt: new Date() })
      .where(
        and(
          eq(messages.id, input.messageId),
          eq(messages.senderUserId, input.senderUserId),
          isNull(messages.deletedAt),
        ),
      )
      .returning();

    if (message) await this.touchRoom(message.roomId);
    return message;
  }

  async deleteMessage(messageId: string, senderUserId: string) {
    const [message] = await this.db
      .update(messages)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(messages.id, messageId), eq(messages.senderUserId, senderUserId), isNull(messages.deletedAt)))
      .returning();

    return message;
  }

  async findRoom(roomId: string) {
    return this.db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  }

  async blockUser(blockerUserId: string, blockedUserId: string) {
    await this.db.insert(userBlocks).values({ blockerUserId, blockedUserId }).onConflictDoNothing();
  }

  async reportMessage(reporterUserId: string, messageId: string, reason: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      INSERT INTO ${messageReports} ("messageId", "reporterUserId", reason)
      SELECT ${messages.id}, ${reporterUserId}, ${reason}
      FROM ${messages}
      INNER JOIN ${roomMembers}
        ON ${roomMembers.roomId} = ${messages.roomId}
       AND ${roomMembers.userId} = ${reporterUserId}
      WHERE ${messages.id} = ${messageId} AND ${messages.deletedAt} IS NULL
      ON CONFLICT ("messageId", "reporterUserId") DO UPDATE
        SET reason = EXCLUDED.reason, "createdAt" = now()
      RETURNING id
    `);
    return rows.rowCount === 1;
  }

  private async touchRoom(roomId: string) {
    await this.db.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, roomId));
  }
}
