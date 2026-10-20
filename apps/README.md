# Peerchive 신규 앱

2019년 원본 ProofU(`frontend/`, `backend/`)와 별개로 만드는 신규 앱입니다. 원본은 기록 보존 대상이며 이 워크스페이스에 포함되지 않습니다. 결정 배경은 [ADR](../docs/adr/README.md)과 [시스템 설계](../docs/planning/SYSTEM_DESIGN.md)를 보세요.

## 구성

| 경로 | 내용 |
|---|---|
| `apps/web` | Nuxt 4(Vue 3, TypeScript strict). 화면(`app/`), `/api/v1` 라우트(`server/api`), 서비스 모듈(`server/modules`), 공유 DTO 타입(`shared/types`) |
| `apps/worker` | 작업 worker(pg-boss, [ADR 0004](../docs/adr/0004-pg-boss-jobs.md)). outbox 전달과 파일 검사 작업 |
| `apps/bot` | 디스코드 봇(discord.js gateway, [ADR 0009](../docs/adr/0009-discord-bot-and-checkins.md)). `/log`·📌 수집, 승인 요청 DM, 체크인 알림·주간 요약 게시. 규칙은 웹 서버 내부 API에 있음([설정 안내](bot/README.md)) |
| `packages/domain` | 런타임 의존성 없는 도메인 규칙: 과제 공간 권한 정책, 빌드 로그 작성·수정·해결 연결 규칙, 공개 상태 전이·공개 후보 권한·결정적 JSON(manifest 해시)·공개 전 점검 규칙, 역할 선언·팀원 확인·기여 장부 기간 규칙, 산출물 업로드·열람 정책과 검사 상태 전이, 마일스톤·할 일·사후 작성 규칙, 주간 체크인 주(서울 ISO 주)·알림 일정·익명 집계(n≥5), 학교·과목 이름 정규화 키·학기 종료 시각·개념 태그 slug·병합 전제 조건·단조 엠바고·적용 엠바고 계산 |
| `packages/db` | Drizzle ORM 스키마, SQL migration(`migrations/`), `createDb(url)`, 운영자 부여 CLI(`scripts/grant-operator.ts`) |
| `packages/bot-protocol` | 웹 ↔ 봇 내부 API 약속: HMAC-SHA256 요청 서명·검증(시각 차이 5분, nonce)과 요청/응답 타입 |
| `packages/files` | 오브젝트 저장소 추상화(파일시스템 driver), 파일 형식 판별, 악성코드 검사 어댑터(clamd), 검사 작업([ADR 0007](../docs/adr/0007-file-storage-and-scanning.md)) |
| `ops/docker-compose.yml` | 로컬 개발용 PostgreSQL 16, 선택 profile `clamav`(clamd) |

## 구현 현황

[실행 계획 §4](../docs/planning/DELIVERY_PLAN.md) 백로그 기준입니다.

| 항목 | 상태 | 내용 |
|---|---|---|
| T-01 개발 환경·DB migration·CI | 완료 | Nuxt 4 골격, PostgreSQL+Drizzle migration, CI(아카이브·앱·DB 통합) |
| T-02 세션·공개/비공개 프로필 | 완료 | 이메일 매직링크, DB 세션(30일·sliding), CSRF Origin 검사, `/me`·프로필·공개 프로필·탈퇴 요청([ADR 0006](../docs/adr/0006-auth-sessions.md)) |
| T-03 과제·초대·프로젝트 권한 | 완료 | 과제 생성·목록·수정(version 409), 멤버·초대(7일·일회성·취소)·역할 변경·내보내기·나가기·소유권 이전, 감사 이벤트 |
| T-04 빌드 로그·revision·태그별 payload | 완료 | 7개 태그별 payload 검증(모르는 키 거부), 수정은 새 revision(낡은 `expectedRevision`은 409 `stale_revision`)·태그 변경 불가(422 `tag: immutable`), 💡해결↔🧱막힘 연결(같은 프로젝트만), 근거 링크(http/https, 서버가 열지 않음), 자기 기입 수행일(최대 내일) vs 기록 시각, `clientId` 재전송 중복 방지, cursor 목록·태그/작성자 필터, 과제 화면의 작성 폼(임시 저장·재시도)·타임라인·수정 이력 |
| T-05 파일 업로드·격리·검사 | 완료 | 업로드 의도(15분)→PUT(스트림·SHA-256·크기 한도)→완료(idempotent, 같은 내용 중복 방지) 3단계, 파일당 20MB·1인당 500MB, worker 검사(magic-byte 판별·선언 형식/확장자 대조·내장 콘텐츠 점검·ClamAV 또는 개발용 signature-only), `pending→scanning→clean/quarantined/failed`·재시도·dead-letter, clean만 멤버에게 내려줌(그 밖에는 404, nosniff·sandbox CSP), 빌드 로그 파일 근거(같은 프로젝트·최대 10개·revision 이어받기), 과제 화면의 산출물 섹션(진행률·상태 문구·미리보기·새 버전)과 근거 선택([ADR 0007](../docs/adr/0007-file-storage-and-scanning.md)) |
| T-06 마일스톤·스냅샷·진화 보기 | 완료 | 마일스톤(프로젝트당 12개, 이름 80자·메모 500자·예정일·자기 기입 도달일, version 409), 기본 단계 템플릿(기획→중간발표→구현→검증→최종제출, 빈 프로젝트만), 순서 변경(전체 순열만, ▲▼ 버튼)·position 빈틈없이 유지, 삭제는 어떤 로그 revision(이전 것 포함)이라도 가리키면 409 `in_use`(스냅샷은 함께 해제), 스냅샷은 같은 프로젝트의 clean 버전만(마일스톤당 6개, 검사 중 422 `not_clean`, 중복 409), 빌드 로그의 마일스톤 연결(revision별·이어받기·같은 프로젝트만)과 `milestone=` 필터, 과제 화면의 마일스톤 섹션·진화 보기(가로 스크롤 영역)·타임라인 구분선 |
| T-07 할 일·완료 전환·사후 작성 모드 | 완료 | 할 일(원본 Card 계승, 제목 120자·메모 1000자·담당자는 active 멤버·마감일, 열린 할 일 200개·전체 500개, version 409), 상태 메뉴와 ▲▼ 순서 변경(상태별 position 빈틈없이, 상태를 바꾸면 새 목록 맨 뒤, 드래그 없음), 완료 시 "막힌 적 있었나요? 결정할 게 있었나요?" 프롬프트(응답 없이도 완료)와 빌드 로그 전환(source `task`, 할 일당 한 번, 빌드 로그 검증 그대로, 전환한 할 일은 삭제 불가), 사후 작성 모드(만들 때 선택, 이후 owner만 켜고 끔, 그 모드에서 만든 로그(source `retro`)·마일스톤·스냅샷은 `retrospective`로 고정되어 모드를 꺼도 남음), 모든 프로젝트·로그·마일스톤·스냅샷 DTO의 `retrospective`(공개 DTO T-11/T-12로 옮길 대상), 과제 화면의 할 일 섹션·완료 프롬프트·`사후 작성` 배지·기억·파일 기준 날짜 칸·되짚기 안내 |
| T-08 역할 선언·팀원 확인·기여 리포트 | 완료 | 역할 선언(문장 300자, 멤버당 10개)과 근거(같은 프로젝트의 로그 revision·파일 버전, 최대 20개, 격리·실패 파일 422, 검사 중은 허용), 수정은 작성자만 새 revision(owner도 403, 낡은 `expectedRevision` 409)이고 새 revision은 `본인 설명 · 미확인`부터, 팀원 확인·이의(작성자 아닌 owner/editor/reviewer, 자기 확인 403, 이전 revision 409 `not_current`, 이의는 메모 필수, 이의가 있으면 `이의 있음`), viewer는 읽기만, 기간 장부(서울 월~일, 종류별 개수·할 일 완료·clean 파일·회의 참석·선언 상태, 이름순, 점수·순위 없음, 나간 멤버는 그 기간 기록이 있을 때만), 주간 요약 문장 함수(pilot-kit §4.1), 과제 화면의 기여 섹션(선언 폼·근거 선택·확인 초기화 안내·이력·기간 요약 표)과 인쇄용 동료평가 리포트 `/projects/[id]/report`([ADR 0008](../docs/adr/0008-contribution-report-format.md)) |
| T-09 디스코드 봇·주간 체크인 | 완료(실제 디스코드 연동은 미검증) | 디스코드 계정 연결(웹에서 10분·일회용 코드 → `/peerchive link`, 해시 저장, 계정당 하나·해제), owner의 채널 연결(`/peerchive bind`, 한 채널 한 과제, 주간 요약은 채널별 선택), `/log 태그 내용`(진행·회고·회의는 본문, 막힘은 증상+선택 시간, 결정·검증은 모달, 해결은 웹 안내, 빌드 로그 검증 그대로)·📌(내 메시지는 바로 🔨진행, 남의 메시지는 작성자 승인 DM 48시간 — 승인 전 로그 없음, 결정·만료 때 저장한 내용 삭제), 디스코드 id 기반 clientId(UUID v5)로 재전송해도 로그 하나, 출처 `디스코드` 표시, 연결 안 된 사용자·비멤버는 안내만(저장 없음), 봇↔웹 HMAC 서명 내부 API(`/api/internal/discord/*`, 쿠키로는 호출 불가), 주간 체크인(60초 폼: 시간·난이도·한 줄·못 한 이유·통계 동의(기본 꺼짐), 주마다 upsert, 이번 주·지난주만, 팀 안 공개, 한 줄 → 🔨진행/🧱막힘 로그 1회), 대시보드 "이번 주 체크인", 체크인 알림(일 20시)·주간 요약(화 10시, `formatWeeklySummary`) 예약 게시(채널·종류·주마다 한 번), 익명 집계 함수(n≥5)([ADR 0009](../docs/adr/0009-discord-bot-and-checkins.md)) |
| T-10 학교·과목·개념 태그·엠바고 | 완료 | 학생 작성 학교·과목(정규화 키 + pg_trgm 검색, 최대 20개, 병합된 행은 정본으로), 같은 이름 409 `already_exists`·비슷한 이름/같은 과목 코드 409 `similar_exists`(`confirmNew`), 사용자별 생성 한도(시간당 20회, 429), 개설 학기(과목·연도·학기마다 하나, 종료 시각은 서버 계산: 1학기 6/30·여름 8/31·2학기 12/31·겨울 다음 해 2월 말일, 서울 하루 끝, 사용자는 못 정함), 개념 태그(slug 정규화, 과목당 12개), 운영자(`operators` 테이블, CLI로만 부여, 비공개 과제 열람 권한 없음)의 학교·과목·태그 병합(한 트랜잭션에서 학기·프로젝트·학기 엠바고·태그 연결을 정본으로 옮김, 평탄화로 순환·사슬 없음, 과목은 같은 학교끼리)·학기 종료 조정·엠바고 낮추기(감사), 단조 엠바고(`projects.embargo_until`은 학기를 바꾸거나 떼도 줄지 않음)·명시적 엠바고(`embargoes`)·적용 엠바고 계산, 게시 판정 `assertPublishable`(T-11/T-12가 부름, 엠바고 중 409 `embargo_active`), 과제 만들기·과목 정보 패널의 과목 고르기(학교 → 과목 → 학기, 비슷한 이름 확인), 헤더 엠바고 배지, 개념 태그 추가([ADR 0010](../docs/adr/0010-catalog-merge-and-embargo.md)) |
| T-11 공개 후보·점검·미리보기·동의 | 완료 | 공개(프로젝트당 하나, slug 예약어·중복 422)와 공개 후보: 요약/전체 수준, 공개 제목(80자)·학생 요약(1000자), 고른 로그·선언은 지금 revision으로 고정, 마일스톤(전체 공개면 스냅샷 포함), 파일은 전체 공개에서 clean 버전만(422 `not_clean`/`not_allowed`), 사람별 노출(기본 익명 "팀원 A/B…"), 파일 사용 조건(열람만·SPDX 허용 목록·외부 출처). 공개 데이터는 `buildPublicSnapshot` 하나로만 만들어 후보에 저장(허용 목록, 이메일·사용자 id·체크인·메모·확인 메모·저장소 키·비공개 링크·학기 id 없음, 안정된 가명 키, 누출 테스트), manifest(고정 revision·버전·노출 이름·사용 조건 + 스냅샷 다이제스트)의 canonical JSON SHA-256 해시에 동의를 묶음. 엠바고 중 409 `embargo_active`, 새 후보는 이전 후보를 대체(409 `superseded`). 공개 전 점검 경고(전화·메일·주민번호·학번·사설 URL·문제지/답안 파일명·긴 코드·익명 팀원 이름, 가린 표본·위치·고치기 링크). 동의 당사자(작성자·회의 참석자·선언자·파일 올린 사람, 나간 멤버 포함 + 만든 사람, 자기 동의는 명시할 때만), 해시 다르면 409 `stale_manifest`, 미동의자 제외 후보(자기 관련 부분이 같은 사람만 동의 이어받음), 도메인 전이로 ready 판정·재계산(보류는 T-15까지 없음). 화면 `/projects/[id]/publish`(공개 준비, 게시 버튼은 비활성)·`/consents`(동의 요청), 공통 `PublicSnapshotView`([ADR 0011](../docs/adr/0011-publication-snapshot-and-consent.md)) |
| T-12 게시·철회·파생 차단 | 다음 | [실행 계획 §4](../docs/planning/DELIVERY_PLAN.md) |

화면: `/login`, `/onboarding`(프로필 설정 겸용, 디스코드 연결), `/consents`(동의 요청·미리보기·결정), `/projects`(새 과제의 과목 고르기·"지난 과제 되짚기" 선택, "이번 주 체크인" 카드 포함), `/projects/[id]`(엠바고 배지, 개요·과목 정보·주간 체크인·할 일·산출물·마일스톤·빌드 로그·기여·디스코드 연결·멤버), `/projects/[id]/report?from=&to=`(인쇄용 동료평가 리포트), `/projects/[id]/publish`(공개 준비: 수준·고르기·사람 표시·사용 조건·점검·동의 현황·막는 것·미리보기, 게시는 T-12), `/invite/[token]`, `/u/[handle]`.

빌드 로그 API: `POST/GET /api/v1/projects/:id/logs`(목록은 `tag=`·`author=`·`milestone=` 필터), `GET /api/v1/logs/:id`, `GET/POST /api/v1/logs/:id/revisions`(본문에 `evidenceVersionIds[]`, `milestoneId`). 읽을 수 없는 프로젝트·로그는 404, reviewer/viewer의 작성·수정은 403입니다.

산출물 API: `POST /api/v1/projects/:id/artifacts/upload-intents`, `PUT /api/v1/uploads/:intentId`, `POST /api/v1/uploads/:intentId/complete`, `GET /api/v1/projects/:id/artifacts`, `GET /api/v1/artifacts/:id`, `GET /api/v1/artifacts/:id/versions/:versionId/content`, `POST /api/v1/artifacts/:id/versions/:versionId/rescan`. 상태 코드는 [ADR 0007](../docs/adr/0007-file-storage-and-scanning.md)에 정리했습니다.

마일스톤 API: `GET/POST /api/v1/projects/:id/milestones`, `PUT /api/v1/projects/:id/milestones/order`(`milestoneIds[]` 전체 순열, 아니면 422 `mismatch`/`duplicate`), `POST /api/v1/projects/:id/milestones/apply-template`(마일스톤이 있으면 409 `not_empty`), `PATCH /api/v1/milestones/:id`(`expectedVersion`, 낡으면 409 `version_conflict`), `DELETE /api/v1/milestones/:id`(204, 로그가 가리키면 409 `in_use`), `POST /api/v1/milestones/:id/snapshots`(201, clean 아님 422 `not_clean`, 다른 프로젝트·없음 422 `not_found`, 중복 409 `duplicate`), `DELETE /api/v1/milestones/:id/snapshots/:artifactVersionId`(204). 한도 초과는 409 `limit_reached`. 읽을 수 없으면 404, reviewer/viewer의 쓰기는 403입니다.

할 일 API: `GET /api/v1/projects/:id/tasks?status=`, `POST /api/v1/projects/:id/tasks`(201), `PUT /api/v1/projects/:id/tasks/order`(`{status, taskIds[]}` 그 상태 전체 순열, 아니면 422 `mismatch`/`duplicate`), `PATCH /api/v1/tasks/:id`(`expectedVersion`, 낡으면 409 `version_conflict`, 담당자가 active 멤버가 아니면 422 `not_member`), `POST /api/v1/tasks/:id/complete`(200 `{task, prompt}`, 이미 완료면 그대로 200), `POST /api/v1/tasks/:id/convert`(201 `{task, log}`, 태그 `stuck`/`decision`/`progress`, payload는 빌드 로그 규칙으로 422, 완료 전 409 `not_done`, 두 번째 409 `already_converted`), `DELETE /api/v1/tasks/:id`(204, 전환한 할 일은 409 `converted`). 한도 초과는 409 `limit_reached`. 읽을 수 없으면 404, reviewer/viewer의 쓰기는 403입니다. 사후 작성 모드는 `POST /api/v1/projects`의 `retroMode`, `PATCH /api/v1/projects/:id`의 `retroMode`(지금과 다른 값이면 owner만, 아니면 403)로 정합니다.

기여 API: `GET/POST /api/v1/projects/:id/claims`(본문 `{text, evidence?[{kind:'log'|'artifact', id}]}`, 201, 멤버당 10개 초과 409 `limit_reached`, 근거 422 `{evidence: 'not_found'|'not_attachable'}`), `GET/POST /api/v1/claims/:id/revisions`(`{expectedRevision, text?, evidence?}`, 201, 작성자만·아니면 403, 낡으면 409 `stale_revision`, 바뀐 것 없음 422 `no_changes`; 생략한 근거는 이어받음), `PUT /api/v1/claim-revisions/:id/endorsement`(`{status: 'confirmed'|'disputed', note?}`, 200, 자기 선언 403 `self_endorsement`, 현재 revision이 아니면 409 `not_current` + `currentRevisionId`, 이의에 메모 없으면 422), `DELETE /api/v1/claim-revisions/:id/endorsement`(204), `GET /api/v1/projects/:id/contribution?from=&to=`(서울 날짜·양 끝 포함, 기본 이번 주, 기간 오류 422 `{to: 'before_from'|'too_long'}`). 읽을 수 없으면 404, viewer의 쓰기는 403입니다. 주간 요약 문장은 `server/modules/contribution/weekly-summary.ts`의 `formatWeeklySummary`(봇이 화요일에 게시, T-09).

디스코드 API(웹, 로그인): `GET /api/v1/me/integrations`, `POST /api/v1/me/integrations/discord/link-code`(201 `{code, expiresAt}`, 10분·한 번만, 원문은 이 응답에서만), `DELETE /api/v1/me/integrations/discord`(204), `POST /api/v1/projects/:id/discord/bind-code`(owner만, 아니면 403·비멤버 404, 201), `GET /api/v1/projects/:id/discord/bindings`(멤버), `PATCH /api/v1/discord-bindings/:id`(`{summaryEnabled}`, owner만), `DELETE /api/v1/discord-bindings/:id`(204, owner만, 승인 대기 📌 요청 만료).

내부 API(봇 전용, `POST`, HMAC 서명 필수): `/api/internal/discord/link`·`bind`·`logs`·`pins`·`pin-decisions`·`notices/claim`·`notices/ack`. 업무 결과는 200 `{status}`(`created`/`duplicate`/`not_bound`/`not_linked`/`not_writer`/`invalid`/`web_only`/`approval_requested` 등, 이유를 자세히 밝히지 않음), 서명·시각·nonce 실패는 401 `invalid_signature`, 형식 오류 422, 비밀 미설정 503 `internal_api_disabled`. 세션 쿠키만으로는 부를 수 없습니다([ADR 0009](../docs/adr/0009-discord-bot-and-checkins.md)).

체크인 API: `GET /api/v1/projects/:id/checkins/me?week=YYYY-Www`(본인, 없으면 `checkin: null`), `PUT /api/v1/projects/:id/checkins/me`(`{week?, timeBucket, difficulty, note?, shareForStats?, skipReasons?, promote?: {tag: 'progress'|'stuck'}}`, 처음 201·다시 200, 이번 주·지난주 밖이면 422 `{week: 'out_of_range'}`, promote에 한 줄이 없으면 422 `{note: 'required'}`, 쓰기 권한 없이 promote면 403), `GET /api/v1/projects/:id/checkins?week=`(멤버, 이름순 팀 현황, 통계 동의·이유는 싣지 않음), `GET /api/v1/me/checkins`(대시보드). 읽을 수 없는 프로젝트는 404.

학교·과목 API(로그인): `GET /api/v1/schools?q=`, `POST /api/v1/schools`(`{name, confirmNew?}`, 201), `GET /api/v1/schools/:id/courses?q=`, `POST /api/v1/schools/:id/courses`(`{title, code?, confirmNew?}`, 201, 없는 학교 404), `GET /api/v1/courses/:id/terms`, `POST /api/v1/courses/:id/terms`(`{year, semester}`, 새로 만들면 201·있으면 200 `created: false`, `endsAt`을 보내면 422 `{endsAt: 'not_allowed'}`, 범위 밖 연도 422 `{year: 'out_of_range'}`), `GET /api/v1/concept-tags?q=`, `GET/POST /api/v1/courses/:id/concept-tags`(`{tagId}` 또는 `{label}`, 새로 붙이면 201·이미 있으면 200, 12개 초과 409 `limit_reached`). 만들기에서 같은 이름은 409 `already_exists`, 비슷한 이름·같은 과목 코드는 409 `similar_exists`(둘 다 `candidates[]`), 생성 한도 초과 429 `rate_limited`. 병합된 학교·과목 id로 불러도 정본으로 처리합니다.

엠바고 API: `GET /api/v1/projects/:id`·`PATCH`의 `embargo: {until, active, source}`(`source`: `course_term_end`·`course_term_embargo`·`project_embargo`)와 `courseContext`, `PATCH /api/v1/projects/:id`의 `courseTermId`(owner/editor, null이면 연결 해제, 없는 학기 422 `{courseTermId: 'not_found'}`, 엠바고는 줄지 않음), `POST /api/v1/projects/:id/embargoes`(`{until, reason}`, owner만·아니면 403, 201). 게시 API(T-11/T-12)는 `server/modules/embargo/embargo.ts`의 `assertPublishable`을 게시 트랜잭션 안에서 불러야 합니다(엠바고 중 409 `embargo_active` + `until`).

공개 후보·동의 API(T-11): `GET /api/v1/projects/:id/publication`(멤버: 공개 상태·열린(없으면 마지막) 후보·선택지·엠바고), `POST /api/v1/projects/:id/publication-candidates`(`{level, title, summary, slug, logIds?, milestoneIds?, claimIds?, artifactVersionIds?, exposure?, usageTerms?, consentSelf?}`, 201, owner/editor, reviewer/viewer 403, 엠바고 409 `embargo_active` + until, 게시됨·제한됨 409 `publication_locked`, 선택 오류 422 `not_found`/`not_clean`/`not_allowed`/`not_member`, slug 422 `reserved`/`taken`), `GET /api/v1/candidates/:id`(멤버·당사자, ready 재계산, `blockers`·`checks`·`subjects`), `GET /api/v1/candidates/:id/preview`(저장된 스냅샷 그대로), `POST /api/v1/candidates/:id/consents`(`{decision: 'granted'|'declined', manifestHash, note?}`, 당사자만·아니면 403 `not_subject`, 대체됨 409 `superseded`, 해시 다름 409 `stale_manifest` + currentManifestHash), `POST /api/v1/candidates/:id/exclude-declined`(owner만, 201, 거절 없음 409 `no_declined`), `GET /api/v1/me/consent-requests`. 멤버도 당사자도 아니면 404. 게시·철회·공개 조회는 T-12이며 저장된 스냅샷(`publication_candidates.snapshot`)만 읽어야 합니다([ADR 0011](../docs/adr/0011-publication-snapshot-and-consent.md)).

운영자 API(운영자가 아니면 403 `operator_only`): `POST /api/v1/operator/schools/:id/merge`·`/operator/courses/:id/merge`·`/operator/concept-tags/:id/merge`(`{into}`, 200 + 정본, 자기 자신 422 `{into: 'self'}`, 없는 대상 422 `{into: 'not_found'}`, 이미 병합 409 `already_merged`, 대상이 병합됨 409 `target_merged`, 다른 학교 과목 409 `different_school`), `PATCH /api/v1/course-terms/:id`(`{endsAt, reason}`, 늘리면 연결된 프로젝트 엠바고도 올림), `POST /api/v1/operator/course-terms/:id/embargoes`(`{until, reason}`, 201), `PATCH /api/v1/operator/projects/:id/embargo`(`{until|null, reason}`, 낮추기만·높이면 422 `{until: 'not_lower'}`, 응답은 적용 엠바고뿐). 모두 감사 이벤트를 남깁니다. 운영자도 비공개 과제 내용 API는 404입니다.

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
pnpm worker                                   # 다른 터미널에서: 파일 검사 worker(개발 모드)
pnpm bot                                      # 선택: 디스코드 봇(토큰 필요, apps/bot/README.md)
pnpm test
```

- 로그인: `/login`에 이메일을 넣으면 `pnpm dev` 콘솔에 `[dev-console mail]` 블록으로 로그인 링크가 출력됩니다(개발 전용, 실제 메일 발송 없음).
- 5432 포트가 이미 쓰이고 있으면 `.env`의 `POSTGRES_PORT`와 `DATABASE_URL` 포트를 함께 바꾸고 `docker compose --env-file .env -f ops/docker-compose.yml up -d`로 띄우세요(compose는 기본적으로 `ops/.env`를 읽습니다).
- `pnpm test`는 `DATABASE_URL`이 없으면 DB 통합 테스트(`packages/db`, `apps/web/test/*.integration.test.ts`, `apps/worker/test/*.integration.test.ts`)를 건너뜁니다. 통합 테스트는 트랜잭션 rollback으로 데이터를 남기지 않습니다. 실행하려면 `DATABASE_URL=postgres://peerchive:peerchive@localhost:5432/peerchive pnpm test`.
- 파일을 올리면 worker가 검사해야 "사용 가능"이 됩니다. `pnpm worker`는 `NODE_ENV=development`로 실행하며 기본 검사기는 개발용 `signature-only`(형식 판별만)입니다. 실제 악성코드 검사를 해 보려면 `docker compose -f ops/docker-compose.yml --profile clamav up -d`(처음엔 서명 DB를 받느라 몇 분 걸림) 뒤 `.env`에 `PEERCHIVE_MALWARE_SCANNER=clamav`.
- 올린 파일은 저장소 루트의 `.data/objects/`(gitignore 대상)에 무작위 키로 저장됩니다. 웹 서버는 이 디렉터리를 정적으로 제공하지 않습니다.
- 끝나면 `docker compose -f ops/docker-compose.yml down`(데이터 볼륨 `peerchive-pg-data`는 유지, 지우려면 `down -v`).

## 환경 변수

| 변수 | 기본값 | 내용 |
|---|---|---|
| `DATABASE_URL` (`NUXT_DATABASE_URL`) | 없음 | PostgreSQL 접속 문자열(서버 전용) |
| `NUXT_SITE_ORIGIN` | `http://localhost:3000` | 허용 사이트 origin(쉼표 구분). 첫 항목으로 로그인·초대 링크를 만들고, 상태 변경 API(POST/PATCH/PUT/DELETE)의 `Origin`/`Referer`가 이 목록과 다르면 403. 배포 시 실제 origin으로 꼭 설정 |
| `NUXT_MAIL_TRANSPORT` | `dev-console` | 현재 `dev-console`(개발 전용)만 있음. production에서는 이 값으로 서버가 시작되지 않음 |
| `PEERCHIVE_STORAGE_DRIVER` | `filesystem` | 파일 저장소(web·worker 공통). 지금은 filesystem만 있음. production에서는 `PEERCHIVE_ALLOW_FS_STORAGE_IN_PRODUCTION=1` 없이는 web·worker가 시작되지 않음 |
| `PEERCHIVE_STORAGE_ROOT` | `.data/objects` | filesystem 저장소 루트. 상대 경로면 저장소 루트 기준 |
| `PEERCHIVE_MALWARE_SCANNER` | `signature-only` | worker 검사기. `clamav` 또는 `signature-only`(개발 전용, production에서 worker가 시작되지 않음) |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `127.0.0.1` / `3310` | clamd 주소 |
| `PEERCHIVE_SCAN_CONCURRENCY` | `2` | worker의 동시 검사 수(1–8) |
| `PEERCHIVE_INTERNAL_SECRET` | 없음 | 웹 ↔ 봇 내부 API HMAC 공유 비밀(web·bot 공통). 비우면 웹의 `/api/internal`이 꺼짐(503). production에서 약한 값(32자 미만·자리표시 값)이면 web·bot이 시작되지 않음 |
| `PEERCHIVE_API_BASE_URL` / `PEERCHIVE_SITE_URL` | `http://localhost:3000` | 봇이 부를 웹 서버 주소 / 안내 링크 주소(production에서 API 주소 필수) |
| `DISCORD_BOT_TOKEN` / `DISCORD_APPLICATION_ID` / `DISCORD_GUILD_ID` | 없음 | 봇 토큰·애플리케이션 id·(개발용) 명령 등록 서버. [apps/bot/README.md](bot/README.md) |

- 빌드한 서버(`node apps/web/.output/server/index.mjs`)는 기본적으로 production으로 동작합니다(Secure 쿠키, dev-console 거부). 로컬에서 빌드 결과를 점검할 때만 `NODE_ENV=development`를 명시하세요.

## 그 밖의 명령

| 명령 | 내용 |
|---|---|
| `pnpm typecheck` | 모든 워크스페이스 타입 검사(web은 `nuxt typecheck`) |
| `pnpm build` | web 프로덕션 빌드(`apps/web/.output`) |
| `pnpm worker` | worker 개발 실행(`NODE_ENV=development`, 루트 `.env` 읽음). 배포용은 `pnpm --filter worker start`(production 기본, 실제 검사기 필요). SIGINT/SIGTERM이면 진행 중인 작업을 기다린 뒤(최대 30초) 종료 |
| `pnpm bot` | 디스코드 봇 개발 실행(`NODE_ENV=development`, 루트 `.env` 읽음). 처음엔 `pnpm --filter bot register-commands`로 슬래시 명령 등록. 배포용은 `pnpm --filter bot start` |
| `pnpm db:generate` | `packages/db/src/schema.ts` 변경을 SQL migration으로 생성 |
| `pnpm --filter @peerchive/db grant-operator <email> [--revoke]` | 운영자 부여·회수(로그인한 적 있는 활성 사용자, 감사 이벤트 기록). 운영자 권한은 이 CLI로만 바꿉니다. `DATABASE_URL`(없으면 루트 `.env`) 사용 |
| `pnpm check:archive` | 원본 아카이브 보존 검증(`python3 scripts/check_archive.py`) |

스키마는 migration으로만 바꿉니다. `schema.ts`를 고쳤다면 `pnpm db:generate`로 생성한 SQL을 함께 커밋하세요(CI가 불일치를 검사합니다).

0008 migration은 `CREATE EXTENSION IF NOT EXISTS pg_trgm`으로 시작합니다. 관리형 PostgreSQL에서는 pg_trgm이 허용되어 있어야 하고 migration 계정에 확장을 만들 권한이 있어야 합니다(없으면 관리자가 미리 만들어 두세요).
