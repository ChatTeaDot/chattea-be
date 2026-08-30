-- chattea:migration-mode=non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS profile_uploads_final_deletion_due_idx ON profile_uploads ("finalDeletionPendingAt", "cleanupLeaseExpiresAt", "createdAt") WHERE "finalDeletionPendingAt" IS NOT NULL AND "finalDeletedAt" IS NULL;
