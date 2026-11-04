# 0024. 모집·지원·스터디 방 생성: 팀원 찾기와 스터디 모집을 한 테이블로 + 걸린 곳의 읽기 정책을 따르는 열람 + 모집자만 보는 지원자 목록(시각 순서·사유 없음) + 마감 때 과제 공간·스터디 방과 "받아야 하는" 초대 + 과목 큐레이터 자리

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-07은 DELIVERY_PLAN §4.1 "팀원 찾기와 같은 모집 테이블, 지원자 목록은 모집자만·순위 없음, 마감 시 스터디 방 생성과 초대"와 §5.1 시나리오 N(스터디 모집에서 기록까지)의 앞부분입니다. 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.8(팀원 찾기: 같은 과목 학생, 선택 첨부(공개 프로필·공개 사례), 지원자 목록은 모집자만·활동량·포크 수·확인 수로 정렬하지 않음, 거절 사유 없음, 팀이 구성되면 과제 공간 생성과 초대, 팀 배정 과목은 과목 큐레이터가 숨김, 스터디도 같은 방식·한 목록에서 종류로 구분), §8.9.5(스터디 모집: 공식 페이지 모집 게시판·과목 허브·사용자 방, 만들어질 방의 이름 표시 방식, 마감하면 스터디 방 + 초대, 표시명 기본, 익명 스터디 방 기록은 포트폴리오 연결 불가), §8.7(이번 학기 과목 등록, P1 — 이번 범위 밖).
- SYSTEM_DESIGN §6.7 Recruitment·Application("모집자만 열람, 순위·점수·거절 사유 필드 없음, 익명 게시판의 모집이어도 지원자 정보는 모집자에게만"), §8.1·§8.2(정책 함수 한 곳, 404), §9.1(`POST /community/recruitments`·`…/applications`·`…/close`).
- ADR 0019(`createStudyRoomInternal`, 스터디 방은 초대로만), 0020(이름 표시 방식), 0021(열람 매트릭스·스키마 커뮤니티 구역 경계 검사·센티넬·감사/분석 id·코드만), 0022(글쓰기에는 감사 없음 — 감사 조회가 신원 우회로가 되지 않게), 0023(제재는 커뮤니티 쓰기 정책 함수에서만), 0018(학교 인증), 0010(과목·학기 정본, 엠바고).
- 변경: D-05: 공간에 걸리지 않은 과목 모집은 학교 인증에 더해 그 과목을 등록한 사람만 읽고 지원하고 올립니다 ([ADR 0060](0060-open-question-decisions.md)).

## 결정

### 테이블 (migration `0022_recruitments`, 새 테이블은 모두 schema.ts 커뮤니티 구역)

- `recruitments`: `kind`(`team|study`), `space_id?`(공식 페이지·사용자 방, 모집 게시판이 있는 공간), `course_id?`(정본), `term_id?`(그 과목의 정본 학기), `title`(1~80), `description`(0~2000), `capacity`(2~20, **모집 인원 = 선정할 수 있는 지원자 수, 모집자 제외**), `room_name_mode`(스터디만, 표시명 기본), `status`(`open|closed|cancelled`), `closes_at?`(마감 예정, 90일 안), `created_by`, `created_at`, `closed_at`, `result_project_id?`, `result_space_id?`, `hidden_at`(운영 조치). DB check: 공간·과목 중 하나 이상, 팀원 찾기는 과목 필수, 학기는 과목이 있을 때만, 스터디만 방 방식, 결과는 마감 + 종류에 맞을 때만, `open`이면 `closed_at` 없음, 비운 제목·소개(탈퇴 정리)는 모집 중이 아닐 때만.
- `recruitment_applications`: `(recruitment_id, applicant_id)` unique, `message`(0~500), `profile_handle?`, `case_slugs`(최대 3), `status`(`pending|accepted|declined|withdrawn`), `created_at`, `decided_at`, `project_invitation_id?`·`space_invitation_id?`(발급한 초대, 다시 받으면 이전 것을 취소), `message_hidden_at`(운영 조치). **사유·점수·순위 열이 없습니다**(통합 테스트가 information_schema로 확인).
- `courses.team_finding_disabled`(카탈로그 구역, 기본 false), `community_notices.recruitment_id` + `space_id` nullable(공간 없이 과목에만 걸린 모집의 알림) + `(recruitment_id, kind, user_id)` 부분 unique, 신고·조치 열 `community_recruitment_id`·`community_application_id`, enum 값(신고 대상 2, 조치 `hide_recruitment`·`hide_application`, 알림 3, 분석 3). 같은 migration에서 더한 enum 값을 쓰는 check는 `::text`로 비교합니다(ADR 0019).
- C-05 경계 검사(커뮤니티 테이블 목록·소스 경계·센티넬)가 두 테이블을 자동으로 덮는 것을 테스트로 확인했고, 행위자 × 경로 매트릭스에 모집 경로 9개를 더했습니다.

### 올리는 곳·보는 사람 (결정)

- **공간에 올림**: 그 공간의 `recruiting` 게시판에 쓸 자격(`canWriteBoard`: 공식 학교·학과 페이지는 그 학교·학과 인증, 사용자 방은 active 멤버, 모더레이터 전용 게시판이면 운영진, 이용 제한 없음)이 있어야 합니다. 모집 게시판이 없으면 409 `no_recruiting_board`(사용자 방은 방장이 게시판을 더함). 공간을 읽을 수 없으면 404.
- **과목에 올림**: 공간 없이 과목만이면 **그 과목 학교(정본)의 active 인증** 사용자만 올리고 봅니다. 과목을 고르면(공간에 올려도) 그 학교 인증이 있어야 합니다(403 `affiliation_required`). 과목 맥락의 모집은 공개 과목 허브와 달리 커뮤니티 데이터입니다(로그인·인증 필수, noindex).
- **보기**(`canViewRecruitment`): 걸린 곳의 읽기 정책(`canReadSpace` — C-05 매트릭스 그대로, 또는 과목 학교 인증). 모집자 본인도 학교 인증이 해제되면 404입니다(C-05와 같음). 운영 조치로 가린 모집·팀원 찾기가 꺼진 과목의 팀원 모집은 **모집자 본인만**(취소할 수 있게) 봅니다.
- **모집자 신원을 응답에 싣지 않습니다**(`mine` 참거짓만). 익명 공식 페이지의 모집 게시판에서도 모집 글이 사람과 이어지지 않게 하고, 팀은 과제 공간·스터디 방에서 서로 확인합니다. 반대로 **지원하면 모집자에게 지원자의 표시 이름이 보입니다**(화면이 미리 알림).
- 사용자별 한도: 모집 하루 5개, 지원 하루 20번(DB 고정 창, 429). 요청 본문 64KB(413).

### 지원자 목록은 모집자만 (결정)

- `GET …/applications`는 **모집자만**: 모집을 읽을 수 있는 다른 사람(모더레이터·운영자·다른 지원자)은 403 `recruiter_only`, 읽을 수 없으면 404. 선정·선정 안 함·마감·취소도 같습니다. 운영자 화면·신고 상세에도 지원자 목록이 없습니다.
- 지원자 DTO는 `RECRUITER_APPLICATION_KEYS`(id·표시 이름·메시지·가림 여부·첨부·상태·시각)뿐이고 **지원 시각 순서**(같으면 id)로만 보냅니다(`orderApplications`). 활동량·포크 수·확인 수·점수·순위 필드가 없습니다(통합 테스트가 키 집합을 `toEqual`). 철회한 지원은 목록에서 빠집니다.
- 지원자 수(지원·검토 중·선정)는 **모집자에게만** 상세에서 보입니다. 카드·다른 사람의 상세에는 없습니다.
- 지원자는 자기 지원 상태만 봅니다(`검토 중`·`선정됨`·`모집이 마감되었거나 선정되지 않았습니다.`·`지원을 취소했습니다.`). 거절과 마감(선정되지 않음)을 구분하지 않습니다.
- **지원·선정·선정 안 함은 감사 기록을 남기지 않습니다.** 감사 행에 지원자 id와 모집 id가 같이 있으면 운영자의 감사 조회(`/operator/audit?target=`)가 지원자 목록 우회로가 되기 때문입니다(ADR 0022의 글쓰기와 같은 이유). 모집 만들기·마감·취소·초대 발급의 감사는 모집자가 행위자이고 metadata는 id·코드·개수뿐입니다.

### 첨부 (결정)

- 선택입니다. `attachProfile: true`(지원자 본인의 숨기지 않은 공개 프로필, 아니면 422 `attachProfile: not_public`)와 `caseSlugs`(지원자가 **active 멤버인 과제의 지금 제공 중인 공개 사례**(publication) slug 최대 3개, 아니면 422 `caseSlugs.N: not_yours`). 화면은 `GET …/attachment-options`로 내 것만 고르게 합니다.
- **읽을 때마다 다시 확인**합니다(`loadServedRelease` + 멤버십, 프로필 숨김·계정 상태). 철회·대체·제한·엠바고·숨김으로 지금 제공되지 않으면 응답에서 빠집니다(행에는 slug가 남지만 내용은 공개 쪽에만 있음). 스냅샷 제목만 가져오고 비공개 작업 테이블은 읽지 않습니다.

### 선정·마감·취소 (결정)

- 선정은 모집 중 + 검토 중인 지원 + 모집 인원까지(409 `capacity_full`, 모집 행 `FOR UPDATE`로 동시 선정을 줄 세움). 선정 안 함은 검토 중·선정 둘 다(마감 전 마음을 바꿀 수 있게), 지원자에게 "모집이 마감되었거나 선정되지 않았습니다" 알림. **사유 입력 자체가 없습니다.**
- 지원자는 모집 중에 검토 중·선정 상태의 지원을 취소할 수 있습니다. 같은 모집에 다시 지원할 수는 없습니다(409 `already_applied`, unique).
- **마감**: 모집자만, 모집 중, 선정 한 명 이상(409 `no_accepted` — 아무도 없으면 취소). 한 트랜잭션에서:
  - 팀원 찾기 → `insertProjectInTx`(projects 모듈의 만들기와 같은 함수)로 **비공개 과제 공간**(owner = 모집자, 종류 team, 학기가 있으면 연결 → T-10 엠바고). 제목은 "과목 이름 + 팀 과제"이고 **모집 글 내용을 옮기지 않습니다**(커뮤니티 글이 커뮤니티 테이블 밖으로 나가지 않게 — 센티넬 테스트가 마감 뒤 과제·초대·감사·분석 테이블을 확인). 분석 `project_created { origin: recruitment }`.
  - 스터디 → `createStudyRoomInternal`(초대 전용·목록 비노출·모집 때 고른 이름 표시 방식, 방 이름은 제목 앞 40자 — 모집을 만들 때 공간 이름 규칙·예약어를 미리 확인, 학교는 걸린 공간 또는 과목 학교, 과목 연결). 커뮤니티 전체 이용 제한 중이면 403 `write_restricted`.
  - 검토 중인 지원은 선정되지 않음으로 닫고 알림, 선정된 사람에게 `recruitment_invited` 알림.
- **초대는 받아야 합니다(자동 멤버십 없음)**: 선정된 사람이 모집 화면에서 "초대 받기"(`POST …/invitation`)를 누르면 그때 기존 초대 서비스(`issueInvitationInTx` — 과제, 역할 editor / `issueSpaceInvitationInTx` — 스터디 방)로 **모집자 이름의 7일·한 번만 쓰는 링크**를 발급해 응답에서 한 번만 돌려주고(토큰 원문은 저장하지 않음), 다시 받으면 이전 링크를 취소합니다. 수락은 기존 초대 화면(`/invite/…`, `/community/invite/…`)에서 본인이 합니다. 마감 때 미리 만들지 않는 이유: 해시만 저장하는 규칙 때문에 원문 링크를 알림에 넣을 수 없고, 알림 행에 토큰을 두면 저장 원칙이 깨집니다. 모집자가 더는 과제 owner·방 운영진이 아니거나 방이 보관·제한되면 409 `invitation_unavailable`.
- **취소**: 모집자만, 모집 중. 검토 중·선정된 지원자에게 "모집이 취소되었습니다"(이유 없음).
- 알림(`community_notices`)의 payload는 모집 종류뿐이고 제목·모집자·이유가 없습니다. 링크는 모집 주소이며 열 때 다시 판정합니다(볼 수 없으면 404).

### 과목 큐레이터 자리 (결정)

- §8.8의 "수업이 팀을 배정하는 과목에서는 과목 큐레이터가 이 기능을 숨김"은 큐레이터 역할이 아직 없으므로 **과목 행의 플래그 `team_finding_disabled`**로 두고, 지금은 운영자가 `POST /api/v1/operator/community/courses/:id/team-finding {disabled}`로 정합니다(정본 과목, 감사 `community.course_team_finding`). 큐레이터가 생기면 이 경로의 권한 판정만 바꿉니다.
- 켜면: 그 과목의 팀원 모집은 모집자 외에는 목록·상세·지원에서 404, 새 팀원 모집은 409 `team_finding_disabled`, 과목 화면의 링크가 사라집니다. 스터디 모집은 영향이 없습니다. 공개 과목 허브 응답에는 이 값을 싣지 않습니다.
- 과목 허브(`/c/:id`, 공개 화면)의 "이 과목 팀원 찾기·스터디 모집" 링크는 화면이 뜬 뒤 **로그인한 경우에만** `GET /api/v1/community/recruitments/course-entry?courseId=`에 그 학교 인증 여부·플래그를 묻고, 참일 때만 그립니다. 공개 SSR·공개 API는 커뮤니티 모듈을 부르지 않습니다(C-05 소스 경계 그대로). 모집 글·수는 공개 화면에 없습니다.

### 신고·운영 조치·제재 (결정)

- 신고 대상 `community_recruitment {recruitmentId}`: 신고자가 볼 수 있는 가려지지 않은 모집(아니면 404). `community_application {applicationId}`: **그 모집의 모집자만**(지원 메시지를 보는 사람이 모집자뿐이므로, 다른 사람은 404). 사용자별 신고 한도(T-15)는 그대로, 신고 누적 자동 숨김(C-06)은 글·댓글에만 적용합니다(모집은 운영자 검토).
- 조치 `hide_recruitment`(모집자 외 404·지원 받지 않음, 모집자에게 "운영 조치로 가려짐") / `hide_application`(모집자에게 "운영 조치로 가려진 메시지입니다"). 되돌림(이의제기·해제)은 가림을 풉니다. 당사자는 모집자·지원자입니다(당사자 안내·이의제기).
- 운영자 신고 상세는 그 모집 글 또는 지원 메시지 하나만 보이고 **모집자·지원자 id·이름과 지원자 목록이 없습니다**.
- 이용 제한(C-06): 판정 공간 기준(공간에 올린 모집은 그 공간 범위 제재까지, 과목 모집은 커뮤니티 전체 제재) 효력이 있으면 올리기·지원이 403 `write_restricted`. 읽기·신고·지원 취소는 막지 않습니다. 과제 공간 쪽(초대 수락 뒤 과제 작업)에는 영향이 없습니다.

### 탈퇴 정리·분석·로그

- worker `ops/purge.ts`(지원 행이 초대를 가리키므로 초대·과제 정리보다 먼저): 그 사람의 지원은 지우고, 신고·조치가 가리키면 메시지·첨부를 비운 `withdrawn` 행으로 남깁니다. 그 사람이 올린 모집 중 모집 중인 것은 취소하고(지원자에게 웹과 같은 취소 알림) 모든 모집 글의 제목·소개를 비웁니다(행은 남음, 마감 결과 링크 유지). 그 모집의 지원이 가리키던 초대 연결은 끊습니다. 장부 종류 `recruitment_applications`·`recruitments_cancelled`·`recruitment_texts`, 재적용은 idempotent.
- 분석 허용 목록: `recruitment_created {kind}`, `application_submitted {kind}`, `recruitment_closed {kind, outcome: project|study_room|cancelled}`, `community_report_filed`의 `targetKind`에 `recruitment`·`application`. id·제목·과목·지원자 수 없음(C-05 금지 키 검사 통과).
- 커뮤니티 모듈은 서버 로그를 남기지 않습니다.

### 화면

- `/community/recruitments?space=|course=`: 모집 카드(종류 배지 팀원/스터디·상태·과목·학기·모집 인원·마감 예정, 지원자 수 없음), 모집 글 쓰기(종류·제목·소개·인원·학기·마감 예정·스터디 방 이름 표시 방식과 안내). 맥락 없이 열면 "내가 올린 모집"·"내 지원".
- `/community/recruitments/:id`: 지원(메시지·내 공개 프로필·공개 사례 선택), 내 지원 상태·지원 취소·초대 받기 → 초대 열기, 모집자 영역(지원 순서대로·선정·선정 안 함·마감·취소·결과 링크, "순위·활동량 없음·사유 없음" 안내), 신고(모집 글 / 모집자만 지원 메시지).
- `/community/s/:slug`의 모집 게시판에 "팀원·스터디 모집 보기·올리기", `/community`에 "모집·내 지원", `/community/notices`에 모집 알림, `/c/:id`에 로그인·인증 사용자에게만 "이 과목 팀원 찾기". 모두 `useCommunityPage()`(제목 고정·OG 없음), 키보드 조작, 360px 가로 스크롤 없음(E2E).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /community/recruitments?space=\|course=[&kind=]` | 200 `RecruitmentListDto` | 401, 404(읽을 수 없는 공간·인증 없는 과목), 422 |
| `POST /community/recruitments` | 201 상세 | 401, 403 `affiliation_required`·`write_not_allowed`·`write_restricted`, 404, 409 `no_recruiting_board`·`team_finding_disabled`, 413, 422 `title`(`reserved` 포함)·`description`·`capacity`·`closesAt`·`courseId: required`·`termId: not_in_course`·`roomNameMode`, 429 |
| `GET /community/recruitments/mine`, `…/attachment-options` | 200 | 401 |
| `GET /community/recruitments/course-entry?courseId=` | 200 `{available}` | 401, 404 |
| `GET /community/recruitments/:id` | 200 | 401, 404 |
| `POST /community/recruitments/:id/applications` | 201 내 지원 | 401, 403 `own_recruitment`·`write_restricted`, 404, 409 `recruitment_not_open`·`already_applied`, 413, 422 `message`·`attachProfile: not_public`·`caseSlugs.N: not_yours`, 429 |
| `POST /community/recruitments/:id/withdraw` | 200 | 401, 404, 409 `not_applied`·`recruitment_not_open`·`not_withdrawable` |
| `GET /community/recruitments/:id/applications` | 200 (모집자만) | 401, 403 `recruiter_only`, 404 |
| `POST …/applications/:appId/accept\|decline` | 200 | 401, 403 `recruiter_only`, 404, 409 `recruitment_not_open`·`not_pending`·`capacity_full` |
| `POST /community/recruitments/:id/close` | 200 상세 | 401, 403 `recruiter_only`·`write_restricted`, 404, 409 `recruitment_not_open`·`no_accepted` |
| `POST /community/recruitments/:id/cancel` | 200 상세 | 401, 403, 404, 409 `recruitment_not_open` |
| `POST /community/recruitments/:id/invitation` | 200 `{kind, inviteUrl}` | 401, 404, 409 `not_selected`·`not_closed`·`already_member`·`invitation_unavailable`, 429(시간당 10) |
| `POST /operator/community/courses/:id/team-finding {disabled}` | 200 | 401, 403 `operator_only`, 404, 422 |
| `POST /reports {targetType: community_recruitment\|community_application}` | 201/200 | 404(볼 수 없음·모집자가 아님·가려짐), 422 |
| `POST /operator/reports/:id/resolve {action: hide_recruitment\|hide_application}` | 200 | 409 `target_not_public` |

## 결과

- 같은 학교·같은 공간 사람끼리 팀원·스터디를 모으고, 지원자 정보는 모집자만 보며(운영자 감사 조회로도 찾을 수 없음), 마감하면 비공개 과제 공간·초대 전용 스터디 방으로 이어지되 각자 초대를 수락해야 들어갑니다. 모집 글은 커뮤니티 테이블 밖으로 나가지 않습니다.
- 테스트: 도메인 `recruitments.test.ts`(올리기·보기·지원 자격, 인원, 전이, 시각 순서, 알림·분석 허용 목록), 통합 `recruitments.integration.test.ts`(모집자만 지원자·키 집합·감사 없음, 첨부 확인과 철회 뒤 사라짐, 인원·사유 없는 거절·취소, 팀 마감 → 비공개 과제 + 초대·자동 멤버십 없음·엠바고, 스터디 마감 → 초대 전용 방 + 초대, 취소 알림, 과목 플래그, 게시판·인증·제재·인증 해제, 한도, 신고·가리기·운영자 화면, 센티넬), C-05 매트릭스·테이블 목록 확장, worker `ops-purge`, E2E `community-recruitments.spec.ts`(스터디·팀원 찾기, desktop·360px).
- 한계: 모집 글을 고치는 경로가 없습니다(잘못 올렸으면 취소하고 다시 올림). 목록은 최근 50개(페이지 넘김 없음). 이번 학기 과목 등록(§8.7)이 없으므로 "같은 과목을 등록한 학생" 대신 "그 과목 학교 인증 사용자"가 과목 모집을 봅니다. 초대 링크는 선정된 사람이 받으러 와야 하고(알림은 화면 안뿐, 메일은 C-10), 7일이 지나면 다시 받습니다. 지원 메시지는 모집자에게 지원 순서대로 보이므로 "먼저 지원한 사람이 위"라는 순서 자체는 남습니다. 지원자의 표시 이름은 읽을 때의 값입니다. 스터디 기록(빌드 로그·마일스톤)과 익명 스터디 방의 포트폴리오 연결 금지는 C-08입니다. 모집 신고는 신고 누적 자동 숨김 대상이 아닙니다.

## 대안

- **팀원 찾기·스터디 모집 테이블 분리**: 필드가 조금씩 다르지만 계획이 같은 테이블·같은 목록을 요구하고, 권한·알림·신고 경로가 두 벌이 됩니다.
- **모집을 글(C-04 posts)의 한 종류로**: 게시판·익명 번호를 재사용하지만 이름 표시 방식(익명 글)과 지원자 신원(모집자에게 보임)이 충돌하고, 글 DTO가 역할마다 달라집니다(ADR 0022 "보는 사람과 무관한 DTO").
- **마감 때 선정된 사람을 바로 멤버로**: 단계가 줄지만 계획이 "초대"를 요구하고, 본인 동의 없이 비공개 과제·방 멤버가 되면 기록·동의 규칙(T-11)과 맞지 않습니다.
- **마감 때 초대 링크를 만들어 알림에 넣기**: 클릭 한 번이 줄지만 토큰 원문을 저장해야 합니다(해시만 저장 원칙 위반).
- **지원·선정에 감사 기록**: 추적은 쉽지만 운영자 감사 조회가 지원자 목록 우회로가 됩니다.
- **모집 글에 모집자 이름 표시**: 신뢰에 도움이 되지만 익명 공식 페이지의 모집 게시판에서 사람이 드러나고, 이름 표시 방식 규칙을 모집에도 따로 만들어야 합니다.
- **과목 큐레이터 역할을 지금 만들기**: 정확하지만 큐레이터 선정·권한·포트폴리오 표시(§8.6)가 C-07 범위를 넘습니다. 플래그와 운영자 경로로 자리만 둡니다.
- **모집 인원에 모집자 포함**: "4명 팀"처럼 읽히지만 수락 한도 계산이 헷갈립니다. 화면에 "나를 빼고"를 적었습니다.
