import { Injectable, Optional } from "@nestjs/common";
import { NotificationService } from "src/modules/notification/notification.service";
import { ChatRepository } from "./chat.repository";
import { AiSummaryPreviewPayload, ChatMessagePayload, ChatRoomPayload } from "./chat.types";

const FIRST_MESSAGE_MAX_LENGTH = 30;
const MESSAGE_MAX_LENGTH = 90;
const REPORT_REASON_MAX_LENGTH = 120;
const SUMMARY_MIN_LENGTH = 30;
const SUMMARY_MAX_SOURCE_LENGTH = 180;
const SUMMARY_PLAN_IDS = new Set(["gold", "black"]);

@Injectable()
export class ChatService {
  /**
   * ChatService에서 사용할 ChatRepository 의존성을 주입한다.
   *
   * @param chatRepository 채팅 저장소
   */
  constructor(
    private readonly chatRepository: ChatRepository,
    @Optional() private readonly notificationService?: NotificationService,
  ) {}

  /**
   * 채팅방 목록을 조회한다.
   *
   * @returns 채팅방 목록
   */
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

  /**
   * 채팅방 메시지를 페이지 단위로 조회한다.
   *
   * @param input 채팅방 ID와 페이지 입력값
   * @returns 메시지 목록
   */
  async messages(input: {
    roomId: string;
    userId: string;
    first?: number | null;
    after?: string | null;
  }): Promise<ChatMessagePayload[]> {
    this.validateUuid(input.roomId, "ROOM_ID_INVALID");
    this.validateUuid(input.userId, "USER_ID_INVALID");
    if (!(await this.chatRepository.hasRoomMember(input.roomId, input.userId))) throw new Error("ROOM_ACCESS_DENIED");
    const limit = Math.min(input.first ?? 50, 100);
    const cursor = input.after ? await this.chatRepository.findMessageCursor(input.after) : null;
    const result = await this.chatRepository.messages({
      roomId: input.roomId,
      limit,
      after: cursor?.createdAt,
      viewerUserId: input.userId,
    });

    return result.map(rowToMessage);
  }

  /**
   * 메시지를 전송한다.
   *
   * @param input 메시지 전송 입력값
   * @returns 생성되었거나 idempotency key로 조회된 메시지
   */
  async sendMessage(input: {
    roomId: string;
    senderUserId: string;
    text: string;
    idempotencyKey?: string | null;
  }): Promise<ChatMessagePayload> {
    const text = this.validateText(input.text);
    this.validateUuid(input.roomId, "ROOM_ID_INVALID");
    this.validateUuid(input.senderUserId, "USER_ID_INVALID");
    if (!(await this.chatRepository.hasRoomMember(input.roomId, input.senderUserId)))
      throw new Error("ROOM_ACCESS_DENIED");

    if (input.idempotencyKey) {
      const existing = await this.chatRepository.findMessageByIdempotencyKey(input.idempotencyKey);
      if (existing) return rowToMessage(existing);
    }

    const count = await this.chatRepository.activeMessageCount(input.roomId);
    if (count === 0 && text.length > FIRST_MESSAGE_MAX_LENGTH) {
      throw new Error("FIRST_MESSAGE_TEXT_TOO_LONG");
    }

    const message = await this.chatRepository.createMessage({ ...input, text });
    const recipientIds = await this.chatRepository.otherRoomMemberIds(input.roomId, input.senderUserId);
    await Promise.all(
      recipientIds.map((userId) =>
        this.notificationService?.notify({
          userId,
          type: "message",
          title: "새 메시지가 도착했어요",
          body: text.slice(0, 60),
          route: `/rooms/${input.roomId}`,
          sourceId: message.id,
        }),
      ),
    );
    return rowToMessage(message);
  }

  /**
   * 메시지를 수정한다.
   *
   * @param input 메시지 수정 입력값
   * @returns 수정된 메시지
   */
  async editMessage(input: { messageId: string; userId: string; text: string }): Promise<ChatMessagePayload> {
    const text = this.validateText(input.text);
    this.validateUuid(input.userId, "USER_ID_INVALID");
    if (!(await this.chatRepository.sentByUser(input.messageId, input.userId)))
      throw new Error("MESSAGE_ACCESS_DENIED");
    const message = await this.chatRepository.editMessage({ messageId: input.messageId, text });
    if (!message) throw new Error("MESSAGE_NOT_FOUND");
    return rowToMessage(message);
  }

  /**
   * 메시지를 삭제한다.
   *
   * @param messageId 삭제할 메시지 ID
   * @returns 삭제 성공 여부
   */
  async deleteMessage(messageId: string, userId: string): Promise<boolean> {
    this.validateUuid(userId, "USER_ID_INVALID");
    if (!(await this.chatRepository.sentByUser(messageId, userId))) throw new Error("MESSAGE_ACCESS_DENIED");
    return Boolean(await this.chatRepository.deleteMessage(messageId));
  }

  /**
   * 채팅방 읽음 처리를 검증한다.
   *
   * @param roomId 채팅방 ID
   * @returns 채팅방 존재 여부
   */
  async markRoomRead(roomId: string, userId: string): Promise<boolean> {
    this.validateUuid(roomId, "ROOM_ID_INVALID");
    this.validateUuid(userId, "USER_ID_INVALID");
    return this.chatRepository.markRoomRead({ roomId, userId });
  }

  /**
   * 타이핑 상태를 검증한다.
   *
   * @param input 채팅방 ID와 타이핑 여부
   * @returns 처리 성공 여부
   */
  setTyping(input: { roomId: string; typing: boolean }): boolean {
    this.validateUuid(input.roomId, "ROOM_ID_INVALID");
    return true;
  }

  /**
   * 사용자를 차단한다.
   *
   * @param blockerUserId 차단한 사용자 ID
   * @param blockedUserId 차단된 사용자 ID
   * @returns 처리 성공 여부
   */
  async blockUser(blockerUserId: string, blockedUserId: string): Promise<boolean> {
    this.validateUuid(blockerUserId, "USER_ID_INVALID");
    this.validateUuid(blockedUserId, "USER_ID_INVALID");
    if (blockerUserId === blockedUserId) throw new Error("BLOCK_SELF_NOT_ALLOWED");
    await this.chatRepository.blockUser(blockerUserId, blockedUserId);
    return true;
  }

  /**
   * 메시지를 신고한다.
   *
   * @param reporterUserId 신고한 사용자 ID
   * @param messageId 신고 대상 메시지 ID
   * @param reason 신고 사유
   * @returns 처리 성공 여부
   */
  async reportMessage(reporterUserId: string, messageId: string, reason: string): Promise<boolean> {
    this.validateUuid(reporterUserId, "USER_ID_INVALID");
    this.validateUuid(messageId, "MESSAGE_ID_INVALID");
    const message = await this.chatRepository.findActiveMessage(messageId);
    if (!message) throw new Error("MESSAGE_NOT_FOUND");
    if (!(await this.chatRepository.hasRoomMember(message.roomId, reporterUserId))) {
      throw new Error("ROOM_ACCESS_DENIED");
    }
    await this.chatRepository.reportMessage(reporterUserId, messageId, validateReportReason(reason));
    return true;
  }

  /**
   * 안읽은 메시지 요약 미리보기를 생성한다.
   *
   * @param input 플랜 ID, 안읽은 메시지 목록, 활성화 여부
   * @returns AI 요약 미리보기
   */
  unreadMessageSummary(input: { planId: string; unreadTexts: string[]; enabled: boolean }): AiSummaryPreviewPayload {
    if (!input.enabled) return unavailable("SUMMARY_DISABLED");
    if (!SUMMARY_PLAN_IDS.has(input.planId.toLowerCase())) return unavailable("SUMMARY_PLAN_REQUIRED");

    const sourceText = input.unreadTexts
      .map((text) => text.trim())
      .filter(Boolean)
      .join(" ")
      .slice(-SUMMARY_MAX_SOURCE_LENGTH);

    if (sourceText.length < SUMMARY_MIN_LENGTH) {
      return { ...unavailable("SUMMARY_TEXT_TOO_SHORT"), sourceText };
    }

    return {
      available: true,
      sourceText,
      summary: `최근 안읽은 대화 요약: ${sourceText}`,
    };
  }

  /**
   * 메시지 본문을 검증하고 정규화한다.
   *
   * @param input 메시지 본문
   * @returns 정규화된 메시지 본문
   */
  private validateText(input: string): string {
    const text = input.trim();
    if (!text) throw new Error("MESSAGE_TEXT_REQUIRED");
    if (text.length > MESSAGE_MAX_LENGTH) throw new Error("MESSAGE_TEXT_TOO_LONG");
    return text;
  }

  /**
   * UUID 형식을 검증한다.
   *
   * @param input 검증할 UUID
   * @param error 실패 시 던질 에러 메시지
   */
  private validateUuid(input: string, error: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)) {
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
};

const validateReportReason = (input: string): string => {
  const reason = input.trim();
  if (!reason) throw new Error("REPORT_REASON_REQUIRED");
  if (reason.length > REPORT_REASON_MAX_LENGTH) throw new Error("REPORT_REASON_TOO_LONG");
  return reason;
};

const unavailable = (reason: string): AiSummaryPreviewPayload => ({
  available: false,
  reason,
  sourceText: "",
});

const rowToMessage = (row: MessageRow): ChatMessagePayload => ({
  id: row.id,
  roomId: row.roomId,
  senderUserId: row.senderUserId ?? undefined,
  text: row.text,
  idempotencyKey: row.idempotencyKey ?? undefined,
  createdAt: row.createdAt.toISOString(),
});
