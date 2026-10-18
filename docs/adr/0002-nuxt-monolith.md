# 0002. Nuxt 단일 앱(웹 + 서버 API)

- 상태: 채택
- 날짜: 2026-10-18

## 맥락

공개 사례·과목·프로필 페이지는 검색 노출과 OG를 위해 SSR이 필요하고, 편집 화면과 API도 필요합니다. 1인 개발·운영을 전제로 배포 단위와 CORS·인증 경계를 줄여야 합니다(§3, §4). 원본이 Vue였으므로 Vue 경험을 이어갈 수 있습니다.

## 결정

- `apps/web`에 Nuxt 4(Vue 3, TypeScript strict)를 쓰고 서버 API는 Nitro 라우트 `server/api/v1/*`로 둡니다.
- 도메인 규칙은 프레임워크와 무관한 `packages/domain`(런타임 의존성 없음)에, DB 스키마·migration은 `packages/db`에 둡니다. handler는 요청 검증·정책 호출·응답 변환만 합니다.
- 첫 서버 라우트는 `GET /api/v1/health`이며 `DATABASE_URL`이 있을 때만 DB에 `select 1`을 보냅니다.
- 타입 검사는 `nuxt typecheck`(vue-tsc)로 CI에서 실행합니다. UI 라이브러리(Tailwind 등)는 화면 작업 시작 시 추가합니다.

## 결과

- 배포 1개(web)로 시작하고, worker·bot은 같은 `packages/*`를 공유하는 별도 프로세스로 추가합니다.
- 외부 클라이언트용 API 안정성은 `/api/v1` 경로 버전과 `packages/contracts`(예정)로 관리합니다.

## 대안

- Vue 3 SPA + 독립 TypeScript API: 공개 페이지 SSR을 따로 구성해야 하고 배포가 둘로 나뉨. 외부·모바일 클라이언트 요구가 커지면 재검토.
- Next.js 등 다른 프레임워크: Vue 경험 계승 이점이 사라짐.
