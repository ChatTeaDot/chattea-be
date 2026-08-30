DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'user_consumable_balances'::regclass
      AND contype = 'c'
      AND (
        pg_get_constraintdef(oid) LIKE '%"superLikeCredits"%'
        OR pg_get_constraintdef(oid) LIKE '%"boostCredits"%'
      )
  LOOP
    EXECUTE format('ALTER TABLE user_consumable_balances DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END
$$;

CREATE TABLE IF NOT EXISTS revenuecat_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider varchar(30) NOT NULL,
  "providerTransactionId" text NOT NULL,
  "originalTransactionId" text NOT NULL,
  "userId" uuid NOT NULL REFERENCES users("userId"),
  "canonicalProductId" text NOT NULL,
  "providerProductId" text NOT NULL,
  "superLikeUnits" integer NOT NULL,
  "boostUnits" integer NOT NULL,
  state varchar(20) NOT NULL,
  "stateEventTimestampMs" bigint NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT revenuecat_transactions_provider_transaction_unique UNIQUE (provider, "providerTransactionId"),
  CONSTRAINT revenuecat_transactions_units_nonnegative CHECK ("superLikeUnits" >= 0 AND "boostUnits" >= 0),
  CONSTRAINT revenuecat_transactions_units_present CHECK ("superLikeUnits" > 0 OR "boostUnits" > 0),
  CONSTRAINT revenuecat_transactions_state_check CHECK (state IN ('granted', 'refunded'))
);

CREATE TABLE IF NOT EXISTS revenuecat_transaction_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "providerEventId" text NOT NULL UNIQUE REFERENCES billing_events("providerEventId"),
  "revenuecatTransactionId" uuid NOT NULL REFERENCES revenuecat_transactions(id),
  "eventTimestampMs" bigint NOT NULL,
  "requestedState" varchar(20) NOT NULL,
  "effectiveState" varchar(20) NOT NULL,
  "superLikeDelta" integer NOT NULL,
  "boostDelta" integer NOT NULL,
  applied boolean NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT revenuecat_transaction_ledger_requested_state_check CHECK ("requestedState" IN ('granted', 'refunded')),
  CONSTRAINT revenuecat_transaction_ledger_effective_state_check CHECK ("effectiveState" IN ('granted', 'refunded'))
);

CREATE INDEX IF NOT EXISTS revenuecat_transaction_ledger_transaction_timestamp_idx
  ON revenuecat_transaction_ledger ("revenuecatTransactionId", "eventTimestampMs", "createdAt");
