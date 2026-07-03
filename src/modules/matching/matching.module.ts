import { Module } from "@nestjs/common";
import { SubscriptionModule } from "src/modules/subscription/subscription.module";
import { MatchingResolver } from "./matching.resolver";
import { MatchingRepository } from "./matching.repository";
import { MatchingService } from "./matching.service";

@Module({
  imports: [SubscriptionModule],
  providers: [MatchingResolver, MatchingService, MatchingRepository],
})
export class MatchingModule {}
