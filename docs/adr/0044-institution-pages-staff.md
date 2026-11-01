# 0044. 기관 페이지·기수 방·기관 운영진: 대학이 아닌 기관의 `official_school` = 기관 페이지(새 종류 없음) + 기수에 묶인 방장 없는 동문회·OB 방(그 기수 인증만) + 운영자가 지정하는 `institution_staff`(모더레이터 범위 + 설정·게시판 + 자기 기관 초대 코드, 작성자 확인·수료증·사람 조회 없음) + 5 미만 가림 집계

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

I-02는 DELIVERY_PLAN §4.3 P2 백로그의 기관 확장 두 번째 항목입니다: "기관 운영진 권한이 방장·모더레이터를 넘지 않음, 작성자 확인 불가, 기관 단위 사용자 조회 API 없음, 기관 통계는 임계값 적용 집계만". 수용 시나리오 §5.3 Z의 뒷부분은 "기관 운영진은 기관 페이지의 익명·소속 표시 익명 글 작성자를 알 수 없고, 소속 사용자의 프로필·과제 공간을 기관 단위로 조회할 수 없습니다"이고, §7 GA 게이트는 "기관 운영진 권한 범위 검토"를 요구합니다. §9 위험 표는 "기관 운영진의 감시 도구화"를 막기 위해 "기관 단위 사용자 조회 API 없음, 작성자 확인은 운영자 신고 처리 역할만"을 적었습니다. 관련 설계와 앞선 결정:

- PROOFU_EVOLUTION_PLAN §8.9.11(기관 페이지: 요청을 받아 운영자가 개설, 익명, 기관별 인증), SYSTEM_DESIGN §6.7.2(InstitutionAdmin, 초대 코드는 기관 운영진이 발급), §8.4 권한 표(기관 운영진: 기관 기수 방이면 운영 조치만·기수·배지 수정·일정 생성, 초대 코드 자기 기관만, 수료증 확인 불가, 작성자 확인 불가, "기관 페이지의 방장·모더레이터와 같은 권한만", "기관 단위로 조회할 수 없음", "통계는 §11.2와 같은 임계값을 적용한 집계만").
- ADR 0019(공간·공식 페이지: 운영자만 열고 학교 인증에서 자격이 나옴), 0021(커뮤니티 경계), 0023(작성자 확인은 운영자만, 방 운영진은 작성자를 모른 채 가리기·제재 요청), 0027(지표 5 미만 가림 `suppressSmall`), 0037(기관 = `schools` + `kind`, 초대 코드·기수 `institution_cohorts`·수료증, 플래그 `institutions`; 남긴 문제: 커뮤니티 방 만들기·공식 페이지 요청이 부트캠프 인증으로도 열림), 0038(동문회·OB 방 템플릿, 남긴 문제: 기수 방과 `institution_cohorts` 연결), 0039~0041(모임 도구·명부·라운지), 0042(토픽), 0043(수료 회고, 남긴 질문: 기관의 응답 경로).

## 결정

### 1. 기관 페이지 = 대학이 아닌 기관의 `official_school` (새 공간 종류 없음)

- `community_space_kind`에 값을 더하지 않았습니다. 기관 페이지는 **`schools.kind`가 university가 아닌 정본 기관의 `official_school` 공간**입니다(ADR 0037이 기관을 새 테이블이 아니라 `schools` + `kind`로 둔 것과 같은 선택). 공식 페이지의 규칙(운영자만 개설, 학교마다 하나, 이름 표시 anonymous 고정, 자격은 멤버십이 아니라 그 기관 active 인증, 가입·초대·멤버 목록 없음, 모더레이터 지정, 라운지 미디어·졸업생 인증 이력 열람)이 그대로 적용되고, enum `ADD VALUE`와 그에 따른 모든 `kind` 분기·check 수정을 피합니다.
- 다른 점(서버 판정): 개설·개설 요청은 **P2 `institutions` 플래그가 켜져 있을 때만**(꺼지면 404), **학과 페이지 없음**(422 `departmentLabel: not_supported`), 기본 게시판은 `INSTITUTION_PAGE_DEFAULT_BOARDS` = 자유·수료생(종류 alumni)·질문·정보·모집·공지(새내기 없음). 감사 `community.official_create`에 `institutionPage` 플래그.
- 응답: `SpaceSummaryDto.institutionSpace`(`page`·`cohort_room`·null). 화면은 "기관 페이지"·"기수 방"으로 부르고, `공식`은 Peerchive가 운영한다는 뜻이며 이 기관 인증 계정만 읽는다고 안내합니다.
- **플래그가 꺼지면 기관 페이지·기수 방은 없는 공간과 같습니다**(`loadSpaceContext` 404, 내 공간·찾기 목록에서 빠짐 — 운영자 공간 도구는 `loadSpace`를 바로 써서 조치는 가능). 대학 공식 페이지는 플래그와 무관합니다(테스트).

### 2. 기수 방: 기수에 묶인 동문회·OB 방, 방장 없음, 그 기수 인증만

- `community_spaces.cohort_id → institution_cohorts`(migration `0041_institution_staff_cohort_rooms`). check: `cohort_id`가 있으면 `user_room` + `school_id`(그 기관) 필수. 부분 unique: 기수마다 **보관되지 않은** 기수 방 하나(보관하면 다시 만들 수 있음). 이 색인의 조건은 `status <> 'archived'`로 씁니다(`::text` 캐스트는 IMMUTABLE이 아니어서 색인 조건에 쓸 수 없음 — 새 enum 값이 아니므로 그대로 비교해도 됨).
- 만들기: `POST /api/v1/community/institutions/:id/cohort-rooms {cohortLabel, name?, description?, nameMode?}` — **그 기관 운영진 또는 운영자**. 기수는 없으면 만듭니다(초대 코드 발급과 같은 `findOrCreateCohort`). 이름 기본값 `기관 이름 + 기수`(사용자 방과 같은 예약어 검사), 이름 표시 기본 `display`(실명·익명도 고름), **동문회·OB 템플릿**(A-01~A-03의 방별 프로필·배지·일정·투표·앨범·명부를 그대로 씀 — ADR 0038이 남긴 "기수 방과 `institution_cohorts` 연결"의 답), 기본 게시판 general + 공지, **자유 가입·목록 노출 고정**(가입 방식·찾기 변경 422 `not_editable`), 정원 2000, **방장 없음**. 같은 기수 409 `cohort_room_exists`(+slug). 감사 `community.cohort_room_create{schoolId, cohortId, nameMode, byStaff}`.
- 자격(@peerchive/domain `meetsRoomAffiliation`): 기수 방이면 **그 기관(정본)·그 기수의 active 인증**(`hasCohortAffiliation` — 수단은 묻지 않음: 초대 코드·기수 승인·수료증 확인 모두). 소개·가입·초대 수락·읽기가 모두 이 판정을 거치므로 다른 기수·기수 없는 인증·다른 기관은 404이고 찾기에도 나오지 않습니다. **인증이 끝나면 멤버십이 남아도 다음 요청부터 404**(학교 연결 방과 같은 C-05 규칙).
- 방장이 없으므로 승인·내보내기·초대·역할·이름 표시 방식 변경·보관은 아무도 하지 않습니다(보관·제한은 운영자 공간 도구). 문제 멤버는 신고·이용 제한(C-06)으로 다룹니다. 방장을 두지 않은 이유: 방장은 멤버 목록·내보내기·역할을 가지므로 기관이 지정한 사람이 방장이면 기관 단위 사람 조회가 생기고, 사용자가 방장이면 "기관이 운영하는 기수 방"과 "누군가의 방"이 섞입니다. 일반 멤버가 만드는 기수 친목 방은 기존 사용자 방(기관 연결)으로 충분합니다.

### 3. 기관 운영진 `institution_staff`

- 테이블(I-02 구역, 커뮤니티 구역 밖): `(school_id, user_id, granted_by, granted_at, revoked_at?, revoked_by?)`, 해제되지 않은 행은 `(기관, 사람)`마다 하나(부분 unique), 해제는 행을 남김(check: 해제 전에는 `revoked_by` 없음). 탈퇴 정리는 그 사람의 행을 지웁니다(장부 `institution_staff`, 그 사람이 지정·해제한 남의 행은 가명 처리된 users를 가리킴).
- 지정·해제: **운영자만** `GET/POST /api/v1/operator/institutions/:id/staff {userId}`, `DELETE …/staff/:userId`. 대학 422 `institutionId: not_supported`(대학 쪽 "학생회 운영진"은 범위 밖), 없는·active가 아닌 사용자 422, 이미 운영진 409 `already_staff`, 해제할 행 없음 404. 감사 `institution_staff.grant`·`.revoke` — targetId는 지정 행 id, metadata는 `{schoolId, userId}`(id만). 운영진에게 그 기관 인증이 있을 필요는 없습니다(기관 직원).
- 판정(@peerchive/domain `isInstitutionStaffFor`): active 계정 + 그 기관(정본)의 해제되지 않은 운영진 + 공간이 **그 기관의 기관 페이지 또는 기수 방**. 사용자가 만든 기관 연결 방·학과 페이지·다른 기관 공간에는 아무 권한이 없습니다. 서버는 플래그가 켜져 있을 때만 `institutionStaffSchoolIds`를 채우므로 꺼지면 권한이 사라집니다.

### 4. 운영진 권한 = 모더레이터 범위 + 설정·게시판 (방장을 넘지 않음)

| 행동 | 기관 페이지 | 기수 방 | 근거 |
|---|---|---|---|
| 읽기(상세·게시판·글) | 가능 | 가능(운영 조치를 위해, 멤버가 아님) | `canReadSpace` |
| 가리기·되돌리기·운영 화면·제재 요청 | 가능 | 가능 | `canModerate`(모더레이터와 같은 경로, ADR 0023) |
| 공지(모더레이터 전용 게시판) 쓰기 | 가능 | 가능 | `canWriteBoard` → `canModerate` |
| 일반 게시판 글·댓글·공감 | 그 기관 인증이 있을 때만(일반 멤버와 같음) | 그 기수 인증 + 멤버일 때만 | 운영진 지위로는 없음 |
| 설정(이름·소개)·게시판 만들기·고치기 | 가능 | 가능(가입 방식·찾기는 고정) | `canManageSpace` `update_settings`·`manage_boards` |
| 보관·승인·내보내기·초대·역할·이름 표시 방식 | 불가 | 불가 | 방장 권한 — 운영진에게 없음 |
| 멤버 목록·방별 프로필·명부·일정·투표·앨범·스터디 기록 | 공식 페이지에는 원래 없음(409) | **404**(멤버가 아님) | 아래 "멤버 단위 기능" |
| 작성자 확인(익명·소속 표시 익명 포함) | **불가(403 `operator_only`)** | 불가 | `canResolveAuthor`는 운영자만 |
| 초대 코드 발급·목록·철회 | 자기 기관만 | – | §5 |
| 수료증 확인 | **불가** | – | ADR 0037 §6 |

- 도메인 테스트가 "운영진이 할 수 있는 관리 동작은 모두 일반 방의 방장도 할 수 있다"(`SPACE_MANAGE_ACTIONS` 전체)를 확인하고, 운영진에게 허용된 것이 `update_settings`·`manage_boards`뿐임을 고정합니다.
- **멤버 단위 기능**: 기수 방을 운영진으로만 읽는 사람(`SpaceContext.staffOnly`)은 `loadReadableSpace(…, { institutionStaff: true })`로 명시한 경로(공간 상세·게시판 목록·글 목록·글 보기·글 쓰기(공지)·내 글 고치기·지우기·운영 조치·설정·게시판 관리)만 쓰고, 그 밖의 모든 커뮤니티 경로는 기본값으로 **404**입니다. 기본을 막고 필요한 곳만 여는 방식이라 A-01~A-04처럼 "읽을 수 있으면 멤버"라고 가정한 기존·이후 모듈이 운영진에게 열리지 않습니다(테스트: 방별 프로필·명부·멤버 목록 404).
- 운영진이 글 목록에서 보는 것은 같은 방 모더레이터가 보는 것과 같습니다: 작성자 표시는 일반 멤버와 같은 DTO(사람 id·핸들 없음, 익명은 스레드 번호), 표시명·실명 방의 방별 이름·배지는 글에 붙은 만큼만. 운영진이 공지를 쓰면 그 방 방식(표시명 방이면 운영진의 표시명 페르소나)으로 고정됩니다.
- 회원 안내: 기관 페이지·기수 방 화면에 "이 기관 운영진이 운영 조치를 위해 읽을 수 있고, 운영진도 작성자를 알 수 없고 멤버 목록을 보지 않음"을 보입니다.

### 5. 초대 코드: 운영진은 자기 기관만

- `POST/GET /api/v1/institutions/:id/invite-codes`, `POST /api/v1/invite-codes/:id/revoke`(설계 §9 초안 경로). 판정 `requireInstitutionManager`: 운영자 또는 그 기관 운영진(다른 기관 403 `institution_staff_only`, 대학 422). 철회는 코드의 기관을 보고 권한이 없으면 **404**(코드 id가 있는지도 모름). 규칙(HMAC만·원문 한 번·만료·한도·기수)은 운영자 발급과 같은 본체(`issueCodeFor`)를 씁니다. 감사 `invite_code.issue`·`.revoke`에 `byStaff` 플래그를 더했습니다. 운영자 경로(`/operator/…`)는 그대로 운영자 전용입니다.

### 6. 기관 집계: 5 미만 가림, 합계 없음

- `GET /api/v1/community/institutions/:id/stats`(운영진·운영자): 신분별 인증 회원 수(`verifiedMemberCount` — active·verified_at·active 계정, 사람 단위), 기관 페이지 최근 30일 게시 중인 글·댓글 수, 보관되지 않은 기수 방 수(사람 수가 아님). **사람·글 수는 모두 `suppressSmall`(5 미만 null, ADR 0027)**. 합계·기수별·수단별 수는 싣지 않습니다 — 신분별 두 칸과 합계를 함께 주면 가린 칸을 빼기로 되살릴 수 있기 때문입니다. 기관 운영 화면(`GET /api/v1/community/institutions/:id`)의 기수 방 멤버 수도 5 미만 null입니다.
- 커뮤니티 표(글·댓글·공간)를 세므로 이 경로는 커뮤니티 모듈(`community/institution-pages.ts`)과 `/api/v1/community/**`에 둡니다(C-05 경계: 커뮤니티 모듈을 import하는 라우트는 그 아래에만). 인증 회원 수는 `institutions/member-counts.ts`를 씁니다(커뮤니티 → 기관 방향 import만).

### 7. 기관 단위 사용자 조회 경로 없음

- 기관 관련 라우트는 정해진 목록뿐이고(라우트 검사 테스트가 파일 목록을 고정), 운영진이 쓰는 경로 이름에 member·user·profile·project·affiliation·follow·directory·export·search 같은 말이 없습니다. 운영진 화면 모듈의 `@peerchive/db` import에 users·profiles·personas·institution_affiliations·space_memberships·room_profiles·directory_entries·projects가 없음을 소스 검사로 고정합니다(운영진 모듈 `institutions/staff.ts`는 계정 상태 확인·운영자용 운영진 목록 때문에 users만).
- 운영진 본인에게 보이는 것은 자기가 운영진인 기관 목록(`GET /api/v1/me/institution-staff`)뿐입니다. 운영자용 운영진 목록만 사용자 id·계정 이름을 싣습니다.

### 8. I-01이 남긴 문제: 대학이 아닌 기관 인증과 커뮤니티

- **사용자 방 만들기·학교 무관 방 가입은 대학이 아닌 기관 인증으로도 됩니다(유지)**. ADR 0019가 방 만들기에 인증을 요구한 이유는 사칭·스팸을 줄이는 것이고, 초대 코드(기관이 발급)·수료증(운영자 확인)·기수 승인(비승인 수단 인증자 2명)은 그 목적에서 학교 메일과 같거나 강합니다. 학교 무관 방은 원래 "어떤 학교든"이고 토픽(ADR 0042)도 부트캠프 인증을 받습니다. 자기 기관에 연결한 사용자 방도 만들 수 있고(그 기관 인증만 들어옴), 그런 방은 기관의 방이 아니므로 **기관 운영진 권한이 미치지 않습니다**(테스트). 이 판정은 플래그와 무관합니다 — 대학이 아닌 기관 인증은 플래그가 켜졌을 때만 생기고, 나중에 끄더라도 이미 인증한 사람의 기존 방 이용을 바꾸지 않습니다(토픽과 같은 태도).
- **공식 페이지 개설 요청은 그 기관 active 인증이면 낼 수 있습니다(플래그 켜짐만, 학교 페이지만)**. 요청은 수요 신호이고 여는 것은 운영자입니다. 대학이 아닌 기관의 페이지는 협력 기관 확보(GA)와 운영진 지정 계획을 확인한 뒤 엽니다(RUNBOOK). 학생회 표시(`student_council`)는 대학 개념이라 기관 요청에는 쓰지 않습니다(막지는 않음, 운영 판단).

### 9. 범위 밖으로 둔 것

- §8.4의 "기수·배지 수정(기관 기수 방)"과 "일정 생성(기관 기수 방)"은 운영진에게 주지 않았습니다. 둘 다 A-01·A-02에서 방장·운영진(admin) 멤버의 기능이고, 운영진이 멤버가 아닌 채 그 경로를 쓰려면 방별 프로필·응답자 목록을 읽게 됩니다(§7과 충돌). 필요하면 기관이 공지 게시판으로 일정을 알리고, 별도 결정으로 "멤버 정보를 읽지 않는 일정 만들기"를 엽니다.
- A-06 수료 회고에 대한 기관의 응답 경로는 넣지 않았습니다(ADR 0043의 질문 그대로). 회고 신고는 운영자 처리입니다.
- 운영진 지정은 웹 API·운영자 화면만(CLI 없음 — 감사 행위자가 운영자로 남도록).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| 모든 새 경로 | – | 플래그 꺼짐 404, 401 |
| `GET /me/institution-staff` | 200 | – |
| `GET /operator/institutions/:id/staff` | 200 | 403 `operator_only`, 404 |
| `POST /operator/institutions/:id/staff` | 201 | 403, 404, 409 `already_staff`, 422 `institutionId: not_supported`·`userId: invalid\|not_found\|inactive` |
| `DELETE /operator/institutions/:id/staff/:userId` | 200 | 403, 404 |
| `GET/POST /institutions/:id/invite-codes` | 200 / 201(+`code` 한 번) | 403 `institution_staff_only`, 404, 422 |
| `POST /invite-codes/:id/revoke` | 200(멱등) | 404(없음·다른 기관) |
| `GET /community/institutions/:id` | 200 | 403 `institution_staff_only`, 404, 422 `institutionId: not_supported` |
| `POST /community/institutions/:id/cohort-rooms` | 201 | 403, 404, 409 `cohort_room_exists`, 422 `cohortLabel`·`name`·`nameMode` |
| `GET /community/institutions/:id/stats` | 200 | 403, 404, 422 |
| (기존) `POST /community/official-requests` | – | 대학이 아닌 기관: 플래그 꺼짐 404, 학과 422 `departmentLabel: not_supported` |
| (기존) `POST /operator/community/official-pages` | – | 같음 |
| (기존) `PATCH /community/spaces/:slug` | – | 기수 방의 `joinPolicy`·`discovery` 422 `not_editable` |
| (기존) 기수 방의 방별 프로필·명부·멤버 목록 등 | – | 운영진(멤버 아님) 404 |

## 결과

- 기관은 기관 페이지(운영자가 엶)와 기수 방(운영진이 엶)을 갖고, 운영진은 그 두 곳에서 모더레이터 범위의 조치·공지·게시판 관리와 자기 기관 초대 코드 발급을 합니다. 작성자 확인·수료증 확인·사람 조회는 운영진에게 없고, 집계는 5 미만을 가립니다.
- 기수 방은 인증된 기수 멤버만의 공간이고 인증이 끝나면 접근이 사라집니다. 동문회·OB 템플릿의 모든 도구를 그대로 씁니다.
- 새 enum 값이 없어 빈 DB에서 처음부터 migrate해도 `ADD VALUE` 문제가 없습니다(확인함).
- 한계: 운영진은 기수 방의 글을 읽으므로 기수 방은 "기관이 볼 수 있는 방"입니다(화면 안내). 기관이 볼 수 없는 친목 방은 사용자가 만드는 방으로 남깁니다. 운영진 지정·해제 알림(메일)은 없고 운영 화면과 감사뿐입니다. 기수 방에 방장이 없어 내보내기가 필요하면 운영자 이용 제한으로 대응합니다. 운영진은 그 기관 인증이 없으면 기관 페이지의 일반 게시판에 쓰지 못합니다(공지만).

## 대안

- **새 공간 종류 `official_institution`**: 이름은 분명하지만 enum `ADD VALUE`(같은 migration에서 쓰지 못함), 공식 페이지 판정·check·분석 허용 목록·화면의 모든 `kind` 분기를 바꿔야 하고 얻는 규칙은 같습니다. 학교 종류(`schools.kind`)로 충분히 구분됩니다.
- **기수 방을 공식 페이지처럼 멤버십 없는 공간으로**: 인증에서 바로 자격이 나와 단순하지만, 동문회·OB 템플릿(방별 프로필·일정·명부)이 모두 멤버십에 기대므로 쓸 수 없습니다.
- **운영진을 기수 방의 moderator 멤버로 넣기**: 기존 경로가 그대로 동작하지만 멤버로서 방별 프로필·명부·응답자 목록을 보게 되어, 기수 방을 돌며 기관 단위로 사람을 모을 수 있습니다(§7 위반).
- **운영진에게 기수 방 읽기 권한 없이 신고로만 조치**: 가장 좁지만 운영진이 할 일이 거의 없고 운영자 신고 처리와 같아집니다. 모더레이터와 같은 읽기로 두고 멤버 단위 기능은 막았습니다.
- **집계에 합계·기수별 수 추가**: 쓸모는 있지만 가린 칸을 빼기로 되살리는 경로가 생깁니다. 보완 가림(complementary suppression)을 넣기 전까지 싣지 않습니다.
- **부트캠프 인증으로는 사용자 방을 못 만들게**: 캠퍼스 커뮤니티를 대학으로 좁히지만, 토픽·학교 무관 방과 기준이 갈리고 인증 강도의 차이도 근거가 약합니다.
