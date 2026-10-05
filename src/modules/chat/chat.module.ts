import { Module } from "@nestjs/common";
import { PubSub } from "graphql-subscriptions";
import { NotificationModule } from "src/modules/notification/notification.module";
import { ChatResolver } from "./chat.resolver";
import { ChatRepository } from "./chat.repository";
import { ChatService } from "./chat.service";
import { CHAT_PUB_SUB } from "./chat.types";

@Module({
  imports: [NotificationModule],
  providers: [ChatResolver, ChatService, ChatRepository, { provide: CHAT_PUB_SUB, useValue: new PubSub() }],
})
export class ChatModule {}
