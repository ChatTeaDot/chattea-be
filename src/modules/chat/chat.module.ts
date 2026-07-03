import { Module } from "@nestjs/common";
import { ChatResolver } from "./chat.resolver";
import { ChatRepository } from "./chat.repository";
import { ChatService } from "./chat.service";

@Module({
  providers: [ChatResolver, ChatService, ChatRepository],
})
export class ChatModule {}
