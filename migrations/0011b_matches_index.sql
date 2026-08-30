-- chattea:migration-mode=non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS matches_user_high_low_idx ON matches ("userHighId", "userLowId");
