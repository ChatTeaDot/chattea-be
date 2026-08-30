-- chattea:migration-mode=non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS user_blocks_blocked_blocker_idx ON user_blocks ("blockedUserId", "blockerUserId");
