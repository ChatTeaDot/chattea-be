import { Module } from "@nestjs/common";
import { SubscriptionResolver } from "./subscription.resolver";
import { SubscriptionRepository } from "./subscription.repository";
import { SubscriptionService } from "./subscription.service";

@Module({
  providers: [SubscriptionResolver, SubscriptionService, SubscriptionRepository],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
