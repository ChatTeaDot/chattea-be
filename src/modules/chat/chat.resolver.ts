import { Args, Context, Mutation, Query, Resolver } from "@nestjs/graphql";
import { UseGuards } from "@nestjs/common";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { ChatService } from "./chat.service";
import {
  BlockUserInput,
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
  constructor(private readonly chatService: ChatService) {}

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
