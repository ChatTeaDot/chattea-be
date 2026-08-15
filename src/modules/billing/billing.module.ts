import { Module } from "@nestjs/common";
import { NotificationModule } from "src/modules/notification/notification.module";
import { BillingController } from "./billing.controller";
import { BillingRepository } from "./billing.repository";
import { BillingResolver } from "./billing.resolver";
import { BillingService } from "./billing.service";

@Module({
  imports: [NotificationModule],
  controllers: [BillingController],
  providers: [BillingRepository, BillingResolver, BillingService],
})
export class BillingModule {}
