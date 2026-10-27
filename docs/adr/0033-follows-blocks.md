# 0033. 팔로우·비공개 계정·차단·뮤트: 페르소나 → 페르소나 팔로우 + 사용자 사본 열 check로 막는 자기 팔로우 + 자동 승인 없는 공개 전환 + 사용자 단위 저장·페르소나 단위 숨김 차단 + 차단한 그 페르소나와의 팔로우만 끊기 + 알림 0건

- 상태: 채택
- 날짜: 2026-10-28

## 맥락

S-04는 DELIVERY_PLAN §4.2 공개 프로필·팔로우 백로그의 넷째 항목입니다: "비공개 계정 승인 흐름, 자기 페르소나 팔로우 불가, 팔로워 삭제·차단·뮤트 무알림. 차단 시 404·양방향 팔로우 삭제, `all_personas` 선택 시 연결 추정 경고. 0~1단계 글에는 차단 미적용". 수용 시나리오는 §5.2 T(비공개 계정: 승인 전 기본 정보만, 승인 뒤 `승인한 팔로워` 범위 항목, 팔로워 삭제 무알림, 비공개 → 공개 전환 때 대기 요청 자동 승인 없음, 팔로워 수 표시를 끄면 공개 응답에 숫자 없음)·U(표시명 프로필에서 차단하면 그 프로필 404·서로의 팔로우 삭제·알림 없음, 실명 프로필은 "모든 프로필에서 차단"을 고를 때만 숨김 + 연결 추정 경고, 익명 글은 그대로)와 R의 마지막 줄(표시명으로 팔로우하면 상대의 팔로워 목록에는 표시명만). 관련 설계:

- SYSTEM_DESIGN §6.7.1: `Follow(follower_persona_id, followee_persona_id, status pending/active, created_at, approved_at?)` — 쌍 유일, 같은 사용자의 페르소나끼리 불가, 팔로워 삭제는 행 삭제·무알림. `Block(blocker_user_id, blocked_user_id, origin_persona_id, scope origin_persona/all_personas, created_at)` — 저장은 사용자 단위, 숨김 범위는 기본 차단을 건 페르소나, `all_personas`는 고를 때만 + 연결 비공개면 "다른 프로필까지 숨기면 같은 사람임이 추정될 수 있습니다" 안내, 차단 시 양방향 Follow 삭제, 0~1단계 글 미적용. `Mute(muter_user_id, muted_persona_id, created_at)` — 피드·알림에서만 제외. Persona의 `account_privacy`·`show_follower_count`(S-01에 열만 있음).
- §8.3 권한 표: 팔로우 요청은 로그인 사용자만, 자기·자기 페르소나 불가, 차단당한 사용자 404. 팔로워 승인·삭제·차단·뮤트는 본인만. 팔로우 목록은 `follow_lists` 범위(public일 때 / 승인된 팔로워 / 본인), 차단당한 사용자 404. 정책 함수 `canViewPersona`·`canViewPersonaItem`·`canFollow`. §9.2 `POST /profiles/:handle/follow`·`POST /follow-requests/:id/approve`·`DELETE /followers/:personaId`·`POST /blocks`·`POST /mutes`.
- 지금 코드: S-03(ADR 0031)의 `personaViewerFor`가 `approvedFollower`·`blocked`를 늘 false로 두고 "S-04는 이 두 값만 채우면 된다"고 했습니다. 공개 경로(공개 JSON·README 카드·`/u` SSR·OG·`/print`)는 쿠키를 읽지 않아 늘 비로그인 판정이고, 세션 범위는 `GET /profiles/:handle`(세션을 읽음)을 화면이 브라우저에서만 부릅니다. ADR 0029의 social 모듈은 커뮤니티 테이블을 import하지 않고, social DB 역할의 권한은 `peerchive_apply_social_grants()` 하나에 있습니다. ADR 0032 뒤로 라우트를 더해도 TS2589가 나지 않습니다.

## 결정

### 1. 저장 (migration `0029_follows_blocks`)

- **`follows`**: `id`(관리 API가 쓰는 행 id), `follower_persona_id`·`followee_persona_id`, **사용자 사본 열** `follower_user_id`·`followee_user_id`, `status`(enum `follow_status` pending/active), `created_at`, `approved_at`. 쌍 유일 `follows_pair_key`. 두 복합 외래 키 `(persona_id, user_id) → personas(id, user_id)`가 사본 = 페르소나의 주인임을 보장하고, **check `follower_user_id <> followee_user_id`가 자기 페르소나(같은 사용자의 다른 페르소나 포함) 팔로우를 DB에서 막습니다** — 트리거 없이 선언만으로 됩니다. check `(status = 'active') = (approved_at is not null)`.
- **`blocks`**: `id`, `blocker_user_id`·`blocked_user_id`(사용자 단위 저장), `origin_persona_id`(차단을 건 내 페르소나, 기본 숨김 범위), **`blocked_persona_id`**(차단을 건 상대의 페르소나 페이지), `scope`(enum `block_scope`), `created_at`. 유일 키는 `(blocker_user_id, origin_persona_id, blocked_persona_id)`, check `blocker <> blocked`, 복합 외래 키 둘.
  - `blocked_persona_id`는 설계 표에 없던 열입니다. 둘 다 연결 누출을 막으려고 둡니다: ① 내 차단 목록에 "내가 차단한 그 페르소나"만 보여 줄 수 있습니다(사용자 id만 있으면 상대의 어느 페르소나를 보여 줄지 골라야 하고, 고르면 다른 페르소나가 드러남). ② 유일 키가 `(blocker, blocked_user)`였다면 같은 상대의 다른 페르소나를 차단할 때 "이미 차단함"이 나와 두 페르소나가 같은 사람임을 알려 줍니다. 지금 키는 페르소나 쌍마다 행이 따로라 그런 응답이 없습니다.
  - `blocked_user_id`는 서버만 씁니다. 어떤 응답(차단 결과·내 차단 목록·관계 정보)에도 싣지 않습니다.
- **`mutes`**: `id`, `muter_user_id`, `muted_persona_id`, 사본 `muted_user_id`(복합 외래 키 + 자기 뮤트 check), `created_at`, 쌍 유일.
- 세 표 모두 행 id만 응답에 싣고, 다른 사람의 **페르소나 id·사용자 id는 싣지 않습니다**. 그래서 §9.2 초안의 `DELETE /followers/:personaId`는 **`DELETE /followers/:id`(팔로우 행 id)**로 바꿨습니다.
- migration이 `peerchive_apply_social_grants()`를 `CREATE OR REPLACE`로 넓혀 다시 부릅니다: 세 표 SELECT(쓰기 없음). 커뮤니티 테이블 권한은 여전히 0건이고, S-02 역할 테스트가 `SET LOCAL ROLE peerchive_social`로 팔로우 목록·관계 정보 경로를 실행합니다.

### 2. 정책 (`@peerchive/domain` `follows.ts`, `visibility.ts`는 그대로)

- `decideFollow`(= §8.3 `canFollow`): 비로그인 `signed_out` → 대상 비활성·대상 주인이 나를 차단 `not_found`(존재를 드러내지 않음, 자기 페르소나 여부보다 먼저) → 주체 페르소나가 내 것이 아님 `acting_persona` → 같은 사용자 `own_persona` → 내가 **바로 그 페르소나**를 차단해 둠 `blocked_by_you` → 통과면 첫 상태(공개 계정 active, 비공개 계정 pending).
  - 차단한 사람 쪽 검사는 **내가 아는 것만** 봅니다. A가 B의 표시명을 차단했는데 B의 실명 팔로우를 "차단한 사람"이라며 막으면, A는 그 거절로 B 실명 = B 표시명을 알게 됩니다. 그래서 같은 상대의 다른 페르소나는 막지 않습니다.
- `blockHides`(origin이 그 페르소나이거나 `all_personas`), `blockNeedsLinkConfirm`(all_personas + 내게 다른 페르소나 있음 + 연결 비공개), `showsFollowCounts`(본인은 늘, 다른 사람은 `show_follower_count`일 때만), `FOLLOW_RATE_LIMIT`(사용자당 시간당 60건).
- `personaViewerFor`(social): `blocked` = 페르소나 주인이 보는 사람을 차단했고 범위가 이 페르소나를 덮음(덮으면 나머지는 읽지 않음), `approvedFollower` = 보는 사람이 **어느 페르소나로든** 이 페르소나를 active로 팔로우함. 보는 사람은 세션 사용자라서, 표시명으로 승인받은 사람도 같은 계정으로 로그인해 있으면 승인한 팔로워 범위를 봅니다(승인한 쪽이 고른 결과). `canViewPersona`·`canViewPersonaItem`은 S-03 그대로이고, pending 요청은 아무것도 넓히지 않습니다.

### 3. 팔로우·비공개 계정

- `POST /profiles/:handle/follow {as}`: 주체 페르소나는 요청자가 고릅니다(실명·표시명). 이미 있으면 그 상태를 그대로 돌려주고(멱등), **새 행을 만들 때만** 한도를 셉니다(429). 주체 페르소나에 공개 프로필이 없으면 409 `profile_required`(목록에 보일 수 없는 팔로워를 만들지 않음). DB check 위반(경합 등)도 409 `own_persona`로 바꿉니다.
- `DELETE /profiles/:handle/follow?as=`: 언팔로우·보낸 요청 취소. 받은 쪽: `POST /follow-requests/:id/approve`·`/reject`(거절 = 행 삭제), `DELETE /followers/:id`(팔로워 삭제 = 행 삭제). 남의 요청·처리된 요청·없는 id는 404(요청을 보낸 사람도 승인할 수 없음).
- **공개 → 비공개**는 즉시이고 이미 승인된 팔로워는 그대로입니다. **비공개 → 공개**는 대기 요청을 자동 승인하지 않습니다: `PATCH /personas/:id`의 응답·`GET /me/personas`에 `pendingFollowRequests`가 있고, 화면은 저장 전에 "모두 승인 / 모두 거절 / 그대로 두기"를 묻습니다. 앞의 둘은 `POST /personas/:id/follow-requests {action: approve_all | reject_all}`, 마지막은 아무 API도 부르지 않습니다. 공개 계정이 된 뒤의 새 팔로우는 바로 active이고, 남은 요청은 하나씩 처리할 수 있습니다.
- **알림 0건**: 팔로우·요청·승인·거절·팔로워 삭제·언팔로우·차단·뮤트 어느 것도 알림·outbox·공지·디스코드 알림 행을 만들지 않습니다. 통합 테스트가 public 스키마의 모든 표 행 수를 전후로 비교해 바뀐 표가 `follows`(·차단이면 `blocks`와 `audit_events`, 뮤트면 `mutes`)뿐임을 봅니다. 팔로우 알림 자체(예: "새 팔로우 요청")는 S-05 알림에서 다시 정합니다.

### 4. 목록·개수

- `GET /profiles/:handle/followers`·`following`(세션을 읽음, `private, no-store`): `follow_lists` 범위를 보는 사람 기준으로 판정(S-03: public·private, 비공개 계정은 승인한 팔로워까지). 볼 수 없으면 `{entries: null}`, 차단당했으면 404. 줄마다 **그 페르소나의 `{kind, handle, displayName}`뿐**이고 연결(identity_links)을 읽지 않습니다 — 표시명으로 팔로우하면 표시명만 보이고, 연결을 켜도 목록 줄에 상대 페르소나가 붙지 않습니다. 상대가 공개 상태가 아니면(비활성·계정 비활성·운영 숨김) 빠지고, **보는 사람에게 차단으로 숨겨진 페르소나도 빠집니다**(관리 화면 목록·대기 요청 수도 같은 조건). 한 번에 500줄(페이지네이션은 피드와 함께 S-05).
- `follow_lists` 기본값은 ADR 0031 그대로 **private**입니다(열린 질문이었음). 팔로우 목록은 사람 사이 관계를 드러내므로 본인이 켤 때만 엽니다.
- **개수** `followCounts: {followers, following}`(active, 상대가 공개 상태인 것): 공개 프로필 JSON은 비로그인 판정이라 주인이 `show_follower_count`를 켰을 때만 **키가 있고**, 끄면 키 자체가 없습니다(null·0으로 남기지 않음 — 있음/없음의 모양 차이 외에 값이 새지 않음). 세션 경로 `GET /profiles/:handle/social`도 같은 규칙이고 본인에게만 늘 줍니다. 이전 공개 프로필 DTO(`GET /profiles/:handle`)에는 싣지 않습니다. 정렬·추천 가중치로 쓰지 않습니다(§11.3).
- `GET /profiles/:handle/social`: 계정 공개 여부, 개수(위 규칙), 목록을 볼 수 있는지, 본인 여부, 로그인한 다른 사람에게는 내 페르소나별 팔로우 상태·이 페이지에서 건 차단·뮤트 id. `/u/:handle` 화면은 이것을 SSR 뒤 브라우저에서만 부르고(보는 사람별 내용이 SSR HTML·payload에 없음), 404면 "프로필을 찾을 수 없습니다"로 바꿉니다.

### 5. 차단

- **페르소나 페이지에서** 겁니다: `POST /blocks {handle, as, scope?, confirmLinkInference?}`. 대상은 handle의 그 페르소나, 주체는 내가 고른 내 페르소나(origin). 대상이 내게 숨겨졌으면(그 사람이 나를 차단) 404 — 볼 수 없는 페이지에서는 걸 수 없습니다. `all_personas` + 내게 다른 페르소나 + 연결 비공개인데 확인 플래그가 없으면 422 `confirmLinkInference: required`(화면은 `BLOCK_LINK_WARNING`과 확인란). 같은 (origin, 대상)을 다시 차단하면 범위만 바뀝니다.
- **차단당한 사용자**(세션 사용자, 어느 페르소나로 로그인했든)에게 숨겨진 페르소나는 `GET /profiles/:handle`(과제 수행 목록)·`/social`·`/followers`·`/following`·팔로우·언팔로우·뮤트·역차단이 모두 404입니다. 공개 경로(쿠키 없음)는 판정할 수 없으므로 로그아웃한 방문자와 같은 응답이고, 화면은 브라우저에서 위 404를 받아 숨깁니다(§8.3이 "존재 여부를 숨기기 위한 404"라 한 것은 로그인한 사용자에 대한 것).
- **팔로우 삭제 범위 — 숨겨지는 내 페르소나(origin, `all_personas`면 내 모든 페르소나)와 차단한 그 대상 페르소나 사이의 양방향 팔로우만 지웁니다.** 설계 문장 "양방향 Follow 삭제"를 "두 사용자의 모든 페르소나 사이"로 읽으면 연결이 샙니다:
  - 차단한 사람 쪽: A가 B 표시명을 차단했는데 B 실명 → A 실명 팔로우까지 사라지면, A는 자기 팔로워 목록에서 B 실명이 같은 순간 빠진 것을 보고 B 실명 = B 표시명임을 압니다. 요구 사항 "표시명 페르소나에서 차단해도 차단한 사람에게 상대의 실명 페르소나를 드러내지 않음"과 정면으로 어긋납니다.
  - 차단당한 사람 쪽: origin_persona 차단인데 A 실명과의 팔로우까지 끊기면, B는 A 표시명 404와 같은 순간 A 실명과의 관계가 끊긴 것으로 A 실명 = A 표시명을 압니다(그 추정은 A가 `all_personas`를 확인하고 고를 때만 감수하기로 한 것).
  - 그래서 남는 팔로우(예: B 실명 → A 표시명)가 있을 수 있습니다. 차단이 있는 동안 이 행은 B에게 아무것도 열지 않습니다: 숨겨진 페르소나는 `canViewPersona`가 먼저 404로 끊고(승인된 팔로워여도), B가 보는 목록·관리 화면에서도 빠집니다. A 쪽 목록에는 B 실명이 그대로 보이는데, A가 이미 아는 것 이상을 드러내지 않습니다. 차단을 풀면 그대로 이어집니다(지운 행은 되살리지 않음). S-05 피드도 같은 `canViewPersona`를 거쳐야 합니다.
- 차단은 **0~1단계(익명) 커뮤니티 글에 닿지 않습니다**: 커뮤니티 모듈은 `blocks`를 읽지 않고(이 작업은 커뮤니티 코드를 바꾸지 않음), social 모듈은 커뮤니티 테이블을 읽지 않습니다(S-02 테스트). 통합 테스트가 차단 전후 차단당한 사용자의 게시판 목록·글 응답이 같음을 봅니다. 2~3단계 공간에서 차단한 사용자의 글을 접는 것(§8.3)은 이 작업 범위 밖입니다(열린 질문).
- `DELETE /blocks/:id`(내 것만, 아니면 404), `GET /me/blocks`(대상은 그 페르소나의 지금 handle·이름·종류, 내 origin 페르소나, 범위).

### 6. 뮤트

- `POST /mutes {handle}`(멱등, 201)·`DELETE /mutes/:id`·`GET /me/mutes`. 대상이 내게 숨겨졌으면 404, 내 페르소나면 409 `own_persona`. 지금은 저장과 목록뿐이고 보이는 효과가 없습니다(팔로우 피드·알림 제외는 S-05). 상대의 보기·팔로우·목록에 아무 영향이 없습니다.

### 7. 감사

- **차단은 감사합니다**: `social.block`(대상 페르소나 id를 target, metadata `{originPersonaId, originKind, targetKind, scope, linkConfirmed}`)·`social.unblock`(`{originPersonaId, scope}`). 괴롭힘 신고를 조사할 때 "누가 언제 어느 범위로 차단·해제했는지"가 필요하고, 확인 플래그는 연결 추정 경고를 보고 골랐는지의 근거입니다. handle·이름은 남기지 않습니다(id만, 바뀌는 값 없음).
- **팔로우·승인·거절·삭제·뮤트는 감사하지 않습니다**: 하루에도 많이 일어나는 일상 동작이고, 감사 기록은 행을 지워도 남으므로 언팔로우·거절한 관계의 역사(사회 관계망 이력)가 운영 기록에 쌓입니다. 악용(대량 팔로우)은 한도가 막고, 조사에 필요한 지금 관계는 `follows` 행에 있습니다.

### 8. 탈퇴 정리

- worker `purgeAccount`가 페르소나를 지우기 전에 그 사람이 들어간 `follows`(양쪽)·`blocks`(건 것·당한 것)를 지우고, `mutes`(건 것·당한 것)는 페르소나 유무와 관계없이 지웁니다. 상대에게 알리지 않습니다. 감사의 차단 기록은 다른 감사 행처럼 남습니다(id만).

### 9. 화면

- `/u/:handle`: `ProfileSocial`(브라우저에서만) — 비공개 계정 배지, 팔로워·팔로잉 수(키가 있을 때만)와 목록 펼치기(볼 수 있을 때만), 내 프로필이 둘이면 "어느 프로필로" 고르기(표시명이면 상대에게 표시명만 보인다는 안내), 팔로우/팔로우 요청/요청 취소/팔로우 취소, "차단·뮤트"(범위 라디오, 내 모든 프로필이면 연결 추정 경고 + 확인란, 차단 해제, 뮤트·해제). 본인이면 "팔로우 관리" 링크. 404면 화면 전체가 "프로필을 찾을 수 없습니다".
- `/settings/follows`(머리글 메뉴 "팔로우·차단"): 페르소나마다 계정 공개·팔로워 수 표시(비공개 → 공개 + 대기 요청이 있으면 저장 전에 세 가지 중 고르기), 받은 요청(승인·거절), 팔로워(삭제), 팔로잉·보낸 요청(취소), 차단한 프로필·뮤트한 프로필(해제). `/settings/visibility`의 "팔로우 기능은 준비 중" 안내를 고쳤습니다.

## 결과

- 시나리오 T·U와 R의 팔로우 줄, §8.3 표의 팔로우·목록·차단 줄을 도메인 단위 테스트(`follows.test.ts`)·통합 테스트(`follows.integration.test.ts`: 비공개 승인 전후 과제 목록·팔로우 목록, 공개 전환 자동 승인 없음·모두 승인·모두 거절, 표 행 수로 보는 알림 0건, 팔로워 수 키 없음(JSON 원문 포함), 자기 페르소나 API 409·DB check·사본 열 위조 외래 키, 한도, follow_lists private, 남의 관리 API 404, 표시명 팔로우 목록, 차단 404·팔로우 삭제 범위·all_personas 확인·감사 metadata, 뮤트, 익명 글 무영향)·S-02 속성 테스트(무작위 팔로우를 더해 모든 페르소나의 팔로우 목록이 정확히 실제 팔로우의 handle뿐이고, 연결이 비공개면 상대 페르소나 handle·id와 사용자 id가 없으며 익명 글 데이터가 0건)·E2E(`t-follows.spec.ts`)가 확인합니다.
- 열린 질문:
  - 팔로우 요청·승인 알림(받는 사람에게 "새 요청")은 S-05 알림에서 정합니다. 그때도 거절·삭제·차단·뮤트는 알리지 않습니다.
  - 차단 뒤 남는 팔로우(차단한 대상 페르소나가 아닌 쪽)는 개수에 그대로 들어갑니다. 차단당한 사람이 개수와 목록 길이의 차이로 무언가 짐작할 수는 있지만, 개수는 공개 상태 상대만 세고 목록은 보는 사람별로 거르므로 차이는 원래도 생깁니다.
  - 차단당한 사람에게 숨겨진 페르소나를 향한 남은 팔로우는 그 사람이 스스로 지울 수 없습니다(그 페르소나가 404라서). 차단이 풀리기 전에는 효과가 없으므로 그대로 둡니다.
  - 2~3단계(실명·표시명) 커뮤니티 공간에서 차단한 사용자의 글 접기(§8.3)와 팔로우 목록 페이지네이션은 이후 작업입니다.
  - 운영자의 "조치 목적" 팔로우 목록 열람(§8.3 운영자 열)은 아직 경로가 없습니다.

## 대안

- **자기 팔로우를 트리거로 막기**: 페르소나 행을 다시 읽는 트리거도 되지만, 사본 열 + 복합 외래 키 + check는 선언만으로 같은 보장을 주고 프로젝트 목록(ADR 0031)과 같은 방식입니다.
- **차단 때 두 사용자의 모든 페르소나 사이 팔로우 삭제**: 문장 그대로의 해석이지만 위 5절처럼 차단한 사람에게는 상대의 연결을, 차단당한 사람에게는 origin_persona 차단만으로 차단한 사람의 연결을 알려 줍니다.
- **차단을 `(blocker_user, blocked_user)` 한 행으로**: 설계 표에 가장 가깝지만 다시 차단할 때의 "이미 차단함"과 차단 목록 표시가 상대의 연결을 드러냅니다.
- **공개 경로에서도 차단 판정**: 쿠키를 읽어야 해서 공개 조회 공통 handler의 가정(ADR 0012·0031)이 깨지고, 로그아웃하면 어차피 보입니다.
- **공개 전환 때 대기 요청 자동 승인(Instagram 방식)**: §8.3이 "자동 승인하지 않고 본인에게 묻는다"고 정했습니다.
- **`show_follower_count = false`일 때 `followCounts: null`**: 모양이 같아 화면 코드는 단순하지만, 계획이 "숫자가 없음"을 요구했고 키를 빼면 직렬화 실수로 0이 새는 일도 없습니다.
