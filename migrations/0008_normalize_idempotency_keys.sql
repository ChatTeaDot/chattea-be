ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_room_sender_idempotency_unique;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_idempotency_key_length_check;

WITH normalized_keys AS (
  SELECT
    id,
    btrim(
      "idempotencyKey",
      E'\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    ) AS normalized_key
  FROM messages
  WHERE "idempotencyKey" IS NOT NULL
)
UPDATE messages
SET "idempotencyKey" = CASE
  WHEN char_length(normalized_keys.normalized_key) BETWEEN 1 AND 128 THEN normalized_keys.normalized_key
  ELSE NULL
END
FROM normalized_keys
WHERE messages.id = normalized_keys.id;

WITH ranked_keys AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY "roomId", "senderUserId", "idempotencyKey"
      ORDER BY "createdAt", id
    ) AS duplicate_rank
  FROM messages
  WHERE "idempotencyKey" IS NOT NULL
)
UPDATE messages
SET "idempotencyKey" = NULL
FROM ranked_keys
WHERE messages.id = ranked_keys.id AND ranked_keys.duplicate_rank > 1;

ALTER TABLE messages
  ADD CONSTRAINT messages_idempotency_key_length_check
  CHECK (
    "idempotencyKey" IS NULL OR (
      char_length("idempotencyKey") BETWEEN 1 AND 128 AND
      "idempotencyKey" = btrim(
        "idempotencyKey",
        E'\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
      )
    )
  );
ALTER TABLE messages
  ADD CONSTRAINT messages_room_sender_idempotency_unique
  UNIQUE ("roomId", "senderUserId", "idempotencyKey");
