# Peerchive 디스코드 봇 (`apps/bot`)

디스코드에서 `/log`와 📌 반응으로 빌드 로그를 남기고, 연결된 채널에 주간 체크인 알림·주간 기여 요약을 올리며, 팀 전원이 동의한 회의 채널에서는 `/summarize`로 AI 회의 요약 초안을 만드는 봇입니다([ADR 0058](../../docs/adr/0058-ai-meeting-summary.md)). 업무 규칙(권한·검증·중복 방지)은 웹 서버에 있고, 봇은 HMAC으로 서명한 내부 API 요청만 보냅니다. 결정 배경은 [ADR 0009](../../docs/adr/0009-discord-bot-and-checkins.md)를 보세요.

> **현재 상태**: 업무 흐름은 가짜 디스코드 어댑터로 테스트했고, 웹 서버 내부 API는 실제 PostgreSQL과 서명한 요청으로 확인했습니다. **실제 디스코드 애플리케이션으로는 아직 실행해 보지 않았습니다.** 아래 순서로 처음 연결할 때 명령 등록·모달·버튼·DM·📌 반응을 하나씩 확인해 주세요.

## 구성

| 파일 | 내용 |
|---|---|
| `src/main.ts` | 진입점. gateway 연결, 1분마다 예약 알림 확인, 종료 신호 처리 |
| `src/discord-gateway.ts` | discord.js 어댑터(이벤트 → `gateway.ts` 타입, 응답·DM·채널 게시) |
| `src/handlers.ts` | 업무 흐름(명령 해석 → 내부 API → 안내 문장). discord.js를 모름 |
| `src/commands.ts` | 슬래시 명령 정의(등록 JSON)와 입력 해석, 버튼·모달 id |
| `src/api-client.ts` | 서명한 내부 API 호출(네트워크 오류·5xx면 새 nonce로 1회 재시도) |
| `src/messages.ts` | 사용자에게 보내는 문장 |
| `src/register-commands.ts` | 슬래시 명령 등록 스크립트 |

## 디스코드 애플리케이션 만들기

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. 이름 예: `Peerchive`.
2. **General Information**의 **Application ID** → `DISCORD_APPLICATION_ID`.
3. **Bot** 탭
   - **Reset Token**으로 토큰을 만들어 `DISCORD_BOT_TOKEN`에 넣습니다. 토큰은 저장소·채팅에 올리지 마세요. 새면 바로 다시 Reset 하세요.
   - **Public Bot**은 끄는 것을 권장합니다(pilot 서버에만 초대).
   - **Privileged Gateway Intents**에서 **Message Content Intent**를 켭니다. 📌이 달린 메시지 본문을 읽는 데 필요한 특권 intent이며, 봇이 100개 넘는 서버에 들어가면 디스코드의 검증을 받아야 합니다. Server Members·Presence intent는 필요 없습니다.
4. 봇이 쓰는 gateway intents(코드에서 지정): `Guilds`, `GuildMessages`, `GuildMessageReactions`, `MessageContent`.

## 서버에 초대하기

**OAuth2 → URL Generator**

- Scopes: `bot`, `applications.commands`
- Bot Permissions(최소): **View Channels**, **Send Messages**, **Read Message History**(📌이 봇 실행 전 메시지에 달렸을 때 그 메시지를 읽기 위해, 그리고 `/summarize`가 회의 채널의 최근 메시지를 읽기 위해). 권한 정수 `68608`.

만든 URL을 서버 관리자가 열어 초대합니다. 기록 채널에서 봇이 위 권한을 갖는지 확인하세요(채널별 권한 덮어쓰기 주의). DM 승인 요청은 받는 사람이 "서버 멤버의 DM 허용"을 꺼 두면 전달되지 않으며, 그때는 📌을 단 사람에게 그 사실을 알립니다.

## 환경 변수

저장소 루트 `.env`(`.env.example` 참고)를 읽습니다. 이미 설정된 환경 변수가 우선합니다.

| 변수 | 필수 | 내용 |
|---|---|---|
| `DISCORD_BOT_TOKEN` | 예 | 봇 토큰 |
| `DISCORD_APPLICATION_ID` | 명령 등록 때 | Application ID |
| `DISCORD_GUILD_ID` | 아니요 | 명령을 이 서버에만 등록(개발용, 즉시 반영). 비우면 전역 등록(반영에 시간이 걸릴 수 있음) |
| `PEERCHIVE_INTERNAL_SECRET` | 예 | 웹 서버와 같은 공유 비밀. production에서는 32자 이상의 무작위 값(`openssl rand -hex 32`)이어야 하며 `.env.example`의 자리표시 값으로는 웹·봇 모두 시작하지 않음 |
| `PEERCHIVE_API_BASE_URL` | production에서 예 | 웹 서버 주소(개발 기본 `http://localhost:3000`). 봇과 웹 사이 구간은 TLS 또는 사설망으로 두세요 |
| `PEERCHIVE_SITE_URL` | 아니요 | 안내 문장에 넣을 사이트 주소(기본: API 주소) |

웹 서버에도 같은 `PEERCHIVE_INTERNAL_SECRET`이 있어야 `/api/internal/discord/*`가 켜집니다(없으면 503). 링크를 만들 `NUXT_SITE_ORIGIN`도 실제 주소로 설정하세요.

## 실행

```sh
pnpm install
pnpm --filter bot register-commands   # 처음 한 번, 명령 정의를 바꿨을 때
pnpm dev                              # 웹 서버(다른 터미널)
pnpm bot                              # 봇(개발 모드, NODE_ENV=development)
```

배포용은 `pnpm --filter bot start`(production 기본)입니다. SIGINT/SIGTERM이면 알림 확인을 멈추고 gateway 연결을 닫습니다. 봇은 하나만 띄우는 것을 권장합니다(여러 개여도 알림은 서버의 임대로 한 번만 가져가지만, 같은 이벤트를 두 봇이 받으면 안내 DM이 두 번 갈 수 있음).

## 사용 흐름

1. 각자 웹 **프로필 설정 → 디스코드 연결**에서 코드를 만들고, 디스코드에서 `/peerchive link 코드`(10분, 한 번만).
2. 과제 owner가 과제 화면 **디스코드 연결 → 채널 연결 코드 만들기** 후, 기록할 채널에서 `/peerchive bind 코드`. 한 채널은 한 과제에만 연결됩니다.
3. 연결된 채널에서
   - `/log tag:🧱 막힘 text:CORS 에러 [time:2시간 미만]` → 로그 하나(같은 interaction을 다시 보내도 하나)
   - ⚖️ 결정·✅ 검증은 필수 항목 모달이 열립니다. 💡 해결은 막힘 연결이 필요해 웹으로 안내합니다.
   - 내 메시지에 📌 → 🔨 진행 로그. 남의 메시지에 📌 → 작성자에게 승인/거절 DM(48시간), 승인해야 작성자 이름으로 저장.
4. owner가 채널별로 **주간 요약**을 켜면 화요일 10시에 지난주 요약을 올립니다. 체크인 알림은 일요일 20시에 연결된 모든 채널에 올립니다.
5. (웹 서버에 AI가 설정된 경우, E-13) owner가 과제 화면 **AI 회의 요약 → 회의 채널로 제안**을 누르고 팀원 **전원**이 같은 화면에서 동의하면, 그 채널에서 `/summarize [window:최근 2시간] [count:100]`을 쓸 수 있습니다(owner/editor). 봇은 먼저 서버에 확인하고(동의·권한·AI 설정이 아니면 안내만 하고 메시지를 읽지 않음), 된다고 할 때만 최근 메시지를 읽어 봇·시스템 메시지와 **동의한 팀원(디스코드 계정 연결)이 아닌 사람의 메시지**를 빼고(개수만) 첨부는 개수만 세어 한 번 보냅니다. 서버도 팀 밖 메시지를 다시 거릅니다. 원문은 봇·서버 어디에도 저장하지 않고, 만든 초안은 다른 팀원이 웹에서 승인해야 🗣️ 회의 로그가 됩니다. 이 요청은 재시도하지 않습니다(AI 호출이 겹치지 않게).

봇의 모든 명령 응답은 본인에게만 보입니다. 연결되지 않은 사용자나 멤버가 아닌 사람에게는 안내만 하고 아무것도 저장하지 않습니다.

## 처음 연결할 때 확인할 것(미검증 항목)

- [ ] `register-commands`가 `/peerchive`(link·bind·help)·`/log`(tag 선택지 7개, text, time)·`/summarize`(window 선택지 6개, count 1~200)를 등록하는지, 한국어 선택지가 보이는지
- [ ] `/summarize`가 회의 채널에서 최근 메시지를 읽는지(Read Message History), 범위 밖·봇 메시지를 빼는지, 30초 넘게 걸려도 "생각 중" 뒤 결과로 바뀌는지
- [ ] `/log`가 3초 안에 응답하는지(서버가 느리면 "생각 중" 뒤 결과로 바뀌는지)
- [ ] `/log 결정`·`검증` 모달이 열리고 제출되는지, 처음 입력한 내용이 본문 칸에 채워지는지
- [ ] 봇 실행 전 메시지에 단 📌도 처리되는지(partial 메시지·반응)
- [ ] 승인 요청 DM의 승인/거절 버튼이 동작하고 버튼이 사라지는지
- [ ] 알림 게시가 `@everyone` 등 멘션을 일으키지 않는지(allowedMentions 비활성)

## 테스트

```sh
pnpm --filter bot test         # 가짜 어댑터·가짜 서버로 명령·📌·승인·알림·서명·재시도·/summarize(확인 전 읽지 않음·크기 상한)
pnpm --filter bot typecheck
```

웹 서버 쪽 규칙(코드 단일 사용·만료·해시 저장, `/log` 중복 방지, 📌 승인·거절·만료, 알림 주당 한 번)은 `apps/web/test/discord.integration.test.ts`, 서명 검증은 `apps/web/test/internal-auth.test.ts`와 `packages/bot-protocol/test`가 확인합니다.
