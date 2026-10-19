# 0006. 인증: 이메일 매직링크 + 자체 DB 세션(표준 방식)

- 상태: 채택
- 날짜: 2026-10-19

## 맥락

T-02는 계정·세션·공개/비공개 프로필을 만듭니다. SYSTEM_DESIGN §4는 "검증된 세션/OAuth 라이브러리, HttpOnly 쿠키, 이메일 매직링크 + Google·GitHub·카카오, 자체 암호 프로토콜 금지"를 요구합니다. 이번 slice는 매직링크만 구현하고 OAuth는 나중에 추가합니다. 사용자 테이블(`users`: `display_name`, `private_email`, `status`)과 프로필(`profiles`)은 0003에서 이미 정의했고, 공개 DTO와 로그인 식별자를 분리하는 것이 핵심 규칙입니다(§6.1).

검토한 선택지는 (a) better-auth 같은 인증 라이브러리를 기존 `users`에 매핑, (b) Lucia 가이드 방식의 최소 DB 세션 직접 구현입니다.

## 결정

(b)를 택합니다. 암호 기법은 새로 만들지 않고 Node 표준 `crypto`의 CSPRNG·SHA-256·`timingSafeEqual`만 씁니다.

- **세션**: 쿠키 `peerchive_session = <id>.<secret>`. id 144비트, secret 256비트(CSPRNG, base64url). DB `sessions`에는 id와 `sha256(secret)`만 저장하고 비교는 상수 시간. 만료 30일, 남은 기간이 15일 미만이면 사용할 때 30일로 연장. 로그아웃·탈퇴는 행 삭제로 즉시 무효화. 사용자 `status`가 `active`가 아니면 기존 세션도 거부(그 자리에서 삭제).
- **쿠키**: `HttpOnly`, `SameSite=Lax`, `Path=/`, production에서 `Secure`.
- **매직링크**: 256비트 토큰, `magic_link_tokens`에 SHA-256 해시만 저장, 15분 만료, `UPDATE … WHERE used_at IS NULL AND expires_at > now`로 한 번만 소비. 요청 API는 계정 유무·상태와 무관하게 202(열거 방지). 처음 보는 주소면 검증 시점에 사용자(`active`)와 로그인 계정을 만들고, 프로필이 없으면 `/onboarding`으로 보냄. 실패는 이유를 구분하지 않고 `/login?error=link`.
- **로그인 수단 테이블**: `auth_accounts(user_id, provider, provider_account_id)`, `provider` enum에 `email`·`google`·`github`·`kakao`를 미리 둡니다. OAuth는 같은 테이블에 행을 추가하는 방식으로 붙이며, 프로토콜 처리(state·PKCE·토큰 교환)는 직접 쓰지 않고 검증된 OAuth 클라이언트 라이브러리(예: arctic)를 그때 별도 ADR로 고릅니다.
- **rate limit**: DB 고정 창 카운터(`rate_limit_buckets`, 키는 이메일·IP의 SHA-256). 이메일당 15분 5회(초과 시 같은 202, 발송만 생략), IP당 15분 20회(초과 시 429).
- **CSRF**: 상태를 바꾸는 `/api/v1` 요청(POST/PATCH/PUT/DELETE)은 `Origin`(없으면 `Referer`)이 `NUXT_SITE_ORIGIN` 목록과 정확히 같아야 하며 아니면 403(Nitro 서버 미들웨어). SameSite=Lax와 함께 두 겹입니다.
- **메일**: `MailTransport` 인터페이스. 현재 구현은 개발용 `dev-console`(링크를 서버 콘솔에 출력, 수신 주소는 가림)뿐이고, production에서는 이 transport로 서버가 시작되지 않습니다. 빌드 산출물은 기본 production으로 보며, 로컬 점검 때만 실행 시 `NODE_ENV=development`를 명시해 예외로 둡니다.
- **탈퇴 요청**: `users.status = 'deleted'`, `deletion_requested_at` 기록, 모든 세션 삭제. 실제 삭제(purge)·DeletionLedger·소유 프로젝트 처리는 범위 밖(§6.6, TODO).

## 결과

- 의존성이 늘지 않고(입력 검증용 zod만 추가), 기존 `users`/`profiles` 스키마와 공개 DTO 규칙을 그대로 지킵니다.
- 세션 저장소가 PostgreSQL 하나라 서버 인스턴스를 늘려도 그대로 동작합니다. 요청마다 세션 조회 1회(연장 시 갱신 1회)가 듭니다.
- 직접 유지하는 코드이므로 보안 검토 대상이 됩니다. 범위를 세션·토큰 수명 관리로 좁히고 통합 테스트(단일 사용·만료·폐기·정지 계정)로 고정했습니다.
- 매직링크는 `/auth/verify#token=…`(fragment, 서버로 전송되지 않음)로 보내고, "로그인 확인" 페이지에서 가린 이메일을 보여 준 뒤 사용자가 버튼을 눌러야 `POST /api/v1/auth/magic-link/verify`로 소비합니다. 메일 보안 스캐너가 링크를 미리 열어도 토큰이 소비되지 않고, 남이 보낸 링크로 남의 계정에 로그인되는 login CSRF는 계정 표시로 알아차릴 수 있게 합니다(완전히 막지는 못함).
- 알려진 한계: 프록시 뒤 배포 시 신뢰 프록시 설정 없이 IP rate limit은 프록시 IP 기준이 됩니다. rate limit 행 정리는 작업 큐(0004) 도입 후 주기 작업으로 합니다.

## 대안

- better-auth: 매직링크·OAuth·Drizzle 어댑터를 갖추고 빠르게 붙일 수 있으나, 자체 user/account/session/verification 스키마(이메일 인증 여부·이미지 등)를 기대해 기존 `users`/`profiles` 분리와 필드 매핑을 계속 맞춰야 하고, 전이 의존성과 업데이트 주기(보안 패치 추적)가 늘어납니다. 사용자 계정 기능이 커지면(2FA, 패스키 등) 재검토합니다.
- Auth.js(@auth/core): Nuxt 연동이 커뮤니티 모듈 중심이고 매직링크에 별도 메일 공급자 설정이 필요합니다.
- JWT 무상태 세션: 즉시 폐기(로그아웃·정지·탈퇴)가 어렵고 §14의 세션 보호 목표와 맞지 않습니다.
