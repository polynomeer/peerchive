# 0003. PostgreSQL + Drizzle ORM

- 상태: 채택
- 날짜: 2026-10-18

## 맥락

revision·동의·공개 상태를 트랜잭션과 제약으로 지켜야 하고, 이후 `pg_trgm`·`pgvector`·작업 큐(0004)를 같은 DB에서 쓰려 합니다(§4). 원본은 Sequelize `sync`로 스키마를 바꿨는데, 신규 앱에서는 명시적 migration이 필요합니다.

## 결정

- DB는 PostgreSQL 16, 드라이버는 `postgres`(postgres.js), ORM은 Drizzle(`drizzle-orm` + `drizzle-kit`).
- 스키마는 `packages/db/src/schema.ts`에 TypeScript로 정의하고, `pnpm db:generate`로 SQL migration을 `packages/db/migrations/`에 생성해 커밋합니다. 적용은 `pnpm db:migrate`. `push`/sync 방식은 쓰지 않습니다.
- 첫 slice 테이블: users, profiles, schools, courses, course_terms, projects, project_members, invitations, log_entries, log_revisions. 유일 제약 `(project_id, user_id)`, `(log_entry_id, revision_no)`.
- 외래 키는 기본 `no action`(무조건 cascade 금지, §6.6).
- 통합 테스트는 실제 PostgreSQL에서 트랜잭션 rollback으로 실행하며 `DATABASE_URL`이 없으면 건너뜁니다. CI `db` job은 service container로 실행하고 schema와 migration 불일치도 검사합니다.
- 로컬 DB는 `ops/docker-compose.yml`(루프백 바인딩, 로컬 전용 자격 증명).

## 결과

- 생성된 SQL을 리뷰할 수 있고, 수동 SQL(확장 설치, 부분 인덱스 등)도 migration에 추가할 수 있습니다.
- Drizzle는 1.0 이전(0.x)이라 메이저 변경 시 migration 형식·API 변경을 확인해야 합니다. 버전은 정확히 고정합니다.

## 대안

- Prisma: 스키마 DSL과 엔진 바이너리가 추가되고 SQL 수준 제어가 상대적으로 약함.
- Kysely + 수동 SQL migration: 유연하지만 스키마 정의와 타입을 따로 관리해야 함.
- MySQL 유지: 원본과의 연속성은 있으나 `pgvector`·jsonb·pg-boss 이점을 잃음.
