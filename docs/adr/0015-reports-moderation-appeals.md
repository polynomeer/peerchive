# 0015. 신고·보류·운영 조치·이의제기: 로그인 신고 + 공개 차단만 하는 조치(항목 가리기 포함) + 요청마다 확인하는 읽기 + 조치마다 한 번의 이의제기

- 상태: 채택
- 날짜: 2026-10-21

## 맥락

T-15는 공개 파일럿 전에 꼭 있어야 하는 신고·관리 조치입니다(DELIVERY_PLAN T-15 "public 상태만 검색, 조치·이의제기·audit 기록", §7 G2 "신고 담당자·대응 시간·삭제 절차 지정"). 관련 설계:

- PROOFU_EVOLUTION_PLAN §9.4 "동의 철회·신고: 공개 버전 숨김, 원인 확인과 이의제기 기록, 파생 포트폴리오도 차단", §15 학업 진실성(신고·숨김)·저작권·개인정보.
- SYSTEM_DESIGN §6.6 Report(target_type, target_id, reason, status)·AuditEvent(본문 미저장), §7.2 `published → restricted`(운영 조치)·`restricted → draft`(조치 해제 후 재검토), §8 "관리자의 비공개 접근은 사유·기간·범위·감사 기록을 갖춘 예외, 삭제 권한과 공개 차단 권한 분리", §14 철회 목표(DB 변경 즉시 차단, 파생 정리 5분).
- 이미 있던 자리: 도메인 전이 `restrict`/`lift_restriction`, 게시 전제 조건 `hasOpenHold`(T-11~T-12는 항상 false), 선배 노트 `hidden` 상태(API 없음), 공개 조회 `servableReleaseSql`(공개 상태가 published일 때만), 운영자 테이블(ADR 0010, CLI로만 부여, 비공개 과제 열람 권한 없음), 감사 모듈, worker 정리 handler 등록 구조(ADR 0012).

소유자의 미커밋 기획 수정(신고 누적 자동 숨김·학생 큐레이터)은 참고만 했습니다. 큐레이터는 구현하지 않습니다.

## 결정

### 신고 접수: 로그인한 사용자만(파일럿)

- `POST /api/v1/reports {targetType, targetRef, reason, details?}`. **로그인 필수**(401). 익명 신고는 IP 기준 한도·선택 연락처가 필요하고 남용(경쟁 팀 신고 폭탄)에 약해서, 파일럿에서는 사람 단위로 한도·중복을 판정합니다. 공개 화면에는 "로그인하고 신고하기" 안내를 둡니다. 권리 침해 게시 중단 요청처럼 계정 없는 사람의 경로는 법률 검토 뒤 별도 절차(§15 P1)입니다.
- 대상(모두 **지금 공개인 것**만, 아니면 404 — 공개 조회와 같은 판정):

  | targetType | targetRef(공개 화면에 보이는 값만) | 지금 공개 판정 |
  |---|---|---|
  | `publication` | `{slug}` | `loadServedRelease`(공개 published + 지금 release + 엠바고 없음) |
  | `publication_item` | `{slug, kind: log\|claim\|artifact, key}` | 위 + 가린 항목을 뺀 스냅샷에 그 키가 있음 |
  | `senior_note` | `{noteId}` | `status = 'published'` |
  | `case_study` | `{handle, anchor: case-1…5}` | 지금 판의 그 대표 케이스가 `isPubliclyVisible` |
  | `profile` | `{handle}` | active 사용자 + 숨기지 않은 프로필 |

- 사유: `personal_info`(개인정보 노출)·`answer_sharing`(답안·정답 공유)·`copyright`(저작권·권리 침해)·`harassment`·`false_claim`(거짓 기여 주장)·`spam`·`other`. 설명 1000자(선택).
- **최소 저장**: 대상 내용을 복사하지 않고 포인터만(공개 사례는 신고 때 제공하던 release id, 노트·케이스는 그때의 version). 설명은 운영자만 보고 감사 기록에 넣지 않습니다.
- **중복**: 같은 신고자·같은 대상(`target_key`, 도메인 `reportTargetKey`)의 처리 전(open·in_review) 신고는 하나(부분 unique). 다시 보내면 기존 신고를 200 `created: false`로 돌려주고 한도를 쓰지 않습니다. 처리된 뒤에는 새 신고를 받습니다.
- **한도**: 사용자별 시간당 10회·하루 30회(429). 순서는 검증(422) → 대상 판정(404) → 중복(200) → 한도(429) → 저장(201).
- 신고자는 `GET /me/reports`에서 상태(접수·검토 중·처리됨·기각)만 봅니다. 어떤 조치를 했는지는 알려 주지 않습니다.

### 보류(hold)

- `personal_info`·`copyright` 신고가 공개 사례(또는 그 항목)에 들어오면 `holds` 한 줄(공개, 사유, 만든 신고)이 생깁니다. 열린 보류가 있으면 `readinessContext.hasOpenHold = true` → 후보가 ready가 되지 않고 게시·새 버전 게시가 409 `publish_blocked`(+`hold_open`)입니다(게시 트랜잭션에서도 다시 계산).
- 보류는 **이미 제공 중인 release를 내리지 않습니다**(내리는 것은 운영자의 판단 = restrict). 신고 하나로 공개를 닫으면 악용하기 쉬워서입니다. 대신 신고된 내용이 새 버전으로 퍼지거나, 철회 뒤 다시 게시되는 것을 막습니다.
- 그 신고가 처리(resolve·dismiss)되면 같은 트랜잭션에서 풀립니다. owner 화면에는 "신고 검토 중이라 새 게시가 보류"와 사유 종류만 보입니다.

### 운영 조치 모델

운영자 처리는 **대상 단위**입니다. 같은 대상의 처리 전 신고들을 한 번에 닫고(같은 조치 행을 가리킴), 그 신고들이 건 보류를 풉니다. 모든 처리는 한 트랜잭션에 상태 변경 + `moderation_actions` 행 + outbox + 감사를 남깁니다.

| 조치 | 대상 | 효과 | 되돌림(제한 해제·이의 되돌림) |
|---|---|---|---|
| `none` | 모두 | 없음(처리됨 또는 기각) | – |
| `restrict` | 공개 사례·항목 | 도메인 `restrict`: published → restricted, 지금 release → withdrawn, 열린 후보 → superseded, access_epoch +1, outbox `publication.withdrawn`(cause `restricted`) | 도메인 `lift_restriction`: restricted → **draft**. release는 되살리지 않으므로 owner가 새 후보 → 당사자 동의 → 게시를 다시 함 |
| `hide_item` | 공개 사례 항목 | `release_hidden_items`(공개, 종류, 키) 한 줄, access_epoch +1 | lifted_at, access_epoch +1 |
| `hide_note` | 선배 노트 | published → hidden(고치기·게시 409 `hidden`) | hidden → published(숨긴 동안 고칠 수 없으므로 내용 그대로) |
| `hide_case_study` | 케이스 스터디 | `case_studies.hidden_at`(게시 409 `hidden`, 판에 넣기 422) | null(게시 상태는 그대로) |
| `hide_profile` | 공개 프로필 | `profiles.hidden_at` → `/u/:handle`·README 카드·T-02 공개 프로필 API 404. 계정·과제 공간은 그대로 | null |

- 대상 종류별로 고를 수 있는 조치는 도메인 `ACTIONS_BY_TARGET`(아니면 422 `action: not_applicable`). 대상이 이미 그 조치를 받을 수 없으면(게시 중이 아님·이미 숨김) 409 `target_not_public`.
- **내부 메모와 당사자 사유를 분리**: `note`(내부, 필수, 1000자)는 운영자 화면에만, `publicReason`(300자)은 당사자 안내에만 나갑니다. `notifyOwner: true`면 `publicReason` 필수.
- **차단 ≠ 삭제**: 이번 범위의 조치는 모두 공개 차단이고 되돌릴 수 있습니다. 내용 삭제는 별도의 명시적 운영 조치(삭제 ledger와 함께, T-16 이후)이며 이 API에 없습니다.
- **restrict를 고른 방식**: release를 withdrawn으로 만들어 철회와 같은 파생 정리(검색 문서·신호 삭제, 케이스 스터디 unavailable)를 그대로 탑니다. 해제가 draft로 가는 것은 SYSTEM_DESIGN §7.2 그대로이며, 조치 사이에 동의가 바뀌었을 수 있으므로 다시 동의를 받게 합니다.
- **hide_item 범위**: 가린 항목은 **공개 전체**에 적용합니다(스냅샷 키는 공개마다 안정). owner가 새 버전을 게시해도 같은 키는 계속 가려지고, 운영자 되돌림·이의제기로만 풀립니다(보류가 풀린 뒤 같은 내용을 다시 게시해 노출하는 일을 막음). 파일 키는 버전 id라 새 파일 버전은 새 키입니다.

### 공개 읽기 반영(요청마다, worker 무관)

- 제한: `servableReleaseSql`·`canServePublicRelease`가 이미 "공개 published"를 요구하므로 restricted는 사례·파일·허브·검색·신호·포크·케이스 스터디(고정 release)에서 커밋 즉시 404/제외입니다. 추가로 고칠 SQL이 없었습니다.
- 가린 항목: `loadServedRelease`가 요청마다 `release_hidden_items`를 읽어 **스냅샷 사본**에서 항목과 그 항목을 가리키는 참조(해결한 막힘·파일 근거·선언 근거·마일스톤 스냅샷)를 뺍니다(도메인 `redactHiddenItems`, 저장된 스냅샷은 그대로). 그래서 공개 파일은 404, 신호·포크·케이스 초안·신고 대상 판정은 가린 항목을 모릅니다. 공개 응답 `hiddenItems: [{kind, key, index}]`로 화면이 원래 자리에 "운영 조치로 가려진 항목"을 그립니다. 과목 허브(`servableReleasesForCourse`)도 같은 사본을 쓰고, 검색은 같은 쿼리의 `not exists`(`hiddenStuckSql`)로 거릅니다. 케이스 스터디 공개 보기는 가린 항목을 인용한 문장을 글 없이 자리 표시로 바꾸고(`moderated: true`, 초안 문장이 스냅샷 글을 담고 있으므로) 매트릭스 근거에서도 뺍니다.
- 숨긴 노트·케이스·프로필은 각 공개 읽기의 조건(`status = 'published'`, `isPubliclyVisible`의 `hidden_at is null`, 프로필 `hidden_at is null`)으로 빠집니다.
- worker(`moderation.action {actionId, phase}` 큐, 지금 행 상태 기준·idempotent)는 남은 사본만 맞춥니다: 가린 막힘 카드·숨긴 노트의 검색 문서 삭제, 되돌리면 다시 색인. 검색 색인 handler도 가린 막힘을 색인하지 않습니다. 신호는 지우지 않습니다(읽기에서 이미 빠지고, 되돌리면 그대로 다시 셈).

### 운영자 화면과 볼 수 있는 범위

- `/operator`(대기열: 상태별, 대상별 묶음 — 개수·사유별 개수·처음/마지막 신고·담당자·보류, 열린 이의제기)와 `/operator/reports/:id`(상세·처리). 운영자가 아니면 API는 403 `operator_only`, 화면은 404(존재를 드러내지 않음).
- 운영자가 보는 내용은 **공개됐던 것뿐**: 신고 때 제공하던 release의 저장된 스냅샷(신고된 항목 강조, 지금 가린 키 목록), 신고 때 version 그대로인 게시된·숨긴 노트·케이스 글(그 사이 고쳤으면 "볼 수 없음"), 공개 프로필 허용 목록. 비공개 과제 공간(프로젝트·로그·공개 준비 화면)은 신고가 열려 있어도 운영자에게 404입니다. 신고자 신원은 대기열·상세에 싣지 않습니다(감사 기록의 actor로만 남음).
- 분쟁 조사용 비공개 접근(SYSTEM_DESIGN §8의 사유·기간·범위가 있는 예외)은 이번에 만들지 않았습니다. 필요해지면 별도 ADR로 기간 제한 grant + 감사로 추가합니다.

### 이의제기

- `POST /api/v1/appeals {actionId | reportId, message}`(1000자): 조치의 **당사자만**(공개 사례는 지금 active owner, 노트·케이스는 작성자, 프로필은 그 사람; 아니면 404), 조치마다 한 번(409 `already_appealed`, DB unique), 조치 없음·기각은 409 `not_appealable`, 이미 풀린 조치는 409 `already_reversed`.
- 운영자 `POST /operator/appeals/:id/decide {decision: uphold|reverse, note}`: 되돌리면 위 표의 되돌림을 같은 트랜잭션에서 합니다(제한은 draft로). 같은 운영자가 조치와 이의 결정을 함께 할 수 있습니다(파일럿 운영자 수가 적음 — 한계).
- 운영자 제한 해제 `POST /operator/publications/:id/lift-restriction {note}`도 같은 되돌림(cause `lift`)입니다.

### 알림(화면 안에서만)

- 메일은 보내지 않습니다. 당사자는 공개 준비 화면(제한·가린 항목 안내 + 보류 안내), 선배 노트 화면, 케이스 스터디 편집 화면의 안내 상자와 `/me/moderation-notices` 목록에서 조치 종류·당사자 사유·이의 상태를 봅니다. 목록은 운영자가 알림을 켠 조치만, 안내 상자는 지금 효력이 있는 조치 모두입니다(owner가 상태를 이해하도록).

### 감사

- 기록: `report.create`(대상 종류·사유·보류 여부·공개 id), `report.assign`, `report.resolve`/`report.dismiss`(조치 id·종류·닫은 신고 수·푼 보류 수), `moderation.apply`·`moderation.lift`·`moderation.reverse`(대상 객체 기준, 조치 id·종류), `appeal.create`, `appeal.decide`(결정). **신고 설명·내부 메모·당사자 사유·이의 메시지 글은 넣지 않습니다**(테스트로 확인).
- 조회: `GET /operator/audit?target=<id>`(대상 id 또는 metadata의 actionId·publicationId, 최근 200).

### 자동 임시 숨김: 이번에는 구현하지 않음

소유자 초안의 "서로 다른 사람의 신고가 기준 수에 이르면 임시 숨김"은 넣지 않았습니다(`PEERCHIVE_AUTO_HIDE_THRESHOLD` 없음). 이유: (1) 공개 사례의 유일한 차단 수단인 restrict는 해제하면 draft로 가므로 "임시"가 되지 않고, 오탐이면 owner가 동의를 다시 받아야 합니다. (2) 같은 학과 파일럿에서는 몇 명이 모여 경쟁 팀 사례를 내리는 악용이 기준 수를 쉽게 넘깁니다. (3) 개인정보·저작권 신고는 이미 보류로 확산을 막고, 운영 대응 시간 목표(apps/README.md "운영")로 사람이 판단합니다. 넣는다면 release를 바꾸지 않는 별도 "임시 숨김" 상태(servable 조건 하나)를 만들어 해제 시 그대로 돌아오게 하는 것이 전제입니다(커뮤니티 기능 §8.9.6과 함께 검토).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /reports` | 201, 200(같은 처리 전 신고) | 401, 403(CSRF), 404(지금 공개 아님), 422, 429 |
| `GET /me/reports`, `GET /me/moderation-notices` | 200 | 401 |
| `POST /appeals` | 201 | 401, 404(당사자 아님·없음), 409 `not_appealable`·`already_appealed`·`already_reversed`, 422 |
| `GET /operator/reports?status=`, `GET /operator/reports/:id` | 200 | 401, 403 `operator_only`, 404, 422(status) |
| `POST /operator/reports/:id/assign` | 200 | 401, 403, 404, 409 `already_closed` |
| `POST /operator/reports/:id/resolve` | 200 | 401, 403, 404, 409 `already_closed`·`target_not_public`, 422(`note` 필수, `publicReason: required`, `action: not_applicable`) |
| `POST /operator/reports/:id/dismiss` | 200 | 401, 403, 404, 409 `already_closed`, 422 |
| `POST /operator/publications/:id/lift-restriction` | 200 `{publicationId, status: 'draft'}` | 401, 403, 404, 409 `not_restricted`, 422 |
| `GET /operator/appeals?status=`, `POST /operator/appeals/:id/decide` | 200 | 401, 403, 404, 409 `already_decided`, 422 |
| `GET /operator/audit?target=` | 200 | 401, 403, 422 |
| (기존) 게시·새 버전 게시 | – | 409 `publish_blocked` + `hold_open`(보류 중), 409 `publication_locked`(제한 중 후보 만들기) |
| (기존) 노트 고치기·게시, 케이스 게시 | – | 409 `hidden` |

migration `0014_moderation`(enum 6개, 테이블 `reports`·`moderation_actions`·`release_hidden_items`·`holds`·`appeals`, 열 `case_studies.hidden_at`·`profiles.hidden_at`).

## 결과

- 모든 조치는 한 행의 상태 변경으로 즉시 효력이 있고, 공개 읽기는 요청마다 그 상태를 확인하므로 worker가 멈춰도 가린 내용은 보이지 않습니다. 대가로 공개 사례 조회마다 가린 항목 쿼리 1개가 늘었습니다.
- 운영자는 공개됐던 내용만 보고, 신고자는 상태만 보며, 당사자는 사유만 봅니다. 감사에는 id·종류만 남습니다.
- 한계: 익명 신고·계정 없는 권리자 경로 없음, 메일 알림 없음, 자동 임시 숨김 없음, 큐레이터 1차 검토 없음(소유자 초안 §8.6, 미구현), 분쟁 조사용 기간 제한 비공개 접근 없음, 내용 삭제 조치 없음(T-16 삭제 ledger와 함께), hide_item은 일반 해제 API 없이 이의제기 되돌림으로만 풂(제한은 lift API 있음), 가린 파일은 공개 경로만 막고 비공개 과제 공간의 파일은 그대로, 마일스톤·요약은 가릴 수 없음(필요하면 restrict), 같은 운영자가 조치와 이의 결정을 할 수 있음, 노트·케이스 신고 때의 글은 따로 보관하지 않아 그 뒤 고치면 운영자도 볼 수 없음(최소 저장의 대가).

## 대안

- **익명 신고 + IP 한도 + 선택 연락처**: 접근성은 좋지만 IP 공유(학교망)·우회가 쉬워 한도가 약하고, 중복 판정이 흐려집니다. 파일럿 뒤 신고량을 보고 다시 봅니다.
- **신고 즉시 보류 = 공개 내림**: 가장 안전해 보이지만 신고 한 번으로 남의 공개를 닫을 수 있습니다. 보류는 새 게시만 막고, 내리는 것은 사람이 합니다.
- **restrict를 release 유지 + 공개 상태만 바꾸기**: 해제 때 그대로 되돌릴 수 있지만 SYSTEM_DESIGN §7.2(해제 후 draft·재검토)와 다르고, 파생 데이터 정리를 따로 만들어야 합니다.
- **hide_item을 release 단위로**: 새 버전에서 자동으로 풀려 단순하지만, 보류가 풀린 뒤 같은 내용을 다시 게시해 노출할 수 있습니다.
- **가린 항목을 스냅샷에서 지운 새 release 만들기**: 공개 데이터가 깔끔하지만 동의는 manifest 해시에 묶여 있어(ADR 0011) 운영자가 동의 없는 새 release를 만드는 셈이 됩니다. 저장된 스냅샷은 그대로 두고 읽을 때 뺍니다.
- **신고 대상 내용을 신고에 복사(증거 보존)**: 운영자가 고친 뒤에도 원래 글을 볼 수 있지만 개인정보 신고의 내용을 한 벌 더 만드는 셈이고 삭제 범위가 넓어집니다. 공개 사례는 release 포인터로 충분하고, 노트·케이스는 최소 저장을 택했습니다.
