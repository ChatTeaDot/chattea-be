-- chattea:migration-mode=non-transactional
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS user_profile_photos_upload_unique ON user_profile_photos ("uploadId") WHERE "uploadId" IS NOT NULL;
