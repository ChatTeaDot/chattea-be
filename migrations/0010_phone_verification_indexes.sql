CREATE INDEX IF NOT EXISTS phone_verification_phone_created_idx
  ON "phoneVerification" ("phoneE164", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS phone_verification_ip_created_idx
  ON "phoneVerification" ("requestIpHash", "createdAt" DESC)
  WHERE "requestIpHash" IS NOT NULL;

CREATE INDEX IF NOT EXISTS phone_verification_created_idx
  ON "phoneVerification" ("createdAt");
