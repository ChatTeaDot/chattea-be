-- chattea:migration-mode=non-transactional
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS push_tokens_user_device_unique ON push_tokens ("userId", "deviceId");
