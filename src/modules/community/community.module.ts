import { Module } from "@nestjs/common";
import { CommunityResolver } from "./community.resolver";
import { CommunityRepository } from "./community.repository";
import { CommunityService } from "./community.service";

@Module({
  providers: [CommunityResolver, CommunityService, CommunityRepository],
})
export class CommunityModule {}
