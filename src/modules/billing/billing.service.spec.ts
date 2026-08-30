import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { createHmac } from "crypto";
import { NotificationService } from "src/modules/notification/notification.service";
import { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";

describe("BillingService", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const secret = "webhook-secret";
  const nowSeconds = 1787932800;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const webhook = (type = "INITIAL_PURCHASE", eventId = "event-1") => {
    const payload = {
      event: {
        id: eventId,
        type,
        event_timestamp_ms: 1767225601000,
        app_user_id: userId,
        product_id: "chattea_basic_monthly",
        original_transaction_id: "transaction-1",
        purchased_at_ms: 1767225600000,
        expiration_at_ms: 1769904000000,
        environment: "PRODUCTION",
        app_id: "app-chattea",
      },
    };
    return { payload, rawBody: Buffer.from(JSON.stringify(payload)) };
  };

  const signature = (rawBody: Buffer, timestamp = nowSeconds) =>
    `t=${timestamp},v1=${createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
      .digest("hex")}`;

  const createService = (
    result: "applied" | "duplicate" | "ignored" = "applied",
    configValues: Record<string, string> = {},
  ) => {
    const applyRevenueCatEvent = jest.fn<BillingRepository["applyRevenueCatEvent"]>().mockResolvedValue({
      outcome: result === "ignored" ? "stale" : result,
      balanceDelta: { boostCredits: 0, superLikeCredits: 0 },
    });
    const notify = jest.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
    const config = {
      get: jest
        .fn<(key: string) => string | undefined>()
        .mockImplementation((key) => (key === "REVENUECAT_WEBHOOK_SECRET" ? secret : configValues[key])),
    } as unknown as ConfigService;
    const service = new BillingService(
      { applyRevenueCatEvent } as unknown as BillingRepository,
      { notify } as unknown as NotificationService,
      config,
    );
    return { applyRevenueCatEvent, notify, service };
  };

  it.each([
    [new Date("2026-08-29T12:30:00.000Z"), "2026-08-29T12:30:00.000Z"],
    [undefined, null],
  ])("returns the active boost boundary as %p", async (activeBoostUntil, expected) => {
    const repository = {
      balance: jest
        .fn<
          () => Promise<{
            balance: { superLikeCredits: number; boostCredits: number };
            activeBoostUntil: Date | undefined;
          }>
        >()
        .mockResolvedValue({
          balance: { superLikeCredits: 2, boostCredits: 3 },
          activeBoostUntil,
        }),
    } as unknown as BillingRepository;
    const service = new BillingService(repository, {} as NotificationService, {} as ConfigService);

    await expect(service.balance(userId)).resolves.toEqual({
      superLikeCredits: 2,
      boostCredits: 3,
      activeBoostUntil: expected,
    });
  });

  it("records a correctly signed subscription event once before granting the plan", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const { payload, rawBody } = webhook();
    const { applyRevenueCatEvent, notify, service } = createService();

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(applyRevenueCatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        subscription: expect.objectContaining({
          planId: "basic",
          providerProductId: "chattea_basic_monthly",
          status: "active",
        }),
      }),
    );
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId, type: "purchase" }));
  });

  it.each([
    ["SANDBOX", "app-chattea"],
    ["PRODUCTION", "different-app"],
  ])("rejects a production mutation from environment %s and app %s", async (environment, appId) => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = webhook().payload;
    payload.event.environment = environment;
    payload.event.app_id = appId;
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService("applied", {
      NODE_ENV: "production",
      REVENUECAT_IOS_APP_ID: "app-chattea-ios",
      REVENUECAT_ANDROID_APP_ID: "app-chattea-android",
    });

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).rejects.toThrow(
      environment === "SANDBOX" ? "REVENUECAT_ENVIRONMENT_INVALID" : "REVENUECAT_APP_ID_INVALID",
    );
    expect(applyRevenueCatEvent).not.toHaveBeenCalled();
  });

  it.each(["app-chattea-ios", "app-chattea-android"])(
    "accepts a production mutation for configured RevenueCat app %s",
    async (appId) => {
      jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
      const payload = webhook().payload;
      payload.event.app_id = appId;
      const rawBody = Buffer.from(JSON.stringify(payload));
      const { service } = createService("applied", {
        NODE_ENV: "production",
        REVENUECAT_IOS_APP_ID: "app-chattea-ios",
        REVENUECAT_ANDROID_APP_ID: "app-chattea-android",
      });

      await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).resolves.toEqual({
        accepted: true,
        duplicate: false,
      });
    },
  );

  it("fails closed when both RevenueCat platform identifiers are configured to the same app", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = webhook().payload;
    payload.event.app_id = "app-chattea-ios";
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService("applied", {
      NODE_ENV: "production",
      REVENUECAT_IOS_APP_ID: "app-chattea-ios",
      REVENUECAT_ANDROID_APP_ID: "app-chattea-ios",
    });

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).rejects.toThrow(
      "REVENUECAT_APP_IDS_MUST_DIFFER",
    );
    expect(applyRevenueCatEvent).not.toHaveBeenCalled();
  });

  it("accepts a duplicate signed event without granting it twice", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const { payload, rawBody } = webhook();
    const { applyRevenueCatEvent, notify, service } = createService("duplicate");

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(applyRevenueCatEvent).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["TEST"])("records and accepts a signed %s event without customer or product fields", async (type) => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = { event: { id: `event-${type}`, type, event_timestamp_ms: 1767225601000 } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(applyRevenueCatEvent).toHaveBeenCalledWith({
      providerEventId: `event-${type}`,
      payloadHash: expect.any(String),
    });
  });

  it.each(["TRANSFER", "TEMPORARY_ENTITLEMENT_GRANT", "VIRTUAL_CURRENCY_TRANSACTION"])(
    "rejects an unimplemented entitlement-changing %s event without acknowledging it",
    async (type) => {
      jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
      const payload = { event: { id: `event-${type}`, type, event_timestamp_ms: 1767225601000 } };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const { applyRevenueCatEvent, service } = createService();

      await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).rejects.toThrow(
        "REVENUECAT_EVENT_TYPE_NOT_IMPLEMENTED",
      );
      expect(applyRevenueCatEvent).not.toHaveBeenCalled();
    },
  );

  it("maps a Google Play base-plan product to its canonical subscription", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = webhook().payload;
    payload.event.product_id = "chattea_gold_monthly:monthly";
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload);
    expect(applyRevenueCatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: expect.objectContaining({
          planId: "gold",
          providerProductId: "chattea_gold_monthly:monthly",
        }),
      }),
    );
  });

  it("maps a consumable purchase to a granted provider transaction", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = webhook("NON_RENEWING_PURCHASE", "event-consumable-purchase").payload;
    payload.event.product_id = "chattea_superlikes_5";
    Object.assign(payload.event, { transaction_id: "transaction-consumable-1" });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload);

    expect(applyRevenueCatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        consumableTransition: {
          canonicalProductId: "chattea_superlikes_5",
          eventTimestampMs: 1767225601000,
          originalTransactionId: "transaction-1",
          providerProductId: "chattea_superlikes_5",
          providerTransactionId: "transaction-consumable-1",
          targetState: "granted",
          units: { boostCredits: 0, superLikeCredits: 5 },
          userId,
        },
      }),
    );
  });

  it("maps a customer-support consumable cancellation to refunded", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = webhook("CANCELLATION", "event-consumable-refund").payload;
    payload.event.product_id = "chattea_superlikes_5";
    Object.assign(payload.event, {
      cancel_reason: "CUSTOMER_SUPPORT",
      transaction_id: "transaction-consumable-1",
    });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload);

    expect(applyRevenueCatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ consumableTransition: expect.objectContaining({ targetState: "refunded" }) }),
    );
  });

  it("maps a consumable refund reversal back to granted", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = webhook("REFUND_REVERSED", "event-consumable-restored").payload;
    payload.event.product_id = "chattea_superlikes_5";
    Object.assign(payload.event, { transaction_id: "transaction-consumable-1" });
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload);

    expect(applyRevenueCatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ consumableTransition: expect.objectContaining({ targetState: "granted" }) }),
    );
  });

  it("rejects a consumable purchase without a provider transaction id", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = webhook("NON_RENEWING_PURCHASE", "event-consumable-missing-transaction").payload;
    payload.event.product_id = "chattea_superlikes_5";
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).rejects.toThrow(
      "REVENUECAT_TRANSACTION_ID_REQUIRED",
    );
    expect(applyRevenueCatEvent).not.toHaveBeenCalled();
  });

  it("rejects an unknown event type explicitly", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const payload = { event: { id: "event-unknown", type: "FUTURE_EVENT" } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).rejects.toThrow(
      "REVENUECAT_EVENT_TYPE_UNSUPPORTED",
    );
    expect(applyRevenueCatEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["INITIAL_PURCHASE", "active"],
    ["RENEWAL", "active"],
    ["UNCANCELLATION", "active"],
    ["NON_RENEWING_PURCHASE", "active"],
    ["SUBSCRIPTION_EXTENDED", "active"],
    ["REFUND_REVERSED", "active"],
    ["EXPIRATION", "expired"],
    ["CANCELLATION", undefined],
    ["BILLING_ISSUE", undefined],
    ["SUBSCRIPTION_PAUSED", undefined],
    ["PRODUCT_CHANGE", undefined],
    ["INVOICE_ISSUANCE", undefined],
    ["TEST", undefined],
  ] as const)("maps %s to subscription state %s", async (eventType, expectedStatus) => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const { payload, rawBody } = webhook(eventType, `event-${eventType}`);
    const { applyRevenueCatEvent, notify, service } = createService();

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    const input = applyRevenueCatEvent.mock.calls[0]?.[0];
    const subscription = input && "subscription" in input ? input.subscription : undefined;
    expect(subscription?.status).toBe(expectedStatus);
    if (!expectedStatus) expect(notify).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "",
    `t=${nowSeconds}`,
    "v1=abc",
    `t=not-a-timestamp,v1=${"a".repeat(64)}`,
    `t=${nowSeconds},v1=not-hex`,
    `t=${nowSeconds},v1=${"a".repeat(64)},extra=value`,
  ])("rejects a missing or malformed signature header: %s", async (receivedSignature) => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const { payload, rawBody } = webhook();
    const { applyRevenueCatEvent, service } = createService();

    await expect(service.handleRevenueCatWebhook(rawBody, receivedSignature, payload)).rejects.toThrow(
      "REVENUECAT_SIGNATURE_INVALID",
    );
    expect(applyRevenueCatEvent).not.toHaveBeenCalled();
  });

  it("rejects a signature for different raw JSON bytes", async () => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const { payload, rawBody } = webhook();
    const tamperedRawBody = Buffer.from(`${rawBody.toString()} `);
    const { applyRevenueCatEvent, service } = createService();

    await expect(service.handleRevenueCatWebhook(tamperedRawBody, signature(rawBody), payload)).rejects.toThrow(
      "REVENUECAT_SIGNATURE_INVALID",
    );
    expect(applyRevenueCatEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["object event type", { type: {} }],
    ["numeric product identifier", { product_id: 42 }],
    ["string purchase timestamp", { purchased_at_ms: "tomorrow" }],
    ["out-of-range expiration timestamp", { expiration_at_ms: 8_640_000_000_000_001 }],
  ])("rejects malformed RevenueCat fields: %s", async (_label, override) => {
    jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    const base = webhook().payload.event;
    const payload = { event: { ...base, ...override } };
    const rawBody = Buffer.from(JSON.stringify(payload));
    const { applyRevenueCatEvent, service } = createService();

    await expect(service.handleRevenueCatWebhook(rawBody, signature(rawBody), payload)).rejects.toThrow(
      "REVENUECAT_EVENT_INVALID",
    );
    expect(applyRevenueCatEvent).not.toHaveBeenCalled();
  });

  it.each([-301, 301])(
    "rejects a valid signature timestamp outside the replay tolerance by %i seconds",
    async (offset) => {
      jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
      const { payload, rawBody } = webhook();
      const { applyRevenueCatEvent, service } = createService();

      await expect(
        service.handleRevenueCatWebhook(rawBody, signature(rawBody, nowSeconds + offset), payload),
      ).rejects.toThrow("REVENUECAT_SIGNATURE_TIMESTAMP_INVALID");
      expect(applyRevenueCatEvent).not.toHaveBeenCalled();
    },
  );

  it.each([-300, 300])(
    "accepts a valid signature timestamp on the replay tolerance boundary: %i seconds",
    async (offset) => {
      jest.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
      const { payload, rawBody } = webhook();
      const { service } = createService();

      await expect(
        service.handleRevenueCatWebhook(rawBody, signature(rawBody, nowSeconds + offset), payload),
      ).resolves.toEqual({ accepted: true, duplicate: false });
    },
  );
});
