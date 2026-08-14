import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, isNull, ne, or, sql } from "drizzle-orm";
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

  /**
   * 매칭된 채팅방 목록과 각 방의 마지막 메시지를 조회한다.
   *
   * @param userId 사용자 ID
   * @returns 채팅방 목록
   */
  async rooms(userId: string) {
    const rows = await this.db
      .select({
        id: rooms.id,
        name: users.userName,
        updatedAt: rooms.updatedAt,
      })
      .from(matches)
      .innerJoin(rooms, eq(rooms.id, matches.roomId))
      .innerJoin(
        users,
        eq(
          users.userId,
          sql`case when ${matches.userLowId} = ${userId} then ${matches.userHighId} else ${matches.userLowId} end`,
        ),
      )
      .where(or(eq(matches.userLowId, userId), eq(matches.userHighId, userId)))
      .orderBy(desc(rooms.updatedAt));

    return Promise.all(
      rows.map(async (room) => {
        const lastMessage = await this.db.query.messages.findFirst({
          columns: { text: true },
          where: and(eq(messages.roomId, room.id), isNull(messages.deletedAt)),
          orderBy: desc(messages.createdAt),
        });

        const unread = await this.unreadMessageCount(room.id, userId);
        return {
          id: room.id,
          name: room.name,
          lastMessage: lastMessage?.text ?? null,
          unreadCount: Number(unread),
          updatedAt: room.updatedAt,
        };
      }),
    );
  }

  /**
   * 커서 메시지의 생성 시각을 조회한다.
   *
   * @param messageId 커서로 사용할 메시지 ID
   * @returns 메시지 생성 시각 또는 undefined
   */
  async findMessageCursor(messageId: string) {
    return this.db.query.messages.findFirst({
      columns: { createdAt: true },
      where: eq(messages.id, messageId),
    });
  }

  /**
   * 채팅방 메시지 목록을 조회한다.
   *
   * @param input 채팅방 ID, 조회 개수, 커서 시각
   * @returns 메시지 목록
   */
  async messages(input: { roomId: string; limit: number; after?: Date | null; viewerUserId: string }) {
    const where = input.after
      ? and(eq(messages.roomId, input.roomId), isNull(messages.deletedAt), gt(messages.createdAt, input.after))
      : and(eq(messages.roomId, input.roomId), isNull(messages.deletedAt));

    return this.db
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
      .orderBy(messages.createdAt)
      .limit(input.limit);
  }

  async hasRoomMember(roomId: string, userId: string): Promise<boolean> {
    const membership = await this.db.query.roomMembers.findFirst({
      columns: { roomId: true },
      where: and(eq(roomMembers.roomId, roomId), eq(roomMembers.userId, userId)),
    });
    return Boolean(membership);
  }

  async otherRoomMemberIds(roomId: string, userId: string): Promise<string[]> {
    const members = await this.db.query.roomMembers.findMany({
      columns: { userId: true },
      where: and(eq(roomMembers.roomId, roomId), ne(roomMembers.userId, userId)),
    });
    return members.map((member) => member.userId);
  }

  /**
   * idempotency key로 기존 메시지를 조회한다.
   *
   * @param idempotencyKey 중복 전송 방지 키
   * @returns 기존 메시지 또는 undefined
   */
  async findMessageByIdempotencyKey(idempotencyKey: string) {
    return this.db.query.messages.findFirst({
      where: eq(messages.idempotencyKey, idempotencyKey),
    });
  }

  async findActiveMessage(messageId: string) {
    return this.db.query.messages.findFirst({
      columns: { id: true, roomId: true },
      where: and(eq(messages.id, messageId), isNull(messages.deletedAt)),
    });
  }

  /**
   * 삭제되지 않은 메시지 수를 조회한다.
   *
   * @param roomId 채팅방 ID
   * @returns 활성 메시지 수
   */
  async activeMessageCount(roomId: string) {
    const [row] = await this.db
      .select({ count: count() })
      .from(messages)
      .where(and(eq(messages.roomId, roomId), isNull(messages.deletedAt)));

    return row?.count ?? 0;
  }

  /**
   * 새 메시지를 저장하고 채팅방 갱신 시각을 변경한다.
   *
   * @param input 메시지 생성 입력값
   * @returns 생성된 메시지
   */
  async createMessage(input: { roomId: string; senderUserId: string; text: string; idempotencyKey?: string | null }) {
    const [message] = await this.db
      .insert(messages)
      .values({
        roomId: input.roomId,
        senderUserId: input.senderUserId,
        text: input.text,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();

    await this.touchRoom(input.roomId);
    return message;
  }

  /**
   * 메시지 본문을 수정하고 채팅방 갱신 시각을 변경한다.
   *
   * @param input 수정할 메시지 ID와 본문
   * @returns 수정된 메시지 또는 undefined
   */
  async editMessage(input: { messageId: string; text: string }) {
    const [message] = await this.db
      .update(messages)
      .set({ text: input.text, updatedAt: new Date() })
      .where(and(eq(messages.id, input.messageId), isNull(messages.deletedAt)))
      .returning();

    if (message) await this.touchRoom(message.roomId);
    return message;
  }

  /**
   * 메시지를 soft delete 처리한다.
   *
   * @param messageId 삭제할 메시지 ID
   * @returns 삭제된 메시지 또는 undefined
   */
  async deleteMessage(messageId: string) {
    const [message] = await this.db
      .update(messages)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt)))
      .returning();

    return message;
  }

  /**
   * 채팅방을 ID로 조회한다.
   *
   * @param roomId 채팅방 ID
   * @returns 채팅방 또는 undefined
   */
  async findRoom(roomId: string) {
    return this.db.query.rooms.findFirst({ where: eq(rooms.id, roomId) });
  }

  async markRoomRead(input: { roomId: string; userId: string }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const member = await tx.query.roomMembers.findFirst({
        columns: { roomId: true },
        where: and(eq(roomMembers.roomId, input.roomId), eq(roomMembers.userId, input.userId)),
      });
      if (!member) return false;
      const lastMessage = await tx.query.messages.findFirst({
        columns: { id: true },
        where: and(eq(messages.roomId, input.roomId), isNull(messages.deletedAt)),
        orderBy: desc(messages.createdAt),
      });
      await tx
        .insert(readReceipts)
        .values({ roomId: input.roomId, userId: input.userId, lastReadMessageId: lastMessage?.id, readAt: new Date() })
        .onConflictDoUpdate({
          target: [readReceipts.roomId, readReceipts.userId],
          set: { lastReadMessageId: lastMessage?.id, readAt: new Date() },
        });
      return true;
    });
  }

  async sentByUser(messageId: string, userId: string): Promise<boolean> {
    const message = await this.db.query.messages.findFirst({
      columns: { id: true },
      where: and(eq(messages.id, messageId), eq(messages.senderUserId, userId), isNull(messages.deletedAt)),
    });
    return Boolean(message);
  }

  private async unreadMessageCount(roomId: string, userId: string): Promise<number | string> {
    const receipt = await this.db.query.readReceipts.findFirst({
      columns: { readAt: true },
      where: and(eq(readReceipts.roomId, roomId), eq(readReceipts.userId, userId)),
    });
    const [row] = await this.db
      .select({ count: count() })
      .from(messages)
      .where(
        and(
          eq(messages.roomId, roomId),
          ne(messages.senderUserId, userId),
          isNull(messages.deletedAt),
          receipt ? gt(messages.createdAt, receipt.readAt) : undefined,
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * 사용자를 차단 목록에 저장한다.
   *
   * @param blockerUserId 차단한 사용자 ID
   * @param blockedUserId 차단된 사용자 ID
   * @returns 저장 완료 Promise
   */
  async blockUser(blockerUserId: string, blockedUserId: string) {
    await this.db.insert(userBlocks).values({ blockerUserId, blockedUserId }).onConflictDoNothing();
  }

  /**
   * 메시지 신고 사유를 저장하거나 갱신한다.
   *
   * @param reporterUserId 신고한 사용자 ID
   * @param messageId 신고 대상 메시지 ID
   * @param reason 신고 사유
   * @returns 저장 완료 Promise
   */
  async reportMessage(reporterUserId: string, messageId: string, reason: string) {
    await this.db
      .insert(messageReports)
      .values({ messageId, reporterUserId, reason })
      .onConflictDoUpdate({
        target: [messageReports.messageId, messageReports.reporterUserId],
        set: { reason, createdAt: new Date() },
      });
  }

  private async touchRoom(roomId: string) {
    await this.db.update(rooms).set({ updatedAt: new Date() }).where(eq(rooms.id, roomId));
  }
}
