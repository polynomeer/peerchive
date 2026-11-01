# 0043. 현직자 답변 이동·수료 회고: 토픽의 내 답변(댓글)도 `ArchiveTransfer`로 선배 노트 초안에(질문은 복사하지 않아 질문자 동의 없음) + 이름 표시 재선택 네 가지(실명·표시명·익명·**소속 표시 유지** — 원 글에 고정된 문자열을 그대로 복사, 페르소나 없음·투영 없음) + 수료 회고 = 별도 표 `completion_retros`(선배 노트 형식, 별점·연봉·추천 점수 열·입력 없음, 익명 회고에 A-05 두 단계 임계값을 쓰는 순간 고정, 기관 인증 계정만 읽음, 신고·`hide_retro`, 플래그 `institutions`)

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

A-06은 DELIVERY_PLAN §4.3 P2 백로그의 "현직자 답변 이동·수료 회고"입니다: "토픽 답변 → 선배 노트에 `ArchiveTransfer` 재사용과 이름 표시 재선택, 수료 회고에 별점·연봉·추천 점수 필드 없음". 같은 절은 "기록으로 이어지는 A-06은 미루지 않습니다"라고 둡니다. 관련 설계와 앞선 결정:

- PROOFU_EVOLUTION_PLAN §8.9.10: 직무 토픽에서 졸업생 현직자가 후배의 커리어 질문에 답하고, 좋은 답은 **작성자 동의로** 선배 노트(§8.3)로 옮길 수 있음. "가져오지 않는 것": 회사·교육기관 별점 리뷰와 연봉 정보는 평판 분쟁 위험이 있어 만들지 않고, 부트캠프·교육 프로그램 경험은 별점 대신 선배 노트 형식의 **구조화된 수료 회고**로 남김. §8.9.11: 기관 = 대학·부트캠프·교육 프로그램·연합 동아리.
- SYSTEM_DESIGN §6.7.2 "토픽과 소속 표시 익명": **현직자 답변의 이동** — 토픽 답변을 선배 노트로 옮길 때는 `ArchiveTransfer`(§6.7)를 쓰고 이름 표시 방식을 다시 고름. **1단계로 남기면 선배 노트에도 소속 표시만 붙고 페르소나와 연결되지 않음**. **수료 회고** — `SeniorNote`에 `institution_id`·`cohort_id`를 붙인 구조화된 회고, 별점·연봉·추천 점수 필드 없음. §8.3 불변조건 1: 0~1단계 글은 투영 경로 자체가 없음.
- ADR 0013(선배 노트: 과목 허브, 공개 읽기는 published만, 작성 자격 = 그 과목 학교 인증), 0025(C-09 옮기기: 커뮤니티 → 아카이브 한 방향 복사, 아카이브 테이블은 커뮤니티를 가리키지 않음, 동의 = 복사되는 글의 당사자, 원 글과 복사본의 연결은 공개 DTO에 없음, 선배 노트는 내 글 → 초안), 0029(S-02 경계·속성 테스트), 0030(표시명 = 표시명 페르소나), 0035(S-05: 선배 노트는 name·display만 같은 종류 페르소나로 투영, DB 함수 `persona_activity_source_ok`), 0037(기관 = `schools.kind`, 신분 글자, 플래그), 0042(A-05 토픽·`affiliated_anonymous`·작성 시점 고정 소속 표시·두 단계 임계값).

## 결정

### 1. 토픽 답변 → 선배 노트 (ArchiveTransfer 재사용)

- **원본**: 토픽의 **내 댓글(답변)**. `POST /community/posts/:id/archive-transfers {target: 'senior_note', commentId, courseId, answerKey, displayMode, displayName?, noAnswersConfirmed: true}`. 기존 C-09 선배 노트 경로("내 글 → 초안")에 `commentId`만 더했습니다. 토픽의 내 **글**은 기존 경로 그대로 옮기고, 같은 이름 표시 선택지(아래)를 받습니다.
  - 제한: 선배 노트 대상만(422 `commentId: not_applicable`), 토픽 공간만(422 `commentId: not_allowed` — 다른 공간의 댓글 이동은 이번 범위가 아님), 그 글의 댓글(422 `commentId: invalid`), 글·댓글 모두 게시 중(409 `source_not_open`), 내 댓글(403 `not_author`). 토픽 접근 규칙(활성 기관 인증, 플래그 `topics`)은 `loadReadableSpace`가 그대로 적용합니다(플래그 꺼짐 404).
  - `archive_transfers`: `source_comment_id = 그 댓글`, 바로 `done`(요청 = 작성자 동의, 스냅샷 없음). `archive_transfers_target_check`에서 senior_note의 `source_comment_id is null` 조건을 뺐습니다.
- **질문 글은 복사하지 않습니다**: 답변 본문만 고른 선배 노트 질문(`answerKey`)의 답이 됩니다(선배 노트는 고정된 질문 4개에 대한 답이라 질문 글을 담을 자리가 없음). 그래서 C-09 규칙("동의는 복사되는 글의 당사자")에 따라 **질문한 사람의 동의는 필요 없습니다**. 답변이 질문을 인용했다면 그것은 작성자 자신의 글입니다.
- **과목 연결**: 선배 노트는 과목 허브에 붙으므로 작성자가 과목을 고릅니다(토픽은 학교가 없어 학교 제한 없음, 과목 검색은 학교부터). 작성 자격은 기존 노트와 같습니다: 그 과목 학교의 active 인증(403 `hub_write_not_allowed`), 시간당 5개, 사용자·과목당 3개, 정답·답안·교수 개인 평가 없음 확인, 게시 때 답 2개 이상. **과목과 이어지지 않는 커리어 답변(예: 면접 준비)은 이 대상이 맞지 않습니다** — 노트 질문이 과목 경험을 묻기 때문이며, 그런 답변은 토픽에 남기거나 부트캠프 경험이면 수료 회고(§2)로 씁니다. 과목 없는 "커리어 노트"는 새 표가 필요해 만들지 않았습니다.

### 2. 이름 표시 재선택 네 가지

| 고른 방식 | 노트 행 | 공개 표시 | 페르소나 투영 |
|---|---|---|---|
| 계정 이름(`name`) | `display_name_snapshot` = 게시 때 계정 이름 | 그 이름 | 실명 페르소나(S-05 규칙 그대로, 복사본 노트만) |
| 표시명(`display`) | 입력한 표시명 | 그 표시명 | 표시명 페르소나(같음) |
| 익명(`anonymous`) | 없음 | "익명 선배" | 없음 |
| **소속 표시 유지(`affiliation`)** | `affiliation_label` = 원 글의 고정 문자열 복사, 이름 없음 | `○○대학교 · 졸업생`·`대학 졸업생` 등 그 문자열 | **없음** |

- `senior_note_display_mode`에 `affiliation`을 더하고 `senior_notes.affiliation_label`(1–100자)을 두었습니다. check: affiliation 방식이면 문자열이 있고 이름 사본이 없음.
- **복사하고 다시 계산하지 않습니다**: 원 글(댓글)에 작성 시점 고정된 `affiliation_label`을 그대로 옮깁니다. 이유: (1) 설계가 "1단계로 남기면"이라고 했듯 원 글의 표시를 유지하는 선택이고, (2) 다시 계산하면 그사이 인원이 늘어 표시가 좁아지거나(기관 유형 → 기관 이름) 소속이 바뀌어 원 글과 다른 소속이 붙을 수 있으며, 좁아지는 것은 A-05의 "고른 것보다 좁게 표시하지 않음·이미 쓴 표시는 그대로"를 어깁니다. DB 트리거 `senior_notes_affiliation_label_guard`가 다른 값으로 바꾸기를 막고 비우기(탈퇴 정리)만 허용합니다(테스트: 옮기기 직전 회원이 줄고, 옮긴 뒤 소속을 철회해도 문자열 그대로).
- 원 글이 "표시 안 함"(문자열 없음)이면 유지할 표시가 없어 422 `displayMode: label_unavailable`(익명을 고르면 같은 결과). 소속 표시 익명이 아닌 원본(공식 페이지 글 등)에는 이 방식이 없습니다(422 `displayMode: invalid`). 직접 만들기(`POST /courses/:id/senior-notes`)도 받지 않고(422), 고치기는 복사한 문자열이 있는 노트만 이 방식으로 바꿀 수 있습니다(422 `label_unavailable`).
- **문자열은 소속 표시를 고를 때만 복사합니다**. 이름을 고른 복사본에는 소속 표시가 없어, 나중에 이름 노트를 소속 표시로 바꿔 "이 이름 = 이 소속 표시 글"을 잇는 길이 없습니다.
- **투영**: 게시 때 투영 요청(outbox)은 `name`·`display`만 만듭니다(`isPersonaSeniorNoteMode`). worker 처리기·도메인 규칙(`decidePersonaActivityProjection`)도 둘만 받고, DB 함수 `persona_activity_source_ok`(0031)가 이미 name·display만 허용하므로 원시 SQL로도 소속 표시·익명 노트는 23514입니다(테스트). 실명·표시명 복사본은 **노트 자체**(`source_type = senior_note`, 노트 id)로만 그 페르소나 활동이 되고 원 글·댓글·옮기기 id는 어디에도 실리지 않습니다.
- **연결을 드러내지 않음**: 공개 노트 DTO(`PublicSeniorNoteDto`)는 표시 이름·답만이고 `affiliated` 참거짓을 더했습니다. 댓글에서 옮긴 노트는 원 글의 "아카이브로 옮겨짐" 표시에도 넣지 않습니다(어느 답변이 옮겨졌는지 드러나지 않게, 글에서 옮긴 노트는 C-09 그대로). 이름을 고르면 원 글을 읽은 사람이 같은 글임을 알아볼 수 있다는 점은 화면에서 안내합니다(C-09와 같은 한계).
- 분석 `senior_note_published.displayMode`에 `affiliation`을 더했습니다(옮기기 분석은 기존대로 사용자 키 없이 종류만).

### 3. 수료 회고 = 별도 표 `completion_retros`

- 설계는 "`SeniorNote`에 `institution_id`·`cohort_id`를 붙인 회고"이지만 **같은 형식의 별도 표**로 만들었습니다. 이유: `senior_notes.course_id`는 NOT NULL이고 과목 허브·검색 색인·유용성 신호·S-05 투영 카드(`/c/:courseId`)·과목 병합이 모두 이 열을 전제로 합니다. 과목 없는 행을 섞으면 그 경로마다 예외가 생기고, 회고가 공개 과목 허브·검색으로 새어 나갈 위험이 커집니다(§4의 공개 범위 결정과 충돌). 별도 표는 커뮤니티 구역 밖(새 구역 "수료 회고")에 두고 커뮤니티 테이블을 가리키지 않습니다.
- 열: `institution_id`(정본 기관, 대학이 아닌 기관 — 이 기관들은 병합하지 않음, ADR 0037)·`cohort_id`(작성자 소속의 기수)·`author_id`(응답에 없음)·`display_mode`(새 enum name/display/anonymous)·`display_name_snapshot`·`label_scope_requested`·`label_scope_applied`·`institution_label`·`cohort_label`·`answers`(jsonb)·`guidelines_confirmed`·`status`(published/withdrawn/hidden)·시각. **숫자형 열이 없습니다.**
- **평가 필드 없음(완료 기준)**: 질문 4개 `learned`(실제로 배운 것)·`curriculum`(커리큘럼·진행 방식을 지나며 겪은 것)·`beforeStart`(시작 전에 알았으면 좋았을 것)·`advice`(다음 수강생에게), 각 1000자·2개 이상. 표·질문 키·입력 어디에도 별점·연봉·추천 점수가 없습니다. 입력에 모르는 키(`rating`·`salary`·`recommendScore` …)가 오면 422 `<key>: unknown`, 답에 모르는 질문 키도 `answers.<key>: unknown`. 스키마 테스트가 `information_schema.columns`의 열 이름을 낱말로 나눠(`isEvaluationFieldName`: rating·star·score·salary·wage·pay·income·compensation·recommend·nps·grade) 0건이고 숫자형 열이 없음을 확인합니다. 작성 확인 문구: "강사·운영진 개인에 대한 평가, 별점·연봉·추천 점수, 다른 수강생의 개인정보를 넣지 않았습니다"(필수).
- **쓰기 자격**: 대학이 아닌 기관의 **수료생**(standing alumni, active + verified 소속, active 계정)만, 그 소속으로(`affiliationId`). 대학 졸업생·부트캠프 수강생은 쓰지 않습니다(대학 경험은 과목별 선배 노트). 쓰는 순간 게시(초안 없음), 공개 전 점검 규칙(전화·메일·주민번호 등) 경고는 `confirmWarnings`로 확인(409 `checks_unconfirmed`). 사람·기관마다 공개(·숨김) 회고 하나(부분 unique index + advisory lock, 409 `retro_exists`), 철회하면 다시 씁니다. 고치기는 두지 않았습니다(철회 후 다시 쓰기 — 고정된 표시·신고 대상 버전을 단순하게).
- **이름 표시와 임계값(A-05 규칙 재사용)**:
  - 이름을 건 회고(`name` = 계정 이름, `display` = 표시명 페르소나 이름, 없으면 403 `display_persona_required`): 기관 이름 범위로 고정(`○○부트캠프 · 수료생`). 이름으로 이미 드러나 숨길 익명이 없기 때문입니다. 기수는 작성자가 고른 경우만(`showCohort`).
  - 익명 회고("익명 수료생"): 작성자가 고른 범위(기관 이름/기관 유형/표시 안 함, 기본 기관 이름)에 **쓰는 순간의** (정본 기관, 수료생)·(기관 종류, 수료생) 인증 회원 수로 `decideAffiliationLabel`(두 단계, 기본 50, `PEERCHIVE_AFFILIATION_LABEL_THRESHOLD`)을 적용해 행에 고정합니다. 회고는 기관에 대한 글이므로 **기관 이름 범위가 아니면 그 기관 목록·필터에 나오지 않고**(기관 이름 자체가 작은 집단을 가리키므로) 전체 목록에서 고정된 문자열(`부트캠프 수료생` 또는 없음)만 보입니다. 기수는 보이지 않습니다(422 `showCohort: anonymous_not_allowed`, 학과·기수·입학연도 미표시 원칙).
  - 넓혀졌는지는 작성자 본인 응답(`labelBroadened`)·쓰기 화면 미리보기에만, 회원 수는 어디에도 없습니다. 고정은 트리거 `completion_retros_frozen_guard`(기관·작성자·범위·문자열·시각은 바꿀 수 없고, 이름·기수는 익명·빈 값으로 비우기만 — 탈퇴 정리).
  - 임계값 셈(`verifiedMemberCount`·`verifiedCategoryCount`·`affiliationLabelThreshold`)은 커뮤니티 테이블을 읽지 않으므로 `server/modules/institutions/member-counts.ts`로 옮기고 토픽 모듈이 다시 내보냅니다(C-05 경계: institutions 모듈은 커뮤니티 모듈을 import하지 않음).
- **페르소나 투영 없음**: 회고는 어떤 방식이든 페르소나 활동이 되지 않습니다(`persona_activity_source`에 종류가 없고 만들지 않았음). 프로필에 회고를 잇는 것은 공개 범위(§4)와 함께 운영 근거가 생기면 새 ADR로 정합니다.

### 4. 수료 회고 공개 범위

- **읽기**: 로그인한 active 계정 중 **active 기관 인증이 하나라도 있는 사람(대학 포함) 또는 운영자** — 토픽 독자와 같은 범위(`GET /completion-retros` → 아니면 `{eligible: false, items: []}`). 공개 아카이브·공개 검색·검색엔진(noindex, `useCommunityPage`)에는 내보내지 않습니다.
- 이유: 기관을 직접 다루는 글은 공개되면 별점 리뷰와 같은 평판 분쟁(§8.9.10 "가져오지 않는 것")에 가까워지고, 기관 쪽의 반론·운영진 경로(I-02)가 아직 없습니다. 인증된 학생·수료생에게만 보이면 다음 수강생이 될 사람(대학생 포함)이 읽을 수 있으면서 책임 있는 독자로 좁혀집니다. 공개로 넓히는 것은 GA 이후 운영 근거와 I-02 기관 운영진 경로가 생기면 새 ADR로 정합니다.
- 목록: 게시 중만, 최근 순 20개(`before` 커서), 필터 `institution`(그 기관 범위로 고정된 회고만)·`kind`(기관 이름·유형 범위), `institutions`(기관 이름 범위의 회고가 있는 기관, 개수 없음). DTO에 작성자 id·소속 id·고른 범위·회원 수가 없습니다.

### 5. 운영·탈퇴·감사·플래그

- **신고·조치**: 신고 대상 `completion_retro {retroId}`(읽을 수 있는 사람이 게시 중인 회고를 — 아니면 404), 조치 `hide_retro`(published → hidden, 되돌리면 hidden → published, 그사이 철회했으면 그대로). 당사자는 작성자(안내 경로 `/community/retros`, 이의제기 가능), 운영자 신고 상세는 회고 하나(작성자 id 없음), 대상 이름표 "수료 회고 · 고정된 기관 표시". `reports`·`moderation_actions.completion_retro_id` + check.
- **탈퇴 정리**: 작성자의 회고를 지우고, 신고·조치가 가리키면 글·이름·기수를 비운 익명 철회 행으로 남깁니다(장부 종류 `completion_retros`). 선배 노트 묘비는 소속 표시도 비우고 방식을 익명으로 둡니다.
- **감사**: `completion_retro.create`·`.withdraw`는 회고 id + 방식·넓혀졌는지·경고 수·숨김 여부 같은 플래그만. **익명 회고는 행위자 없이** 남깁니다(작성자 id와 익명 글 id를 한 행에 남기지 않는 C-04 원칙). 토픽 답변 옮기기는 C-09처럼 커뮤니티 쪽 감사가 없고 노트 쪽 `senior_note.create{transferred: true}`만.
- **플래그**: 수료 회고는 `institutions`(기관 확장 영역 — 기수·수료생 인증과 함께), 토픽 답변 이동은 원본이 토픽이라 `topics`(꺼지면 토픽 공간이 404이므로 옮기기·선택지도 404). 운영 도구(신고 상세·조치·되돌리기)·탈퇴 정리는 플래그와 무관합니다.

### 6. 화면

- 토픽 글 화면: 내 소속 표시 익명 댓글에 "선배 노트로 옮기기"(기존 `ArchiveTransferForm`에 `commentId` — 선택지 `GET /community/posts/:id/archive-options?commentId=`가 `source.affiliationLabel`을 줌). 표시 방식에 "소속 표시 유지: ○○대학교 · 졸업생"과 프로필 연결 안내. 선배 노트 화면은 복사한 소속 표시가 있는 노트에만 그 방식을 보입니다.
- `/community/retros`(로그인·noindex·제목 고정): 목록·기관 필터·신고, 쓰기(내 수료생 소속, 이름 표시, 익명이면 기관 표시 범위와 미리보기·넓힘 안내, 이름이면 기수 보이기, 질문 4개, 확인), 내 회고(상태·운영 안내·철회). 커뮤니티 첫 화면 링크는 플래그가 켜졌을 때만.

### 7. migration `0040_topic_answer_transfer_retros`

- enum 값 셋(`senior_note_display_mode += affiliation`, `report_target_type += completion_retro`, `moderation_action_kind += hide_retro`)은 `ADD VALUE`이고, drizzle migrate가 빈 DB에서 모든 migration을 한 트랜잭션으로 돌리므로 이 값을 쓰는 check(`senior_notes_affiliation_label_check`·`reports_target_check`·`moderation_actions_completion_retro_check`)는 모두 `::text` 비교입니다. 새로 만든 enum(`completion_retro_display_mode`·`completion_retro_status`)은 같은 트랜잭션에서 리터럴로 써도 됩니다. 손으로 둔 트리거 함수 둘(`senior_notes_affiliation_label_guard`·`completion_retros_frozen_guard`). 빈 DB(`peerchive_verify`)에서 처음부터 migrate되는 것을 확인했습니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /community/posts/:id/archive-transfers {target: senior_note, commentId, …}` | 201(done) | 404(토픽 플래그 꺼짐·읽을 수 없음), 403 `not_author`·`hub_write_not_allowed`, 409 `source_not_open`·`limit_reached`, 422 `commentId: not_applicable\|not_allowed\|invalid`·`displayMode: invalid\|label_unavailable`, 429 |
| `GET /community/posts/:id/archive-options?commentId=` | 200(`source`) | 403 `not_author`, 404 |
| `PATCH /senior-notes/:id {displayMode: affiliation}` | 200 | 422 `displayMode: label_unavailable` |
| `POST /courses/:id/senior-notes {displayMode: affiliation}` | – | 422 `displayMode: invalid` |
| 수료 회고 모든 경로 | – | 플래그 `institutions` 꺼짐 404, 401 |
| `GET /completion-retros?institution=&kind=&before=` | 200(`eligible`) | 422 |
| `GET /me/completion-retros/composer` | 200 | – |
| `POST /me/completion-retros` | 201 | 403 `display_persona_required`, 409 `retro_exists`·`checks_unconfirmed`, 422 `<key>: unknown`·`affiliationId: invalid`·`displayMode: name_required`·`labelScope: named_fixed`·`showCohort: anonymous_not_allowed\|no_cohort`·`answers`·`guidelinesConfirmed: confirm_required`, 429 |
| `GET /me/completion-retros` | 200 | – |
| `POST /me/completion-retros/:id/withdraw` | 200(이미 철회 200) | 404 |
| `POST /reports {targetType: completion_retro, targetRef: {retroId}}` | 201/200 | 404(읽을 수 없음·게시 중 아님·플래그) |
| `POST /operator/reports/:id/resolve {action: hide_retro}` | 200 | 409 `target_not_public` |

## 결과

- 토픽의 현직자 답변이 과목 허브의 선배 노트로 이어지고, 작성자는 이름을 걸지(그 페르소나 활동이 됨) 소속 표시만 남길지(페르소나와 끝까지 무관) 고릅니다. S-02 속성 테스트를 넓혀 무작위 세계에서 토픽 답변을 네 방식으로 옮겨 게시해도 원 글 id·작성 시각·토픽 값·옮기기 id는 어떤 페르소나 출력에도 없고, 익명·소속 표시 복사본은 노트 id조차 없으며, 실명·표시명 복사본은 같은 종류 페르소나의 노트 활동으로만 나타남을 확인합니다(세계마다 범주를 임계값 이상으로 채워 소속 표시 복사본이 실제로 생기게 함).
- 수료 회고는 별점·연봉·추천 점수 없이 경험만 남고, 작은 기관의 익명 회고는 기관 이름이 붙지 않습니다.
- 한계: 과목과 이어지지 않는 커리어 답변은 옮길 곳이 없습니다. 수료 회고는 공개 검색·프로필에 나오지 않아 기관 밖 예비 수강생은 인증 없이는 읽지 못합니다. 이름 표시를 고른 복사본은 원 글을 읽은 사람이 같은 글임을 알아볼 수 있습니다(화면 안내, C-09와 같음). 익명 회고 작성자는 넓혀졌는지로 그 기관(·범주)이 50명 미만인지 알 수 있습니다(A-05와 같이 작성자에게만). 회고 고치기·'도움됐어요' 신호는 없습니다.

## 대안

- **`senior_notes.course_id`를 nullable로 만들고 회고를 같은 표에**: 설계 문구에 가깝지만 과목 허브·검색·신호·투영 카드·병합 경로 모두에 "과목 없음" 예외가 생기고 회고가 공개 경로로 샐 위험이 큽니다.
- **소속 표시를 옮길 때 다시 계산**: 최신 인원을 반영하지만 원 글과 다른(더 좁거나 다른 소속의) 표시가 붙을 수 있어 "1단계로 남기면"과 A-05 고정 원칙을 어깁니다.
- **질문 글도 함께 옮기고 질문자 동의 받기(막힘 Q&A처럼)**: 선배 노트는 고정 질문에 대한 답이라 질문 글을 담을 자리가 없고, 동의 대기가 생겨 현직자 답변을 남기는 흐름이 길어집니다. 질문을 담는 형태가 필요하면 막힘 Q&A를 토픽으로 넓히는 새 결정이 필요합니다.
- **이름을 고른 복사본에도 소속 표시를 저장**: 나중에 방식을 바꿔 이름 ↔ 소속 표시 글을 잇는 길이 생깁니다.
- **수료 회고 공개(공개 아카이브·검색)**: 예비 수강생에게 가장 유용하지만 기관 평판 분쟁 위험과 반론 경로 부재로 미뤘습니다(§4).
- **익명 회고도 언제나 기관 이름으로**: 인증 수료생이 몇 명뿐인 기관에서 익명 회고가 사실상 실명이 됩니다. 반대로 "작은 기관은 익명 회고 금지"는 작성 기회를 막아, 넓혀 표시하고 기관 목록에서 빼는 쪽을 골랐습니다.
- **추천 여부(예/아니오) 같은 가벼운 평가**: 숫자가 아니어도 집계하면 추천 점수가 됩니다. 두지 않습니다.
