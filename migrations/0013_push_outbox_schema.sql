ALTER TABLE push_tokens
  ADD COLUMN IF NOT EXISTS "deviceId" uuid;

DELETE FROM push_tokens
  WHERE "deviceId" IS NULL;

ALTER TABLE push_tokens
  ALTER COLUMN "deviceId" SET NOT NULL;

CREATE TABLE IF NOT EXISTS push_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "notificationId" uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  "pushTokenId" uuid REFERENCES push_tokens(id) ON DELETE SET NULL,
  "tokenSnapshot" text NOT NULL,
  title varchar(80) NOT NULL,
  body text NOT NULL,
  route text,
  status varchar(30) NOT NULL DEFAULT 'queued',
  "ticketId" text,
  "sendAttempts" integer NOT NULL DEFAULT 0,
  "receiptAttempts" integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamp NOT NULL DEFAULT now(),
  "receiptAvailableAt" timestamp,
  "leaseExpiresAt" timestamp,
  "lastErrorCode" text,
  "lastErrorMessage" text,
  "sentAt" timestamp,
  "completedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT push_outbox_notification_token_unique UNIQUE ("notificationId", "pushTokenId"),
  CONSTRAINT push_outbox_status_check CHECK (
    status IN (
      'queued',
      'sending',
      'receipt_pending',
      'receipt_checking',
      'delivered',
      'failed_permanent',
      'exhausted',
      'cancelled'
    )
  ),
  CONSTRAINT push_outbox_attempts_nonnegative CHECK ("sendAttempts" >= 0 AND "receiptAttempts" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS push_outbox_ticket_unique
  ON push_outbox ("ticketId")
  WHERE "ticketId" IS NOT NULL;

CREATE INDEX IF NOT EXISTS push_outbox_send_due_idx
  ON push_outbox ("nextAttemptAt", "createdAt")
  WHERE status IN ('queued', 'sending');

CREATE INDEX IF NOT EXISTS push_outbox_receipt_due_idx
  ON push_outbox ("receiptAvailableAt", "nextAttemptAt", "createdAt")
  WHERE status IN ('receipt_pending', 'receipt_checking');
