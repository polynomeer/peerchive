# 0026. 스터디 기록: 스터디 방 ↔ 내부 과제(kind study) 1:1 + 방 멤버십에서 같은 트랜잭션으로 파생하는 과제 멤버십 + 과제 행에 옮겨 둔 방 이름 표시 방식 + 후보에 고정하는 방식으로 판정하는 익명 스터디의 포트폴리오 연결 금지

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-08은 DELIVERY_PLAN §4.1 "스터디 방에서 빌드 로그·마일스톤 사용, 공개는 공개 절차·멤버 동의, 익명 스터디 방 기록은 포트폴리오 연결 불가"이고, §5.1 시나리오 N(스터디 모집에서 기록까지)의 뒷부분입니다. 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.9.5 "스터디 방에는 게시판과 함께 과제 공간과 같은 빌드 로그·마일스톤을 켤 수 있습니다 … 끝날 때 스터디 회고를 공개 사례·포트폴리오로 만들 수 있습니다. 익명 스터디 방은 기록을 포트폴리오에 연결하지 않습니다", §8.9.8 "스터디 방 기록 → 공개 사례·포트폴리오, 공개 절차(§9.3)와 멤버 동의", §9(엠바고·공개 절차), §10(포트폴리오).
- SYSTEM_DESIGN §6.7 StudyRecord "스터디 방이 기록을 켜면 내부 `Project(kind=study)`를 만들어 빌드 로그·마일스톤을 그대로 재사용. 공개는 Publication 규칙(§7.2)과 멤버 동의를 따름. `anonymous` 스터디 방의 기록은 포트폴리오·공개 프로필에 연결할 수 없음".
- ADR 0011·0012(후보·스냅샷 허용 목록·manifest 해시에 묶인 동의·게시), 0013(과목 허브), 0014(케이스 스터디는 release의 팀원만), 0019·0020·0021(공간·이름 표시 방식·열람 범위와 스키마 구역 경계 검사), 0024(스터디 방은 모집 마감의 `createStudyRoomInternal`로 초대 전용), 0016(탈퇴 정리·분석 허용 목록).

## 결정

### 모델 (migration `0024_study_records`)

- `project_kind`에 `study`를 더합니다. `projects`에 `study_name_mode`(community_name_mode, **study일 때만·반드시** — check `(kind = study) = (study_name_mode is not null)`)와 `study_school_id`(study일 때만, 방의 정본 학교, 학교 무관 방이면 null)를 둡니다. 같은 migration에서 더한 enum 값을 쓰는 check는 `::text`로 비교합니다(ADR 0019).
- `study_records`(schema.ts **커뮤니티 구역** — C-05 경계 검사·테이블 목록이 자동으로 덮음): `space_id` unique, `project_id` unique, `enabled_by`, `created_at`. 방향은 커뮤니티 → 과제뿐이고 과제 쪽 테이블은 이 행을 가리키지 않습니다. 과제·공개·포트폴리오 모듈은 이 테이블을 읽지 않고(소스 경계 검사 그대로) 과제 행의 두 열만 봅니다.
- **켜기**: `POST /community/spaces/:slug/study-record {courseTermId?}` — 스터디 방(`study_room`)의 **방장만**, active 방, 이용 제한 없음. 한 트랜잭션에서 `insertProjectInTx`(웹 만들기·포크·C-07과 같은 함수, origin `study`)로 비공개 과제를 만들고 연결 행을 넣은 뒤 멤버십을 동기화합니다. 제목은 **방 이름을 옮기지 않고** "과목 이름 스터디 기록"(고른 학기 또는 방에 연결된 과목, 카탈로그 데이터) 또는 "스터디 기록"입니다(C-05 센티넬 원칙: 커뮤니티 글·이름은 커뮤니티 테이블 밖으로 나가지 않음). 과목 학기는 선택이며(엠바고 T-10 그대로), 나중에 과제 화면에서도 바꿉니다.
- **끄기 없음**: 공개 후보·동의·release가 이 과제를 가리킬 수 있으므로 기록을 끄거나 연결을 끊는 경로를 두지 않습니다. 방이 보관되어도 기록은 남습니다.

### 멤버십 파생 (결정: 같은 트랜잭션 동기화, 원천은 방 멤버십 하나)

- 과제 권한 판정은 모든 과제 서비스가 `loadReadableProject`(project_members)에서 시작하고, 과제 모듈은 커뮤니티 테이블을 읽을 수 없습니다(C-05 경계). 그래서 "읽을 때 방에서 계산"하지 않고, **방 멤버십을 바꾸는 같은 트랜잭션에서 커뮤니티 모듈이 과제 멤버십을 다시 계산해 씁니다**(`syncStudyRecordInTx` → @peerchive/domain `planStudyRecordSync`, 멱등). 과제 쪽의 초대·역할 변경·내보내기·나가기·소유권 이전·종류 변경은 **409 `study_managed`**이므로 project_members를 쓰는 다른 길이 없고, 두 원천이 갈라질 수 없습니다. project_members는 방 멤버십의 투영(projection)입니다.
- 부르는 곳: 가입(`joinSpace`)·초대 수락·승인·나가기(방장 승계 포함)·내보내기·역할 변경(방장 넘기기 포함)·보관(`archiveSpaceInTx` — 승계자가 없을 때의 자동 보관도)·운영 제한/해제. 공간 행을 먼저 잠근 뒤 과제 행을 잠급니다(과제 서비스는 공간을 잠그지 않으므로 순서가 엇갈리지 않음).
- 역할 대응:

| 방 | 과제 |
|---|---|
| active owner(방장) | owner(공개 준비·게시·철회 담당), `projects.owner_id`도 방장 |
| active admin·moderator·member | editor(로그·마일스톤·할 일·파일·역할 선언) |
| 방이 archived·restricted | owner는 owner, 나머지 active 멤버는 **viewer**(읽기만) |
| pending(승인 대기) | 과제 멤버 아님 |
| left(나감·대기 취소) | left |
| removed(내보냄·거절)·멤버십 행 없음(탈퇴 정리) | removed |

  같은 사람이 다시 들어오면 기존 행을 active로 되돌립니다(행 하나). 과제에서 owner 역할을 잃는 사람은 editor로 내려 두어 owner가 둘 남지 않게 합니다. 바뀐 것이 있으면 감사 `project.study_sync`(개수·owner 변경 여부만)를 남깁니다.
- **방 열람 범위와 같은 학교 조건**: C-05는 학교 인증을 해제하면 멤버여도 다음 요청부터 404입니다. 과제 모듈은 방을 읽을 수 없으므로 켤 때 방의 정본 학교를 `projects.study_school_id`에 옮겨 두고, `loadReadableProject`가 study 과제에 한해 **그 학교(학교 무관 방이면 아무 학교)의 active 인증**을 함께 확인합니다(학교 인증 테이블만 읽음). 인증이 없으면 기록과 그 안의 모든 경로가 404이고 내 과제 목록에서도 빠지며, 다시 인증하면 돌아옵니다. 과제 멤버십 행은 그대로라 동의 당사자 자격도 그대로입니다.
- 탈퇴 정리(worker `ops/purge.ts`): 방장 승계 뒤 그 사람의 방 멤버십을 지우고, 그 사람이 있던 기록마다 같은 계획 함수로 과제 멤버십을 맞춥니다(그 사람 removed, 승계자 과제 owner, 장부 `study_record_syncs`). 이후 과제 정리는 팀 과제와 같습니다(기록은 "탈퇴한 사용자"로 가명 처리, 혼자였던 기록은 연결 행과 함께 삭제 — 다른 사람이 가리키면 기존 묘비 규칙).

### 로그는 과제 로그 (결정)

- 기록 탭에서 쓰는 로그·마일스톤·할 일·파일은 **과제 데이터**이고 커뮤니티 글이 아닙니다(익명 번호·작성 시점 이름 방식이 없음, 과제 권한·검증 그대로). 분석 `log_saved`에 `origin: study`를 붙입니다.
- **익명 스터디 방**: 기록 안에서 다른 멤버의 이름을 "스터디 멤버 N"(과제 멤버가 된 순서, handle 없음)으로 가리고 본인은 자기 이름을 봅니다(`loadPersonMask` — 로그 작성자·해결 연결·할 일 담당자·파일 올린 사람·멤버 목록·역할 선언·확인·기여 장부·체크인·공개 준비 선택지·후보 당사자·동의 요청의 요청한 사람). 이름순 정렬도 가린 이름 기준입니다. 사용자 id는 그대로 둡니다(본인 표시·수정 권한·필터·회의 참석자가 id를 씀).
- 판정은 과제 행의 `study_name_mode`(방의 **지금** 방식)입니다. 방 방식은 worker의 이름 표시 방식 변경 적용(C-03)이 공간 행과 **같은 트랜잭션에서** 과제 행에도 옮깁니다.

### 공개 (결정)

- 공개는 기존 후보 → 점검·미리보기 → 동의 → 게시(T-11·T-12) 그대로입니다(요약/전체 수준, 엠바고 — 학기를 연결하면 학기 종료까지, 보류, manifest 해시). 공개 준비는 기록의 owner(방장)·editor, 게시·철회는 owner입니다.
- **멤버 동의**: 스터디 기록은 내용이 들어간 사람 외에 **후보를 만들 때 active인 방 멤버 모두**가 당사자입니다(범위 `study_member`). 내용이 없는 멤버도 동의해야 게시됩니다.
- **스냅샷**: 허용 목록 빌더(`buildPublicSnapshot`)는 기존 `kind` 필드에 `study`를 싣고, **study일 때만** `studyNameMode`를 더합니다(후보를 만들 때 과제 행의 값, 이후 바뀌지 않음). 다른 종류의 스냅샷에는 키 자체가 없어 기존 후보의 manifest 해시가 바뀌지 않습니다. 방식은 manifest 다이제스트에 들어가므로 동의도 방식까지 포함한 내용에 묶입니다.
- **익명 스터디 후보**: 노출 방식에 이름(`name`)이 하나라도 있으면 422 `exposure: anonymous_study`. 모두 익명이므로 공개 페이지에는 "팀원 A/B…"만 있고 로그 작성자 표시가 없습니다.
- 공개 페이지·과목 허브: 스냅샷 `kind`가 study면 "스터디 기록"·"스터디" 배지(허브 카드의 참여자 수도 팀 과제처럼). 과목 연결은 release의 기존 규칙(게시 때 정본 과목·학기 표시) 그대로라 학기를 연결한 기록만 허브에 나옵니다. 분석 `publication_published`에 `origin: study`.
- 신고·운영 조치는 공개 사례와 같은 경로(T-15)를 씁니다(새 대상 없음).

### 포트폴리오 (결정: 후보에 고정한 방식으로 판정)

- 케이스 스터디 만들기·게시: release 스냅샷이 `kind: study` + `studyNameMode: anonymous`이면 **422 `anonymous_study`**(필드 `releaseSlug`, 팀원 여부보다 먼저 같은 응답). 케이스 스터디 출처 목록(`/me/case-study-sources`)에서도 빠집니다.
- 공개 프로필·포트폴리오 판(`isPubliclyVisible`)과 모집 지원 첨부(C-07 `ownServedCase`·첨부 선택지)도 같은 함수(`canLinkReleaseToPortfolio`)로 거릅니다. 익명 스터디 참여는 어떤 공개 경로에서도 사람과 이어지지 않습니다.
- **방식이 나중에 바뀌면**: 이미 만든 후보·release는 만들 때의 방식 그대로입니다(익명으로 바뀌어도 표시명 release로는 케이스 스터디를 계속 만들 수 있고, 표시명으로 바뀌어도 익명 release는 계속 막힘). 새 후보는 그때의 방식을 씁니다. 예약만 된 변경은 영향이 없습니다(적용된 방식만 봄).

### 분석·감사

- 분석: `study_record_enabled {mode, withCourse}`(방·과제·과목 id 없음, C-05 금지 키 검사에 `study_` 접두를 더함), `project_created {kind: study, origin: study}`, `log_saved {origin: study}`, `publication_published {origin: study}`.
- 감사: `community.study_record_enable`(대상 공간, metadata는 방식·과목 연결 여부), `project.study_sync`(개수·owner 변경 여부). 커뮤니티 모듈은 서버 로그를 남기지 않습니다.

### 화면

- `/community/s/:slug`(스터디 방): "게시판"·"기록" 탭(`role=tablist`, `#record`로 바로 열기). 기록 탭(`StudyRecordSection`)은 꺼져 있으면 방장에게 "스터디 기록 켜기"(과목 학기 선택은 선택)와 안내, 켜져 있으면 배지·내 역할·익명 안내·"기록 전체 화면"·방장의 "공개 준비"·"내 동의 요청" 링크와 과제 화면과 같은 할 일·마일스톤·파일·빌드 로그 컴포넌트.
- `/projects`: 스터디 기록을 "스터디 기록" 묶음으로 따로(익명 방 배지). `/projects/:id`: "스터디 기록" 배지·안내, 초대·역할·내보내기·소유권 이전·나가기 영역을 숨김. `/projects/:id/publish`: 멤버 모두 동의 안내, 익명 방이면 이름 선택지를 없애고 안내. `/consents`: 범위 `study_member` 표시. `/p/:slug`·`/c/:id`: 배지. `/portfolio`: 422 안내 문장.
- 모두 한국어, 키보드 조작, 360px 가로 스크롤 없음(E2E).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /community/spaces/:slug/study-record` | 200 `StudyRecordStateDto`(과제 id는 기록 멤버에게만) | 401, 404 |
| `POST /community/spaces/:slug/study-record {courseTermId?}` | 201 | 401, 403(방장 아님)·`write_restricted`, 404, 409 `not_study_room`·`space_not_active`·`already_enabled`, 422 `courseTermId` |
| 과제 쪽 `POST /projects/:id/invitations`·`PATCH|DELETE …/members/:userId`·`POST …/leave`·`POST …/transfer-ownership`·`PATCH /projects/:id {kind}` (study) | — | 409 `study_managed` |
| study 과제의 모든 경로(비멤버·나감·내보냄·학교 인증 없음) | — | 404 |
| `POST /projects/:id/publication-candidates` (익명 스터디, 이름 노출) | — | 422 `exposure: anonymous_study` |
| `POST /candidates/:id/publish` (방 멤버 동의 부족) | — | 409 `publish_blocked` + `consent_missing` |
| `POST /case-studies`·`POST /case-studies/:id/publish` (익명 스터디 release) | — | 422 `anonymous_study` (`releaseSlug: anonymous_study`) |

## 결과

- 스터디 방이 기록을 켜면 과제 공간의 모든 기능을 그대로 쓰고, 멤버는 방을 따라 자동으로 들고 나며(원천 하나), 공개는 방 멤버 모두의 동의를 거친 공개 사례가 되고, 익명 방의 기록은 공개되더라도 어떤 사람의 포트폴리오·공개 프로필·지원서에도 이어지지 않습니다.
- 테스트: 도메인 `study-records.test.ts`(역할 대응·계획 멱등·나감/내보냄/탈퇴·승계·다시 들어옴·보관, 익명 규칙, 이름 표, 분석), 웹 `study-records.integration.test.ts`(켜기·연결·제목에 방 이름 없음, 가입·나가기·내보내기·다시 초대·역할·방장 넘기기·승계·보관·마지막 멤버, `study_managed`, 비멤버·다른 학교·미인증·나감·내보냄·인증 해제 404 매트릭스, 로그·마일스톤·할 일, 멤버 모두 동의 뒤 게시·스냅샷·공개 페이지·과목 허브, 익명 방 이름 가림·422·첨부 제외, 방식 변경 뒤 release 고정), `public-snapshot.test.ts`(study만 `studyNameMode` 키), C-05 매트릭스·테이블 목록·분석 접두 확장, worker `ops-purge`(승계자가 과제 owner, 혼자 기록 삭제)·`ops-name-modes`(과제 행에 방식 복사), E2E `community-study-records.spec.ts`(모집으로 만든 방에서 기록 켜기 → 로그 → 동의 → 게시 → `/p`·허브 배지, 익명 방 이름 가림·포트폴리오 422; desktop·360px).
- 한계: 기록을 끄거나 다른 방과 다시 연결할 수 없습니다. 익명 방 기록 안에서 사용자 id는 그대로라, 방 멤버 목록(방장·운영진만 봄, 이름 포함)과 맞춰 보면 방장·운영진은 작성자를 알 수 있습니다(공개 경로에는 id·이름이 없음). 동의 당사자는 후보를 만들 때의 방 멤버이고, 그 뒤 들어온 멤버는 다음 후보부터 당사자입니다. 과목 연결이 없는 기록은 과목 허브에 나오지 않습니다. 디스코드 연결은 막지 않았고 주간 요약은 owner 기준으로 이름을 가립니다. 보관·제한된 방의 방장은 계속 owner라 공개 준비를 할 수 있습니다.

## 대안

- **읽을 때 방에서 권한 계산**: 원천이 하나라 깔끔하지만 과제·공개·포트폴리오 모듈이 커뮤니티 테이블을 읽어야 해 C-05 경계(공개 읽기 경로는 커뮤니티 코드·테이블에 닿지 않음)가 깨지고, 모든 과제 서비스의 권한 함수가 두 갈래가 됩니다.
- **과제 쪽 멤버 관리 허용 + 양방향 동기화**: 두 원천이 생겨 경합·충돌 규칙이 필요합니다. 방을 원천으로 하고 과제 쪽 쓰기를 막았습니다.
- **기록 로그를 커뮤니티 글로**: 게시판·익명 번호를 재사용하지만 빌드 로그 태그·마일스톤·공개 스냅샷·동의를 다시 만들어야 하고, 계획(§6.7 "Project(kind=study)를 만들어 그대로 재사용")과 다릅니다.
- **익명 스터디도 이름 노출 허용(본인 동의 시)**: 유연하지만 "익명 스터디 방의 기록은 포트폴리오 연결 불가"를 우회하는 길이 됩니다. 모두 익명으로만 공개합니다.
- **포트폴리오 판정을 방의 지금 방식으로**: 방식이 바뀌면 이미 동의·게시한 release의 의미가 바뀝니다. 후보를 만들 때 고정한 값으로 판정합니다.
- **스냅샷에 `projectKind` 필드를 새로**: 기존 `kind` 필드가 같은 뜻이고, 새 키를 모든 스냅샷에 더하면 열린 후보의 manifest 해시가 바뀝니다. `kind`에 `study`를 싣고 `studyNameMode`만 study일 때 더했습니다.
- **기록 제목에 방 이름**: 알아보기 쉽지만 커뮤니티의 이름이 과제·공개 테이블로 나갑니다(제목은 과제 화면에서 바꿀 수 있음).

## 부록: 익명 스터디 기록의 사용자 id 가명화 (2026-10-27)

### 문제

결정의 "익명 스터디 방" 항목은 이름만 "스터디 멤버 N"으로 가리고 사용자 id를 그대로 두었습니다. 그런데 사용자 id는 과제·방·팀 사이에서 같은 값이라, 같은 사람과 익명이 아닌 과제(팀 과제·표시명 스터디 기록 등)를 함께 쓰는 멤버는 그쪽 응답에서 그 id 옆의 이름을 보고 "스터디 멤버 N"이 누구인지 알 수 있었습니다(로그 작성자·할 일 담당자·완료한 사람·만든 사람·파일 올린 사람·멤버 목록·역할 선언·확인한 사람·기여 장부·체크인·회의 참석자 payload·공개 준비 선택지·노출 방식 키·제외한 사람·후보 당사자·만든 사람·게시를 막는 것의 당사자). 선언 revision 이력(`GET /claims/:id/revisions`)은 이름도 가리지 않고 있었습니다.

### 결정

- **응답의 사람 참조는 멤버 참조**: 익명 스터디 기록(kind study + `study_name_mode` anonymous)에서 다른 사람의 사용자 id는 과제별 가명 키 `sm_` + HMAC-SHA256(`PEERCHIVE_MEMBER_REF_PEPPER`, `study-member-ref:v1:<과제 id>:<사용자 id>`) 앞 16자로 바꿉니다. 과제마다 다르고(다른 과제의 키나 어떤 사용자 id와도 이어지지 않음, uuid와 모양도 다름) 보는 사람과 무관합니다(같은 기록의 멤버는 같은 사람에 대해 같은 키를 봄). 키는 저장하지 않고 응답할 때 계산합니다. **본인 id는 그대로** 둡니다(화면의 "나" 표시·내 선언·내 동의 판정이 `me.id`와 비교하고, 본인은 이미 자기 id를 앎).
- **한 곳에서**: 과제 서비스는 DTO를 만들 때 `loadMemberRefs(db, project, viewerId)`(server/modules/projects/member-refs.ts) 하나만 씁니다 — `person()`(이름 가림 + id 참조), `ref()`, `maskName()`(서버 안의 정렬·집계용, id는 실제 값), `resolve()`/`resolveAll()`(입력). 이전 `loadPersonMask`를 대신하며 문자열 치환은 하지 않습니다. 익명 스터디 기록이 아니면 모든 함수가 그대로 돌려줍니다.
- **입력**: 멤버를 가리키는 입력 — 할 일 담당자(`assigneeId`), 회의 로그 참석자(`payload.attendees`), 공개 후보 노출 방식(`exposure`의 키), 로그 작성자 필터(`?author=`) — 는 사용자 id 또는 가명 키를 받고 서버가 실제 id로 바꿉니다. 익명 스터디 기록에서는 본인 id와 이 과제 멤버(어느 상태든)의 가명 키만 받고, 모르는 키와 **다른 사람의 실제 id는 422 `not_member`**(그 필드)입니다(다른 곳에서 본 id로 "이 사람이 멤버인가"를 묻는 길을 막음). 익명이 아닌 과제는 지금처럼 사용자 id를 받고 가명 키는 422입니다. 이름 노출 422 `exposure: anonymous_study`는 키를 보기 전에 판정합니다. 역할 확인(`PUT /claim-revisions/:id/endorsement`)은 revision id가 대상이라 바뀌지 않습니다. 과제 쪽 멤버 관리(`…/members/:userId`·소유권 이전)는 study에서 원래 409 `study_managed`입니다.
- **저장은 그대로**: DB에는 실제 id가 남습니다(회의 참석자 payload, 공개 후보 `selection.exposure`·`excludedUserIds` 포함). 응답할 때 참석자·선택을 멤버 참조로 바꾸고, 응답 payload를 그대로 다시 보내는 수정은 실제 id로 되돌아와 "바뀐 것 없음" 판정도 같습니다. migration은 없습니다.
- **번호와 가입 시각**: "스터디 멤버 N"의 번호를 가입 순서가 아니라 **가명 키 순서**로 매깁니다(방 멤버 목록의 가입 순서와 맞춰 번호를 사람에게 잇지 못하게). 멤버가 들고 나면 번호가 바뀔 수 있습니다. 과제 멤버 목록의 `joinedAt`은 다른 멤버에게 null이고(방 멤버 목록의 가입 시각과 같은 트랜잭션 시각이라 맞춰 볼 수 있음), 순서는 역할 → 가린 이름입니다(`MemberDto.joinedAt: string | null`).
- **방장·운영진**: 기록 안에서는 방장·운영진(admin)도 다른 멤버와 **같은 가명**을 봅니다(과제 owner여도 예외 없음). 누가 방에 있는지는 커뮤니티 쪽 방 멤버 목록(`GET /community/spaces/:slug/members`, owner·admin만, 이름·실제 id)에서만 보고, 그 목록은 가명 키·번호를 싣지 않아 대응표가 생기지 않습니다. 초대 전용 스터디 방이라 방장은 이미 초대한 사람을 알지만, 기록의 어느 글이 누구 것인지는 응답으로 알 수 없습니다.
- **설정**: `PEERCHIVE_MEMBER_REF_PEPPER`(web만, 다른 pepper와 다른 값). 개발·테스트는 고정 개발용 값, production에서 없거나 약하면(32자 미만·자리표시) web이 시작하지 않습니다(server/plugins/member-refs.ts). 저장하지 않는 키라 바꿀 수 있고, 바꾸면 열려 있던 기록 화면의 키가 맞지 않아 새로 고쳐야 합니다(그 사이 입력은 422).

### 검사

- `apps/web/test/study-member-refs.integration.test.ts`: 라우트 트리(`api/v1/projects/**`·`logs/**`·`tasks/**`·`artifacts/**`·`claims/**`·`claim-revisions/**`·`milestones/**`·`candidates/**`·`uploads/**`·`publications/**`·`discord-bindings/**`와 과제 데이터를 싣는 `/me` 세 경로)를 읽어 모든 라우트 파일이 분류표에 있고 그 handler가 분류한 서비스 함수를 부르는지 확인합니다(DB 없이 실행 — 새 과제 라우트를 분류하지 않으면 실패). DB가 있으면 방장 A·멤버 B·C의 익명 기록(B는 A와 일반 팀 과제도 함께 씀)을 채운 뒤 **분류한 모든 경로를 A로 부르고**, 응답·오류 본문에 B·C의 실제 id·handle·이메일·이름이 없음을 확인합니다. 가명 키 입력(담당자·참석자·노출 방식·작성자 필터)이 실제 id로 저장되고 모르는 키·실제 id가 422인지, 보는 사람과 무관한지, 표시명 스터디 기록·일반 과제는 그대로인지도 봅니다.
- 이 검사로 선언 revision 이력의 이름·id 누출도 찾아 고쳤습니다.
- E2E `community-study-records.spec.ts`(익명 방): 기록 API(멤버·로그·할 일·장부·공개 준비) 응답에 멤버의 실제 id가 없고 다른 멤버는 `sm_…`.

### 한계

- 가명 키는 응답 본문의 사용자 참조만 바꿉니다. 시각(로그·확인·체크인 시각), 글 내용, 파일 이름처럼 사람이 직접 쓴 것은 가리지 않습니다.
- 방 멤버가 둘뿐이면 "나 아닌 사람"은 한 명이라 가명으로도 누구인지 압니다(익명 방의 본질적 한계).
- 동의 요청 목록(`/me/consent-requests`)·디스코드 주간 요약은 원래 id를 싣지 않고 이름만 가립니다.

> 2026-11-05: 표시명 스터디 기록도 같은 멤버 참조를 쓰고, 방 멤버 목록도 표시명·익명 방에서는 실제 id 대신 방별 키를 냅니다. [ADR 0060](0060-open-question-decisions.md)의 "구현 중 달라진 점"을 보세요.
