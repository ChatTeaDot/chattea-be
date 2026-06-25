# chattea-be

ChatTea backend. Node.js + TypeScript GraphQL API.

## Run

```sh
pnpm install
pnpm run dev
```

Health check:

```sh
curl http://localhost:4000/healthz
```

GraphQL endpoint:

```txt
http://localhost:4000/graphql
```

## Checks

```sh
pnpm test
pnpm run typecheck
```

## Docker

```sh
docker compose up --build
```

## Current scope

- Korean phone normalization.
- Phone code hash/expiry verification.
- One-time phone code verification; replay returns `PHONE_CODE_ALREADY_USED`.
- Verification locks after five failed code attempts until the code expires.
- Phone resend, phone-hourly, and IP-hourly rate limits.
- Phone signup/login GraphQL flow.
- Server-side signup nickname validation: required and max 20 chars.
- Server-side profile intro validation: max 60 chars.
- Session store with `Authorization: Bearer` -> `me` lookup; PostgreSQL-backed when `DATABASE_URL` is set.
- Kakao REST profile adapter for `loginWithKakao`, phone-required payload, and verified phone linking.
- Full v1 GraphQL operation names.
- In-memory SMS sender for local/test and Munjanara SMS sender for prod-style config.
- GraphQL integration test for request/verify/complete/login.
- Auth guard for chat and upload GraphQL operations; unauthenticated requests return `AUTH_REQUIRED`.
- Match candidate listing plus `likeUser`; mutual likes create a chat room with both members in PostgreSQL.
- Subscription plan catalog query with documented Free/Basic/Gold/Black prices and benefits.
- AI summary eligibility/preview rules for Gold/Black unread messages: enabled only, 30+ chars, latest 180 chars.
- Anonymous community posts/comments/reports; public responses use anonymous nicknames while PostgreSQL keeps author IDs for moderation.
- Profile rating storage with 1-5 score constraint and one upserted rating per rater/rated pair; match candidates do not expose scores.
- In-memory chat rooms/messages with idempotent `sendMessage`, `editMessage`, `deleteMessage`, `markRoomRead`.
- User blocking and message reporting mutations with PostgreSQL persistence.
- Server-side message text limits: first message 30 chars, general messages 90 chars.
- GraphQL `setTyping` mutation and session-authenticated WebSocket subscriptions for message/read/typing events.
- Upload signing service behind a signer interface, with dev signer for local/test and Cloudflare R2 signer for configured env.
- PII redaction for phone, code, signupToken, session/auth token, message/file content in logs and observability reporter payloads.
- First-party Sentry (`SENTRY_DSN`) and Datadog APM (`DATADOG_APM_ENABLED=true`) initialization.
- PostgreSQL initial schema migration for users, profile intro, auth, phone verification, signup tokens, sessions, rooms, messages, attachments, read receipts, blocks, and reports.
- PostgreSQL-backed auth, phone verification, signup token, session, room, and message runtime when `DATABASE_URL` is set.
- Production env guard: `SERVICE_ENV=production` requires `DATABASE_URL`, non-default `PHONE_CODE_PEPPER`, Munjanara SMS env, and Cloudflare R2 env before startup.
- Dockerfile plus root Docker Compose scaffold for BE and private Postgres.

Not yet wired: production Datadog Agent/VPS log forwarding.
