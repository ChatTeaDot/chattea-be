# ChatTea 백엔드

ChatTea용 NestJS 11, GraphQL, Drizzle ORM, PostgreSQL 백엔드.

## 요구사항

- Node.js 24
- pnpm 10.13.1
- PostgreSQL 17

## 로컬 개발

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm db:up
pnpm migrate
pnpm start:dev
```

`.env.example`은 호스트 프로세스와 Compose PostgreSQL 포트 `5433`을 대상으로 한다. `pnpm docker:up`은 `docker-compose.dev.yml`을 추가해서 `NODE_ENV=development`로 로컬 스택 전체를 띄운다. 프로덕션 compose 파일은 `NODE_ENV=production`을 하드코딩하고 모든 필수 설정을 검증하며 우회 스위치가 없다.

## 검증

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

PostgreSQL 기반 테스트는 다음 로컬 기본값을 사용한다.

```bash
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5433
POSTGRES_USERNAME=chattea
POSTGRES_PASSWORD=chattea-dev
POSTGRES_DATABASE=chattea
```

`pnpm test:e2e`는 `.env`를 로드하며, 데이터베이스 설정이 없으면 PostgreSQL 스위트를 조용히 건너뛰지 않고 실패한다.

## 프로덕션 설정

다음 설정이 모두 있어야 프로덕션 기동이 통과한다(fail-closed).

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

`KAKAO_CALLBACK_URL`, `SMS_PROVIDER_URL`, `R2_PUBLIC_BASE_URL`, `CLIENT_URL`은 크리덴셜 없는 HTTPS URL이어야 한다. 시크릿은 16자 이상이어야 하고 개발/테스트 접두사를 쓰면 안 된다. `TRUST_PROXY`는 `true`나 `*`가 아니라 정확한 신뢰 프록시 주소 또는 범위로 설정한다.

Expo 푸시 발송은 선택이다. `EXPO_PUSH_ENABLED=true`를 설정하고 필요하면 `EXPO_PUSH_ACCESS_TOKEN`을 설정한다. 푸시 발송이 꺼져 있어도 인앱 알림은 계속 저장된다.

## 프로필 업로드

프로필 이미지는 검증된 4단계 흐름을 사용한다.

1. `filename`, `contentType`, `sizeBytes`로 `createUpload`를 호출한다. `id`, `putUrl`, `expiresAt`을 반환하며 public URL은 반환하지 않는다.
2. 만료 전에 선언한 content type으로 정확히 `sizeBytes` 바이트를 `putUrl`에 `PUT`한다.
3. `finalizeUpload(uploadId: id)`를 호출한다. 서버가 소유권, 객체 크기, MIME 메타데이터, 디코딩된 이미지 제한을 검증한 뒤 최종 객체를 재인코딩하고 신뢰된 `publicUrl`과 메타데이터를 반환한다.
4. 순서가 정해진 검증된 ID들을 `UpdateUserProfileInput.photoUploadIds`로 보낸다. 날것의 URL은 프로필 사진 근거로 절대 받지 않는다.

하위 호환을 위해, 인증된 사용자의 프로필에 이미 붙어 있는 기존 사진은 `me`가 반환한 사진 `id`를 `photoUploadIds`로 보내 유지할 수 있다. 이 호환은 업로드 ID가 없는 해당 사용자의 레거시 첨부 행에만 적용되며, 임의의 UUID나 URL을 인가하지 않는다. 새 사진은 반드시 create, PUT, finalize 흐름을 완료해야 한다.

## RevenueCat 웹훅

RevenueCat은 `POST /webhooks/revenuecat`으로 이벤트를 보낸다. 정확한 raw 요청 바디를 HMAC-SHA256으로 서명하고 공식 헤더 형식으로 보낸다.

```text
X-RevenueCat-Webhook-Signature: t=<unix-seconds>,v1=<hex-digest>
```

서버는 잘못된 서명, 비상수시간 비교, 5분 허용 범위를 벗어난 타임스탬프를 거부한다. 프로덕션에서 mutation 이벤트는 스토어별 public app 식별자가 `REVENUECAT_IOS_APP_ID` 또는 `REVENUECAT_ANDROID_APP_ID`와 일치하는 `PRODUCTION` 이벤트여야 하며, 두 개의 서로 다른 식별자가 모두 필요하다. 비프로덕션 환경은 테스트용 샌드박스 이벤트를 받는다. 이벤트 ID가 멱등성을 제공하고, 구현된 구독/소모품 업데이트는 트랜잭션으로 커밋된다. Google Play 구독 상품은 RevenueCat의 `<subscription_id>:<base_plan_id>` 형태를 받는다.

해당 entitlement 모델이 구현되기 전까지 RevenueCat 웹훅에서 `TRANSFER`, `TEMPORARY_ENTITLEMENT_GRANT`, `VIRTUAL_CURRENCY_TRANSACTION`을 켜지 않는다. 엔드포인트는 그런 상태 변경을 거짓으로 확인하는 대신 `501`을 반환한다.

## 마이그레이션과 배포

새 애플리케이션 버전을 시작하기 전에 마이그레이션을 실행한다.

```bash
pnpm migrate
```

마이그레이션 파일명과 체크섬은 `_migrations`에 기록된다. 이미 적용된 마이그레이션을 바꾸면 배포가 실패한다. 데이터베이스 스냅샷이나 point-in-time recovery로 롤백하고, 이력을 수정하는 대신 새 forward 마이그레이션을 추가한다.

PostgreSQL이 트랜잭션 안에서 금지하는 온라인 구문은 정확히 이 첫 줄을 사용한다.

```sql
-- chattea:migration-mode=non-transactional
```

이런 파일은 정확히 하나의 실행 구문만 담아야 하고 멱등이어야 한다. 러너는 전역 마이그레이션 advisory lock을 잡고, `BEGIN` 바깥에서 PostgreSQL 확장 쿼리 프로토콜로 구문을 실행하며, 성공 후에만 이력을 기록한다. nontransactional 모드는 SQL 주석, 표현식, operator class, 뒤따르는 토큰 없이 따옴표 없는 단순한 `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS <index_name>` 구문 하나만 받는다. 재시도 전에 러너는 PostgreSQL이 invalid 또는 not ready로 보고하는 기존 대상을 drop한다. 실행 후 `indisvalid`와 `indisready`가 모두 true여야 하고, 러너는 인덱스에 파일·체크섬 마커를 기록한 뒤 마이그레이션 이력을 넣는다. 이력 삽입이 실패하면 정확한 마커를 가진 유효·준비 상태 인덱스만 재개되며, 마커가 없거나 다른 마커의 동일 이름 인덱스는 변경 없이 fail-closed로 실패한다. 그 외 nontransactional 바디, SQL 바디 주석, 알 수 없는 마이그레이션 모드, 복수 구문은 마이그레이션 부수 효과 전에 실패한다.

PostgreSQL이 TLS를 요구하면 `POSTGRES_SSL=true`를 설정한다. 인증서는 항상 검증되며, 시스템 trust store에 제공자 CA가 없으면 이스케이프된 PEM 인증서를 `POSTGRES_SSL_CA`로 제공한다.

마이그레이션이나 기동 전에 정확한 배포 환경으로 `pnpm config:check`를 실행한다. 프로덕션 컨테이너는 이 preflight를 자동으로 수행한다.

프로덕션은 `docker-compose.production.yml`을 사용하고 불변 이미지 참조가 필요하다.

```bash
export CHATTEA_BACKEND_DIGEST='<64 lowercase hex characters>'
docker compose --env-file .env -f docker-compose.production.yml -p chattea config --quiet
docker compose --env-file .env -f docker-compose.production.yml -p chattea pull chattea-migrate chattea-be chattea-maintenance
docker compose --env-file .env -f docker-compose.production.yml -p chattea run --rm chattea-migrate
docker compose --env-file .env -f docker-compose.production.yml -p chattea up -d --no-build --wait --wait-timeout 120 chattea-be chattea-maintenance
```

API는 기동 중 계정 삭제를 스케줄하거나 마이그레이션을 실행하지 않는다. `chattea-maintenance`가 계정 삭제, 푸시 발송, 푸시 영수증, 방치된 스테이징 정리를 즉시 그리고 60초마다 PostgreSQL advisory lock 아래 제한된 배치로 실행한다. 헬스 체크는 `/tmp/chattea-maintenance-heartbeat`가 150초 이내에 갱신돼야 한다. 구조화된 실패는 `docker compose --env-file .env -f docker-compose.production.yml -p chattea logs chattea-maintenance`로 확인한다.
