# 0010. 학교·과목·개념 태그 정규화와 엠바고: 운영자 테이블 + 즉시 다시 가리키는 병합 + 단조 엠바고

- 상태: 채택
- 날짜: 2026-10-20

## 맥락

T-10은 학교·과목·개설 학기·개념 태그와 엠바고입니다(DELIVERY_PLAN T-10: "병합 처리, 학기 종료 전 게시 요청 서버 거부", 시나리오 D). 이름은 학생이 입력하고 정규화는 삭제가 아니라 운영자 병합으로 합니다(PROOFU_EVOLUTION_PLAN §8.2, §8.6, SYSTEM_DESIGN §6.2). 교수 실명·평가 필드는 다루지 않습니다. 엠바고는 학기 종료 전 공개를 막지만 끝났다고 자동 공개하지 않습니다(§9.2, SYSTEM_DESIGN §7.2).

지금까지 앱에는 운영자 개념이 없었습니다. 병합·학기 종료 조정·엠바고 낮추기는 일반 사용자에게 줄 수 없는 일입니다.

## 결정

### 운영자

- `operators(user_id PK, granted_at, granted_by?, revoked_at?)` 테이블. `users.role` enum 대신 별도 테이블로 둡니다: 사용자 DTO·세션과 섞이지 않고, 부여·회수 시각이 남으며, 나중에 학생 큐레이터·학교 모더레이터(§8.6, §8.9.3)처럼 범위가 있는 역할을 따로 더하기 쉽습니다.
- 부여·회수는 CLI로만 합니다: `pnpm --filter @peerchive/db grant-operator <email> [--revoke]`(`packages/db/scripts/grant-operator.ts`, Node 22.18+ 타입 제거로 실행, 추가 의존성 없음). API는 없습니다. 감사 이벤트 `operator.grant`/`operator.revoke`(actor 없음 = 콘솔).
- 운영자는 비공개 과제 공간을 읽을 수 없습니다(§8). 프로젝트 API는 계속 멤버십으로만 판정하고, 운영자 엠바고 낮추기는 프로젝트 내용 없이 적용 엠바고만 돌려줍니다.
- 운영자 API(`/api/v1/operator/*`, `PATCH /api/v1/course-terms/:id`)는 운영자가 아니면 403 `operator_only`.

### 검색·중복 판정

- `pg_trgm` 확장(0008 migration 맨 앞의 `CREATE EXTENSION IF NOT EXISTS pg_trgm`; drizzle-kit이 확장을 만들지 않아 생성된 SQL에 직접 추가). 관리형 PostgreSQL은 이 확장을 허용해야 합니다(RDS·Cloud SQL·Supabase 등은 지원).
- 비교는 정규화 키로 합니다: `labelKey` = NFKC·소문자·글자/숫자/`+`/`#` 밖의 문자 제거(“운영 체제” = “운영체제”, “C++” ≠ “C”). 학교 `name_key`, 과목 `title_key`·`code_key`에 저장하고 GIN trgm 인덱스를 둡니다. 한국어 trigram이 동작함을 확인했습니다(PostgreSQL 16, UTF-8).
- 검색: 정본(merged_into null)만, 키 부분 일치(`like`) 또는 `%`(유사도 ≥ 0.3), 최대 20개. 병합된 이름으로 찾아도 정본이 나옵니다.
- 만들기: 같은 키의 정본 → 409 `already_exists`(후보, `confirmNew`로도 못 만듦). 유사도 ≥ 0.6 또는 같은 학교의 같은 과목 코드 → `confirmNew: true` 없이는 409 `similar_exists`(후보 최대 5개). 학교는 정본끼리 `name_key` 부분 unique, 과목은 학교별 advisory lock 안에서 확인합니다(학교 병합으로 같은 이름 과목이 한 학교에 모일 수 있어 DB unique로 두지 않음).
- 생성 한도: 학교·과목·새 학기·새 개념 태그 만들기는 사용자별 시간당 20회(공용 bucket `catalog_create`, 기존 rate-limit 모듈). 넘으면 429 `rate_limited`.

### 병합: 즉시 다시 가리키기(eager re-pointing)

읽을 때마다 merged_into를 따라가는 대신, 병합 트랜잭션 안에서 참조를 정본으로 옮깁니다. 읽기 쿼리(공개 과목 페이지·검색·집계, T-13)가 단순해지고 정본만 보면 되기 때문입니다.

- 학교 A → B: A의 과목을 B로 옮김. 같은 이름 과목이 생기면 운영자가 과목을 이어서 병합합니다.
- 과목 A → B(같은 학교만, 아니면 409 `different_school` — 학교를 먼저 병합): A의 학기 중 B에 같은 (연도, 학기)가 없으면 B로 옮기고, 있으면 A 학기를 B 학기로 병합(`course_terms.merged_into`)하며 그 학기의 프로젝트·학기 엠바고를 B 학기로 옮깁니다. 옮겨진 프로젝트의 엠바고는 단조 규칙대로 max(지금 값, B 학기 종료·학기 엠바고)로 올라갑니다. 개념 태그 연결도 옮깁니다(병합으로 12개를 넘을 수 있음).
- 개념 태그 A → B: 과목 연결과 하위 태그(parent_id)를 옮깁니다. 병합된 태그도 slug를 유지해 같은 slug로 다시 붙이면 정본으로 이어집니다.
- 순환·사슬 방지: 대상은 정본, 원본은 아직 병합되지 않은 행이어야 합니다(`checkMerge`: 자기 자신 422 `{into: 'self'}`, 원본이 병합됨 409 `already_merged`, 대상이 병합됨 409 `target_merged`). 원본을 가리키던 병합 행도 정본으로 바꿔(평탄화) 항상 한 단계입니다. 행은 지우지 않습니다.
- 감사: `school.merge`·`course.merge`(옮긴 학기·병합한 학기·옮긴 프로젝트 수)·`concept_tag.merge`.

### 개설 학기와 종료 시각

- (과목, 연도, 학기)마다 하나, 만들기는 idempotent(이미 있으면 200 `created: false`).
- `ends_at`은 서버가 계산합니다(서울 하루 끝 23:59:59.999): 1학기 6/30, 여름 8/31, 2학기 12/31, 겨울 다음 해 2월 말일(윤년 29일). 학교마다 실제 종강일보다 넉넉하게 잡은 값입니다. 사용자가 `endsAt`을 보내면 422 `{endsAt: 'not_allowed'}` — 짧은 종료일로 엠바고를 피하는 우회를 막습니다.
- 운영자만 `PATCH /course-terms/:id {endsAt, reason}`으로 고칩니다(감사). 늘리면 연결된 프로젝트의 엠바고도 같은 트랜잭션에서 올리고, 줄여도 이미 연결된 프로젝트의 엠바고는 줄지 않습니다.
- 연도는 30년 전부터 내년까지(지난 과제 되짚기 포함).

### 엠바고: 단조 증가

- `projects.embargo_until`: 학기를 연결하거나 바꿀 때마다 max(지금 값, 새 학기 종료·학기 엠바고, 이전 학기의 학기 엠바고)로만 올라갑니다. 옛 학기로 바꾸거나 연결을 끊어도 줄지 않습니다(옛 학기로 바꿔 엠바고를 피하는 우회 방지). 낮추기는 운영자만(`PATCH /operator/projects/:id/embargo {until|null, reason}`, 높이려 하면 422 `{until: 'not_lower'}`, 감사 `embargo.lower`).
- `embargoes(scope project|course_term, until, reason, requested_by, revoked_at?)`: 명시적 엠바고. 프로젝트 엠바고는 owner가(`POST /projects/:id/embargoes`, 더 거는 것이라 안전), 학기 엠바고는 운영자가 겁니다. 해제 API는 아직 없습니다(revoked_at 자리만).
- 적용 엠바고 = max(projects.embargo_until, 지금 학기의 학기 엠바고, 프로젝트 엠바고) — `computeEffectiveEmbargo`(@peerchive/domain, 활성 판정은 기존 `isEmbargoActive`). `GET /projects/:id`는 `embargo: {until, active, source}`를 싣습니다.
- 서버 판정 `assertPublishable(db, actor, projectId, now)`: 읽기 권한(아니면 404) + 엠바고(중이면 409 `embargo_active` + `until`). 게시 API는 T-11/T-12에서 만들며, 게시 트랜잭션 안에서 이 함수를 먼저 부르고 동의·파일·보류 검사를 더합니다. 학기가 끝나도 자동 공개는 없습니다.
- 지난 학기에 연결한 사후 작성 과제는 종료일이 지났으므로 자연히 엠바고가 없습니다.

## 결과

- 학교·과목·태그 정규화가 운영자 한 번의 병합으로 끝나고, 읽기 쿼리는 정본만 봅니다.
- 학생은 종료일을 정할 수 없고, 학기를 바꿔도 엠바고가 줄지 않으므로 게시 차단을 우회할 길이 운영자 조치(감사 기록)뿐입니다. 대신 잘못 연결한 과제는 운영자가 풀어 줘야 합니다.
- 학교 메일 인증·공식 학교 페이지·학생 큐레이터(§8.6, §8.9)는 아직 없습니다. `schools.verified_label`과 별도 operators 테이블은 그때 학교 인증 여부·범위 있는 역할을 덧붙일 자리를 남깁니다.
- 한계: 과목에서 태그를 떼는 기능이 없어(병합만 가능) 잘못 붙은 태그가 12개 한도를 채울 수 있습니다. 운영자 화면은 아직 없고 API만 있습니다. 종료 시각은 학기별 고정 규칙이라 학교별 학사일정과 다를 수 있습니다.

## 대안

- **`users.role` enum**: 간단하지만 사용자 행과 섞이고 부여 이력이 남지 않으며, 범위 있는 역할로 넓히기 어렵습니다.
- **읽을 때 merged_into 따라가기**: 병합이 가볍지만 모든 읽기·집계에 정본 해석이 들어가고, 겹치는 학기의 프로젝트를 한 학기로 모을 수 없습니다.
- **사용자가 종료일 입력**: 학교마다 정확하지만 짧은 날짜로 엠바고를 피할 수 있습니다.
- **학기 연결이 바뀌면 엠바고 다시 계산**: 단순하지만 옛 학기로 바꿔 엠바고를 피할 수 있습니다.
