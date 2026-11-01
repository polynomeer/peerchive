# 0042. 토픽·소속 표시 익명·임계값: `community_spaces.kind = topic`(운영자만, 기관 인증 하나 이상이면 읽고 씀, 멤버십 없음) + 1단계 이름 표시 `affiliated_anonymous`(토픽 전용, 페르소나 없음·투영 없음) + 글·댓글 행에 작성 시점 소속 표시 고정(기관 이름/기관 유형/표시 안 함) + 두 단계 임계값: (정본 기관, 신분) 인증 회원 50명 미만이면 기관 유형으로, 넓힌 범주(기관 유형, 신분)도 50명 미만이면 표시 안 함(작성자에게만 안내)

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

A-05는 DELIVERY_PLAN §4.3 P2 백로그의 토픽 항목입니다: "운영자 전용 토픽 생성, `affiliation_label` 작성 시점 고정, `(기관, 신분)` 인증 회원 50명 미만이면 자동 상향, 넓혀짐 여부는 작성자에게만, 학과·기수·입학연도 미표시, 0~1단계 투영 0건(S-02 테스트 확장)". 수용 시나리오 §5.3 Y는 "인증 회원이 30명인 부트캠프의 수료생이 `취준` 토픽에 글을 쓰면 `부트캠프 수료생`으로 표시되고, 넓혀졌다는 사실은 작성자에게만 안내. 인증 졸업생이 60명 이상인 대학의 졸업생은 `○○대 · 졸업생`. `표시 안 함`이면 소속이 붙지 않음. 이후 회원 수가 늘거나 소속이 바뀌어도 이미 쓴 글의 표시는 그대로, 학과·기수는 어떤 경우에도 표시되지 않음"입니다. §7 GA 게이트는 "A-05 임계값·S-02 확장 회귀 테스트"를 요구합니다. 관련 설계와 앞선 결정:

- PROOFU_EVOLUTION_PLAN §4.4: 정체성 단계 — 0단계 익명, **1단계 소속 표시 익명**(이름 없이 소속만), 2단계 표시명, 3단계 실명. §8.9.10: 토픽은 운영자가 열고 "기관 인증 계정이면 누구나 참여", 표시할 소속 범위(학교명 / 학교 유형 / 표시 안 함)는 작성자가 고름, 임계값(초기안 50) 미만이면 `부트캠프 수료생`·`대학 졸업생`처럼 넓은 범주로 자동 상향(n ≥ 5 익명 집계 원칙의 확장). 같은 절의 공감 라운지는 "익명이 기본이며 이미지·짧은 영상도".
- SYSTEM_DESIGN §6.7.2: `CommunitySpace(kind = topic)` + `topic_category`, 운영자만 생성, `current_name_mode = affiliated_anonymous` 고정, 열람·쓰기는 활성 `InstitutionAffiliation`이 하나라도 있는 계정. Post·Comment에 `affiliation_id?`(운영자 전용)·`label_scope_requested`·`label_scope_applied`·`affiliation_label`(작성 시점 문자열 고정). `InstitutionMemberCount`(일 단위 집계). §6.7.1: `affiliated_anonymous`는 `persona_id`가 항상 NULL(CHECK). §8.3 불변조건 1: 0~1단계 글은 투영 경로 자체가 없음. §8.4: 토픽 읽기·쓰기는 활성 기관 인증 하나 이상(아니면 404), 운영자 가능, 작성자 확인은 사유·감사 기록 경로뿐, 인증이 만료·철회되면 다음 요청부터 쓰기 자격을 막되 이미 쓴 `affiliation_label`은 바꾸지 않음. §9.2 `labelBroadened`는 작성자 본인 응답에만.
- ADR 0020·0030(이름 표시 방식: 쓰는 순간 고정 + 고정 열 트리거), 0022(글·댓글: 스레드 익명 번호, 작성자 id + 글 id를 한 행에 남기는 감사 없음), 0023(운영자 작성자 확인 `community_author_lookups`), 0029(S-02 경계: 작성 시점 페르소나·투영 트리거·속성 테스트), 0037(기관 = `schools.kind`, 신분은 student/alumni 그대로·글자만 대학 재학생/졸업생·그 밖 수강생/수료생, 플래그 `topics`), 0041(라운지 미디어는 공식 학교 페이지 자유 게시판만, 토픽은 A-05에서 정함).

## 결정

### 1. 토픽 = 운영자가 여는 공간 종류 `topic`

- `community_space_kind`에 `topic`, 새 enum `topic_category`(career·grad_school·startup·military·campus_life·role, 설계 그대로)와 `community_spaces.topic_category`(토픽에만 — check). check `community_spaces_topic_check`: 토픽은 학교가 없고(`school_id` null) 이름 표시가 `affiliated_anonymous`, 토픽이 아니면 `affiliated_anonymous`일 수 없음.
- 새 표를 만들지 않고 공간·게시판·글·댓글·공감·신고·운영 도구를 그대로 씁니다. 기본 게시판 하나(`general`, `게시판`).
- `@peerchive/domain isOperatorSpaceKind`(공식 학교·학과 페이지 + 토픽): 멤버십이 아니라 인증에서 자격이 나오고, 가입·초대·멤버 목록·멤버 수가 없고, 이름 표시 방식을 바꿀 수 없고, 설정·게시판·보관은 운영자만, 모더레이션은 운영자(와 모더레이터 멤버십 — 토픽에는 지정 API를 열지 않음), 자동 숨김 기준은 공식 페이지 값, 소규모 방 시각 버킷 없음. `isOfficialKind`(`공식` 배지·학교 연결·공식 페이지 기본 게시판·모더레이터 지정)는 그대로 공식 페이지만입니다.
- **자격**: `canReadSpace(topic)` = active 기관 인증 하나 이상(대학·부트캠프 무관) 또는 운영자. `canWriteBoard(topic)` = active 기관 인증 하나 이상(운영자도 인증이 없으면 읽기만 — 소속 표시에 쓸 소속이 없음). 인증이 만료·철회되면 다음 요청부터 404입니다.
- **만들기**: 운영자만 — `POST /api/v1/operator/community/topics {name, description?, category}`(403 `operator_only`, 플래그 꺼짐 404, 같은 이름 키(`labelKey`) 409 `topic_exists` + slug, advisory lock), 화면 `/operator/community`의 "토픽 열기"(플래그가 켜졌을 때만), CLI `pnpm --filter @peerchive/db topic create|list`(플래그와 무관하게 준비 — ADR 0037의 CLI 원칙). 감사 `community.topic_create{kind, category}`(CLI는 `via: cli`).
- **목록**: `GET /api/v1/community/topics` → `{eligible, items: [{slug, name, description, category, status}]}`(active·보관, 분류 → 이름 순). 활성 기관 인증이 없으면 `eligible: false` + 빈 목록(토픽 이름도 보내지 않음). 멤버 수·글 수는 없습니다. 토픽은 "내 공간"·찾기 목록에 섞지 않고 `/community/topics`에서만 엽니다. 상세·게시판·글은 기존 `/community/s/:slug`·`/b/:id`·`/p/:id` 경로를 씁니다.

### 2. 1단계 이름 표시 `affiliated_anonymous`

- `community_name_mode`에 `affiliated_anonymous`. `@peerchive/domain NAME_MODES`는 DB enum과 같은 네 값이고, 방이 고를 수 있는 방식은 새 `ROOM_NAME_MODES`(실명·표시명·익명)입니다(방 만들기·방식 변경 예약·모집의 스터디 방 방식은 이것만 받음 — 422). 같은 enum을 쓰는 `projects.study_name_mode` 등에는 이 값이 들어오지 않지만 타입이 넓어져 `asRoomNameMode`(들어오면 가장 보수적인 `anonymous`로 읽음)로 좁힙니다.
- `nameModeAtWrite`: 토픽은 항상 `affiliated_anonymous`(다른 방식 요청은 422 `nameMode: mode_fixed`), 공식 페이지에서 고르면 422 `affiliated_not_allowed`, 사용자 방은 기존대로 `mode_fixed`. 플래그와 무관하게 토픽 밖에서는 거부됩니다.
- 작성자 표시는 익명과 같습니다(`resolveAuthorDisplay` → anonymous, 스레드 번호 `글쓴이`·`익명N` — `assignThreadAlias`가 0·1단계를 같이 셈). 방별 프로필·배지는 찾지도 않습니다. 소속 표시는 번호 옆에 붙습니다(§6.7.2 "번호").
- **페르소나 없음**: `community_posts/comments_persona_check`를 `name_mode::text not in ('anonymous', 'affiliated_anonymous') or persona_id is null`로 넓혔습니다. 서비스는 페르소나를 찾지 않고(`personaKindForNameMode` → null), 투영 outbox를 만들지 않으며, 분석 이벤트는 익명처럼 사용자 키 없이(unlinked) 남깁니다. DB 투영 함수(`persona_activity_source_ok`, 0031)는 community_post를 `real`·`display` + 작성 시점 `persona_id`로만 허용하므로 고치지 않아도 이 값의 투영 경로가 없습니다(원시 SQL로도 23514 — 테스트).
- **토픽 밖 금지(DB)**: `community_persona_attribution_guard`(BEFORE INSERT)를 다시 정의해 `affiliated_anonymous` 글은 토픽 공간에서만, 댓글은 글의 공간이 토픽일 때만 넣을 수 있게 했습니다(23514).

### 3. 작성 시점에 고정하는 소속 표시

- 글·댓글 열(커뮤니티 구역 — social DB 역할 권한 없음, C-05·S-02 경계 검사가 자동으로 덮음): `affiliation_id`(→ `institution_affiliations`, 운영자 전용), `label_scope_requested`·`label_scope_applied`(새 enum `affiliation_label_scope`: institution → institution_kind → none 순으로 넓음), `affiliation_label`(1–100자).
- check: 네 열은 `affiliated_anonymous` 행에만(범위 둘은 필수), 적용 범위는 고른 범위와 같거나 `institution → institution_kind → none` 방향으로만 넓음(**좁게 표시하는 경우 없음**), `none`이면 문자열 없음·아니면 있음.
- **고정**: 고정 열 트리거(`community_frozen_columns_guard`)가 범위·문자열의 모든 변경을 거부하고 `affiliation_id`는 null로 비우는 것만 허용합니다(탈퇴 정리). 이후 회원이 늘거나 소속이 해제·철회·병합돼도 이미 쓴 표시는 그대로입니다. 고치기(PATCH)는 이 열을 건드리지 않습니다.
- **문자열**: 기관 이름 `○○대학교 · 졸업생`(정본 기관 이름 + `standingLabelFor`: 대학 재학생/졸업생, 그 밖 수강생/수료생), 기관 유형 `대학 졸업생`·`부트캠프 수료생`·`교육 프로그램 수료생`·`동아리 연합 수료생`(`INSTITUTION_KIND_LABELS` + 신분 글자). **학과(자기 신고)·기수·입학연도는 읽지도 않습니다**(소속을 읽는 쿼리가 그 열을 고르지 않고, 표시 함수는 그 값을 받지 않음). 표시 안 함이면 문자열·소속 id 모두 없음.
- **입력**: 글·댓글 쓰기 `{…, affiliationScope?: institution|institution_kind|none, affiliationId?}`. 기본 범위는 기관 이름(설계 "작성자가 고름" — 가장 좁은 것을 기본으로 두고 임계값이 넓힘), 기본 소속은 가장 최근에 인증한 active 소속. 소속 id는 내 active 인증 소속이어야 하고(아니면 422 `affiliationId: invalid`), 표시 안 함에 소속 id를 주면 422 `affiliationId: not_applicable`. 토픽이 아닌 공간에 이 입력이 있으면 422 `affiliationScope|affiliationId: not_allowed`.
- **응답**: 글·댓글 DTO에 `affiliationLabel`(게시 중일 때 고정한 문자열, 표시 안 함이면 null, 지우거나 가린 글은 null — 소속 표시 익명 글에만 키가 있음). **소속 id·회원 수는 어떤 응답에도 없습니다**. 운영자 화면의 신고 대상 표시(`operatorCommunityItem`)도 같은 문자열을 보여 줍니다.

### 4. 임계값과 넓혀짐 안내

- 규칙(`@peerchive/domain decideAffiliationLabel`, **두 단계**):
  - 표시 안 함 → 없음.
  - 기관 이름 → 그 순간의 **(정본 기관, 신분)** 인증 회원 수 ≥ 임계값이면 기관 이름. 아니면 **넓힌 범주(기관 유형, 신분 — 그 유형의 모든 정본 기관 합계)** 인증 회원 수 ≥ 임계값이면 유형 글자. 그것도 미만이면 **표시 안 함(`none`)**.
  - 기관 유형 → 범주 인증 회원 수 ≥ 임계값이면 유형 글자, 아니면 표시 안 함.
  - 고른 범위와 적용 범위가 다르면 넓혀진 것(`broadened`)입니다. 예: 전국에 인증 수료생이 30명뿐인 교육 프로그램의 수료생은 기관 이름·유형 어느 쪽을 골라도 소속 표시 없이(이름 없는 익명과 같게) 보이고, 작성자에게만 넓혀졌다고 알립니다. 표시 안 함이 되면 소속 id도 남기지 않습니다(표시가 없으므로).
- **세는 회원**(`countsTowardLabelThreshold`, 서버 `verifiedMemberCount`·`verifiedCategoryCount` SQL): 정본 기관(`coalesce(merged_into, id)` — 병합된 학교의 소속도 정본으로 셈, 범주 단계는 정본 기관의 종류)·같은 신분(student/alumni)·`status = active`·`verified_at` 있음·**active 계정**, 사람 단위로 한 번(`count(distinct user_id)`). pending·만료·철회 소속, 인증 전 행, 정지·탈퇴 계정, 다른 신분, 다른 기관은 세지 않습니다. 졸업생 인증 이력(만료된 alumni, ADR 0041)은 세지 않습니다 — 지금 인증된 사람만이 표시를 숨겨 주는 군중이기 때문입니다.
- 임계값: 기본 50(`AFFILIATION_LABEL_THRESHOLD`), 설정 `PEERCHIVE_AFFILIATION_LABEL_THRESHOLD`(정수 5~10000, 그 밖·빈 값은 50 — 5 미만으로 낮출 수 없음, n ≥ 5 원칙의 하한). 요청마다 읽고 새 글에만 적용됩니다.
- **실시간으로 셉니다**(설계의 `InstitutionMemberCount` 일 단위 집계 표를 두지 않음): 쓰는 트랜잭션 안에서 두 수(기관·범주)를 한 번씩 세고 결과는 판정에만 씁니다(저장·응답·로그 없음). 이유: 집계 표는 갱신 작업·지연(하루 동안 넘은 기준이 반영 안 됨)을 더하고, 인원 수 자체가 행으로 남으면 그것이 새 소규모 집계 노출 지점이 됩니다. 기관마다 수천 명 수준에서 색인(`institution_affiliations_school_id_idx`)으로 충분합니다. 쓰기 경로가 무거워지면 집계 표로 바꾸되 판정 규칙(`decideAffiliationLabel`)은 그대로 둡니다.
- **넓혀졌는지는 작성자에게만**: 행에는 고른 범위·적용 범위가 남지만(감사·운영 확인용), 응답에는 보는 사람이 작성자 본인일 때만 `labelBroadened`(두 범위가 다른지)를 싣습니다. 다른 사람의 응답에는 키 자체가 없습니다. 글쓰기 화면 `composer.affiliation`은 **내 소속마다 범위별 미리보기**(`{label, broadened}` — 표시 안 함이 되면 `label: null` + `broadened: true`, 화면은 "익명(소속 표시 없음)"과 안내)와 안내 문구를 줍니다(회원 수 없음). 작성자는 넓혀졌는지로 "기관(·범주)이 50명 미만인지"를 알게 되는데, 설계가 작성자에게 알리라고 한 것이고 자기 소속에 대해서만입니다.

### 5. 운영자 작성자 확인

- 기존 `POST /operator/community/author-lookups`(ADR 0023: 사유·근거·한도·감사 id만) 응답에, 소속 표시 익명 글·댓글이면 `affiliationId`(표시에 쓴 소속, 표시 안 함·탈퇴 정리 뒤면 null)를 더했습니다. 소속 id는 이 사유 기록 경로로만 운영자에게 보입니다. 기관 운영진(I-02)·방장·모더레이터에게는 없습니다(§8.4).
- 감사 기록·분석 이벤트에 소속 id·표시 문자열을 넣지 않습니다(글 작성 감사는 원래 없음, 분석은 방식·영역 코드만 — `post_created.area`에 `topic`, `mode`에 `affiliated_anonymous`).

### 6. 탈퇴 정리

- worker purge가 그 사람의 소속 행을 지우기 전에 글·댓글의 `affiliation_id`를 null로 비웁니다(외래 키). 글·댓글은 기존대로 작성자 삭제(제목·본문 비움)가 되고, 표시 문자열은 고정 열이라 남지만 지운 글에는 응답하지 않습니다.

### 7. 토픽 미디어·'많이 공감한 글' 탭은 미룸

- 토픽에는 미디어를 붙이지 않습니다(라운지 미디어 규칙 `isLoungeBoard`는 공식 학교 페이지 자유 게시판만, ADR 0041). 이유: 토픽은 학교를 넘나들어 사진 속 정보(학교 건물·명찰)가 소속 표시 익명을 깨뜨리기 쉽고, 임계값으로 넓힌 표시를 사진이 되돌릴 수 있습니다. A-04와 같은 파이프라인이라 붙이는 것은 작으므로, 토픽 운영 근거가 생기면 새 ADR로 엽니다.
- '많이 공감한 글' 탭(ADR 0041이 A-05 범위로 남김)은 A-05 완료 기준(DELIVERY_PLAN)에 없어 미뤘습니다. 공감 수는 글 응답에 이미 있습니다.

### 8. 플래그

- 꺼짐(기본): 목록·만들기 API 404, `loadSpaceContext`가 토픽 공간을 404로(상세·게시판·글·댓글·공감·신고·고치기 모두 이 함수를 거침), 커뮤니티 첫 화면 링크·운영자 토픽 폼 숨김. 운영자 공간 도구(제한·보관 — `loadSpace` 직접)·작성자 확인·탈퇴 정리는 플래그와 무관합니다. 토픽 행·글은 남아 다시 켜면 보입니다. `affiliated_anonymous`는 토픽 밖에서 언제나 거부되므로 플래그가 꺼지면 이 방식으로 쓸 수 있는 곳이 없습니다.

### 9. migration `0038_topics_affiliation_labels`·`0039_affiliation_label_category_threshold`

- enum 값 두 개(`ADD VALUE`)와 새 enum 둘, 열·색인·check, 그리고 손으로 둔 트리거 함수 두 개(`CREATE OR REPLACE`). drizzle migrate는 빈 DB에서 모든 migration을 한 트랜잭션으로 돌리고 PostgreSQL은 ADD VALUE한 값을 같은 트랜잭션에서 쓸 수 없으므로, **새 enum 값을 쓰는 check·트리거는 모두 `::text` 비교**입니다(0033과 같은 방식, migration을 둘로 나눠도 같은 트랜잭션이라 나누지 않음). 새로 만든 enum(`affiliation_label_scope`)의 값은 같은 트랜잭션에서 써도 됩니다. 빈 DB(`peerchive_verify`)에서 처음부터 migrate되는 것을 확인했습니다.
- 두 단계 임계값(위 §4)은 `*_label_scope_check`에 `institution → none`·`institution_kind → none`을 더한 `0039_affiliation_label_category_threshold`입니다. 0038이 이미 적용된 개발 DB를 손으로 고치지 않으려고 0038을 바꾸지 않고 별도 migration으로 두었습니다(새 enum 값을 쓰지 않아 text 비교 불필요). 빈 DB에서 0038·0039를 함께 migrate하는 것도 확인했습니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| 토픽 관련 모든 경로 | – | 플래그 꺼짐 404, 401 |
| `GET /community/topics` | 200(`eligible`) | – |
| `POST /operator/community/topics` | 201 + 상세 | 403 `operator_only`, 409 `topic_exists`, 422 `name`·`description`·`category` |
| `GET /community/spaces/:slug`·`/boards/:id/posts`·`/posts/:id`(토픽) | 200(`affiliationLabel`, 본인 `labelBroadened`, `composer.affiliation`) | 404(활성 기관 인증 없음) |
| `POST /community/boards/:id/posts`·`/posts/:id/comments`(토픽) | 201 | 403 `write_not_allowed`(운영자 인증 없음)·`write_restricted`, 404, 409 `space_not_active`, 422 `nameMode: mode_fixed`·`affiliationScope`·`affiliationId: invalid\|not_applicable` |
| (그 밖 공간) 글·댓글 쓰기 | – | 422 `nameMode: affiliated_not_allowed`(공식)·`mode_fixed`(방)·`affiliationScope\|affiliationId: not_allowed` |
| (기존) 방 만들기·방식 변경 예약 | – | `affiliated_anonymous` 422 `nameMode\|toMode: invalid` |

## 결과

- 학교·기관을 넘나드는 토픽에 이름 없이 소속과 신분만 붙은 글을 쓸 수 있고, 인증 회원이 적은 소속은 자동으로 넓은 범주로 보이며 넓혀졌다는 사실은 작성자만 압니다. 표시는 쓰는 순간 행에 고정되어 이후 인원·소속 변화로 바뀌지 않습니다(DB 트리거).
- 1단계 글은 0단계와 같이 페르소나·활동 목록·피드·검색으로 나가지 않습니다: DB check(persona null)·투영 함수 허용 목록·S-02 속성 테스트(무작위 세계에 토픽·소속 표시 익명 글·댓글을 넣고 모든 페르소나 공개 출력·활동·피드·추천·검색에 id·본문·해시·시각·토픽 이름 0건, `persona_activities` 0건).
- 넓힌 범주도 작은 집단이면(예: 전국 인증 회원이 몇 명뿐인 동아리 연합·교육 프로그램) 두 번째 단계가 소속 표시를 없앱니다. 설계는 한 단계만 정했지만, 범주 글자도 작은 집단에서는 익명을 깨뜨리므로 같은 임계값을 범주에도 적용했습니다.
- 한계: 같은 사람이 여러 글을 쓰면 말투·시각으로 이어질 수 있는 것은 익명과 같습니다(스레드 사이 번호를 공유하지 않는 것까지가 보장). 작성자는 넓혀졌는지로 자기 소속이 50명 미만인지 알 수 있습니다(설계상 허용). 토픽 미디어·'많이 공감한 글' 탭은 미뤘습니다.

## 대안

- **토픽 전용 표(`topics`)**: 공간·게시판·글·신고·운영 도구를 모두 다시 이어야 합니다. 설계(`CommunitySpace.kind = topic`)와도 다릅니다.
- **소속 표시를 읽을 때 계산**: 표시가 인원·소속 변화를 따라 바뀌어 "이미 쓴 글은 그대로"를 어기고, 넓혀졌던 글이 나중에 기관 이름으로 좁아질 수 있습니다.
- **`InstitutionMemberCount` 일 단위 집계 표**: 위 §4 이유로 실시간으로 셉니다. 판정 함수가 숫자만 받으므로 나중에 바꿔도 규칙은 같습니다.
- **넓혀졌는지를 공개 DTO에 싣기(`labelBroadened` 모두에게)**: "이 기관은 50명 미만"이라는 소규모 집단 정보가 모두에게 나갑니다(설계 §9.2가 금지).
- **`affiliated_anonymous`를 방이 고를 수 있는 방식으로**: 기관이 섞인 방에서 소속 표시가 소규모 방 구성원을 바로 드러냅니다. 설계가 토픽에만 둡니다(A-06 선배 노트 이동은 그때 정함).
- **범주 단계 없이 한 단계만(설계 원문)**: 희귀한 기관 유형의 범주 글자(`동아리 연합 수료생`)가 몇 명뿐인 집단을 가리키게 됩니다. 범주가 작으면 표시하지 않는 쪽이 n ≥ 5 원칙에 맞습니다.
- **범주가 작으면 더 넓은 상위 범주(`수료생`) 하나 더**: 신분 글자만으로는 맥락이 거의 없고 단계만 늘어납니다. 표시 안 함으로 충분합니다.
- **migration을 enum 값과 나머지 둘로 나누기**: 빈 DB에서는 drizzle이 둘을 한 트랜잭션으로 돌려 효과가 없습니다. `::text` 비교가 실제 해결책입니다.
- **운영자도 인증 없이 토픽에 쓰기**: 소속 표시에 쓸 소속이 없어 "표시 안 함"만 가능한데, 운영자 공지는 공식 경로(제재·공간 도구)가 따로 있습니다. 읽기·운영만 엽니다.
