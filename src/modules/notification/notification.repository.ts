import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import {
  notifications,
  pushOutbox,
  pushTokens,
  type NotificationType,
  type PushOutboxStatus,
} from "src/modules/database/schema";
import { PushClaimBatch, PushReceiptResult, PushSendResult } from "./push-delivery.types";

export type CreateNotificationInput = Readonly<{
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  route?: string;
  sourceId?: string;
}>;

const OPEN_PUSH_STATUSES: PushOutboxStatus[] = ["queued", "sending", "receipt_pending", "receipt_checking"];
const IN_FLIGHT_PUSH_STATUSES: PushOutboxStatus[] = ["sending", "receipt_pending", "receipt_checking"];

@Injectable()
export class NotificationRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  list = (userId: string) =>
    this.db.query.notifications.findMany({
      where: eq(notifications.userId, userId),
      orderBy: [desc(notifications.createdAt)],
      limit: 100,
    });

  createWithPushOutbox = (input: CreateNotificationInput, enqueuePush: boolean) =>
    this.db.transaction(async (tx) => {
      const [notification] = await tx.insert(notifications).values(input).returning();
      if (!notification) throw new Error("NOTIFICATION_CREATE_FAILED");
      if (!enqueuePush) return notification;

      const tokens = await tx
        .select({ id: pushTokens.id, token: pushTokens.token })
        .from(pushTokens)
        .where(eq(pushTokens.userId, input.userId))
        .for("key share");
      if (tokens.length > 0) {
        await tx.insert(pushOutbox).values(
          tokens.map((token) => ({
            notificationId: notification.id,
            pushTokenId: token.id,
            tokenSnapshot: token.token,
            title: input.title,
            body: input.body,
            route: input.route,
          })),
        );
      }
      return notification;
    });

  markRead = async (userId: string, notificationId: string): Promise<boolean> => {
    const [notification] = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return Boolean(notification);
  };

  registerPushToken = async (input: {
    userId: string;
    deviceId: string;
    token: string;
    platform: "ios" | "android";
  }): Promise<void> => {
    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`push-token:${input.token}`}, 0))`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`push-device:${input.userId}:${input.deviceId}`}, 0))`,
      );
      const existing = await tx
        .select({
          id: pushTokens.id,
          userId: pushTokens.userId,
          deviceId: pushTokens.deviceId,
          token: pushTokens.token,
        })
        .from(pushTokens)
        .where(
          or(
            eq(pushTokens.token, input.token),
            and(eq(pushTokens.userId, input.userId), eq(pushTokens.deviceId, input.deviceId)),
          ),
        )
        .for("update");
      const deviceToken = existing.find((token) => token.userId === input.userId && token.deviceId === input.deviceId);
      const requestedToken = existing.find((token) => token.token === input.token);
      if (requestedToken && requestedToken.deviceId !== input.deviceId) {
        throw new ConflictException("PUSH_TOKEN_DEVICE_CONFLICT");
      }
      if (deviceToken?.token === input.token) {
        await tx
          .update(pushTokens)
          .set({ platform: input.platform, updatedAt: now })
          .where(eq(pushTokens.id, deviceToken.id));
        return;
      }

      if (deviceToken) {
        if (requestedToken) {
          await tx
            .update(pushOutbox)
            .set({ status: "cancelled", completedAt: now, leaseExpiresAt: null, updatedAt: now })
            .where(and(eq(pushOutbox.pushTokenId, requestedToken.id), inArray(pushOutbox.status, OPEN_PUSH_STATUSES)));
          await tx.delete(pushTokens).where(eq(pushTokens.id, requestedToken.id));
        }
        await tx
          .update(pushOutbox)
          .set({ tokenSnapshot: input.token, updatedAt: now })
          .where(and(eq(pushOutbox.pushTokenId, deviceToken.id), eq(pushOutbox.status, "queued")));
        await tx
          .update(pushOutbox)
          .set({ status: "cancelled", completedAt: now, leaseExpiresAt: null, updatedAt: now })
          .where(and(eq(pushOutbox.pushTokenId, deviceToken.id), inArray(pushOutbox.status, IN_FLIGHT_PUSH_STATUSES)));
        await tx
          .update(pushTokens)
          .set({ token: input.token, platform: input.platform, updatedAt: now })
          .where(eq(pushTokens.id, deviceToken.id));
        return;
      }

      if (requestedToken) {
        await tx
          .update(pushOutbox)
          .set({ status: "cancelled", completedAt: now, leaseExpiresAt: null, updatedAt: now })
          .where(and(eq(pushOutbox.pushTokenId, requestedToken.id), inArray(pushOutbox.status, OPEN_PUSH_STATUSES)));
        await tx.delete(pushTokens).where(eq(pushTokens.id, requestedToken.id));
      }
      await tx.insert(pushTokens).values(input);
    });
  };

  unregisterPushToken = async (input: { userId: string; deviceId: string }): Promise<boolean> => {
    return this.db.transaction(async (tx) => {
      const tokens = await tx
        .select({ id: pushTokens.id, userId: pushTokens.userId })
        .from(pushTokens)
        .where(eq(pushTokens.deviceId, input.deviceId))
        .for("update");
      const tokenIds = tokens.filter(({ userId }) => userId === input.userId).map(({ id }) => id);
      if (tokenIds.length === 0) return tokens.length === 0;
      const now = new Date();
      await tx
        .update(pushOutbox)
        .set({ status: "cancelled", completedAt: now, leaseExpiresAt: null, updatedAt: now })
        .where(and(inArray(pushOutbox.pushTokenId, tokenIds), inArray(pushOutbox.status, OPEN_PUSH_STATUSES)));
      await tx.delete(pushTokens).where(inArray(pushTokens.id, tokenIds));
      return true;
    });
  };

  claimSendBatch = (input: { now: Date; leaseExpiresAt: Date; limit: number }): Promise<PushClaimBatch> =>
    this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(pushOutbox)
        .where(sendDue(input.now))
        .orderBy(asc(pushOutbox.nextAttemptAt), asc(pushOutbox.createdAt), asc(pushOutbox.id))
        .limit(input.limit)
        .for("update", { skipLocked: true });
      const selected = candidates;
      if (selected.length === 0) return { jobs: [], hasMore: false };
      const jobs = await tx
        .update(pushOutbox)
        .set({
          status: "sending",
          sendAttempts: sql`${pushOutbox.sendAttempts} + 1`,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.now,
        })
        .where(
          inArray(
            pushOutbox.id,
            selected.map(({ id }) => id),
          ),
        )
        .returning();
      const [remaining] = await tx.select({ id: pushOutbox.id }).from(pushOutbox).where(sendDue(input.now)).limit(1);
      return { jobs, hasMore: Boolean(remaining) };
    });

  claimReceiptBatch = (input: { now: Date; leaseExpiresAt: Date; limit: number }): Promise<PushClaimBatch> =>
    this.db.transaction(async (tx) => {
      const candidates = await tx
        .select()
        .from(pushOutbox)
        .where(receiptDue(input.now))
        .orderBy(asc(pushOutbox.receiptAvailableAt), asc(pushOutbox.createdAt), asc(pushOutbox.id))
        .limit(input.limit)
        .for("update", { skipLocked: true });
      const selected = candidates;
      if (selected.length === 0) return { jobs: [], hasMore: false };
      const jobs = await tx
        .update(pushOutbox)
        .set({
          status: "receipt_checking",
          receiptAttempts: sql`${pushOutbox.receiptAttempts} + 1`,
          leaseExpiresAt: input.leaseExpiresAt,
          updatedAt: input.now,
        })
        .where(
          inArray(
            pushOutbox.id,
            selected.map(({ id }) => id),
          ),
        )
        .returning();
      const [remaining] = await tx.select({ id: pushOutbox.id }).from(pushOutbox).where(receiptDue(input.now)).limit(1);
      return { jobs, hasMore: Boolean(remaining) };
    });

  applySendResults = (results: readonly PushSendResult[], now: Date): Promise<void> =>
    this.db.transaction(async (tx) => {
      for (const result of results) {
        const values = sendResultValues(result, now);
        const [updated] = await tx
          .update(pushOutbox)
          .set(values)
          .where(
            and(
              eq(pushOutbox.id, result.id),
              eq(pushOutbox.status, "sending"),
              eq(pushOutbox.sendAttempts, result.attempt),
            ),
          )
          .returning({ id: pushOutbox.id });
        if (updated && result.invalidatePushTokenId) {
          await invalidatePushToken(tx, result.invalidatePushTokenId, result.id, now);
        }
      }
    });

  applyReceiptResults = (results: readonly PushReceiptResult[], now: Date): Promise<void> =>
    this.db.transaction(async (tx) => {
      for (const result of results) {
        const values = receiptResultValues(result, now);
        const [updated] = await tx
          .update(pushOutbox)
          .set(values)
          .where(
            and(
              eq(pushOutbox.id, result.id),
              eq(pushOutbox.status, "receipt_checking"),
              eq(pushOutbox.receiptAttempts, result.attempt),
            ),
          )
          .returning({ id: pushOutbox.id });
        if (updated && result.invalidatePushTokenId) {
          await invalidatePushToken(tx, result.invalidatePushTokenId, result.id, now);
        }
      }
    });
}

type NotificationTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const invalidatePushToken = async (
  tx: NotificationTransaction,
  pushTokenId: string,
  currentJobId: string,
  now: Date,
): Promise<void> => {
  await tx
    .update(pushOutbox)
    .set({ status: "cancelled", completedAt: now, leaseExpiresAt: null, updatedAt: now })
    .where(
      and(
        eq(pushOutbox.pushTokenId, pushTokenId),
        ne(pushOutbox.id, currentJobId),
        inArray(pushOutbox.status, OPEN_PUSH_STATUSES),
      ),
    );
  await tx.delete(pushTokens).where(eq(pushTokens.id, pushTokenId));
};

const sendResultValues = (result: PushSendResult, now: Date) => {
  if (result.kind === "accepted") {
    if (!result.ticketId || !result.receiptAvailableAt) throw new Error("EXPO_PUSH_TICKET_INVALID");
    return {
      status: "receipt_pending" as const,
      ticketId: result.ticketId,
      receiptAvailableAt: result.receiptAvailableAt,
      nextAttemptAt: result.receiptAvailableAt,
      sentAt: now,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: now,
    };
  }
  if (result.kind === "retry") {
    if (!result.nextAttemptAt) throw new Error("EXPO_PUSH_RETRY_TIME_REQUIRED");
    return {
      status: "queued" as const,
      nextAttemptAt: result.nextAttemptAt,
      leaseExpiresAt: null,
      lastErrorCode: result.errorCode,
      lastErrorMessage: result.errorMessage,
      updatedAt: now,
    };
  }
  return {
    status: result.kind === "exhausted" ? ("exhausted" as const) : ("failed_permanent" as const),
    completedAt: now,
    leaseExpiresAt: null,
    lastErrorCode: result.errorCode,
    lastErrorMessage: result.errorMessage,
    updatedAt: now,
  };
};

const receiptResultValues = (result: PushReceiptResult, now: Date) => {
  if (result.kind === "delivered") {
    return {
      status: "delivered" as const,
      completedAt: now,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      updatedAt: now,
    };
  }
  if (result.kind === "retry") {
    if (!result.nextAttemptAt) throw new Error("EXPO_PUSH_RETRY_TIME_REQUIRED");
    return {
      status: "receipt_pending" as const,
      nextAttemptAt: result.nextAttemptAt,
      leaseExpiresAt: null,
      lastErrorCode: result.errorCode,
      lastErrorMessage: result.errorMessage,
      updatedAt: now,
    };
  }
  return {
    status: result.kind === "exhausted" ? ("exhausted" as const) : ("failed_permanent" as const),
    completedAt: now,
    leaseExpiresAt: null,
    lastErrorCode: result.errorCode,
    lastErrorMessage: result.errorMessage,
    updatedAt: now,
  };
};

const sendDue = (now: Date) =>
  or(
    and(eq(pushOutbox.status, "queued"), lte(pushOutbox.nextAttemptAt, now)),
    and(eq(pushOutbox.status, "sending"), lte(pushOutbox.leaseExpiresAt, now)),
  );

const receiptDue = (now: Date) =>
  or(
    and(
      eq(pushOutbox.status, "receipt_pending"),
      lte(pushOutbox.receiptAvailableAt, now),
      lte(pushOutbox.nextAttemptAt, now),
    ),
    and(eq(pushOutbox.status, "receipt_checking"), lte(pushOutbox.leaseExpiresAt, now)),
  );
