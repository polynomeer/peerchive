# 0034. 소셜 링크·되돌림 확인: 페르소나별 링크 + 사용자당 같은 주소 하나 + worker만 접속하는 SSRF 방어 수집기(DNS 직접 해석·전 주소 검사·주소 고정) + 3번 연속 실패면 lost + "인물 검증 아님" 문구

- 상태: 채택
- 날짜: 2026-10-28

## 맥락

S-06은 DELIVERY_PLAN §4.2 공개 프로필·팔로우 백로그의 다섯째 항목입니다: "링크 수집 worker의 SSRF 방어(허용 스킴·redirect 제한·사설 IP 차단·timeout), 재확인 시 `lost` 전환, 페르소나별 링크 분리, `확인됨` 문구가 인물 검증으로 읽히지 않는지 사용성 확인". 수용 시나리오는 §5.2 V(GitHub 프로필에 Peerchive 프로필 링크를 넣고 확인을 요청하면 `확인됨`, 링크를 지우면 다음 재확인에서 `lost`, 사설 IP·내부 주소로 redirect되는 URL은 수집 worker가 접속하지 않고 거부). 관련 설계:

- SYSTEM_DESIGN §6.7.1 `SocialLink(id, persona_id, provider instagram/youtube/linkedin/github/blog/other, url, verification unverified/verified/lost, verified_at?, last_checked_at?)` — 페르소나별로 별개, 되돌림 링크 확인은 §10의 링크 수집 worker 규칙으로만, 재확인에서 사라지면 `lost`, `verified`는 계정 소유 확인일 뿐 인물·경력 검증이 아님.
- §8.3 권한 표 첫 줄 "프로필 기본 정보(이름·소개·소셜 링크)": 비로그인부터 누구나, 차단당한 사용자만 404.
- §9.2 `POST /personas/:id/social-links`, `POST /social-links/:id/verify` — "링크 수집 worker에서만 접속, 재시도 제한". §10 "서버는 사용자가 붙인 URL에 바로 접속하지 않습니다. 허용 도메인·redirect 제한·사설 IP 차단·timeout을 갖춘 worker에서만 수집".
- 지금 코드: 서버가 외부 URL에 접속하는 곳이 아직 없습니다(SSRF 유틸 없음). 웹의 `client-ip.ts`가 `node:net` BlockList로 프록시 CIDR을 다루지만 접속 판정용은 아닙니다. 사이트 주소는 웹의 `NUXT_SITE_ORIGIN` 첫 항목이고 worker는 읽지 않았습니다. 공개 경로는 쿠키를 읽지 않고(ADR 0012·0031), 차단당한 사용자는 세션 경로 `/profiles/:handle/social`이 404입니다(ADR 0033). social DB 역할 권한은 `peerchive_apply_social_grants()` 하나에 있습니다(ADR 0029).

## 결정

### 1. 저장 (migration `0030_social_links`)

- **`social_links`**: `id`, `persona_id`, 사용자 사본 `user_id`, `provider`(enum `social_link_provider`), `url`, `verification`(enum `social_link_verification`, 기본 unverified), `verified_at`, `last_checked_at`, `last_check_result`(enum `social_link_check_result` found/missing/fetch_failed/blocked, 본인 화면용), `check_failures`(연속 실패 수), `verify_requested_at`, `created_at`.
  - 복합 외래 키 `(persona_id, user_id) → personas(id, user_id)`가 사본 = 주인을 보장합니다(팔로우·과제 수행 목록과 같은 방식).
  - **유일 키 `(user_id, url)`**: 같은 사용자의 다른 페르소나에 같은 주소를 걸 수 없습니다. 실명·표시명 프로필에 같은 GitHub 주소가 붙으면 연결 플래그(ADR 0028)를 꺼 둬도 누구나 두 프로필이 같은 사람임을 압니다. API는 409 `used_by_other_persona`(같은 페르소나면 `duplicate`)로 알려 주고, 화면은 그 이유를 설명합니다. 다른 사람끼리는 같은 주소를 넣을 수 있습니다(되돌림 링크는 각자의 프로필 주소로 확인하므로 남의 계정을 확인받을 수 없음).
  - check: `url like 'https://%'`·300자, `(verification = 'verified') = (verified_at is not null)`, `check_failures >= 0`.
  - 주소는 바꾸지 않습니다(PATCH 없음). 고치려면 지우고 다시 넣습니다 — 확인 결과가 다른 주소에 이어 붙는 일이 없습니다(worker도 쓰기 전에 주소가 같은지 봄).
- migration이 `peerchive_apply_social_grants()`를 `CREATE OR REPLACE`로 넓혀 다시 부릅니다: `social_links` SELECT(쓰기 없음). 커뮤니티 테이블 권한은 여전히 0건이고, S-02 역할 테스트가 `SET LOCAL ROLE peerchive_social`로 공개 링크 읽기를 실행합니다.

### 2. 주소 규칙 (`@peerchive/domain` `social-links.ts`)

- `parseSocialLinkUrl`: **https만**(http 블로그도 받지 않음 — 수집기가 평문으로 남의 사이트에 접속하지 않고, 공개 프로필이 평문 링크를 걸지 않게), **기본 포트만**, 아이디·비밀번호(`user@`) 없음, **IP 주소 host 없음**(10진 `2130706433`·8진 `0177.0.0.1`·16진 `0x7f.1`·짧은 `127.1`은 WHATWG URL이 IPv4로 바꾸므로 함께 거부, `[::1]`·`[::ffff:…]` 거부), localhost·`.local`·`.internal`·`.lan`·`.home.arpa`·`.test`·`.example`·`.invalid`·`.onion`·`.arpa` 같은 내부 이름과 한 단어 host·끝의 `.` 거부, 공백·제어 문자·`\` 거부, 300자. fragment는 지우고 host는 소문자로 정규화해 그 값을 저장·중복 판단에 씁니다.
- 알려진 서비스(github·instagram·youtube·linkedin)는 **그 서비스의 host(또는 하위 도메인)만** 받습니다(`provider_mismatch`). 다른 사이트에 GitHub 배지가 붙지 않게 하려는 것입니다. 블로그·기타는 공개 이름이면 됩니다.
- 이 검사는 이름만 봅니다. 이름이 내부 주소로 해석되는 경우는 수집기가 접속할 때마다 막습니다(3절).

### 3. 링크 수집기 (`apps/worker/src/net/safe-fetch.ts`, `ip-ranges.ts`)

사용자가 붙인 URL에 서버가 접속하는 **유일한 길**이고, worker에만 있습니다(웹 서버는 import하지 않음). 이후 링크 미리보기 같은 수집도 여기에 더합니다.

- 정책 `LINK_FETCH_POLICY`(고정, 환경 변수 없음): https만·443만, redirect 3번까지, 전체 5초(DNS·모든 redirect·본문 포함), 본문 512KB, `text/html`·`application/xhtml+xml`만, GET만, `accept-encoding: identity`(압축된 응답은 거부 — 압축 폭탄·크기 우회 방지), 쿠키를 보내지도 저장하지도 않음, 고정 User-Agent `PeerchiveLinkCheck/1.0`, `agent: false`(연결 재사용 없음).
- **DNS를 직접 해석하고 돌려받은 주소 전부를 검사합니다.** 하나라도 막힌 주소가 있으면 그 이름 전체를 거부합니다(공개 주소와 사설 주소를 섞어 돌려줘 운에 맡기는 수법 차단). 판정은 허용 목록입니다:
  - IPv4 거부: 0/8, 10/8, 100.64/10(CGNAT), 127/8, 169.254/16(link-local·클라우드 메타데이터), 172.16/12, 192.0.0/24, 192.0.2/24, 192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4(255.255.255.255 포함).
  - IPv6: 전역 unicast `2000::/3`만, 그 안의 2001::/23(Teredo 등)·2001:db8::/32·2002::/16(6to4, 안에 IPv4를 실음)·3fff::/20 거부. 그래서 `::`·`::1`·**IPv4-mapped `::ffff:0:0/96`(안의 IPv4가 공개여도)**·IPv4-compatible·NAT64 `64:ff9b::/96`·`100::/64`·ULA `fc00::/7`·link-local `fe80::/10`·site-local·multicast가 모두 거부됩니다. zone id(`%eth0`)·형식 오류도 거부.
- **검사한 주소로 고정(pin)해 접속합니다**: 요청 소켓의 `lookup`이 그 주소만 돌려주므로(Happy Eyeballs의 `all: true` 형식 포함), 검사와 접속 사이에 이름이 다른 주소를 가리키게 바꿔도(DNS rebinding) 검사하지 않은 주소로 가지 않습니다. TLS 인증서 확인·SNI·Host 헤더는 원래 이름 그대로입니다.
- **redirect는 직접 처리합니다**: 301·302·303·307·308만, 3번까지, 매번 URL 검사(스킴·포트·사용자 정보·이름)부터 DNS·주소 검사·고정까지 처음부터 다시 합니다. https → http는 거부.
- 결과는 예외 없이 코드로 돌려줍니다: `invalid_url`·`blocked`(+이유)·`dns`·`too_many_redirects`·`timeout`·`too_large`·`not_html`·`http_status`(+status)·`network`.
- **테스트 훅**(`testHooks`: resolver·추가 허용 주소·정책·접속 주소 알림)은 함수 인자로만 받고 환경 변수로는 켤 수 없으며, `NODE_ENV=test`가 아니면 넘기는 것 자체가 예외입니다. 허용 주소 훅도 "127.0.0.1을 더 허용"할 뿐이라 사설 주소 거부 규칙은 테스트에서도 그대로입니다. 테스트는 가짜 resolver와 127.0.0.1 로컬 서버로만 접속합니다(바깥 인터넷 0건).

### 4. 확인·재확인 (`apps/worker/src/social-links.ts`)

- **확인 요청** `POST /social-links/:id/verify`(202): 웹은 `verify_requested_at`을 쓰고 outbox `social_link.verify {socialLinkId}`(주소 없음)만 남깁니다. 전달기가 같은 이름의 pg-boss 큐로 옮기고(재시도 2번, 60초 만료), handler가 지금 행을 읽어 수집합니다. 링크가 지워졌거나 페르소나·계정이 비활성이면 접속하지 않습니다. 화면은 `verifyPending`(요청 뒤 아직 결과 없음) 동안 3초마다 최대 30초 다시 읽습니다.
- **되돌림 링크 판정**(`pageLinksTo`): HTML의 `href` 중 host(대소문자 무시)와 경로 `/u/<handle>`(끝 `/` 무시)가 페르소나의 공개 프로필 주소와 같은 것이 있으면 됩니다. 스킴·query·fragment는 보지 않습니다. **본문에 주소를 글로만 적은 것은 세지 않습니다**(링크여야 함). 프로필 주소의 origin은 `NUXT_SITE_ORIGIN` 첫 항목이고 worker도 이제 이 값을 읽습니다(`OpsConfig.siteOrigin`). 없으면 무엇을 찾을지 모르므로 접속하지 않고 그대로 둡니다(경고 로그).
- handle은 확인할 때의 지금 handle입니다. handle을 바꾸면 이전 주소로 된 되돌림 링크는 다음 재확인에서 `lost`가 됩니다(링크한 페이지도 고쳐야 함, 화면이 넣을 주소를 늘 보여 줌).
- **상태 전이**(`nextSocialLinkState`, 확인 요청과 재확인이 같은 규칙):
  - 링크 있음 → `verified`(연속 실패 0, 처음 verified가 될 때 `verified_at`).
  - 페이지를 받았는데 링크 없음, 또는 404·410 → verified였으면 **`lost`**(`verified_at` 비움), unverified·lost는 그대로.
  - 가져오기 실패(timeout·5xx·403·429·HTML 아님·너무 큼·DNS)·접속 거부(blocked) → **상태는 그대로 두고 `check_failures` +1**. verified 링크가 **3번 연속** 실패하면 `lost`. 일시 장애로 확인 표시가 바로 빠지지 않게 하면서, 끝내 볼 수 없게 된(예: 이름이 내부 주소로 바뀐) 링크에 확인 표시가 남지 않게 하는 절충입니다. 재확인이 링크마다 하루 한 번이므로 대략 사흘입니다. 성공하면 0으로 돌아갑니다.
- **재확인**은 운영 주기 작업 `ops.social-link-recheck`(기본 매시 37분, `PEERCHIVE_CRON_SOCIAL_LINK_RECHECK`로 바꾸거나 `off`): verified 링크 중 마지막 확인에서 24시간이 지난 것을 오래된 순으로 한 번에 100개, 동시에 4개씩. 링크마다 대략 하루 한 번이고, 한 번 실행은 최악 100 × 5초 / 4 ≈ 2분입니다. unverified·lost는 다시 보지 않습니다(사용자가 확인을 다시 요청해야 함). 결과는 다른 운영 작업처럼 `task:social-link-recheck` 기록에 남습니다.
- 로그에는 링크 id·결과 코드만 남기고 주소는 남기지 않습니다.

### 5. API·한도

- `GET /personas/:id/social-links`(본인만, 링크·한도·`backLinkUrl`), `POST /personas/:id/social-links {provider, url}`(201), `DELETE /social-links/:id`, `POST /social-links/:id/verify`(202). 남의 것·없는 id는 모두 404. 공개 프로필이 없는 페르소나는 409 `profile_required`, 비활성 페르소나의 확인 요청은 409 `persona_inactive`.
- **페르소나당 8개**(409 `limit_reached` + `limit`). 개수는 페르소나 행을 잠그고 셉니다(동시 추가 경합).
- 한도(`hitRateLimit`): 확인 요청 **사용자당 시간당 20건 + 링크당 시간당 3건**(수집기가 남의 사이트를 두드리는 도구가 되지 않게), 링크 추가 사용자당 하루 30건(지우고 다시 넣어 링크당 한도를 돌아가지 못하게). 429.

### 6. 공개 표시

- 소셜 링크는 **프로필 기본 정보**입니다(§8.3 표 첫 줄). 공개 범위 항목(ADR 0031)을 만들지 않고 공개 프로필에 늘 싣습니다. 보이기 싫은 링크는 넣지 않으면 됩니다.
- 공개 프로필 JSON `socialLinks: [{provider, url, verified}]` — 그 페르소나의 링크만, 넣은 순서. 확인 끊김(lost)·마지막 결과·시각은 싣지 않습니다(lost는 공개에서 그냥 확인 표시가 없는 링크). **연결을 켜도 상대 페르소나의 링크를 붙이지 않습니다**(연결은 `linkedPersona` 한 필드뿐).
- 차단당한 사용자: 링크는 프로필의 일부라 세션 경로가 페르소나 자체를 404로 감추면 화면 전체가 "프로필을 찾을 수 없습니다"가 됩니다. 공개 경로(쿠키 없음)는 로그아웃한 방문자와 같은 응답입니다(ADR 0033).
- `/u/:handle`: 머리글에 `서비스 · 주소` 링크(`rel="nofollow noopener noreferrer ugc"`, 새 창)와 확인된 링크의 **`링크 확인됨`** 배지. 배지에는 늘 설명이 붙습니다: "링크 확인됨 — 이 계정에 Peerchive 프로필 링크가 있음을 확인했을 뿐, 인물·경력을 검증하지 않습니다". "인증"·체크 표시(✓)를 쓰지 않습니다(학교 인증 배지 ✓와 구별). `/u/:handle/print`는 주소와 확인 표시·설명을 글로 적습니다.
- `/settings/personas`(제목 "표시명 프로필·소셜 링크"): 프로필마다 링크 목록(상태 `확인 전`·`확인 중…`·`링크 확인됨`·`확인 끊김`, 마지막 결과 문구), 넣을 프로필 주소, 넣기·확인 요청·지우기.

### 7. 감사·탈퇴

- 감사 `social_link.add`·`social_link.remove`·`social_link.verify_request`: target은 링크 id, metadata는 `{personaId, personaKind, provider}`(+지울 때·요청 때 `verification`)뿐이고 **주소는 남기지 않습니다**(외부 계정 주소는 그 자체로 사람을 가리키는 값이고, 감사 기록은 행을 지워도 남음). worker의 확인 결과는 감사하지 않습니다(사람의 행동이 아님, 행에 마지막 결과가 있음).
- worker `purgeAccount`가 페르소나를 지우기 전에 그 사람의 `social_links`를 지웁니다(장부 종류 `social_links`).

## 결과

- 시나리오 V는 worker 통합 테스트가 끝까지 봅니다: 웹과 같은 outbox 행 → 전달기 → 링크 수집기(가짜 resolver + 127.0.0.1 서버)로 되돌림 링크 확인 → verified, 페이지에서 링크를 지우면 24시간 뒤 재확인에서 lost, 사설 IP로 redirect되는 주소는 첫 hop 말고 접속 0건·`blocked`·상태 유지. 수집기 테스트(사설 IP·IPv4-mapped literal·내부 이름·다른 포트·다른 스킴으로의 redirect 거부, redirect 3번 초과, 응답 없음·본문 멈춤·느린 DNS timeout, 스트림·선언 크기 초과, HTML 아님·압축 응답, 공개+사설 섞인 DNS 거부(IPv4·IPv6), rebinding: 고정 주소로만 접속하고 다음 hop은 다시 검사), 주소 판정 단위 테스트(0.0.0.0·100.64/10·169.254·fc00::/7·fe80::/10·::1·mapped·6to4·Teredo 등), 도메인 단위 테스트(URL 규칙·10진/8진/16진 host·되돌림 링크 판정·상태 전이), 웹 통합 테스트(CRUD·정규화·남의 것 404·한도·중복·다른 페르소나 같은 주소 409·페르소나 분리(연결 켜도)·outbox payload에 주소 없음·verified/lost 공개 표시·확인 요청 한도·감사 metadata에 주소 없음·차단 404), S-02 경계 테스트(새 라우트 포함·역할 SELECT), 탈퇴 정리 테스트, E2E `v-social-links.spec.ts`(넣기·내부 주소 거부·확인 전·방문자에게 링크·지우기; 바깥 인터넷 접속이 없도록 확인 요청은 누르지 않고, E2E worker에는 사이트 origin을 주지 않음)가 확인합니다.
- 운영: worker가 바깥 https(443)로 나가야 합니다. 이 수집기 말고는 바깥 접속이 없으므로 egress를 443만 열고, 가능하면 수집기 프로세스의 egress에서도 사설·메타데이터 대역을 막아 두 겹으로 둡니다(RUNBOOK).
- 열린 질문:
  - **사용성 확인**(DELIVERY_PLAN S-06 완료 기준): "링크 확인됨" 배지와 설명이 인물 검증으로 읽히지 않는지 파일럿 사용자 몇 명에게 확인해야 합니다. 문구는 domain 상수 하나(`SOCIAL_LINK_VERIFIED_LABEL`·`_NOTE`)라 바꾸기 쉽습니다.
  - Instagram·LinkedIn·YouTube는 로그인 벽·스크립트 렌더링·자체 redirect 주소(`/redirect?q=`, `lnkd.in`)로 링크를 감싸 HTML에서 되돌림 링크를 찾지 못할 수 있습니다. 지금은 `fetch_failed`·`missing`으로 남고 확인 표시가 없을 뿐입니다. 서비스별 API·`rel="me"` 규약 지원은 이후 작업입니다.
  - 남이 쓸 수 있는 페이지(블로그 댓글·이슈 댓글)에 제3자가 내 프로필 링크를 넣으면 "확인됨"이 될 수 있습니다. 이 확인이 "그 페이지에 링크가 있다"는 뜻일 뿐이라는 문구로 받아들이고, 신고 대상에 소셜 링크를 더하는 S-07에서 다시 봅니다.
  - lost 링크를 재확인에서 자동으로 되살리지 않습니다(사용자가 다시 요청). 매일 모든 lost를 두드리지 않으려는 것입니다.
  - 수집기 결과 캐시(같은 주소를 여러 사람이 넣은 경우)와 host별 동시 접속 제한은 아직 없습니다. 재확인 배치가 오래된 순으로 100개씩이라 지금 규모에서는 같은 host를 짧은 시간에 많이 두드리지 않습니다.

## 대안

- **웹 서버에서 바로 가져오기**: 응답이 빠르지만 §10이 금지하고, 웹 프로세스의 egress·내부망 접근을 수집 대상에 그대로 내줍니다.
- **http 블로그 허용**: 평문 블로그가 있지만 수집기가 평문으로 접속하고(경로 중간에서 바꿀 수 있는 되돌림 링크) 공개 프로필에 평문 링크가 걸립니다. https만으로 시작합니다.
- **`fetch` + 이름 검사만**: 이름은 공개인데 해석 결과가 내부 주소인 경우, 검사 뒤 해석이 바뀌는 rebinding, redirect 뒤 주소를 막지 못합니다. undici `Agent`의 `connect.lookup`도 같은 고정을 할 수 있지만 Node가 undici를 공개 모듈로 내보내지 않아 의존성을 더해야 했고, `node:https`의 `lookup` 옵션으로 충분했습니다.
- **`node:net` BlockList로 판정**: 범위 목록은 짧아지지만 IPv4-mapped·형식 오류 처리를 따로 해야 하고, 허용 목록(2000::/3) 방식이 막는 목록 방식보다 새 특수 대역에 안전합니다.
- **가져오기 실패 한 번에 lost**: 단순하지만 대상 사이트의 일시 장애·bot 차단으로 확인 표시가 깜박입니다. 반대로 실패를 무시하면 영영 볼 수 없게 된 링크에 확인 표시가 남습니다.
- **소셜 링크를 공개 범위 항목으로**: 설계 표에 항목이 없고 §8.3이 기본 정보로 정했습니다. 링크를 고르는 것 자체가 공개하겠다는 선택이라 범위 설정을 하나 더 두지 않았습니다.
- **같은 주소를 두 페르소나에 허용하고 경고만**: 사용자가 원해서 이어 붙이는 경우도 있지만, 그때는 연결 플래그(ADR 0028)를 켜면 됩니다. 경고 없이 놓치기 쉬운 누출이라 막습니다.
