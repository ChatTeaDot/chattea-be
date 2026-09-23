-- A key is scoped to a sender within a room. Soft deletion deliberately does
-- not release the key: retries must never create a second logical message.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS "messages_idempotencyKey_key";
ALTER TABLE messages
  ADD CONSTRAINT messages_idempotency_key_length_check
  CHECK ("idempotencyKey" IS NULL OR char_length("idempotencyKey") BETWEEN 1 AND 128);
ALTER TABLE messages
  ADD CONSTRAINT messages_room_sender_idempotency_unique
  UNIQUE ("roomId", "senderUserId", "idempotencyKey");

DROP INDEX IF EXISTS messages_room_created_idx;
CREATE INDEX messages_room_created_id_idx ON messages ("roomId", "createdAt", id);
