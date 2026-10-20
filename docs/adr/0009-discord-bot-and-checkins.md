# 0009. 디스코드 봇과 주간 체크인: 별도 봇 프로세스 + 서명된 내부 API

- 상태: 채택(실제 디스코드 애플리케이션 연동은 미검증)
- 날짜: 2026-10-20

## 맥락

T-09는 디스코드에서 `/log`와 📌로 빌드 로그를 남기고(PROOFU_EVOLUTION_PLAN §6.5), 주 1회 60초 체크인과 주간 요약을 보내는 일입니다(§6.4, §7). 완료 조건은 "계정 연결, idempotent 수집, 타인 메시지 📌는 승인 요청, 통계 동의 분리"(DELIVERY_PLAN T-09)와 시나리오 B입니다. SYSTEM_DESIGN §12.1은 반응 수집을 **메시지 작성자 본인의 로그로만** 저장하라고 정합니다.

디스코드 gateway는 상시 WebSocket 연결이라 Nuxt 웹 서버(요청-응답, 여러 인스턴스)에 넣기 어렵습니다. 반면 권한·검증·중복 방지 규칙은 이미 웹 서버의 logs 모듈(T-04)에 있고, 두 번째 구현을 만들면 규칙이 갈라집니다.

## 결정

### 구조

- **`apps/bot`**: discord.js 14.27.0 gateway 프로세스. 디스코드 이벤트를 받아 웹 서버 내부 API를 부르고 안내 문장만 고릅니다. discord.js는 어댑터(`DiscordGateway` 인터페이스, `discord-gateway.ts`) 뒤에 두고, 업무 흐름(`handlers.ts`)은 가짜 어댑터로 테스트합니다. 봇은 DB에 접속하지 않습니다.
- **웹 서버 `/api/internal/discord/*`**: 계정 연결·채널 연결·`/log`·📌·승인 결정·예약 알림을 처리합니다. 로그는 logs 모듈의 `parseLogInput`·`insertLog`로만 만들고(출처 `discord`), 주간 요약 본문은 `formatWeeklySummary`(T-08)를 그대로 씁니다.
- **`packages/bot-protocol`**: 서명·검증 함수와 요청/응답 타입을 봇과 웹이 함께 씁니다(런타임 의존성 없음, Node 표준 crypto).

### 내부 API 인증(HMAC)

- 서명 대상: `v1\n<timestamp>\n<nonce>\n<METHOD>\n<path>\n<본문 원문>`, HMAC-SHA256, 헤더 `x-peerchive-timestamp`·`x-peerchive-nonce`·`x-peerchive-signature: v1=<hex>`. 공유 비밀은 `PEERCHIVE_INTERNAL_SECRET`.
- 시각 차이 5분 초과 거부, `timingSafeEqual` 비교, nonce는 `internal_request_nonces`에 10분 기억해 재사용을 거부합니다(받을 때 오래된 행 삭제). 재시도는 새 nonce로 다시 서명하고, 업무 중복은 아래 clientId로 막습니다.
- 실패 이유는 응답에서 구분하지 않고 401 `invalid_signature`. 비밀이 없으면 503 `internal_api_disabled`, POST가 아니면 405, 서명은 맞지만 JSON이 아니면 422.
- **CSRF 예외의 근거**: Origin 검사 미들웨어는 `/api/v1`만 봅니다. `/api/internal`은 브라우저 세션을 쓰지 않으므로 그 대상이 아니며, 내부 handler는 `event.context.auth`를 비우고 서명만 봅니다. 쿠키와 같은 사이트 Origin만으로는 401이 됩니다(테스트).
- production: 웹은 비밀이 비어 있으면 내부 API만 끄고, 값이 약하면(32자 미만, 서로 다른 문자 10개 미만, `change-me` 같은 자리표시어) 시작하지 않습니다. 봇은 production에서 강한 비밀이 없으면 시작하지 않습니다.

### 계정·채널 연결

- 웹에서 일회용 코드(10자, I·O·0·1 제외 32자 알파벳, CSPRNG, 10분, 한 번만)를 만들고, DB에는 `sha256(kind:code)`만 둡니다. 디스코드에서 `/peerchive link 코드`, `/peerchive bind 코드`. 디스코드 사용자별 10분 10회 rate limit.
- `integrations(provider, external_id, linked_at, revoked_at)`: 연결 중인 행은 (공급자, 외부 id)·(사용자, 공급자)마다 하나(부분 unique). 디스코드 토큰은 받지 않고 사용자 id만 저장합니다. 해제는 `revoked_at`.
- 채널 연결은 코드를 만든 owner 계정에 연결된 디스코드 사용자만, 그 사람이 지금도 owner일 때만 됩니다. 한 채널 = 한 프로젝트(부분 unique). (서버, 채널) id만 저장하고 채널 이름은 선택 label입니다.

### 수집

- 연결 채널 + 연결 계정 + 그 프로젝트의 active owner/editor일 때만 저장합니다. 아니면 `not_bound`/`not_linked`/`not_writer`만 돌려주고 아무것도 저장하지 않으며, 봇은 본인에게만 보이는 안내를 보냅니다.
- **중복 방지**: clientId = UUID v5(고정 이름공간, `discord:interaction:<id>` 또는 `discord:message:<id>`). logs 모듈의 (project, author, client_id) unique가 재전송·동시 요청을 하나로 만듭니다.
- **`/log` 태그별 처리**(모달 + 최소 payload 혼합):
  - 🔨진행·🔁회고·🗣️회의: 내용이 본문.
  - 🧱막힘: 내용 200자까지가 증상, 더 길면 전체를 본문에도. 막힌 시간은 `/log`의 선택 옵션이며 없으면 `lt30m`(기록 시점 기준 기본값, 로그 수정으로 고침). 시나리오 B의 `/log 막힘 CORS 에러` 한 줄로 저장되게 하려는 선택입니다.
  - ⚖️결정·✅검증: 필수 필드(선택지·기준·선택 / 대상·조건·결과)를 디스코드 모달로 받습니다.
  - 💡해결: 어떤 막힘을 풀었는지 연결해야 해서 웹으로 안내(`web_only`).
  - 검증 실패는 `invalid` + 빌드 로그 규칙의 필드별 코드, 응답은 "웹에서 마저 채워 주세요" 링크와 함께.
- **📌**: 반응한 사람이 작성자 본인이면 바로 🔨진행(본문 = 메시지, 첨부는 개수만 적음, 원문 메시지 링크를 근거 링크로). 남이 달면 `discord_pin_requests`(48시간)를 만들고 작성자에게 승인/거절 버튼 DM을 보냅니다. 버튼을 누른 디스코드 id가 작성자와 다르면 `not_found`. 승인하면 **작성자 이름으로** 로그를 만들고, 승인 전에는 로그가 없습니다. 메시지마다 요청은 하나(만료되면 다시 열 수 있음, 결정된 메시지는 `already_decided`).

### 데이터 보존(승인 대기 📌)

- 승인 때 로그를 만들려면 내용이 필요하므로 요청 행에 메시지 내용을 **승인 대기 동안만** 둡니다. 승인·거절·만료·채널 연결 해제 때 바로 `content = null`로 지우고, DB check(`status = 'pending' or content is null`)로도 강제합니다. 만료 정리는 봇이 1분마다 부르는 알림 확인 요청에서 함께 하므로 최대 48시간 + 약 1분입니다.
- 봇은 메시지 생성 이벤트를 듣지 않고, 📌이 달린 메시지만 그때 읽어 서버로 보냅니다. 연결되지 않은 채널(`not_bound`)이면 서버는 아무것도 저장하지 않고 봇도 응답하지 않습니다.

### 주간 체크인

- `weekly_checkins(project_id, user_id, iso_week 'YYYY-Www'(서울), time_bucket none|lt2h|lt5h|lt10h|ten_plus, difficulty 1–5, note ≤200, promoted_log_entry_id, share_for_stats 기본 false, skip_reasons text[] 기본 '{}', created_at, updated_at)`, (프로젝트, 사용자, 주) unique. 다시 내면 **upsert(last-write-wins)**: 본인만 고치므로 version을 두지 않습니다. 이번 주·지난주만 쓸 수 있습니다(월요일 12시 마감 뒤 늦은 제출 허용).
- active 멤버면 누구나(viewer 포함) 냅니다. **팀 안에서는** 누가 냈는지와 시간·난이도·한 줄을 서로 봅니다(과제 공간과 같은 비공개 범위, 과제 밖으로는 나가지 않음). 통계 공유 여부와 기록 못 한 이유는 본인만 봅니다.
- "이 한 줄을 빌드 로그로 옮기기": 🔨진행(본문 = 한 줄) 또는 🧱막힘(증상 = 한 줄, 막힌 시간 = 체크인 시간 구간에서 가장 가까운 값: 0→lt30m, ~2h→lt2h, ~5h→half_day, ~10h·10h+→day_plus). logs 모듈로 만들어 쓰기 권한이 없으면 403, 체크인마다 한 번(clientId = UUID v5(체크인 id)).
- 통계 동의는 체크인과 분리, 기본 꺼짐. 과목 허브 집계 API는 아직 없고, 순수 함수 `aggregateCheckinStats`(동의한 서로 다른 사람 5명 미만이면 null, 개인 식별 값 없음)만 둡니다(§11.2).

### 예약 알림(체크인 알림·주간 요약)

- **봇이 시계를 돌리고 서버가 일정을 정합니다.** 봇은 1분마다 `notices/claim`을 부르고, 서버는 `dueNotices(now)`(서울: 일 20:00~월 12:00 체크인 알림, 화 10:00~수 10:00 지난주 요약)에 해당하는 `discord_notices` 행을 (채널 연결, 종류, 주) unique로 만든 뒤 아직 안 보낸 행을 5분 임대로 돌려줍니다. 봇은 게시 후 ack합니다.
- 주간 요약은 owner가 채널 연결마다 켤 때만(`summary_enabled`, 기본 꺼짐) 만들고, 본문은 프로젝트 owner 권한으로 읽은 지난주 장부의 `formatWeeklySummary`(1900자 넘으면 리포트 링크로 줄임)입니다.
- pg-boss 스케줄을 쓰지 않은 이유: 알림을 실제로 보낼 수 있는 것은 봇뿐이라 worker가 만든 행도 결국 봇이 가져가야 하고, worker·봇 두 프로세스가 모두 떠 있어야 하는 의존이 생깁니다. 한 번 만들기는 DB unique가, 여러 봇·여러 웹 인스턴스는 `FOR UPDATE SKIP LOCKED` 임대가 보장합니다.
- 전달은 최소 한 번입니다: 봇이 게시 후 ack 전에 죽으면 5분 뒤 다시 게시될 수 있습니다. 5번 실패하면 포기(`failed_reason`). 창을 놓친(봇이 하루 넘게 꺼진) 주의 알림은 보내지 않습니다.

## 결과

- 새 의존성: `discord.js` 14.27.0(봇만). 웹·worker 의존성은 늘지 않습니다.
- 규칙이 한 곳(웹 서버)에 있어 웹·할 일 전환·디스코드·체크인이 같은 검증과 권한을 씁니다.
- 봇 장애는 기록 입력 경로 하나를 잃을 뿐 데이터 일관성에 영향이 없습니다. 웹 장애 때 봇은 "잠시 뒤 다시"만 안내합니다(재시도 1회).
- 운영할 프로세스가 하나(봇) 늘고, 공유 비밀을 웹·봇에 같은 값으로 배포해야 합니다. 비밀 교체는 두 프로세스를 함께 재시작합니다(이중 키 허용은 TODO).
- 디스코드 MessageContent는 특권 intent라 봇이 100개 서버를 넘으면 디스코드 검증이 필요합니다(pilot 규모에서는 해당 없음).
- 알려진 한계(TODO):
  - **실제 디스코드와 연결해 확인하지 않았습니다.** discord.js 어댑터(`discord-gateway.ts`)는 타입 검사만 했고, 명령 등록·모달·버튼·DM·partial 반응 처리는 실제 애플리케이션으로 확인해야 합니다(`apps/bot/README.md`).
  - 승인 대기 요청이 메시지 내용을 최대 48시간 보관합니다. 승인 시점에 봇이 메시지를 다시 읽어 보내는 방식(내용 무저장)은 메시지 삭제·수정 처리와 함께 다음에 검토합니다.
  - 📌 반응을 지워도 이미 만든 로그·요청은 그대로입니다. 디스코드에서 메시지를 지워도 로그는 남습니다(작성자가 웹에서 관리).
  - 체크인 알림은 채널 게시만 하고 개인 DM 알림은 없습니다.
  - nonce·rate limit·만료 코드 행 정리는 요청 시점 삭제 또는 주기 작업 TODO(ADR 0004)입니다.

## 대안

- 웹 서버 안에서 gateway 실행: 인스턴스마다 연결이 생기거나 리더 선출이 필요하고, 배포·재시작 때 연결이 끊깁니다.
- 디스코드 Interactions Endpoint(HTTP, gateway 없음): 슬래시 명령은 되지만 📌 반응 이벤트를 받을 수 없습니다.
- 봇이 DB에 직접 접근: 규칙이 두 곳에 생기고 DB 자격 증명이 하나 더 퍼집니다.
- mTLS·OAuth client credentials: 단일 운영자 규모에 비해 운영 부담이 큽니다. 공유 비밀 HMAC은 GitHub webhook과 같은 익숙한 방식입니다.
- pg-boss 스케줄(worker) + outbox: 위 "예약 알림" 참고.
