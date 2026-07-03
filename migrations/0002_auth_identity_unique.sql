CREATE EXTENSION IF NOT EXISTS "pgcrypto";

UPDATE "signupToken"
SET "tokenHash" = encode(digest("tokenHash", 'sha256'), 'hex')
WHERE "tokenHash" !~ '^[0-9a-f]{64}$';

UPDATE "kakaoSignupToken"
SET "tokenHash" = encode(digest("tokenHash", 'sha256'), 'hex')
WHERE "tokenHash" !~ '^[0-9a-f]{64}$';

DELETE FROM "authIdentity" a
USING "authIdentity" b
WHERE a."provider" = b."provider"
  AND a."providerUserId" = b."providerUserId"
  AND (
    a."createdAt" > b."createdAt"
    OR (a."createdAt" = b."createdAt" AND a."id" > b."id")
  );

ALTER TABLE "authIdentity" ADD CONSTRAINT "authIdentity_provider_providerUserId_unique" UNIQUE ("provider", "providerUserId");
