ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS "providerEventTimestampMs" bigint;

UPDATE user_subscriptions
SET "providerEventTimestampMs" = floor(extract(epoch FROM "updatedAt") * 1000)::bigint
WHERE provider IS NOT NULL AND "providerEventTimestampMs" IS NULL;

WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY "userId", provider
      ORDER BY "providerEventTimestampMs" DESC NULLS LAST, "updatedAt" DESC, id DESC
    ) AS position
  FROM user_subscriptions
  WHERE provider IS NOT NULL
)
DELETE FROM user_subscriptions
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'user_subscriptions_user_provider_unique'
  ) THEN
    ALTER TABLE user_subscriptions
      ADD CONSTRAINT user_subscriptions_user_provider_unique UNIQUE ("userId", provider);
  END IF;
END
$$;
