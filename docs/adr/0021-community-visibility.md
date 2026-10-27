# 0021. 커뮤니티 열람 범위·검색엔진 비노출: 정책 함수 한 곳 + 비로그인 화면은 SSR 전 404 고정 HTML(API는 401) + 항상 noindex·noarchive + robots.txt + 고정 제목·OG 없음 + 스키마 구역 기반 경계 검사

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

C-05는 DELIVERY_PLAN §4.1 "비로그인·다른 학교·비멤버 404, `noindex`·robots·사이트맵 제외, OG 본문 미리보기 없음, 공개 검색·임베딩·집계에 커뮤니티 본문 0건"이고, §7 GC 게이트(커뮤니티 개방)의 필수 회귀 테스트입니다. 관련 설계:

- PROOFU_EVOLUTION_PLAN §8.9: 커뮤니티 글은 로그인한 같은 학교 구성원·방 멤버만 보고, 검색엔진에 색인하지 않으며, 외부에 링크를 붙여도 본문 미리보기를 만들지 않습니다.
- SYSTEM_DESIGN §6.7(커뮤니티 테이블은 공개 release 조회 경로와 섞지 않는 별도 모듈 `server/modules/community`가 소유), §8.1(권한 표: 비로그인·다른 학교 404, listed 방도 이름·소개·멤버 수만), §8.2(학교 연결 공간은 그 학교 active 인증만, 인증 해제 다음 요청부터 차단, 로그인 전용·권한 없으면 404, `X-Robots-Tag`·meta·robots.txt·사이트맵 제외는 보조 장치, OG는 일반 카드만, 공개 검색 색인·임베딩·과목 집계·공개 release·포트폴리오에 커뮤니티 본문 없음), §11(공개 읽기 경로는 비공개 테이블을 읽지 않음).
- ADR 0012·0013·0014: 공개 조회(`/api/v1/public/**`, `/p`·`/c`·`/u`·`/search`)는 `PEERCHIVE_PUBLIC_INDEXING`으로 색인을 정하고(기본 noindex), 공개 읽기 모듈은 공개 release 상태만 읽습니다.
- ADR 0019(C-02)·0020(C-03): 정책 함수(`canReadSpace`·`canPreviewSpace`), `/api/v1/community/**` 로그인 필수·noindex, 소스 경계·센티넬 테스트의 시작점. 글·댓글(C-04)은 아직 없습니다.

## 결정

### 1. 열람 매트릭스: 정책 함수 한 곳

모든 커뮤니티 읽기(API·화면 SSR·내 공간 목록·찾기·알림의 공간 이름·신고 대상 확인·초대 미리보기, C-04 이후 글 목록)는 `@peerchive/domain`의 `canReadSpace`·`canPreviewSpace`(+ 가입은 `canJoinSpace`)만 거칩니다. 서비스는 `loadReadableSpace`·`getSpaceDetail`에서 판정하고, 읽을 수 없으면 `NOT_FOUND`(404)이며 존재 여부를 구분하지 않습니다.

| 행위자 \ 공간 | 공식 페이지 | 학교 연결 사용자 방 | 학교 무관 사용자 방 | 초대 전용 방 |
|---|---|---|---|---|
| 비로그인(화면) | 404 고정 HTML | 404 고정 HTML | 404 고정 HTML | 404 고정 HTML |
| 비로그인(API) | 401 | 401 | 401 | 401 |
| 미인증(학교 인증 없음) | 404 | 404 | 404 | 404 |
| 다른 학교 인증 | 404 | 404 | 소개만(가입 가능하므로) | 404 |
| 같은 학교 비멤버 | 읽기(인증 파생) | 소개만 | 소개만 | 404 |
| 승인 대기 | — | 소개만 | 소개만 | 404(C-05 변경) |
| 내보냄(removed)·나감(left) | 읽기(인증 파생) | 404 / 소개만 | 404 / 소개만 | 404 |
| 멤버, 인증 해제 뒤 | 404 | 404 | 다른 인증이 없으면 404 | 404 |
| active 멤버(자격 있음) | 읽기 | 읽기 | 읽기 | 읽기 |

- **인증 해제(C-05 변경)**: 사용자 방·스터디 방도 `canReadSpace`가 지금의 학교 자격을 봅니다(`meetsRoomAffiliation`: 학교 연결 방은 그 학교 active 인증, 학교 무관 방은 아무 학교 active 인증 하나 — 들어올 때의 조건과 같음). 인증이 해제·취소·만료되면 멤버십이 남아도 다음 요청부터 404이고, 다시 인증하면 돌아옵니다. 읽기에 묶인 권한(`canModerate`·`canWriteBoard`·관리)도 같이 사라집니다. 학교 무관 방까지 넣은 이유: 커뮤니티 전체가 "인증 구성원끼리"라는 전제이고(ADR 0019의 "로그인만으로 방 만들기" 대안 기각), 미인증 계정이 남은 멤버십으로 계속 읽는 길을 남기지 않기 위해서입니다. 나가기(요청 취소 포함)는 자격과 무관하게 됩니다.
- **목록·알림도 같은 함수**: `GET /community/spaces/mine`은 읽을 수 없는 방(인증 해제)과 소개를 볼 수 없는 승인 대기(초대 전용으로 바뀐 방)를 뺍니다. 알림은 행을 남기되 지금 읽을 수 없는 공간의 이름·주소를 싣지 않습니다(C-03 그대로).
- **초대 링크**: 토큰이 있어도 학교 자격이 없으면(다른 학교·미인증·해제) `POST /community/invitations/preview`가 방 이름·소개 없이 404 `not_eligible`입니다(이전에는 200 + 이름 + `reason: not_eligible`). 화면은 학교 인증 안내만 보여 줍니다. 수락은 전처럼 404.
- 가입 시도(`POST …/join`)는 자격이 없으면 404, 내보내진 사람은 403 `removed`, 초대 전용은 자격 있는 사람에게만 403 `invite_only`(ADR 0019 그대로). 이 둘은 이미 그 방을 아는 사람에게만 나옵니다.

### 2. 비로그인 응답: 화면은 404, API는 401 (결정)

- **화면 `/community`·`/community/**`**: 세션이 없거나 무효·만료면 서버 미들웨어(`03.community`, `createCommunityGuard`)가 SSR 전에 **404 + 고정 HTML**(`COMMUNITY_NOT_FOUND_HTML`)을 돌려줍니다. 실제 방·없는 방·초대 주소·`/community` 첫 화면 모두 같은 바이트이고, Nuxt payload·방 이름·OG·description이 없습니다(제목 `Peerchive 커뮤니티`, robots meta, 로그인·처음으로 링크뿐). 세션 미들웨어(`02.auth`)가 커뮤니티 화면 경로에서도 세션을 검증합니다. 링크 미리보기 봇(Slackbot·Discordbot·facebookexternalhit·Twitterbot·TelegramBot·kakaotalk-scrap 등)은 쿠키가 없으므로 이 응답을 받습니다(User-Agent로 분기하지 않음).
  - 로그인 화면으로 보내지(302) 않는 이유: 계획이 비로그인 404를 요구하고, 리다이렉트는 "이 주소는 로그인하면 열린다"는 신호가 되며, 링크 미리보기에 로그인 화면 카드가 붙습니다. 대신 404 페이지에 로그인 링크가 있습니다(어떤 주소에도 같으므로 정보가 없음). 초대 링크를 비로그인으로 열면 로그인 뒤 다시 열어야 합니다(ADR 0019 한계 그대로).
- **API `/api/v1/community/**`**: 비로그인은 **401 `unauthenticated`**를 유지합니다. 공간을 조회하기 전에 모든 경로에 같은 본문으로 나오므로 존재 여부를 드러내지 않고(테스트: 있는 slug·없는 slug·없는 경로의 본문이 같음), JSON 클라이언트(화면의 `$fetch`, 봇 없음)가 "로그인 필요"와 "없음"을 구분해 로그인 흐름으로 보낼 수 있습니다. 다른 `/api/v1`도 비로그인은 401이라 일관됩니다. 로그인한 사람에게 읽을 수 없는 공간은 404입니다.
- 로그인했지만 읽을 수 없는 사람(다른 학교·비멤버 등)의 화면은 앱 안의 "공간을 찾을 수 없습니다"(HTTP 404)이고, SSR payload에는 API 404 오류(상태·코드)만 있으며 방 데이터가 없습니다.

### 3. 소개(preview) 내용 (결정)

- 소개는 `access: 'preview'`, 이름·멤버 수·가입 방식·이름 표시 방식(+ 예약 배너)·학교·정원만입니다. 게시판 `[]`, 권한 전부 false, 멤버 목록 없음(`GET …/members`는 404), 정원 검토 요청값 `capacityRequested`는 null.
- **unlisted 방은 소개 글(`description`)도 null**(`previewIncludesDescription`). unlisted는 "목록에 없고 링크로만"이라 링크가 전달되면 받은 사람이 같은 학교 구성원이기만 하면 소개를 보게 되는데, 방장이 소개 글을 멤버용으로 쓴 경우가 많고 이름만으로도 가입 판단은 됩니다. listed 방은 찾기 목록에도 소개 글이 나오므로 그대로입니다. 승인 대기 목록의 unlisted 방도 소개 글 없음.
- **초대 전용 방은 소개가 없습니다**(승인 대기 중이어도, C-05 변경). 방이 초대 전용으로 바뀐 뒤 남은 승인 대기는 화면·목록에서 사라지지만 방장은 승인·거절할 수 있고, 본인은 API로 요청을 취소할 수 있습니다(한계).

### 4. 검색엔진 비노출

- **헤더**: 커뮤니티 화면·API의 모든 응답(성공·오류·비로그인)에 `X-Robots-Tag: noindex, nofollow, noarchive`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. 공개 색인 설정과 무관하게 항상 붙습니다. `noarchive`를 더한 이유: 검색엔진 캐시 사본이 철회·탈퇴 뒤에도 남는 것(SYSTEM_DESIGN §11)을 커뮤니티에서는 처음부터 막습니다.
- **meta**: 모든 커뮤니티 화면이 `useCommunityPage()`로 `<meta name="robots" content="noindex, nofollow, noarchive">`·`<meta name="referrer" content="no-referrer">`를 둡니다.
- **robots.txt**(`server/routes/robots.txt.get.ts`, 요청마다 환경 변수를 읽음):
  - `PEERCHIVE_PUBLIC_INDEXING` 꺼짐(파일럿 기본): `User-agent: *` / `Disallow: /`.
  - 켜짐: `/community`·`/api/v1/community`·`/api/`·`/settings`·`/me`·`/operator`·`/projects`·`/portfolio`·`/consents`·`/invite/`·`/auth/`·`/login`·`/onboarding`·`/senior-notes`를 Disallow, `/p/`·`/c/`·`/u/`·`/search`·`/api/v1/public/`·`/`(정확히)만 Allow, 나머지 `Disallow: /`(기본 차단). 과목 허브는 `/c/`로 끝 슬래시를 붙여 `/community`와 겹치지 않습니다.
  - `Sitemap:` 줄은 없습니다.
- **사이트맵**: 없습니다. 테스트가 `apps/web`의 server·app·public에서 이름에 sitemap이 들어간 파일을 찾아 커뮤니티 경로·테이블·모듈을 담으면 실패하고, sitemap 모듈 의존성이 생기면 실패합니다(만들 때 커뮤니티 제외를 같이 정해야 함).

### 5. 제목·OG

- 커뮤니티 화면의 문서 제목은 고정 `Peerchive 커뮤니티`입니다(멤버에게도). 공간 이름·소개·글로 `title`·`og:title`·`og:description`·`og:image`·`twitter:*`를 만들지 않고, 사이트 기본 `description`도 지웁니다. 탭·북마크·화면 공유·브라우저 기록에 방 이름이 남지 않고, 로그인한 사람이 링크를 붙여도 미리보기 카드가 일반 카드뿐입니다. 화면 본문(h1)에는 이름이 그대로 보입니다.
- 소스 검사: `app/pages/community/**`의 모든 화면이 `useCommunityPage()`를 부르고 `useHead(`·`useSeoMeta`·`og:`를 직접 쓰지 않습니다.

### 6. 데이터 경계 검사(자동, C-04 이후도 덮음)

- **커뮤니티 테이블 목록은 스키마에서 읽습니다**: `packages/db/src/schema.ts`의 구역 머리말(`// ── …`)에 "커뮤니티"가 들어간 구역의 모든 `pgTable`이 커뮤니티 테이블입니다. C-04가 posts·comments·thread_aliases·reactions를 그 구역에 더하면 아래 검사가 자동으로 그 테이블까지 덮습니다. 다른 구역에 커뮤니티처럼 보이는 이름(`community_*`·`space_*`·`posts`·`comments`·`thread_aliases`·`reactions`·`name_mode_*` 등)의 테이블을 만들면 실패합니다.
- **테이블 접근**: `apps/web/server`·`apps/worker/src`·`apps/bot/src`에서 커뮤니티 테이블 이름(내보낸 이름·SQL 이름)을 쓰는 파일은 커뮤니티 모듈·커뮤니티 API 경로와 문서화된 예외뿐입니다. 예외: `moderation/notices.ts`(제한된 방의 방장에게 운영 안내, owner 여부만), worker `ops/purge.ts`(탈퇴 정리), `ops/name-modes.ts`·`apply-name-modes.ts`(C-03 적용).
- **모듈 import**: 커뮤니티 모듈을 import하는 파일은 커뮤니티 API 경로, 신고·조치 어댑터(`moderation/operator|targets|actions.ts` → `community/reporting|official`만), 서버 미들웨어(→ `community/http`만)뿐입니다.
- **공개 읽기·파생 경로**: 공개 조회 API, publication(공개 스냅샷 포함)·course-hub(검색·허브)·portfolio(공개 프로필)·analytics·catalog·identity·ops 모듈과 worker 파생 handler는 커뮤니티 모듈·테이블을 어떤 형태로도 참조하지 않습니다.
- **런타임 센티넬**: 센티넬 이름·소개의 방 셋·공식 페이지·게시판·초대·가입·나가기·내보내기·이름 표시 방식 예약·알림·인증 해제를 만든 뒤, **커뮤니티 테이블 밖의 모든 테이블**(information_schema로 나열: 감사·outbox·분석·검색 문서·공개 스냅샷·포트폴리오 등)에 센티넬이 0건이고, 공개 검색(모든 종류)·과목 허브·공개 사례·공개 프로필 응답에 센티넬·slug가 없음을 확인합니다. C-04 글 본문이 어디로든 복사되면 이 검사가 실패합니다.
- **감사·분석**: 커뮤니티 감사 기록의 metadata 값은 uuid·코드(`[a-z_]+`)·숫자·참거짓·null뿐이고 센티넬이 없습니다. 운영자가 직접 조치할 때 쓰는 사유 `note`도 감사가 아니라 `moderation_actions.internal_note`(제한·보관)와 `reverse_note`(해제)에 남고, 감사에는 `moderationActionId`만 남습니다(ADR 0015와 같은 원칙, migration 0019). 커뮤니티 분석 이벤트(`space_*`·`name_mode_*`, 앞으로의 `post_*`·`comment_*`·`community_*`·`board_*`·`reaction_*`·`thread_*`·`recruitment_*`)는 enum·bool props만, 키에 id·name·slug·title·body·text 같은 말이 없고, 그런 키를 넣으면 허용 목록이 거부합니다. `projectHash`는 null.
- 서버 로그: 커뮤니티 모듈은 console·logger를 쓰지 않습니다(요청 로그는 경로만, 방 이름은 경로에 없음 — 무작위 slug).

### 7. 화면 상태와 로그아웃

- 비로그인 SSR은 Nuxt를 거치지 않으므로 payload가 없습니다. 로그인했지만 읽을 수 없으면 payload에는 오류만 있습니다.
- **로그아웃**은 서버 세션을 지운 뒤 `clearNuxtData()`·`clearNuxtState`(로그인 상태 제외)를 하고 `reloadNuxtApp({ path: '/login' })`으로 앱을 새로 불러옵니다. 메모리의 useAsyncData 캐시(`space-<slug>`·`community-mine` 등)와 첫 SSR 응답에 담긴 `__NUXT_DATA__`가 함께 사라지고, 커뮤니티 응답은 `no-store`라 뒤로 가기도 서버에 다시 묻습니다(→ 404 고정 HTML). E2E로 확인합니다.

### 상태 코드·헤더 요약

| 요청 | 상태 | 본문 | 헤더 |
|---|---|---|---|
| 비로그인·봇 `GET /community/**`(있는 방·없는 방·초대·첫 화면) | 404 | 고정 HTML(같은 바이트, 이름·payload·OG 없음) | noindex·nofollow·noarchive, no-store, no-referrer, nosniff, Set-Cookie 없음 |
| 비로그인 `/api/v1/community/**` | 401 `unauthenticated` | 모든 경로 같은 본문 | 같음 |
| 로그인, 읽을 수 없는 공간(화면) | 404 | 앱의 "공간을 찾을 수 없습니다" | 같음 |
| 로그인, 읽을 수 없는 공간(API) | 404 | `not_found` | 같음 |
| 초대 미리보기, 학교 자격 없음 | 404 `not_eligible` | 이름·소개 없음 | 같음 |
| 멤버 화면 | 200 | 제목 `Peerchive 커뮤니티`, og·description 없음 | 같음 |
| `GET /robots.txt` | 200 | 색인 꺼짐 `Disallow: /`, 켜짐 위 목록 | text/plain, no-store |

## 결과

- GC 게이트의 C-05 회귀 테스트: `apps/web/test/community-visibility.integration.test.ts`(행위자 × 경로 매트릭스, 소개, 센티넬, 감사·분석, HTTP 경계·봇, robots.txt, 소스 경계·사이트맵·화면 머리말), 도메인 `community.test.ts`, E2E `community-visibility.spec.ts`(비로그인·봇·다른 학교 404, 소스에 방 이름 없음, robots meta, 멤버 화면 제목·OG, 로그아웃 뒤 방 데이터 없음, robots.txt). migration 없음.
- RUNBOOK §2 GC 표에 C-05 행과 배포 도메인 확인 명령을 둡니다.
- 한계: robots·noindex는 협조하는 크롤러에만 효과가 있습니다(실제 차단은 로그인·정책 함수). 이미 퍼진 화면 캡처·복사는 막지 못합니다. 초대 전용으로 바뀐 방의 승인 대기는 화면에서 사라집니다(방장은 처리 가능). 학교 무관 방의 멤버가 모든 학교 인증을 잃으면 그 방도 못 읽습니다(다시 인증하면 돌아옴). 소스 경계 검사는 이름 기반이라 동적 SQL 문자열 조합으로 테이블 이름을 만들면 놓칠 수 있고, 그 경우를 런타임 센티넬이 받칩니다. 모든 테이블을 훑는 센티넬 검사는 테스트 DB 행 수에 비례해 느려질 수 있습니다. 커뮤니티 화면 제목이 모두 같아 여러 탭을 구분하기 어렵습니다.

## 대안

- **API도 비로그인 404**: 계획 문구에 더 가깝지만, 공간을 조회하기 전의 401은 정보가 없고 JSON 클라이언트의 로그인 처리와 다른 `/api/v1` 규칙이 깨집니다.
- **비로그인 화면을 로그인으로 리다이렉트**: 초대 링크 흐름이 매끄럽지만 404 요구와 다르고 미리보기 카드에 로그인 화면이 붙습니다.
- **봇 User-Agent만 따로 막기**: UA는 바꿀 수 있고, 로그인 여부로 막으면 봇을 따로 알 필요가 없습니다.
- **멤버에게는 방 이름을 제목에**: 탭 구분이 쉬우나 기록·공유·로그인한 사람이 붙인 링크 미리보기에 이름이 남습니다.
- **커뮤니티 테이블 이름을 테스트에 손으로 나열**: 단순하지만 C-04가 테이블을 더할 때 목록을 고치지 않으면 경계 검사가 새 테이블을 놓칩니다.
- **unlisted 방도 소개 글 보이기**(ADR 0019): 가입 판단에 도움이 되지만 링크가 퍼질 때 멤버용 소개 글이 함께 퍼집니다.
