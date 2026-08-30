-- chattea:migration-mode=non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_matching_visible_created_idx ON users ("createdAt" DESC) WHERE "profileCompletedAt" IS NOT NULL AND "hiddenAt" IS NULL AND "deletedAt" IS NULL;
