import { Module } from "@nestjs/common";
import { NotificationModule } from "src/modules/notification/notification.module";
import { CommunityResolver } from "./community.resolver";
import { CommunityRepository } from "./community.repository";
import { CommunityService } from "./community.service";

@Module({
  imports: [NotificationModule],
  providers: [CommunityResolver, CommunityService, CommunityRepository],
})
export class CommunityModule {}
