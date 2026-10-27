# Peerchive E2E 테스트

[실행 계획 §5](../../docs/planning/DELIVERY_PLAN.md)의 수용 시나리오를 실제 브라우저(Playwright, Chromium만)로 확인합니다. 빌드한 web 서버와 worker를 전용 DB로 띄워 화면을 직접 조작합니다.

## 실행

```sh
# 0) 처음 한 번: 의존성과 Chromium(다른 브라우저·시스템 패키지는 설치하지 않음)
pnpm install
pnpm --filter e2e exec playwright install chromium

# 1) web 빌드(로컬 DB 컨테이너는 내린 상태에서)
docker compose -f ops/docker-compose.yml down
pnpm --filter web build

# 2) PostgreSQL만 다시 띄우기(호스트 포트를 바꿔 쓰면 POSTGRES_PORT를 같이 지정)
docker compose -f ops/docker-compose.yml up -d --wait postgres

# 3) 실행(DATABASE_URL은 DB 이름만 바꿔 peerchive_e2e로 씁니다)
DATABASE_URL=postgres://peerchive:peerchive@127.0.0.1:5432/peerchive pnpm e2e
# 또는 pnpm --filter e2e test --project=mobile tests/h-mobile-keyboard.spec.ts

# 4) 끝나면 컨테이너 내리기
docker compose -f ops/docker-compose.yml down
```

`pnpm e2e`는 빌드하지 않습니다. 앱 코드를 바꿨다면 1)부터 다시 하세요. 실패한 테스트의 trace·스크린샷은 `apps/e2e/test-results/`(git 제외)에 남고 `pnpm --filter e2e exec playwright show-trace <trace.zip>`으로 봅니다.

| 환경 변수 | 기본값 | 뜻 |
|---|---|---|
| `DATABASE_URL` | 저장소 루트 `.env`의 값, 없으면 `postgres://peerchive:peerchive@127.0.0.1:5432/peerchive` | 접속 정보. DB 이름은 무시하고 `peerchive_e2e`를 씁니다 |
| `PEERCHIVE_E2E_DATABASE_URL` | — | E2E DB 주소를 그대로 지정(이름은 `_e2e`로 끝나야 함) |
| `PEERCHIVE_E2E_PORT` | `3417` | 테스트용 web 서버 포트(`http://localhost:<port>`) |
| `PEERCHIVE_E2E_WORKERS` | `3` | 동시에 도는 테스트 수 |

## 구성

| 경로 | 내용 |
|---|---|
| `playwright.config.ts` | Chromium 두 project: `desktop`(1280×800), `mobile`(360×740, 터치). 모든 시나리오를 두 project에서 돌립니다 |
| `support/global-setup.ts` | ① `peerchive_e2e`를 지우고 새로 만든 뒤 migration ② 빌드한 web 서버(`apps/web/.output/server/index.mjs`)를 `NODE_ENV=development`·dev-console 메일·임시 디렉터리 filesystem 저장소로 시작 ③ worker(signature-only 검사기, `NUXT_SITE_ORIGIN` 없음 — 소셜 링크 수집이 바깥에 접속하지 않음) 시작. PID와 임시 경로는 `.e2e-state/state.json` |
| `support/global-teardown.ts` | setup이 띄운 두 프로세스 그룹만 멈추고 임시 저장소를 지웁니다. DB와 서버 로그(`.e2e-state/web.log`·`worker.log`)는 조사용으로 남깁니다 |
| `support/fixtures.ts` | `newUser()`: 새 browser context에서 실제 로그인(로그인 화면 → 메일 링크 → `/auth/verify#token=…` → [로그인 계속하기] → 온보딩). `anon()`: 쿠키 없는 방문자 |
| `support/mail.ts` | dev-console 메일 읽기(서버 로그에서 가린 수신 주소로 메일을 찾고 링크를 꺼냄) |
| `support/api.ts` | 준비 단계용 API 도우미(같은 context의 쿠키와 사이트 `Origin` 헤더 사용). 시험 대상 동작은 화면으로 조작합니다 |
| `support/scenarios.ts` | 여러 시나리오가 함께 쓰는 "지난 학기 과목에 게시된 사례" 만들기 |
| `support/db.ts` | E2E DB 직접 작업: 로그인 IP rate limit 카운터 비우기, 운영자 부여 CLI·학교 메일 도메인 등록 CLI 실행, 이름 표시 방식 변경 적용 시뮬레이션(그 방 예약의 `requested_at`·`effective_at`을 7일 1분 앞당긴 뒤 worker 적용 명령 `pnpm --filter worker apply-name-modes`, C-03) |
| `support/affiliation.ts` | 학교 메일 인증(C-01): CLI로 학교마다 무작위 도메인 등록, 화면에서 코드 요청 → dev-console 메일에서 6자리 코드 읽기 → 입력. 다른 시나리오의 준비용 `verifyByApi`(API로 인증, C-02) |

## 설계 결정

- **메일 읽기: dev-console**. Mailpit(ADR 0017)은 컨테이너가 하나 더 필요하고, 로그인 링크 형식은 두 transport가 같습니다. 서버 stdout을 파일로 받아 `to: a***@도메인` 줄로 메일을 찾습니다. 주소가 가려지므로 사용자마다 무작위 도메인(`…@e2e-<무작위>.example.com`)을 씁니다.
- **DB 격리**: 개발 DB를 건드리지 않도록 같은 서버의 `peerchive_e2e`를 실행마다 지우고 다시 만듭니다. 이메일·핸들·slug·제목은 모두 무작위라 테스트끼리 겹치지 않고 병렬로 돕니다.
- **rate limit**: 매직링크 요청은 IP당 15분 20회(ADR 0006)인데 모든 테스트가 같은 루프백 IP로 로그인합니다. 로그인 도우미가 요청 직전에 `magic_link_ip:` 카운터만 지웁니다(이메일당 한도·다른 한도는 그대로). 학교 메일 인증 요청도 IP 한도(`affiliation_ip:`)가 있어 인증 도우미가 요청 직전에 그 카운터만 지웁니다(C-06 시나리오로 인증 횟수가 늘어 한도에 걸린 적이 있음, 사용자·주소별 한도는 그대로).
- **운영자**: 실제 운영 절차와 같은 `pnpm --filter @peerchive/db grant-operator <email>`를 E2E DB로 실행합니다.
- **학교 메일 인증**: 도메인 등록은 운영 절차와 같은 `school-email-domain add` CLI, 코드는 로그인 링크처럼 dev-console 메일(서버 로그)에서 읽습니다. 수신 주소가 첫 글자 + 도메인으로 가려지므로 학교마다 무작위 도메인(`e2e<무작위>.ac.kr`)을 등록하고 하위 도메인 주소를 씁니다.
- **파일 검사**: worker가 signature-only 검사기로 실제 검사 작업을 처리합니다(ClamAV 컨테이너 불필요). PDF는 테스트마다 주석 한 줄을 바꿔 같은 내용 합치기를 피합니다.
- **7일 예약(C-03)**: 시계를 바꾸지 않고 그 방의 예약 시각만 DB에서 7일 1분 앞당긴 뒤 worker와 같은 적용 함수를 명령으로 한 번 돌립니다. E2E worker의 매분 작업이 먼저 적용해도 결과가 같습니다(조건부 update).

## 시나리오

| 파일 | 시나리오 | 확인하는 것 |
|---|---|---|
| `a-private-project.spec.ts` | A | 이메일 가입, 비공개 과제·PDF 업로드(검사 후 사용 가능)·한 줄 로그, 새로고침 유지, 익명은 로그인으로·다른 사용자는 "과제를 찾을 수 없습니다"(API 404), 검색 결과 없음, GitHub 안내 없음 |
| `b-idempotent-log.spec.ts` | B(디스코드 대신) | 빠른 두 번 클릭, 서버 저장 뒤 응답 유실 → [재시도]가 같은 clientId(200)로 로그 하나 |
| `c-claims.spec.ts` | C | 로그 근거 선언 → 팀원 확인 → 수정하면 "본인 설명 · 미확인", owner에게 남의 선언 [고치기] 없음·API 403, 동료평가 리포트 상태 글자 |
| `d-embargo-consent.spec.ts` | D | 학기 진행 중 과제는 후보 불가(화면·409), 지난 학기 팀 과제는 팀원 동의 전 게시 불가 → 동의 → 게시, 고르지 않은 로그는 공개에 없음, 대체된 후보로 게시 409 |
| `e-withdraw.spec.ts` | E | 철회 즉시 공개 페이지(HTTP 404)·JSON·파일 404, 공개 프로필의 케이스는 "볼 수 없는 케이스 스터디", 과목 허브에서 빠짐 |
| `f-course-hub-fork.spec.ts` | F | 선배는 노트 화면 안내 → 학교 메일 인증(화면) 뒤 선배 노트, 익명 과목 허브: 사례·막힘·선배 노트, 워크로드 표 없음(5명 미만), 후배 포크(인증 불필요) → 마일스톤만 있는 새 비공개 과제 |
| `affiliation.spec.ts` | C-01 | 학교 검색 → 다른 학교 도메인 거부(힌트 없음) → 코드 메일 → 틀린 코드(남은 시도 4회) → 인증 → 졸업생 전환 → 공개 배지는 켤 때만(학과·메일·도메인 없음) → 그 학교 과목만 노트 작성 가능(다른 학교는 안내·API 403) |
| `g-retrospective.spec.ts` | G | 사후 작성 과제·마일스톤·로그 배지, 기억·파일 기준 날짜, 공개 화면·JSON까지 `사후 작성` |
| `h-mobile-keyboard.spec.ts` | H | 파일 먼저 → 나중에 설명, 오프라인 저장 실패에도 입력 보존·"오류 — 재시도"·재시도 성공, 새로고침 뒤 입력 복원, 할 일·마일스톤 키보드 순서 변경(포커스 유지) |
| `i-public-profile.spec.ts` | I | 익명 검토자가 `/u/<handle>`에서 문제·내 역할·근거 칩 → 공개 기록, HTML·JSON·OG·인쇄·README 카드에 이메일·체크인 메모·비공개 로그·내부 id 없음 |
| `r-personas.spec.ts` | R(S-01) | 설정 화면에서 표시명 프로필 만들기(연결 꺼짐) → 비로그인 방문자: 실명·표시명 `/u/<handle>`·인쇄 보기의 HTML(SSR payload)·OG·제목, 공개 JSON·README 카드·이전 공개 프로필 API 어디에도 상대 프로필의 handle·이름·페르소나 id·소개 없음 → 연결 켜기(확인 대화상자) → 양쪽에 서로의 링크(따라가기)·인쇄 보기에 주소, id·소개는 여전히 없음 → 끄기 → 다음 요청부터 다시 0건 |
| `s-visibility.spec.ts` | S(S-03) | 설정 화면에서 네 항목 전체 공개 + 과제 둘(지난 학기 팀 과제·엠바고 과제) 고르기 → 비로그인 방문자: `/u/<handle>`·인쇄 보기의 HTML(SSR payload)·공개 JSON·README 카드·이전 공개 프로필 API에 과목·학기·고른 과제 제목만, 엠바고 과제 제목·고르지 않은 비공개 과제·팀원 이름·handle·id·로그·동의 대기 후보·과제 id 0건 → `로그인 사용자`로 좁히면 비로그인 응답에서 빠지고 로그인한 다른 사용자 화면에만 붙음 → 과제 API 읽기 결과 그대로(외부인 404·팀원 200) → 남의 페르소나 PUT 404·공개 사례 항목 422 |
| `t-follows.spec.ts` | T·U(S-04) | B가 설정 화면에서 비공개 계정으로 바꿈 → A가 B의 `/u/<handle>`에서 팔로우 요청(요청 취소 버튼으로 바뀜) → B가 `/settings/follows`에서 승인, 팔로워 1 → B가 A의 프로필 페이지 "차단·뮤트"에서 차단 → A에게 B의 관계·팔로워·세션 프로필 API와 팔로우 404, `/u/<B>`는 "프로필을 찾을 수 없습니다", 팔로우 삭제, 남의 팔로우 관리 API 404 |
| `v-social-links.spec.ts` | V(S-06, 화면 부분) | `/settings/personas`에서 내부망 IP 주소 거부 문구 → GitHub 링크 넣기, `확인 전`·확인 요청 버튼 → 방문자의 `/u/<handle>`에 `nofollow` 링크, `링크 확인됨` 없음 → 지우면 사라짐. 바깥 인터넷에 접속하지 않도록 확인 요청은 누르지 않고 E2E worker에는 `NUXT_SITE_ORIGIN`을 주지 않음(수집·verified·lost·사설 IP redirect 거부는 worker 테스트) |
| `community.spec.ts` | C-02 | 학교 인증(준비는 API) → 방 만들기 화면(예약어 이름 거부·학교 연결·표시명·초대 전용·링크로만) → 비멤버는 "찾을 수 없습니다"(API 404) → 초대 링크(화면) → 다른 인증 사용자가 수락 → 같은 링크 재사용 410 → 방장 나가기 → 남은 멤버가 방장(승계). API·페이지 `X-Robots-Tag: noindex, nofollow, noarchive`, 비로그인 API 401, 공개 검색에 방 이름 없음 |
| `community.spec.ts` | C-03 | 방장이 화면에서 "익명으로 바꾸기" 예약(확인 대화상자) → 배너 "7일 뒤 … 이미 쓴 글은 바뀌지 않습니다." → 두 번째 예약 409·멤버 예약 403 → 멤버 화면 배너·`/community`의 읽지 않은 알림 수·`/community/notices`의 예약 알림 → 적용 시뮬레이션 → 이름 표시 방식 "익명"·배너 없음·이력 "적용됨"·적용 알림·모두 읽음 → 방장 선택지가 새 방식 기준 |
| `community-posts.spec.ts` | C-04 | 익명 방(준비는 API): 게시판 화면의 "이 방은 익명으로 표시됩니다" → 멤버가 글(`글쓴이`·내 글) → 다른 멤버 댓글(`익명1`·내 댓글)·공감(비추천 버튼 없음) → 글쓴이 답(`글쓴이`) → 같은 사람 다시 `익명1` → 둘째 스레드는 따로 번호(첫 스레드의 글쓴이가 `익명1`) → 방장 화면도 같은 표시·신고 대화상자, API에 사람 id·이메일·핸들·표시 이름 없음, 비멤버 404(소스에 제목 없음), 문서 제목 고정 |
| `community-visibility.spec.ts` | C-05 | 비로그인 방문자: 실제 방·없는 방·초대·첫 화면 모두 같은 404 고정 HTML(방 이름·`__NUXT`·OG 없음, robots meta·noindex/no-store/no-referrer 헤더, 쿠키 없음), API 401 → 링크 미리보기 봇 UA 4종도 같은 404 → 다른 학교 인증 사용자는 "공간을 찾을 수 없습니다"(HTTP 404, 소스에 방 이름 없음) → 방장 화면도 제목 `Peerchive 커뮤니티`·og/description meta 없음 → 로그아웃 뒤 화면·`__NUXT_DATA__`·뒤로 가기·같은 주소에 방 이름 없음 → `/robots.txt`는 `Disallow: /` |
| `community-moderation.spec.ts` | C-06 | 익명 방(준비는 API): 멤버가 신고 대화상자(커뮤니티 안내)로 신고 + 둘 더 → 모두에게 "신고가 모여 운영 검토 중인 글입니다", 작성자 본인 안내 → 운영자 대기열 "임시 숨김 · 우선 검토" → 기각(복원) → 방장이 작성자를 모른 채 제재 요청(방 운영 영역·API에 작성자 식별자 없음) → 운영자 `/operator/community-moderation`에서 사유를 적고 작성자 확인 → 이 방 7일 쓰기 제한 → 그 사람은 이 방 게시판에 제한 안내·API 403 `write_restricted`, 다른 방에는 화면으로 글을 씀, 본인 운영 안내·이의제기 버튼 → 방장 화면 "쓰기 제한 1건"·"제재가 내려졌습니다"뿐. 확인 기록에 사유는 있고 작성자는 없음. 360px 가로 스크롤 없음 |
| `community-recruitments.spec.ts` | C-07 | 스터디: 과목 허브의 "이 과목 팀원 찾기·스터디 모집"(인증 사용자만, 비로그인에는 없음) → 스터디 모집 올리기(표시명 기본) → 둘이 지원(메시지) → 다른 지원자는 지원자 목록 API 403·모집자 영역 없음 → 모집자가 지원 순서대로 보고 첫 사람 선정 → 마감(스터디 방) → 선정되지 않은 사람은 "모집이 마감되었거나 선정되지 않았습니다."·방 404 → 선정된 사람은 알림 → 초대 받기 → 초대 수락 → 스터디 방 멤버(수락 전 404). 팀원 찾기: 학기를 고른 모집 → 지원 → 선정 → 마감(비공개 과제 공간, 모집자는 결과 링크로 이동) → 선정된 사람은 수락 전 과제 API 404 → 초대 받기 → 수락 → 과제 공간. noindex·비로그인 401·공개 검색에 제목 없음, 360px 가로 스크롤 없음 |
| `community-archive-transfer.spec.ts` | C-09 | 익명 방 질문 게시판: 질문한 학생이 답을 채택("채택된 답변") → "아카이브로 옮기기"(막힘 Q&A·과목 찾기·익명) → 요청 화면에 "답변자 동의 대기 중"만(화면·API에 답한 학생 id·핸들·이름·메일 없음) → 동의 전 과목 페이지에 없음 → 답한 학생이 커뮤니티 알림에서 요청을 열어 옮겨질 글을 보고 익명으로 동의 → 비로그인 방문자가 /c/<과목>에서 막힘 Q&A(질문한 학생·답한 학생, 사람 id·방 slug·글 id 없음) → 원 글에 "아카이브로 옮겨짐" → 질문한 학생이 철회하면 과목 페이지에서 바로 사라짐. 360px 가로 스크롤 없음 |
| `community-study-records.spec.ts` | C-08 | 스터디 모집(API)으로 만든 표시명 방: 방장이 기록 탭에서 "스터디 기록 켜기" → 멤버가 기록 탭에서 빌드 로그 작성(과제 쪽 초대 409, 방 밖 사람 404) → 공개 후보(방 멤버 모두 당사자, 동의 전 게시 409) → 멤버가 동의 화면에서 동의 → 게시 → `/p`에 "스터디 기록", 과목 허브 카드에 "스터디" 배지(방 이름 없음). 익명 방: 기록 탭에서 다른 멤버가 "스터디 멤버 N", 이름 노출 후보 422, 게시 뒤 케이스 스터디 422 `anonymous_study`·포트폴리오 출처 목록에 없음. desktop·360px 가로 스크롤 없음 |
| `community-ops.spec.ts` | C-10 | 표시명 방에 글 하나·신고 하나(API) → 운영자 대기열의 묶음에 처리 기한 배지("기한 여유 … 목표 72시간"), "기한 넘김만" 필터에는 없음 → `/operator/ops-time`에서 이번 주 분야별 분 저장·수정(내 기록 표 합계) → `/operator/community-metrics`(처리 기한 24·72시간, 운영 시간 표에 이번 주, 재지 않는 지표 이유, 방 이름 없음) → CSV 내보내기(집계 머리 줄, 방 이름·slug·글 id·본문·메모·UUID 없음). 운영자 아니면 화면 404 문구·API 403. desktop·360px 가로 스크롤 없음 |
| `moderation.spec.ts` | T-15 | 신고(화면) → 운영자 "항목 하나 가리기" → 공개 페이지에 "운영 조치로 가려진 항목" |
| `a11y-and-layout.spec.ts` | 접근성 | 주요 화면 16곳(학교 인증·표시명 프로필·커뮤니티·커뮤니티 알림 화면 포함): 보이는 h1 하나, 이름 있는 입력 칸, Tab 포커스 표시(첫 Tab은 건너뛰기 링크), 가로 스크롤 없음 |

## 한계

- 실제 디스코드(B의 `/log`·📌)와 실제 SMTP 발송, ClamAV·S3 저장소는 다루지 않습니다(각 패키지 통합 테스트 범위).
- 접근성 검사는 기본 규칙만입니다(axe 같은 도구 없음). 화면 낭독기 확인은 사람이 해야 합니다.
- 서버는 `NODE_ENV=development`로 띄우므로 production 전용 거부 규칙(dev-console 금지 등)은 확인하지 않습니다.
