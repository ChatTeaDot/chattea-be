CREATE EXTENSION IF NOT EXISTS "pgcrypto";

ALTER TABLE "signupToken" RENAME COLUMN "token" TO "tokenHash";
ALTER TABLE "kakaoSignupToken" RENAME COLUMN "token" TO "tokenHash";

UPDATE "signupToken" SET "tokenHash" = encode(digest("tokenHash", 'sha256'), 'hex');
UPDATE "kakaoSignupToken" SET "tokenHash" = encode(digest("tokenHash", 'sha256'), 'hex');

ALTER TABLE "signupToken" ADD COLUMN "usedAt" timestamp;
ALTER TABLE "kakaoSignupToken" ADD COLUMN "usedAt" timestamp;

ALTER TABLE "refreshToken" DROP CONSTRAINT "refreshToken_pkey";
ALTER TABLE "refreshToken" ADD COLUMN "id" uuid DEFAULT gen_random_uuid() NOT NULL;
ALTER TABLE "refreshToken" ADD CONSTRAINT "refreshToken_pkey" PRIMARY KEY ("id");
ALTER TABLE "refreshToken" ADD CONSTRAINT "refreshToken_userId_deviceId_unique" UNIQUE ("userId", "deviceId");
ALTER TABLE "refreshToken" DROP COLUMN "tokenKey";
