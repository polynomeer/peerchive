# 0014. 케이스 스터디·포트폴리오 판·공개 프로필: 게시된 release에 고정한 템플릿 초안 + 문장마다 스냅샷 인용 + 바꾸지 않는 판 + 읽을 때마다 원본 확인

- 상태: 채택
- 날짜: 2026-10-20

## 맥락

T-14는 공개된 과제 사례를 개인 포트폴리오로 바꾸는 기능입니다(PROOFU_EVOLUTION_PLAN §10.1–§10.6·§11·§13.2, SYSTEM_DESIGN §6.5 CaseStudy·CaseSentence·PortfolioEdition·PortfolioItem·CompetencyEvidence·§11, DELIVERY_PLAN T-14 "모든 문장에 출처, 철회된 사례 자동 차단, 비공개 필드 HTML·JSON·OG·인쇄물 미포함", 시나리오 I). 지켜야 할 것:

1. 공개 경로는 승인된 release 스냅샷만 읽습니다(SYSTEM_DESIGN §1-1). 케이스·프로필이 공개로 보여 주는 것은 (a) 프로필의 공개 필드, (b) **지금** 제공 가능한 release 스냅샷, (c) 사용자가 케이스·판에 직접 쓴 글뿐입니다. 비공개 작업 테이블에서 공개 글을 만들지 않습니다.
2. 철회된 사례를 쓰는 포트폴리오 항목은 자동으로 이용 불가가 되고 원본 문장을 더 제공하지 않습니다(§1-4·§11). 읽기가 상태를 먼저 확인하므로 정리가 늦어도 노출되지 않습니다.
3. MVP 초안은 생성형 모델 없이 템플릿 조합입니다(§10.2). AI 다듬기(P1)·면접 준비 팩(P1)·채용자 Q&A(P2)·연락 요청(P2)은 범위 밖입니다.
4. 매트릭스는 근거 시각화이며 점수·색 농도가 없습니다. 자기 선언 스킬과 경험 근거를 구분합니다(§10.4).

## 결정

### 자격과 자기 공개(reveal-self)

- 케이스 스터디는 **지금 게시 중인** release(`loadServedRelease`: 공개 published + release published + 지금 release + 엠바고 없음) 하나에서만 만들 수 있고, 그 release의 비공개 참조 `refs.members`(스냅샷 가명 키 → 사용자 id, ADR 0011)에 들어 있는 사람(노출 방식 무관)만 만들 수 있습니다. 없는·철회된 공개는 404, 팀원이 아니면 422 `releaseSlug: not_member`.
- 그 release에서 **익명**("팀원 A")이던 사람이 케이스를 만들면 자기 공개 프로필과 그 익명 표시가 연결됩니다. 그래서 `revealSelf: true`를 명시해야 하고(아니면 422 `revealSelf: confirm_required`), 화면은 "사례 속 익명 표시가 당신이라는 것을 누구나 알 수 있게 됩니다. 다른 팀원의 표시는 바뀌지 않습니다"라는 경고와 확인란을 보여 줍니다. 확인은 `case_studies.reveal_self`에 남고 DB check(`not self_anonymous or reveal_self`)로도 보장합니다.
- **다른 팀원의 정체는 드러내지 않습니다**: 케이스 글·인용 표시는 스냅샷 글과 스냅샷의 팀원 표시(이름 또는 "팀원 B")만 씁니다. 고르기에 쓰는 "내가 쓴 로그·올린 파일"은 `refs`에서 계산하지만 글에 넣지 않습니다. 공개 프로필의 "사례 속 본인 표시"는 본인의 표시만입니다.
- 한계: 익명 팀원이 둘뿐인 팀에서 한 사람이 자기를 드러내면 남은 익명 표시가 다른 한 사람이라는 것은 추론될 수 있습니다(실명은 스냅샷에 없으므로 드러나지 않음).

### 템플릿 초안 생성 규칙

`@peerchive/domain generateCaseStudyDraft(snapshot, releaseVersion, self, jobTarget)` — 결정적(같은 입력이면 같은 결과), 저장된 스냅샷 글만 고정된 한국어 문장 틀에 채웁니다. 글은 공백을 정리하고 글자 수 기준으로 잘라 "…"를 붙일 뿐 바꾸거나 더하지 않습니다. 숫자는 스냅샷 항목을 센 값(기록 수·팀원 확인 수)뿐입니다. 시도(attempts)·오류 원문은 넣지 않습니다.

| 구역 | 고르는 것(스냅샷 순서 유지) | 문장 틀(예) |
|---|---|---|
| 문제와 결과 | 공개 제목·학생 요약, 내가 쓴 첫 검증의 결과(없으면 팀의 첫 검증을 "팀이 확인한 결과") | `{제목} — {요약}`, `확인한 결과: {결과}` |
| 내 역할 | 내 역할 선언(팀원 확인 → 미확인 → 이의 순, 최대 3), 내가 쓴 로그·참석한 회의의 종류별 개수 | `역할: {선언} (팀원 확인 2명)`, `직접 남긴 기록: 결정 2 · 막힘 1 · 회의 참석 1` |
| 핵심 결정 | 내가 쓴 ⚖️결정, 내가 쓰거나 참석한 회의의 결정 사항 | `선택: {선택} (선택지: A / B) · 기준: {기준}` |
| 막힘과 해결 | 내가 쓴 막힘 또는 내가 해결한 막힘 + 스냅샷의 💡해결(둘 다 인용) | `막힘: {증상} → 해결: {방법} (걸린 시간: 반나절)` |
| 검증 | 내가 쓴 ✅검증 | `검증: {대상} · 조건: {조건} · 결과: {결과}` |
| 한계·회고 | 내 결정의 "지나고 보니", 내 검증의 남은 질문, 해결하지 못한 내 막힘, 내 🔁회고 | `지나고 보니: …`, `남은 질문: …`, `회고: …` |
| 원본 링크 | 마일스톤 순서, 내가 올린 공개 파일 | `진행 단계: 기획 → 최종`, `산출물: {표시 이름}` |

- 직무(backend/frontend/data/pm/design/general)는 가운데 세 구역(결정·막힘과 해결·검증)의 순서를 바꿉니다(예: 백엔드는 결정 → 막힘 → 검증, 프론트엔드·디자인은 검증 → 결정 → 막힘, 데이터는 검증 → 막힘 → 결정). 문제와 결과·내 역할이 처음, 한계·회고·원본 링크가 끝입니다. 맨 앞 가운데 구역은 4개, 나머지는 3개까지 고릅니다. 같은 release로 직무별 케이스를 여러 개 만들 수 있습니다(§10.2).
- 테스트: 모든 사용자 글을 표식으로 바꾼 스냅샷에서 결과 글의 표식을 빼면 문장 틀 글자만 남는지(지어낸 글 없음), 같은 입력이면 같은 결과인지, 다른 팀원의 결정·선언·파일 글이 들어가지 않는지 확인합니다.

### 인용 모델

- 문장(`case_sentences`)마다 `citations: [{releaseVersion, kind, key}]`. kind는 `log`·`claim`·`milestone`·`artifact`(키는 스냅샷 가명 키, 파일은 버전 id)와 **`summary`**(key `summary`: 스냅샷의 공개 제목·학생 요약). 기획서의 네 종류에 `summary`를 더한 것은 "문제와 결과" 첫 문장이 요약에서 오기 때문입니다.
- 편집(`PATCH`)의 인용은 고정한 release 버전과 같아야 하고(422 `stale_release`) 그 스냅샷에 있는 키여야 합니다(422 `not_found`). 문장당 12개, 구역당 12문장, 전체 60문장, 문장 500자, 모르는 키 거부.
- **출처 없는 문장**은 초안에 둘 수 있지만 게시를 막습니다(409 `uncited_sentences` + `sentences[{section, index}]`). 예외는 **한계·회고 구역에서 `kind: 'reflection'`으로 표시한 문장**(본인 회고)뿐이며 공개 화면에 "본인 회고"로 표시됩니다. 다른 구역의 reflection은 422 `not_allowed`(DB check로도 보장).
- 표시: 인용 칩은 스냅샷에서 만든 짧은 글(`⚖️ 결정 · 카카오 지도`)과 공개 사례 페이지 안의 위치(`/p/<slug>#public-<키>`, 요약은 `#public-title`, 파일은 `#public-f-<버전 id>`)입니다. `PublicSnapshotView`가 역할 선언·마일스톤·파일에도 앵커 id를 붙이도록 넓혔습니다.
- 사용자가 쓴 제목·문장에는 공개 전 점검 규칙(`runPublicationChecks`, 위치 `case_study`)을 돌려 경고하고, 게시 때 확인(`confirmWarnings`) 없이는 409 `checks_unconfirmed`(선배 노트와 같음). 판의 한 줄 소개·역량 이름·스킬도 점검해 경고만 돌려줍니다(위치 `portfolio`).

### 상태와 이용 가능 여부

- `case_studies.status`: draft → published(→ 고치면 draft로) / unavailable(되돌리지 않음). 케이스는 만들 때의 release(`release_id`·`release_version`)에 고정되며 다른 release로 옮기지 않습니다.
- **읽을 때마다 원본 확인**: 공개 프로필·README 카드·인쇄 보기·판 미리보기·작성자 화면은 모두 `loadCaseStudiesWithRelease`로 케이스와 고정 release를 읽으면서 같은 쿼리에서 `servableReleaseSql`(ADR 0013)을 계산합니다. 원본이 철회·대체·엠바고되면 저장된 status와 무관하게 즉시 이용 불가로 보고, 공개 쪽에는 글 없이 "원본 사례를 더 이상 볼 수 없습니다"만, 작성자 화면에는 이유(withdrawn/replaced/blocked)와 "새 버전으로 다시 만들기"(같은 공개의 지금 release에 내가 팀원으로 있으면 그 slug)만 보입니다. 편집·게시는 409 `unavailable`.
- **worker 정리 handler** `case-studies`(`registerDerivedCleanup`, ADR 0012): `publication.withdrawn`·`publication.published` 때 그 공개의 release 중 지금 상태가 withdrawn/replaced인 것에 고정된 케이스를 `unavailable`(이유 withdrawn/replaced)로 표시합니다. 이벤트 내용이 아니라 release 행 상태로 판정하므로 늦거나 순서가 바뀌거나 중복돼도 결과가 같고, 지금 게시 중인 release의 케이스는 건드리지 않습니다. 엠바고로 잠시 막힌 경우는 표시하지 않습니다(풀리면 다시 보임).
- 작성자가 게시한 케이스를 고치면 draft로 돌아가 다시 게시할 때까지 공개 프로필에서 "지금은 볼 수 없는 케이스 스터디입니다"로 보입니다(점검 없이 바뀐 글이 공개되지 않게, 선배 노트와 같은 선택).

### 포트폴리오 판(edition)

- `portfolio_editions`: 사용자마다 version 1, 2, …(unique), `status` current/superseded(사용자마다 current 하나, 부분 unique), 한 줄 소개, 역량 행 `[{label, preset}]`, 자기 선언 스킬. `portfolio_items`(대표 케이스 최대 5, 순서), `competency_evidence`(역량 행 × 대표 케이스 × 스냅샷 kind·key, **점수·수준 필드 없음**).
- **바꾸지 않습니다**: 수정 API가 없습니다. `POST /portfolio-editions`가 새 판을 만들고 이전 current를 superseded로 바꿉니다(한 트랜잭션, 사용자별 advisory lock). 이전 판은 `GET /me/portfolio-editions`에서만 보이고 공개하지 않습니다. 공개 프로필은 지금 판만 씁니다.
- 대표 케이스는 내 것이고 게시 중이며 원본을 지금 제공할 수 있어야 합니다(422 `not_found`/`not_published`/`duplicate`). 판이 고정하는 것은 "어떤 케이스를 어떤 순서로"이고, 케이스 글 자체는 읽을 때 그 케이스의 지금 게시본을 보여 줍니다.
- `POST /portfolio-editions/preview`는 같은 검증으로 저장 없이 공개 보기 그대로를 돌려줍니다(화면의 "미리보기 → 판 공개").

### 역량 × 근거 매트릭스

- 행 = 역량(직무별 프리셋 `JOB_TARGET_PRESETS` 또는 직접 입력, 최대 12, 이름 중복 422), 열 = 대표 케이스. 칸의 근거는 **그 케이스가 인용한 스냅샷 항목**에서만 고를 수 있습니다(422 `not_cited`, 다른 케이스 422 `not_featured`, 요약 인용은 근거가 아님). 프리셋 행에 근거를 보내지 않으면 프리셋의 근거 종류 규칙으로 채우고(`suggestCompetencyEvidence`, 예: 디버깅 → 막힘 해결·막힘·해결, API 설계 → 결정), 화면은 추천을 미리 체크한 채 고치게 합니다.
- 칸은 읽을 때 `countEvidence`로 종류별 개수만 셉니다: 결정 · 막힘 해결(막힘과 그 해결을 함께 고르면 하나) · 막힘 · 해결 · 검증 · 회의 정리 · 진행 · 회고 · 팀원 확인(확인된 선언) · 역할 선언 · 마일스톤 · 산출물. 글은 "결정 2 · 막힘 해결 1", 근거 없으면 "–", 볼 수 없는 케이스면 "볼 수 없음"(근거를 싣지 않음). 칸의 근거 목록은 공개 사례 앵커로 이어집니다. 색·굵기로 정도를 나타내지 않습니다.
- "경험 근거가 있는 역량"(볼 수 있는 칸에 근거가 하나 이상)과 "자기 선언 스킬"(본인 입력, 근거 연결 없음)을 따로 표시합니다.

### 공개 프로필·내보내기

- `GET /api/v1/public/profiles/:handle`(익명, 공개 조회 공통 handler: no-store·nosniff·no-referrer·noindex 기본·운영 스위치 503·모든 거부 404, 세션 미들웨어가 공개 GET을 건너뛰어 쿠키 없음). 프로필 공개 필드는 T-02 공개 DTO 허용 목록 그대로이고 이메일·사용자/케이스/공개 id가 없습니다(대표 케이스는 `case-1`… 앵커). 한 줄 소개는 판의 것, 없으면 프로필의 것.
- 연락: 이메일 없이 연락 정책 안내 문구만("연락 요청 기능은 준비 중", 연락 요청은 P2).
- 후배 기여: 내가 **게시한** 케이스의 공개를 포크한 서로 다른 사람 수(본인 제외)와 **계정 이름으로** 게시한 선배 노트 수. 익명·표시명 노트는 실명 프로필과 연결하지 않으려고 세지 않습니다. 개수만, 순위 없음.
- 4년 타임라인: 내가 게시한 케이스의 공개(지금 제공 가능한 것) — 공개 제목·학기 표시(release의 `term_label`)·사례 링크, 연도(학기 연도, 없으면 게시 연도)·학기 순. 익명이던 사례는 본인이 연결을 확인해 게시한 케이스가 있을 때만 나옵니다.
- 화면 `/u/[handle]`(공개 레이아웃, SSR이 로그인 상태를 읽지 않음 — 공개 페이지 접두어에 `/u`를 더함), Open Graph는 이름·한 줄 소개만, 기본 noindex. 인쇄 보기 `/u/[handle]/print`(A4, 머리글 없음, 링크 주소를 글로 함께, ADR 0008과 같은 브라우저 "PDF로 저장"). 둘 다 같은 공개 API만 부릅니다.
- `GET /api/v1/public/profiles/:handle/readme-card.md`(`text/markdown; charset=utf-8`, 같은 공개 헤더): 이름·한 줄 소개, 볼 수 있는 대표 케이스의 제목과 첫 "문제와 결과" 문장(100자), `/p/<slug>`·`/u/<handle>` 절대 링크(`NUXT_SITE_ORIGIN` 첫 항목). 마크다운 특수 문자는 escape하고 볼 수 없는 케이스는 뺍니다.
- 누출 테스트: 작업 공간 테이블(고르지 않은 로그, 프로젝트 제목, 마일스톤 메모, 확인 메모, 체크인 메모)에 표식을 넣고 케이스 DTO·공개 프로필 JSON·README 카드 어디에도 표식·이메일·내부 id·익명 팀원의 실명이 없음을 확인합니다. 인쇄 보기는 같은 API만 쓰며 빌드 서버 스모크에서 HTML을 확인합니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /case-studies` | 201 | 401, 404(지금 공개 아님), 409 `limit_reached`, 422 `releaseSlug: not_member`·`revealSelf: confirm_required`, 429 |
| `GET /case-studies/:id` | 200 | 401, 404(작성자 아님 포함) |
| `PATCH /case-studies/:id` | 200 | 401, 404, 409 `version_conflict`(+currentVersion)·`unavailable`, 422(`not_found`·`stale_release`·`not_allowed`·`no_changes` 등) |
| `POST /case-studies/:id/publish` | 200(재요청 200) | 401, 404, 409 `uncited_sentences`(+sentences)·`checks_unconfirmed`(+warnings)·`empty`·`unavailable`·`version_conflict`, 422 |
| `POST /case-studies/:id/unpublish` | 200 | 401, 404, 409 `not_published` |
| `GET /me/case-studies`, `GET /me/case-study-sources` | 200 | 401 |
| `POST /portfolio-editions` | 201 | 401, 422(`not_found`·`not_published`·`duplicate`·`not_featured`·`not_cited`·`too_many`), 429 |
| `POST /portfolio-editions/preview` | 200 | 401, 422 |
| `GET /me/portfolio-editions` | 200 | 401 |
| `GET /public/profiles/:handle` | 200 | 404, 503 |
| `GET /public/profiles/:handle/readme-card.md` | 200 | 404, 503 |

migration `0013_portfolio`.

## 결과

- 공개 케이스 글의 출처가 "스냅샷 글 + 본인이 쓴 글"로 좁고, 원본 확인이 읽기 쿼리 안에 있어 철회·대체가 커밋 즉시 프로필·카드·인쇄 보기에서 사라집니다. worker는 저장 상태만 맞춥니다.
- 대가: 공개 프로필은 요청마다 대표 케이스(최대 5)·게시한 케이스의 release 스냅샷을 읽습니다. 파일럿 규모에 충분하며, 커지면 access_epoch를 키로 하는 짧은 캐시를 검토합니다.
- 원본이 새 버전으로 바뀌면 케이스를 새로 만들어야 합니다(옮기기 없음). 인용 키는 공개마다 안정적이므로 나중에 "이전 케이스의 글을 새 버전으로 옮기기"를 더할 수 있습니다.
- 한계: AI 다듬기(P1)·면접 준비 팩(P1)·채용자 Q&A(P2)·연락 요청(P2)·공유 토큰(ShareGrant, P1) 없음. PortfolioItem의 `claim_revision_id`(선언 직접 넣기)는 케이스 인용으로 대신했습니다. 템플릿 문장은 조사(을/를) 처리를 피한 틀이라 다소 딱딱합니다. 인쇄 보기에서 칸별 근거 목록은 접힌 채(개수만) 나옵니다. 선배 노트 수는 이름으로 쓴 것만 셉니다. 익명 팀원이 둘인 팀의 추론 한계는 위와 같습니다.

## 대안

- **공개 프로필에서 케이스 상태(status)만 믿기**: 쿼리는 단순하지만 worker가 늦으면 철회된 사례의 글이 남습니다(불변조건 위반).
- **케이스 게시 때 글을 판에 복사(판 스냅샷)**: 판이 완전히 고정되지만 철회 때 복사본을 따로 지워야 하고, 원본 확인을 복사본마다 다시 해야 합니다. 판은 케이스 선택만 고정하고 글은 케이스의 게시본을 읽는 쪽을 골랐습니다.
- **익명 사례는 케이스를 못 만들게 하기**: 가장 안전하지만 익명으로 동의한 팀원이 자기 몫을 포트폴리오에 쓸 수 없습니다. 본인만 명시적으로 드러내는 확인으로 풀었습니다.
- **출처 없는 문장 허용 + 표시만**: 편하지만 "모든 문장에 출처"(DELIVERY_PLAN)를 지키지 못합니다. 본인 회고만 좁게 허용했습니다.
- **매트릭스 칸을 근거 종류 규칙으로만 자동 계산**: 손이 덜 가지만 같은 종류의 기록이 모든 역량에 똑같이 들어가 근거가 흐려집니다. 추천은 규칙으로, 결정은 사람이 합니다.
