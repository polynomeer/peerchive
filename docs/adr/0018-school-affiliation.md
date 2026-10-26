# 0018. 학교 메일 인증·학과 자기 신고: institution_affiliations(HMAC만, 주소 미저장) + 운영자 등록 도메인 + 열거 안전 코드 흐름 + 과목 허브 작성 자격

- 상태: 채택
- 날짜: 2026-10-26

## 맥락

C-01은 커뮤니티 백로그의 첫 항목입니다(DELIVERY_PLAN §4.1 "인증 코드 만료·재시도 제한, 졸업생 인증 이력 유지, 공개 DTO에 학번·학과·인증 메일 없음. 과목 허브 작성 자격과 같은 레코드 사용"). 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.6 "열람은 누구나, 과목 허브 작성은 학교 인증 계정만": 선배 노트 등은 해당 학교 메일로 인증한 재학생·졸업생만 씁니다. 졸업 뒤 메일이 없어져도 재학 중 인증 이력을 유지하고 `졸업생`을 표시합니다. 학번·학과는 공개하지 않습니다. §10.1 "학교 메일 인증은 프로필에서는 선택 배지".
- SYSTEM_DESIGN §6.7 `SchoolAffiliation(user_id, school_id, email_domain, verified_at, standing, department_id?, status)`, §6.7.2 **이관 원칙**("P1 구현부터 테이블 이름을 `institution`·`institution_affiliation`으로 만들고 `kind = university`, `method = email`만 씀"), §8.1·§8.2 학교 인증, §9.1 `POST /community/affiliations`·`/verify`("인증 코드 만료·재시도 제한, 학과는 자기 신고").
- ADR 0013은 `canWriteToCourseHub` 한 곳에 학교 인증 조건을 더하도록 자리를 남겼고, ADR 0010의 `schools`(학생 작성·운영자 병합)가 이미 있습니다. ADR 0006의 매직링크는 "계정 유무와 무관하게 202"로 열거를 막습니다.

## 결정

### 테이블과 이관 원칙에서 벗어난 점

- `institution_affiliations`(이관 원칙의 이름, `institution_kind` enum `university`만, `method` enum `email`만): `user_id`, `school_id`, `email_hash`, `email_domain`, `standing`(student/alumni), `department_label?`, `status`(pending/active/revoked/expired), `verified_at`, `revoked_at`, `revoked_reason`(user_removed/operator/merged_duplicate), `created_at`, `updated_at`.
- **기관 테이블은 만들지 않고 기존 `schools`를 `school_id`로 가리킵니다.** 이관 원칙은 `institution` 테이블을 처음부터 두라고 하지만, T-10이 이미 `schools`(병합·정규화 키·과목 연결)를 만들었고 과목·검색·병합이 모두 그것을 씁니다. 지금 이름만 바꾸면 이득 없이 모든 catalog 코드가 흔들립니다. P2(I-01)에서 `schools`를 기관으로 일반화(이름 변경 또는 `institutions` 뷰 + `kind`)하고 `school_id`를 `institution_id`로 옮기는 migration을 한 번 둡니다. 소속 테이블 쪽은 이미 kind·method 열이 있어 그때 바꿀 것이 없습니다.
- `department_id?` 대신 `department_label?`(자기 신고 글, 정규화, 40자): 학과 테이블(§6.7 Department)은 C-02(공식 페이지)에서 생깁니다. 그때 운영자가 학과 행을 만들고 라벨을 연결합니다.
- `school_email_domains(school_id, domain unique, added_by, created_at)`: 학교 메일 도메인. `affiliation_codes(affiliation_id, code_hash, expires_at, attempts, used_at)`: 인증 코드. `profiles.show_affiliation_badge`(기본 false). migration `0016_school_affiliation`.
- 부분 unique: `email_hash`는 **active 행 사이에서만** 하나(한 학교 주소는 한 계정만 인증), `(user_id, school_id)`는 pending·active 사이에서 하나.

### 메일 주소는 저장하지 않음

- 저장하는 것: `email_hash` = HMAC-SHA256(`PEERCHIVE_AFFILIATION_PEPPER`, `school-email:v1:` + 정규 주소)와 `email_domain`. 정규 주소는 로컬 부분 소문자, 도메인 소문자 ASCII(IDN은 WHATWG URL 규칙의 punycode), `+태그` 제거(같은 메일함 별칭으로 여러 계정을 인증하는 것 방지). 점(.)은 그대로 둡니다(학교 메일 대부분이 점을 무시하지 않음).
- 코드는 요청 처리 안에서 바로 보내고, 주소는 그 요청의 메모리에서만 씁니다. pending 동안에도 주소는 없고 해시만 있습니다(코드 재발송은 사용자가 주소를 다시 입력). 코드는 HMAC(pepper, `affiliation-code:v1:` + 소속 id + 코드)만 저장하고 `timingSafeEqual`로 비교합니다.
- 행을 끝낼 때(만료·잠김·본인 해제·운영자 취소·병합 중복)는 `email_hash`를 지웁니다. 남는 이력은 학교·도메인·재학 상태·인증/해제 시각뿐입니다. 해제된 주소는 다른 계정이 다시 인증할 수 있습니다(운영자 취소 뒤 같은 주소로 다시 인증하는 것을 막지는 않음 — 한계).
- pepper는 바꾸지 않습니다(바꾸면 active 행과 새 요청의 해시가 맞지 않아 한 주소 한 계정 확인이 깨짐). production에서 없거나 약하면(32자 미만·자리표시) web이 시작하지 않습니다(`server/plugins/affiliation.ts`). worker·탈퇴 정리는 사용자 id로 지우므로 pepper가 필요 없습니다.

### 학교 메일 도메인

- 운영자만 등록·삭제합니다: `GET/POST /api/v1/operator/schools/:id/email-domains`, `DELETE …/:domainId`(감사 `school_email_domain.add`·`.remove`)와 CLI `pnpm --filter @peerchive/db school-email-domain list|add|remove <schoolId> [domain]`(grant-operator 옆, 같은 도메인 규칙 파일을 Node 타입 제거로 직접 읽음). 학생이 만든 학교 이름(ADR 0010)은 누구나 만들 수 있으므로, 도메인을 학생이 붙이게 하면 아무 학교나 사칭할 수 있어 운영자 일로 둡니다.
- 일치: 등록 도메인과 같거나 그 하위 도메인(`yu.ac.kr` 등록 → `stu.yu.ac.kr` 허용). 점 경계로만 비교해 `evilyu.ac.kr`·`yu.ac.kr.evil.com`은 거부, 비슷한 유니코드 글자는 punycode가 달라 거부됩니다. 와일드카드는 없고, TLD 하나·공용 접미사(`ac.kr`·`co.kr`·`edu.au` 등)·웹메일(`gmail.com`·`naver.com` 등)은 등록할 수 없습니다(422 `domain: invalid|shared_suffix|webmail`). 한 도메인은 한 학교(409 `domain_taken`), 다른 학교 도메인의 상위·하위 도메인도 거부(409 `domain_overlaps`).
- 도메인을 지워도 이미 인증된 소속은 그대로 active입니다(졸업 뒤 메일이 없어져도 이력을 유지하는 것과 같은 판단). 필요하면 운영자가 소속을 취소합니다.

### 흐름과 열거 안전

경로는 SYSTEM_DESIGN §9.1의 `/community/affiliations` 대신 `/api/v1/me/affiliations`입니다: 커뮤니티 모듈(C-02~)이 아직 없고, 지금 쓰는 곳은 내 계정 설정·과목 허브 작성 자격이라 `/me` 아래가 맞습니다. 커뮤니티가 생겨도 같은 레코드를 읽습니다.

1. `POST /me/affiliations {schoolId, email, standing, departmentLabel?}` → **202**.
   - 학교는 정본을 따라갑니다(병합된 id도 됨). 메일 도메인이 그 학교(정본 + 정본으로 병합된 학교)의 등록 도메인이 아니면 422 `domain_not_allowed`이고, 맞는 도메인이나 다른 학교 이름은 알려 주지 않습니다.
   - 한도(고정 창, 시간당): IP 30회·사용자 5회 → 429. 도메인 거부도 사용자 한도에 셉니다(도메인 추측 제한). 정규 주소 해시당 3회 → **같은 202, 발송만 안 함**.
   - 같은 학교에 이미 active면 409 `already_verified`(내 상태라 알려 줘도 됨). 진행 중 pending은 새 요청으로 대체(expired)됩니다.
   - **그 주소가 다른 계정에서 이미 인증됐는지는 여기서 보지 않습니다.** 쓰이는 주소든 처음 주소든 같은 202·같은 응답 모양이고 코드를 보냅니다. 그래서 남의 학교 메일이 가입돼 있는지 알아볼 수 없습니다.
   - 메일(한국어, 일반 텍스트 + HTML): "인증 코드: 123456", 10분 동안 유효, "직접 요청하지 않았다면 이 메일을 무시하세요". 주소·학교 이름은 넣지 않습니다. 발송 실패도 같은 202 + 가린 로그·`mail.send_failed`(purpose `affiliation_code`) 감사(ADR 0017과 같음).
2. `POST /me/affiliations/:id/verify {code}`: 6자리가 아니면 422 `code: invalid_format`(시도로 세지 않음). 틀리면 시도 +1, 422 `code_mismatch` + `attemptsLeft`. 5번째로 틀리면 410 `attempts_exceeded`(행 expired). 만료(10분) 410 `code_expired`, 쓴·대체된 코드 410 `code_unavailable`. 상태 변화(시도 수·만료)를 커밋한 뒤 오류를 돌려줍니다. 맞으면 active + `verified_at`, 감사 `affiliation.verify`(학교·재학 상태·도메인만), 분석 `affiliation_verified`.
   - **409 `email_in_use`는 이 단계에서만**: 코드가 맞아 주소 소유가 증명된 뒤 같은 해시가 다른 계정에서 active면 이 요청을 끝내고(expired) 409. 그 주소의 주인에게만 보이는 정보라 열거가 되지 않습니다. 동시에 인증하면 부분 unique 위반도 409입니다.
3. `GET /me/affiliations`(만료된 요청은 빼고, 해제 이력은 포함 + `showBadge`·`hubRequiresAffiliation`), `PATCH /me/affiliations/:id {standing?, departmentLabel?}`(재학생 → 졸업생만, 반대는 422 `standing: not_allowed` — 해제 뒤 재학 중 메일로 다시 인증; 끝난 행 409 `not_editable`; 감사에는 학과 이름 없이 바뀌었는지만), `DELETE /me/affiliations/:id`(revoked `user_removed`, 해시 삭제, 이력 유지).
4. 운영자: `GET /operator/affiliations?schoolId=|userId=&status=`(사용자 id·학교·도메인·상태·시각만 — 학과·재학 상태 없음, 주소는 저장돼 있지 않음), `POST /operator/affiliations/:id/revoke {reason}`(revoked `operator`, 사유는 감사 metadata).

- 졸업: 메일이 없어져도 active를 유지하고 주기적 재인증은 없습니다. 나중에 필요하면 `verified_at` 기준 재인증 요청(예: 4년)이나 `expires_at` 열(P2 InstitutionAffiliation)을 더합니다.
- 정리: worker 주기 작업 `affiliation-codes`(매시 27분): 쓸 수 있는 코드가 없어진 지 1시간 지난 pending을 expired로(해시 삭제), 쓰였거나 만료된 지 하루 지난 코드 행 삭제.

### 공개 노출

- 공개 프로필·포트폴리오·과목 허브·선배 노트 DTO에는 학번(받지 않음)·학과·메일·도메인이 없습니다(테스트로 확인).
- 선택 배지: 본인이 `PATCH /me/profile {showAffiliationBadge: true}`로 켰을 때만 공개 프로필(`GET /public/profiles/:handle`의 `affiliationBadges[]`, `/u/:handle`)에 "○○대학교 인증", 졸업생이면 "○○대학교 인증 · 졸업생". 학교 이름은 정본 학교 이름입니다.
- 선배 노트에는 새로 보이는 것이 없습니다(인증 배지도 붙이지 않음). 익명 노트에 학교 배지를 붙이면 작은 학교에서 사람을 좁힐 수 있고, 학교는 과목 허브 자체가 이미 보여 줍니다. 작성 시점 소속 문자열(§6.7.2 `affiliation_label`)은 커뮤니티 글(C-03~)에서 다룹니다.

### 과목 허브 작성 정책

- `hubWriteDecision(user, course, policy)` / `canWriteToCourseHub`(@peerchive/domain 한 곳): active 사용자 + 정본 과목 + **그 과목 학교(정본)의 active 인증**. 서버는 사용자의 active 소속이 가리키는 학교를 `coalesce(merged_into, id)`로 정본화해 넘깁니다(학교 병합은 소속·도메인도 즉시 정본으로 옮기지만 읽기도 정본을 따라감). 졸업생도 씁니다.
- 선배 노트 만들기·게시 때 모두 확인합니다(해제·취소되면 초안을 게시할 수 없음). 이미 게시된 노트는 그대로 남습니다. 인증이 없어 막히면 403 `hub_write_not_allowed` + `requirement: 'school_affiliation'`·`schoolId`, 화면은 "이 학교 메일로 인증하면 선배 노트를 쓸 수 있습니다"와 인증 페이지 링크(`/settings/affiliations?school=…&return=…`). 화면 안내용 `GET /me/hub-write?course=`(`allowed`·`requirement`·정본 학교).
- **유용성 신호·플랜 포크는 열어 둡니다**(로그인만). §8.6이 인증을 요구하는 것은 "선배 노트·막힘 Q&A 답변·과제 유형 요약" 작성이고, 신호는 정렬용 반응(작성자 점수 없음, ADR 0013), 포크는 내 비공개 과제를 만드는 것이라 허브에 글을 쓰지 않습니다.
- `PEERCHIVE_HUB_REQUIRE_AFFILIATION`(기본 `1`). `0`은 로컬·개발용(인증 없이 작성)이며 **production에서는 `0`이거나 형식이 틀리면 web이 시작하지 않습니다**. 두 번째 허용 플래그를 두지 않은 이유: 파일럿에서 학교 인증 없이 허브를 열 이유가 없고(도메인 등록은 운영자 몇 분 일), 운영 실수로 정책이 꺼지는 것을 막는 쪽이 낫습니다. 정책을 바꾸려면 새 ADR로 코드를 바꿉니다.

### 탈퇴·분석·병합

- 탈퇴 정리(worker `ops/purge.ts`)와 재적용: 그 사람의 인증 코드(장부 종류 `affiliation_codes`)와 소속 행 전부(`institution_affiliations`, 해제 이력 포함)를 지웁니다. 운영자가 등록한 도메인의 `added_by`는 가명 처리된 users 행을 가리킨 채 남습니다.
- 분석 허용 목록에 `affiliation_verified { standing: student|alumni }`. 학교 id·도메인은 넣지 않습니다(학교는 개인정보가 아니지만 작은 학교는 학교 + 시각만으로 사람을 좁힐 수 있음). pgEnum도 같은 값을 더했습니다.
- 학교 병합(ADR 0010): 같은 트랜잭션에서 도메인과 소속을 정본으로 옮깁니다. 한 사용자가 두 학교 모두에 진행 중 인증이 있으면 active가 pending보다, 같으면 정본 쪽이 남고 다른 쪽은 revoked `merged_duplicate`(active였으면) 또는 expired로 끝냅니다(메일 해시 삭제). 감사 metadata에 `affiliationsMoved`·`affiliationsClosed`·`emailDomainsMoved`.

### 화면

`/settings/affiliations`(머리말 "학교 인증", 프로필 설정에서도 링크): 학교 검색(CoursePicker와 같은 `/api/v1/schools?q=` 검색, 학교 만들기는 없음 — 도메인이 없는 새 학교는 인증할 수 없으므로), 학교 메일·재학/졸업생·학과(선택, 공개 안 됨), 코드 입력(`one-time-code`, 남은 시도·만료 시각), 내 인증 목록(상태·재학 상태 글자, 졸업생으로 바꾸기·학과 고치기·해제, 해제 이력), 공개 배지 선택. 선배 노트 화면은 인증이 없으면 폼 대신 안내와 링크를 보여 줍니다. 운영자 도메인 관리 화면은 아직 없고 API·CLI만 있습니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /me/affiliations` | 202 | 401, 403(CSRF), 404(학교), 409 `already_verified`·`request_in_progress`, 422 `email: invalid_format`·`domain_not_allowed`·`departmentLabel`·`standing`, 429 |
| `POST /me/affiliations/:id/verify` | 200(이미 active 200) | 401, 404, 409 `email_in_use`, 410 `code_expired`·`attempts_exceeded`·`code_unavailable`, 422 `code: invalid_format`·`code_mismatch`(+attemptsLeft) |
| `GET /me/affiliations` | 200 | 401 |
| `PATCH /me/affiliations/:id` | 200 | 401, 404, 409 `not_editable`, 422 `standing: not_allowed`·`departmentLabel` |
| `DELETE /me/affiliations/:id` | 200(끝난 행 200) | 401, 404 |
| `GET /me/hub-write?course=` | 200 | 401, 404 |
| `GET/POST /operator/schools/:id/email-domains` | 200 / 201(이미 있음 200 `created: false`) | 401, 403 `operator_only`, 404, 409 `domain_taken`·`domain_overlaps`, 422 `domain` |
| `DELETE /operator/schools/:id/email-domains/:domainId` | 200 | 401, 403, 404 |
| `GET /operator/affiliations` | 200 | 401, 403, 404(학교), 422(`schoolId`·`userId` 중 하나 필요) |
| `POST /operator/affiliations/:id/revoke` | 200(끝난 행 200) | 401, 403, 404, 422 `reason` |
| `POST /courses/:id/senior-notes`, `POST /senior-notes/:id/publish` | (ADR 0013) | 403 `hub_write_not_allowed`(+`requirement`·`schoolId`) |

## 결과

- 과목 허브 글은 그 학교 메일로 인증한 계정만 쓰고, 읽기·포크·신호는 그대로 열려 있습니다. 운영자가 파일럿 학교마다 메일 도메인을 등록해야 합니다(RUNBOOK §1).
- DB·백업이 새도 학교 메일 주소 목록은 나오지 않습니다(pepper가 따로 있어야 해시를 대조할 수 있고, 그래도 추측한 주소를 확인하는 것뿐). 대신 사용자에게 "어느 주소로 인증했는지"는 도메인까지만 보여 줄 수 있습니다.
- 요청 단계에서 이미 쓰인 주소를 알려 주지 않으므로, 그 주소의 주인이 아닌 사람은 코드를 받지 못해 아무것도 알 수 없습니다. 주인은 코드를 넣은 뒤 409로 압니다.
- 한계: 공용 접미사·웹메일 목록은 손으로 관리하는 짧은 목록입니다(Public Suffix List 의존성 없음). 학교가 졸업생에게도 메일을 주는 경우 재학/졸업생 구분은 자기 선언입니다. 운영자 취소 뒤 같은 주소로 다시 인증하는 것을 막지 않습니다(필요하면 취소 행의 해시를 남기는 차단 목록을 더함). 학과는 자유 글이라 학과 페이지 쓰기 판정(C-02)에 바로 쓰기 어렵습니다. 주기적 재인증은 없습니다. 운영자 도메인 화면이 없습니다. 메일 발송은 요청 처리 안에서 기다립니다(느린 SMTP면 응답이 늦음, ADR 0017과 같음).
- DELIVERY_PLAN §4.1 순서상 나머지 커뮤니티 백로그(C-02~C-10)는 G3 게이트를 기다립니다.

## 대안

- **주소를 암호화해 저장**: 재발송·운영자 확인이 쉽지만 복호화 키만 있으면 학교 메일 목록이 나옵니다. 해시 + 도메인으로 필요한 판정(한 주소 한 계정·학교 일치)이 모두 됩니다.
- **요청 때 409 `email_in_use`**: 사용자에게 친절하지만 남의 학교 메일이 가입돼 있는지 알아보는 데 쓸 수 있습니다.
- **학생이 학교에 도메인을 붙임**: 운영 부담이 없지만 학생 작성 학교(누구나 만듦)에 아무 도메인이나 붙여 사칭할 수 있습니다.
- **`schools`를 지금 `institutions`로 이름 변경**: 이관 원칙에 더 맞지만 T-10~T-16의 catalog·병합·허브 코드를 모두 바꾸고 얻는 것이 없습니다. P2에서 기관 종류가 실제로 생길 때 한 번 합니다.
- **신호·포크에도 인증 요구**: 허브 품질에는 도움이 될 수 있지만 §8.6이 요구하지 않고, 후배(아직 그 학교 메일이 없는 사람 포함)의 탐색을 막습니다.
- **정책 플래그 `0`을 production에서 두 번째 플래그로 허용**: 유연하지만 실수로 정책이 꺼질 여지가 남습니다.
