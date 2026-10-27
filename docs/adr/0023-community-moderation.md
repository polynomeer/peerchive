# 0023. 커뮤니티 신고 누적 임시 숨김·방 운영진 도구·이용 제한·운영자 작성자 확인: 서로 다른 인증 신고자 수 + 같은 트랜잭션 숨김 + 작성자를 모르는 방 운영진 + 사유를 남기는 확인으로만 발급하는 제재

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-06은 DELIVERY_PLAN §4.1 "서로 다른 인증 사용자 기준 수(공식 5·방 3) 도달 시 자동 숨김, 단계별 제한이 과제 공간·포트폴리오에 영향 없음, 운영자 작성자 확인에 사유·감사 기록 필수"와 §5.1 시나리오 M(신고·임시 숨김·이용 제한), GC 게이트(§7)의 필수 항목입니다. 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.9.4(방장 권한: 공지 고정·**글 숨김**·멤버 승인·내보내기, 익명 방의 방장도 작성자를 볼 수 없음), §8.9.6(익명은 다른 사용자에게 익명, 운영자는 신고 처리·법적 요청 대응에만 작성자 확인, 신고와 임시 숨김(공식 5·방 3), 권리 침해 게시 중단 요청은 별도 절차, 이용 제한: 경고 → 쓰기 기간 제한 → 커뮤니티 영구 제한, 과제 공간·포트폴리오와 분리), §15.
- SYSTEM_DESIGN §6.7 CommunitySanction(`scope community|space`, `level warning|write_suspended|permanent`, `until?`, `reason`, `report_id?`, `issued_by`, 커뮤니티 쓰기 정책 함수에서만 검사, `space` 범위는 방장에게 신원을 알리지 않음)·"Report 확장"(서로 다른 학교 인증 사용자의 열린 신고가 기준에 이르면 **같은 트랜잭션에서** `auto_hidden` + 검토 큐), §8.1(권한 표: 글·댓글 숨김/해제는 방장 "자기 방"·모더레이터 "자기 페이지", 제재는 방장·모더레이터 "제재 요청"·운영자 "결정·이의제기 처리", 작성자 확인은 운영자만 "사유·범위·감사 기록을 남긴 경우만", `canResolveAuthor`), §9.1(`POST /reports` 대상당 1회·누적 시 자동 숨김, 작성자 확인·이용 제한 API).
- ADR 0015(신고·조치는 공개 차단만·이의제기 조치마다 한 번·감사 id만), 0016(탈퇴 정리·분석 허용 목록), 0018(학교 인증), 0019(`canModerate`), 0021(정책 함수 한 곳·스키마 커뮤니티 구역 경계 검사·감사/분석 id·코드만), 0022(글 쓰기에는 감사 없음 — 익명 작성자 확인 우회 방지, `communityWriteSuspended`·`auto_hidden` 자리, 보는 사람과 무관한 DTO).

## 결정

### 테이블 (migration `0021_community_moderation`, 새 테이블은 모두 schema.ts 커뮤니티 구역)

- `community_sanctions`: `user_id`, `scope`(`community|space`), `space_id`(space 범위만, check), `level`(`warning|write_suspended|permanent`), `until`(기간 제한만 필수, 나머지는 null, check), `action_id`(짝인 `moderation_actions` 행, unique), `lookup_id`(필수: 작성자 확인 기록), `report_id?`·`request_id?`, `issued_by`, `revoked_at`·`revoked_by`. 영구는 커뮤니티 전체만(check).
- `community_author_lookups`: `operator_id`, `target_type`(`post|comment`)·`post_id`/`comment_id`(check), `author_id`(확인된 작성자, 탈퇴 정리 때 null), `reason`(1~1000자, 필수), `report_id?`/`request_id?`(둘 중 하나까지, check).
- `community_sanction_requests`: `space_id`, `requested_by`, `post_id`/`comment_id`(하나, check), `target_key`, `reason`(신고 사유 enum), `details`(1~1000자), `status`(`open|resolved|dismissed`), `closed_*`. 같은 사람·대상의 열린 요청은 하나(부분 unique).
- enum 값: `moderation_action_kind`에 `space_hide`·`sanction`(둘 다 글·댓글 id 하나를 가리키고 **공간 id는 비움**, check — 공간 id가 있으면 방장이 조치 "당사자"가 되어 제재 안내를 받게 됨), `community_notice_kind`에 `item_auto_hidden`·`item_restored`, 분석 이벤트 3개, `moderation_actions.reverse_cause`에 `space`(방 운영진의 되돌림).
- `community_notices_post_unread_key`를 `(post_id, user_id, kind)`로 바꿨습니다. 같은 글에 새 댓글 알림과 임시 숨김 알림이 함께 읽지 않은 채 있을 수 있어서입니다. 종류를 부분 인덱스 조건에 넣지 않은 이유: enum → text 변환은 IMMUTABLE이 아니라 인덱스 조건에 쓸 수 없고, 리터럴 비교는 빈 DB에 migration을 한 트랜잭션으로 돌릴 때 같은 트랜잭션에서 더한 enum 값이라 PostgreSQL이 거부합니다.
- C-05 경계 검사가 새 테이블 셋을 자동으로 덮는 것(커뮤니티 테이블 목록·소스 경계·센티넬)을 테스트로 확인했고, 행위자 × 경로 매트릭스에 운영진 도구 경로 5개를 더했습니다.

### 임시 숨김: 셈과 기준 (결정)

- 신고를 저장한 **같은 트랜잭션**에서(`createReport` → `afterReportCreated` → `applyReportThresholdInTx`) 그 글·댓글 행을 `FOR UPDATE`로 잠그고 다시 셉니다. 동시 신고는 행 잠금으로 줄을 서고, 두 번째 트랜잭션은 첫 번째가 커밋한 신고까지 읽으므로 기준을 넘는 순간 한 번만 바뀝니다.
- 셈: 그 대상의 **처리 전(open·in_review) 신고**의 서로 다른 신고자 중
  - 작성자 본인 제외(본인 신고는 받지만 세지 않음),
  - 지금 **active 학교 인증**이 있는 사람만: 학교를 연결한 공간(공식 페이지 포함)은 **그 학교(정본)**, 연결하지 않은 방은 아무 학교. 신고한 뒤 인증이 해제되면 그 신고는 남지만 더는 세지 않습니다. 다른 학교 사람이 공식 페이지를 읽는 경우(운영자)는 세지 않습니다.
  - 계정이 active인 사람만.
- 기준: 공식 페이지 5, 사용자 방·스터디 방 3(`PEERCHIVE_COMMUNITY_AUTO_HIDE_OFFICIAL`·`PEERCHIVE_COMMUNITY_AUTO_HIDE_ROOM`, 정수 2~50, 틀리면 기본값). 게시 중(`published`)인 것만 바꿉니다.
- **신고자·대상마다 한 번**: 커뮤니티 글·댓글은 같은 사람이 같은 대상을 다시 신고하면 처리 전이든 닫힌 신고든 기존 신고를 200(`created: false`)으로 돌려줍니다. 기각 뒤 같은 사람들이 다시 숨기지 못하게 하려는 것입니다. 숨긴 대상은 게시 중이 아니라 새 신고가 404입니다. 사용자별 신고 한도(시간당 10·하루 30, T-15)는 모든 대상에 그대로 적용됩니다.
- 숨기면: 상태 `auto_hidden`(본문은 DB에 남음), 모두에게 "신고가 모여 운영 검토 중인 글입니다/댓글입니다"(목록에도 자리 표시), 작성자에게 커뮤니티 알림 `item_auto_hidden`(payload는 대상 종류만 — 신고자·신고 수·사유 없음, 글·사람·종류마다 읽기 전 한 행)과 글 화면의 본인 안내. 감사 `report.create`에 `autoHidden` 참거짓만 더하고, 분석 `community_auto_hidden {targetKind}`(사용자 키 없음).
- **운영자 검토**: 대기열(`/operator`)에서 `autoHidden: true` 묶음이 맨 앞(우선 검토)입니다. 처리 방식은 기존 신고 처리 그대로입니다:
  - 기각 또는 "조치 없음"으로 처리 → **복원**(`auto_hidden` → `published`, 조치 행 `none`에 내부 메모, 신고는 dismissed/resolved, 작성자에게 `item_restored`).
  - `hide_post`·`hide_comment`로 처리 → **확정**(`hidden`, 작성자에게 공개 사유·이의제기).
- 권리 침해를 주장하는 게시 중단 요청은 이 경로가 아니라 법률 검토를 거친 별도 절차입니다(신고 대화상자에 안내, RUNBOOK §4.3).

### 방 운영진 도구 (결정: 직접 가리기 + 제재 요청 둘 다)

계획 문서가 방장의 "글 숨김"(§8.9.4)과 "자기 방" 숨김/해제(SYSTEM_DESIGN §8.1)를 명시하므로 (a) 직접 가리기와 (b) 제재 요청을 모두 엽니다.

- **가리기** `POST /community/posts|comments/:id/hide {publicReason, note?}`: `canModerate`(사용자 방 owner·admin·moderator, 공식 페이지 모더레이터 — 운영자는 이 경로가 아니라 신고 처리로). 게시 중인 것만(409 `target_not_open`), 사람마다 시간당 30. 조치 행 `space_hide`(공간 id 없음, 내부 메모는 `note` 또는 "방 운영진이 가림", 공개 사유 필수, 당사자 알림 켬) + 상태 `hidden` + 감사 `community.space_hide`(행위자는 운영진, metadata는 조치·공간 id). 작성자는 `/me/moderation-notices`에서 사유를 보고 이의를 제기합니다(누가 가렸는지는 없음).
- **되돌리기** `POST …/unhide {note?}`: 그 공간의 운영진 누구나(누가 가렸든), 운영자는 이의제기 되돌림 또는 `POST /operator/community/space-hides/:actionId/reverse`. **운영자의 가리기(hide_*)가 함께 효력이 있으면 대상은 계속 가려집니다**(되돌림은 "다른 가리기가 없을 때만 다시 보이게" — 운영자 조치 되돌림도 같은 규칙). 효력 있는 방 운영진 가리기가 없으면 409 `not_space_hidden`.
- 응답은 일반 멤버와 **같은 스레드 DTO**입니다(통합 테스트가 `toEqual`). 운영진 여부는 글 DTO에 싣지 않고, 화면은 공간 상세의 `permissions.moderate`와 별도 운영 화면으로 압니다(ADR 0022의 "역할마다 다른 응답 없음" 유지).
- **제재 요청** `POST /community/sanction-requests {targetType: post|comment, targetId, reason, details}`: 같은 운영진 자격, 같은 사람·대상의 열린 요청이 있으면 그것(200), 시간당 10·하루 30. 응답·운영 화면에 작성자는 없습니다.
- **공간 운영 화면** `GET /community/spaces/:slug/moderation`: 효력 있는 방 운영진 가리기, 이 공간의 제재 요청과 상태(처리됐으면 "제재가 내려졌는지"만), **이 공간 범위로 지금 쓰기를 막는 제재 수**. 누구인지는 어디에도 없습니다(SYSTEM_DESIGN §8.1 "이 방에서 쓰기 제한됨"). 멤버 목록에도 제한 표시를 하지 않습니다(작은 방에서 목록 대조로 사람을 특정하지 못하게).

### 작성자 확인 (결정)

- `POST /operator/community/author-lookups {targetType, targetId, reason, reportId?|requestId?}` — `canResolveAuthor`(active 운영자만, 아니면 403 `operator_only`). 사유 필수(422). 근거 신고·요청은 선택이지만(법적 요청 대응 등 신고 밖의 경우), 주면 같은 대상이어야 합니다(422 `mismatch`). 운영자마다 시간당 20·하루 60(429).
- 한 트랜잭션에서 확인 기록(사유는 **여기에만**) + 감사 `community.author_lookup`(행위자 운영자, 대상 글·댓글 id, metadata는 `lookupId`·`reportId`·`requestId`뿐 — 작성자 id·사유 없음) 뒤 201로 작성자의 내부 id·핸들·계정 상태·제재 이력을 돌려줍니다(이메일·실명 없음).
- **이 응답 밖에서는 작성자가 다시 나오지 않습니다**: 확인 기록 목록(`GET …/author-lookups`)은 누가·언제·어떤 글·사유·근거·발급 여부만, 제재 목록(`GET …/sanctions`)은 대상자 없이 수준·범위·기한·대상 글만 싣습니다. 기록을 다시 보는 것이 사유 없는 새 확인이 되지 않게 하려는 것입니다. 운영자 신고 상세·제재 요청 목록의 글·댓글은 C-04처럼 `익명`이고, 감사 조회(`/operator/audit?target=`)에도 작성자 id가 들어 있는 C-06 행이 없습니다(통합 테스트가 표면 12곳을 검사).
- 글쓰기 화면의 익명 안내(ADR 0022 `ANONYMITY_OPERATOR_NOTE`)가 이 절차를 알립니다.

### 이용 제한(제재) (결정)

- `POST /operator/community/sanctions {lookupId, level, scope, days?, note, publicReason}`: **작성자 확인으로만** 발급합니다 — 같은 운영자가 24시간 안에 한 확인(409 `lookup_not_yours`·`lookup_expired`), 탈퇴 정리된 작성자는 409 `author_unavailable`. 범위 `space`는 그 글·댓글의 공간입니다. 경고는 기한 없음, 쓰기 기간 제한은 1~365일(422 `days: required|not_allowed|too_long`), 영구는 커뮤니티 전체만(422 `scope: community_only`).
- 한 트랜잭션: 조치 행 `sanction`(대상 글·댓글, 내부 메모·공개 사유, 당사자 알림 켬) + 제재 행 + 근거 요청을 `resolved` + 감사 `community.sanction_issue`(대상은 제재 id, metadata는 id와 수준·범위 코드) + 분석 `community_sanction_issued {level, scope}`(사용자 키 없음). 근거 신고는 닫지 않습니다(가리기 여부는 신고 처리로 따로 결정).
- **효력**: `access.ts loadViewer(…, spaceId)`가 되돌리지 않은 제재를 읽고 `activeWriteRestriction`(도메인)으로 판정해 `communityWriteSuspended`·`writeRestriction`을 채웁니다. 판정 공간 기준으로 커뮤니티 전체 제재(기간 제한·영구) 또는 그 공간 범위 제재가 효력이 있으면 쓰기(글·댓글·공감)가 403 `write_restricted`(+수준·범위·기한, 어느 글·누구의 요청 때문인지는 없음)입니다. 공간 밖 판정(방 만들기)은 커뮤니티 전체 제재만 봅니다. 경고는 막지 않습니다. 기한이 지나면 되돌리지 않아도 풀립니다(요청 시각 기준 판정, worker 불필요). 읽기·가입·신고는 막지 않습니다(제한 중인 사람도 괴롭힘을 신고할 수 있어야 함).
- 글쓰기 안내(`composer.restriction`)는 **본인 응답에만** 있고 다른 사람에게는 항상 null입니다. 당사자 안내(`/me/moderation-notices`)는 수준·범위·공간 이름·기한·적용 중 여부와 공개 사유만 싣습니다.
- **과제 공간·포트폴리오·공개 프로필·과목 허브와 무관**: 제재는 커뮤니티 정책 함수에서만 읽습니다(통합 테스트가 영구 제한 중에 과제·로그 작성, 공개 프로필·과목 허브 읽기를 확인).
- **이의제기**: T-15 경로 그대로(조치마다 한 번 = 제재마다 한 번, 당사자는 글·댓글 작성자). 되돌리면(`undoModeration` → `revokeSanctionByActionInTx`) 제재가 풀립니다. 운영자 해제는 `POST /operator/community/sanctions/:id/revoke {note}`(조치 행을 `lift`로 되돌림). 신고와 이어지지 않은 이의제기(방 운영진 가리기·제재)는 `/operator` 이의제기 목록에서 바로 결정합니다.

### 탈퇴 정리 (worker `ops/purge.ts`, 결정)

- 그 사람에게 내려진 제재 행은 **지웁니다**(장부 `community_sanctions`). 짝인 운영 조치 행·이의제기는 운영 기록으로 남습니다(ADR 0016의 신고·조치와 같음).
- 작성자 확인 기록은 운영자의 **접근 기록이라 남기고**, 확인된 작성자 칸만 null로 비웁니다(`community_author_lookup_subjects`). 대상 글·댓글 id·사유·운영자는 남습니다.
- 그 사람이 운영진으로서 쓴 제재 요청은 설명 글만 지웁니다(`sanction_request_details`, 신고 설명과 같은 규칙).
- 그 사람이 운영자로서 남긴 확인·발급 기록의 행위자 칸은 가명 처리된 users 행을 그대로 가리킵니다(감사와 같음).

### 감사·분석·로그

- 감사(모두 metadata는 id·코드·참거짓만, 사유·메모·설명 글은 moderation_actions·확인 기록·요청 테이블에만): `community.space_hide`·`community.space_unhide`·`community.sanction_request`·`community.sanction_request_dismiss`·`community.author_lookup`·`community.sanction_issue`·`community.sanction_revoke`, 기존 `report.create`(+`autoHidden`)·`moderation.lift`·`appeal.*`.
- 분석 허용 목록: `community_report_filed {targetKind: space|post|comment}`, `community_auto_hidden {targetKind: post|comment}`, `community_sanction_issued {level, scope}`. 셋 다 사용자 키 없이(`unlinked`) 남깁니다(신고·제재 행동을 사람과 잇지 않음). id·사유·신고 수는 없습니다(C-05 금지 키 검사 통과).
- 커뮤니티 모듈은 서버 로그를 남기지 않습니다(C-05).

### 화면

- 글·댓글: 신고 대화상자(사유 7종 + 커뮤니티 안내: 누적 시 임시 숨김·한 번만·권리 침해는 별도 절차), "운영 검토 중" 자리 표시와 작성자 본인 안내, 방 운영진 도구(`CommunityModTools`: 가리기 대화상자·되돌리기·제재 요청 대화상자), 쓰기 제한 안내(게시판·댓글 자리).
- `/community/s/[slug]`: "방 운영" 영역(가린 글·댓글, 제재 요청과 상태, 이 방 범위 쓰기 제한 n건). `/community/notices`: 임시 숨김·복원 알림. `/me/moderation-notices`: 제재 요약·이의제기.
- 운영자: `/operator` 대기열의 "임시 숨김 · 우선 검토" 배지와 신고 없는 이의제기 결정, `/operator/reports/[id]`의 복원/확정 안내와 작성자 확인·제재 발급(`OperatorAuthorLookup`), `/operator/community-moderation`(제재 요청·제재 목록·해제·확인 기록·방 운영진 가리기). 모두 키보드로 조작, 360px에서 가로 스크롤 없음(E2E).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /reports`(커뮤니티 글·댓글) | 201 / 200(같은 사람·대상의 기존 신고, 닫혔어도) | 404(읽을 수 없음·게시 중 아님), 422, 429 |
| `POST /community/posts\|comments/:id/hide {publicReason, note?}` | 200 스레드 | 401, 403 `moderate_not_allowed`, 404, 409 `target_not_open`·`space_not_active`, 413, 422 `publicReason`, 429 |
| `POST /community/posts\|comments/:id/unhide {note?}` | 200 스레드 | 401, 403, 404, 409 `not_space_hidden`·`space_not_active` |
| `GET /community/spaces/:slug/moderation` | 200 `SpaceModerationDto` | 401, 403 `moderate_not_allowed`, 404 |
| `POST /community/sanction-requests` | 201 / 200 | 401, 403, 404, 413, 422 `targetType`·`targetId`·`reason`·`details`, 429 |
| 글·댓글·공감 쓰기, `POST /community/spaces`(방 만들기) | — | 403 `write_restricted` {level, scope, until} |
| `POST /operator/community/author-lookups` | 201 `AuthorLookupResultDto` | 401, 403 `operator_only`, 404, 422 `reason: required`·`reportId\|requestId: mismatch`, 429 |
| `GET /operator/community/author-lookups?target=` | 200 | 403, 422 `target` |
| `POST /operator/community/sanctions` | 201 `OperatorSanctionDto` | 403, 404, 409 `lookup_not_yours`·`lookup_expired`·`author_unavailable`, 422 `days`·`scope: community_only`·`note`·`publicReason` |
| `GET /operator/community/sanctions?status=active\|all` | 200 | 403, 422 |
| `POST /operator/community/sanctions/:id/revoke {note}` | 200 | 403, 404, 409 `already_revoked` |
| `GET /operator/community/sanction-requests?status=` · `POST …/:id/dismiss {note}` | 200 | 403, 404, 409 `already_closed`, 422 |
| `GET /operator/community/space-hides` · `POST …/:actionId/reverse {note}` | 200 | 403, 404, 409 `already_reversed` |
| `POST /operator/reports/:id/dismiss`·`resolve {action: none}`(임시 숨김) | 200(복원) | 기존과 같음 |

## 결과

- 신고 셋(방)·다섯(공식 페이지)이 모이는 순간 같은 트랜잭션에서 숨겨지고, 같은 사람·작성자·인증 해제된 사람·다른 학교 사람으로는 기준을 채울 수 없습니다.
- 방 운영진은 자기 공간을 정리하고 제재를 요청할 수 있지만 익명 작성자는 끝까지 알 수 없고, 운영자의 작성자 확인은 사유·기록·감사 없이는 일어나지 않으며 기록을 다시 보는 것으로 우회할 수 없습니다.
- 테스트: 도메인 `community-moderation.test.ts`(기준 수·셈·제재 입력·효력·범위 합치기·권한·알림/분석 허용 목록), 통합 `community-moderation.integration.test.ts`(방 3·공식 5 정확히 기준에서, 본인·중복·인증 해제·다른 학교 제외, 댓글, 설정 기준, 복원·확정, 대상당 한 번, 방 운영진 가리기·되돌리기·운영자 가리기와 겹침·공식 모더레이터, 요청 → 확인(사유 필수·감사 id만·기록에 작성자 없음) → 방 범위 제한(그 방만, 다른 방은 씀, 기한 뒤 풀림), 커뮤니티 범위·경고·영구·이의제기 한 번·해제·운영자별·24시간·한도, 과제·포트폴리오·프로필·허브 무관, 작성자 비노출 표면 12곳), C-05 매트릭스·테이블 목록·감사 형식 확장, worker `ops-purge`, E2E `community-moderation.spec.ts`.
- 한계: 임시 숨김 알림은 글·사람·종류마다 읽기 전 한 행이라 같은 글의 글과 댓글이 함께 숨겨지면 알림은 하나입니다. 기준 수는 배포마다 환경 변수 하나(공간별 조정 없음). 확인한 작성자는 응답에만 있으므로 운영자가 그 자리에서 제재를 정하지 않으면 다시 확인(새 기록)해야 합니다. 제재 요청은 글·댓글 하나씩입니다. 실명·연락처 문자열 경고(§8.9.6, P2)와 게시 중단 요청 절차(법률 검토)는 이번 범위 밖입니다. 공간 범위 제재가 효력이 있는 동안 작은 방에서는 "누가 갑자기 쓰지 않는지"로 추정될 수 있습니다(개수만 보여 주는 이상 줄일 수 없음).

## 대안

- **방장에게 작성자 확인 권한**: 운영이 빠르지만 §8.1·§8.9.6이 금지하고, 익명 방의 신뢰가 무너집니다.
- **제재 요청만 열고 방장 가리기는 두지 않음**: 단순하지만 계획의 "방장 권한: 글 숨김"과 다르고, 운영자 대기 동안 방이 방치됩니다.
- **신고 수만으로 숨김(인증·서로 다른 사람 무시)**: 구현이 쉽지만 한 사람·외부인이 숨김을 만들 수 있습니다.
- **worker가 주기적으로 기준을 셈**: 트랜잭션이 짧아지지만 "기준 도달 즉시"(SYSTEM_DESIGN §15 기준)를 만족하지 못합니다(SYSTEM_DESIGN 품질 기준 "신고 누적 시 자동 숨김 즉시 적용").
- **확인 기록·제재 목록에 작성자를 보여 줌**: 운영이 편하지만 기록 열람이 사유 없는 확인이 됩니다. 필요하면 다시 확인(새 기록)하도록 했습니다.
- **제재를 user id로 바로 발급(확인 없이)**: 표시명 글처럼 이미 보이는 경우엔 편하지만, 모든 발급이 사유 있는 확인을 거친다는 감사 성질이 깨집니다.
- **감사 metadata에 사유 저장**: 한곳에 모이지만 ADR 0015·0021의 "감사는 id·코드만"과 다르고, 사유에 개인정보가 섞일 수 있습니다.
- **탈퇴 정리 때 확인 기록 삭제**: 남는 개인정보가 줄지만 운영자의 접근 기록(누가 왜 봤는지)이 사라집니다. 작성자 칸만 비웠습니다.
