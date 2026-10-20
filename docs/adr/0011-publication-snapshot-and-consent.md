# 0011. 공개 후보와 동의: 저장된 공개 스냅샷 + manifest 해시에 묶인 동의

- 상태: 채택
- 날짜: 2026-10-20

## 맥락

T-11은 공개 후보·공개 전 점검·미리보기·팀원 동의입니다(DELIVERY_PLAN T-11: "선택 revision만 DTO 구성, manifest 변경 시 동의 재요청, 미동의자 자료 제외", 시나리오 D). 게시·철회·익명 공개 조회는 T-12입니다. 지켜야 할 불변조건(SYSTEM_DESIGN §1):

1. 공개 경로는 **승인된 공개 스냅샷만** 읽고, 비공개 작업 기록은 공개 API·미리보기·검색 등으로 새지 않습니다.
2. 공개는 선택한 로그 revision·산출물 버전·노출 이름만 담은 스냅샷이며, 동의는 그 manifest의 해시에 묶입니다.
3. 엠바고 중인 과제의 공개 요청은 서버가 거부합니다.

공개 수준은 요약(산출물 본문 제외)과 전체 두 가지이고, 산출물 사용 조건은 열람만(기본)·명시 라이선스·외부 원래 조건입니다(PROOFU_EVOLUTION_PLAN §9.1, §9.5). 공개 전 점검은 경고이며 막지 않습니다(§9.3, §15).

## 결정

### 테이블

- `publications`(프로젝트당 하나): `slug`(전체 unique, 3–60자, 예약어 금지), `level`, `status`(도메인 `PUBLICATION_STATES`), `current_release_id`(T-12가 채움, 지금은 null). 첫 후보를 만들 때 생깁니다.
- `publication_candidates`: 후보이자 게시되면 그대로 release가 되는 행(T-12가 `published` 상태와 `current_release_id`로 연결). `snapshot`(공개 DTO 전체), `manifest`, `manifest_hash`, `selection`(정규화한 선택, 비공개), `refs`(스냅샷 키 → 비공개 id), `checks`(점검 경고), `subject_digests`(당사자별 다이제스트), `derived_from_id`, `version`(공개 안에서 1부터), `status`(`awaiting_consent`·`ready`·`superseded`, T-12용 `published`·`withdrawn`). 열린 후보(awaiting_consent/ready)는 공개마다 하나(부분 unique)입니다. 스냅샷·manifest·해시는 만든 뒤 바꾸지 않습니다.
- `consents`: (후보, 당사자)마다 하나. `manifest_hash`(만들 때 후보 해시 복사), `scope text[]`, `status`(pending/granted/declined/revoked — revoked는 게시 후 철회용, T-12), `decided_at`, `note`(300자), `carried_from_candidate_id`.
- 별도 release 테이블을 두지 않은 이유: 동의는 후보의 해시에 묶이고 게시는 "그 후보를 그대로 공개"이므로, 행을 복사하면 같은 스냅샷이 두 곳에 생기고 어긋날 여지만 늘어납니다. T-12는 `access_epoch` 같은 철회용 열을 이 테이블에 더하면 됩니다.

### 공개 스냅샷: 하나의 매퍼, 저장 후 그대로 제공

- `buildPublicSnapshot(selected private rows) → PublicSnapshot`(`apps/web/server/modules/publication/snapshot.ts`)이 공개 데이터를 만드는 **유일한** 함수입니다. 결과를 후보에 저장하고, 미리보기(`GET /candidates/:id/preview`)는 저장된 값을 그대로 돌려줍니다. T-12 공개 페이지·포트폴리오도 이 값만 읽습니다. 화면은 `PublicSnapshotView` 하나로 미리보기·동의·공개 페이지를 그립니다.
- 허용 목록: DB 행을 펼치지 않고 필드를 하나씩 고릅니다. 로그 payload는 태그별 허용 키만(막힘: 증상·키워드·오류·시도·시간, 해결: 방법·시간, 결정: 선택지·기준·선택·지나고 보니, 검증: 대상·조건·결과·남은 질문, 회의: 결정·후속 + 참석자 가명 키).
- 항상 빼는 것: 이메일, 사용자 id(가명 키로 바꿈), 체크인, 비공개 메모(할 일·마일스톤 메모·스냅샷 메모), 확인 메모와 확인한 사람(상태와 개수만), 감사 정보, 이 사이트 origin을 가리키는 링크(비공개 경로)와 http/https 밖의 링크, 저장소 키·검사 정보·선언한 형식, 학기 id(학교·과목·코드·연도·학기 이름만), 익명 팀원의 로그 작성자(작성자 표시 없음), 다른 프로젝트 자료, 원래 파일 이름의 경로 부분(익명 팀원 이름·메일·전화·학번이 들어 있으면 `파일 N.확장자`). 선택하지 않은 로그·파일을 가리키는 연결(해결 대상·근거·마일스톤)은 끊습니다.
- 파일은 버전 id·형식·크기·표시 이름·사용 조건만. 내용은 T-12의 release 확인 경로로만 내려줍니다. 요약 공개에는 파일·마일스톤 스냅샷이 없습니다. 전체 공개에서 고른 마일스톤의 스냅샷 파일은 자동으로 포함됩니다.
- 사후 작성 표시(`retrospective`)와 로그 출처(`source`)를 옮깁니다(T-07). 기록 시각과 자기 기입 수행일을 따로 둡니다.
- 키: 팀원·로그·선언·마일스톤은 `sha256("peerchive-public-key:<publicationId>:<kind>:<id>")` 앞 12자(`m_`·`l_`·`c_`·`ms_`). 내부 id를 드러내지 않고 다른 공개와 연결되지 않으며, 같은 공개의 다음 후보에서도 같은 항목은 같은 키입니다(다른 항목을 빼도 남은 항목의 참조가 바뀌지 않음). 익명 팀원은 키 순서대로 "팀원 A, B, …"입니다.
- 누출 테스트: 모든 비공개 열에 표식 문자열을 넣은 행(단위 테스트)과 DB(통합 테스트)로 스냅샷·미리보기 응답 어디에도 표식·이메일·내부 id가 없음을 확인합니다.

### manifest와 해시

- manifest = 고정한 로그 revision(id·번호), 마일스톤 id·version·스냅샷 버전, 선언 revision과 그때의 확인 상태·개수, 파일 버전·표시 이름·사용 조건, 사람별 키·노출 방식·표시 이름, 제외한 사람, 수준·제목·요약·slug, 그리고 `contentDigest = sha256(canonicalJson(snapshot))`. 목록은 id 순으로 정렬합니다.
- `manifest_hash = sha256(canonicalJson(manifest))`. `canonicalJson`(@peerchive/domain)은 키를 정렬하고 배열 순서를 지키며 undefined 키를 빼고, Date·Map·BigInt·NaN·순환을 거부합니다(정규화 없이 보이는 그대로). 스냅샷 다이제스트가 들어 있으므로 공개될 글자 하나가 바뀌어도 해시가 바뀝니다. 같은 선택을 다시 만들면 같은 해시입니다(테스트).
- 로그·선언은 후보를 만들 때의 **지금 revision**으로 고정합니다. 나중에 고쳐도 그 후보에는 반영되지 않고, 반영하려면 새 후보를 만듭니다.

### 후보 만들기

- `POST /projects/:id/publication-candidates`: active owner/editor(reviewer/viewer 403, 비멤버 404). 트랜잭션 안에서 프로젝트 행을 잠근 뒤 `assertPublishable`(ADR 0010)로 엠바고를 확인합니다(409 `embargo_active` + `until`).
- 입력: `level`, `title`(≤80), `summary`(≤1000, 학생이 쓴 요약), `slug`, `logIds`·`milestoneIds`·`claimIds`·`artifactVersionIds`, `exposure{userId: name|anonymous}`(기본 익명), `usageTerms{versionId: view_only | license(SPDX 허용 목록) | external(source)}`, `consentSelf`.
- 오류: 같은 프로젝트에 없으면 422 `not_found`, 파일이 clean이 아니면 422 `not_clean`(마일스톤 스냅샷도), 요약 공개에 파일 422 `not_allowed`, 멤버가 아닌 노출 대상 422 `{exposure: 'not_member'}`, slug 422 `reserved`/`taken`/`invalid_format`, 게시됨·제한됨 공개 409 `publication_locked`(T-12/T-15가 규칙을 정함).
- 새 후보를 만들면 열린 이전 후보는 `superseded`가 되고 그 동의는 쓰이지 않습니다. 공개 상태는 도메인 전이로 draft로 되돌린 뒤(`revise_candidate`, ready면 `reopen_candidate` 먼저, 철회됨이면 `start_new_candidate`) `create_candidate`로 awaiting_consent가 됩니다.

### 동의 당사자

- 이름이 공개되거나 로그를 썼거나 회의 참석자로 표시되거나 역할 선언을 했거나 포함된 파일(마일스톤 스냅샷 포함)을 올린 모든 사람 — 지금 멤버가 아니어도(나간·내보낸 멤버) 포함합니다. 익명으로 표시되더라도 자기 내용이 담기므로 당사자입니다. 확인만 한 사람은 이름·메모가 공개되지 않으므로 당사자가 아닙니다.
- 후보를 만든 사람은 공개 제목·요약을 쓴 사람이므로 항상 당사자(`title_summary`)입니다. 그 동의는 요청에서 `consentSelf: true`를 명시했을 때만 granted로 기록합니다(조용한 자기 동의 없음).
- `scope`: name / anonymous_label / logs / meetings / claims / artifacts / title_summary.
- 후보는 그 과제의 active 멤버와 그 후보의 당사자(나간 멤버 포함)만 볼 수 있고, 그 밖에는 404입니다.

### 동의 결정

- `POST /candidates/:id/consents {decision: granted|declined, manifestHash, note?}`: 당사자 본인만(볼 수는 있지만 당사자가 아니면 403 `not_subject`). 대체된 후보면 409 `superseded`(+ 지금 열린 후보 id), 해시가 다르면 409 `stale_manifest`(+ 현재 해시). 게시 전까지 결정을 바꿀 수 있습니다. 대리 동의는 없습니다.
- `GET /me/consent-requests`: 열린 후보의 내 pending 동의(과제 이름·공개 제목·범위·미리보기 링크).

### 미동의자 제외와 동의 이어받기

- `POST /candidates/:id/exclude-declined`(owner만, 거절이 없으면 409 `no_declined`): 거절한 사람의 로그·선언·올린 파일(스냅샷 포함)·이름과 회의 참석 표시를 뺀 새 후보를 만듭니다. 이전 후보가 고정한 revision을 그대로 쓰고(그 사이 고친 내용을 몰래 넣지 않음), 마일스톤·이름 등은 다시 읽습니다. 해시는 당연히 바뀝니다.
- **이어받기 규칙**: 당사자마다 "자기 관련 부분" = 공통 틀(수준·제목·요약·slug·과목·사후 작성) + 마일스톤 전체 + 자기 팀원 항목(표시 이름) + 자기가 쓴 로그와 참석한 회의 로그 + 자기 선언 + 자기가 올린 파일의 canonical 다이제스트를 후보에 저장합니다. 미동의자 제외 후보에서 이전 후보에 granted였고 이 다이제스트가 **같은** 사람만 동의를 이어받고(`carried`), 나머지는 다시 요청합니다. 예: 거절한 사람이 참석자로 들어 있던 회의 로그를 쓴 사람은 그 로그가 바뀌므로 다시 동의해야 합니다.
- 안전한 이유: 미동의자 제외는 고정 revision을 유지한 채 항목을 빼기만 하고, 그 밖에 바뀔 수 있는 것(공통 틀·마일스톤·표시 이름·선언 확인 상태·근거 연결)은 모두 누군가의 자기 관련 부분에 들어 있어 그 사람이 다시 동의해야 합니다. 일반적인 새 후보(내용 수정)에서는 이어받지 않고 모두 다시 요청합니다(manifest 변경 시 동의 재요청).
- 응답하지 않은 사람은 자동으로 빼지 않습니다(owner가 그 사람의 내용을 빼고 새 후보를 만들 수 있음). 탈퇴·연락 두절로 영원히 pending인 경우의 처리 정책은 열린 질문입니다.

### ready 판정과 보류

- 도메인 `transition('awaiting_consent', 'mark_ready')`: 모든 당사자 granted(현재 해시) + 스냅샷의 모든 파일 clean + 열린 보류 없음. 동의 결정과 후보 조회(`GET /candidates/:id`, 공개 준비 화면) 때마다 다시 계산해 후보·공개 상태를 맞추고, ready였는데 조건이 깨지면 새 도메인 이벤트 `reopen_candidate`(ready → awaiting_consent)로 돌립니다. worker가 검사 상태를 바꿀 때 밀어 넣지는 않고 읽을 때 다시 계산합니다(clean 파일이 다시 바뀌는 경로는 지금 없고, 게시(T-12)가 어차피 전부 다시 검사합니다).
- **보류(hold)는 미룹니다**: 신고·운영 조치(T-15)와 함께 테이블을 만들며, 지금은 열린 보류가 없는 것으로 봅니다(`hasOpenHold: false`).
- 엠바고는 ready 판정에 넣지 않지만(도메인 규칙) 후보의 `blockers`에 함께 보여 줍니다. 후보 DTO의 `blockers`: consent_missing(+ 상태), consent_stale, file_not_clean, hold_open, embargo_active, superseded.
- 잠금 순서는 프로젝트 → 공개 → 후보이며, 동의 결정도 공개 → 후보 순서로 잠급니다.

### 공개 전 점검(경고)

- 규칙(`@peerchive/domain` `runPublicationChecks`): 한국 전화번호, 메일 주소(예시 도메인·git SSH 주소 제외), 주민등록번호 형태(날짜·성별 자리 검사), 학번 같은 8–10자리 수(19xx·20xx 시작, 날짜·단위·해시·소수 제외), 사설·로컬 주소 URL, 문제지·정답·답안·해답·기출·solution·answer 파일 이름(`resolution` 같은 단어 안은 제외), 긴 코드(울타리 또는 코드 같은 줄 15줄 이상), 익명으로 고른 팀원의 이름. 규칙마다 오탐 방지 테스트가 있습니다.
- 공개될 스냅샷(+ 원래 파일 이름은 문제지·답안 규칙만)에만 돌리고, 결과는 위치(제목·요약·로그 키+필드·선언·마일스톤·파일)와 **가린 표본**만 후보에 저장합니다. 화면은 로그 고치기 링크(`/projects/:id#log-<id>`)를 줍니다. AI·경량 모델 점검은 P1입니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /projects/:id/publication` | 200 | 비멤버 404 |
| `POST /projects/:id/publication-candidates` | 201 | 403(reviewer/viewer), 404, 409 `embargo_active`·`publication_locked`, 422 |
| `GET /candidates/:id`, `GET /candidates/:id/preview` | 200 | 멤버·당사자가 아니면 404 |
| `POST /candidates/:id/consents` | 200 | 404, 403 `not_subject`, 409 `superseded`·`stale_manifest`, 422 |
| `POST /candidates/:id/exclude-declined` | 201 | 404, 403(owner 아님), 409 `no_declined`·`superseded`·`embargo_active` |
| `GET /me/consent-requests` | 200 | 401 |

## 결과

- 공개 데이터의 출처가 저장된 스냅샷 하나라서 T-12 공개 경로는 비공개 테이블을 읽지 않고, 누출 회귀는 매퍼 하나의 테스트로 지킬 수 있습니다. 대신 이름 변경 같은 원본 변경은 새 후보를 만들어야 반영됩니다.
- 동의가 해시에 묶여 "동의한 뒤 내용이 바뀌는" 경우를 서버가 막습니다. 미동의자 제외에서만 좁게 이어받으므로 팀원이 같은 내용에 여러 번 답하는 부담은 줄지만, 다른 수정에서는 모두 다시 답해야 합니다.
- slug는 게시 전 후보에서도 자리를 차지합니다(게시하지 않은 과제가 이름을 잡아 둘 수 있음). 게시 후 slug 변경 규칙은 T-12가 정합니다.
- 한계: 보류(hold) 없음, 점검은 규칙 기반 경고뿐(타인 실명 일반 탐지는 P1), 응답 없는 당사자 처리 정책 미정, 파일 내용 미리보기 없음(T-12 release 경로), worker가 검사 상태 변경을 후보에 밀어 넣지 않음(읽을 때 다시 계산).

## 대안

- **공개 조회 때 비공개 테이블에서 DTO를 만들기**: 저장이 가볍지만 공개 경로가 비공개 테이블을 읽게 되고(불변조건 1 위반 위험), 동의한 내용과 보이는 내용이 어긋날 수 있습니다.
- **manifest에 id만 넣고 해시**: 마일스톤 제목·표시 이름·확인 상태처럼 id가 같아도 바뀌는 값이 동의 없이 바뀔 수 있습니다. 그래서 스냅샷 다이제스트를 넣습니다.
- **미동의자 제외 때 모두 다시 동의**: 가장 단순하고 안전하지만, 자기 내용이 그대로인 팀원에게 같은 질문을 반복합니다. 자기 관련 부분 다이제스트로 좁게 이어받는 쪽을 골랐습니다.
- **순서 번호 키(l1, l2…)**: 읽기 쉽지만 항목 하나를 빼면 뒤 항목의 키와 참조가 모두 바뀌어 이어받기 판정이 깨집니다.
- **release 테이블 분리**: SYSTEM_DESIGN §6.5의 이름을 그대로 따르지만 같은 스냅샷을 복사해야 합니다. 후보 행을 release로 쓰고 상태로 구분합니다.
