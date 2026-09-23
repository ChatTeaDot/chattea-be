-- chattea:migration-mode=non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS push_tokens_user_idx ON push_tokens ("userId");
