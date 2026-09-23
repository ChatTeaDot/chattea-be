ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "birthDate" date,
  ADD COLUMN IF NOT EXISTS region varchar(20),
  ADD COLUMN IF NOT EXISTS "interestedGender" varchar(20),
  ADD COLUMN IF NOT EXISTS "profileCompletedAt" timestamp,
  ADD COLUMN IF NOT EXISTS "hiddenAt" timestamp,
  ADD COLUMN IF NOT EXISTS "deletionScheduledAt" timestamp,
  ADD COLUMN IF NOT EXISTS "deletedAt" timestamp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_interested_gender_check' AND conrelid = '"users"'::regclass
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT users_interested_gender_check
      CHECK ("interestedGender" IS NULL OR "interestedGender" IN ('male', 'female', 'everyone'));
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS user_profile_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  url text NOT NULL,
  position integer NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("userId", position),
  CHECK (position BETWEEN 0 AND 2)
);

CREATE TABLE IF NOT EXISTS match_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actorUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "targetUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  action varchar(20) NOT NULL,
  "revertedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CHECK ("actorUserId" <> "targetUserId"),
  CHECK (action IN ('skip', 'like', 'superlike'))
);

CREATE INDEX IF NOT EXISTS match_actions_actor_active_idx
  ON match_actions ("actorUserId", "createdAt" DESC)
  WHERE "revertedAt" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS match_actions_actor_target_active_unique
  ON match_actions ("actorUserId", "targetUserId")
  WHERE "revertedAt" IS NULL;

CREATE TABLE IF NOT EXISTS user_consumable_balances (
  "userId" uuid PRIMARY KEY REFERENCES "users"("userId") ON DELETE CASCADE,
  "superLikeCredits" integer NOT NULL DEFAULT 0,
  "boostCredits" integer NOT NULL DEFAULT 0,
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CHECK ("superLikeCredits" >= 0),
  CHECK ("boostCredits" >= 0)
);

CREATE TABLE IF NOT EXISTS user_boosts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  source text NOT NULL,
  "startsAt" timestamp NOT NULL,
  "endsAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CHECK ("endsAt" > "startsAt")
);

CREATE INDEX IF NOT EXISTS user_boosts_user_active_idx ON user_boosts ("userId", "endsAt" DESC);

ALTER TABLE user_subscriptions
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS "providerCustomerId" text,
  ADD COLUMN IF NOT EXISTS "providerProductId" text;

CREATE TABLE IF NOT EXISTS billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "providerEventId" text NOT NULL UNIQUE,
  provider varchar(30) NOT NULL,
  "payloadHash" text NOT NULL,
  "receivedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  type varchar(20) NOT NULL,
  title varchar(80) NOT NULL,
  body text NOT NULL,
  route text,
  "sourceId" text,
  "readAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CHECK (type IN ('like', 'match', 'message', 'comment', 'purchase'))
);

CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications ("userId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform varchar(20) NOT NULL,
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  "createdAt" timestamp NOT NULL DEFAULT now(),
  CHECK (platform IN ('ios', 'android'))
);

CREATE INDEX IF NOT EXISTS users_pending_deletion_idx
  ON "users" ("deletionScheduledAt")
  WHERE "deletionScheduledAt" IS NOT NULL AND "deletedAt" IS NULL;

CREATE TABLE IF NOT EXISTS community_comment_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "commentId" uuid NOT NULL REFERENCES community_comments(id) ON DELETE CASCADE,
  "reporterUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  reason text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("commentId", "reporterUserId")
);
