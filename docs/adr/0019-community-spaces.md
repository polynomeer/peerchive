# 0019. 커뮤니티 공간·게시판·멤버십·가입 방식: 별도 community 모듈 + 학교 인증에서 파생하는 공식 페이지 자격 + 정책 함수 한 곳 + 운영자만 여는 공식 페이지

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-02는 캠퍼스 커뮤니티의 뼈대입니다(DELIVERY_PLAN §4.1 "공식 페이지는 운영자만 개설, 개설 요청 집계(기준 10명·학생회), 예약어 이름 거부, 정원 300, 방장 승계·보관"). 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.9.2(공간 종류: 공식 학교·학과 페이지, 사용자 방, 스터디 방), §8.9.3(개설 요청·`공식` 배지·익명 기본·열람 범위·기본 게시판·모더레이터), §8.9.4(사용자 방: 이름 표시 방식·학교 연결/무관·찾기·가입 방식·정원·방장 승계), §16(P1은 pilot 학교 공식 페이지 1개와 사용자 방, 공식 학과 페이지 확대는 P2).
- SYSTEM_DESIGN §6.7(CommunitySpace·SpaceMembership·Board·SpaceOpeningRequest, "커뮤니티 테이블은 공개 release 조회 경로(§11)와 섞지 않는 별도 모듈 `server/modules/community`가 소유"), §8.1(권한 표, 정책 함수 `canReadSpace`·`canWriteBoard`·`canModerate`), §8.2(학교 인증에서 파생한 열람, 로그인 전용·404, noindex), §9.1(커뮤니티 API 초안).
- ADR 0018(C-01)의 `institution_affiliations`(active 소속, 자기 신고 학과 `department_label`, 학과 테이블 없음), ADR 0010·0015(운영자에게 비공개 공간 읽기 권한이 없음), ADR 0015(신고·조치 대기열), ADR 0016(탈퇴 정리·분석 허용 목록).
- 소유자 결정(2026-10-27): P1 커뮤니티 백로그를 G3 게이트 전에 시작합니다. GC 게이트(C-05·C-06 회귀 테스트, 모더레이터·법률 검토 등)를 통과하기 전에는 커뮤니티를 실제 사용자에게 열지 않습니다.

## 결정

### 모듈 경계

- `apps/web/server/modules/community/`(access·spaces·memberships·invitations·official·reporting)만 커뮤니티 테이블을 읽고 씁니다. API는 `/api/v1/community/**`(로그인 필수)와 `/api/v1/operator/community/**`뿐이고 `/api/v1/public`에는 없습니다.
- 공개 읽기 경로(`/api/v1/public/**` 라우트, publication/public-*, course-hub의 허브·검색·공개 범위, portfolio의 공개 프로필·보기·release 범위)와 worker의 검색 색인은 커뮤니티 모듈·테이블을 참조하지 않습니다. 소스 경계 테스트(`apps/web/test/community.integration.test.ts`)가 확인하고, 통합 테스트가 커뮤니티 작업 전후로 `search_documents` 행 수가 같고 공개 검색이 방 이름(센티넬)을 찾지 못함을 확인합니다.
- 다른 모듈은 커뮤니티 데이터를 이 모듈의 함수로만 씁니다: 신고·조치(moderation)는 `community/reporting.ts`(신고 대상 판정·이름·당사자·운영자용 공간 정보)와 `community/official.ts`의 `restrictSpaceInTx`·`liftSpaceRestrictionInTx`를 부릅니다. 예외 둘: 당사자 안내 목록의 SQL 조건(notices.ts의 `affectedSql`, 방 owner 조건 한 줄)과 worker 탈퇴 정리(웹 모듈을 import할 수 없음, 같은 도메인 함수 `chooseOwnerSuccessor`를 씀).
- 권한 판정은 모두 `@peerchive/domain`의 순수 함수(`canReadSpace`·`canPreviewSpace`·`canJoinSpace`·`canWriteBoard`·`canModerate`·`canManageSpace`·`canCreateRoom`·`chooseOwnerSuccessor`)를 거칩니다. C-04(글)·C-06(제재)·worker·알림도 같은 함수를 씁니다.

### 테이블 (migration `0017_community_spaces`)

- `community_spaces`: `kind`(official_school/official_department/user_room/study_room), `school_id?`, `department_label?`·`department_key?`(학과 페이지만), `linked_course_id?`, `name`, `description?`, `slug`(unique), `current_name_mode`(real/display/anonymous), `discovery`(listed/unlisted), `join_policy`(open/approval/invite), `capacity`, `capacity_requested?`, `status`(active/archived/restricted), `created_by`, `archived_at`, `restricted_at`. 학교마다 공식 학교 페이지 하나, (학교, 학과 키)마다 공식 학과 페이지 하나(부분 unique). DB check로 공식 페이지는 `school_id` 필수·`anonymous` 고정.
- `space_memberships`: `(space_id, user_id)` unique, `role`(owner/admin/moderator/member), `status`(pending/active/left/removed), `joined_at`(승계 순서), `requested_at`, `ended_at`. 공간마다 active owner 하나(부분 unique).
- `boards`: `kind`(free/freshmen/alumni/question/info/recruiting/notice/general), `title`(공간 안 unique), `write_role`(member/moderator), `position`. DB check로 notice는 항상 moderator.
- `space_invitations`: SHA-256 토큰 해시만, 7일, 한 번만(`used_at`·`used_by`), 취소(`revoked_at`). 과제 초대(T-03)와 같은 규칙.
- `official_page_requests`: `(school_id, department_key, requester_id)` unique(학교 페이지는 `department_key = ''`), `source`(student/student_council), `source_marked_by`.
- 신고 대상 `community_space`(`reports.community_space_id`)와 조치 `restrict_space`(`moderation_actions.community_space_id`), 분석 이벤트 `space_created`·`space_joined`. 같은 migration에서 더한 enum 값을 check에 쓰면 PostgreSQL이 거부하므로("unsafe use of new value") 그 check는 `::text`로 비교합니다.
- `slug`는 CSPRNG 소문자·숫자 10자입니다. 이름(한국어)을 주소에 넣지 않고, unlisted 방에서는 추측하기 어려운 링크 역할을 합니다.

### 공간 종류와 자격

| | 만드는 사람 | 읽기 | 쓰기(canWriteBoard) | 멤버십 |
|---|---|---|---|---|
| 공식 학교 페이지 | 운영자만 | 그 학교(정본) active 인증 · 운영자 | 그 학교 인증(학과 쓰기 제한 `removed`가 없을 것) | 모더레이터 지정·쓰기 제한에만 |
| 공식 학과 페이지 | 운영자만 | 그 학교 active 인증 | 자기 신고 학과 키가 같은 그 학교 인증 | 같음 |
| 사용자 방 | active 학교 인증이 하나 이상인 사람 | active 멤버만 | active 멤버 | 가입 방식에 따름 |
| 스터디 방 | 내부 서비스만(C-07 모집 마감) | active 멤버만 | active 멤버 | 초대로만 |

- **공식 페이지 자격은 멤버십이 아니라 학교 인증에서 나옵니다**(SYSTEM_DESIGN §6.7). 인증이 해제·취소되면 다음 요청부터 404입니다(모더레이터 멤버십이 있어도). 공식 페이지에는 가입·초대·멤버 목록이 없습니다(409 `not_joinable`·`no_member_list`).
- `notice` 게시판·`write_role = moderator` 게시판은 사용자 방에서 owner·admin·moderator, 공식 페이지에서 지정된 모더레이터·운영자만 씁니다.
- **운영자에게 사용자 방의 암묵적 읽기 권한이 없습니다**(ADR 0010·0015와 같은 원칙). 운영자는 공간 정보(이름·소개·종류·상태·멤버 수)만 운영 화면·신고 상세에서 봅니다. 공식 페이지는 운영자가 개설·운영하므로 읽고 관리합니다(§8.1 표).
- `communityWriteSuspended`(C-06 CommunitySanction)는 `CommunityViewer`에 자리만 있고 지금은 항상 false입니다.

### 학교 연결과 사용자 방 자격 (결정)

- §8.9.4의 "학교 연결 / 학교 무관"을 그대로 둡니다. **학교를 연결한 방은 그 학교(정본) active 인증 계정만** 소개를 보고 들어오며(초대를 받아도 마찬가지, 404), **학교 무관 방은 어떤 학교든 active 인증이 하나 있으면** 들어옵니다.
- 방 만들기에도 active 학교 인증이 하나 이상 필요합니다(403 `affiliation_required` + `requirement: school_affiliation`). §8.9.2는 "로그인한 누구나"이지만, 캠퍼스 커뮤니티의 사칭·스팸 위험(DELIVERY_PLAN §9.1)을 줄이고 학교 무관 방의 가입 자격과 맞추기 위해 인증을 요구합니다. 하루 10개 한도(429).
- 학교 id는 정본으로 비교합니다(공간·소속이 병합 전 학교를 가리켜도 `coalesce(merged_into, id)`). 학교 병합은 커뮤니티 행을 옮기지 않습니다(읽기가 정본을 따라감). 두 학교에 각각 공식 페이지가 있었다면 병합 뒤 둘 다 보이며, 운영자가 하나를 보관합니다(한계).

### 공식 학과 페이지와 자유 글 학과 (결정)

- C-01의 학과는 자기 신고 자유 글이고 학과 테이블이 없습니다. 학과 페이지는 운영자가 정한 `department_label`과 그 `labelKey`(NFKC·소문자·공백·구두점 제거, `department_key`)를 저장하고, **사용자의 active 소속 `department_label`의 같은 키**가 일치하면 그 학과로 봅니다("컴퓨터 공학과" = "컴퓨터공학과"). 표기가 다른 학생("컴공")은 학교 인증 화면에서 학과 이름을 페이지 표기에 맞춰 고치면 됩니다.
- 학과 테이블(§6.7 Department)·별칭·병합은 학과 페이지가 실제로 여럿 생기는 P2(§16 "공식 학과 페이지 확대")로 미룹니다. 학과는 메일로 확인할 수 없으므로 모더레이터의 학과 쓰기 제한(`removed` 멤버십)이 보조 장치이며, 그 조작 API는 글이 생기는 C-04/C-06에서 엽니다(대상 글로 지정, 작성자 신원 비노출).

### 가입·멤버십·승계

- `canJoinSpace(viewer, space, membership, via)`: open → active, approval → pending, invite → 403 `invite_only`(초대 링크로만). 초대 수락은 가입 방식과 무관하게 active. 정원은 active가 될 때만 셉니다(승인 때 다시 확인, 409 `space_full`).
- 멤버가 아닌 사람에게 소개(preview: 이름·소개·멤버 수·가입 방식, 게시판 없음)는 **active 사용자 방 + 학교 자격 + 초대 전용이 아님 + 내보내지지 않음**일 때만 보입니다(listed·unlisted 모두 — unlisted는 "목록에 없고 링크로만"). 그 밖의 상세는 404입니다(존재를 숨김). `discover`는 listed이고 초대 전용이 아닌 방 + 내 학교 공식 페이지만, 최대 50개.
- 승인 거절과 내보내기는 `removed`: 스스로 다시 들어올 수 없고(403 `removed`, 소개도 404) 새 초대로만 들어옵니다. 거절 사유는 남기지 않습니다.
- 역할: 설정·게시판·승인·내보내기·초대는 owner·admin, 역할 변경·보관은 owner. admin은 moderator·member만 내보냅니다. `role: owner`를 주면 소유권 이전(이전 owner는 admin).
- **방장 승계**(`chooseOwnerSuccessor`): owner가 나가거나 탈퇴 정리되면 가장 오래된(`joined_at`) active admin → 가장 오래된 다른 active 멤버(moderator 포함). 아무도 없으면 방을 보관(archived)하고 대기 요청은 left, 열린 초대는 취소합니다. 감사 `community.owner_succession`·`community.space_archive`(cause `no_successor`).
- 상태: **archived**(멤버는 읽기만, 가입·쓰기·관리 없음, 되돌리기 없음), **restricted**(운영 조치: 멤버는 읽기만, 목록·소개·가입·쓰기·관리 없음, 운영자만 해제). 관리 시도는 409 `space_not_active`.

### 이름·정원·게시판

- 예약어(`RESERVED_SPACE_NAME_WORDS`): 공식, 학생회, 총학, 총학생회, 대의원회, 운영자, 운영진, 운영팀, 관리자, 관리팀, 피어카이브, peerchive, proofu, official, admin, administrator, moderator, staff. labelKey로 비교해 띄어쓰기·대소문자·전각을 무시합니다. **`운영`만으로는 막지 않습니다**("운영체제 스터디"). **학교 이름도 막지 않습니다**("○○대 12학번 컴공 동기방"이 정상 이름), 사칭은 신고 대상입니다. 공식 페이지 이름은 운영자가 정하므로 예약어 검사를 하지 않습니다.
- 정원: 기본·최대 300. 301~2000을 요청하면 정원 300으로 만들고 `capacity_requested`에 남겨 운영자가 정합니다(`POST /operator/community/spaces/:id/capacity`). 2000을 넘는 모임은 공식 페이지로 유도합니다.
- 이름 표시 방식은 만들 때 정하고 저장만 합니다(실명 방은 가입 방식 기본값 approval). 바꾸기는 C-03(7일 예약·이후 글에만)이며 지금은 422 `nameMode: not_editable`.
- 게시판: 공식 페이지는 자유·새내기·졸업생·질문·정보·모집·공지(모더레이터 전용) 7개, 사용자 방은 `general` 하나에서 시작해 owner·admin이 general·free·question·info·recruiting·notice를 10개까지 더합니다. 공식 페이지 게시판은 운영자가 관리합니다. 글쓰기는 C-04입니다(화면은 "글쓰기는 곧 열립니다").

### 공식 페이지 개설 요청

- 그 학교 active 인증 계정이 (학교, 학과)마다 한 번 요청합니다(중복은 200 `created: false`, 이미 열렸으면 409 `official_exists` + slug). 요청자에게는 요청 수를 보여 주지 않습니다.
- **집계**: 서로 다른 요청자 중 지금 그 학교 인증이 active인 수(해제되면 빠짐). 10명 이상이거나 운영자가 어떤 요청을 학생회 요청으로 표시하면 기준 도달입니다(`officialRequestThresholdReached`). 기준에 처음 이를 때(같은 묶음 advisory lock 안에서) 감사 `community.official_request.threshold`(학교 id·학과 여부·요청자 수·학생회 여부, 요청자 id 없음)를 남기고 운영자 목록이 `thresholdReached`를 표시합니다. 수가 기준 밑으로 내려갔다가 다시 이르면 다시 남깁니다.
- **자동 개설하지 않습니다.** 운영자가 `POST /operator/community/official-pages`로 엽니다(요청 수와 무관하게 열 수 있음 — §19 "요청이 너무 적으면 pilot 학교는 운영자가 먼저 개설"). 알림은 메일·푸시가 아니라 운영 화면·감사 기록입니다(운영자 알림 채널은 C-10).

### 신고·운영 조치

- T-15 대기열을 그대로 씁니다. 신고 대상 `community_space`는 `{spaceSlug}`로 가리키고, **신고자가 그 공간을 읽거나 소개를 볼 수 있을 때만** 받습니다(아니면 404). 운영자 상세에는 공간 정보만 싣습니다(`OperatorTargetContentDto.kind = 'community_space'`).
- 조치 `restrict_space`: active → restricted(같은 트랜잭션, 이미 아니면 409 `target_not_public`), 되돌림(이의제기 reverse)은 restricted → active. 당사자(이의제기·안내)는 그 방의 active owner입니다. 신고 없이도 운영자가 `POST /operator/community/spaces/:id/restrict|lift-restriction|archive {note}`로 직접 조치하고 사유는 감사에 남습니다. 해제는 그 공간의 되돌리지 않은 restrict_space 조치를 `lift`로 표시합니다.
- 글·댓글 신고(`community_post`·`community_comment`)·자동 임시 숨김·제재는 C-06입니다.

### 탈퇴 정리·분석·검색엔진

- 탈퇴 정리(worker `ops/purge.ts`): 그 사람이 active owner인 방은 먼저 승계(없으면 보관), 그 뒤 그 사람의 멤버십 전부·그 사람이 만들었거나 쓴 초대·그 사람의 개설 요청을 지웁니다. 운영자로서 학생회 표시를 한 기록은 표시자만 지웁니다. 공간 행(`created_by`)은 가명 처리된 users 행을 가리킨 채 남습니다. 장부 종류 `space_memberships`·`space_invitations`·`official_page_requests`·`space_owner_transfers`·`spaces_archived`.
- 분석 허용 목록: `space_created { kind }`, `space_joined { kind: user_room|study_room, policy: open|approval|invite }`. 공간·학교 id·이름은 넣지 않습니다(사용자 키는 기존처럼 HMAC).
- 검색엔진: `/api/v1/community/**`의 모든 응답(오류 포함)에 `X-Robots-Tag: noindex, nofollow`·`no-store`, 세션이 없으면 handler 전에 401(`server/middleware/03.community.ts`). 화면 `/community/**`도 `noindex, nofollow`(meta + 헤더). robots.txt·사이트맵 제외·OG 미리보기 정책은 C-05에서 굳힙니다.

### 화면

- `/community`: 내 공간(공식 배지·역할), 승인 대기, 공간 찾기, 방 만들기(이름·소개·학교 연결·이름 표시 방식 설명·가입 방식·찾기·정원), 공식 페이지 개설 요청과 내 요청. 학교 인증이 없으면 인증 안내.
- `/community/s/[slug]`: 이름·`공식` 배지·이 공간의 이름 표시 방식, 게시판 목록("글쓰기는 곧 열립니다"), 가입 버튼(가입 방식별), 나가기(방장은 "방장 넘기고 나가기"), 관리자용 설정·게시판 더하기·멤버(승인·거절·역할·내보내기)·초대 링크(만든 직후 한 번만 보임)·보관.
- `/community/invite/[token]`: 토큰은 서버 렌더링에 쓰지 않고 POST 본문으로만 보냅니다(no-referrer).
- `/operator/community`: 개설 요청 묶음(학생회 표시), 공식 페이지 열기, 공간 목록과 제한·해제·보관·정원 결정.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /community/spaces/mine`, `GET /community/spaces/discover?q=` | 200 | 401, 422(q 40자) |
| `POST /community/spaces` | 201 | 401, 403 `affiliation_required`, 404(학교), 422 `name: required\|too_long\|reserved\|invalid`·`capacity`·`nameMode`, 429 |
| `GET /community/spaces/:slug` | 200(`access: member\|preview`) | 401, 404 |
| `PATCH /community/spaces/:slug` | 200 | 401, 403, 404, 409 `space_not_active`, 422 `nameMode: not_editable`·`joinPolicy`/`discovery: not_editable`(공식)·`name` |
| `POST /community/spaces/:slug/archive` | 200 | 401, 403, 404, 409 `space_not_active` |
| `POST /community/spaces/:slug/join` | 200 `{status}` | 401, 403 `invite_only`·`removed`, 404, 409 `already_member`·`already_pending`·`space_full`·`not_joinable` |
| `POST /community/spaces/:slug/leave` | 200 `{succession}` | 401, 404, 409 `not_member` |
| `GET /community/spaces/:slug/members` | 200 | 401, 403, 404, 409 `no_member_list` |
| `POST …/members/:userId/approve\|reject` | 200 | 401, 403, 404, 409 `space_not_active`·`not_pending`·`space_full` |
| `PATCH …/members/:userId {role}`, `DELETE …/members/:userId` | 200 | 401, 403, 404, 409 `self`·`use_leave`·`not_active_member`·`space_not_active`, 422 |
| `GET/POST /community/spaces/:slug/invitations`, `DELETE …/:id` | 200 / 201 | 401, 403, 404, 409 `not_joinable`·`space_not_active` |
| `POST /community/invitations/preview`, `POST /community/invitations/accept` | 200 | 401, 404(학교 자격), 409 `already_member`·`space_full`, 410 |
| `GET/POST /community/spaces/:slug/boards`, `PATCH /community/boards/:id` | 200 / 201 | 401, 403, 404, 409 `title_taken`·`too_many_boards`·`space_not_active`, 422 `kind: not_allowed` |
| `GET/POST /community/official-requests` | 200 / 201(이미 있음 200) | 401, 403 `affiliation_required`, 404, 409 `official_exists`, 422 |
| `GET /operator/community/official-requests`, `POST …/:id/student-council` | 200 | 401, 403 `operator_only`, 404 |
| `POST /operator/community/official-pages` | 201 | 401, 403, 404, 409 `official_exists`, 422 |
| `GET /operator/community/spaces`, `POST …/:id/restrict\|lift-restriction\|archive\|capacity`, `GET/POST …/:id/moderators`, `DELETE …/:id/moderators/:userId` | 200 | 401, 403, 404, 409 `target_not_public`·`not_restricted`·`already_archived`, 422 |
| `POST /reports {targetType: community_space, targetRef: {spaceSlug}}` | 201/200 | 404(읽을 수 없는 공간), 422 |

## 결과

- 학교 인증 구성원끼리 방을 만들고 초대·승인으로 모이며, 공식 페이지는 운영자만 엽니다. 커뮤니티 데이터는 공개 경로·검색 색인에 들어가지 않고, 운영자도 사용자 방 내용을 읽지 않습니다.
- C-03(이름 표시 방식 변경 예약)·C-04(글·댓글)·C-05(robots·사이트맵·OG)·C-06(신고 누적 숨김·제재)이 같은 정책 함수 위에 올라갑니다.
- 한계: 학과 일치는 자유 글 키 비교라 표기가 다르면 맞지 않습니다(학생이 학과 이름을 고쳐야 함). 학교 병합 뒤 중복 공식 페이지를 자동으로 합치지 않습니다. 개설 요청 알림은 운영 화면·감사 기록뿐입니다(메일·푸시 없음). 만료된 초대 행을 지우는 주기 작업이 없습니다(행은 작고 탈퇴 정리에서 지움). 학과 쓰기 제한·공지 고정 API는 C-04/C-06. 로그인하지 않은 채 초대 링크를 열면 로그인 뒤 링크를 다시 열어야 합니다(과제 초대처럼 이어 주지 않음). 방 수·가입 요청에 대한 사용자별 한도는 방 만들기(하루 10개)뿐입니다.

## 대안

- **공식 페이지도 멤버십으로 읽기**: 목록·탈퇴 처리가 단순하지만, 인증 해제 뒤에도 남은 멤버십으로 계속 읽게 되고 학교 구성원 전체를 미리 넣어야 합니다. SYSTEM_DESIGN이 학교 인증 파생을 요구합니다.
- **사용자 방을 로그인만으로 만들기**(§8.9.2 문구 그대로): 진입이 쉽지만 학교 무관 방이 인증 없는 계정의 스팸·사칭 통로가 됩니다. 인증은 C-01로 몇 분이면 됩니다.
- **학과 테이블을 지금 만들기**: 정확하지만 학과 정규화·병합 운영이 P1 범위(공식 페이지 1개)를 넘습니다.
- **기준 도달 시 자동 개설**: 운영 부담이 줄지만 §8.9.3·SYSTEM_DESIGN이 운영자 검토를 요구하고, 빈 페이지를 미리 만들지 않는다는 원칙과 맞지 않습니다.
- **slug에 이름을 넣기**: 읽기 쉽지만 unlisted 방 이름이 주소로 새고, 한국어 이름 변환 규칙이 필요합니다.
- **운영자에게 사용자 방 읽기 허용**: 신고 처리가 쉬워지지만 비공개 공간 원칙(ADR 0010·0015)과 맞지 않습니다. 글 단위 신고는 C-06에서 신고된 글만 보여 줍니다.
