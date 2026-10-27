# 0027. 커뮤니티 운영 도구·계측: 숨김 시각부터 재는 처리 기한 + 본인만 보는 주간 운영 시간 + 키 없는 이벤트를 사람으로 세지 않는 지표 + 모든 칸 5 미만 가림 + 집계만 담는 CSV

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-10은 DELIVERY_PLAN §4.1의 P1 커뮤니티 백로그 마지막 항목입니다: "신고 큐·처리 시간, 주간 운영 시간 기록, §6.1 이벤트(익명 글은 사용자 키 없이)". 관련 설계:

- DELIVERY_PLAN §6.1 커뮤니티 지표(핵심: 커뮤니티 → 막힘 로그 전환, 커뮤니티 → 스터디 기록 전환. 그 밖에 스터디 공개 전환·모집 성사·아카이브 유입·재방문·신고율과 처리 시간·운영 부담·작성자 확인)와 분석 이벤트 목록, "익명 글·댓글 이벤트에는 사용자 키를 붙이지 않음", "공감 수·글 수는 개인 지표로 쓰지 않음".
- §7 GC 게이트 "신고 검토 담당과 주간 시간·대응 시간 지정", §9.1 "검토 대기 증가, 처리 시간 중앙값 24시간 초과, 주간 검토 시간이 가용 시간 초과".
- ADR 0015(신고·조치), 0016(분석 이벤트·운영자 지표 5 미만 가림·상세 상태 확인), 0019~0026(커뮤니티 테이블은 커뮤니티 모듈만 읽음, C-05 경계 검사, 익명 이벤트 `unlinked`).
- 이전 slice가 남긴 것: 대기열은 임시 숨김을 맨 앞에 두지만 나이·기한이 없음, `reports.assigned_at`은 마지막 배정만, 임시 숨김 시각이 어디에도 없음, 익명 이벤트는 이벤트마다 새 무작위 HMAC(사람 단위로 세면 익명 글 하나가 한 사람이 됨), §6.1의 `operator_identity_lookup`·`space_kind` 없음.

## 결정

### 신고 처리 기한(SLA)

- **두 가지 기한**: 신고 누적으로 임시 숨김된 글·댓글(우선 검토)은 **숨김 시각부터** `PEERCHIVE_REPORT_SLA_AUTO_HIDDEN_HOURS`(기본 24), 나머지 신고(커뮤니티 공간·모집·지원·막힘 Q&A와 아카이브 대상 모두)는 **첫 신고부터** `PEERCHIVE_REPORT_SLA_HOURS`(기본 72). 1~720 정수, 틀리면 기본값. 기한의 75%가 지나면 `due_soon`, 넘으면 `overdue`(@peerchive/domain `reportGroupSla`). 숨김 시각에서 재는 이유: §6.1 "자동 숨김 후 검토 완료까지 시간"이고, 숨김 전에는 글이 보이므로 운영 부담의 기준점이 숨김입니다.
- **새 열 두 개(`reports`)**: `auto_hidden_at`(임시 숨김을 일으킨 트랜잭션이 그때 처리 전이던 같은 대상의 신고에 채움), `first_action_at`(첫 배정 또는 처리·기각, 다시 배정해도 그대로, 신고 시각보다 앞서지 않음). 운영 지표·상태 확인이 **커뮤니티 테이블을 읽지 않고** 우선순위·처리 시간을 알 수 있습니다(C-05 경계 유지). migration은 기존 행을 채웁니다(첫 조치 = 배정·처리 중 이른 시각, 지금 임시 숨김인 대상의 처리 전 신고 = 그 대상의 마지막 처리 전 신고 시각 — 근사).
- **대기열**(`GET /operator/reports?status=&overdue=1`): 묶음마다 `sla {priority, startedAt, dueAt, targetHours, ageSeconds, state, firstActionSeconds, resolutionSeconds}`. 처리 전 묶음은 지금까지, 끝난 묶음은 처리 시각까지로 잽니다. 순서는 임시 숨김 먼저(그 안에서 오래된 것부터, 기존 그대로). `overdue=1`은 처리 전 상태에서만(아니면 422 `overdue: open_only`). 화면은 배지 문구("기한 여유·곧 기한·기한 넘김", 색만으로 구분하지 않음)와 "기한 넘김만" 필터.
- **상세 상태 확인**(`/api/v1/health?deep=1`): `reports {open, overdue, overdueAutoHidden, oldestOpenAgeSeconds, targets}` — 개수뿐(내용·id 없음). 기한 넘김은 `status`(ok/degraded)에 넣지 않습니다: 시스템 장애가 아니라 운영 대응 신호이며, 에스컬레이션은 RUNBOOK 절차로 합니다.

### 주간 운영 시간

- `ops_time_entries`(운영 구역, 커뮤니티 구역 아님): 운영자·서울 ISO 주(`YYYY-Www`)마다 한 행, 분야별 분 5개(`reports`·`official_pages`·`affiliation_support`·`curation`·`other`, 각 0 이상, 합계 10080 이하 — DB check), 메모 200자(선택).
- API: `GET /operator/ops-time`(내 기록, 이번 주 + 최근 12주), `PUT /operator/ops-time/:week {minutes, note?}`(멱등 저장, 이번 주 이후 422 `future`, 52주보다 오래되면 `too_old`), `DELETE /operator/ops-time/:week`(204, 없으면 404). 모두 운영자만(403 `operator_only`). **다른 운영자의 행을 여는 경로가 없습니다**(id 경로 없음, 주는 항상 본인 행). 감사 `ops_time.save`·`ops_time.delete`는 행 id만(주·분·메모 없음).
- 지표에는 **주·분야별 합계와 기록한 운영자 수만**(모두 5 미만 가림) 나갑니다. 사람별 순위·비교는 어디에도 없습니다.
- **탈퇴 정리는 가명 처리**: 메모만 지우고 분은 남깁니다(주간 합계·운영 비용 산정이 바뀌지 않게, 행은 가명 처리된 users를 가리킴). 지우는 대신 남긴 이유: 운영 시간은 서비스 운영 기록이고 메모가 아니면 개인을 드러내지 않습니다.
- 보존: 파일럿 기간 + 1년(운영 비용 산정 근거, DELIVERY_PLAN §10). 정리 작업은 만들지 않았고 RUNBOOK §8에 수동 절차를 적었습니다.

### 사용자 키 없는 이벤트 = `actor_hash` null

- `analytics_events.actor_hash`를 nullable로 바꾸고, `emitAnalytics({ unlinked: true })`는 이벤트마다의 무작위 HMAC 대신 **null**을 씁니다(project_hash도 null). 무작위 HMAC은 사람과 이어지지 않지만 "서로 다른 사람 수"로 세면 익명 글 하나가 한 사람이 되어 주간 활성이 부풀었습니다. null이면 세는 쪽이 "키 없음"을 확실히 압니다. 기존 행은 migration이 바꿉니다(항상 키 없는 이벤트 6종 + 익명 글·댓글). 익명 대상 공감의 과거 행은 props로 가릴 수 없어 그대로 둡니다(사람과 이어지지 않음, 커뮤니티 개방 전이라 실제 행은 없음).
- 사람 단위 지표(활성화·기록 유지·포트폴리오 공유한 사람·주간 활성)는 키 있는 이벤트만 셉니다(`computePilotMetrics`도 null을 건너뜀).

### §6.1 이벤트 점검

| §6.1 이벤트 | 구현 | 사용자 키 |
|---|---|---|
| `community_post_created`(space_kind·name_mode·board_kind) | `post_created {kind, mode, area}` — **`area` 추가**(official/room/study). C-05 금지 키 때문에 `space_kind` 대신 `area` | 익명이면 없음 |
| `community_comment_created` | `comment_created {mode, reply}` | 익명이면 없음 |
| `archive_transfer_requested`·`_completed`(target) | 같은 이름 `{target}` | 없음 |
| `recruitment_closed`(kind) | 같은 이름 `{kind, outcome}` | 있음 |
| `study_room_created` | `space_created {kind: study_room}` | 있음 |
| `study_record_logged` | `log_saved {origin: study}`(과제 키 있음) | 있음 |
| `report_filed` | `community_report_filed {targetKind}` | 없음 |
| `post_auto_hidden` | `community_auto_hidden {targetKind}` | 없음 |
| `sanction_issued`(level) | `community_sanction_issued {level, scope}` | 없음 |
| `operator_identity_lookup` | **새 `community_author_lookup {basis: report/sanction_request/none}`** | 없음 |

정적 테스트가 이 표의 emitter와 `unlinked` 규칙을, 통합 테스트가 실제 흐름의 이벤트와 null 키를 확인합니다.

### 커뮤니티 지표(`GET /api/v1/operator/metrics/community?from=&to=&space=`)

**자료**: 사람 행동은 분석 이벤트(수집 거부한 사람 제외), 운영 행동은 운영 기록(`reports`·`moderation_actions`·`community_sanctions`·`community_author_lookups`·`ops_time_entries`) — 운영 기록은 서비스 운영의 기록이라 수집 거부와 무관하게 개수로만 셉니다. 기간 규칙은 pilot 지표와 같습니다(서울 날짜, 기본 28일, 최대 366일). 계산은 순수 함수 `computeCommunityMetrics`.

| 지표(§6.1) | 정의 | 상태 |
|---|---|---|
| 주간 활성 | 서울 ISO 주마다 키 있는 커뮤니티 행동(공간 만들기·가입·이름 방식 예약·표시명/실명 글·댓글·공감·모집·지원·마감·스터디 기록)을 한 서로 다른 사람. **익명 글·댓글·공감·신고는 키가 없어 빠집니다**(재방문의 대체 관찰) | 구현 |
| 글·댓글 | 게시판 종류별·이름 방식별 개수, 익명 비율·표시명/실명 비율(§6.2 익명 외 활동 비중) | 구현 |
| 신고율 | 커뮤니티 신고 이벤트 ÷ 글 이벤트 × 100(과 × 1000, §6.1 표기) | 구현 |
| 처리 시간 | 기간 안에 처리된 묶음의 첫 조치·처리까지 중앙값, **자동 숨김 → 검토 완료 중앙값**(목표 24시간), 기한 안 처리 비율 | 구현 |
| 자동 숨김률·복원률 | 기간 안에 신고된 글·댓글 묶음 중 임시 숨김, 처리된 임시 숨김 중 기각·조치 없음(복원) | 구현 |
| 이용 제한 | 수준별 발급 수 | 구현 |
| 작성자 확인 | 건수, 신고·제재 요청과 이어진 비율(목표 100%) | 구현 |
| 지금 처리 전·기한 넘김 | 기간과 무관한 현재 값 | 구현 |
| **커뮤니티 → 막힘 로그 전환**(핵심) | 기간 안 질문 게시판 글 대비 기간 안 막힘 Q&A·막힘 로그 옮기기 완료(이벤트끼리 잇지 않은 기간 근사) | 구현(근사) |
| 옮기기 | 옮길 곳별 요청 → 완료 | 구현 |
| **커뮤니티 → 스터디 기록 전환**(핵심) | 스터디 방이 생긴 모집 마감 대비 스터디 기록 로그가 서로 다른 ISO 주 3개 이상인 스터디 과제(과제 키로 셈, 기간 근사) | 구현(근사) |
| 스터디 공개 전환 | 기록 있는 스터디 과제 중 공개 사례 게시(origin study) | 구현(선배 노트 부분은 아래) |
| 모집 성사 | 끝난 모집(마감 + 취소) 중 과제 공간·스터디 방이 생긴 비율 | 구현(분모는 끝난 모집) |
| 운영 부담 | 주·분야별 운영 시간 합계 | 구현 |
| 아카이브 유입 | "처음 연" 시점 이벤트 없음(페이지 조회 추적 안 함) | null + 이유 |
| 재방문 | 방문 이벤트 없음 → 주간 활성으로 대신 봄 | null + 이유 |
| 작성·체류 시간 | 재지 않음(인터뷰·관찰) | null + 이유 |
| 스터디 → 선배 노트 | 노트 게시 이벤트가 스터디와 이어지지 않음 | null + 이유 |

- **모든 칸 5 미만 null**(ANALYTICS_MIN_GROUP). 비율은 분자·분모 중 하나라도 가려지면 null, 중앙값은 표본 5 미만이면 null. 시간 분 합계·운영자 수에도 적용합니다(운영자 2~3명이면 운영자 수는 늘 가려짐 — 서로의 시간을 역산하지 못하게).
- **공간별 보기**: 이벤트에는 공간이 없으므로(개인 식별 위험) 공간별 값은 커뮤니티 테이블에서 개수만 셉니다. 운영자가 **명시적으로 고른 공간 하나**(`space=<id>`)만, active 멤버(공식 페이지는 그 학교 active 인증 사용자)가 **N 이상**일 때만: N = `PEERCHIVE_METRICS_SPACE_MIN_MEMBERS`(기본 **20**, 10 미만으로는 못 내림). 미만이면 409 `space_too_small {minMembers}`, 없는 공간 404. 응답에는 공간 종류만 있고 이름·id는 없습니다. 고를 수 있는 공간 목록은 `GET …/community/spaces`(운영자 화면 선택용 이름 포함). 20인 이유: 작은 방에서는 "익명 글 n개·표시명 글쓴이 m명"만으로 사람을 좁힐 수 있고, 5 미만 가림만으로는 방 단위 차분을 막기 어렵습니다.
- 지표 라우트는 `api/v1/operator/metrics/community/`에 있고 커뮤니티 모듈의 집계 파일 하나(`community/ops-metrics.ts`)만 import합니다(C-05 경계 검사의 문서화된 예외로 추가).

### CSV 내보내기(`GET /api/v1/operator/metrics/community/export?from=&to=`)

- 같은 집계를 `section,metric,dimension,value` 줄로(가린 값은 빈 칸). dimension은 코드·ISO 주·`주:분야`뿐이라 **id·이름·글·해시·공간별 값이 들어갈 자리가 없습니다**(테스트가 UUID·64자 해시·이름·센티넬 없음 확인). 파일 이름은 기간 날짜만.
- 운영자마다 시간당 10회(429), 감사 `metrics.export {kind: community_csv}`, `no-store`·`noindex`·`attachment`.

## 결과

- GC 게이트의 "주간 시간·대응 시간"과 §9.1의 초기 신호(대기 증가·중앙값 24시간 초과·주간 검토 시간)가 화면·API·상태 확인으로 측정 가능해졌습니다(RUNBOOK §2 GC 표·§4.4 주간 루틴).
- 처리 기한은 업무 시간이 아니라 달력 시간입니다(주말·야간 포함). 파일럿 대응 목표(apps/README "운영")의 "업무일"과 다를 수 있어 배지는 설계 목표로 읽습니다.
- 전환 지표는 이벤트끼리 잇지 않은 기간 단위 근사입니다(질문 글이 다른 기간에 옮겨지면 다른 기간에 셈). 개인을 잇지 않는 대가입니다.
- 지표는 기간 이벤트·신고를 메모리로 읽어 계산합니다(파일럿 규모). 커지면 SQL 집계로 바꿉니다.
- 기존 migration 이전의 첫 조치·숨김 시각은 근사입니다.

## 대안

- 기한 시작을 항상 첫 신고로: 임시 숨김 전(글이 보이는 동안)의 시간을 운영 부담으로 세게 됨. §6.1 정의와 다름.
- 임시 숨김 여부를 지표에서 커뮤니티 테이블로 읽기: ops 모듈이 커뮤니티 테이블을 읽어 C-05 경계를 깸. 신고 행에 시각을 남김.
- 익명 이벤트를 무작위 HMAC으로 유지하고 이름으로 거르기: 이벤트·props 조합마다 규칙이 생기고 새 이벤트가 빠질 수 있음. null이 규칙 하나.
- 운영 시간을 사람별로 보여 주기: 소수 운영자 사이의 비교·평가 도구가 됨(§6 "개인 지표로 쓰지 않음"의 운영자 쪽 적용).
- 탈퇴 운영자의 시간 행 삭제: 과거 주간 합계·운영 비용이 바뀜. 메모만 지움.
- 공간별 보기를 모든 공간 목록으로: 작은 방 단위 값이 쌓이면 익명 작성자를 좁힐 수 있음. 고른 공간 하나 + 멤버 기준.
