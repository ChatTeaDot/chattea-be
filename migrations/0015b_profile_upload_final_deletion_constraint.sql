ALTER TABLE profile_uploads
  ADD CONSTRAINT profile_uploads_final_deletion_state_check CHECK (
    ("finalDeletionPendingAt" IS NULL AND "finalDeletedAt" IS NULL)
    OR (
      "finalDeletionPendingAt" IS NOT NULL
      AND ("finalKey" IS NOT NULL OR "finalDeletedAt" IS NOT NULL)
    )
  ) NOT VALID;

ALTER TABLE profile_uploads
  VALIDATE CONSTRAINT profile_uploads_final_deletion_state_check;
