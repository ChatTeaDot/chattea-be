UPDATE messages
SET "idempotencyKey" = NULL
WHERE "idempotencyKey" = '' OR char_length("idempotencyKey") > 128;
