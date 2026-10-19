# Peerchive 신규 앱

2019년 원본 ProofU(`frontend/`, `backend/`)와 별개로 만드는 신규 앱입니다. 원본은 기록 보존 대상이며 이 워크스페이스에 포함되지 않습니다. 결정 배경은 [ADR](../docs/adr/README.md)과 [시스템 설계](../docs/planning/SYSTEM_DESIGN.md)를 보세요.

## 구성

| 경로 | 내용 |
|---|---|
| `apps/web` | Nuxt 4(Vue 3, TypeScript strict). 화면(`app/`), `/api/v1` 라우트(`server/api`), 서비스 모듈(`server/modules`), 공유 DTO 타입(`shared/types`) |
| `packages/domain` | 런타임 의존성 없는 도메인 규칙: 과제 공간 권한 정책, 빌드 로그 작성·수정·해결 연결 규칙, 공개 상태 전이, 기여 확인 |
| `packages/db` | Drizzle ORM 스키마, SQL migration(`migrations/`), `createDb(url)` |
| `ops/docker-compose.yml` | 로컬 개발용 PostgreSQL 16 |

## 구현 현황

[실행 계획 §4](../docs/planning/DELIVERY_PLAN.md) 백로그 기준입니다.

| 항목 | 상태 | 내용 |
|---|---|---|
| T-01 개발 환경·DB migration·CI | 완료 | Nuxt 4 골격, PostgreSQL+Drizzle migration, CI(아카이브·앱·DB 통합) |
| T-02 세션·공개/비공개 프로필 | 완료 | 이메일 매직링크, DB 세션(30일·sliding), CSRF Origin 검사, `/me`·프로필·공개 프로필·탈퇴 요청([ADR 0006](../docs/adr/0006-auth-sessions.md)) |
| T-03 과제·초대·프로젝트 권한 | 완료 | 과제 생성·목록·수정(version 409), 멤버·초대(7일·일회성·취소)·역할 변경·내보내기·나가기·소유권 이전, 감사 이벤트 |
| T-04 빌드 로그·revision·태그별 payload | 완료 | 7개 태그별 payload 검증(모르는 키 거부), 수정은 새 revision(낡은 `expectedRevision`은 409 `stale_revision`)·태그 변경 불가(422 `tag: immutable`), 💡해결↔🧱막힘 연결(같은 프로젝트만), 근거 링크(http/https, 서버가 열지 않음), 자기 기입 수행일(최대 내일) vs 기록 시각, `clientId` 재전송 중복 방지, cursor 목록·태그/작성자 필터, 과제 화면의 작성 폼(임시 저장·재시도)·타임라인·수정 이력 |
| T-05 파일 업로드·격리·검사 | 다음 | |

화면: `/login`, `/onboarding`(프로필 설정 겸용), `/projects`, `/projects/[id]`(개요·빌드 로그·멤버), `/invite/[token]`, `/u/[handle]`.

빌드 로그 API: `POST/GET /api/v1/projects/:id/logs`, `GET /api/v1/logs/:id`, `GET/POST /api/v1/logs/:id/revisions`. 읽을 수 없는 프로젝트·로그는 404, reviewer/viewer의 작성·수정은 403입니다.

## 준비

- Node.js 24(`.nvmrc`, Active LTS). 22.19+도 지원합니다. 다른 버전에서는 `Unsupported engine` 경고가 날 수 있습니다.
- pnpm 11.28.2(`corepack enable` 또는 `packageManager` 필드 사용)
- Docker(로컬 DB를 쓸 때)

## 실행

```sh
pnpm install
cp .env.example .env                          # 로컬 전용 값. 실제 비밀값을 넣지 마세요.
docker compose -f ops/docker-compose.yml up -d
pnpm db:migrate
pnpm dev                                      # http://localhost:3000
pnpm test
```

- 로그인: `/login`에 이메일을 넣으면 `pnpm dev` 콘솔에 `[dev-console mail]` 블록으로 로그인 링크가 출력됩니다(개발 전용, 실제 메일 발송 없음).
- 5432 포트가 이미 쓰이고 있으면 `.env`의 `POSTGRES_PORT`와 `DATABASE_URL` 포트를 함께 바꾸고 `docker compose --env-file .env -f ops/docker-compose.yml up -d`로 띄우세요(compose는 기본적으로 `ops/.env`를 읽습니다).
- `pnpm test`는 `DATABASE_URL`이 없으면 DB 통합 테스트(`packages/db`, `apps/web/test/*.integration.test.ts`)를 건너뜁니다. 통합 테스트는 트랜잭션 rollback으로 데이터를 남기지 않습니다. 실행하려면 `DATABASE_URL=postgres://peerchive:peerchive@localhost:5432/peerchive pnpm test`.
- 끝나면 `docker compose -f ops/docker-compose.yml down`(데이터 볼륨 `peerchive-pg-data`는 유지, 지우려면 `down -v`).

## 환경 변수

| 변수 | 기본값 | 내용 |
|---|---|---|
| `DATABASE_URL` (`NUXT_DATABASE_URL`) | 없음 | PostgreSQL 접속 문자열(서버 전용) |
| `NUXT_SITE_ORIGIN` | `http://localhost:3000` | 허용 사이트 origin(쉼표 구분). 첫 항목으로 로그인·초대 링크를 만들고, 상태 변경 API(POST/PATCH/PUT/DELETE)의 `Origin`/`Referer`가 이 목록과 다르면 403. 배포 시 실제 origin으로 꼭 설정 |
| `NUXT_MAIL_TRANSPORT` | `dev-console` | 현재 `dev-console`(개발 전용)만 있음. production에서는 이 값으로 서버가 시작되지 않음 |

- 빌드한 서버(`node apps/web/.output/server/index.mjs`)는 기본적으로 production으로 동작합니다(Secure 쿠키, dev-console 거부). 로컬에서 빌드 결과를 점검할 때만 `NODE_ENV=development`를 명시하세요.

## 그 밖의 명령

| 명령 | 내용 |
|---|---|
| `pnpm typecheck` | 모든 워크스페이스 타입 검사(web은 `nuxt typecheck`) |
| `pnpm build` | web 프로덕션 빌드(`apps/web/.output`) |
| `pnpm db:generate` | `packages/db/src/schema.ts` 변경을 SQL migration으로 생성 |
| `pnpm check:archive` | 원본 아카이브 보존 검증(`python3 scripts/check_archive.py`) |

스키마는 migration으로만 바꿉니다. `schema.ts`를 고쳤다면 `pnpm db:generate`로 생성한 SQL을 함께 커밋하세요(CI가 불일치를 검사합니다).
