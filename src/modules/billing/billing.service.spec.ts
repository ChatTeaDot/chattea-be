import { ConfigService } from "@nestjs/config";
import { createHmac } from "crypto";
import { describe, expect, it, jest } from "@jest/globals";
import { NotificationService } from "src/modules/notification/notification.service";
import { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";

describe("BillingService", () => {
  const userId = "5f29b801-2c88-4b0a-97db-f68bbfa03270";
  const secret = "webhook-secret";
  const rawBody = Buffer.from(
    JSON.stringify({
      event: {
        id: "event-1",
        type: "INITIAL_PURCHASE",
        app_user_id: userId,
        product_id: "chattea_basic_monthly",
        original_transaction_id: "transaction-1",
        purchased_at_ms: 1767225600000,
        expiration_at_ms: 1769904000000,
      },
    }),
  );

  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

  it("records a signed subscription event once before granting the plan", async () => {
    const repository = {
      applyRevenueCatEvent: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
    } as unknown as BillingRepository;
    const notifications = {
      notify: jest.fn<() => Promise<void>>(),
    } as unknown as NotificationService;
    const config = {
      get: jest
        .fn<(key: string) => string | undefined>()
        .mockImplementation((key) => (key === "REVENUECAT_WEBHOOK_SECRET" ? secret : undefined)),
    } as unknown as ConfigService;
    const service = new BillingService(repository, notifications, config);

    await expect(service.handleRevenueCatWebhook(rawBody, signature, JSON.parse(rawBody.toString()))).resolves.toEqual({
      accepted: true,
      duplicate: false,
    });
    expect(repository.applyRevenueCatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        subscription: expect.objectContaining({
          planId: "basic",
          providerProductId: "chattea_basic_monthly",
          status: "active",
        }),
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ userId, type: "purchase" }));
  });

  it("accepts a duplicate signed event without granting it twice", async () => {
    const repository = {
      applyRevenueCatEvent: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
    } as unknown as BillingRepository;
    const notifications = {
      notify: jest.fn<() => Promise<void>>(),
    } as unknown as NotificationService;
    const config = {
      get: jest.fn<(key: string) => string | undefined>().mockReturnValue(secret),
    } as unknown as ConfigService;
    const service = new BillingService(repository, notifications, config);

    await expect(service.handleRevenueCatWebhook(rawBody, signature, JSON.parse(rawBody.toString()))).resolves.toEqual({
      accepted: true,
      duplicate: true,
    });
    expect(repository.applyRevenueCatEvent).toHaveBeenCalledTimes(1);
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it("rejects an invalid HMAC signature", async () => {
    const service = new BillingService(
      {} as BillingRepository,
      {} as NotificationService,
      { get: jest.fn<() => string>().mockReturnValue(secret) } as unknown as ConfigService,
    );

    await expect(service.handleRevenueCatWebhook(rawBody, "wrong", JSON.parse(rawBody.toString()))).rejects.toThrow(
      "REVENUECAT_SIGNATURE_INVALID",
    );
  });
});
