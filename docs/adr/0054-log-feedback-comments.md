# 0054. 로그별 피드백 댓글: 로그(entry)에 붙는 `log_comments`(쓸 때 revision 번호만 맥락으로) + 팀 안에서만 읽고(active 멤버) 쓰기(owner/editor/reviewer) + 작성자만 수정·소프트 삭제, owner만 숨김 + 보관 과제는 읽기 전용 + 공개 스냅샷·공개 DTO·검색·케이스·기여 장부 밖 + 탈퇴 때 본문을 비운 행으로 남김, migration 0049·플래그 없음

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

E-10은 DELIVERY_PLAN §4.4 P1 보완 백로그 항목입니다: "팀원만 작성·열람, 댓글은 공개 스냅샷에 들어가지 않음(공개 여부 분리), 로그 수정 버전과 무관하게 유지, 삭제는 본인·숨김은 owner". 제품 기획 §16 협업 고도화의 "로그별 피드백 댓글(공개 여부 분리)"에 해당합니다.

- T-04(ADR 0005 계열, `server/modules/logs`): 로그는 `log_entries`(식별자)와 `log_revisions`(내용, 덧쓰지 않음)로 나뉘고, 읽을 수 없는 과제·로그는 없는 것과 같은 404입니다(§8).
- 권한(§8, `@peerchive/domain` permissions): 역할은 owner/editor/reviewer/viewer, 읽기는 active 멤버 전체, 로그 작성은 owner/editor. 주석에 "reviewer는 피드백(별도 기능)만, viewer는 읽기만"이라고 이미 적혀 있습니다.
- 과제 상태 `lifecycle`(planning·active·completed·archived)은 지금까지 어떤 쓰기도 막지 않았습니다.
- 공개(ADR 0011): 공개 데이터는 `buildPublicSnapshot` 허용 목록으로만 만들고, 검색·케이스·과목 허브는 저장된 스냅샷에서 파생합니다.
- 탈퇴 정리(ADR 0016): 다른 사람이 멤버였던 과제의 로그·선언 같은 팀 기록은 남기고 users 행을 "탈퇴한 사용자"로 가명 처리하며, 남의 기록에 붙인 메모 글은 지웁니다. 막힘 Q&A(E-04, ADR 0049)는 글 행·자리를 남기고 본문만 비웁니다.
- 개인 자료 내보내기(사용자 단위 export)는 아직 없습니다.

## 결정

### 1. 데이터: 로그(entry)에 붙고 revision 번호만 맥락으로

- 새 테이블 `log_comments(id, project_id, log_entry_id, author_id, revision_no, body, status, created_at, edited_at, deleted_at, hidden_at)`, 상태 enum `log_comment_status`(`published`·`deleted`·`hidden`).
- `log_entry_id`를 가리키므로 로그를 고쳐도(새 revision) 댓글이 그대로 남습니다. `revision_no`는 쓸 때의 현재 revision(바뀌지 않음)이라 화면에 "r1에 남김"처럼 맥락만 보여 줍니다.
- `project_id`는 `(log_entry_id, project_id)` → `log_entries(id, project_id)` 복합 외래 키로 로그의 과제와 같음을 DB가 강제합니다(그 대상으로 `log_entries_id_project_key` 유니크 제약 추가). 과제 단위 정리·조회에 씁니다.
- 검사 제약: 본문은 `deleted`면 빈 문자열, 아니면 1~2000자. `deleted_at`·`hidden_at`은 상태와 짝. `revision_no >= 1`. 부분 인덱스는 없습니다.
- migration `0049_log_feedback_comments`. 생성된 SQL에서 유니크 제약 추가를 복합 외래 키보다 앞으로 옮겼습니다(빈 DB에서 순서대로 적용되도록).

### 2. 권한: 팀 안에서만

규칙은 `@peerchive/domain` `log-comments.ts`의 순수 함수입니다.

- **읽기**: 그 과제의 active 멤버 전체(로그 읽기와 같은 `loadReadableLog`, 스터디 기록의 학교 인증 조건 포함). 비멤버·나간 멤버·없는 id는 똑같이 404.
- **쓰기**: active owner/editor/reviewer. viewer는 403(읽기만). §8의 "reviewer는 피드백만"과 맞춥니다.
- **수정**: 작성자 본인, 게시 상태, 지금도 쓰기 역할일 때만. 본문이 같으면 바꾸지 않고 돌려줍니다. `edited_at`을 남겨 "수정됨"을 표시합니다(수정 이력은 남기지 않음 — 피드백 글이라 로그처럼 정정 이력을 보존할 이유가 약함).
- **삭제**: 작성자 본인(지금 역할 무관, active 멤버). 본문을 비우고 `deleted`로 바꾸며 행·자리는 남깁니다. 다시 보내면 그대로 돌려줍니다. owner도 남의 댓글을 고치거나 지울 수 없습니다.
- **숨김·숨김 해제**: active owner만(`PUT …/hidden {hidden}`). 지운 댓글은 409 `comment_deleted`. 숨긴 댓글의 본문·작성자는 작성자 본인과 owner(해제 판단용)에게만 보이고, 다른 멤버에게는 "owner가 숨긴 댓글입니다" 자리만 보입니다. 작성자는 숨긴 댓글을 지울 수 있지만 고칠 수는 없습니다.
- **보관(archived) 과제는 읽기 전용**: 새 댓글·수정은 409 `project_archived`, 삭제·숨김은 정리를 위해 허용합니다. completed(마친 과제)는 회고 피드백이 오가는 시기라 막지 않습니다. 로그 쓰기에는 이 규칙을 넓히지 않았습니다(범위 밖).
- 익명 스터디 기록(ADR 0026 부록)은 로그와 같이 작성자를 `loadMemberRefs`로 가립니다.

### 3. API

| 경로 | 누가 | 결과 |
| --- | --- | --- |
| `GET /api/v1/logs/:id/comments` | active 멤버 | `{items, canComment, archived}`, 오래된 순 최대 200개 |
| `POST /api/v1/logs/:id/comments {body}` | owner/editor/reviewer | 201 댓글. 로그 행을 잠가 로그당 200개 한도(409 `limit_reached`) |
| `PATCH /api/v1/log-comments/:id {body}` | 작성자 | 고친 댓글 |
| `DELETE /api/v1/log-comments/:id` | 작성자 | 지운 댓글(본문·작성자 null) |
| `PUT /api/v1/log-comments/:id/hidden {hidden}` | owner | 숨김·해제한 댓글 |

- 본문은 줄바꿈을 `\n`으로 맞추고 앞뒤 공백을 자른 뒤 1~2000자(422 `required`·`too_long`).
- 쓰기·수정은 사용자당 시간 30번(`log_comment` 버킷, 429).
- `LogDto.commentCount`: 게시 상태 댓글 수(접힌 상태 표시용). 본문은 로그 응답에 싣지 않습니다.
- 감사 `log_comment.create|edit|delete|hide|unhide`, 대상 `log_comment`, metadata는 `{logId}`뿐(본문 없음).
- 알림(디스코드 등)·분석 이벤트는 만들지 않았습니다.

### 4. 공개 여부 분리

- 댓글은 `buildPublicSnapshot` 허용 목록(ADR 0011)에 없고 스냅샷 원천(`SnapshotSource`)도 이 테이블을 읽지 않습니다. 공개 DTO·검색·케이스·과목 허브·포트폴리오·PDF는 저장된 스냅샷에서만 파생하므로 댓글이 닿을 경로가 없습니다.
- 기여 장부·동료평가 리포트(T-08)에도 넣지 않습니다. 피드백은 근거 기록이 아니고, 개수를 세면 "댓글 많이 단 사람"이라는 점수가 생깁니다.
- 회귀 테스트: 댓글(게시·숨김)이 있는 팀 과제로 후보를 만들어 게시한 뒤, 후보 행(스냅샷 포함)·owner 미리보기·익명 공개 응답 어디에도 댓글 본문·id·`comment` 문자열이 없음을 확인합니다.
- 개인 자료 내보내기가 생기면 본인이 쓴 댓글만 넣을 수 있습니다(지금은 해당 기능 없음).

### 5. 탈퇴 정리

- 탈퇴한 사람의 댓글은 팀 기록 규칙(ADR 0016)에 맞춰 **행·자리는 남기고 본문을 비워** `deleted`로 바꿉니다(숨김 표시도 지움). 작성자 칸은 가명 처리된 users를 가리킵니다. 삭제 장부 `log_comments`.
- 혼자만 쓴 과제를 지울 때는 로그보다 먼저 그 과제의 댓글 행을 지웁니다.

### 6. 화면

- 과제 화면 타임라인의 로그마다 "피드백 댓글 N개" 버튼(`aria-expanded`). 펼치면 그때 불러오고(`LogComments.vue`), "팀원만 볼 수 있고 공개 페이지·검색에는 실리지 않습니다." 안내, 오래된 순 목록, 작성자·시각·"rN에 남김"(지금 revision과 다를 때)·"수정됨", 서버 플래그에 따라 수정·삭제·숨기기/숨김 풀기 버튼.
- 입력란 "피드백 남기기"와 "댓글 남기기". 결과는 role=status, 오류는 role=alert. viewer·보관 과제는 이유를 적은 읽기 전용 안내만 보입니다.
- 삭제는 본문만 비우는 소프트 삭제라 확인 창 없이 처리합니다.

## 결과

- 팀원은 로그를 고쳐도 사라지지 않는 피드백을 로그 옆에 남기고, 공개 페이지에는 아무 흔적도 생기지 않습니다.
- 테스트: domain 단위 `log-comments.test.ts`(역할별 읽기·쓰기, 보관 과제, 작성자 수정·삭제, owner 숨김, 본문 보임 판정), web 통합 `log-comments.integration.test.ts`(viewer 403·비멤버·나간 멤버 404, 검증·시간 한도, revision 뒤 유지와 revision 번호, 작성자 수정·소프트 삭제·owner 숨김/해제와 감사 metadata, 보관 과제, 공개 제외 회귀), worker `ops-purge.test.ts`(본문 비운 행 유지·혼자 과제 행 삭제·재적용 없음), e2e `e10-log-comments.spec.ts`(reviewer가 펼쳐 남기고 owner가 보며 팀 밖 사용자 404).
- 한계: 수정 이력·답글(중첩)·멘션·알림·실시간 갱신은 없습니다. 운영자 신고 경로에 넣지 않았습니다(팀 안 글이라 owner 숨김으로 처리, 필요하면 후속). 로그당 200개 이후는 받지 않습니다.

## 대안

- **revision에 댓글을 붙임**: 고칠 때마다 피드백이 이전 버전에 묻혀 "로그 수정과 무관하게 유지" 조건을 어깁니다. revision 번호만 맥락으로 남겼습니다.
- **viewer도 쓰기 허용**: "팀원 누구나"에 더 가깝지만 §8의 viewer 읽기 전용 원칙과 어긋납니다. 피드백 역할은 reviewer로 줍니다.
- **삭제 때 행을 지움**: 스레드의 앞뒤 맥락("위 의견에 동의")이 깨집니다. 본문만 비우고 자리를 남겼습니다(E-04와 같은 규칙).
- **owner가 남의 댓글을 지움**: 숨김으로 충분하고 되돌릴 수 있습니다. 지우기는 작성자 권리로 둡니다.
- **보관 과제도 모두 허용 / 모두 막기**: 보관은 "더 쓰지 않음"의 표시라 새 글·수정은 막되, 문제가 된 글을 치울 수 있도록 삭제·숨김은 남겼습니다.
- **댓글 수를 기여 장부에 넣기**: 피드백 양이 점수처럼 읽히고 근거 기록과 섞입니다.
