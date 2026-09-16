# Chattea BE Plan

## Summary
- GraphQL API, auth, realtime subscription, chat/message/upload/SMS.
- 담당:
  - auth/session
  - SMS
  - Kakao verification
  - message persistence
  - upload signing
  - subscription fanout
- FE와 GraphQL schema 계약을 공유.

## Stack
- Node.js + TypeScript.
- GraphQL server.
- WebSocket GraphQL Subscription.
- Effect for services/errors/runtime flows.
- PostgreSQL.
- Redis for realtime fanout/rate limit/session-ish volatile state.

## GraphQL Contract
- Query:
  - `me`
  - `rooms`
  - `messages(roomId, first, after)`
- Mutation:
  - `loginWithKakao`
  - `requestPhoneCode`
  - `verifyPhoneCode`
  - `completePhoneSignup`
  - `attachPhoneToMe`
  - `sendMessage`
  - `editMessage`
  - `deleteMessage`
  - `markRoomRead`
  - `createUpload`
- Subscription:
  - `messageCreated`
  - `messageUpdated`
  - `messageDeleted`
  - `typingChanged`
  - `readReceiptUpdated`

## Auth
- App session은 BE가 발급.
- Kakao token 검증 후 user 연결/생성.
- phone은 unique.
- 전화번호 인증 성공:
  - 기존 phone이면 login.
  - 신규 phone이면 signup하지 않고 `signupToken` 발급.
  - `completePhoneSignup`에서 프로필/약관 확인 후 user 생성.

## Phone Verification
- 대상: 한국 번호만.
- normalize: `010...`/`+82...` -> E.164 `+821012345678`.
- SMS provider: AWS SNS v1.
- code:
  - 6자리 숫자.
  - TTL 5분.
  - hash 저장.
  - 평문 code는 로그/DB 금지.
- rate limit:
  - 재발송 cooldown 60초.
  - phone 기준 시간당 5회.
  - IP 기준 시간당 20회.
  - verify 실패 phone 기준 5회 후 TTL 만료까지 잠금.
- `phone_verifications`:
  - `id`
  - `phone_e164`
  - `code_hash`
  - `purpose`
  - `expires_at`
  - `verified_at`
  - `attempt_count`
  - `request_ip_hash`
  - `user_agent_hash`
  - `created_at`
- `signupToken`:
  - 15분 TTL.
  - Redis 저장.
  - phone과 verification id만 포함.
  - 프로필 완료 전 user 생성 안 함.
- AWS SNS adapter는 `SmsSender` 단일 인터페이스 뒤에 둠. v1 provider switch용 factory 없음.
- SMS 문구:
  - `[Chattea] 인증번호는 {code}입니다. 5분 안에 입력해주세요.`
- `{code}` 외 동적값 없음.
- `dev`: 실제 발송 기본 off 가능. 서버 로그에는 code 금지, test 전용 in-memory/sandbox sender만 허용.
- `prod`: AWS SNS만 사용.

## Data Model
- `users`
- `auth_identities`
- `phone_verifications`
- `sessions`
- `rooms`
- `room_members`
- `messages`
- `message_attachments`
- `read_receipts`

## Chat
- message idempotency key 지원.
- optimistic temp id -> server id 교체 가능.
- streaming assistant message는 `messageUpdated` chunks/events로 반영.
- reconnect 대비 cursor/latest sync 제공.

## Upload
- BE가 presigned URL 발급.
- FE upload 후 attachment finalize.
- content scanning은 v1 후순위.

## Observability
- Sentry backend errors.
- Datadog logs/APM/metrics.
- PII redaction:
  - message content
  - phone
  - code
  - `signupToken`
  - auth token
  - file content

## Tests
- unit tests for auth services, phone verification, Kakao token exchange, message reducer.
- Korean phone normalization.
- invalid/global phone reject.
- code hash verify success/fail/expired.
- resend cooldown and attempt lock.
- existing phone -> login payload.
- new phone -> signupToken payload.
- `completePhoneSignup` creates user only after valid token + terms.
- integration tests for GraphQL Query/Mutation.
- `requestPhoneCode` -> `verifyPhoneCode` -> `completePhoneSignup`.
- subscription tests for message events.
- DB migration test.
- PII redaction test.
