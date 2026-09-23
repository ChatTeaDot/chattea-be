import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationType } from "src/modules/database/schema";
import { ExpoPushGateway } from "./expo-push.gateway";
import { NotificationRepository } from "./notification.repository";
import {
  EXPO_RECEIPT_DELAY_MS,
  MaintenanceBatchResult,
  MAX_EXPO_MESSAGES_PER_REQUEST,
  MAX_PUSH_RECEIPT_ATTEMPTS,
  MAX_PUSH_SEND_ATTEMPTS,
  PUSH_LEASE_MS,
  PushReceiptResult,
  PushSendResult,
} from "./push-delivery.types";

const EMPTY_BATCH: MaintenanceBatchResult = {
  claimed: 0,
  succeeded: 0,
  retryScheduled: 0,
  permanentlyFailed: 0,
  hasMore: false,
};

@Injectable()
export class NotificationService {
  constructor(
    private readonly notificationRepository: NotificationRepository,
    private readonly configService: ConfigService,
    private readonly expoPushGateway: ExpoPushGateway = new ExpoPushGateway(configService),
  ) {}

  list = async (userId: string) => {
    const notificationRows = await this.notificationRepository.list(userId);
    return notificationRows.map((notification) => ({
      ...notification,
      route: notification.route ?? undefined,
      readAt: notification.readAt?.toISOString(),
      createdAt: notification.createdAt.toISOString(),
    }));
  };

  notify = (input: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    route?: string;
    sourceId?: string;
  }) => this.notificationRepository.createWithPushOutbox(input, this.pushEnabled());

  markRead = (userId: string, notificationId: string) => this.notificationRepository.markRead(userId, notificationId);

  registerPushToken = async (
    userId: string,
    deviceId: string,
    input: { token: string; platform: string },
  ): Promise<boolean> => {
    const token = input.token.trim();
    const platform = input.platform.trim().toLowerCase();
    if (!this.expoPushGateway.isValidToken(token)) throw new Error("PUSH_TOKEN_INVALID");
    if (platform !== "ios" && platform !== "android") throw new Error("PUSH_PLATFORM_INVALID");
    await this.notificationRepository.registerPushToken({ userId, deviceId, token, platform });
    return true;
  };

  unregisterPushToken = (userId: string, deviceId: string): Promise<boolean> =>
    this.notificationRepository.unregisterPushToken({ userId, deviceId });

  processPushOutboxBatch = async (input: { now: Date; limit: number }): Promise<MaintenanceBatchResult> => {
    if (!this.pushEnabled()) return EMPTY_BATCH;
    const limit = validateBatchLimit(input.limit);
    const claimed = await this.notificationRepository.claimSendBatch({
      now: input.now,
      limit,
      leaseExpiresAt: new Date(input.now.getTime() + PUSH_LEASE_MS),
    });
    if (claimed.jobs.length === 0) return { ...EMPTY_BATCH, hasMore: claimed.hasMore };

    let results: readonly PushSendResult[];
    try {
      const tickets = await this.expoPushGateway.send(
        claimed.jobs.map((job) => ({
          to: job.tokenSnapshot,
          title: job.title,
          body: job.body,
          data: job.route ? { route: job.route } : undefined,
          sound: "default",
        })),
      );
      results =
        tickets.length === claimed.jobs.length
          ? claimed.jobs.map((job, index) => ticketResult(job, tickets[index], input.now))
          : claimed.jobs.map((job) => retrySendResult(job, input.now, "ExpoTicketCountMismatch"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "EXPO_PUSH_SEND_FAILED";
      results = claimed.jobs.map((job) => retrySendResult(job, input.now, "ExpoRequestFailed", message));
    }
    await this.notificationRepository.applySendResults(results, input.now);
    return summarizeSendResults(results, claimed.hasMore);
  };

  processPushReceiptBatch = async (input: { now: Date; limit: number }): Promise<MaintenanceBatchResult> => {
    if (!this.pushEnabled()) return EMPTY_BATCH;
    const limit = validateBatchLimit(input.limit);
    const claimed = await this.notificationRepository.claimReceiptBatch({
      now: input.now,
      limit,
      leaseExpiresAt: new Date(input.now.getTime() + PUSH_LEASE_MS),
    });
    if (claimed.jobs.length === 0) return { ...EMPTY_BATCH, hasMore: claimed.hasMore };

    const ticketIds = claimed.jobs.flatMap((job) => (job.ticketId ? [job.ticketId] : []));
    let results: readonly PushReceiptResult[];
    if (ticketIds.length !== claimed.jobs.length) {
      results = claimed.jobs.map((job) =>
        job.ticketId
          ? retryReceiptResult(job, input.now, "ExpoReceiptBatchInvalid")
          : { id: job.id, attempt: job.receiptAttempts, kind: "permanent", errorCode: "ExpoTicketMissing" },
      );
    } else {
      try {
        const receipts = await this.expoPushGateway.getReceipts(ticketIds);
        results = claimed.jobs.map((job) => receiptResult(job, receipts.get(job.ticketId ?? ""), input.now));
      } catch (error) {
        const message = error instanceof Error ? error.message : "EXPO_PUSH_RECEIPT_FAILED";
        results = claimed.jobs.map((job) => retryReceiptResult(job, input.now, "ExpoReceiptRequestFailed", message));
      }
    }
    await this.notificationRepository.applyReceiptResults(results, input.now);
    return summarizeReceiptResults(results, claimed.hasMore);
  };

  private pushEnabled = (): boolean => this.configService.get<boolean>("EXPO_PUSH_ENABLED") === true;
}

type PushJob = Awaited<ReturnType<NotificationRepository["claimSendBatch"]>>["jobs"][number];

const validateBatchLimit = (limit: number): number => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPO_MESSAGES_PER_REQUEST) {
    throw new Error("PUSH_BATCH_LIMIT_INVALID");
  }
  return limit;
};

const ticketResult = (
  job: PushJob,
  ticket: Awaited<ReturnType<ExpoPushGateway["send"]>>[number] | undefined,
  now: Date,
): PushSendResult => {
  if (!ticket) return retrySendResult(job, now, "ExpoTicketMissing");
  if (ticket.status === "ok") {
    return {
      id: job.id,
      attempt: job.sendAttempts,
      kind: "accepted",
      ticketId: ticket.id,
      receiptAvailableAt: new Date(now.getTime() + EXPO_RECEIPT_DELAY_MS),
    };
  }
  if (ticket.errorCode === "MessageRateExceeded" || ticket.errorCode === "ProviderError") {
    return retrySendResult(job, now, ticket.errorCode, ticket.message);
  }
  return {
    id: job.id,
    attempt: job.sendAttempts,
    kind: "permanent",
    errorCode: ticket.errorCode ?? "ExpoTicketRejected",
    errorMessage: ticket.message,
    ...(ticket.errorCode === "DeviceNotRegistered" && job.pushTokenId
      ? { invalidatePushTokenId: job.pushTokenId }
      : {}),
  };
};

const retrySendResult = (job: PushJob, now: Date, errorCode: string, errorMessage?: string): PushSendResult =>
  job.sendAttempts >= MAX_PUSH_SEND_ATTEMPTS
    ? { id: job.id, attempt: job.sendAttempts, kind: "exhausted", errorCode, errorMessage }
    : {
        id: job.id,
        attempt: job.sendAttempts,
        kind: "retry",
        nextAttemptAt: retryAt(now, job.sendAttempts),
        errorCode,
        errorMessage,
      };

const receiptResult = (
  job: PushJob,
  receipt: Awaited<ReturnType<ExpoPushGateway["getReceipts"]>> extends ReadonlyMap<string, infer Value>
    ? Value | undefined
    : never,
  now: Date,
): PushReceiptResult => {
  if (!receipt) return retryReceiptResult(job, now, "ExpoReceiptMissing");
  if (receipt.status === "ok") return { id: job.id, attempt: job.receiptAttempts, kind: "delivered" };
  return {
    id: job.id,
    attempt: job.receiptAttempts,
    kind: "permanent",
    errorCode: receipt.errorCode ?? "ExpoReceiptRejected",
    errorMessage: receipt.message,
    ...(receipt.errorCode === "DeviceNotRegistered" && job.pushTokenId
      ? { invalidatePushTokenId: job.pushTokenId }
      : {}),
  };
};

const retryReceiptResult = (job: PushJob, now: Date, errorCode: string, errorMessage?: string): PushReceiptResult =>
  job.receiptAttempts >= MAX_PUSH_RECEIPT_ATTEMPTS
    ? { id: job.id, attempt: job.receiptAttempts, kind: "exhausted", errorCode, errorMessage }
    : {
        id: job.id,
        attempt: job.receiptAttempts,
        kind: "retry",
        nextAttemptAt: retryAt(now, job.receiptAttempts),
        errorCode,
        errorMessage,
      };

const retryAt = (now: Date, attempt: number): Date =>
  new Date(now.getTime() + Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 60 * 60 * 1000));

const summarizeSendResults = (results: readonly PushSendResult[], hasMore: boolean): MaintenanceBatchResult => ({
  claimed: results.length,
  succeeded: results.filter(({ kind }) => kind === "accepted").length,
  retryScheduled: results.filter(({ kind }) => kind === "retry").length,
  permanentlyFailed: results.filter(({ kind }) => kind === "permanent" || kind === "exhausted").length,
  hasMore,
});

const summarizeReceiptResults = (results: readonly PushReceiptResult[], hasMore: boolean): MaintenanceBatchResult => ({
  claimed: results.length,
  succeeded: results.filter(({ kind }) => kind === "delivered").length,
  retryScheduled: results.filter(({ kind }) => kind === "retry").length,
  permanentlyFailed: results.filter(({ kind }) => kind === "permanent" || kind === "exhausted").length,
  hasMore,
});
