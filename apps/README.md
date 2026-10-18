# Peerchive 신규 앱 (Phase 0 기술 골격)

2019년 원본 ProofU(`frontend/`, `backend/`)와 별개로 만드는 신규 앱입니다. 원본은 기록 보존 대상이며 이 워크스페이스에 포함되지 않습니다. 결정 배경은 [ADR](../docs/adr/README.md)과 [시스템 설계](../docs/planning/SYSTEM_DESIGN.md)를 보세요.

## 구성

| 경로 | 내용 |
|---|---|
| `apps/web` | Nuxt 4(Vue 3, TypeScript strict). `/` 안내 페이지, `GET /api/v1/health` |
| `packages/domain` | 런타임 의존성 없는 도메인 규칙: 과제 공간 읽기 권한, 공개 상태 전이, 기여 확인 |
| `packages/db` | Drizzle ORM 스키마(첫 slice), SQL migration(`migrations/`), `createDb(url)` |
| `ops/docker-compose.yml` | 로컬 개발용 PostgreSQL 16 |

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

- 5432 포트가 이미 쓰이고 있으면 `.env`의 `POSTGRES_PORT`와 `DATABASE_URL` 포트를 함께 바꾸고 `docker compose --env-file .env -f ops/docker-compose.yml up -d`로 띄우세요(compose는 기본적으로 `ops/.env`를 읽습니다).
- `pnpm test`는 `DATABASE_URL`이 없으면 DB 통합 테스트를 건너뜁니다. 실행하려면 `DATABASE_URL=postgres://peerchive:peerchive@localhost:5432/peerchive pnpm test`.
- 끝나면 `docker compose -f ops/docker-compose.yml down`(데이터 볼륨 `peerchive-pg-data`는 유지, 지우려면 `down -v`).

## 그 밖의 명령

| 명령 | 내용 |
|---|---|
| `pnpm typecheck` | 모든 워크스페이스 타입 검사(web은 `nuxt typecheck`) |
| `pnpm build` | web 프로덕션 빌드(`apps/web/.output`) |
| `pnpm db:generate` | `packages/db/src/schema.ts` 변경을 SQL migration으로 생성 |
| `pnpm check:archive` | 원본 아카이브 보존 검증(`python3 scripts/check_archive.py`) |

스키마는 migration으로만 바꿉니다. `schema.ts`를 고쳤다면 `pnpm db:generate`로 생성한 SQL을 함께 커밋하세요(CI가 불일치를 검사합니다).
