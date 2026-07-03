ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "userName" varchar(40) NOT NULL DEFAULT '';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "intro" text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_intro_length_check' AND conrelid = '"users"'::regclass
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT users_intro_length_check CHECK (char_length("intro") <= 60);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '대화',
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

INSERT INTO rooms (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', '오늘의 대화')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS room_members (
  "roomId" uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "joinedAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("roomId", "userId")
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "roomId" uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  "senderUserId" uuid REFERENCES "users"("userId") ON DELETE SET NULL,
  text text NOT NULL,
  "idempotencyKey" text UNIQUE,
  "deletedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CHECK (char_length(text) <= 90)
);

CREATE INDEX IF NOT EXISTS messages_room_created_idx ON messages ("roomId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "messageId" uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  "objectKey" text NOT NULL,
  "contentType" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS read_receipts (
  "roomId" uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "lastReadMessageId" uuid REFERENCES messages(id) ON DELETE SET NULL,
  "readAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("roomId", "userId")
);

CREATE TABLE IF NOT EXISTS user_blocks (
  "blockerUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "blockedUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("blockerUserId", "blockedUserId"),
  CHECK ("blockerUserId" <> "blockedUserId")
);

CREATE TABLE IF NOT EXISTS message_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "messageId" uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  "reporterUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  reason text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("messageId", "reporterUserId")
);

CREATE TABLE IF NOT EXISTS user_likes (
  "likerUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "likedUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("likerUserId", "likedUserId"),
  CHECK ("likerUserId" <> "likedUserId")
);

CREATE INDEX IF NOT EXISTS user_likes_liked_created_idx ON user_likes ("likedUserId", "createdAt" DESC);

CREATE TABLE IF NOT EXISTS user_liked_me_accesses (
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "periodStart" timestamp NOT NULL,
  "viewedCount" integer NOT NULL DEFAULT 0,
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "periodStart"),
  CHECK ("viewedCount" >= 0)
);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "planId" text NOT NULL,
  status text NOT NULL,
  "currentPeriodStartsAt" timestamp,
  "currentPeriodEndsAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CHECK ("planId" IN ('free', 'basic', 'gold', 'black')),
  CHECK (status IN ('active', 'canceled', 'expired'))
);

CREATE INDEX IF NOT EXISTS user_subscriptions_user_status_idx ON user_subscriptions ("userId", status, "createdAt" DESC);

CREATE TABLE IF NOT EXISTS matches (
  "userLowId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "userHighId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "roomId" uuid NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("userLowId", "userHighId"),
  CHECK ("userLowId" <> "userHighId")
);

CREATE SEQUENCE IF NOT EXISTS community_anonymous_name_seq;

CREATE TABLE IF NOT EXISTS community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "authorUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "anonymousName" text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  "deletedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CHECK (char_length(title) <= 80),
  CHECK (char_length(body) <= 1000)
);

CREATE INDEX IF NOT EXISTS community_posts_created_idx ON community_posts ("createdAt" DESC);

CREATE TABLE IF NOT EXISTS community_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "postId" uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  "authorUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "anonymousName" text NOT NULL,
  body text NOT NULL,
  "deletedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CHECK (char_length(body) <= 500)
);

CREATE INDEX IF NOT EXISTS community_comments_post_created_idx ON community_comments ("postId", "createdAt" ASC);

CREATE TABLE IF NOT EXISTS community_post_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "postId" uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  "reporterUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  reason text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  UNIQUE ("postId", "reporterUserId"),
  CHECK (char_length(reason) <= 120)
);

CREATE TABLE IF NOT EXISTS scores (
  "scorerUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  "scoredUserId" uuid NOT NULL REFERENCES "users"("userId") ON DELETE CASCADE,
  score integer NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("scorerUserId", "scoredUserId"),
  CHECK ("scorerUserId" <> "scoredUserId"),
  CHECK (score BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS scores_scored_created_idx ON scores ("scoredUserId", "createdAt" DESC);
