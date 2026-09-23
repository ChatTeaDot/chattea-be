import { PushOutbox } from "src/modules/database/schema";

export const MAX_EXPO_MESSAGES_PER_REQUEST = 100;
export const EXPO_RECEIPT_DELAY_MS = 15 * 60 * 1000;
export const PUSH_LEASE_MS = 60 * 1000;
export const MAX_PUSH_SEND_ATTEMPTS = 5;
export const MAX_PUSH_RECEIPT_ATTEMPTS = 8;

export type MaintenanceBatchResult = Readonly<{
  claimed: number;
  succeeded: number;
  retryScheduled: number;
  permanentlyFailed: number;
  hasMore: boolean;
}>;

export type PushClaimBatch = Readonly<{
  jobs: readonly PushOutbox[];
  hasMore: boolean;
}>;

export type ExpoGatewayTicket =
  Readonly<{ status: "ok"; id: string }> | Readonly<{ status: "error"; message: string; errorCode?: string }>;

export type ExpoGatewayReceipt =
  Readonly<{ status: "ok" }> | Readonly<{ status: "error"; message: string; errorCode?: string }>;

export type PushSendResult = Readonly<{
  id: string;
  attempt: number;
  kind: "accepted" | "retry" | "permanent" | "exhausted";
  ticketId?: string;
  receiptAvailableAt?: Date;
  nextAttemptAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  invalidatePushTokenId?: string;
}>;

export type PushReceiptResult = Readonly<{
  id: string;
  attempt: number;
  kind: "delivered" | "retry" | "permanent" | "exhausted";
  nextAttemptAt?: Date;
  errorCode?: string;
  errorMessage?: string;
  invalidatePushTokenId?: string;
}>;
