import { ConfigService } from "@nestjs/config";
import { describe, expect, it, jest } from "@jest/globals";
import { PushOutbox } from "src/modules/database/schema";
import { ExpoPushGateway } from "./expo-push.gateway";
import { NotificationRepository } from "./notification.repository";
import { NotificationService } from "./notification.service";

const NOW = new Date("2026-08-29T00:00:00.000Z");

const pushJob = (input: Partial<PushOutbox> = {}): PushOutbox => ({
  id: "0198f26b-f32b-7fc8-93c5-a67b827ecb27",
  notificationId: "0198f26b-f32b-7fc8-93c5-a67b827ecb28",
  pushTokenId: "0198f26b-f32b-7fc8-93c5-a67b827ecb29",
  tokenSnapshot: "ExpoPushToken[device]",
  title: "title",
  body: "body",
  route: "/matches/0198f26b-f32b-7fc8-93c5-a67b827ecb30",
  status: "sending",
  ticketId: null,
  sendAttempts: 1,
  receiptAttempts: 0,
  nextAttemptAt: NOW,
  receiptAvailableAt: null,
  leaseExpiresAt: new Date("2026-08-29T00:01:00.000Z"),
  lastErrorCode: null,
  lastErrorMessage: null,
  sentAt: null,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...input,
});

const createService = (pushEnabled: boolean) => {
  const notification = {
    id: "0198f26b-f32b-7fc8-93c5-a67b827ecb27",
    userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
    type: "match" as const,
    title: "title",
    body: "body",
    route: null,
    sourceId: null,
    readAt: null,
    createdAt: NOW,
  };
  const repository = {
    applyReceiptResults: jest.fn<NotificationRepository["applyReceiptResults"]>().mockResolvedValue(undefined),
    applySendResults: jest.fn<NotificationRepository["applySendResults"]>().mockResolvedValue(undefined),
    claimReceiptBatch: jest
      .fn<NotificationRepository["claimReceiptBatch"]>()
      .mockResolvedValue({ jobs: [], hasMore: false }),
    claimSendBatch: jest.fn<NotificationRepository["claimSendBatch"]>().mockResolvedValue({ jobs: [], hasMore: false }),
    createWithPushOutbox: jest.fn<NotificationRepository["createWithPushOutbox"]>().mockResolvedValue(notification),
    registerPushToken: jest.fn<NotificationRepository["registerPushToken"]>().mockResolvedValue(undefined),
    unregisterPushToken: jest.fn<NotificationRepository["unregisterPushToken"]>().mockResolvedValue(true),
  };
  const config = {
    get: (key: string) => (key === "EXPO_PUSH_ENABLED" ? pushEnabled : undefined),
  } as ConfigService;
  const gateway = {
    getReceipts: jest.fn<ExpoPushGateway["getReceipts"]>().mockResolvedValue(new Map()),
    isValidToken: jest.fn<ExpoPushGateway["isValidToken"]>().mockReturnValue(true),
    send: jest.fn<ExpoPushGateway["send"]>().mockResolvedValue([]),
  };
  const service = new NotificationService(
    repository as unknown as NotificationRepository,
    config,
    gateway as unknown as ExpoPushGateway,
  );
  return { gateway, notification, repository, service };
};

describe("NotificationService", () => {
  it("persists an enabled push job without calling Expo from the domain request", async () => {
    const { gateway, notification, repository, service } = createService(true);

    await expect(
      service.notify({ userId: notification.userId, type: "match", title: "title", body: "body" }),
    ).resolves.toBe(notification);

    expect(gateway.send).not.toHaveBeenCalled();
    expect(repository.createWithPushOutbox).toHaveBeenCalledWith(
      { userId: notification.userId, type: "match", title: "title", body: "body" },
      true,
    );
  });

  it("preserves the in-app notification without an outbox job when push is disabled", async () => {
    const { notification, repository, service } = createService(false);

    await expect(
      service.notify({ userId: notification.userId, type: "match", title: "title", body: "body" }),
    ).resolves.toBe(notification);
    expect(repository.createWithPushOutbox).toHaveBeenCalledWith(
      { userId: notification.userId, type: "match", title: "title", body: "body" },
      false,
    );
  });

  it("binds a valid Expo token to the authenticated installation", async () => {
    const { repository, service } = createService(true);

    await expect(
      service.registerPushToken("5f29b801-2c88-4b0a-97db-f68bbfa03270", "a47ac10b-58cc-4372-a567-0e02b2c3d479", {
        token: " ExpoPushToken[device] ",
        platform: " IOS ",
      }),
    ).resolves.toBe(true);
    expect(repository.registerPushToken).toHaveBeenCalledWith({
      userId: "5f29b801-2c88-4b0a-97db-f68bbfa03270",
      deviceId: "a47ac10b-58cc-4372-a567-0e02b2c3d479",
      token: "ExpoPushToken[device]",
      platform: "ios",
    });
  });

  it("propagates a token installation conflict without reporting registration success", async () => {
    const { repository, service } = createService(true);
    repository.registerPushToken.mockRejectedValue(new Error("PUSH_TOKEN_DEVICE_CONFLICT"));

    await expect(
      service.registerPushToken("attacker", "attacker-device", {
        token: "ExpoPushToken[victim]",
        platform: "ios",
      }),
    ).rejects.toThrow("PUSH_TOKEN_DEVICE_CONFLICT");
    expect(repository.registerPushToken).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid tokens and platforms before persistence", async () => {
    const invalidToken = createService(true);
    invalidToken.gateway.isValidToken.mockReturnValue(false);

    await expect(
      invalidToken.service.registerPushToken("user", "device", { token: "invalid", platform: "ios" }),
    ).rejects.toThrow("PUSH_TOKEN_INVALID");

    const invalidPlatform = createService(true);
    await expect(
      invalidPlatform.service.registerPushToken("user", "device", {
        token: "ExpoPushToken[device]",
        platform: "windows",
      }),
    ).rejects.toThrow("PUSH_PLATFORM_INVALID");
    expect(invalidToken.repository.registerPushToken).not.toHaveBeenCalled();
    expect(invalidPlatform.repository.registerPushToken).not.toHaveBeenCalled();
  });

  it("never claims or sends push work when delivery is disabled", async () => {
    const { gateway, repository, service } = createService(false);

    await expect(service.processPushOutboxBatch({ now: NOW, limit: 100 })).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      retryScheduled: 0,
      permanentlyFailed: 0,
      hasMore: false,
    });
    await expect(service.processPushReceiptBatch({ now: NOW, limit: 100 })).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      retryScheduled: 0,
      permanentlyFailed: 0,
      hasMore: false,
    });
    expect(repository.claimSendBatch).not.toHaveBeenCalled();
    expect(repository.claimReceiptBatch).not.toHaveBeenCalled();
    expect(gateway.send).not.toHaveBeenCalled();
    expect(gateway.getReceipts).not.toHaveBeenCalled();
  });

  it("enforces the Expo batch boundary before claiming rows", async () => {
    const { repository, service } = createService(true);

    await expect(service.processPushOutboxBatch({ now: NOW, limit: 101 })).rejects.toThrow("PUSH_BATCH_LIMIT_INVALID");
    await expect(service.processPushReceiptBatch({ now: NOW, limit: 0 })).rejects.toThrow("PUSH_BATCH_LIMIT_INVALID");
    expect(repository.claimSendBatch).not.toHaveBeenCalled();
    expect(repository.claimReceiptBatch).not.toHaveBeenCalled();
  });

  it("maps every Expo ticket to its claimed row in order", async () => {
    const { gateway, repository, service } = createService(true);
    const jobs = [
      pushJob({ id: "0198f26b-f32b-7fc8-93c5-a67b827ecb31" }),
      pushJob({ id: "0198f26b-f32b-7fc8-93c5-a67b827ecb32", pushTokenId: null }),
      pushJob({ id: "0198f26b-f32b-7fc8-93c5-a67b827ecb33" }),
    ];
    repository.claimSendBatch.mockResolvedValue({ jobs, hasMore: true });
    gateway.send.mockResolvedValue([
      { status: "ok", id: "ticket-1" },
      { status: "error", message: "slow", errorCode: "MessageRateExceeded" },
      { status: "error", message: "gone", errorCode: "DeviceNotRegistered" },
    ]);

    await expect(service.processPushOutboxBatch({ now: NOW, limit: 3 })).resolves.toEqual({
      claimed: 3,
      succeeded: 1,
      retryScheduled: 1,
      permanentlyFailed: 1,
      hasMore: true,
    });
    expect(gateway.send).toHaveBeenCalledWith(
      jobs.map((job) => ({
        to: job.tokenSnapshot,
        title: job.title,
        body: job.body,
        data: { route: job.route },
        sound: "default",
      })),
    );
    expect(repository.applySendResults).toHaveBeenCalledWith(
      [
        {
          id: "0198f26b-f32b-7fc8-93c5-a67b827ecb31",
          attempt: 1,
          kind: "accepted",
          ticketId: "ticket-1",
          receiptAvailableAt: new Date("2026-08-29T00:15:00.000Z"),
        },
        {
          id: "0198f26b-f32b-7fc8-93c5-a67b827ecb32",
          attempt: 1,
          kind: "retry",
          nextAttemptAt: new Date("2026-08-29T00:00:30.000Z"),
          errorCode: "MessageRateExceeded",
          errorMessage: "slow",
        },
        {
          id: "0198f26b-f32b-7fc8-93c5-a67b827ecb33",
          attempt: 1,
          kind: "permanent",
          errorCode: "DeviceNotRegistered",
          errorMessage: "gone",
          invalidatePushTokenId: "0198f26b-f32b-7fc8-93c5-a67b827ecb29",
        },
      ],
      NOW,
    );
  });

  it("retries a failed request and exhausts a row at the configured attempt limit", async () => {
    const { gateway, repository, service } = createService(true);
    const retryable = pushJob({ id: "0198f26b-f32b-7fc8-93c5-a67b827ecb31", sendAttempts: 4 });
    const exhausted = pushJob({ id: "0198f26b-f32b-7fc8-93c5-a67b827ecb32", sendAttempts: 5 });
    repository.claimSendBatch.mockResolvedValue({ jobs: [retryable, exhausted], hasMore: false });
    gateway.send.mockRejectedValue(new Error("timeout"));

    await expect(service.processPushOutboxBatch({ now: NOW, limit: 2 })).resolves.toEqual({
      claimed: 2,
      succeeded: 0,
      retryScheduled: 1,
      permanentlyFailed: 1,
      hasMore: false,
    });
    expect(repository.applySendResults).toHaveBeenCalledWith(
      [
        {
          id: retryable.id,
          attempt: 4,
          kind: "retry",
          nextAttemptAt: new Date("2026-08-29T00:04:00.000Z"),
          errorCode: "ExpoRequestFailed",
          errorMessage: "timeout",
        },
        {
          id: exhausted.id,
          attempt: 5,
          kind: "exhausted",
          errorCode: "ExpoRequestFailed",
          errorMessage: "timeout",
        },
      ],
      NOW,
    );
  });

  it("checks receipts without resending and invalidates a rejected installation", async () => {
    const { gateway, repository, service } = createService(true);
    const delivered = pushJob({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb31",
      status: "receipt_checking",
      ticketId: "ticket-1",
      receiptAttempts: 1,
    });
    const invalid = pushJob({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb32",
      status: "receipt_checking",
      ticketId: "ticket-2",
      receiptAttempts: 1,
    });
    repository.claimReceiptBatch.mockResolvedValue({ jobs: [delivered, invalid], hasMore: false });
    gateway.getReceipts.mockResolvedValue(
      new Map([
        ["ticket-1", { status: "ok" as const }],
        ["ticket-2", { status: "error" as const, message: "gone", errorCode: "DeviceNotRegistered" }],
      ]),
    );

    await expect(service.processPushReceiptBatch({ now: NOW, limit: 2 })).resolves.toEqual({
      claimed: 2,
      succeeded: 1,
      retryScheduled: 0,
      permanentlyFailed: 1,
      hasMore: false,
    });
    expect(gateway.send).not.toHaveBeenCalled();
    expect(gateway.getReceipts).toHaveBeenCalledWith(["ticket-1", "ticket-2"]);
    expect(repository.applyReceiptResults).toHaveBeenCalledWith(
      [
        { id: delivered.id, attempt: 1, kind: "delivered" },
        {
          id: invalid.id,
          attempt: 1,
          kind: "permanent",
          errorCode: "DeviceNotRegistered",
          errorMessage: "gone",
          invalidatePushTokenId: "0198f26b-f32b-7fc8-93c5-a67b827ecb29",
        },
      ],
      NOW,
    );
  });

  it("retries missing receipts and exhausts them at the configured limit", async () => {
    const { repository, service } = createService(true);
    const retryable = pushJob({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb31",
      status: "receipt_checking",
      ticketId: "ticket-1",
      receiptAttempts: 7,
    });
    const exhausted = pushJob({
      id: "0198f26b-f32b-7fc8-93c5-a67b827ecb32",
      status: "receipt_checking",
      ticketId: "ticket-2",
      receiptAttempts: 8,
    });
    repository.claimReceiptBatch.mockResolvedValue({ jobs: [retryable, exhausted], hasMore: false });

    await expect(service.processPushReceiptBatch({ now: NOW, limit: 2 })).resolves.toEqual({
      claimed: 2,
      succeeded: 0,
      retryScheduled: 1,
      permanentlyFailed: 1,
      hasMore: false,
    });
    expect(repository.applyReceiptResults).toHaveBeenCalledWith(
      [
        {
          id: retryable.id,
          attempt: 7,
          kind: "retry",
          nextAttemptAt: new Date("2026-08-29T00:32:00.000Z"),
          errorCode: "ExpoReceiptMissing",
          errorMessage: undefined,
        },
        {
          id: exhausted.id,
          attempt: 8,
          kind: "exhausted",
          errorCode: "ExpoReceiptMissing",
          errorMessage: undefined,
        },
      ],
      NOW,
    );
  });
});
