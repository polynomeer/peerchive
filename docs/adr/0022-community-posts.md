# 0022. 커뮤니티 글·댓글·공감·스레드 익명 번호: 공간 행 FOR SHARE + DB 트리거로 굳힌 작성 시점 방식 + 익명으로 쓸 때만 받는 스레드 번호 + 보는 사람과 무관한 DTO + 행을 남기는 지우기 + 가리기만 하는 운영 조치

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-04는 DELIVERY_PLAN §4.1 "스레드 안 번호 유지·스레드 간 비연결, `글쓴이` 표시, 방장·모더레이터 응답에 작성자 식별자 없음, 비추천 없음"과 §5.1 시나리오 K(익명 작성자 보호)입니다. 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.5(스레드 단위 익명 표시: 같은 스레드에서 같은 번호, 스레드가 다르면 이어지지 않음, 글쓴이의 답은 `작성자`/`글쓴이`), §8.9.1(공감만, 비추천 없음, 인기글 탭은 P2), §8.9.6(익명은 다른 사용자에게 익명, 방장·모더레이터는 작성자를 확인할 수 없음, 이 사실을 글쓰기 화면에 표시), §8.9.7(비추천·활동 순위 없음).
- SYSTEM_DESIGN §6.7 Post·Comment·ThreadAlias·Reaction(작성 시점 `name_mode` 복사, 답글 한 단계, `(post_id, user_id)`·`(post_id, alias_no)` 유일, 글쓴이 0, 처음 쓴 순서대로 번호·재사용 없음), "소규모 익명 방"(멤버 10명 미만이면 시각 버킷), §8.1(방장·모더레이터 API도 같은 공개 DTO, `ThreadAlias.user_id`·안정적인 키 없음), §8.2, §9.1(글·댓글·공감 API).
- ADR 0020(C-03)의 **작성 시점 고정 계약**: `name_mode NOT NULL`, 같은 트랜잭션에서 공간 행을 `FOR SHARE`로 잠근 뒤 `nameModeAtWrite`가 정한 값만, 바꾸는 UPDATE 경로 없음(트리거 또는 테스트), 표시는 `resolveAuthorDisplay`.
- ADR 0021(C-05): 모든 읽기는 정책 함수 한 곳, 스키마 커뮤니티 구역 기반 경계 검사(새 테이블은 그 구역에), 감사·분석은 id·코드만, 센티넬 검사.
- ADR 0015(신고·조치는 공개 차단만, 이의제기), ADR 0016(탈퇴 정리·분석 허용 목록), ADR 0018(학교 인증), ADR 0019(공간·게시판·`canWriteBoard`, "글·댓글 신고는 C-06"이라 적었으나 신고 접수와 가리기 조치는 이번에 엶 — 아래).

## 결정

### 테이블 (migration `0020_community_posts`, 모두 schema.ts 커뮤니티 구역)

- `community_posts`: `board_id`, `space_id`(게시판의 공간 복사, 잠금·조회용), `author_id`, `name_mode`(고정), `title`(1~120), `body`(1~10000), `status`(`published`·`deleted_by_author`·`hidden`·`auto_hidden`), `edited_at`, `deleted_at`, `version`. check: 지운 글은 제목·본문이 빈 문자열이고 `deleted_at`이 있음, 나머지는 길이 범위 안.
- `community_comments`: `post_id`, `parent_comment_id`(최상위 댓글만, 서비스가 확인), `author_id`, `name_mode`(**댓글 자신의 작성 시점 방식**), `body`(1~3000), `status`·`edited_at`·`deleted_at`·`version`(글과 같은 check).
- `thread_aliases`: `(post_id, user_id)`·`(post_id, alias_no)` unique, `alias_no >= 0`.
- `community_reactions`: `post_id` 또는 `comment_id` 하나(check), `user_id`, `kind`(`empathy`만), `(대상, user, kind)` 부분 unique.
- `community_notices`에 `post_id`·종류 `post_commented`(내 글의 새 댓글, 읽기 전까지 글·사람마다 한 행 부분 unique), `reports`·`moderation_actions`에 `community_post_id`·`community_comment_id`, enum 값 `report_target_type: community_post|community_comment`, `moderation_action_kind: hide_post|hide_comment`, 분석 이벤트 3개. 같은 migration에서 더한 enum 값을 쓰는 check는 `::text`로 비교합니다(ADR 0019).
- C-05 경계 검사가 새 테이블을 자동으로 덮는 것을 테스트로 확인했습니다(커뮤니티 테이블 목록에 넷이 들어 있는지, 행위자 × 경로 매트릭스에 글·댓글·공감·신고 경로 9개를 더함).

### 작성 시점 고정: 잠금 + 함수 + 트리거 (결정)

- 글·댓글을 넣는 트랜잭션: ① 게시판·글로 공간 id를 찾음 → ② 공간 행 `SELECT … FOR SHARE` → ③ `loadReadableSpace`(정책 함수) → ④ 그 순간의 예약까지 읽어 `nameModeAtWrite` → ⑤ insert. 이름 표시 방식 예약·취소(웹)와 적용(worker)은 같은 공간 행을 `FOR UPDATE`로 잠그므로, 쓰는 도중에 방식이 바뀌는 경우가 없습니다. 댓글은 ②~③ 뒤에 글 행을 `FOR UPDATE`로 잠가 스레드 번호를 정합니다(잠금 순서: 공간 → 글).
- **DB 트리거**(`community_frozen_columns_guard`, drizzle 스키마가 표현하지 못해 migration에 손으로 둔 SQL, `pnpm db:generate` 스냅샷과 무관): `community_posts`의 `name_mode`·`author_id`·`space_id`·`board_id`, `community_comments`의 `name_mode`·`author_id`·`post_id`·`parent_comment_id`를 바꾸는 UPDATE와 `thread_aliases`의 모든 UPDATE를 SQLSTATE 23514로 거부합니다. 서비스에도 그 열을 바꾸는 경로가 없고(고치기는 제목·본문·`edited_at`·`version`만), 통합 테스트가 "예약 → effective_at → worker 적용(`applyNameModeChange`) 뒤에도 이전 글·댓글의 방식이 그대로"와 "트리거가 UPDATE를 막음"을 함께 확인합니다.
- 서비스 테스트만 두지 않고 트리거를 둔 이유: 계약이 "어떤 경로로도 소급 0건"이고, 앞으로의 운영 SQL·탈퇴 정리·다른 모듈의 실수도 막아야 하기 때문입니다. 탈퇴 정리(worker)도 제목·본문·상태만 바꿉니다.
- 공식 페이지: 익명 기본, 글·댓글마다 `display`만 고를 수 있고 `real`은 422 `nameMode: real_not_allowed`. 사용자 방은 공간 방식만(다르면 422 `nameMode: mode_fixed`). **실명 방식이면 쓰기 전에 실명이 있어야 합니다**: 없으면 403 `real_name_required`(+`requirement: real_name`), 글쓰기 화면은 미리 안내합니다(`composer.realNameRequired`).

### 스레드 익명 번호 (결정)

- 번호는 **익명으로 쓸 때만** 받습니다(`assignThreadAlias`):
  - 익명 글의 글쓴이는 0번 → `글쓴이`. 그 스레드에서 글쓴이가 익명으로 쓴 댓글도 `글쓴이`(§8.5 "작성자의 답은 `작성자`/`글쓴이`"; 커뮤니티 전체에서 `글쓴이` 한 가지로 씁니다. 질문 게시판도 `질문자` 대신 `글쓴이`).
  - 다른 사람은 그 스레드에 **처음 익명으로 쓴 순서대로** 지금까지의 가장 큰 번호 + 1(`익명1`·`익명2`…). 같은 사람은 계속 같은 번호이고, 지우거나 탈퇴해도 행을 지우지 않으므로 번호가 다시 쓰이지 않습니다.
  - **이름이 보이는 글(표시명·실명)의 글쓴이는 `글쓴이` 번호를 받지 않습니다**: 방식이 바뀐 뒤 그 사람이 익명 댓글을 쓰면 다른 사람처럼 `익명N`입니다. `글쓴이`로 묶으면 익명 댓글이 위의 이름과 바로 이어지기 때문입니다. 같은 이유로 표시명·실명 글·댓글에는 번호를 주지 않습니다(이름이 보이는 참여 순서로 익명 번호를 거꾸로 추정하지 못하게). 반대로 익명 글 아래의 표시명·실명 댓글에는 `글쓴이` 배지를 붙이지 않습니다(익명 글쓴이가 드러남).
- **스레드 사이 비연결**: 번호는 글마다 따로이고(같은 두 사람이 다른 스레드에서는 다른 번호), 응답에는 사람 id·핸들·프로필 링크·`thread_aliases`의 id·user_id가 없습니다. 댓글 id는 무작위 uuid라 사람을 묶지 못합니다. `mine`은 보는 사람 자신의 글에만 true이며 그 사람의 응답에만 들어갑니다.
- 동시성: 같은 스레드에 동시에 처음 쓰는 두 사람은 글 행 잠금으로 순서가 정해지고, unique `(post_id, alias_no)`가 마지막 방어선입니다.

### 응답(DTO): 보는 사람과 무관 (결정)

- 작성자 표시 = `resolveAuthorDisplay(고정된 방식, 작성자, 보는 사람)` + 스레드 번호(`threadAuthorView`). 익명은 `글쓴이`/`익명N`, 표시명은 계정 표시 이름, 실명은 실명 + 학교 연결 공간이면 그 학교 active 인증 여부(`schoolVerified`), 탈퇴 정리된 사람의 표시명·실명 글은 `탈퇴한 사용자`(익명 글은 탈퇴 여부도 드러내지 않고 그대로 번호). 이름은 읽을 때의 값(ADR 0020).
- **방장·모더레이터·운영자에게 추가 필드가 없습니다.** 같은 글을 방장과 다른 멤버가 받은 JSON이 같음(`toEqual`)을 통합 테스트가, 표시가 같고 JSON에 사람 id·이메일·핸들·표시 이름이 없음을 E2E가 확인합니다. 숨김 권한 플래그 같은 것도 이번에는 두지 않았습니다(방장·모더레이터의 직접 숨김은 C-06).
- **소규모 익명 방**(SYSTEM_DESIGN §6.7, §5.1 P): 공식 페이지가 아닌 공간에서 active 멤버가 10명 미만이면 **익명 글·댓글**의 시각을 `createdAt: null` + `createdBucket: today|this_week|earlier`(서울 날짜 기준)로만 보내고 `editedAt`도 숨깁니다(`edited` 참거짓만). 목록 cursor는 시각이 아니라 글 id라 버킷을 우회하지 못합니다. DB에는 정확한 시각이 남습니다.
- 글쓰기 화면 안내(`composer`): 지금 쓰면 고정될 방식, 고를 수 있는 방식, "이 방은 익명으로 표시됩니다" 같은 문장, 익명이면 "방장·모더레이터는 작성자를 볼 수 없고, 운영자는 사유를 기록한 경우에만 확인"(§8.9.6).

### 지우기·가리기 자리 표시 (결정)

- 본인 지우기는 **행을 남기고** 제목·본문을 DB에서 비웁니다(`deleted_by_author`, 그 대상의 공감 삭제). 스레드 번호·답글·운영 기록이 이어지게 하려는 것입니다. 지운 글은 **목록에서 빠지고**, 주소로 열면 "작성자가 삭제한 글입니다"와 남은 댓글이 보이며 새 댓글은 409 `post_not_open`입니다. 지운 댓글은 "작성자가 삭제한 댓글입니다" + 그 자리의 번호(익명이면)만.
- 운영 조치로 가린 글·댓글(`hidden`, C-06의 `auto_hidden`도 같음)은 본문을 DB에 남기고(이의제기로 되돌릴 수 있게) 응답에서는 "운영 조치로 가려진 글입니다"/"…댓글입니다"만 보입니다. **목록에도 자리 표시로 남깁니다**(조치가 있었다는 투명성, 내용은 없음). 작성자 본인에게도 본문을 보여 주지 않고(사유는 `/me/moderation-notices`), 고치기는 막고 지우기는 됩니다.
- 지우거나 가린 표시명·실명 글의 이름은 보여 주지 않습니다(`label: null`). 익명 번호는 남깁니다(스레드를 읽을 때 번호가 이어지게).

### 공감 (결정)

- `empathy` 하나뿐이고 비추천은 없습니다. `PUT|DELETE …/reaction`(두 번 켜도 하나), 응답은 `{count, reacted}`뿐이며 누가 눌렀는지는 어떤 응답에도 없습니다. 자기 글은 409 `own_item`, 지우거나 가린 대상은 409 `target_not_open`, 보관·제한된 공간은 409. 쓰기 역할과는 무관하게 읽을 수 있는 active 공간이면 됩니다(`canReact`). 인기글(HOT/BEST)은 P2.

### 신고·운영 조치 (결정: C-06에서 C-04로 일부 당김)

- `POST /reports {targetType: community_post|community_comment, targetRef: {postId}|{commentId}}`: **신고자가 읽을 수 있는 게시 중인** 글·댓글만(아니면 404, 형식 오류 422). 대상 내용은 복사하지 않습니다. 공간 id를 신고·조치 행에 넣지 않아 방장이 당사자가 되지 않습니다.
- 운영자 상세는 그 글·댓글 하나만(지금 행, 가린 것도 본문 포함, 작성자 표시는 익명이면 `익명`, **작성자 id 없음**). 조치는 `hide_post`·`hide_comment`(공개 차단만, 삭제 아님, 조치 행 + 당사자용 사유 + 감사에는 id만), 되돌림(이의제기 reverse)은 지금 `hidden`일 때만 `published`로.
- 당사자(안내·이의제기)는 작성자입니다. 익명 글이어도 안내는 본인에게만 가고, 본인이 이의를 제기하면 그 사실(이의제기 행)은 운영자에게 보입니다 — 본인이 스스로 하는 일이라 허용합니다.
- 서로 다른 인증 사용자 신고 누적 자동 숨김, 방장·모더레이터의 숨김 요청·제재, 운영자의 사유 기록 작성자 확인(`operator_identity_lookup`)은 C-06입니다. `canWriteBoard`의 `communityWriteSuspended`가 제재 자리입니다.

### 감사·분석·알림·로그 (결정)

- **글·댓글·공감 쓰기에는 감사 기록을 남기지 않습니다.** 감사 행 하나에 작성자 id와 글 id가 함께 있으면 운영자 감사 조회(`/operator/audit?target=`)가 익명 글의 작성자를 찾는 길이 되어 C-06의 "사유·범위·감사가 있는 작성자 확인"을 우회하기 때문입니다. 운영 조치의 감사(`moderation.apply`·`reverse`, 운영자가 행위자)는 그대로 남고 metadata는 id·코드뿐입니다.
- 분석: `post_created { kind: 게시판 종류, mode }`, `comment_created { mode, reply }`, `reaction_added { target: post|comment }`. id·제목·본문·공간·게시판 키 없음(C-05 금지 키 때문에 `board_kind`·`name_mode` 대신 `kind`·`mode`). **익명 글·댓글(과 익명 대상 공감)은 사용자 키 없이**(`emitAnalytics({ unlinked: true })`: 수집 거부·계정 상태는 확인하고 actor_hash에 이벤트마다 새 무작위 값의 HMAC) 남깁니다(SYSTEM_DESIGN §6.7, DELIVERY_PLAN C-10). 탈퇴 정리로 지울 수 없지만 사람과 이어지지 않습니다.
- 알림: 내 글에 남이 댓글을 달면 `post_commented`(payload `{count}`만, 읽기 전까지 글마다 한 행에서 개수만 올림, 댓글 쓴 사람·내용 없음, 자기 댓글은 알리지 않음). 지금 읽을 수 없는 공간이면 공간 이름·글 주소를 싣지 않습니다(ADR 0020과 같음).
- 커뮤니티 모듈은 서버 로그를 남기지 않습니다(C-05 소스 검사).

### 한도·입력

- 사용자별 시간당 글 10개·댓글 60개(429, DB 고정 창). 요청 본문 64KB를 넘으면 파싱 전에 413 `too_large`(`readCommunityWriteBody`), 제목 120자·본문 10000자·댓글 3000자(422 `too_long`), NFC·줄바꿈 정리·제어 문자 거부. 답글의 답글은 422 `parentCommentId: not_top_level`. 고치기는 `expectedVersion`(다르면 409 `version_conflict` + `currentVersion`).

### 탈퇴 정리

- worker `ops/purge.ts`: 그 사람의 글·댓글은 행을 남기고 제목·본문을 비워 `deleted_by_author`(가린 것도), 그 사람의 공감과 지운 글·댓글에 달린 공감 삭제, 스레드 번호 행은 남김(가명 처리된 users 행을 가리킴, 다른 참여자의 번호가 그대로). 표시명·실명 글의 작성자는 읽을 때 `탈퇴한 사용자`, 익명 글은 그대로 번호. 장부 종류 `community_posts`·`community_comments`·`community_reactions`. 받은 알림은 기존 규칙대로 지웁니다.

### 화면

- `/community/s/[slug]`: 게시판 이름이 글 목록 링크.
- `/community/b/[id]`: 글쓰기(이름 표시 안내·익명 고지·공식 페이지 익명/표시명 선택·실명 입력 안내), 글 목록(작성자 표시·시각 또는 버킷·댓글/공감 수, 가린 글 자리 표시, 더 보기).
- `/community/p/[id]`: 글·고치기·지우기·공감(`aria-pressed`)·신고 대화상자, 댓글·답글(한 단계)·고치기·지우기·공감·신고, 댓글 쓰기. 모두 `useCommunityPage()`(제목 고정, OG 없음), 키보드로 조작, 360px에서 가로 스크롤 없음(E2E).
- `/community/notices`: 새 댓글 알림(글 링크). `/operator/reports/[id]`: 신고된 글·댓글 하나.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /community/boards/:id/posts?cursor=` | 200 `BoardPostsDto` | 401, 404, 422 `cursor` |
| `POST /community/boards/:id/posts {title, body, nameMode?}` | 201 `CommunityPostDto` | 401, 403 `write_not_allowed`·`real_name_required`, 404, 409 `space_not_active`, 413, 422 `title`·`body`·`nameMode: real_not_allowed\|mode_fixed\|invalid`, 429 |
| `GET /community/posts/:id` | 200 | 401, 404 |
| `PATCH /community/posts/:id {title?, body?, expectedVersion}` | 200 | 401, 403 `not_author`, 404, 409 `not_open`·`version_conflict`·`space_not_active`, 413, 422 |
| `DELETE /community/posts/:id` | 200 | 401, 403, 404, 409 `not_open`·`space_not_active` |
| `POST /community/posts/:id/comments {body, parentCommentId?, nameMode?}` | 201 (스레드) | 401, 403, 404, 409 `post_not_open`·`parent_not_open`·`space_not_active`, 413, 422 `parentCommentId: not_top_level\|invalid`, 429 |
| `PATCH\|DELETE /community/comments/:id` | 200 (스레드) | 글과 같음 |
| `PUT\|DELETE /community/posts/:id/reaction`, `…/comments/:id/reaction` | 200 `{count, reacted}` | 401, 403, 404, 409 `own_item`·`target_not_open`·`space_not_active` |
| `POST /reports {targetType: community_post\|community_comment}` | 201 / 200 | 404(읽을 수 없거나 게시 중이 아님), 422 `targetRef.postId\|commentId` |
| `POST /operator/reports/:id/resolve {action: hide_post\|hide_comment}` | 200 | 409 `target_not_public`, 422 `action: not_applicable` |

## 결과

- 익명 방에서 같은 사람은 그 스레드 안에서만 같은 번호이고, 방장·모더레이터·운영자 응답도 같으며, 이미 쓴 글의 방식은 DB 수준에서 바뀌지 않습니다.
- 테스트: 도메인 `community-posts.test.ts`(번호 배정·표시·권한·버킷·허용 목록), 통합 `community-posts.integration.test.ts`(쓰기 권한·공지·공식 실명 거부·실명 필요·고정 + worker 적용 + 트리거·번호 안정/스레드 독립·동일 JSON·지우기·공감·신고 → 가리기 → 이의제기·알림·한도·페이지·분석·센티넬), C-05 매트릭스·테이블 목록 확장, worker `ops-purge`·`ops-name-modes`, E2E `community-posts.spec.ts`.
- 한계: 이름 문자열은 읽을 때 값(ADR 0020). 방장·모더레이터의 직접 숨김·고정 공지·신고 누적 자동 숨김·제재·운영자 작성자 확인은 C-06. 인기글·검색·첨부·투표는 P2. 소규모 방 판정은 지금 멤버 수라 멤버가 10명 아래로 줄면 이전 글의 시각도 버킷이 되고, 늘면 정확한 시각이 보입니다. 스레드 댓글은 한 번에 1000개까지. 익명 분석 이벤트는 사람과 이어지지 않아 탈퇴 정리로 지우지 않습니다. 가린 글은 작성자에게도 본문이 보이지 않습니다(사유는 안내 목록). 새 댓글 알림은 화면 안뿐입니다.

## 대안

- **트리거 없이 서비스 테스트만**: 단순하지만 운영 SQL·다른 모듈의 실수를 막지 못합니다.
- **표시명·실명 글에도 번호 부여 / 이름 보이는 글의 글쓴이도 `글쓴이`**: 번호가 단순해지지만 방식이 바뀐 스레드에서 익명 댓글이 이름과 이어집니다.
- **댓글이 글의 방식을 따름**: 스레드 표시가 한결같지만 ADR 0020의 "쓰는 순간의 방식" 계약과 다르고, 방이 익명으로 바뀐 뒤에도 실명 댓글을 강제하게 됩니다.
- **지우면 행 삭제**: 데이터가 줄지만 답글·번호·운영 기록이 깨집니다.
- **글 쓰기마다 감사 기록**: 추적은 쉬우나 익명 작성자 확인이 사유 기록 없이 가능해집니다.
- **방장에게 숨김 권한 플래그를 응답에 싣기**: 화면이 편하지만 이번 범위(운영자 조치)에 필요 없고, 응답이 역할마다 달라집니다(C-06에서 별도 경로로).
