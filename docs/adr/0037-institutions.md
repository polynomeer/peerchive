# 0037. 기관 일반화·인증 수단과 P2 기능 플래그: `schools`에 `kind`를 더한 기관 + 대학이 아닌 기관만 쓰는 초대 코드(HMAC만)·기수 승인(비승인 수단 인증자 2명)·수료증 확인(결정 뒤 worker 삭제 + 삭제 장부 `retention`) + 기본 꺼진 영역별 플래그

- 상태: 채택
- 날짜: 2026-11-01

## 맥락

I-01은 DELIVERY_PLAN §4.3 P2 백로그의 기관 확장 첫 항목입니다: "`institution`에 `kind`·`method` 추가 후 기존 대학 메일 인증 회귀 0건. 초대 코드 해시·만료·사용 한도·철회, 기수 승인 2명(승인자는 비승인 수단 인증자만), 수료증 결정 후 7일 안에 파일 삭제와 `DeletionLedger` 기록". 수용 시나리오 §5.3 Z는 "만료되었거나 사용 한도를 넘은 초대 코드는 거부, 기관이 참여하지 않는 기수는 같은 기수 멤버 2명의 승인, 기수 승인으로만 인증된 멤버의 승인은 세지 않음, 수료증 확인은 결정 직후 파일 삭제와 삭제 기록"입니다. 관련 설계와 앞선 결정:

- SYSTEM_DESIGN §6.7.2: Institution(kind university/bootcamp/training_program/club_federation), Cohort(기관 + `12기`, 대학에서는 쓰지 않음), InstitutionAffiliation(method email/invite_code/cohort_approval/certificate_check, cohort_id?, standing student/alumni/trainee/graduate), InstitutionInviteCode(code_hash, 만료·사용 한도·철회, 원문 저장 안 함), CohortApproval(필요 승인 2명, **승인자는 `cohort_approval`이 아닌 수단으로 인증된 멤버**), CertificateCheck(운영자 수동 확인, 격리 버킷, 결정 즉시(최대 7일) 삭제 + DeletionLedger, 원본·OCR·수료증 번호 보관 안 함). §8.4: 초대 코드 발급·철회는 기관 운영진(자기 기관)·운영자, 수료증 확인은 운영자 확인 역할만. §9.2 API 초안.
- ADR 0018: 소속 테이블은 이미 `institution_affiliations`(kind·method 열)이고 기관 테이블 대신 `schools`를 가리킵니다. "P2(I-01)에서 `schools`를 기관으로 일반화(이름 변경 또는 뷰 + `kind`)"를 남겼습니다. ADR 0007(파일 격리·검사·메타데이터 제거), 0016(삭제 장부: 개인정보 없는 HMAC + 재적용).
- DELIVERY_PLAN §7 GA 게이트: P2는 GC 통과·§6.1 전환 근거·협력 기관 확보·수료증 파일 삭제 절차 검토 뒤에 엽니다. 코드는 먼저 만들되 여는 것은 운영 결정입니다.

## 결정

### 1. P2 기능 플래그: 영역별, 기본 꺼짐, 서버가 판정

- `@peerchive/domain` `features.ts`(`parseFeatureFlags`)와 web `server/modules/features.ts`(`featureFlags`·`isFeatureOn`·`requireFeature`). 영역은 `alumni`(A-01~A-04)·`topics`(A-05·A-06)·`institutions`(I-01·I-02). 환경 변수 `PEERCHIVE_FEATURE_P2_ALUMNI`·`_TOPICS`·`_INSTITUTIONS`, 그리고 셋을 한 번에 켜는 `PEERCHIVE_FEATURE_P2`(영역 변수가 있으면 그 값이 우선 — `P2=on` + `P2_ALUMNI=off` 가능).
- 값: `on`·`1`·`true`·`yes`면 켬, 그 밖(빈 값·`off`·오타)은 꺼짐. 잘못 쓴 값으로 열리지 않게 했습니다. 요청마다 환경을 읽습니다(바꾸려면 재시작, 테스트는 `setFeatureEnvForTesting`).
- 꺼진 영역의 **서비스 함수가 맨 앞에서 404**(`requireFeature`)를 던집니다. 경로 처리기가 아니라 서비스에 두어 테스트·다른 호출 경로도 같은 판정을 받습니다. 404인 이유: 기능이 있는지조차 드러내지 않는 기존 규칙(운영자 화면·비공개 공간)과 같게.
- 화면은 `GET /api/v1/features`(로그인 없이, `{alumni, topics, institutions}`)를 `useFeatures()`로 한 번 읽어 진입점(설정의 기관 인증 섹션·운영자 수료증 링크)을 숨깁니다. 권한 판정은 아닙니다.
- 플래그가 막지 않는 것: 기존 C-01 학교 메일 인증(꺼짐·켜짐 모두에서 기존 테스트 전부 통과 — 테스트 파일을 두 번 돌림), 수료증 파일 삭제 worker 작업(꺼도 이미 올라온 파일은 지워야 함), 운영자 CLI(준비는 미리 할 수 있음, 사용자는 플래그 전까지 코드를 쓸 수 없음).
- A-01~A-07·I-02는 새 서비스 맨 앞에 `requireFeature('<영역>')`를 두고 화면은 `useFeatures()`를 씁니다.

### 2. 기관 = `schools` + `kind` (migration `0033_institutions`)

- **이름을 바꾸지 않고 열을 더했습니다**: `schools.kind institution_kind not null default 'university'`. 기존 행은 모두 university가 됩니다. `institutions` 이름 변경·뷰는 catalog·병합·허브·커뮤니티·피드의 모든 `schools` 조인을 흔들고 얻는 것이 없습니다(ADR 0018이 남긴 선택지 중 "kind만"). 코드·문서에서는 기관(Institution) = `schools` 행입니다. 소속의 `school_id` 열 이름도 그대로입니다(같은 이유).
- enum 값 추가: `institution_kind`에 `bootcamp`·`training_program`·`club_federation`(설계 §6.7.2의 값 그대로), `affiliation_method`에 `invite_code`·`cohort_approval`·`certificate_check`. 같은 migration에서 새 enum 값을 쓰지 않습니다(drizzle migrate는 한 트랜잭션이고, PostgreSQL은 `ADD VALUE`한 값을 같은 트랜잭션에서 못 씀). check는 `method::text`로 비교합니다(0021과 같은 방식). 빈 DB에서 처음부터 migrate되는 것도 확인했습니다.
- **대학이 아닌 기관은 운영자만 만듭니다**(`POST /api/v1/operator/institutions {name, kind}`, CLI `institution create`). 학생이 만드는 학교(ADR 0010)는 언제나 university입니다. 이름 키는 학교와 같은 `name_key` 정본 unique를 씁니다(같은 이름이면 409 `already_exists`).
- 대학과 섞이지 않게: 학교 검색(`GET /schools`, 과목 고르기·학교 인증 화면)에는 university만, 기관 검색은 `GET /api/v1/institutions?q=&kind=`(플래그). 과목은 대학에만(`createCourse` 422 `schoolId: not_university`, 설계 "과목·과목 허브는 kind = university에서만"). 병합은 university끼리만(409 `not_university` — 기수·초대 코드·수료증을 옮기는 규칙을 아직 두지 않음).
- **새 인증 수단은 대학이 아닌 기관에서만**(422 `institutionId: not_supported`). 대학은 학교 메일 인증만 그대로입니다. 그래서 과목 허브 작성 자격·공식 학교 페이지·학교 메이트 추천 등 대학 소속을 보는 코드는 바뀌지 않습니다(대학 소속은 늘 메일 인증).
- 재학 상태: 설계의 `trainee/graduate`를 따로 두지 않고 **C-01 값(student/alumni)을 그대로 쓰고 글자만 바꿉니다**(`standingLabelFor`: 대학 재학생/졸업생, 그 밖 수강생/수료생). enum·분석 props(`affiliation_verified{standing}`)·전환 규칙(student → alumni만)을 그대로 쓸 수 있고, A-05의 `(기관, 신분)` 임계값도 같은 두 값으로 셉니다. 공개 배지는 대학이 아니면 "○○ 인증 · 수료생".

### 3. 소속 행의 변화

- `institution_affiliations`: `email_domain` null 허용(메일 인증은 check로 필수 유지), `cohort_id`(→ `institution_cohorts`, 기수 승인은 check로 필수), `method`별 check — 메일이 아니면 `email_hash` 없음, 메일 인증의 열린 행은 해시 필수(기존 규칙). `revoked_reason`에 `certificate_rejected`.
- 한 사용자·기관에 진행 중(pending/active) 행 하나라는 부분 unique는 그대로입니다. 새 요청(어떤 수단이든)은 같은 기관의 pending을 expired로 대체하고(메일 요청과 같은 규칙), active가 있으면 409 `already_verified`.
- `institution_cohorts(school_id, label, label_key)` — `label_key`(소문자·공백 제거)로 `(기관, 기수)` 유일. 사용자가 기수 승인·수료증 요청을 낼 때나 운영자가 기수 코드를 낼 때 없으면 만듭니다. 대학에서는 만들지 않습니다(학번 미수집 원칙).
- `GET /me/affiliations` DTO에 `method`·`institutionKind`·`cohortLabel`·`cohortApprovals{count, required}`·`certificate{uploaded, scanStatus, result, decidedAt}`를 더했습니다(`emailDomain`은 null 가능). 운영자 소속 목록 DTO의 키는 바꾸지 않았습니다(`emailDomain`만 null 가능).
- worker `affiliation-codes`는 메일 인증 pending만 만료시킵니다(전에는 코드가 없는 모든 pending을 만료 — 새 수단의 요청을 한 시간 뒤 지울 뻔함). 기수 승인 요청은 30일 뒤 expired.

### 4. 초대 코드

- `institution_invite_codes(school_id, cohort_id?, code_hash unique, issued_by?, expires_at, max_uses 1–1000, used_count ≤ max_uses, revoked_at?)`. **원문 열이 없습니다**: `code_hash` = HMAC-SHA256(`PEERCHIVE_AFFILIATION_PEPPER`, `invite-code:v1:` + 정규 코드). 원문은 발급 응답(API·CLI 출력)에만 한 번 있고 목록·감사·로그에 없습니다(테스트가 행의 키 목록과 JSON을 확인).
- 코드: Crockford base32 12자(60비트, `XXXX-XXXX-XXXX`), 입력은 대소문자·공백·하이픈 무시, O→0·I/L→1. 정규 코드의 해시로 한 번에 찾으므로 상수 시간 비교가 필요 없습니다(DB가 해시로 찾음).
- 발급: 운영자만(`POST /api/v1/operator/institutions/:id/invite-codes {maxUses, expiresInDays?=14(1–90), cohortLabel?}`), 목록 `GET …/invite-codes`, 철회 `POST /api/v1/operator/invite-codes/:id/revoke`(멱등, 이미 만든 소속은 그대로). CLI `institution issue-code|list-codes|revoke-code`(웹과 같은 pepper 필요). 감사 `invite_code.issue{schoolId, cohort(bool), maxUses}`·`.revoke{schoolId}`. 기관 운영진 발급은 I-02(`InstitutionAdmin`)에서 같은 서비스에 권한만 더합니다.
- 사용: `POST /api/v1/me/affiliations/invite-code {code, standing}` → 201 + active(method invite_code, 코드의 기수). 순서: 형식 422(세지 않음) → **한도(사용자 10회·IP 30회/시간, 맞든 틀리든 셈)** 429 → 없는 코드 422 `invite_code_invalid` → 철회 410 `invite_code_revoked` → 만료 410 `invite_code_expired` → 한도 소진 410 `invite_code_exhausted` → 이미 active 409. 코드 행을 잠그고 `used_count + 1`을 같은 트랜잭션에서 합니다(동시 사용이 한도를 넘지 않음, DB check도). 감사 `affiliation.verify{schoolId, method, standing, inviteCodeId}`, 분석 `affiliation_verified{standing}`.
- 철회·만료·소진을 구별해 알려 주는 것은 받아들였습니다: 60비트 코드를 맞히지 못하면 어느 상태인지도 알 수 없고, 코드를 가진 사람에게는 "새 코드를 요청하세요"가 필요합니다.

### 5. 기수 승인

- `POST /api/v1/me/affiliations/cohort-approval {institutionId, cohortLabel, standing}` → 201 + pending(사용자당 시간당 10회). 기관이 참여하지 않는 기수를 위한 수단입니다.
- `cohort_approvals(affiliation_id, approver_user_id, approver_affiliation_id, created_at)`, 기본 키 `(affiliation_id, approver_user_id)` — 한 사람은 한 요청에 한 번.
- **승인자 자격**(`isEligibleCohortApprover`): 같은 정본 기관·같은 기수의 active 소속이고 그 소속의 method가 `cohort_approval`이 아님(초대 코드·수료증 확인·메일), 계정 active. 승인할 때의 승인자 소속 id를 남겨 나중에 그 인증이 사칭으로 판정되면 승인 기록을 찾을 수 있게 했습니다(자격 제한 절차는 RUNBOOK, 자동 연쇄 취소는 하지 않음).
- 요청을 찾는 경로는 **요청자가 직접 보내는 링크뿐**(`/affiliations/approve/:id`)입니다. 같은 기수 멤버에게 대기 요청 목록을 보여 주지 않습니다(기수 멤버 명부·요청자 노출이 생김). `GET /api/v1/affiliations/:id/cohort-approval`·`POST …/cohort-approvals`는 자격 없는 사람에게 404(요청이 있는지도 모름), 본인 422 `self_approval`, 두 번째 승인 409 `already_approved`, 끝난 요청 409 `not_pending`. 승인자에게 보이는 것은 기관·기수·요청자의 계정 이름·승인 수뿐입니다.
- 두 번째 승인이 들어오는 트랜잭션에서 요청 행을 잠근 채 active로 바꿉니다(감사 `cohort_approval.approve{schoolId, approvals, verified, approverMethod}`, 인증 감사는 actor 없이 `affiliation.verify{method: cohort_approval}`).
- 기수 승인으로 인증된 사람은 그 기수의 다른 요청을 승인할 수 없으므로, 첫 두 사람은 초대 코드나 수료증으로 들어와야 합니다(승인 연쇄로 가짜 기수를 만들 수 없음).

### 6. 수료증 확인

- `certificate_checks(affiliation_id unique, user_id, object_key?, declared_type, file_extension, byte_size ≤ 10MB, sha256, uploaded_at, scan_status·reason·engine·attempts·scanned_at, media_type, result approved|rejected, reviewed_by, decided_at, file_purged_at)`. **원래 파일 이름은 저장하지 않습니다**(확장자만 — 수료증 파일 이름에는 이름이 들어 있는 경우가 많음). OCR·수료증 번호는 다루지 않습니다.
- 흐름: `POST /api/v1/me/affiliations/certificate {institutionId, standing, cohortLabel?, declaredType, fileName, byteSize}` → 201 + pending + `uploadUrl` → `PUT /api/v1/me/affiliations/:id/certificate`(본문 = 파일, 산출물 업로드와 같은 크기 검사·413/422·CSRF) → outbox `certificate-scan` → worker `scanCertificateCheck`(@peerchive/files, 산출물과 같은 `judgeContent`: 판별·형식/확장자 대조·내장 콘텐츠·악성코드, 그다음 메타데이터 제거). 형식은 PNG·JPEG·WebP·PDF.
- **파일은 격리 키(`quarantine/<uuid>`)에서 옮기지 않습니다.** 통과하면 메타데이터를 지운 내용으로 같은 격리 키를 원자적으로 바꿔 쓰고(`writeObject`), `clean/` 키로 가지 않으므로 산출물 내용 경로로는 어떤 경우에도 내려가지 않습니다(설계 "격리 버킷에만"). 주인 없는 격리 파일 정리는 수료증 키를 지우지 않습니다(지우는 것은 아래 작업뿐, 장부 기록 때문에).
- 운영자: `GET /api/v1/operator/certificate-checks?status=pending|decided`(사용자 id·계정 이름·기관·기수·재학 상태·검사 상태·시각 — 이름 대조에 계정 이름이 필요), `POST …/:id/file-url` → **60초 서명 URL**(HMAC(affiliation pepper, 확인 id + 그 운영자 id + 만료)), 감사 `certificate_check.view`(id만). `GET …/:id/file?exp=&sig=`는 운영자 세션 + 그 운영자의 서명 + 만료 전 + **결정 전·요청 pending·검사 통과·파일 있음**이 모두 맞을 때만 내용(산출물과 같은 nosniff·sandbox CSP·no-store·no-referrer, 이름은 고정 `certificate`), 그 밖은 404. 다른 운영자에게 URL이 넘어가도 열리지 않습니다.
- 결정 `POST …/:id/decision {result}`: 승인 → 소속 active, 거절 → revoked `certificate_rejected`. `decided_at`·`reviewed_by`를 남깁니다(A-07 "수료증 확인 시간"은 `decided_at - uploaded_at`). 이미 결정 409 `already_decided`, 검사 전·격리·사용자가 취소 409 `not_reviewable`. 감사 `certificate_check.decide{result, schoolId, affiliationId}`. **결정 뒤에는 운영자도 파일을 받을 수 없습니다**(이미 받은 서명 URL도 404).
- 기관 운영진(I-02)은 수료증을 볼 수 없습니다(§8.4 "운영자 확인 역할만").

### 7. 파일 삭제와 삭제 장부(`retention`)

- worker 주기 작업 `certificate-files`(기본 `*/10 * * * *`, `PEERCHIVE_CRON_CERTIFICATE_FILES`): 결정함·요청이 끝남(취소·대체·만료)·검사 격리/실패·하루 안에 올리지 않음·30일 동안 결정 없음(@peerchive/domain `certificateFileDue`)이면 저장소 파일을 지우고 `object_key = null`, `file_purged_at`. 오래되었거나 못 쓰는 pending 요청은 expired로. 결정 뒤 7일 한도 안이 아니라 **결정 뒤 10분 안**에 지웁니다(설계 "결정 즉시(최대 7일)"). 웹 요청 안에서 지우지 않는 이유: 파일 삭제·장부 기록을 한 곳(재시도 가능한 작업)에 모으려고. P2 플래그와 무관하게 돕니다.
- 장부: 올린 파일을 지울 때마다 `deletion_ledger` 한 행 — `subject_hash` = HMAC(`PEERCHIVE_DELETION_PEPPER`, **수료증 확인 id**), `entity_kind = certificate_file`, `count = 1`, `requested_at` = 결정 시각(분), **`source = retention`**(새 값, check 갱신). 사용자 id·기관·파일 정보가 없습니다.
- 사용자 id가 아닌 확인 id로 HMAC하는 이유: 재적용(`ops:reapply-deletions`)은 장부의 subject와 사용자 id HMAC이 맞으면 **그 계정을 정리**합니다. 사용자 id로 넣으면 수료증만 지운 살아 있는 계정이 복구 뒤 재적용에서 통째로 지워집니다. 그래서 재적용은 계정 정리 대상을 `purge`·`reapply` 항목으로만 좁히고, `retention`·`certificate_file` 항목은 복구된 `certificate_checks` 행 id의 HMAC과 맞춰 **남은 파일만** 다시 지웁니다(계정은 그대로, 테스트). 장부 파일 형식은 같고 `source`에 `retention`이 더해졌습니다.
- 탈퇴 정리(`purge.ts`): 그 사람의 수료증 확인 행과 남은 파일(장부 `certificate_checks`·`certificate_files`, 파일은 커밋 직전 삭제), 그 사람이 한 기수 승인과 그 사람 요청이 받은 승인(`cohort_approvals`), 소속 행. 기수·초대 코드 행은 기관 기록이라 남깁니다(만든 사람 칸은 가명 처리된 users). 이미 그 사람의 승인으로 인증된 다른 사람의 소속은 그대로입니다.

### 8. 화면

- `/settings/affiliations`: 플래그가 켜져 있을 때만 "부트캠프·교육기관 인증" 섹션(방법 고르기: 초대 코드 / 기수 승인 / 수료증 확인, 기관 검색, 기수, 수강생/수료생, 파일). 내 인증 목록에 수단·기수·승인 수·승인 링크·수료증 검사/결정 상태, 메일 도메인은 메일 인증에만. 기존 학교 메일 섹션은 그대로입니다.
- `/affiliations/approve/:id`: 자격 있는 같은 기수 멤버의 승인 화면(그 밖은 "찾을 수 없습니다", 확인 대화상자).
- `/operator/certificates`: 대기/결정함, 파일 보기(60초, 새 창, noopener·noreferrer), 승인·거절(확인 대화상자). 운영자 첫 화면의 링크는 플래그가 켜져 있을 때만.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| 모든 새 경로 | – | 플래그 꺼짐 404 |
| `GET /features` | 200 | – |
| `GET /institutions?q=&kind=` | 200 | 401, 422 |
| `POST /operator/institutions` | 201 | 401, 403 `operator_only`, 409 `already_exists`, 422 `name`·`kind` |
| `POST /operator/institutions/:id/invite-codes` | 201(+`code` 한 번) | 401, 403, 404, 422 `institutionId: not_supported`·`maxUses`·`expiresInDays`·`cohortLabel` |
| `GET /operator/institutions/:id/invite-codes` | 200 | 401, 403, 404 |
| `POST /operator/invite-codes/:id/revoke` | 200(멱등) | 401, 403, 404 |
| `POST /me/affiliations/invite-code` | 201 | 401, 409 `already_verified`, 410 `invite_code_revoked`·`_expired`·`_exhausted`, 422 `code: invalid_format`·`invite_code_invalid`, 429 |
| `POST /me/affiliations/cohort-approval` | 201 | 401, 404, 409 `already_verified`, 422 `institutionId: not_supported`·`cohortLabel`, 429 |
| `GET /affiliations/:id/cohort-approval` | 200 | 401, 404(없음·자격 없음·본인) |
| `POST /affiliations/:id/cohort-approvals` | 201 | 401, 404, 409 `already_approved`·`not_pending`, 422 `self_approval` |
| `POST /me/affiliations/certificate` | 201(+`uploadUrl`) | 401, 404, 409 `already_verified`, 422 `declaredType`·`fileName`·`byteSize`·`institutionId`, 429 |
| `PUT /me/affiliations/:id/certificate` | 200 | 401, 403(CSRF), 404, 409 `already_uploaded`·`not_pending`, 413, 422 `byteSize: size_mismatch` |
| `GET /operator/certificate-checks` | 200 | 401, 403 |
| `POST /operator/certificate-checks/:id/file-url` | 200 | 401, 403, 404(결정 뒤·검사 전·파일 없음) |
| `GET /operator/certificate-checks/:id/file` | 200(내용) | 401, 403, 404 |
| `POST /operator/certificate-checks/:id/decision` | 200 | 401, 403, 404, 409 `already_decided`·`not_reviewable`, 422 `result` |
| (기존) `POST /schools/:id/courses` | – | 대학이 아닌 기관 422 `schoolId: not_university` |
| (기존) `POST /operator/schools/:id/merge` | – | 대학이 아닌 기관 409 `not_university` |

## 결과

- 대학 메일 인증은 그대로이고(기존 통합 테스트를 플래그 꺼짐·켜짐에서 모두 통과), 대학이 아닌 기관은 세 수단으로 인증합니다. 플래그를 켜기 전에는 새 경로가 모두 404이고 화면 진입점이 없습니다.
- DB·백업이 새도 초대 코드 원문은 나오지 않습니다(pepper가 따로 있어야 하고, 그래도 추측한 코드를 확인하는 것뿐). 수료증 파일은 결정 뒤 10분 안에 지워지고 장부에는 확인 id의 HMAC만 남습니다.
- 운영 부담: 협력 기관마다 운영자가 기관을 만들고 코드를 내야 합니다(I-02 전까지). 수료증 확인은 운영자 수작업이며 처리 시간은 `decided_at`으로 잽니다(A-07).
- 한계: 기수 승인 링크를 받은 사람이 실제 같은 기수인지는 승인자의 판단입니다(사칭 판정 시 승인 기록으로 찾기만 하고 자동 연쇄 취소는 없음). 대학의 초대 코드·수료증 인증(메일이 없는 졸업생 등)은 지원하지 않습니다 — 필요하면 대학에도 수단을 열되 과목 허브 자격을 메일 인증으로 좁히는 결정을 먼저 합니다. 대학이 아닌 기관은 병합할 수 없습니다(잘못 만든 기관은 운영자가 DB에서 정리 — RUNBOOK). 커뮤니티 사용자 방 만들기 자격은 "active 소속 하나 이상"이라 부트캠프 인증으로도 열리고, 공식 페이지 개설 요청도 그 기관 인증으로 낼 수 있습니다(여는 것은 운영자 — I-02 전에는 대학이 아닌 기관의 공식 페이지를 열지 않음, RUNBOOK). I-02에서 기관 페이지·기수 방과 함께 다시 봅니다. 서명 URL은 우리 서버 경로(파일을 서버가 스트림)라 S3 직접 서명 URL은 아닙니다(ADR 0007·0017의 서버 스트림 규칙과 같음).

## 대안

- **`schools` → `institutions` 이름 변경(또는 뷰)**: 설계의 이름과 같지만 모든 catalog·커뮤니티 조인을 바꾸고 얻는 것이 없습니다. 열 하나로 같은 의미를 얻었습니다.
- **trainee/graduate enum 추가**: 설계 표와 같지만 standing을 읽는 모든 곳(전환 규칙·분석 props·배지)을 갈라야 합니다. 같은 두 상태의 글자만 다릅니다.
- **초대 코드를 상수 시간 비교로 행마다 대조**: 해시 unique 색인으로 바로 찾는 것과 보안 차이가 없고(원문을 저장하지 않음) 느립니다.
- **기수 대기 요청 목록을 같은 기수 멤버에게 보여 주기**: 승인이 쉬워지지만 기수 명부와 요청자 노출이 생깁니다(A-03 명부 동의 원칙과 충돌). 링크 전달로 충분합니다.
- **결정하는 요청 안에서 파일 삭제**: "결정 직후"에 더 가깝지만 저장소 오류가 결정을 막거나 장부 기록이 두 곳으로 갈라집니다. 10분 주기 작업이 7일 한도를 크게 밑돕니다.
- **수료증 장부 subject를 사용자 id HMAC으로**: 장부만 보면 "누가"가 이어지지만 재적용이 살아 있는 계정을 지웁니다(위 7).
- **플래그를 Nuxt runtimeConfig `public`으로**: 빌드 때 값이 굳거나 `NUXT_PUBLIC_*`로만 바뀌고 서버 판정과 갈라질 수 있습니다. 서버가 한 곳에서 읽고 화면은 그 값을 받습니다.
