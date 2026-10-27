# 0025. 아카이브로 옮기기·채택된 답변·막힘 Q&A: 요청 때 얼린 스냅샷 + 해시에 묶인 동의 + 커뮤니티 → 아카이브 한 방향 복사(아카이브 테이블은 커뮤니티를 가리키지 않음) + 동의 중 답한 사람 익명 + 당사자 누구나 즉시 철회

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-09는 DELIVERY_PLAN §4.1 "질문·채택 답변 → 막힘 로그·Q&A, 조언 글 → 선배 노트. 관련자 동의 전 복사 없음, 이름 표시 방식 재선택, 원 글 열람 범위 유지"입니다. 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.9.8: 질문 게시판의 질문과 답 → 막힘 로그(🧱) 또는 막힘 Q&A(질문자와 채택된 답변자 동의, 옮길 때 이름 표시 방식을 다시 고름), 선배의 조언 글 → 선배 노트(§8.3, 작성자 동의·과목 연결). "커뮤니티에서 아카이브로 옮기는 것은 언제나 작성자의 선택이며, 커뮤니티 글이 자동으로 공개 아카이브나 검색엔진에 노출되지 않습니다."
- §8.5 막힘 Q&A(P1): T-13은 공개 막힘 로그에 질문을 다는 Q&A를 만들지 않았습니다(ADR 0013 "막힘 Q&A는 P1이라 뺌"). 이번 C-09는 그 자리에 **커뮤니티에서 옮겨 온 질문·답 묶음**을 과목 허브의 "막힘 Q&A"로 둡니다(공개 사례 막힘 카드에 직접 질문을 다는 흐름은 여전히 없음).
- SYSTEM_DESIGN §6.7 ArchiveTransfer(source_type post/comment, target_type log_entry/question/senior_note, required_consents[], chosen_name_mode, status awaiting_consent/done/cancelled, 모든 동의가 모이면 복사본, 원 글은 남음, 이름 표시 재선택), §8.2 "ArchiveTransfer로 만든 복사본만 아카이브 규칙을 따르며 원 글의 열람 범위는 바뀌지 않음", §8.3 "원 글과 복사본의 연결은 공개 DTO에 싣지 않음", §9 `POST /community/posts/:id/archive-transfers`·`POST /archive-transfers/:id/consents`.
- ADR 0013(과목 허브: 공개 읽기는 같은 쿼리에서 상태 확인, 검색은 파생 데이터), 0016(탈퇴 정리·분석 허용 목록), 0018(허브 작성은 그 과목 학교 인증), 0019–0024(커뮤니티: 커뮤니티 테이블은 커뮤니티 모듈만, 공개 읽기 경로는 커뮤니티 테이블을 읽지 않음, 작성 시점 이름 고정, 익명 작성자 비노출, 운영 조치·신고 누적 숨김).

## 결정

### 채택된 답변 (결정)

- `community_posts.accepted_comment_id`(이 글의 최상위 댓글, 서비스가 확인). **질문 게시판(board kind `question`)의 글쓴이만** 고르고 바꾸고 풉니다(게시 중인 글·active 공간·게시 중인 최상위 댓글). `PUT|DELETE /community/posts/:id/accepted-answer`. 글의 version은 올리지 않습니다(내용 변경이 아님).
- C-04 고정 열 트리거(`community_frozen_columns_guard`, migration 0020)는 name_mode·author_id·space_id·board_id만 막으므로 **트리거를 바꾸지 않았습니다**(새 열은 막히지 않음, 통합 테스트로 확인).
- 응답: 댓글 DTO에 `accepted`(작성자 표시는 그대로 — 익명이면 `익명N`), 글 DTO에 `acceptedCommentId`(게시 중일 때만)·`canAccept`. 채택을 바꾸거나 풀면 이전 답변을 옮기던 진행 중 요청은 `answer_changed`로 취소됩니다.
- 자기 댓글도 채택할 수 있습니다(스스로 해결한 질문). 그때 막힘 Q&A는 동의 한 번이고 답변 이름도 질문자가 고른 이름입니다.

### 테이블 (migration `0023_archive_transfers`)

| 테이블 | 구역 | 내용 |
|---|---|---|
| `archive_transfers` | **커뮤니티**(C-05 경계 검사가 자동으로 덮음) | target(`course_qa`/`stuck_log`/`senior_note`), status(`awaiting_consent`/`done`/`cancelled`), 원 글·답변·공간, 요청한 사람, 정본 과목(Q&A·노트)·과제·막힘 시간(로그), **snapshot**(요청 때 얼린 글, 끝나거나 취소되면 null), content_hash, cancel_reason, expires_at(14일), 결과 id(course_qa_item_id·senior_note_id·stuck_log_id·solution_log_id). 같은 글·대상의 진행 중 요청은 하나(부분 unique, 조건은 enum 리터럴 대신 닫힌 시각 열) |
| `archive_transfer_consents` | 커뮤니티 | 요청에 필요한 사람마다 한 행(role asker/answerer/author, status pending/granted/declined, 동의한 해시, 막힘 Q&A에 쓸 자기 이름 display_mode·display_label). 요청한 사람의 행은 요청 때 granted |
| `course_qa_items` | **과목 허브(아카이브)** | 정본 과목, 복사한 질문 제목·본문·답변, 각자 고른 이름(asker_label·answerer_label + 익명 여부), 당사자 id(철회 권한·운영 안내·탈퇴 정리용, 공개 응답에 없음), status published/withdrawn/hidden, **transfer_id(불투명 uuid, 외래 키 없음)** |

그 밖에 `community_posts.accepted_comment_id`, `community_notices.archive_transfer_id`(+ 요청·종류·사람마다 한 행), `search_documents.course_qa_item_id`(kind `qa`), `usefulness_signals.course_qa_item_id`(target_kind `course_qa`), `reports`·`moderation_actions.course_qa_item_id`, enum 값(report_target_type `course_qa`, moderation_action_kind `hide_qa`, 알림 3종, 분석 3종). 새 enum 값은 DDL에서 리터럴로 쓰지 않습니다(`::text` 비교, 부분 인덱스 조건은 열로) — 처음부터 migration을 한 트랜잭션에서 돌리는 E2E DB에서도 적용됩니다.

### 커뮤니티 ↔ 아카이브 경계 (결정)

- **방향은 커뮤니티 → 아카이브뿐**입니다. 커뮤니티 모듈(`community/archive-transfers.ts`)이 커뮤니티 행을 읽어 **복사한 글**과 고른 이름만 아카이브 쪽 서비스(`course-hub/course-qa.ts`의 `createCourseQaItemInTx`, `course-hub/senior-notes.ts`의 `createSeniorNoteDraftFromTransfer`, `logs`의 `insertLog`)에 넘깁니다. 커뮤니티 행 → 아카이브 행 외래 키(`archive_transfers.course_qa_item_id` 등)는 있지만, **아카이브 테이블은 커뮤니티 테이블을 가리키지 않습니다**(`course_qa_items`에는 transfer_id를 불투명 값으로만 둠).
- 그래서 공개 읽기(과목 허브·검색·신호·신고 대상 확인·운영자 신고 상세)는 `course_qa_items`만 읽고, 커뮤니티 테이블과 조인할 길이 없습니다. C-05 경계 검사(course-hub·publication·worker 파생 handler는 커뮤니티 모듈·테이블 이름을 쓰지 않음)를 그대로 통과하고, 테스트에 더했습니다: `course_qa_items`는 커뮤니티 구역 밖·schema 선언에 커뮤니티 테이블 참조 없음(소스), `course_qa_items`·`search_documents`·`usefulness_signals`·`senior_notes`·`log_entries`·`log_revisions`에서 커뮤니티 테이블로 가는 외래 키 0개(DB).
- 원 글은 커뮤니티에 그대로 남고 열람 범위도 바뀌지 않습니다. 원 글을 읽을 수 있는 사람에게는 지금 공개된 복사본(게시 중인 막힘 Q&A·게시된 선배 노트)이 있을 때 **"아카이브로 옮겨짐" 표시만** 보입니다(링크·과목·동의한 사람 없음). 반대 방향(허브 → 원 글) 링크는 어디에도 없습니다.

### 옮길 곳 (결정)

| target | 원본 | 필요한 동의 | 결과 | 이름 |
|---|---|---|---|---|
| `course_qa` | 질문 게시판 글 + 게시 중인 채택된 답변(요청한 사람 = 질문한 사람) | 질문한 사람(요청 = 동의) + 답한 사람(같은 사람이면 한 번) | `course_qa_items` 공개 행(동의가 모이는 순간 게시) | 각자: 익명("질문한 학생"/"답한 학생") / 계정 표시명 / 실명(계정에 실명을 넣은 사람만) |
| `stuck_log` | 질문 게시판 글(+ 선택: 채택된 답변) | 질문한 사람(+ 답변을 넣으면 답한 사람) | 질문한 사람이 **owner·editor인 비공개 과제**에 🧱 막힘 로그(제목→증상, 본문→본문, 막힘 시간은 고름) + 💡 해결 로그(답변→해결 방법, 해결 대상 = 그 막힘, "과제 답 자체가 아님" 확인 필수). 작성자는 질문한 사람 | 공개되지 않으므로 고르지 않음. 답한 사람에게는 과제 이름을 보이지 않음 |
| `senior_note` | 내가 쓴 글(어느 게시판이든) | 작성자(요청 = 동의) | 선배 노트 **초안**(본문을 고른 질문 하나의 답으로, 1000자 이하) | 선배 노트 방식(계정 이름/표시명/익명) 중 다시 고름 |

- 막힘 Q&A와 선배 노트는 **과목 고르기 필수**: 원 글 공간에 학교가 있으면 그 학교(정본)의 과목만(422 `courseId: other_school`), 학교 없는 방은 제한 없음. 과목은 정본으로 저장하고, 과목 병합 때 `course_qa_items`도 정본으로 옮깁니다(감사 `courseQaRehomed`).
- **허브 작성 자격(ADR 0018)은 요청한 사람에게** 적용합니다(그 과목 학교의 active 인증, 403 `hub_write_not_allowed` + `requirement: 'school_affiliation'`). 동의가 모일 때 다시 보고, 그사이 자격을 잃었으면 `target_unavailable`로 취소합니다. 답한 사람에게는 인증을 요구하지 않습니다(원 글 공간을 읽을 수 있어야 동의 화면을 봄).
- 선배 노트는 기존 노트 절차를 그대로 탑니다: 작성 자격·만들기 한도(시간당 5)·과목당 3개·"정답·답안·교수 개인 평가 없음" 확인. 옮긴 초안은 답이 하나뿐일 수 있으므로 **게시 때 답 2개 이상을 다시 확인**합니다(422 `answers: too_few`, 기존 노트는 이미 2개 이상이라 영향 없음). 게시는 기존 점검·확인(409 `checks_unconfirmed`)을 거칩니다.
- 막힘 Q&A는 요청 때 공개 전 점검 규칙(`runPublicationChecks`: 전화·메일·주민번호·학번·사설 URL·긴 코드)을 복사할 질문 제목·본문·답변에 돌려 경고가 있으면 확인(`confirmWarnings`) 없이는 409 `checks_unconfirmed`(+가린 표본)이고, **답한 사람의 동의 화면에도 같은 경고**가 보입니다.
- 공개 중(published·hidden)인 막힘 Q&A가 있는 글은 다시 막힘 Q&A로 옮기지 않습니다(409 `already_transferred`). 철회하면 다시 요청할 수 있습니다.

### 동의·해시·편집 (결정: 스냅샷을 얼림)

- **요청 때 복사할 글을 스냅샷으로 얼립니다**(`{questionTitle, questionBody, answerBody}`). 원 글·답변을 그 뒤에 고쳐도 스냅샷은 바뀌지 않고, 동의 화면은 스냅샷을 그대로 보여 주며 복사본도 스냅샷입니다(테스트로 확인). 고친 내용을 옮기려면 취소하고 다시 요청합니다.
  - "고치면 동의 초기화(stale)" 대신 얼리기를 고른 이유: 답한 사람이 동의하는 화면과 실제 복사본이 언제나 같아지고, 질문한 사람이 답한 사람의 동의 뒤에 글을 바꿔 다른 내용을 옮기는 길이 없습니다. 대가는 동의를 기다리는 동안 커뮤니티 구역(archive_transfers)에 글 사본이 하나 더 있는 것이고, 끝나거나 취소되면 바로 지웁니다.
- 동의는 **content_hash**(= SHA-256(canonicalJson({v, target, courseId, 스냅샷 글, 질문한 사람이 고른 이름})), T-11 manifest와 같은 방식)에 묶입니다. 동의 요청은 화면에서 받은 해시를 그대로 돌려보내야 하고 다르면 409 `stale_content`. 복사 직전에 모든 동의 행의 해시가 요청의 해시와 같은지 다시 확인합니다(`evaluateConsents` = complete). 과제 id는 해시에 넣지 않습니다(답한 사람에게 보여 줄 값만).
- 복사 직전 확인: 원 글·답변이 지금도 게시 중(아니면 `source_unavailable`), 채택된 답변이 그대로(아니면 `answer_changed`), 막힘 Q&A는 요청한 사람의 허브 작성 자격, 막힘 로그는 질문한 사람이 지금도 그 과제의 owner·editor(아니면 `target_unavailable`). 모두 같은 트랜잭션에서 복사본을 만들고 done + 스냅샷 삭제.
- 닫힘: 누구든 거절하면 `declined`(사유 없음), 요청한 사람의 취소 `cancelled_by_initiator`, **14일**이 지나면 `expired`(읽거나 쓸 때 닫음 — 주기 작업 없음, 만료된 요청은 동의할 수 없음), 원 글·답변 삭제·운영 조치·신고 누적 임시 숨김·방 운영진 가리기는 같은 트랜잭션에서 `source_unavailable`, 탈퇴 정리 `account_deleted`. 닫히면 스냅샷 글을 지우고 당사자에게 취소 알림(행위자 본인 제외).

### 동의 중 답한 사람 익명 (결정)

- 동의 요청은 답한 사람에게 **커뮤니티 알림**(`archive_consent_requested`, payload는 옮길 곳 종류만)으로 갑니다. 알림·요청 화면(`/community/archive-transfers/:id`)은 원 글 공간을 지금 읽을 수 있는 당사자에게만(아니면 404).
- 요청한 사람의 응답(글 DTO의 요청 요약·요청 상세·선택지·내 막힘 Q&A 목록)에는 답한 사람의 id·이메일·핸들·이름·고른 이름이 없고, `counterpart: {status, text}`("답변자 동의 대기 중/동의함/거절함")만 있습니다. 게시된 뒤에는 답한 사람이 **고른 이름만** 공개됩니다(익명이면 "답한 학생"). 테스트가 요청한 사람의 모든 응답 JSON에 답한 사람 식별자가 없음을 확인합니다.
- 답한 사람에게는 옮겨질 글 그대로와 질문한 사람이 고른 이름(공개될 값), 경고가 보입니다. 질문한 사람의 과제 이름은 보이지 않습니다.
- 감사 기록: 커뮤니티 쪽 요청·동의·취소는 감사 행을 남기지 않습니다(글쓴이 id와 글 id를 한 행에 남기지 않는 C-04 원칙). 아카이브 쪽은 `course_qa.publish`(행위자 없이 과목 id만)·`course_qa.withdraw`(철회한 사람 + role)·`senior_note.create`(`transferred: true`).

### 공개 읽기·검색·신호 (결정)

- 과목 허브 `GET /public/courses/:id`에 `qaItems`(published만, 같은 쿼리에서 상태 확인, 최대 50개, 최근 순). DTO는 `{id, questionTitle, questionBody, answerBody, asker, askerAnonymous, answerer, answererAnonymous, publishedAt, signals}`뿐 — 사람 id·transfer id·원 글·공간 정보 없음.
- 검색: `search_documents` kind `qa`(질문 제목·본문·답변만 색인, 이름은 색인하지 않음). worker가 outbox `course_qa.published`(지금 published일 때만 색인)·`course_qa.withdrawn`(지금 published가 아니면 문서·신호 삭제)를 처리하고, 운영 조치 `moderation.action`(hide_qa: 문서 삭제, 되돌림: 다시 색인)도 맞춥니다. **읽기는 문서를 믿지 않습니다**: `GET /public/search`는 항목과 조인해 `status = 'published'`일 때만 보여 주므로 정리가 늦어 문서가 남아도 철회·숨김된 Q&A는 나오지 않습니다(테스트). 막힘 Q&A 큐는 선배 노트처럼 전용 큐입니다(공개 사례 철회용 정리 handler 등록 구조는 publication 이벤트 전용이라).
- 유용성 신호: target `course_qa`(`{kind: 'course_qa', qaId}`), "나도 여기서 막혔어요"·"도움됐어요" 둘 다, 항목별 개수만(작성자별 합계 없음), 지금 published일 때만 남길 수 있음.

### 철회 (결정)

- `POST /course-qa/:id/withdraw`: **질문한 사람·답한 사람 누구나 언제든**(운영 조치로 숨겨진 상태에서도). 커밋 즉시 허브·검색·신호에서 빠지고(읽기가 status를 봄) 원 글의 "옮겨짐" 표시도 사라집니다. 상대에게 따로 알리지 않습니다(목록에서 철회됨으로 봄). 이미 철회했으면 200. 당사자가 아니면 404. `GET /me/course-qa`(화면 `/me/course-qa`)·요청 화면에서 철회합니다.

### 운영 조치·신고 (결정)

- 막힘 Q&A는 공개 신고 대상 `course_qa {qaId}`(게시 중인 것만, 로그인한 누구나) + 조치 `hide_qa`(published → hidden, 되돌리면 hidden → published — 그사이 당사자가 철회했으면 그대로 withdrawn). 운영자 신고 상세는 복사본만 보여 주고(원 글은 열지 않음) 당사자 id가 없습니다. 운영 조치 안내·이의제기의 당사자는 질문한 사람·답한 사람 둘 다입니다.
- 커뮤니티 운영 조치와의 관계: 가려진(`hidden`·`auto_hidden`)·지워진 원 글이나 답변은 옮기기를 시작할 수 없고(409 `source_not_open`·`no_accepted_answer`), 진행 중 요청은 숨기는·지우는 트랜잭션에서 취소됩니다. 이미 옮겨진 복사본은 원 글이 나중에 가려져도 자동으로 내리지 않습니다(복사본은 두 사람이 동의한 별개의 아카이브 글이고, 문제가 있으면 복사본을 신고해 hide_qa로 처리).
- 이용 제한(C-06) 중인 사람은 옮기기를 시작할 수 없습니다(403 `write_restricted`). 동의·거절·철회는 막지 않습니다(자기 글을 거두는 일).

### 탈퇴 정리 (결정: 당사자 한 명이 탈퇴하면 그 막힘 Q&A를 내림)

- 그 사람이 요청했거나 동의해야 하는 진행 중 요청은 `account_deleted`로 취소(스냅샷 삭제, 남은 당사자에게 취소 알림).
- 그 사람이 **요청한** 옮기기 행(모든 상태)은 동의 행·알림과 함께 지웁니다(그 사람의 기록이고, 복사본인 과제 로그·선배 노트 초안이 정리될 때 외래 키가 막지 않게). 남의 요청에 남은 그 사람의 동의 행은 고른 이름만 비웁니다.
- 그 사람이 질문했거나 답한 막힘 Q&A는 **철회(withdrawn, withdrawn_by `account_deleted`) + 질문·답변 글을 모두 비움**, 그 사람 칸은 null·이름은 "탈퇴한 사용자", 검색 문서·신호 삭제. 상대의 글만 남기는 대신 항목 전체를 내린 이유: 질문 없는 답(또는 답 없는 질문)은 막힘 Q&A로 성립하지 않고, 남은 글에 탈퇴한 사람의 질문·답 맥락이 그대로 남기 때문입니다. 신고·조치가 가리킬 수 있어 행은 남깁니다.
- 장부 종류: `archive_transfers_cancelled`·`archive_transfers`·`archive_transfer_consent_labels`·`course_qa_items`. 질문한 사람의 과제에 복사된 해결 로그는 질문한 사람의 과제 기록으로 남습니다(답한 사람이 동의해 복사한 사본, 팀 기록 규칙과 같음).

### 분석·로그

- 분석: `archive_transfer_requested {target}`·`archive_transfer_completed {target}`·`course_qa_published {}` — 사용자 키 없이(unlinked), 글·과목·사람 id·고른 이름 없음(허용 목록·C-05 테스트가 거부). 유용성 신호의 `target`에 `course_qa`.
- 커뮤니티 모듈은 서버 로그를 남기지 않습니다(C-05).

### 화면

- 글 화면(`/community/p/:id`): 채택된 답변 표시·"이 답변 채택"/"채택 풀기"(글쓴이), "아카이브로 옮겨짐" 표시, 내가 요청했거나 동의를 요청받은 요청 목록, 글쓴이의 "아카이브로 옮기기" 폼(옮길 곳 고르기·막는 이유, 과목 찾기, 내 이름 다시 고르기와 "이름을 고르면 원 글을 읽는 사람은 같은 글임을 알아볼 수 있음" 안내, 경고 확인, 과제·막힘 시간, 선배 노트 질문·표시·확인).
- 요청 화면(`/community/archive-transfers/:id`, `useCommunityPage` 고정 제목·noindex): 동의할 사람에게 옮겨질 글 그대로·경고·내 이름 고르기·동의/거절, 요청한 사람에게 상대 상태·취소, 끝나면 공개 상태·철회. 알림 화면에서 이 화면으로 갑니다.
- 과목 허브(`/c/:id`): "막힘 Q&A" 구역(Q·A와 고른 이름, 신호, 신고). `/me/course-qa`: 내 막힘 Q&A와 철회. 옮긴 선배 노트 초안은 기존 `/senior-notes?course=`에서 고치고 게시합니다. 360px에서 가로 스크롤 없음(E2E).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `PUT /community/posts/:id/accepted-answer {commentId}` | 200 스레드 | 401, 403 `not_author`, 404, 409 `not_question_board`·`not_open`·`space_not_active`·`comment_not_open`, 422 `commentId: invalid\|not_top_level` |
| `DELETE /community/posts/:id/accepted-answer` | 200 스레드 | 401, 403 `not_author`, 404, 409 `not_question_board`·`not_open` |
| `GET /community/posts/:id/archive-options` | 200 | 401, 403 `not_author`, 404 |
| `POST /community/posts/:id/archive-transfers` | **201** 요청(done이면 결과 포함) | 401, 403 `not_author`·`hub_write_not_allowed`(+requirement·schoolId)·`write_restricted`, 404, 409 `source_not_open`·`not_question_board`·`no_accepted_answer`·`transfer_pending`·`already_transferred`·`space_not_active`·`checks_unconfirmed`(+warnings)·`limit_reached`, 413, 422 `courseId: required\|not_found\|other_school`·`projectId: required\|not_found\|not_writable`·`displayMode: required\|invalid\|real_name_required\|display_name_missing`·`timeBucket`·`notAnswerConfirmed`·`answerKey`·`noAnswersConfirmed: confirm_required`·`source: too_long`, 429 |
| `GET /community/archive-transfers/:id` | 200 | 401, 404 |
| `POST /community/archive-transfers/:id/consents {decision, contentHash?, displayMode?}` | 200 | 401, 404, 409 `not_pending`·`already_decided`·`stale_content`, 422 |
| `POST /community/archive-transfers/:id/cancel` | 200 | 401, 404, 409 `not_pending` |
| `GET /me/course-qa` | 200 | 401 |
| `POST /course-qa/:id/withdraw` | 200(이미 철회 200) | 401, 403(CSRF), 404 |
| `POST /senior-notes/:id/publish` | 200 | 기존 + 422 `answers: too_few`(옮긴 초안의 답이 2개 미만) |
| `PUT\|DELETE /signals {target: {kind: 'course_qa', qaId}}` | 200 | 404(published 아님), 422 |
| `GET /public/search?type=qa` | 200 | 기존과 같음 |
| `POST /reports {targetType: course_qa, targetRef: {qaId}}` | 201/200 | 404(게시 중 아님), 422 |
| `POST /operator/reports/:id/resolve {action: hide_qa}` | 200 | 409 `target_not_public` |

## 결과

- 커뮤니티 글이 아카이브로 가는 길은 이 한 경로(동의가 모인 트랜잭션)뿐이고, 공개 읽기는 여전히 커뮤니티 테이블을 모릅니다. C-05 센티넬 검사를 넓혀, 옮기지 않은(또는 거절된) 질문·답의 글은 커뮤니티 밖 어느 테이블에도 없고, 옮긴 글은 `course_qa_items`와 그 파생 검색 문서에만 있음을 확인합니다.
- 동의 화면 = 복사본(얼린 스냅샷 + 해시)이라 "무엇에 동의했는가"가 분명합니다. 대가로 고친 원 글을 옮기려면 다시 요청해야 합니다.
- 한계: 페르소나(S-01, SYSTEM_DESIGN §6.7.1 persona_id)가 없어 복사본 이름은 계정 표시명·실명의 **그때 값의 사본**입니다(나중에 표시명을 바꿔도 복사본은 그대로, 페르소나 열은 S-01에서 더함). 만료는 주기 작업 없이 읽거나 쓸 때 닫습니다(알림은 그때 감). 막힘 Q&A에는 추가 질문·답·스레드가 없고(복사본 하나), 공개 사례 막힘 카드에 직접 질문을 다는 §8.5 흐름도 없습니다. 원 글을 나중에 가려도 복사본은 자동으로 내리지 않습니다(신고로 처리). 동의 요청은 화면 알림뿐(메일·푸시 없음). 질문한 사람의 과제에 복사된 해결 로그는 답한 사람이 탈퇴해도 남습니다. 답 하나만 채택할 수 있고, 질문 게시판이 아닌 글의 댓글은 옮기지 않습니다.

## 대안

- **원 글을 가리키는 공개 행(포인터)**: 복사가 필요 없지만 공개 읽기가 커뮤니티 테이블을 읽게 되어 §8.2·C-05 경계를 깨고, 원 글을 고치면 공개 내용이 바뀝니다.
- **원 글을 고치면 동의 초기화(stale_content)**: 최신 글을 옮기지만, 답한 사람이 본 글과 복사본이 어긋날 틈(고친 직후 동의)이 생기고 매 편집마다 다시 동의를 받아야 합니다.
- **아카이브 행에 transfer 외래 키**: 추적은 쉽지만 아카이브 테이블이 커뮤니티 구역을 가리키게 되어(외래 키 조인 경로) 경계 검사가 막으려는 모양이 됩니다. 불투명 transfer_id + 커뮤니티 쪽 외래 키로 대신했습니다.
- **요청한 사람에게 답한 사람의 고른 이름 미리 보여 주기**: 편하지만 표시명을 고르면 동의 과정에서 신원이 드러납니다(게시 뒤 공개 이름으로만 봄).
- **탈퇴한 당사자의 글만 비우고 상대의 글은 남기기**: 상대의 기여는 남지만 질문·답이 짝을 잃고 탈퇴한 사람의 맥락이 남습니다.
- **만료 주기 작업(worker)**: 정확한 시각에 닫히지만 worker가 커뮤니티 테이블을 더 읽어야 합니다(경계 예외 증가). 읽기·쓰기 때 닫는 것으로 충분합니다.
