# ChatTea 백엔드

ChatTea의 API 서버. NestJS 11 + GraphQL + Drizzle ORM + PostgreSQL 17.

## 기술 스택

- NestJS 11, GraphQL(Code First), Passport + JWT(액세스/리프레시)
- Drizzle ORM, PostgreSQL 17, 커스텀 마이그레이션 러너
- Kakao OAuth, SMS 본인인증, RevenueCat 웹훅, Expo Push, Cloudflare R2
- Docker Compose 로컬/프로덕션 스택, Vitest 단위 + e2e

## 도메인

- **인증**: 카카오 소셜 로그인 → 가입 토큰 → 휴대폰 인증 → JWT 발급
- **매칭**: 일일 추천 후보, 관심/스킵 액션, 매칭 성사
- **좋아요**: 받은 관심 목록, 구독 등급별 공개 범위
- **채팅**: 매칭 기반 대화방, 메시지, 읽음 상태
- **커뮤니티**: 익명 게시글·댓글, 멱등성 키 기반 중복 방지
- **결제**: RevenueCat 웹훅으로 구독/소모품 상태 동기화, 부스트 소모품 잔액
- **알림**: 인앱 알림 저장 + Expo 푸시 발송
- **프로필**: 사진 업로드 파이프라인, 프로필 완성도 검증

## 엔지니어링 하이라이트

- **Fail-closed 구성**: 필수 환경변수·시크릿 강도·HTTPS URL 형식을 기동 전 검증하고, 누락 시 부팅 거부. 프로덕션 컨테이너는 preflight를 자동 수행
- **보안 업로드 파이프라인**: `createUpload` → presigned PUT → `finalizeUpload`에서 소유권·바이트 크기·MIME·디코딩된 이미지 검증 후 재인코딩. 날것 URL은 절대 신뢰하지 않음
- **웹훅 무결성**: RevenueCat 서명을 상수시간 HMAC-SHA256 비교 + 5분 타임스탬프 윈도우 + 이벤트 ID 멱등성 + 트랜잭션 커밋. 미구현 entitlement 이벤트는 거짓 확인 대신 501
- **커스텀 마이그레이션 러너**: `_migrations`에 파일명·체크섬 기록(이력 변조 시 배포 실패), advisory lock, `CREATE INDEX CONCURRENTLY` 같은 non-transactional 구문을 위한 strict 단일 구문 모드
- **Maintenance 워커**: 계정 삭제, 푸시 발송/영수증, 스테이징 정리를 advisory lock 아래 배치로 실행 — API 프로세스와 분리
