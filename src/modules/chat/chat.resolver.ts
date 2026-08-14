import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/accessToken.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { ChatService } from "./chat.service";
import {
  AiSummaryPreviewPayload,
  BlockUserInput,
  ChatMessagePayload,
  ChatMessagesInput,
  ChatRoomPayload,
  EditChatMessageInput,
  MarkRoomReadInput,
  ReportMessageInput,
  SendChatMessageInput,
  SetTypingInput,
  UnreadMessageSummaryInput,
} from "./chat.types";

@Resolver()
export class ChatResolver {
  /**
   * ChatResolver에서 사용할 ChatService 의존성을 주입한다.
   *
   * @param chatService 채팅 서비스
   */
  constructor(private readonly chatService: ChatService) {}

  /**
   * 현재 사용자의 채팅방 목록을 조회한다.
   *
   * @param req 인증 요청 객체
   * @returns 채팅방 목록
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [ChatRoomPayload])
  chatRooms(@Context("req") req: AuthRequest) {
    return this.chatService.rooms(req.user.userId);
  }

  /**
   * 채팅방 메시지를 조회한다.
   *
   * @param input 메시지 조회 입력값
   * @returns 메시지 목록
   */
  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [ChatMessagePayload])
  chatMessages(@Context("req") req: AuthRequest, @Args("input") input: ChatMessagesInput) {
    return this.chatService.messages({ ...input, userId: req.user.userId });
  }

  /**
   * 채팅 메시지를 전송한다.
   *
   * @param input 메시지 전송 입력값
   * @returns 전송된 메시지
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => ChatMessagePayload)
  sendChatMessage(@Context("req") req: AuthRequest, @Args("input") input: SendChatMessageInput) {
    return this.chatService.sendMessage({ ...input, senderUserId: req.user.userId });
  }

  /**
   * 채팅 메시지를 수정한다.
   *
   * @param input 메시지 수정 입력값
   * @returns 수정된 메시지
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => ChatMessagePayload)
  editChatMessage(@Context("req") req: AuthRequest, @Args("input") input: EditChatMessageInput) {
    return this.chatService.editMessage({ ...input, userId: req.user.userId });
  }

  /**
   * 채팅 메시지를 삭제한다.
   *
   * @param messageId 삭제할 메시지 ID
   * @returns 삭제 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  deleteChatMessage(@Context("req") req: AuthRequest, @Args("messageId") messageId: string) {
    return this.chatService.deleteMessage(messageId, req.user.userId);
  }

  /**
   * 채팅방을 읽음 처리한다.
   *
   * @param input 채팅방 읽음 입력값
   * @returns 처리 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  markChatRoomRead(@Context("req") req: AuthRequest, @Args("input") input: MarkRoomReadInput) {
    return this.chatService.markRoomRead(input.roomId, req.user.userId);
  }

  /**
   * 타이핑 상태를 설정한다.
   *
   * @param input 타이핑 상태 입력값
   * @returns 처리 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  setChatTyping(@Args("input") input: SetTypingInput) {
    return this.chatService.setTyping(input);
  }

  /**
   * 사용자를 차단한다.
   *
   * @param req 인증 요청 객체
   * @param input 차단 대상 입력값
   * @returns 처리 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  blockUser(@Context("req") req: AuthRequest, @Args("input") input: BlockUserInput) {
    return this.chatService.blockUser(req.user.userId, input.userId);
  }

  /**
   * 채팅 메시지를 신고한다.
   *
   * @param req 인증 요청 객체
   * @param input 신고 입력값
   * @returns 처리 성공 여부
   */
  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  reportChatMessage(@Context("req") req: AuthRequest, @Args("input") input: ReportMessageInput) {
    return this.chatService.reportMessage(req.user.userId, input.messageId, input.reason);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => AiSummaryPreviewPayload)
  unreadMessageSummary(@Args("input") input: UnreadMessageSummaryInput) {
    return this.chatService.unreadMessageSummary(input);
  }
}
