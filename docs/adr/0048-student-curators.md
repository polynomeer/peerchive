# 0048. 학생 큐레이터: 운영자가 과목(정본)마다 지정·해제하는 `course_curators`(과목을 마침 + 그 학교 active 인증, 최대 2명, 감사 id만, 요청마다 판정해 해제 즉시 권한 없음) + 과제 유형 요약(과목당 한 편, 작성자 없이 허브 공개, version·감사) + 개념 태그 병합 제안(운영자가 승인하면 기존 병합 실행) + 1차 신고 검토는 의견만(신고자·설명·작성자 없음, 운영자 상세에 표시) + 팀원 찾기 끄기 + 본인이 켠 과목만 포트폴리오 "후배 기여"에

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

E-03은 DELIVERY_PLAN §4.4 P1 보완 백로그의 세 번째 항목입니다: "운영자가 과목별 1~2명 지정·해제(감사 기록), 개념 태그 병합 제안·과제 유형 요약·1차 신고 검토만 가능(공개 철회·계정 조치·작성자 확인 불가), 활동을 포트폴리오 ‘후배 기여’에 본인 선택으로 표시". 관련 설계와 앞선 결정:

- PROOFU_EVOLUTION_PLAN §8.6(학생 큐레이터: 과목마다 그 과목을 마친 고학년·졸업생 1~2명, 개념 태그 병합 제안·과제 유형 요약 정리·1차 신고 검토, 최종 처리는 운영자, 활동은 포트폴리오 ‘후배 기여’에 표시할 수 있음), §8.8(팀 배정 과목은 과목 큐레이터가 팀원 찾기를 숨김), §3.1(답안·평가 성향은 다루지 않음).
- ADR 0010(운영자 병합·`operators` 별도 테이블 — "범위 있는 역할을 따로 더할 자리"), 0013(과목 허브, 큐레이터 미구현), 0014(후배 기여), 0015(신고·운영 조치, "큐레이터 1차 검토 없음"), 0018(학교 메일 인증), 0024(`courses.team_finding_disabled` = 큐레이터 자리), 0028(표시명 프로필에는 후배 기여 없음), 0044(기관 운영진 — 같은 지정·해제 모양), 0046·0047(과목 등록·"마침" 판정).
- `과제 유형 요약`은 코드에 없었습니다(체크인 분포 주석의 "과제 유형 묶음"만, ADR 0013 한계 "체크인 분포는 과제 유형 구분 없이 과목 단위"). 그래서 최소 형태(과목당 짧은 글 한 편)로 새로 만듭니다.
- 변경: D-08: 운영자 지정은 제안이고 본인이 수락해야 권한이 생기며, 학교 인증은 요청마다 다시 확인하고, 본인 글·본인 과제의 신고는 검토 목록에서 뺍니다 ([ADR 0060](0060-open-question-decisions.md)).

## 결정

### 1. 지정·해제: `course_curators`, 운영자만, 과목당 2명

- 열: `course_id`(정본 과목), `user_id`, `granted_by`·`granted_at`, `revoked_at`·`revoked_by`(해제 행은 남김, 같은 사람을 다시 지정하면 새 행), `show_in_portfolio`(기본 false). 해제되지 않은 (과목, 사람)은 하나(부분 unique). 기관 운영진(ADR 0044)과 같은 모양입니다.
- `POST /api/v1/operator/courses/:id/curators {userId}`(201 + 그 과목 목록), `GET …/curators`, `DELETE …/curators/:userId`(아니면 404), `GET /api/v1/operator/curators`(전체). 운영자만(403 `operator_only`, 대상 존재 여부보다 먼저). 병합된 과목 id면 정본에 지정합니다.
- **자격**(`@peerchive/domain` `curatorEligibility`, 순서대로): active 계정(422 `userId: inactive`, 없으면 `not_found`) → 이미 지정(409 `already_curator`) → 과목당 2명(409 `limit_reached`, 과목별 advisory lock 안에서 셈) → **과목을 마침**(422 `not_finished`) → **그 과목 학교(정본)의 active 학교 메일 인증**(422 `not_verified`, 졸업생 인증 포함).
- "마침"은 E-02와 같은 판정입니다: 끝난 학기(정본 학기의 `ends_at ≤ now`)의 등록, 또는 끝난 학기에 연결된 과제 공간(스터디 제외)의 active 멤버. E-01 이전에 과목을 마친 학생이 대부분이라 과제 공간 기준을 함께 씁니다. 판정 함수(`hasFinishedCourse`)는 등록 모듈(`course-registrations/hub-opening.ts`)에 두고 **참거짓만** 돌려줍니다. 운영자는 거절 사유(`not_finished`)로 "마쳤는지" 한 비트만 알고 등록·학기·과제 공간은 보지 못합니다. E-01 경계 lint 허용 목록에는 지정 모듈 하나(`curators/assignments.ts`)만 더했고, 운영자 라우트는 여전히 등록 테이블·모듈을 직접 부르지 않습니다.
- 학교 인증은 **지정할 때만** 확인합니다. 졸업생은 학교 메일이 사라져 인증이 끝날 수 있는데, 큐레이터의 주된 대상이 졸업생이라 매 요청 확인하면 조용히 권한을 잃습니다. 인증이 취소(운영자 revoke)된 사람은 운영자가 해제합니다(runbook).
- 감사 `curator.grant`·`curator.revoke`: 지정 행 id + metadata `{courseId, userId}`만.

### 2. 권한 판정: 요청마다, 운영자 권한과 분리

- 큐레이터 = 해제되지 않은 지정 행 + active 계정(`curators/access.ts`). 저장·캐시가 없어 **해제하면 다음 요청부터** 모든 큐레이터 경로가 403 `curator_only`이고 공개 프로필 표시도 사라집니다.
- 과목은 정본 기준(`coalesce(courses.merged_into, courses.id)`)입니다. 어느 과목의 큐레이터도 아니면 과목 존재 여부보다 먼저 403, 다른 과목도 403입니다.
- 큐레이터 권한은 아래 네 가지뿐이고 `isOperator`를 넓히지 않습니다. 운영자 경로(신고 대기열·상세·처리·기각·조치·작성자 확인·주인 확인·감사 조회·병합 실행)는 모두 그대로 `operator_only`입니다.

| | 큐레이터(자기 과목) | 운영자 |
|---|---|---|
| 과제 유형 요약 쓰기·비우기 | 가능 | 가능 |
| 개념 태그 병합 | **제안만** | 승인·거절·직접 병합 |
| 1차 신고 검토 | **의견만**(기각 권장·가리기 권장) | 처리·기각·조치·이의 결정 |
| 팀원 찾기 끄기(C-07) | 가능 | 가능 |
| 공개 철회·가리기·제한·계정 조치·작성자 확인·신고자 설명 | 불가 | 가능 |

### 3. 과제 유형 요약(최소형): `course_type_summaries`

- 정본 과목마다 한 행: `body`(1~1000자), `version`, `updated_by`, 시각. `PUT /api/v1/curator/courses/:id/summary {body, expectedVersion}` — 그 과목 큐레이터 또는 운영자. `expectedVersion`은 지금 version(없으면 0), 다르면 409 `version_conflict`. 빈 글이면 행을 지웁니다(다시 쓰면 version 1부터). 사용자별 시간당 30회.
- **공개**: 열린 과목 허브 응답 `assignmentTypeSummary {body, version, updatedAt}`(없으면 null). **작성자 이름·id를 싣지 않습니다** — 누가 큐레이터인지는 본인이 포트폴리오에서 켤 때만 드러납니다(§6). "준비 중" 허브(E-02)에는 싣지 않습니다(내용 목록 없음 규칙). 개방 기준에도 세지 않습니다.
- **기록**: 이전 글은 보관하지 않고 감사 `curator.summary_update`(과목 id + `{version, cleared, byOperator}`)로 언제 몇 번 고쳤는지만 남깁니다. 요약은 신고 대상이 아닙니다 — 부적절하면 운영자가 고치거나 비웁니다(대상 종류·조치를 늘리지 않음).
- 화면은 "어떤 유형의 과제가 나오는지(개인·팀, 보고서·구현·발표, 흐름)만, 답안·채점 기준·교수 평가는 쓰지 않음"을 안내합니다(§3.1).

### 4. 개념 태그 병합 제안: `concept_tag_merge_proposals`

- `POST /api/v1/curator/courses/:id/tag-merge-proposals {sourceTagId, targetTagId, note?}` — **큐레이터만**(운영자는 직접 병합하므로 403). 원본은 그 과목에 붙은 정본 태그(422 `sourceTagId: not_on_course`), 대상은 아무 정본 태그(병합됐으면 422 `…: merged`, 없으면 `not_found`, 같으면 `targetTagId: self`). 같은 (원본, 대상)의 대기 제안은 하나(409 `already_proposed`). 하루 20회. 감사 `curator.tag_merge_propose`(제안·과목·두 태그 id).
- 운영자: `GET /api/v1/operator/concept-tag-proposals?status=`(기본 pending, 제안한 큐레이터 이름 포함), `POST …/:id/approve`·`…/reject`. **승인은 같은 트랜잭션에서 기존 병합(`mergeConceptTagInTx`, ADR 0010 규칙 그대로)을 실행**하고, 병합 감사 metadata에 `proposalId`를 더합니다. 병합 규칙에 걸리면(그새 병합됨) 오류를 그대로 돌려주고 제안은 대기로 남아 운영자가 거절합니다. 이미 결정된 제안은 409 `already_decided`. 감사 `concept_tag_proposal.approve|reject`(id + 과목 id).
- 큐레이터 작업 화면은 그 과목의 제안(최근 50개)을 보며 다른 큐레이터의 이름 대신 "내 제안"인지만 표시합니다.

### 5. 1차 신고 검토: 의견만, 신고자·작성자 없음

- **범위**: 그 과목 허브에 걸린 공개 항목의 **처리 전**(open·in_review) 신고 — `senior_note`·`course_qa`·`publication`·`publication_item`(`CURATOR_REVIEW_TARGETS`). 과목은 노트·Q&A의 과목, 공개 사례는 신고 때 release의 과목(정본으로 모음)입니다. 케이스 스터디·프로필·커뮤니티 등은 과목 허브 항목이 아니어서 빠집니다.
- `GET /api/v1/curator/courses/:id/reports`(큐레이터만): 대상별 묶음에 대상 종류·이름표·**사유별 개수**·**지금 공개 중인 내용**(공개 화면과 같은 DTO: 노트·Q&A, 사례는 지금 제공 중인 release의 제목·요약 — 신고 때 스냅샷은 운영자만)·공개 경로·내 의견. **신고자 id·이름, 신고 설명(details), 신고 시각, 담당 운영자, 보류, 조치 이력, 작성자 계정은 싣지 않습니다**(소스 lint: 검토 모듈은 `reporterId`·`details`·`assignedTo`·조치·작성자 확인을 부르지 않음, 큐레이터 라우트는 운영자 moderation·등록 모듈을 import하지 않음). 시각을 빼는 이유는 작은 과목에서 "언제 신고했는지"가 신고자를 짐작하게 하기 때문입니다.
- `PUT /api/v1/curator/courses/:id/reports/:reportId/recommendation {recommendation: dismiss|hide, note?}`: 묶음의 가장 오래된 처리 전 신고(운영자 대기열의 묶음 id와 같음)에 큐레이터마다 하나(다시 내면 고침). 처리 전이 아니거나 다른 과목·범위 밖이면 404. 시간당 60회. 감사 `curator.report_recommend`(신고 id + `{courseId, recommendation}`).
- **의견은 신고 상태·담당·처리 기한을 바꾸지 않습니다.** 운영자 대기열 묶음에 `curatorRecommended`(배지 "큐레이터 의견 있음"), 상세에 `curatorRecommendations`(의견·메모·큐레이터 이름·시각, 처리 뒤에도 기록으로 남음). 운영자가 처리하면 큐레이터 목록에서 빠지고, 의견과 다르게 처리해도 큐레이터에게 알리지 않습니다.
- 표: `curator_report_recommendations`(`report_id`, `target_key`, `course_id`, `curator_id`, `recommendation` = 새 enum `curator_recommendation`, `note` 300자). (신고, 큐레이터) unique.

### 6. 팀원 찾기 끄기(C-07 자리)와 포트폴리오 "후배 기여"

- ADR 0024가 남긴 자리대로 플래그 `courses.team_finding_disabled`를 큐레이터도 바꿉니다: `POST /api/v1/community/courses/:id/team-finding {disabled}`(그 과목 큐레이터 또는 운영자, 같은 감사 `community.course_team_finding`에 `byCurator`). 커뮤니티 모듈 경계(C-05 lint: 커뮤니티 모듈을 import하는 라우트는 커뮤니티 경로에만)를 지키려고 큐레이터 경로가 아니라 커뮤니티 경로에 둡니다. 운영자 경로는 그대로입니다.
- **포트폴리오**: 공개 프로필 `juniorContribution.curatedCourses`(과목·학교 이름)는 **지금 큐레이터이고 본인이 켠 과목만**입니다. 기본 꺼짐, 홈 "큐레이터 과목"에서 `PATCH /api/v1/me/curated-courses/:id {showInPortfolio}`(본인, 지금 큐레이터인 과목만, 아니면 404)로 켭니다. 해제되면 사라집니다(해제 사유를 구분하지 않으므로 과거 활동을 남기지 않음). 실명 프로필에만, 표시명 프로필에는 비웁니다(ADR 0028). 개수·순위 없이 과목 이름만입니다(제안·의견 수는 신고·운영 정보와 이어질 수 있어 싣지 않음).

### 7. 과목 병합·탈퇴

- 과목 병합(같은 트랜잭션): 지정 행을 정본으로 옮기고, 같은 사람이 정본에도 지정돼 있으면 원본 쪽 행을 해제(`revoked_by` = 병합한 운영자)합니다. 옮긴 뒤 2명을 넘을 수 있습니다(개념 태그 12개와 같이 운영자 정리). 과제 유형 요약은 정본에 없을 때만 옮기고 있으면 정본 것을 둡니다(원본 행은 읽히지 않음). 병합 제안·신고 의견의 과목도 정본으로. 감사 `course.merge` metadata에 `curatorsMoved`·`curatorsClosed`.
- 탈퇴 정리(`account-purge`): 그 사람의 지정 행(열린 것·해제된 것)을 지우고(삭제 장부 `course_curators`), **병합 제안의 `proposed_by`, 신고 의견의 `curator_id`, 요약의 `updated_by`만 비웁니다**(`curator_actor_refs`). 제안·의견은 운영 결정의 기록이고 요약은 과목의 글이라 남깁니다. 운영자 화면은 "탈퇴한 큐레이터"로 보입니다. 재적용은 멱등입니다.

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /operator/courses/:id/curators` | 201 목록 | 403 `operator_only`, 404, 409 `already_curator`·`limit_reached`, 422 `userId` |
| `DELETE /operator/courses/:id/curators/:userId` | 200 목록 | 403, 404 |
| `GET /curator/courses/:id` | 200 작업 화면 | 403 `curator_only`, 404 |
| `PUT /curator/courses/:id/summary` | 200 `{summary}` | 403, 409 `version_conflict`, 422, 429 |
| `POST /curator/courses/:id/tag-merge-proposals` | 201 | 403, 409 `already_proposed`, 422, 429 |
| `GET /curator/courses/:id/reports` | 200 | 403 |
| `PUT /curator/courses/:id/reports/:reportId/recommendation` | 200 | 403, 404, 422, 429 |
| `POST /community/courses/:id/team-finding` | 200 | 401, 403 `curator_only`, 404, 422 |
| `POST /operator/concept-tag-proposals/:id/approve·reject` | 200 | 403, 404, 409 `already_decided`·병합 규칙 |
| `GET·PATCH /me/curated-courses[/:id]` | 200 | 404, 422 |

## 결과

- 운영자는 과목을 마친 학교 인증 학생을 과목당 2명까지 큐레이터로 두고, 큐레이터는 요약·병합 제안·신고 의견·팀원 찾기만 합니다. 최종 처리는 운영자에게 남고, 큐레이터는 신고자·신고 설명·작성자를 보지 못합니다.
- 화면: `/operator/curators`(지정·해제·병합 제안 대기열), `/curator/:courseId`(큐레이터 작업 화면, 아니면 404), 홈 "큐레이터 과목"(포트폴리오 표시 선택), 허브 "과제 유형 요약", 운영자 신고 상세 "큐레이터 1차 검토 의견", 공개 프로필 "후배 기여"의 큐레이터 과목.
- migration `0045_student_curators`(테이블 4개, enum 2개 — 새로 만든 enum을 같은 migration의 check·부분 index에서 쓰지만 `ADD VALUE`가 아니라 `CREATE TYPE`이라 안전, 빈 DB 처음부터 migrate 확인). 플래그 없음(지정하기 전에는 동작이 같음).
- 테스트: web 통합 `curators.integration.test.ts`(지정·자격·한도·해제, 권한 표, 신고 의견·신고자 비노출, 포트폴리오 선택, 과목 병합, 소스 lint), worker 탈퇴 정리, domain 자격 순서, E2E `e03-student-curators.spec.ts`.
- 한계: 요약의 이전 판은 보관하지 않습니다. 큐레이터 의견은 처리 전 신고에만 낼 수 있고 운영자 결과를 큐레이터에게 알리지 않습니다. 학교 인증은 지정할 때만 봅니다. 해제된 큐레이터의 과거 활동은 포트폴리오에 남지 않습니다. 큐레이터 지정에 본인 동의 단계가 없습니다(운영자가 미리 연락해 정한다는 전제, 원하지 않으면 해제 요청). 큐레이터 자신이 작성자인 항목의 신고도 큐레이터 목록에 보입니다(작성자 표시는 공개 화면과 같음 — 운영자가 필요하면 일시 해제).

## 대안

- **`operators`에 범위 열 추가**: 테이블 하나로 끝나지만 운영자 판정(`isOperator`)을 쓰는 모든 경로에서 범위를 다시 검사해야 하고, 실수 하나가 전체 운영 권한이 됩니다. ADR 0010이 별도 테이블을 남긴 이유와 같습니다.
- **큐레이터가 직접 병합·신고 처리**: 빠르지만 §8.6의 "최종 처리는 운영자"와 어긋나고 병합은 학교를 넘는 전역 태그를 바꿉니다.
- **신고 사유·시각·설명을 모두 보여 줌**: 판단 근거가 늘지만 설명·시각이 작은 과목에서 신고자를 짐작하게 합니다. 사유별 개수와 지금 공개 내용으로 1차 판단에는 충분하다고 봤습니다.
- **과제 유형 요약을 구조화(유형 목록·주차표)**: 검색·집계에 좋지만 아직 무엇을 셀지 근거가 없습니다. pilot에서 쓰이는 모양을 보고 정합니다.
- **요약 판 보관(`course_type_summary_versions`)**: 되돌리기가 쉽지만 짧은 글 하나에 비해 무겁고, 고친 횟수·시각은 감사로 충분합니다.
- **포트폴리오에 해제 뒤에도 "큐레이터였음"을 남김**: 활동 기록으로는 맞지만 운영상 해제(권한 남용 등)와 임기 종료를 구분하지 않아 지금은 지정 중일 때만 보입니다.
- **학교 인증을 매 요청 확인**: 졸업생 큐레이터가 인증 만료로 조용히 권한을 잃습니다.
