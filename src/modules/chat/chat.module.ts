import { Module } from "@nestjs/common";
import { NotificationModule } from "src/modules/notification/notification.module";
import { ChatResolver } from "./chat.resolver";
import { ChatRepository } from "./chat.repository";
import { ChatService } from "./chat.service";

@Module({
  imports: [NotificationModule],
  providers: [ChatResolver, ChatService, ChatRepository],
})
export class ChatModule {}
