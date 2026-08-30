ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "deletionLeaseExpiresAt" timestamp,
  ADD COLUMN IF NOT EXISTS "deletionAttempts" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS profile_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES users("userId") ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'pending',
  "stagingKey" text NOT NULL UNIQUE,
  "finalKey" text UNIQUE,
  "expectedContentType" varchar(30) NOT NULL,
  "expectedSizeBytes" integer NOT NULL,
  "finalContentType" varchar(30),
  "finalSizeBytes" integer,
  "publicUrl" text,
  "expiresAt" timestamp NOT NULL,
  "processingLeaseExpiresAt" timestamp,
  "cleanupLeaseExpiresAt" timestamp,
  "cleanupAttempts" integer NOT NULL DEFAULT 0,
  "failureCode" text,
  "stagingDeletedAt" timestamp,
  "verifiedAt" timestamp,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT profile_uploads_status_check CHECK (status IN ('pending', 'processing', 'verified', 'failed')),
  CONSTRAINT profile_uploads_expected_size_check CHECK ("expectedSizeBytes" BETWEEN 1 AND 10485760),
  CONSTRAINT profile_uploads_final_size_check CHECK ("finalSizeBytes" IS NULL OR "finalSizeBytes" > 0),
  CONSTRAINT profile_uploads_cleanup_attempts_check CHECK ("cleanupAttempts" >= 0),
  CONSTRAINT profile_uploads_verified_fields_check CHECK (
    status <> 'verified' OR (
      "finalKey" IS NOT NULL
      AND "finalContentType" IS NOT NULL
      AND "finalSizeBytes" IS NOT NULL
      AND "publicUrl" IS NOT NULL
      AND "verifiedAt" IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS profile_uploads_user_status_idx
  ON profile_uploads ("userId", status, "createdAt");

CREATE INDEX IF NOT EXISTS profile_uploads_cleanup_due_idx
  ON profile_uploads ("expiresAt", "cleanupLeaseExpiresAt", "createdAt")
  WHERE "stagingDeletedAt" IS NULL;

ALTER TABLE user_profile_photos
  ADD COLUMN IF NOT EXISTS "uploadId" uuid REFERENCES profile_uploads(id) ON DELETE RESTRICT;
