import { Module } from "@nestjs/common";
import { ExpoPushGateway } from "./expo-push.gateway";
import { NotificationRepository } from "./notification.repository";
import { NotificationResolver } from "./notification.resolver";
import { NotificationService } from "./notification.service";

@Module({
  providers: [ExpoPushGateway, NotificationRepository, NotificationResolver, NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
