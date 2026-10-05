import { Args, Context, Mutation, Query, Resolver, Subscription } from "@nestjs/graphql";
import { Inject, UseGuards } from "@nestjs/common";
import { PubSub, withFilter } from "graphql-subscriptions";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { ChatService } from "./chat.service";
import {
  BlockUserInput,
  CHAT_EVENT_TRIGGER,
  CHAT_PUB_SUB,
  ChatMessageEventPayload,
  ChatMessagePayload,
  ChatMessagesInput,
  ChatRoomPayload,
  EditChatMessageInput,
  MarkRoomReadInput,
  ReportMessageInput,
  SendChatMessageInput,
} from "./chat.types";

@Resolver()
export class ChatResolver {
  constructor(
    private readonly chatService: ChatService,
    @Inject(CHAT_PUB_SUB) private readonly pubSub: PubSub,
  ) {}

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [ChatRoomPayload])
  chatRooms(@Context("req") req: AuthRequest) {
    return this.chatService.rooms(req.user.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => [ChatMessagePayload])
  chatMessages(@Context("req") req: AuthRequest, @Args("input") input: ChatMessagesInput) {
    return this.chatService.messages(req.user.userId, input);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Subscription(() => ChatMessageEventPayload)
  async chatEvent(@Args("roomId") roomId: string, @Context("req") req: AuthRequest) {
    await this.chatService.assertRoomMember(roomId, req.user.userId);
    return withFilter(
      () => this.pubSub.asyncIterableIterator(CHAT_EVENT_TRIGGER),
      (payload?: { chatEvent: ChatMessageEventPayload }) => payload?.chatEvent.message.roomId === roomId,
    )();
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => ChatMessagePayload)
  sendChatMessage(@Context("req") req: AuthRequest, @Args("input") input: SendChatMessageInput) {
    return this.chatService.sendMessage(req.user.userId, input);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => ChatMessagePayload)
  editChatMessage(@Context("req") req: AuthRequest, @Args("input") input: EditChatMessageInput) {
    return this.chatService.editMessage(req.user.userId, input);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  deleteChatMessage(@Context("req") req: AuthRequest, @Args("messageId") messageId: string) {
    return this.chatService.deleteMessage(req.user.userId, messageId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  markChatRoomRead(@Context("req") req: AuthRequest, @Args("input") input: MarkRoomReadInput) {
    return this.chatService.markRoomRead(req.user.userId, input.roomId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  blockUser(@Context("req") req: AuthRequest, @Args("input") input: BlockUserInput) {
    return this.chatService.blockUser(req.user.userId, input.userId);
  }

  @UseGuards(JwtAccessTokenGuard)
  @Mutation(() => Boolean)
  reportChatMessage(@Context("req") req: AuthRequest, @Args("input") input: ReportMessageInput) {
    return this.chatService.reportMessage(req.user.userId, input.messageId, input.reason);
  }
}
