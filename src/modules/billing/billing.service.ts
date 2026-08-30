import {
  BadRequestException,
  Injectable,
  Logger,
  NotImplementedException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NotificationService } from "src/modules/notification/notification.service";
import { BillingRepository } from "./billing.repository";

const REVENUECAT_SIGNATURE_TOLERANCE_SECONDS = 300;
const REVENUECAT_MUTATION_EVENT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "NON_RENEWING_PURCHASE",
  "SUBSCRIPTION_EXTENDED",
  "REFUND_REVERSED",
  "EXPIRATION",
  "CANCELLATION",
]);
const REVENUECAT_NOOP_EVENT_TYPES = new Set([
  "BILLING_ISSUE",
  "SUBSCRIPTION_PAUSED",
  "PRODUCT_CHANGE",
  "INVOICE_ISSUANCE",
  "EXPERIMENT_ENROLLMENT",
  "TEST",
]);
const REVENUECAT_UNIMPLEMENTED_EVENT_TYPES = new Set([
  "TRANSFER",
  "TEMPORARY_ENTITLEMENT_GRANT",
  "VIRTUAL_CURRENCY_TRANSACTION",
]);

export const BILLING_PRODUCTS = [
  { id: "chattea_basic_monthly", kind: "subscription", planId: "basic", name: "Basic" },
  { id: "chattea_gold_monthly", kind: "subscription", planId: "gold", name: "Gold" },
  { id: "chattea_black_monthly", kind: "subscription", planId: "black", name: "Black" },
  { id: "chattea_boost_30m", kind: "boost", name: "30분 부스트" },
  { id: "chattea_superlikes_5", kind: "superlike", name: "슈퍼라이크 5개" },
] as const;

type RevenueCatEvent = {
  id?: string;
  type?: string;
  event_timestamp_ms?: number;
  environment?: string;
  app_id?: string;
  app_user_id?: string;
  product_id?: string;
  original_transaction_id?: string;
  transaction_id?: string;
  cancel_reason?: string;
  expiration_at_ms?: number;
  purchased_at_ms?: number;
};

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly billingRepository: BillingRepository,
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  products = () => BILLING_PRODUCTS;

  balance = async (userId: string) => {
    const { balance, activeBoostUntil } = await this.billingRepository.balance(userId);
    return {
      superLikeCredits: balance?.superLikeCredits ?? 0,
      boostCredits: balance?.boostCredits ?? 0,
      activeBoostUntil: activeBoostUntil?.toISOString() ?? null,
    };
  };

  handleRevenueCatWebhook = async (rawBody: Buffer, signature: string | undefined, payload: unknown) => {
    this.assertSignature(rawBody, signature);
    const event = getRevenueCatEvent(payload);
    const eventId = requiredString(event.id, "REVENUECAT_EVENT_ID_REQUIRED");
    const eventType = requiredString(event.type, "REVENUECAT_EVENT_TYPE_REQUIRED").toUpperCase();
    const eventRecord = {
      providerEventId: eventId,
      payloadHash: createHash("sha256").update(rawBody).digest("hex"),
    };
    if (REVENUECAT_NOOP_EVENT_TYPES.has(eventType)) {
      const result = await this.billingRepository.applyRevenueCatEvent(eventRecord);
      return { accepted: true, duplicate: result.outcome === "duplicate" };
    }
    if (REVENUECAT_UNIMPLEMENTED_EVENT_TYPES.has(eventType)) {
      throw new NotImplementedException("REVENUECAT_EVENT_TYPE_NOT_IMPLEMENTED");
    }
    if (!REVENUECAT_MUTATION_EVENT_TYPES.has(eventType)) {
      throw new BadRequestException("REVENUECAT_EVENT_TYPE_UNSUPPORTED");
    }
    if (this.configService.get<string>("NODE_ENV") === "production") {
      const iosAppId = this.configService.get<string>("REVENUECAT_IOS_APP_ID")?.trim();
      const androidAppId = this.configService.get<string>("REVENUECAT_ANDROID_APP_ID")?.trim();
      if (!iosAppId) throw new Error("REVENUECAT_IOS_APP_ID_REQUIRED");
      if (!androidAppId) throw new Error("REVENUECAT_ANDROID_APP_ID_REQUIRED");
      if (iosAppId === androidAppId) throw new Error("REVENUECAT_APP_IDS_MUST_DIFFER");
      const allowedAppIds = new Set([iosAppId, androidAppId]);
      if (requiredString(event.environment, "REVENUECAT_ENVIRONMENT_INVALID").toUpperCase() !== "PRODUCTION") {
        throw new BadRequestException("REVENUECAT_ENVIRONMENT_INVALID");
      }
      if (!allowedAppIds.has(requiredString(event.app_id, "REVENUECAT_APP_ID_INVALID"))) {
        throw new BadRequestException("REVENUECAT_APP_ID_INVALID");
      }
    }

    const userId = requiredUuid(event.app_user_id, "REVENUECAT_APP_USER_ID_INVALID");
    const productId = requiredString(event.product_id, "REVENUECAT_PRODUCT_ID_REQUIRED");
    const basePlanSeparator = productId.indexOf(":");
    const canonicalProductId = basePlanSeparator < 0 ? productId : productId.slice(0, basePlanSeparator);
    const product = BILLING_PRODUCTS.find((candidate) => candidate.id === canonicalProductId);
    if (!product) throw new BadRequestException("REVENUECAT_PRODUCT_UNSUPPORTED");

    const subscriptionStatus = revenueCatSubscriptionStatus(eventType);
    const subscription =
      product.kind === "subscription" && subscriptionStatus
        ? {
            planId: product.planId,
            providerCustomerId: requiredString(
              event.original_transaction_id,
              "REVENUECAT_ORIGINAL_TRANSACTION_ID_REQUIRED",
            ),
            providerProductId: productId,
            eventTimestampMs: requiredTimestamp(event.event_timestamp_ms, "REVENUECAT_EVENT_TIMESTAMP_REQUIRED"),
            startsAt: event.purchased_at_ms ? new Date(event.purchased_at_ms) : new Date(),
            endsAt: event.expiration_at_ms ? new Date(event.expiration_at_ms) : undefined,
            status: subscriptionStatus,
          }
        : undefined;
    const consumableState =
      product.kind === "subscription" ? undefined : revenueCatConsumableTargetState(eventType, event.cancel_reason);
    const consumableTransition = consumableState
      ? {
          providerTransactionId: requiredString(event.transaction_id, "REVENUECAT_TRANSACTION_ID_REQUIRED"),
          originalTransactionId: requiredString(
            event.original_transaction_id,
            "REVENUECAT_ORIGINAL_TRANSACTION_ID_REQUIRED",
          ),
          userId,
          canonicalProductId,
          providerProductId: productId,
          eventTimestampMs: requiredTimestamp(event.event_timestamp_ms, "REVENUECAT_EVENT_TIMESTAMP_REQUIRED"),
          targetState: consumableState,
          units: {
            superLikeCredits: product.kind === "superlike" ? 5 : 0,
            boostCredits: product.kind === "boost" ? 1 : 0,
          },
        }
      : undefined;
    const result = await this.billingRepository.applyRevenueCatEvent(
      subscription
        ? { ...eventRecord, userId, subscription }
        : consumableTransition
          ? { ...eventRecord, consumableTransition }
          : eventRecord,
    );
    if (result.outcome === "duplicate") return { accepted: true, duplicate: true };
    if (result.outcome === "stale") return { accepted: true, duplicate: false };

    const notification =
      subscription?.status === "active"
        ? { title: `${product.name}을 시작했어요`, body: "새 혜택을 바로 이용할 수 있어요.", route: "/premium" }
        : consumableTransition?.targetState === "granted"
          ? { title: `${product.name}을 준비했어요`, body: "필요한 순간에 사용해 보세요.", route: "/profile" }
          : undefined;

    if (notification) {
      try {
        await this.notificationService.notify({ userId, type: "purchase", sourceId: eventId, ...notification });
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: "revenuecat_notification_failed",
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }

    return { accepted: true, duplicate: false };
  };

  private assertSignature = (rawBody: Buffer, signature: string | undefined): void => {
    const secret = this.configService.get<string>("REVENUECAT_WEBHOOK_SECRET");
    if (!secret) throw new Error("REVENUECAT_WEBHOOK_SECRET_REQUIRED");
    const match = signature?.match(/^t=(\d+),v1=([0-9a-f]{64})$/i);
    if (!match) throw new UnauthorizedException("REVENUECAT_SIGNATURE_INVALID");
    const timestampText = match[1];
    const receivedHex = match[2];
    if (!timestampText || !receivedHex) throw new UnauthorizedException("REVENUECAT_SIGNATURE_INVALID");
    const timestamp = Number(timestampText);
    if (!Number.isSafeInteger(timestamp)) throw new UnauthorizedException("REVENUECAT_SIGNATURE_INVALID");
    const expected = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestampText}.`), rawBody]))
      .digest();
    if (!timingSafeEqual(Buffer.from(receivedHex, "hex"), expected)) {
      throw new UnauthorizedException("REVENUECAT_SIGNATURE_INVALID");
    }
    if (Math.abs(Date.now() / 1000 - timestamp) > REVENUECAT_SIGNATURE_TOLERANCE_SECONDS) {
      throw new UnauthorizedException("REVENUECAT_SIGNATURE_TIMESTAMP_INVALID");
    }
  };
}

const getRevenueCatEvent = (payload: unknown): RevenueCatEvent => {
  if (!isRecord(payload)) throw new BadRequestException("REVENUECAT_PAYLOAD_INVALID");
  const event = "event" in payload ? payload.event : payload;
  if (!isRecord(event)) throw new BadRequestException("REVENUECAT_EVENT_INVALID");

  return {
    id: optionalString(event.id),
    type: optionalString(event.type),
    event_timestamp_ms: optionalTimestamp(event.event_timestamp_ms),
    environment: optionalString(event.environment),
    app_id: optionalString(event.app_id),
    app_user_id: optionalString(event.app_user_id),
    product_id: optionalString(event.product_id),
    original_transaction_id: optionalString(event.original_transaction_id),
    transaction_id: optionalString(event.transaction_id),
    cancel_reason: optionalString(event.cancel_reason),
    expiration_at_ms: optionalTimestamp(event.expiration_at_ms),
    purchased_at_ms: optionalTimestamp(event.purchased_at_ms),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new BadRequestException("REVENUECAT_EVENT_INVALID");
  return value;
};

const optionalTimestamp = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new BadRequestException("REVENUECAT_EVENT_INVALID");
  }
  return value;
};

const requiredString = (value: string | undefined, error: string): string => {
  const normalized = value?.trim();
  if (!normalized) throw new BadRequestException(error);
  return normalized;
};

const requiredUuid = (value: string | undefined, error: string): string => {
  const normalized = requiredString(value, error);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new BadRequestException(error);
  }
  return normalized;
};

const requiredTimestamp = (value: number | undefined, error: string): number => {
  if (value === undefined) throw new BadRequestException(error);
  return value;
};

const revenueCatConsumableTargetState = (
  eventType: string,
  cancelReason: string | undefined,
): "granted" | "refunded" | undefined => {
  if (eventType === "INITIAL_PURCHASE" || eventType === "NON_RENEWING_PURCHASE" || eventType === "REFUND_REVERSED") {
    return "granted";
  }
  if (eventType === "CANCELLATION" && cancelReason?.trim().toUpperCase() === "CUSTOMER_SUPPORT") return "refunded";
  return undefined;
};

const revenueCatSubscriptionStatus = (eventType: string): "active" | "expired" | undefined => {
  if (eventType === "EXPIRATION") return "expired";
  if (
    eventType === "INITIAL_PURCHASE" ||
    eventType === "RENEWAL" ||
    eventType === "UNCANCELLATION" ||
    eventType === "NON_RENEWING_PURCHASE" ||
    eventType === "SUBSCRIPTION_EXTENDED" ||
    eventType === "REFUND_REVERSED"
  ) {
    return "active";
  }
  return undefined;
};
