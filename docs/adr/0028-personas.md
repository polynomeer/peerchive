# 0028. 페르소나·표시명 ↔ 실명 연결 플래그: 계정당 실명·표시명 하나씩 + 하나의 전역 handle 공간 + 페르소나별 프로필(내부 조인은 실명만 집음) + 꺼져 있으면 상대를 읽지도 않는 공개 경로 + 플래그만 남는 감사

- 상태: 채택
- 날짜: 2026-10-27

## 맥락

S-01은 DELIVERY_PLAN §4.2 P1 공개 프로필·팔로우 백로그의 첫 항목입니다: "계정당 `real`·`display` 1개씩, handle 유일·예약어 거부. `Profile`·`PortfolioEdition`의 페르소나 귀속. 연결이 꺼져 있으면 두 프로필의 HTML·JSON·OG·PDF·검색·팔로우 목록에 상대 페르소나 정보 0건, 연결 토글은 감사 기록". 수용 시나리오는 §5.2 R(연결이 꺼진 상태에서 두 프로필 어디에도 상대 정보 없음, 켜면 양쪽에 서로의 링크, 다시 끄면 다음 요청부터 사라지고 토글 이력은 감사 기록에만). 관련 설계:

- SYSTEM_DESIGN §6.7.1: `Persona(id, user_id, kind, handle, display_name, account_privacy, show_follower_count, status)` — "handle은 두 종류가 같은 전역 공간에서 유일", "페르소나 행과 공개 DTO에는 같은 사용자의 다른 페르소나 ID를 두지 않음". `IdentityLink(user_id, real_persona_id, display_persona_id, visible 기본 false, changed_at)`. `Profile`은 `user_id` 대신 `persona_id`, `PortfolioEdition`도 페르소나에 귀속하고 채용자용 포트폴리오는 `real`이 기본. 프로필·팔로우·피드는 `server/modules/social`이 소유.
- §8.3: "표시명 ↔ 실명 연결 보기" 칸은 `IdentityLink.visible`일 때만(본인은 가능), 정책 함수 `canSeeIdentityLink`를 API·OG·PDF가 함께 씀. §9.2 `POST /personas`·`PATCH /personas/:id`(본인, 종류별 1개, handle 유일·예약어 거부), `PUT /me/identity-link`(변경 시 AuditEvent), `GET /profiles/:handle`(연결 비공개면 다른 페르소나 정보 없음).
- 지금 코드(T-02·T-14·T-15·C-01): `profiles`는 `user_id`가 기본 키이고 handle을 가집니다. 과제 공간·로그·할 일·선언·장부·체크인·커뮤니티 멤버·운영 화면 등 스무 곳 넘게 `profiles.user_id = users.id`로 조인해 멤버의 handle을 붙입니다. 공개 사례 스냅샷(`/p/:slug`)과 케이스 스터디에는 **계정 표시 이름**(`users.display_name`)이 들어갑니다. 신고·조치는 프로필을 `profile_user_id`(사용자)로 가리킵니다.

## 결정

### 모델 (migration `0026_personas`)

- **`personas`**: `id`, `user_id`, `kind`(`persona_kind`: real/display), `handle`, `display_name`, `account_privacy`(public/private, 기본 public), `show_follower_count`(기본 true), `status`(active/deactivated, 기본 active), 시각. `unique(user_id, kind)`로 계정당 종류별 하나, **`unique(handle)` 하나로 두 종류가 같은 전역 공간에서 유일**(DB가 막으므로 동시 요청에도 겹치지 않음). handle 형식 check는 프로필과 같은 `^[a-z0-9-]{3,30}$`, 앞뒤·연속 하이픈과 예약어는 애플리케이션(`@peerchive/domain` `checkHandle`·`RESERVED_HANDLES`, 기존 목록을 옮김)이 막습니다.
- **실명 페르소나의 이름은 `users.display_name`** 입니다(`display_name` 열은 real이면 null, display면 1~50자, check). 설계는 실명 페르소나 이름을 `User.real_name`으로 적었지만, 지금 공개 프로필·공개 사례 스냅샷·과제 공간이 모두 계정 표시 이름을 쓰고 C-03의 `real_name`은 "실명 방식 커뮤니티 글에서만"이라는 약속(ADR 0020)이 있어, 이 slice에서 공개 프로필 이름을 바꾸면 이미 공개한 출력이 바뀌고 C-03의 약속도 깨집니다. 같은 값을 페르소나 행에 복사하면 원본이 둘이 되므로 두지 않습니다. 실명 페르소나 이름을 `real_name`으로 옮길지는 S-03 이후 따로 정합니다.
- **`profiles`는 페르소나마다 하나**: 기본 키를 `persona_id`로 바꾸고 `persona_kind`를 둡니다. **`user_id`는 실명 프로필에만 채웁니다**(display는 null, check `(persona_kind = 'real') = (user_id is not null)`, `unique(user_id)`). 그래서 내부 조회의 `profiles.user_id = users.id` 조인 스무 곳은 고치지 않아도 실명 프로필만 집고, 과제 공간·커뮤니티 멤버 목록·운영 화면에 표시명 페르소나가 끼어들 길이 없습니다(행이 둘이 되어 조인 결과가 늘어나는 일도 없음). 한 줄 소개·관심 직무·학교(본인 입력)·졸업 시기·연락 정책·구직 여부·학교 인증 배지 표시는 페르소나별입니다.
- **handle의 원본은 `personas.handle`** 입니다. `profiles.handle`은 남겨 두되(내부 조인이 그대로 읽음) 복합 외래 키 `(persona_id, persona_kind, handle) → personas(id, kind, handle) ON UPDATE CASCADE`로 묶었습니다. 페르소나 handle을 바꾸면 같은 문장에서 프로필 handle이 따라 바뀌고, 프로필 handle만 다르게 바꾸는 update는 외래 키 위반입니다(원본이 둘로 갈라질 수 없음). 같은 외래 키가 프로필의 종류도 페르소나 종류와 맞춥니다. `(persona_id, user_id) → personas(id, user_id)`는 실명 프로필의 주인이 그 페르소나의 주인인지 확인합니다(display는 user_id가 null이라 MATCH SIMPLE로 건너뜀).
- **`identity_links`**: `user_id`(기본 키), `real_persona_id`, `display_persona_id`, `visible`(기본 false), `changed_at`. 두 페르소나 열은 각각 `(persona_id, user_id)` 복합 외래 키로 같은 사용자의 페르소나만 가리키고, 서로 달라야 합니다. **두 페르소나가 같은 사람이라는 사실은 이 테이블에만 있습니다**(페르소나 행·프로필 행·공개 DTO에는 상대 id가 없음).
- **`portfolio_editions.persona_id`**(NOT NULL, `(persona_id, user_id)` 복합 외래 키): version과 지금 판(current)은 **페르소나마다**입니다(`unique(persona_id, version)`, 부분 unique current). `user_id`는 소유자 확인·탈퇴 정리용으로 남깁니다.
- **기존 행 채우기**: 프로필마다 같은 handle의 real 페르소나를 만들고(이름은 계정 표시 이름 그대로라 공개 출력이 바뀌지 않음) 프로필·판을 붙입니다. 프로필 없이 판만 있는 사용자(정상 흐름에는 없음)는 프로필 행 없는 real 페르소나(handle `u-` + 사용자 id md5 앞 12자)를 만들어 판을 붙입니다 — 프로필 행이 없으므로 공개되지 않고, 그 사람이 프로필을 만들면 이 페르소나의 handle을 고른 값으로 바꿔 씁니다. 빈 DB에서는 채울 행이 없어 그대로 적용됩니다.

### 정책 함수와 공개 경로

- `canSeeIdentityLink(link, {isOwner})`(`@peerchive/domain` personas.ts): 본인이면 true, 아니면 `link.visible === true`. 운영자 예외는 두지 않습니다(§8.3 "신고 처리 시 감사 기록과 함께"는 S-07에서 별도 경로).
- `server/modules/social/personas.ts`(social 모듈의 첫 파일, 커뮤니티 글 테이블 import 없음):
  - `resolvePublicPersona(handle)`: 실명·표시명 어느 handle이든. 페르소나 active + 계정 active + 프로필 행 있음 + 운영 조치로 숨기지 않음. 아니면 404.
  - `linkedPersonaFor(persona, viewer)`: 연결 행을 읽어 `canSeeIdentityLink`가 false면 **상대 페르소나를 조회하지 않고** null. true여도 상대가 지금 공개 상태가 아니면 null(404가 날 링크를 걸지 않음, 숨긴 쪽을 드러내지 않음). 돌려주는 것은 `{kind, handle, displayName}`뿐 — id·소개·판은 싣지 않습니다.
- 공개 경로는 쿠키를 읽지 않으므로 항상 `isOwner: false`로 부릅니다. 공개 프로필 JSON(`GET /public/profiles/:handle`)과 이전 공개 프로필 API(`GET /profiles/:handle`)는 `kind`와 `linkedPersona`(꺼져 있으면 null)를 싣고, **HTML(`/u/:handle`)·OG·인쇄 보기(`/u/:handle/print`, PDF 경로)는 이 JSON만 그리고 README 카드도 이 DTO에서 만들므로** 상대 정보가 들어갈 다른 길이 없습니다. 켜져 있으면 화면·인쇄 보기·README 카드에 "실명 프로필/표시명 프로필: 이름 @handle" 링크가 붙고, OG에는 넣지 않습니다.
- **표시명 프로필의 공개 내용**: 프로필 필드, 그 페르소나의 지금 판의 글(한 줄 소개·역량 이름·자기 선언 스킬), 본인이 그 프로필에서 켠 학교 인증 배지. **대표 케이스·4년 타임라인·후배 기여는 비웁니다.** 공개 사례(`/p/:slug`)와 케이스 스터디에는 계정 표시 이름·팀 정보가 있어, 같은 케이스·타임라인이 두 프로필에 보이면 연결 플래그와 무관하게 같은 사람임이 드러나기 때문입니다. 같은 이유로 **표시명 페르소나의 판에는 대표 케이스를 넣을 수 없습니다**(422 `featuredCaseStudyIds: display_persona`), 공개 읽기에서도 한 번 더 비웁니다.
- **검색**: 프로필·페르소나는 `search_documents`에 들어가지 않습니다(공개 사례·선배 노트·막힘 Q&A만). 그래서 S-01에서 거를 것이 없고, 프로필을 검색에 넣는 slice가 `linkedPersonaFor`와 같은 규칙을 따릅니다. **팔로우 목록·추천**은 아직 없고(S-04·S-05) 같은 함수를 거칩니다.

### 본인 API·화면

- `POST /api/v1/personas {handle, displayName, 프로필 필드?, accountPrivacy?, showFollowerCount?}` → **201**. 표시명만(`kind`는 생략하거나 `display`), 실명 페르소나는 기존 온보딩 `PATCH /me/profile`이 같은 트랜잭션에서 만듭니다. 실명 프로필이 먼저 있어야 하고(409 `real_persona_required`), 둘째 표시명은 409 `persona_exists`, handle 422 `too_short`·`too_long`·`invalid_format`·`reserved`·`taken`(어느 종류와 겹쳤는지 밝히지 않음). 연결 행은 visible = false로 함께 생깁니다.
- `PATCH /api/v1/personas/:id`: 본인 것만(남의 것·없는 id·형식 오류 404). handle·표시명·프로필 필드·공개 설정. 실명 페르소나의 이름은 계정 표시 이름이라 422 `displayName: not_editable`(`PATCH /me/profile`을 씀). 실명 handle은 두 경로 모두 바꿀 수 있고 어느 쪽이든 `personas.handle`만 바꿉니다.
- `PUT /api/v1/me/identity-link {visible}` → 200 + 내 페르소나. 표시명이 없으면 409 `no_display_persona`. 바뀌지 않으면 아무것도 쓰지 않습니다. `GET /api/v1/me/personas`: 내 페르소나(실명 먼저)·프로필 필드·숨김 여부·연결 플래그(본인에게만, 두 페르소나 id가 함께 있는 유일한 응답).
- 판: `POST /portfolio-editions`·`…/preview`에 `personaId?`(없으면 실명, 내 것이 아니면 422 `personaId: not_found`), `GET /me/portfolio-editions`의 판마다 `persona {id, kind, handle}`. 화면 `/portfolio`는 실명 판만, `/portfolio/edition?persona=<id>`는 그 페르소나의 판(표시명이면 대표 케이스 칸이 없음).
- 화면 `/settings/personas`(주 메뉴 "표시명 프로필"): 표시명 프로필 만들기·고치기, 학교 칸에 "실명 프로필과 같은 값이면 같은 사람으로 추정될 수 있습니다" 안내, 연결 켜기는 확인 대화상자 — "켜면 누구나 두 공개 프로필이 같은 사람이라는 것을 알 수 있습니다. 나중에 끄더라도 그 사이 본 사람이나 저장된 사본에서는 되돌릴 수 없습니다."

### 감사·탈퇴 정리·운영 조치

- 감사(프로젝트 불변식: metadata에는 id·종류·플래그만): `persona.create {kind}`, `persona.update {kind, fields}`(바뀐 필드 **이름**만, 값 없음), `persona.identity_link_update {visible}`(대상은 사용자 id, handle·이름·페르소나 id 없음). 분석 이벤트는 추가하지 않았습니다(§6.2 이벤트는 S-07).
- 탈퇴 정리(worker purge): 연결 행 → 두 프로필(표시명 프로필은 user_id가 없어 페르소나로 찾음) → 판 → 페르소나 순서로 지웁니다(장부 `identity_links`·`profile`·`personas`). 표시명·handle은 남기지 않습니다.
- **운영 조치의 숨김은 페르소나마다**입니다(`profiles.hidden_at`이 프로필 행에 있으므로). 실명 프로필을 숨겨도 표시명 프로필은 그대로이고, 반대도 같습니다 — 함께 404가 되면 그 자체로 같은 사람임이 드러나기 때문입니다. 숨긴 페르소나로 가는 링크는 연결이 켜져 있어도 붙지 않습니다. 계정 정지·탈퇴(`users.status`)는 두 프로필 모두 404입니다.
- **신고는 실명 프로필만** 지금처럼 됩니다. 신고·조치·운영 화면 이름표가 사용자 단위(`profile_user_id`)라 표시명 프로필 신고를 받으면 운영 화면에 실명 handle이 붙고 숨김도 실명 프로필에 걸립니다. 그래서 표시명 프로필 화면에는 신고 버튼을 두지 않고, 신고 대상에 페르소나를 더하는 일은 S-07(“신고 대상에 페르소나·프로필 글·소셜 링크 추가, 표시명 사칭 신고 사유”)에서 합니다. 그 전까지 표시명 프로필의 문제는 실명 프로필 신고나 운영자 직접 조치(DB)로 다룹니다.

### 함께 고친 것

- 프로필 입력의 비울 수 있는 글(한 줄 소개·학교·졸업 시기)은 transform이 바깥에 있어 **키를 보내지 않아도 null로 바뀌었습니다**: `PATCH /me/profile {showAffiliationBadge}`(학교 인증 화면의 배지 스위치)가 한 줄 소개를 지웠습니다. 바깥을 optional로 바꿔 보낸 필드만 바꿉니다(`PATCH /personas/:id`도 같은 스키마).

## 결과

- 시나리오 R의 서버 쪽은 통합 테스트(`apps/web/test/personas.integration.test.ts`: 두 프로필의 공개 JSON·README 카드·이전 공개 프로필 DTO에 상대의 handle·이름·페르소나 id·소개 0건 → 켜기 → 서로의 링크 → 끄기 → 0건, 감사 metadata에 handle·이름 없음, 종류를 넘는 handle 충돌·예약어·둘째 표시명 거부, 판의 페르소나 귀속, 숨김의 페르소나 단위), 브라우저 쪽은 E2E `r-personas.spec.ts`(SSR HTML·payload·OG·인쇄 보기 포함)가 확인합니다. 도메인 규칙은 `packages/domain/test/personas.test.ts`.
- 내부 조인을 고치지 않고 표시명을 배제했기 때문에 기존 과제·커뮤니티·운영 코드는 바뀌지 않았습니다. 그 대신 `profiles.user_id`는 "실명 프로필의 주인"이라는 뜻이 되었고, 새 코드가 표시명 프로필의 주인을 찾을 때는 반드시 `personas`를 거쳐야 합니다.
- `profiles.handle` 사본은 외래 키로 원본과 묶였지만 열 자체는 남습니다. 내부 조인을 모두 `personas`로 옮기면 지울 수 있습니다.
- 표시명 프로필은 공개 사례를 보여 줄 수 없습니다. 공개 사례를 페르소나 이름으로 게시하는 길(스냅샷의 이름 표시를 페르소나로)은 S-03 이후의 일입니다.
- `account_privacy`·`show_follower_count`·`status = deactivated`는 저장만 하고 아직 동작이 없습니다(S-04). deactivated는 공개 경로에서 404로 다룹니다.

## 대안

- **표시명 프로필도 `user_id`를 채우고 내부 조인 스무 곳에 `persona_kind = 'real'` 조건 추가**: 한 곳이라도 빠뜨리면 과제 공간·운영 화면에 표시명이 끼거나 행이 두 배가 됩니다. user_id를 비워 두면 빠뜨릴 곳이 없습니다.
- **handle을 `profiles`에서 지우고 모든 조인을 `personas`로**: 원본이 하나가 되지만 이 slice의 변경이 스무 개 모듈로 퍼집니다. 외래 키 cascade로 사본을 원본에 묶는 쪽을 골랐습니다.
- **두 종류의 handle 유일성을 애플리케이션에서 확인**: 동시 요청에서 겹칠 수 있습니다. 하나의 unique로 막습니다.
- **실명 페르소나에도 `display_name`을 복사**: 계정 표시 이름이 바뀔 때마다 두 곳을 맞춰야 하고, 어긋나면 공개 프로필과 공개 사례의 이름이 달라집니다.
- **표시명 프로필에도 대표 케이스 허용**: 케이스 글과 `/p/:slug`의 계정 이름·팀 정보로 연결 플래그가 무의미해집니다.
- **운영 숨김을 계정 단위로(두 프로필 함께)**: 두 프로필이 동시에 사라지는 것이 연결 단서가 됩니다.
- **연결 플래그를 페르소나 행에(`linked_persona_id`)**: 설계가 금지한 "페르소나 행에 다른 페르소나 id". 별도 테이블에만 둡니다.
