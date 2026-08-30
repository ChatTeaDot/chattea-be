ALTER TABLE profile_uploads
  ADD COLUMN IF NOT EXISTS "finalDeletionPendingAt" timestamp,
  ADD COLUMN IF NOT EXISTS "finalDeletedAt" timestamp;
