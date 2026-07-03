CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS "users" (
  "userId" uuid PRIMARY KEY,
  "email" varchar(255) NOT NULL UNIQUE,
  "phone" varchar(20) UNIQUE,
  "password" text NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "refreshToken" (
  "tokenKey" text PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "deviceId" varchar(255) NOT NULL,
  "refreshToken" text NOT NULL,
  "refreshTokenExp" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now(),
  "updatedAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "authIdentity" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES "users"("userId"),
  "provider" varchar(50) NOT NULL,
  "providerUserId" varchar(255) NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "phoneVerification" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "phoneE164" varchar(20) NOT NULL,
  "codeHash" text NOT NULL,
  "purpose" varchar(50) NOT NULL,
  "expiresAt" timestamp NOT NULL,
  "verifiedAt" timestamp,
  "attemptCount" integer NOT NULL DEFAULT 0,
  "requestIpHash" text,
  "userAgentHash" text,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "signupToken" (
  "token" text PRIMARY KEY,
  "phoneE164" varchar(20) NOT NULL,
  "verificationId" uuid NOT NULL REFERENCES "phoneVerification"("id"),
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "kakaoSignupToken" (
  "token" text PRIMARY KEY,
  "userId" uuid REFERENCES "users"("userId"),
  "providerUserId" varchar(255) NOT NULL,
  "email" varchar(255),
  "expiresAt" timestamp NOT NULL,
  "createdAt" timestamp NOT NULL DEFAULT now()
);
