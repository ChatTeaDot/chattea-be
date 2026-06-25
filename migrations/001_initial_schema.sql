CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text UNIQUE,
  nickname text NOT NULL,
  intro text NOT NULL DEFAULT '',
  terms_accepted_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(intro) <= 60)
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS intro text NOT NULL DEFAULT '';

UPDATE users SET intro = COALESCE(intro, '')
WHERE intro IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_intro_length_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_intro_length_check CHECK (char_length(intro) <= 60);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS auth_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS phone_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164 text NOT NULL,
  code_hash text NOT NULL,
  purpose text NOT NULL,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  request_ip_hash text,
  user_agent_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS phone_verifications_phone_created_idx ON phone_verifications (phone_e164, created_at DESC);
CREATE INDEX IF NOT EXISTS phone_verifications_ip_created_idx ON phone_verifications (request_ip_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS signup_tokens (
  token_hash text PRIMARY KEY,
  phone_e164 text NOT NULL,
  phone_verification_id uuid NOT NULL REFERENCES phone_verifications(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signup_tokens_phone_created_idx ON signup_tokens (phone_e164, created_at DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT '대화',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO rooms (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', '오늘의 대화')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS room_members (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  text text NOT NULL,
  idempotency_key text UNIQUE,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(text) <= 90)
);

CREATE INDEX IF NOT EXISTS messages_room_created_idx ON messages (room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  content_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS read_receipts (
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

CREATE TABLE IF NOT EXISTS message_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, reporter_user_id)
);

CREATE INDEX IF NOT EXISTS message_reports_created_idx ON message_reports (created_at DESC);

CREATE TABLE IF NOT EXISTS user_likes (
  liker_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  liked_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (liker_user_id, liked_user_id),
  CHECK (liker_user_id <> liked_user_id)
);

CREATE INDEX IF NOT EXISTS user_likes_liked_created_idx ON user_likes (liked_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_liked_me_accesses (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  viewed_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_start),
  CHECK (viewed_count >= 0)
);

CREATE INDEX IF NOT EXISTS user_liked_me_accesses_user_period_idx ON user_liked_me_accesses (user_id, period_start DESC);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id text NOT NULL,
  status text NOT NULL,
  current_period_starts_at timestamptz,
  current_period_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (plan_id IN ('free', 'basic', 'gold', 'black')),
  CHECK (status IN ('active', 'canceled', 'expired'))
);

CREATE INDEX IF NOT EXISTS user_subscriptions_user_status_idx ON user_subscriptions (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS matches (
  user_low_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id uuid NOT NULL UNIQUE REFERENCES rooms(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_low_id, user_high_id),
  CHECK (user_low_id <> user_high_id)
);

CREATE SEQUENCE IF NOT EXISTS community_anonymous_nickname_seq;

CREATE TABLE IF NOT EXISTS community_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anonymous_nickname text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(title) <= 80),
  CHECK (char_length(body) <= 1000)
);

CREATE INDEX IF NOT EXISTS community_posts_created_idx ON community_posts (created_at DESC);

CREATE TABLE IF NOT EXISTS community_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anonymous_nickname text NOT NULL,
  body text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (char_length(body) <= 500)
);

CREATE INDEX IF NOT EXISTS community_comments_post_created_idx ON community_comments (post_id, created_at ASC);

CREATE TABLE IF NOT EXISTS community_post_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  reporter_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, reporter_user_id),
  CHECK (char_length(reason) <= 120)
);

CREATE INDEX IF NOT EXISTS community_post_reports_created_idx ON community_post_reports (created_at DESC);

CREATE TABLE IF NOT EXISTS profile_ratings (
  rater_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rated_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rater_user_id, rated_user_id),
  CHECK (rater_user_id <> rated_user_id),
  CHECK (score BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS profile_ratings_rated_created_idx ON profile_ratings (rated_user_id, created_at DESC);
