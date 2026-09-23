-- chattea:migration-mode=non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS profile_uploads_user_created_idx ON profile_uploads ("userId", "createdAt");
