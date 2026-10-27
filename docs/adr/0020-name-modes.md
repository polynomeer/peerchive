# 0020. 이름 표시 방식·변경 이력: 작성 시점 고정 계약 + 방장만 하는 7일 예약 + worker 적용 + 멤버 전원 화면 알림 + 실명 방 가입 방식 기본값 적용

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-03은 DELIVERY_PLAN §4.1 "글·댓글에 작성 시점 모드 고정, 변경은 7일 예약·멤버 알림·이후 글에만 적용, 이전 글 소급 변경 0건"과 §5.1 시나리오 L(실명 방 → 익명: 알림·7일 뒤 적용, 이전 실명 글은 실명·이후 글은 익명, 반대 방향도 이전 익명 글의 작성자를 드러내지 않음, 변경 이력은 방 설정에서 확인)입니다. 관련 설계:

- PROOFU_EVOLUTION_PLAN §4.4(정체성 단계: 익명·표시명·실명, 0~1단계 글은 2~3단계 프로필과 연결하지 않음), §8.9.3(공식 페이지는 익명 기본, 글 단위로 표시명만, 실명 없음), §8.9.4(사용자 방의 이름 표시 방식, "바뀐 방식은 이후 글에만… 전환 전 멤버 전원에게 알리고 7일 뒤 적용", 실명 방은 승인·초대가 기본, 실명은 계정에 입력한 이름이며 신분 확인 없음).
- SYSTEM_DESIGN §6.7: `CommunitySpace.current_name_mode`, `NameModeChange`(append-only, `effective_at = requested_at + 7일`, 예약 시 멤버 전원 알림, worker가 적용, 소급 없음, 공간마다 `scheduled` 하나), `Post`·`Comment.name_mode`(작성 시점에 복사해 고정), "실명"(`User.real_name`, 선택·신분 확인 없음, 학교 연결 공간은 인증 여부만), §8.1(이름 표시 방식 변경: 방장·admin 칸 "사용자 방만, 7일 예약", 공식 페이지 고정, 방장·모더레이터용 API도 같은 공개 DTO), §9.1(`POST /community/spaces/:id/name-mode-changes` "방장").
- ADR 0019(C-02): 공간 모듈 경계, 정책 함수 한 곳, 실명 방 가입 방식 기본값 approval(`defaultJoinPolicy`), 만들 때 정한 방식은 `PATCH`로 못 바꿈(422 `nameMode: not_editable`).
- 글·댓글 테이블은 C-04입니다. C-03은 C-04가 쓸 계약(함수·DB 열 규칙)을 정합니다.

## 결정

### 작성 시점 고정 계약(C-04가 지킬 것)

- **글·댓글은 쓰는 순간의 방식을 `name_mode` 열에 복사해 고정합니다.** C-04는 `posts.name_mode community_name_mode NOT NULL`·`comments.name_mode community_name_mode NOT NULL`을 두고, 그 값은 같은 트랜잭션에서 공간 행을 `FOR SHARE`로 잠근 뒤 `@peerchive/domain`의 `nameModeAtWrite(space, now, requested?)`가 돌려준 값만 씁니다. 수정(`edited_at`)·공간 방식 변경·예약·적용·취소는 이 열을 바꾸지 않으며, C-04는 이 열을 바꾸는 UPDATE 경로를 두지 않습니다(바꾸려는 시도를 막는 트리거 또는 서비스 테스트를 C-04에 둠).
- `nameModeAtWrite`:
  - 사용자 방·스터디 방: 그 순간 효력이 있는 방식(`effectiveNameMode(current_name_mode, scheduled, now)`). 글쓴이가 다른 방식을 고르면 `mode_fixed`.
  - 공식 페이지: `anonymous` 기본, 글 단위 `display`만 허용, `real`은 `real_not_allowed`(§6.7 Post·§8.1).
  - **예약은 `effective_at` 전에는 아무 영향이 없고, `effective_at`부터는 worker가 적용하기 전이라도 새 방식입니다.** 적용 시각이 worker 지연(최대 약 1분)에 흔들리지 않게 하려는 것이며, 공간 상세의 `nameMode`·이력의 `currentMode`도 같은 함수로 계산합니다.
- 작성자 표시는 `resolveAuthorDisplay(modeAtWrite, author, viewer)` 하나로 정합니다. 인자로 공간의 지금 방식·예약을 받지 않으므로(타입으로) 소급할 길이 없습니다.
  - `real` → 계정의 선택 실명 `users.real_name`(없으면 "실명 미입력"), 학교를 연결한 공간이면 그 학교 인증 여부(`schoolVerified`)만 덧붙임. C-04는 실명 방식 공간에서 실명이 없으면 쓰기 전에 입력을 요구합니다(그래도 나중에 지운 경우의 표시가 "실명 미입력").
  - `display` → 계정 표시 이름(`users.display_name`). **방별 이름(RoomProfile, SYSTEM_DESIGN §6.7.2)은 P2**이고, S-01 Persona가 생기면 그 표시명 페르소나로 바뀝니다(그때 `persona_id`를 작성 시점에 함께 고정, §6.7.1).
  - `anonymous` → 이름·id·핸들 없음, `threadAlias: 'computed_by_thread'` 표시만. 스레드 번호(`글쓴이`·`익명1`…)는 C-04의 ThreadAlias가 채웁니다. 작성자가 탈퇴해도 똑같이 익명(탈퇴 여부도 드러내지 않음).
  - 탈퇴(정리)한 작성자의 실명·표시명 글은 "탈퇴한 사용자".
  - 보는 사람이 방장·모더레이터·운영자여도 결과가 같습니다. `viewer`는 본인 글 표시(`mine`)에만 씁니다. 익명 글의 작성자 확인은 C-06의 사유·감사 기록 경로뿐입니다.
- 이름 자체(실명·표시 이름)는 읽을 때의 값입니다(사람이 이름을 고치면 실명·표시명 글의 이름도 따라감). 고정하는 것은 **방식**입니다 — 익명 글이 실명 방 전환으로 드러나지 않고, 실명 글이 익명으로 바뀌지 않는 것이 요구사항이며, 이름 문자열을 글마다 복사하면 탈퇴·정정 때 지울 곳이 늘어납니다.

### 실명(`users.real_name`)

- 선택 입력, 30자, 신분 확인 없음(§6.7 "실명"). 본인 `GET /me`에만 싣고 `PUT /me/real-name {realName | null}`로 고치거나 지웁니다(감사 `account.real_name_update`에는 `set` 여부만). 공개 프로필·공개 DTO·검색·포트폴리오·공개 스냅샷에는 들어가지 않습니다(공개 스냅샷 SENTINEL 테스트에 실명을 넣어 확인). 화면은 `/community`의 "실명 (선택)".
- 탈퇴 정리 때 null로 지웁니다.

### 변경 예약·취소·적용

- **방장(owner)만** 예약합니다(`canManageSpace(…, 'change_name_mode')`). §8.1 표의 "방장·admin" 칸은 열 이름이고 §9.1 API 표가 "방장"이라, 역할 변경·보관과 같은 owner 전용으로 정했습니다(멤버 전원에게 영향이 크고 7일 뒤 되돌리려면 또 7일이 걸림). 운영자도 사용자 방의 방식을 바꾸지 않습니다(사용자 방 읽기 권한 없음, ADR 0019). 공식 페이지는 아무도 못 바꿉니다(409 `name_mode_fixed`).
- `POST /community/spaces/:slug/name-mode-changes {toMode}` → `effective_at = now + 7일`(DB check `effective_at = requested_at + interval '7 days'`). 공간마다 scheduled 하나(부분 unique `name_mode_changes_one_scheduled_key` + 409 `change_already_scheduled`). 같은 방식 422 `toMode: same_mode`. 보관·제한된 방 409 `space_not_active`.
- `DELETE …/name-mode-changes/:id`: 방장, `effective_at` 전에만(409 `already_effective` — 그 뒤에는 이미 새 방식으로 글이 쓰였을 수 있음), 이미 끝난 예약 409 `not_scheduled`.
- 적용: worker 주기 작업 `name-mode-changes`(기본 매분, `PEERCHIVE_CRON_NAME_MODE_CHANGES`). 예약마다 트랜잭션 하나에서 공간 행 잠금 → `status = 'scheduled' and effective_at <= now` 조건부 update → `current_name_mode` 바꾸기 → 알림 → 감사 `community.name_mode_apply`. 조건부라 여러 worker·재시도·수동 실행이 겹쳐도 한 번만 적용되고 알림도 한 번입니다. 공간이 보관·제한 상태여도 적용합니다(예약은 이미 알렸고 되살아나면 그 방식). 같은 함수를 `pnpm --filter worker apply-name-modes`로 한 번 실행할 수 있습니다(밀린 예약 바로 적용, E2E).
- 이력(`name_mode_changes`)은 행을 지우지 않습니다. 상태만 scheduled → applied/cancelled이고 `applied_at`·`cancelled_at`·`cancelled_by`가 채워집니다. `GET …/name-mode-changes`는 공간을 읽을 수 있는 사람(사용자 방은 active 멤버)에게 지금 방식·예약·최근 50개를 주며 **요청·취소한 사람은 싣지 않습니다**(방장만 할 수 있으므로 "방장"으로 충분).

### 실명 방과 가입 방식 (결정)

- 실명으로 바꾸는 예약을 할 때 가입 방식이 **자유 가입(open)이면 같은 트랜잭션에서 방장 승인(approval)으로 바꿉니다**(`joinPolicyForNameModeChange`). 7일 사이에 들어오는 사람도 승인을 거치게 하려는 것이며, 예약 알림과 이력에 `joinPolicyAdjusted`로 남깁니다. approval·invite는 그대로입니다.
- 막지 않고(409) 바꾸는 이유: C-02는 실명 방의 승인을 "기본값"으로 두었고(만들 때 명시하면 자유 가입도 됨), 방장에게 "먼저 가입 방식을 바꾸세요"라는 두 단계를 요구하면 실수로 자유 가입 실명 방이 남기 쉽습니다. 같은 이유로 **기본값을 한 번 적용할 뿐 고정하지는 않습니다** — 방장은 설정에서 다시 자유 가입으로 바꿀 수 있고(만들 때와 같은 자유), 예약을 취소해도 가입 방식은 되돌리지 않습니다.

### 알림(`community_notices`)

- 기존 운영 조치 안내(ADR 0015)는 조치 행에서 계산하는 당사자 안내라 "멤버 전원에게 보내는 공간 소식"에 맞지 않아 새 테이블을 둡니다: `user_id`, `space_id`, `kind`(`name_mode_scheduled`·`name_mode_cancelled`·`name_mode_applied`), `name_mode_change_id`, `payload`(허용 목록: `fromMode`·`toMode`·`effectiveAt`·예약 알림의 `joinPolicyAdjusted`만, `sanitizeNoticePayload`), `created_at`, `read_at`. `(name_mode_change_id, kind, user_id)` 부분 unique로 중복이 없습니다. 이후 C-04~C-07의 공간 소식도 kind를 더해 같은 테이블을 씁니다.
- **받는 사람은 알림을 만드는 순간 그 공간의 active 멤버이면서 계정이 active인 사람**입니다(예약·취소·적용 세 번 모두). 나감·내보냄·승인 대기·탈퇴 요청 계정은 받지 않습니다. 예약 뒤에 들어온 사람은 알림 대신 공간 화면의 배너로 봅니다.
- 화면 안에서만 알립니다(메일·푸시 없음, 이메일 알림은 C-10). `GET /community/notices`(최근 50개 + 읽지 않은 수), `POST /community/notices/read {ids} | {all: true}`(내 알림만, 남의 id는 무시), 화면 `/community/notices`, `/community`의 "커뮤니티 알림 (읽지 않음 N개)" 링크. 공간 이름은 저장하지 않고 **읽을 때 그 공간을 지금 읽을 수 있을 때만** 붙입니다(나간 공간은 "지금은 볼 수 없는 공간").
- 배너: `GET /community/spaces/:slug`의 `pendingNameModeChange`(멤버·소개 모두, 승인 대기 중인 사람도 봄) → "N일 뒤 이름 표시 방식이 ○○으로 바뀝니다. 이미 쓴 글은 바뀌지 않습니다."(`nameModeBannerText`, 남은 일수 올림).

### 분석·탈퇴 정리·운영 조치

- 분석 허용 목록: `name_mode_scheduled { from, to }`(웹, 예약한 방장), `name_mode_applied { from, to }`(worker, 예약한 사람이 있고 수집 거부가 아닐 때). 공간 id·이름은 넣지 않습니다.
- 탈퇴 정리: 받은 알림 삭제(장부 `community_notices`), 이력 행은 공간의 기록이라 남기고 `requested_by`·`cancelled_by`만 null(장부 `name_mode_change_actors`), `users.real_name` null. 가명 처리된 users 행을 가리키게 두지 않고 비우는 이유는 이력이 멤버에게 보이는 기록이라 "누가 바꿨는지"를 남길 필요가 없어서입니다.
- 운영 조치·신고는 새로 두지 않습니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /community/spaces/:slug/name-mode-changes {toMode}` | 201 `NameModeStateDto` | 401, 403(방장 아님), 404(읽을 수 없음), 409 `name_mode_fixed`·`space_not_active`·`change_already_scheduled`(+`changeId`·`effectiveAt`), 422 `toMode: required\|invalid\|same_mode` |
| `DELETE /community/spaces/:slug/name-mode-changes/:id` | 200 `NameModeStateDto` | 401, 403, 404(공간·예약 없음), 409 `not_scheduled`·`already_effective`·`space_not_active` |
| `GET /community/spaces/:slug/name-mode-changes` | 200 `{currentMode, fixed, canChange, pending, history}` | 401, 404 |
| `GET /community/spaces/:slug` | 200 + `pendingNameModeChange`, `permissions.changeNameMode` | (C-02와 같음) |
| `GET /community/notices`, `POST /community/notices/read` | 200 | 401, 422(`ids`/`all` 둘 중 하나) |
| `PUT /me/real-name {realName}` | 200 `MeDto` | 401, 404(비활성), 422 `realName: too_long\|invalid` |
| `PATCH /community/spaces/:slug {nameMode}` | — | 422 `nameMode: not_editable`(그대로) |

## 결과

- 방장이 예약하면 멤버 전원이 즉시 알림을 받고, 7일 동안 배너로 안내되며, 그 뒤에 쓰는 글부터 새 방식입니다. 이미 쓴 글의 방식은 어떤 경로로도 바뀌지 않습니다(도메인 시뮬레이션 테스트·C-04 열 계약).
- 테이블: migration `0018_name_modes`(`name_mode_changes`, `community_notices`, `users.real_name`, enum `name_mode_change_status`·`community_notice_kind`, 분석 이벤트 2개).
- 한계: 이름 문자열은 읽을 때 값이라 실명·표시 이름을 고치면 이전 실명·표시명 글의 이름도 바뀝니다(방식은 그대로). 방별 이름(RoomProfile)·페르소나는 P2·S-01. 알림은 화면 안뿐이고 오래된 알림을 지우는 주기 작업이 없습니다(행은 작고 탈퇴 정리에서 지움). 보관·제한된 방에서도 예약이 적용되고, 그 상태에서는 방장이 취소할 수 없습니다(관리 불가 상태). 7일은 상수(설정 아님)입니다.

## 대안

- **방장·admin 모두 예약**: §8.1 표 칸을 문자 그대로 읽은 것. 영향이 큰 결정을 운영진 여럿이 번갈아 예약·취소할 수 있어 owner 전용으로 했습니다.
- **글마다 이름 문자열까지 복사**: 이름 정정·탈퇴 처리 때 모든 글을 고쳐야 하고, 요구사항(방식 고정)보다 넓습니다.
- **worker 적용 시각에만 방식이 바뀜**: 단순하지만 worker가 멈추면 7일 약속이 늦어집니다. 웹이 `effective_at`으로 계산하면 worker는 상태를 맞추는 일만 합니다.
- **실명 전환 시 자유 가입이면 409로 막기**: 명시적이지만 두 단계를 요구하고, C-02의 "기본값" 규칙과 맞지 않습니다.
- **운영 조치 안내 목록(`/me/moderation-notices`)에 섞기**: 그 목록은 당사자 안내·이의제기 흐름이라 의미가 다르고, 공간 멤버 전원에게 보내는 행이 필요합니다.
