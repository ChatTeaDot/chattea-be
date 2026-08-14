import { BadRequestException, Body, Controller, Headers, HttpCode, Post, Req } from "@nestjs/common";
import { Request } from "express";
import { BillingService } from "./billing.service";

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller("webhooks/revenuecat")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post()
  @HttpCode(200)
  receive(
    @Req() req: RawBodyRequest,
    @Headers("x-revenuecat-signature") revenueCatSignature: string | undefined,
    @Headers("x-webhook-signature") genericSignature: string | undefined,
    @Body() payload: unknown,
  ) {
    if (!req.rawBody) throw new BadRequestException("REVENUECAT_RAW_BODY_REQUIRED");
    return this.billingService.handleRevenueCatWebhook(req.rawBody, revenueCatSignature ?? genericSignature, payload);
  }
}
