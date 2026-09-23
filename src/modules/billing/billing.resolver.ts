import { UseGuards } from "@nestjs/common";
import { Context, Query, Resolver } from "@nestjs/graphql";
import { JwtAccessTokenGuard } from "src/guards/access-token.guard";
import { AuthRequest } from "src/modules/auth/auth.types";
import { BillingService } from "./billing.service";
import { BillingProductPayload, ConsumableBalancePayload } from "./billing.types";

@Resolver()
export class BillingResolver {
  constructor(private readonly billingService: BillingService) {}

  @Query(() => [BillingProductPayload])
  billingProducts() {
    return this.billingService.products();
  }

  @UseGuards(JwtAccessTokenGuard)
  @Query(() => ConsumableBalancePayload)
  consumableBalance(@Context("req") req: AuthRequest) {
    return this.billingService.balance(req.user.userId);
  }
}
