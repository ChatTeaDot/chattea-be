# ChatTea backend

NestJS 11, GraphQL, Drizzle ORM, and PostgreSQL backend for ChatTea.

## Requirements

- Node.js 24
- pnpm 10.13.1
- PostgreSQL 17

## Local development

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:up
pnpm migrate
pnpm start:dev
```

`.env.example` targets the host process and Compose PostgreSQL port `5433`. `pnpm docker:up` instead adds `docker-compose.dev.yml` and starts the entire local stack with `NODE_ENV=development`. The production compose file hardcodes `NODE_ENV=production`, validates every required setting, and has no bypass switch.

## Verification

```bash
pnpm config:check
pnpm audit:all
pnpm lint:check
pnpm format:check
pnpm test --runInBand
pnpm typecheck
pnpm build
pnpm test:e2e --runInBand
```

PostgreSQL-backed tests use these local defaults:

```bash
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5433
POSTGRES_USERNAME=chattea
POSTGRES_PASSWORD=chattea-dev
POSTGRES_DATABASE=chattea
```

`pnpm test:e2e` loads `.env` and fails instead of silently skipping the PostgreSQL suites when the database settings are absent.

## Production configuration

Production startup fails closed unless all of these settings are present:

```text
POSTGRES_HOST
POSTGRES_PORT
POSTGRES_USERNAME
POSTGRES_PASSWORD
POSTGRES_DATABASE
POSTGRES_SSL
JWT_ACCESS_TOKEN_SECRET
JWT_REFRESH_TOKEN_SECRET
JWT_ACCESS_TOKEN_EXP
JWT_REFRESH_TOKEN_EXP
SIGNUP_TOKEN_SECRET
KAKAO_SIGNUP_TOKEN_SECRET
KAKAO_CLIENT_ID
KAKAO_CALLBACK_URL
PHONE_CODE_PEPPER
SMS_PROVIDER_URL
SMS_PROVIDER_AUTHORIZATION
SMS_SENDER_ID
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_PUBLIC_BASE_URL
REVENUECAT_WEBHOOK_SECRET
REVENUECAT_IOS_APP_ID
REVENUECAT_ANDROID_APP_ID
CLIENT_URL
TRUST_PROXY
```

`KAKAO_CALLBACK_URL`, `SMS_PROVIDER_URL`, `R2_PUBLIC_BASE_URL`, and `CLIENT_URL` must be credential-free HTTPS URLs. Secrets must be at least 16 characters and must not use development or test prefixes. Set `TRUST_PROXY` to the exact trusted proxy address or range, never `true` or `*`.

Expo push delivery is optional. Set `EXPO_PUSH_ENABLED=true` and, when required, `EXPO_PUSH_ACCESS_TOKEN`. In-app notifications remain persisted when push delivery is disabled.

## Profile uploads

Profile images use a verified four-step flow:

1. Call `createUpload` with `filename`, `contentType`, and `sizeBytes`. It returns `id`, `putUrl`, and `expiresAt`; it does not return a public URL.
2. Before expiry, `PUT` exactly `sizeBytes` bytes to `putUrl` with the declared content type.
3. Call `finalizeUpload(uploadId: id)`. The server verifies ownership, object size, MIME metadata, and decoded image limits, then re-encodes the final object and returns its trusted `publicUrl` and metadata.
4. Send the ordered verified IDs through `UpdateUserProfileInput.photoUploadIds`. Raw URLs are never accepted as profile-photo authority.

For backward compatibility, an existing photo already attached to the authenticated user's profile may be retained by sending the photo `id` returned by `me` in `photoUploadIds`. This compatibility applies only to that user's attached legacy rows without an upload ID; it does not authorize arbitrary UUIDs or URLs. New photos must complete the create, PUT, and finalize flow.

## RevenueCat webhooks

RevenueCat sends events to `POST /webhooks/revenuecat`. Sign the exact raw request body with HMAC-SHA256 and send the official header format:

```text
X-RevenueCat-Webhook-Signature: t=<unix-seconds>,v1=<hex-digest>
```

The server rejects malformed signatures, non-constant-time mismatches, and timestamps outside the five-minute tolerance. In production, mutation events must also be `PRODUCTION` events whose store-specific public app identifier matches either `REVENUECAT_IOS_APP_ID` or `REVENUECAT_ANDROID_APP_ID`; both distinct identifiers are required. Non-production environments accept sandbox events for testing. Event IDs provide idempotency, and implemented subscription or consumable updates are committed transactionally. Google Play subscription products accept RevenueCat's `<subscription_id>:<base_plan_id>` form.

Do not enable `TRANSFER`, `TEMPORARY_ENTITLEMENT_GRANT`, or `VIRTUAL_CURRENCY_TRANSACTION` in the RevenueCat webhook until their entitlement models are implemented; the endpoint returns `501` instead of falsely acknowledging those state changes.

## Migrations and deploys

Run migrations before starting the new application version:

```bash
pnpm migrate
```

Migration filenames and checksums are recorded in `_migrations`; changing an already-applied migration fails deployment. Roll back through a database snapshot or point-in-time recovery, then add a new forward migration instead of editing history.

Online statements that PostgreSQL forbids inside a transaction use this exact first line:

```sql
-- chattea:migration-mode=non-transactional
```

Such a file must contain exactly one executable statement and must be idempotent. The runner holds the global migration advisory lock, executes the statement through PostgreSQL's extended query protocol outside `BEGIN`, and records history only after success. Nontransactional mode accepts only one simple, unquoted `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <index_name>` statement, without SQL comments, expressions, operator classes, or trailing tokens. Before retry, the runner drops an existing target that PostgreSQL reports as invalid or not ready. After execution, both `indisvalid` and `indisready` must be true, then the runner records a file-and-checksum marker on the index before inserting migration history. If history insertion fails, only a valid, ready index with that exact marker is resumed; an unmarked or differently marked same-name index fails closed without being changed. Any other nontransactional body, SQL body comment, unknown migration mode, or multiple statements fail before migration side effects.

Set `POSTGRES_SSL=true` when PostgreSQL requires TLS. Certificates are always verified; provide an escaped PEM certificate through `POSTGRES_SSL_CA` when the system trust store does not include the provider CA.

Run `pnpm config:check` with the exact deployment environment before migrations or startup. The production container performs this preflight automatically.

Production uses `docker-compose.production.yml` and requires an immutable image reference:

```bash
export CHATTEA_BACKEND_DIGEST='<64 lowercase hex characters>'
docker compose --env-file .env -f docker-compose.production.yml -p chattea config --quiet
docker compose --env-file .env -f docker-compose.production.yml -p chattea pull chattea-migrate chattea-be chattea-maintenance
docker compose --env-file .env -f docker-compose.production.yml -p chattea run --rm chattea-migrate
docker compose --env-file .env -f docker-compose.production.yml -p chattea up -d --no-build --wait --wait-timeout 120 chattea-be chattea-maintenance
```

The API never schedules account deletion or runs migrations during startup. `chattea-maintenance` runs account deletion, push delivery, push receipts, and abandoned staging cleanup immediately and then every 60 seconds in bounded batches under a PostgreSQL advisory lock. Its health check requires `/tmp/chattea-maintenance-heartbeat` to be refreshed within 150 seconds. Inspect structured failures with `docker compose --env-file .env -f docker-compose.production.yml -p chattea logs chattea-maintenance`.
