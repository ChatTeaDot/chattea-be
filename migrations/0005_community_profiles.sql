CREATE TABLE IF NOT EXISTS community_profiles (
  "userId" uuid PRIMARY KEY REFERENCES "users"("userId") ON DELETE CASCADE,
  name varchar(20) NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CHECK (char_length(trim(name)) BETWEEN 1 AND 20)
);

ALTER TABLE community_posts DROP COLUMN IF EXISTS "anonymousName";
ALTER TABLE community_comments DROP COLUMN IF EXISTS "anonymousName";
