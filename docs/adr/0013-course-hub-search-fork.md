# 0013. 과목 허브·선배 노트·플랜 포크·유용성 신호·검색: 공개 release만 읽는 허브 + 상태 조인으로만 읽는 파생 색인 + 계획 허용 목록 포크

- 상태: 채택
- 날짜: 2026-10-20

## 맥락

T-13은 공개 사례를 과목 단위로 묶어 후배가 "이 과목은 얼마나 걸리고 어디서 막히나"를 보게 하는 기능입니다(PROOFU_EVOLUTION_PLAN §3.1·§8.1–§8.6·§13.2, DELIVERY_PLAN T-13 "공개 release만 노출, 포크는 계획 요소만 복사", 시나리오 F). 처음으로 공개 데이터에서 **파생 데이터**(검색 색인·유용성 신호·포크 수)를 만들고, 공개 사례 없이 쓰는 공개 글(선배 노트)이 생깁니다. 지켜야 할 것:

1. 공개 경로는 승인된 release 스냅샷만 읽습니다(SYSTEM_DESIGN §1-1). 과목 허브도, 검색도, 포크도 비공개 작업 테이블로 공개 DTO를 만들지 않습니다.
2. 철회되면 공개 사례·검색·집계가 막히고, 읽기 경로는 상태를 먼저 확인하므로 파생 데이터 정리가 늦어도 노출되지 않습니다(§1-4, ADR 0012).
3. 워크로드 분포는 `share_for_stats = true` 체크인만, 그룹이 5명 미만이면 결과 없음(§11.2).
4. 포크는 계획만: 코드·보고서 본문·막힘의 해결 내용은 복사하지 않습니다(§8.4).
5. 교수 실명·평가는 다루지 않고, "도움됐어요" 신호는 카드 정렬에만 쓰며 작성자 점수로 합산하지 않습니다(§8.5·§8.6).

막힘 Q&A(§8.5)는 P1이라 이번 범위에서 뺐습니다. 소유자가 제안 중인 학교 인증 작성자·허브 단계적 개방·큐레이터·과목 등록·캠퍼스 커뮤니티(PROOFU_EVOLUTION_PLAN 미커밋 수정)는 구현하지 않고, 끼워 넣을 자리만 남겼습니다(아래 "작성 자격").

## 결정

### 과목 허브의 데이터 출처

`GET /api/v1/public/courses/:id`(익명, 쿠키 없음, `no-store`·`noindex` 기본, 운영 스위치 503 — ADR 0012의 공개 조회 규칙과 같은 공통 handler `createPublicJsonHandler`).

| 구역 | 출처 | 조건 |
|---|---|---|
| 과목·학교 이름, 개념 태그 | 학생 작성 카탈로그(T-10) | 정본 과목. "학생 작성" 표시(`authoredBy: 'student'`). 교수 필드 없음 |
| 공개 사례 | `publication_candidates.snapshot`(지금 release) | 이 과목(정본 + 병합된 id)에 연결된 release 중 `servableReleaseSql`(공개 published + release published + 지금 release + 엠바고 없음)을 **같은 쿼리에서** 만족하는 것. 제목·학기 표시·수준·팀 크기(스냅샷 참여자 수)·마일스톤·막힘 수·사후 작성·포크 수 |
| 자주 막히는 지점 | 위 스냅샷의 🧱막힘 로그 | 증상·키워드·시간 구간·해결 여부(같은 스냅샷의 💡해결이 가리키는지)만. 시도·오류 원문·해결 방법은 카드에 없음(사례 페이지 `/p/<slug>#public-<키>`에서 봄). 신호 많은 순 → 최근 순, 최대 30개 |
| 선배 노트 | `senior_notes` | `status = 'published'`만. 작성자 id 없음 |
| 체감 시간·난이도 | `weekly_checkins` | 이 과목 학기에 연결된 프로젝트의 `share_for_stats = true` 행만 `aggregateCheckinStats`로 집계. 동의한 사람 5명 미만이면 `stats: null` + "아직 데이터가 충분하지 않음". 학기 구분 없이(모든 학기) |
| 다른 학교에서는 | `course_concept_tags` | 같은 정본 태그를 가진 다른 학교의 정본 과목, 겹치는 태그 수 순 최대 5개 |

- **엠바고 SQL**: `servableReleaseSql`은 도메인 `canServePublicRelease`를 그대로 SQL로 옮긴 것이고, 엠바고는 `computeEffectiveEmbargo`와 같은 식(max(`projects.embargo_until`, 지금 학기의 해제되지 않은 학기 엠바고, 해제되지 않은 프로젝트 엠바고) > now)입니다. 게시 뒤 걸린 엠바고도 허브·검색·신호·포크에서 막힙니다(ADR 0012 규칙).
- **과목 연결은 게시 때 기록**: 스냅샷에는 학교·과목 이름만 있고 id가 없으므로(ADR 0011), 게시 트랜잭션에서 release에 `course_id`(그 학기의 **정본** 과목)·`term_label`("2025년 2학기")을 기록합니다. 조건: 스냅샷에 과목이 있고(동의한 manifest에 과목이 들어 있음) 프로젝트의 지금 학기가 스냅샷의 (연도, 학기)와 같을 때. 스냅샷에 과목이 없으면 게시 뒤 학기를 붙여도 허브에 나오지 않습니다(동의 범위 밖).
- **병합 rehome**: 운영자 과목 병합(ADR 0010)이 같은 트랜잭션에서 `publication_candidates.course_id`·`senior_notes.course_id`를 정본으로 옮기고 감사 metadata에 개수를 남깁니다. 읽기도 `courseScopeSql`(정본 + 그 정본으로 병합된 id)로 고르므로 옮기기 전 행도 정본 허브에 모입니다. 병합된 id로 부르면 정본 허브를 돌려주고(`course.id`가 정본), 화면은 정본 주소로 301.
- 공개 사례 응답(`GET /public/publications/:slug`)에 `courseId`(정본)·`forkCount`를 더했습니다.

### 선배 노트

- 테이블 `senior_notes`: 정본 `course_id`, `author_id`, `display_mode`(name/display/anonymous), `display_name_snapshot`(name이면 게시 때 계정 이름, display면 입력한 표시명, 익명이면 null), `term_label`(30자, 자유 입력), `total_time_bucket`(~10h/~20h/~40h/40h+, supply-kit §2), `answers` jsonb `{firstWeek, timeSink, differently, wishKnew}`(각 1000자, 비어 있지 않은 답 2개 이상, 모르는 키 거부), `no_answers_confirmed`(DB check: true), `status`(draft/published/withdrawn/hidden), `published_at`·`withdrawn_at`·`version`.
- **작성 자격 `canWriteToCourseHub(user, course)`**(도메인 한 곳): 지금은 active 사용자 + 정본 과목이면 true. 학교 인증 작성자·허브 개방 기준(사례·노트 수)은 이 함수에만 조건을 더하면 됩니다. 만들기·게시 때 모두 부릅니다(403 `hub_write_not_allowed`).
- 만들기 `POST /courses/:id/senior-notes`: "정답·답안·교수 개인 평가 없음" 체크 필수(422 `noAnswersConfirmed: confirm_required`), 사용자별 시간당 5회(429), 사용자·과목당 3개(409 `limit_reached`, 숨김 제외). 초안으로 저장.
- 수정 `PATCH /senior-notes/:id`(작성자만, 아니면 404 — 초안의 존재를 드러내지 않음, `expectedVersion` 409). **게시된 노트를 고치면 draft로 돌아갑니다**: 고친 글이 점검 없이 공개되지 않게 하고, 다시 게시하게 합니다.
- 게시 `POST /senior-notes/:id/publish {expectedVersion, confirmWarnings?}`: 공개 전 점검 규칙(`runPublicationChecks`: 전화·메일·주민번호·학번·사설 URL·긴 코드)을 답·직접 입력한 표시명·학기 표시에 돌립니다. 경고는 막지 않되, 확인(`confirmWarnings: true`) 없이는 409 `checks_unconfirmed` + 가린 표본. 같은 버전 재요청은 200.
- 철회 `POST /senior-notes/:id/withdraw`: 작성자, 즉시. 공개 읽기는 `published`만 보므로 커밋 즉시 사라집니다.
- 익명 노트는 "익명 선배"로만 보이고 공개 응답에 작성자 정보가 없습니다. 운영자는 감사 기록(actor)으로만 작성자를 압니다(조회 API 없음). `hidden`은 T-15 운영 조치 자리입니다(지금 API 없음, 고치기·게시 409 `hidden`).
- outbox `senior_note.published`·`senior_note.withdrawn`(`{seniorNoteId, courseId, version}`, 고쳐서 내려갈 때도 withdrawn).

### 검색: 파생 색인 + 동기 상태 조인

- `search_documents`(kind case/stuck/note): 사례·막힘은 `(publication_id, release_id, item_key)`, 노트는 `(senior_note_id, note_version)`과 제목·짧은 발췌·정규화한 검색 글(NFKC·소문자). pg_trgm GIN 인덱스.
- **만들기·지우기는 worker**: `publication.published` → 등록된 `search-index` handler가 지금 release 스냅샷에서 사례 1개 + 막힘 카드마다 1개 문서를 만들고 이전 release 문서를 지움. `publication.withdrawn` → 그 공개의 문서 전부 삭제. `senior_note.published` → 지금 version 문서로 교체, `senior_note.withdrawn` → 문서·신호 삭제. 게시 handler는 이벤트가 낡았으면(그 사이 철회·새 버전·노트 수정, access_epoch·version 비교) 아무것도 만들지 않아, 철회가 먼저 처리되고 늦은 게시 이벤트가 와도 철회된 내용을 다시 색인하지 않습니다.
- **읽기는 문서를 믿지 않습니다**: `GET /public/search?q=&type=&course=`는 문서를 원본 행과 조인해 같은 쿼리에서 확인합니다 — 사례·막힘은 문서의 `release_id` = 공개의 `current_release_id`이고 `servableReleaseSql`(엠바고 포함)을 만족할 때, 노트는 `status = 'published'`이고 문서의 `note_version` = 지금 `version`일 때만. 그래서 정리 handler가 아직 돌지 않아 문서가 남아 있어도 철회·대체·엠바고·수정된 내용은 나오지 않습니다(테스트로 확인). 반대로 worker가 아직 색인하지 않은 새 게시물은 잠시 검색되지 않을 수 있습니다(허브·사례 페이지에는 바로 보임).
- 일치: 정규화한 글의 부분 일치(ILIKE, 한국어 2글자 검색어용) 또는 pg_trgm 단어 유사도(`<%`), 유사도 → 최근 순, 종류별 최대 20개. 과목 필터는 원본 행의 정본 과목으로 겁니다(문서에 과목을 넣지 않아 병합에도 따로 고칠 것이 없음). 검색어 100자 초과·모르는 type·형식이 틀린 course는 422, 없는 과목은 빈 결과. 색인하는 글은 사례 제목·요약·마일스톤 이름, 막힘 증상·키워드, 노트 답·학기 표시뿐입니다(로그 본문·시도·해결은 색인하지 않음).

### 플랜 포크: 계획 허용 목록

- `POST /api/v1/public/publications/:slug/fork`(로그인 필수 401, 지금 공개인 release만 404, 사용자별 시간당 10회 429).
- 포크한 사람이 owner인 **새 비공개 과제**: 제목 "<원래 제목> 계획 포크", 개인 과제, 학기 없음, 사후 작성 꺼짐. 프로젝트 만들기·마일스톤 만들기 서비스(T-03·T-06)를 그대로 써서 권한·한도·감사가 같습니다.
- **복사 허용 목록**(`forkPlanFromSnapshot`, 저장된 스냅샷에서만):
  - 마일스톤 이름·순서. 예정일 자체는 복사하지 않고, 예정일이 둘 이상이면 첫 예정일 기준 상대 일수("원래 계획에서 첫 예정일 기준 +14일")를 마일스톤 메모로 남깁니다(학기 날짜가 다르므로 시간 배분만 옮김).
  - 포함된 로그의 근거 링크(💡해결 로그의 링크는 해결 내용일 수 있어 제외, 중복 제거, 최대 10개) → 새 프로젝트 개요의 `요약`(summary_by_student)에 "참고 자료(포크한 계획에서 가져옴)" 목록. 별도 참고 자료 테이블(SYSTEM_DESIGN §6.3 Reference)은 아직 없으므로 가장 작은 선택으로 개요 메모를 썼습니다. 사용자가 고치거나 지울 수 있습니다.
  - 그 밖의 모든 것(로그·해결·결정 내용·역할 선언·파일·사람 이름·사용 조건·날짜)은 복사하지 않습니다. 원본 스냅샷에는 할 일·체크리스트·주차별 시간이 없으므로(T-11 허용 목록) 이번에는 복사되지 않습니다.
- `plan_forks`(source publication·release·release_no, target project unique, forked_by, 복사 개수). **(원본 공개, 사용자)마다 하나**: 같은 사람이 다시 포크하면 새로 만들지 않고 기존 프로젝트를 200 `created: false`로 돌려줍니다(새 버전이 나와도 다시 만들지 않음 — 포크 수가 사람 수와 같게 하려는 선택). 처음이면 201. 포크 수 = 행 수 = 서로 다른 사용자 수. 원본이 철회돼도 포크한 프로젝트는 포크한 사람의 데이터로 남고, 원본으로 가는 링크는 공개 조회 규칙대로 끊깁니다(§11). 감사 `plan.fork`.

### 유용성 신호

- `usefulness_signals`: 대상은 막힘 카드(`publication_id` + 스냅샷 로그 키, 키는 공개마다 안정된 가명 키라 새 버전에서도 같은 막힘이면 유지) 또는 선배 노트. 종류 `me_too`(나도 여기서 막혔어요, 막힘만)·`helped`(도움됐어요). (사용자, 대상, 종류)마다 하나(부분 unique).
- `PUT /signals`(idempotent)·`DELETE /signals`: 로그인, 대상이 **지금 공개**여야 함(아니면 404), 시간당 300회. 응답은 그 대상의 개수와 내 신호. `GET /me/signals`는 지금 공개인 대상의 내 신호만(화면의 눌림 표시).
- 읽기는 지금 공개인 대상만 골라 그 대상의 신호를 셉니다. **작성자별 합계는 어디에도 만들지 않습니다.** 철회된 대상의 신호는 읽기에서 무시되고, worker `usefulness-signals` handler가 철회 때 지우며 새 버전 게시 때 지금 스냅샷에 없는 막힘의 신호를 지웁니다. 노트 철회 handler도 노트 신호를 지웁니다.

### 공개 경로와 세션

- 공개 페이지 판정을 `/p/**`·`/c/**`·`/search`로 넓혔습니다(SSR이 로그인 상태를 읽지 않는 레이아웃·플러그인 규칙 그대로). 신호 버튼·포크 버튼·노트 쓰기 링크는 화면이 뜬 뒤 클라이언트에서 로그인 여부를 확인합니다.
- ADR 0012의 "세션 미들웨어는 `/api/v1/public/**`를 건너뜀"을 **읽기(GET/HEAD)에만** 적용하도록 좁혔습니다(`isAnonymousPublicRequest`). 같은 접두어의 쓰기인 포크 POST는 세션을 읽고 CSRF 검사를 받습니다. 운영 스위치는 접두어 전체(포크 포함)에 그대로 적용됩니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /public/courses/:id` | 200(병합 id면 정본) | 404, 503 |
| `GET /public/search` | 200(빈 검색어·없는 과목은 빈 결과) | 422(q too_long, type·course invalid), 503 |
| `POST /public/publications/:slug/fork` | 201(새로), 200(이미 포크) | 401, 403(CSRF), 404, 429, 503 |
| `POST /courses/:id/senior-notes` | 201 | 401, 403 `hub_write_not_allowed`, 404, 409 `limit_reached`, 422, 429 |
| `PATCH /senior-notes/:id` | 200 | 401, 404, 409 `version_conflict`·`hidden`, 422 |
| `POST /senior-notes/:id/publish` | 200(재요청 200) | 401, 403, 404, 409 `checks_unconfirmed`(+warnings)·`version_conflict`·`hidden`, 422 |
| `POST /senior-notes/:id/withdraw` | 200(이미 철회 200) | 401, 404, 409 `not_published` |
| `GET /me/senior-notes?course=` | 200 | 401, 404(없는 과목) |
| `PUT /signals`, `DELETE /signals` | 200 | 401, 404, 422(`kind: not_allowed` 등), 429 |
| `GET /me/signals` | 200 | 401 |

migration `0012_course_hub`.

## 결과

- 허브·검색·신호·포크가 모두 같은 `servableReleaseSql`을 써서 "지금 공개"의 정의가 한 곳입니다. 철회·대체·엠바고는 커밋 즉시 모든 경로에서 사라지고, worker는 남은 사본만 지웁니다.
- 대가: 과목 허브는 요청마다 사례 스냅샷(최대 50개)을 읽어 막힘 카드를 만들고, 체크인 집계도 요청마다 계산합니다. 파일럿 규모에는 충분하며, 커지면 access_epoch를 키로 하는 짧은 캐시나 집계 뷰를 검토합니다(SYSTEM_DESIGN §11.2의 materialized view는 아직 아님).
- 새 게시물은 worker가 색인하기 전까지 검색에 나오지 않습니다(허브·사례 페이지에는 즉시).
- 한계: 막힘 Q&A(P1)·신고(T-15)·학교 인증·허브 단계적 개방 없음, 노트 `hidden`은 API 없음, 참고 자료는 별도 테이블이 아니라 개요 메모, 체크인 분포는 과제 유형 구분 없이 과목 단위, 막힘 카드 정렬은 신호 합계(나도 막힘 + 도움됨)와 최근 순뿐, 다른 학교 과목은 공개 내용이 없어도 나올 수 있음, 검색은 전문 검색(tsvector) 없이 부분 일치·trigram.

## 대안

- **검색 문서만 보고 결과 반환(정리에 기대기)**: 쿼리는 단순하지만 worker가 늦으면 철회된 내용이 검색에 남습니다(불변조건 위반).
- **공개 행에서 바로 ILIKE(색인 테이블 없음)**: 파생 데이터가 없어 정리가 필요 없지만 스냅샷 jsonb 전체를 매번 훑게 되고, 과목명·한국어 부분 일치 인덱스를 쓸 수 없습니다.
- **과목 연결을 스냅샷에 넣기**: 스냅샷·manifest 형식(동의 해시)이 바뀌고, 병합 때 스냅샷을 고칠 수 없습니다. release 행의 열로 둬서 병합 rehome이 가능합니다.
- **포크를 새 버전마다·여러 번 허용**: 포크 수가 사람 수와 달라지고 같은 계획 복사본이 쌓입니다.
- **참고 자료를 진행 로그 하나로 만들기**: 포크한 사람의 과정 기록처럼 보이고 나중에 공개 후보에 섞일 수 있어 피했습니다.
- **게시된 노트 수정은 그대로 공개 유지**: 편하지만 고친 글이 점검·확인 없이 공개됩니다.
