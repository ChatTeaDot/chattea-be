import { Injectable, Optional } from "@nestjs/common";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import { NotificationService } from "src/modules/notification/notification.service";
import { ChatRepository } from "./chat.repository";
import { ChatMessagePayload, ChatRoomPayload } from "./chat.types";

const FIRST_MESSAGE_MAX_LENGTH = 30;
const MESSAGE_MAX_LENGTH = 90;
const REPORT_REASON_MAX_LENGTH = 120;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

@Injectable()
export class ChatService {
  constructor(
    private readonly chatRepository: ChatRepository,
    @Optional() private readonly notificationService?: NotificationService,
  ) {}

  async rooms(userId: string): Promise<ChatRoomPayload[]> {
    this.validateUuid(userId, "USER_ID_INVALID");
    const result = await this.chatRepository.rooms(userId);

    return result.map((room) => ({
      id: room.id,
      name: room.name,
      lastMessage: room.lastMessage,
      unreadCount: room.unreadCount,
    }));
  }

  async messages(
    userId: string,
    input: { roomId: string; first?: number | null; after?: string | null },
  ): Promise<ChatMessagePayload[]> {
    this.validateUuid(input.roomId, "ROOM_ID_INVALID");
    await this.requireRoomMember(input.roomId, userId);
    const limit = Math.min(input.first ?? 50, 100);
    if (limit < 1) throw new Error("MESSAGE_PAGE_SIZE_INVALID");
    if (input.after) this.validateUuid(input.after, "MESSAGE_CURSOR_INVALID");
    const cursor = input.after ? await this.chatRepository.findMessageCursor(input.after, input.roomId) : null;
    if (input.after && !cursor) throw new Error("MESSAGE_CURSOR_INVALID");
    const result = await this.chatRepository.messages({ roomId: input.roomId, limit, after: cursor?.id });

    return result.map(rowToMessage);
  }

  async sendMessage(
    userId: string,
    input: { roomId: string; text: string; idempotencyKey?: string | null },
  ): Promise<ChatMessagePayload> {
    const text = this.validateText(input.text);
    this.validateUuid(input.roomId, "ROOM_ID_INVALID");
    await this.requireRoomMember(input.roomId, userId);

    const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
    if (idempotencyKey) {
      const existing = await this.chatRepository.findMessageByIdempotencyKey(idempotencyKey, input.roomId, userId);
      if (existing) {
        if (existing.deletedAt) throw new Error("IDEMPOTENCY_KEY_ALREADY_USED");
        return rowToMessage(existing);
      }
    }

    const count = await this.chatRepository.activeMessageCount(input.roomId);
    if (count === 0 && text.length > FIRST_MESSAGE_MAX_LENGTH) {
      throw new Error("FIRST_MESSAGE_TEXT_TOO_LONG");
    }

    const result = await this.chatRepository.createMessage({
      roomId: input.roomId,
      senderUserId: userId,
      text,
      idempotencyKey,
    });
    const message = result.message;
    if (!message) throw new Error("MESSAGE_CREATE_FAILED");
    if (message.deletedAt) throw new Error("IDEMPOTENCY_KEY_ALREADY_USED");
    if (result.created && this.notificationService) {
      const recipientIds = await this.chatRepository.otherRoomMemberIds(input.roomId, userId);
      await Promise.allSettled(
        recipientIds.map((recipientId) =>
          this.notificationService?.notify({
            userId: recipientId,
            type: "message",
            title: "새 메시지가 도착했어요",
            body: text.slice(0, 60),
            route: `/rooms/${input.roomId}`,
            sourceId: message.id,
          }),
        ),
      );
    }
    return rowToMessage(message);
  }

  async editMessage(userId: string, input: { messageId: string; text: string }): Promise<ChatMessagePayload> {
    this.validateUuid(input.messageId, "MESSAGE_ID_INVALID");
    const text = this.validateText(input.text);
    const message = await this.chatRepository.editMessage({ messageId: input.messageId, senderUserId: userId, text });
    if (!message) throw new Error("MESSAGE_NOT_FOUND");
    return rowToMessage(message);
  }

  async deleteMessage(userId: string, messageId: string): Promise<boolean> {
    this.validateUuid(messageId, "MESSAGE_ID_INVALID");
    return Boolean(await this.chatRepository.deleteMessage(messageId, userId));
  }

  async markRoomRead(userId: string, roomId: string): Promise<boolean> {
    this.validateUuid(roomId, "ROOM_ID_INVALID");
    await this.requireRoomMember(roomId, userId);
    await this.chatRepository.markRoomRead(roomId, userId);
    return true;
  }

  async blockUser(blockerUserId: string, blockedUserId: string): Promise<boolean> {
    this.validateUuid(blockerUserId, "USER_ID_INVALID");
    this.validateUuid(blockedUserId, "USER_ID_INVALID");
    if (blockerUserId === blockedUserId) throw new Error("BLOCK_SELF_NOT_ALLOWED");
    await this.chatRepository.blockUser(blockerUserId, blockedUserId);
    return true;
  }

  async reportMessage(reporterUserId: string, messageId: string, reason: string): Promise<boolean> {
    this.validateUuid(reporterUserId, "USER_ID_INVALID");
    this.validateUuid(messageId, "MESSAGE_ID_INVALID");
    const reported = await this.chatRepository.reportMessage(reporterUserId, messageId, validateReportReason(reason));
    if (!reported) throw new Error("MESSAGE_NOT_FOUND_OR_FORBIDDEN");
    return true;
  }

  private validateText(input: string): string {
    const text = input.trim();
    if (!text) throw new Error("MESSAGE_TEXT_REQUIRED");
    if (text.length > MESSAGE_MAX_LENGTH) throw new Error("MESSAGE_TEXT_TOO_LONG");
    return text;
  }

  private async requireRoomMember(roomId: string, userId: string): Promise<void> {
    if (!(await this.chatRepository.isRoomMember(roomId, userId))) {
      throw new CustomUnauthorizedException("채팅방에 접근할 수 없습니다.");
    }
  }

  private validateUuid(input: string, error: string): void {
    if (!UUID_PATTERN.test(input)) {
      throw new Error(error);
    }
  }
}

type MessageRow = {
  id: string;
  roomId: string;
  senderUserId: string | null;
  text: string;
  idempotencyKey: string | null;
  createdAt: Date;
  deletedAt?: Date | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const validateIdempotencyKey = (input?: string | null): string | null => {
  if (input == null) return null;
  const key = input.trim();
  if (!key) throw new Error("IDEMPOTENCY_KEY_INVALID");
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new Error("IDEMPOTENCY_KEY_TOO_LONG");
  return key;
};

const validateReportReason = (input: string): string => {
  const reason = input.trim();
  if (!reason) throw new Error("REPORT_REASON_REQUIRED");
  if (reason.length > REPORT_REASON_MAX_LENGTH) throw new Error("REPORT_REASON_TOO_LONG");
  return reason;
};

const rowToMessage = (row: MessageRow): ChatMessagePayload => ({
  id: row.id,
  roomId: row.roomId,
  senderUserId: row.senderUserId ?? undefined,
  text: row.text,
  idempotencyKey: row.idempotencyKey ?? undefined,
  createdAt: row.createdAt.toISOString(),
});
