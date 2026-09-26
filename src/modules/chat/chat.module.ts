import { Module } from "@nestjs/common";
import { NotificationModule } from "src/modules/notification/notification.module";
import { ChatController } from "./chat.controller";
import { ChatResolver } from "./chat.resolver";
import { ChatRepository } from "./chat.repository";
import { ChatService } from "./chat.service";

@Module({
  imports: [NotificationModule],
  controllers: [ChatController],
  providers: [ChatResolver, ChatService, ChatRepository],
})
export class ChatModule {}
