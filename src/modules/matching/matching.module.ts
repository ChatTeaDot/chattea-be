import { Module } from "@nestjs/common";
import { NotificationModule } from "src/modules/notification/notification.module";
import { UserModule } from "src/modules/user/user.module";
import { MatchingResolver } from "./matching.resolver";
import { MatchingRepository } from "./matching.repository";
import { MatchingService } from "./matching.service";

@Module({
  imports: [UserModule, NotificationModule],
  providers: [MatchingResolver, MatchingService, MatchingRepository],
})
export class MatchingModule {}
