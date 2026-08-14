import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NotificationService } from "src/modules/notification/notification.service";
import { BillingRepository } from "./billing.repository";

export const BILLING_PRODUCTS = [
  { id: "chattea_basic_monthly", kind: "subscription", planId: "basic", name: "Basic", priceKrw: 4900 },
  { id: "chattea_gold_monthly", kind: "subscription", planId: "gold", name: "Gold", priceKrw: 9900 },
  { id: "chattea_black_monthly", kind: "subscription", planId: "black", name: "Black", priceKrw: 24900 },
  { id: "chattea_boost_30m", kind: "boost", name: "30분 부스트", priceKrw: 1900 },
  { id: "chattea_superlikes_5", kind: "superlike", name: "슈퍼라이크 5개", priceKrw: 2900 },
] as const;

type RevenueCatEvent = {
  id?: string;
  type?: string;
  app_user_id?: string;
  product_id?: string;
  original_transaction_id?: string;
  expiration_at_ms?: number;
  purchased_at_ms?: number;
};

@Injectable()
export class BillingService {
  constructor(
    private readonly billingRepository: BillingRepository,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  products() {
    return BILLING_PRODUCTS;
  }

  async balance(userId: string) {
    const balance = await this.billingRepository.balance(userId);
    return {
      superLikeCredits: balance?.superLikeCredits ?? 0,
      boostCredits: balance?.boostCredits ?? 0,
    };
  }

  async handleRevenueCatWebhook(rawBody: Buffer, signature: string | undefined, payload: unknown) {
    this.assertSignature(rawBody, signature);
    const event = getRevenueCatEvent(payload);
    const eventId = requiredString(event.id, "REVENUECAT_EVENT_ID_REQUIRED");
    const userId = requiredUuid(event.app_user_id, "REVENUECAT_APP_USER_ID_INVALID");
    const productId = requiredString(event.product_id, "REVENUECAT_PRODUCT_ID_REQUIRED");
    const product = BILLING_PRODUCTS.find((candidate) => candidate.id === productId);
    if (!product) throw new Error("REVENUECAT_PRODUCT_UNSUPPORTED");

    const eventType = event.type?.toUpperCase() ?? "";
    const subscription =
      product.kind === "subscription"
        ? {
            planId: product.planId,
            providerCustomerId: event.original_transaction_id,
            providerProductId: product.id,
            startsAt: event.purchased_at_ms ? new Date(event.purchased_at_ms) : new Date(),
            endsAt: event.expiration_at_ms ? new Date(event.expiration_at_ms) : undefined,
            status: eventType === "EXPIRATION" ? ("expired" as const) : ("active" as const),
          }
        : undefined;
    const consumable =
      product.kind !== "subscription" && isPurchaseEvent(eventType)
        ? { superLikes: product.kind === "superlike" ? 5 : 0, boosts: product.kind === "boost" ? 1 : 0 }
        : undefined;
    const applied = await this.billingRepository.applyRevenueCatEvent({
      providerEventId: eventId,
      payloadHash: createHash("sha256").update(rawBody).digest("hex"),
      userId,
      subscription,
      consumable,
    });
    if (!applied) return { accepted: true, duplicate: true };

    const notification =
      product.kind === "subscription" && eventType !== "EXPIRATION"
        ? { title: `${product.name}을 시작했어요`, body: "새 혜택을 바로 이용할 수 있어요.", route: "/premium" }
        : consumable
          ? { title: `${product.name}을 준비했어요`, body: "필요한 순간에 사용해 보세요.", route: "/profile" }
          : undefined;

    if (notification) {
      try {
        await this.notificationService.notify({ userId, type: "purchase", sourceId: eventId, ...notification });
      } catch {
        // Entitlement changes must remain idempotent even when a notification delivery is unavailable.
      }
    }

    return { accepted: true, duplicate: false };
  }

  private assertSignature(rawBody: Buffer, signature: string | undefined): void {
    const secret = this.configService.get<string>("REVENUECAT_WEBHOOK_SECRET");
    if (!secret) throw new Error("REVENUECAT_WEBHOOK_SECRET_REQUIRED");
    const received = (signature ?? "").replace(/^sha256=/i, "");
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (!received || received.length !== expected.length) throw new Error("REVENUECAT_SIGNATURE_INVALID");
    if (!timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"))) {
      throw new Error("REVENUECAT_SIGNATURE_INVALID");
    }
  }
}

const getRevenueCatEvent = (payload: unknown): RevenueCatEvent => {
  if (!payload || typeof payload !== "object") throw new Error("REVENUECAT_PAYLOAD_INVALID");
  const event = "event" in payload ? (payload as { event?: unknown }).event : payload;
  if (!event || typeof event !== "object") throw new Error("REVENUECAT_EVENT_INVALID");
  return event as RevenueCatEvent;
};

const requiredString = (value: string | undefined, error: string): string => {
  const normalized = value?.trim();
  if (!normalized) throw new Error(error);
  return normalized;
};

const requiredUuid = (value: string | undefined, error: string): string => {
  const normalized = requiredString(value, error);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(error);
  }
  return normalized;
};

const isPurchaseEvent = (eventType: string): boolean =>
  eventType === "INITIAL_PURCHASE" || eventType === "NON_RENEWING_PURCHASE";
