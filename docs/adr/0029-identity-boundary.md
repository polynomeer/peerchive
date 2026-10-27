# 0029. 정체성 분리 경계: import로 닿는 모든 파일을 읽는 모듈 의존 테스트 + 커뮤니티 테이블 권한이 없는 social DB 역할 + persona_id NOT NULL인 페르소나 활동과 원본 행을 다시 보는 투영 트리거 + 작성 시점 페르소나 + 시드 고정 속성 기반 회귀 테스트

- 상태: 채택
- 날짜: 2026-10-28

## 맥락

S-02는 DELIVERY_PLAN §4.2의 둘째 항목입니다: "social 모듈의 커뮤니티 글 테이블 import 금지 lint, social DB 역할에 커뮤니티 글 SELECT 권한 없음, `PersonaActivity.persona_id NOT NULL`, 0~1단계 글의 투영 경로 없음. 속성 기반 회귀 테스트(프로필·피드·팔로우·추천·검색·OG·PDF에 0~1단계 글 0건) 통과". 착수 순서는 "S-02는 팔로우·피드보다 먼저"이고, §7 GP 게이트(공개 프로필·팔로우 개방)의 필수 조건이 "S-02 회귀 테스트(정체성 누출 0건)"입니다. 수용 시나리오는 §5.2 Q(익명 글이 `@devjimin`과 실명 프로필의 활동 목록·피드·추천·검색·OG·PDF 어디에도 없고 글 ID·작성 시각도 없음, 방이 실명으로 바뀐 뒤에도 이전 익명 글은 나타나지 않음, 아카이브로 옮기며 표시명을 고르면 복사본만 나타남). 관련 설계:

- SYSTEM_DESIGN §6.7.1 `PersonaActivity(id, persona_id, source_type(publication_release/senior_note/study_release/profile_post/community_post), source_id, item_kind, created_at, withdrawn_at?)` — 공개 프로필 활동 목록과 팔로우 피드가 읽는 **유일한 원천**, `persona_id NOT NULL`, 원본 모듈이 outbox로 투영, 커뮤니티 글은 `name_mode ∈ {real, display}`이고 `listed` 공간의 글만. "글의 페르소나 귀속": `Post`·`Comment`·`SeniorNote`·`ArchiveTransfer`의 `name_mode`가 real·display이면 작성 시점의 `persona_id`를 고정, 0~1단계는 항상 NULL(CHECK). "기존 규칙과의 관계": 익명 스터디 기록·익명 선배 노트는 0단계로 취급해 투영하지 않음.
- §8.3 불변조건 1: social 모듈은 `Post`·`Comment`·`ThreadAlias`·`ArchiveTransfer`를 import하지 않고(CI lint), social 모듈이 쓰는 DB 역할에는 커뮤니티 글 테이블 SELECT 권한이 없고, 커뮤니티 모듈은 real·display 글에만 outbox 이벤트를 만들고, 0~1단계는 투영 경로 자체가 없고, 회귀 테스트는 임의 조합의 속성 기반 테스트.
- ADR 0020(이름 표시 방식은 작성 시점 고정, 고정 열 트리거, "S-01 Persona가 생기면 그때 `persona_id`를 작성 시점에 함께 고정"), ADR 0021(커뮤니티 테이블은 schema.ts의 커뮤니티 구역에서 읽는 경계 검사), ADR 0026(익명 스터디 release는 `canLinkReleaseToPortfolio`가 막음), ADR 0028(S-01: social 모듈의 첫 파일 `social/personas.ts`, 공개 사례 스냅샷에는 계정 이름이 있어 표시명 프로필에 케이스를 싣지 않음).
- 지금 코드: 저장소에 ESLint가 없습니다(경계 검사는 vitest가 소스를 읽는 방식, ADR 0021). 앱은 DB에 한 계정으로 붙습니다(`DATABASE_URL`, 로컬 docker에서는 슈퍼유저 겸 테이블 주인). 활동 목록·팔로우·피드 화면은 아직 없습니다(S-05). 공개 프로필 JSON·README 카드·이전 공개 프로필 DTO는 S-01에서 페르소나를 풉니다.

## 결정

### 1. 모듈 의존 lint: 테스트가 import 그래프를 따라감 (`apps/web/test/identity-boundary.integration.test.ts`, DB 없이)

- **커뮤니티 테이블 목록은 스키마에서**: ADR 0021과 같은 규칙(schema.ts에서 머리말에 "커뮤니티"가 든 구역의 `pgTable`)을 `test/community-tables.ts`가 내보낸 이름·SQL 이름으로 둘 다 돌려주게 넓혔습니다. 글·댓글·스레드 번호·공감·작성자 확인·이름 표시 변경·옮기기·동의·스터디 기록 등 지금 19개가 모두 들어가고, 새 커뮤니티 테이블도 자동으로 덮습니다.
- **검사 대상**: (a) `server/modules/social/**` 전부, (b) 이름이 `personas?`·`profiles?`·`profile.*.ts`·`identity-link`·`follows?`·`followers`·`following`·`feeds?`·`activit(y|ies)`인 모든 `server/api` 라우트(지금 8개 — S-04·S-05의 팔로우·피드·활동 라우트도 이름으로 자동 포함), (c) 공개 프로필·포트폴리오가 페르소나를 푸는 `identity/profiles.ts`·`portfolio/public-profile.ts`·`portfolio/public-http.ts`.
- **규칙**: 위 파일과 **그 파일에서 상대 import로 닿는 모든 파일**(지금 38개: 판·케이스·release 범위·공개 읽기·엠바고·학교 인증·감사 등)이 ① 커뮤니티 모듈(`modules/community/**`·커뮤니티 API)을 import하지 않고, ② `@peerchive/db`에서 커뮤니티 테이블을 import하지 않고(별칭·`type`·여러 줄 포함), ③ `@peerchive/db`를 `* as`·기본·동적 import로 가져오지 않습니다(이름을 확인할 수 없으므로). (a)·(b)와 서버 파일은 ④ 본문에 커뮤니티 테이블 이름(내보낸 이름·SQL 이름)도 쓰지 않습니다(손으로 쓴 SQL 포함). 공유 타입 파일(`shared/types/api.ts`)은 DTO 필드 이름(`boards` 등)이 겹쳐 ①~③만 봅니다.
- **스캐너 자기 검사**: 여러 줄·별칭·`type`·`* as`·동적 import·SQL 문자열·주석 줄을 담은 가짜 소스로 위반을 모두 잡는지, 소셜 테이블은 위반이 아닌지 먼저 확인합니다(정규식이 아무것도 못 잡아 통과하는 일을 막음).
- 이 테스트가 CI lint 역할을 합니다(ESLint 규칙을 새로 들이지 않음 — 저장소의 다른 경계 검사와 같은 방식).

### 2. social DB 역할 `peerchive_social` (migration `0027_identity_boundary`)

- **로그인할 수 없는(NOLOGIN) 역할**이고, 권한은 social 읽기 경로가 실제로 읽는 것만입니다: `personas`·`profiles`·`identity_links`·`persona_activities` SELECT, `users`는 열 단위로 `id`·`display_name`·`status`만(이메일·실명·탈퇴 정리 정보 없음), `public` 스키마 USAGE. **커뮤니티 구역 테이블에는 어떤 권한도 없고**, 선배 노트·공개 후보·막힘 Q&A·감사 같은 원천 테이블도 읽지 않습니다.
- 권한 목록은 DB 함수 `peerchive_apply_social_grants()` 하나에 둡니다(역할이 없으면 false). 이후 팔로우·피드 테이블이 생기면 그 migration이 이 함수를 `CREATE OR REPLACE`하고 다시 부릅니다.
- **멱등·권한 부족 대비**: migration은 역할이 없을 때만 `CREATE ROLE`을 시도하고, migration 사용자에게 CREATEROLE이 없으면(`insufficient_privilege`) NOTICE만 남기고 넘어갑니다(동시에 만들어졌으면 `duplicate_object`도 무시). 그다음 함수를 불러 권한을 줍니다(역할이 없으면 아무것도 안 함). 역할은 클러스터 전역이라 같은 서버의 다른 DB(E2E용 `peerchive_e2e` 등)에서 이미 만들어졌어도 그대로 쓰고, 권한은 DB마다 줍니다. 로컬 docker의 `peerchive` 사용자는 슈퍼유저 겸 테이블 주인이라 migration이 역할을 직접 만듭니다.
- **운영(RUNBOOK §1·§2 GP)**: 운영 DB의 migration 계정에 CREATEROLE이 없으면 DB 관리자가 한 번 `CREATE ROLE peerchive_social NOLOGIN;`을 실행하고 테이블 주인 계정으로 `SELECT peerchive_apply_social_grants();`를 부릅니다. 확인은 RUNBOOK의 SQL(커뮤니티 테이블 권한 0행).
- **런타임에 이 역할로 붙는 것은 이번 범위가 아닙니다(후속)**: 지금 앱은 한 연결 풀로 모든 모듈을 처리하고, social 읽기 경로만 다른 역할로 돌리려면 요청 단위 `SET LOCAL ROLE` 트랜잭션(또는 별도 풀·로그인 역할)과 공개 포트폴리오 경로의 release 뷰가 필요합니다. 공개 포트폴리오 프로필(`portfolio/public-profile.ts`)은 판·케이스·release·포크 수·선배 노트 수·학교 배지까지 읽어, 이 역할에 그 테이블들을 주면 "원천 테이블을 읽지 않는 역할"이 무너집니다. 그래서 S-02는 역할·권한·테스트까지 두고, **S-05에서 활동 목록·피드 라우트를 붙일 때 그 라우트를 이 역할의 트랜잭션에서 실행**하는 것을 후속으로 남깁니다. 대신 테스트가 **같은 역할로 지금의 social 읽기 경로(`resolvePublicPersona`·`linkedPersonaFor`·이전 공개 프로필 DTO `getPublicProfile`·`listPersonaActivities`)를 실제로 실행**해 권한 목록이 충분하고 커뮤니티 테이블에 닿지 않음을 확인합니다.

### 3. 페르소나 활동(`persona_activities`)과 투영 규칙

- **테이블**: `id`, `persona_id`(NOT NULL, personas 외래 키), `source_type`(enum `persona_activity_source`: publication_release/senior_note/study_release/profile_post/community_post), `source_id`(원천마다 다른 테이블이라 외래 키 없음), `item_kind`(공개 범위 항목 대응 — 공개 사례 `cases`, 선배 노트·스터디 release `notes_and_studies`, 프로필 글·커뮤니티 글 `posts`; 원천 종류와 맞는지 check), `created_at`(원천의 시각), `withdrawn_at`. `unique(persona_id, source_type, source_id)`, 거두지 않은 행의 (페르소나, 시각) 인덱스. schema.ts에서는 신원·프로필 구역(커뮤니티 구역 밖)에 둡니다. 커뮤니티 댓글·막힘 Q&A·스터디 기록 안의 로그는 원천이 아닙니다.
- **규칙 한 곳(`@peerchive/domain` `decidePersonaActivityProjection`)**: 원본 모듈이 자기 테이블에서 읽은 사실을 넘기면 투영 여부와 거부 이유를 돌려줍니다. 익명은 다른 조건보다 먼저 `anonymous`입니다.
  - 커뮤니티 글: 방식 real·display, **작성 시점에 고정한 페르소나가 바로 이 페르소나**(종류도 방식과 같음), listed 공간, 게시 중. 그래서 표시명 글은 실명 페르소나에, 실명 글은 표시명 페르소나에 붙지 않습니다.
  - 선배 노트: 익명은 없음, 계정 이름(`name`) 노트는 실명 페르소나만, 표시명(`display`) 노트는 표시명 페르소나만, 게시 중.
  - 공개 사례·스터디 release: **실명 페르소나만**(스냅샷에 계정 이름·팀 정보가 있어서, ADR 0028), 본인 동의(granted), 게시 중. 스냅샷이 익명 스터디 방(`studyNameMode = anonymous`)이면 어느 원천 종류로 넘겨도 `anonymous`.
  - 프로필 글: 자기 페르소나만(테이블은 S-05).
- **DB 트리거 `persona_activities_projection_guard`**(BEFORE INSERT OR UPDATE): 같은 규칙을 **원본 행으로** 다시 확인합니다 — 커뮤니티 글이면 그 글의 `name_mode`·`persona_id`·상태·공간 노출, 선배 노트면 작성자·방식·상태, release면 상태·스냅샷·그 페르소나 주인의 동의. 프로필 글은 테이블이 생길 때까지 거부합니다. 넘겨받은 사실을 속이거나 SQL로 바로 넣어도 익명 글은 들어오지 못합니다(23514). 투영한 뒤에는 `withdrawn_at`만 바꿀 수 있습니다. `SECURITY DEFINER`(search_path 고정)라 나중에 social 역할로 넣더라도 원본 확인은 테이블 주인 권한으로 하고, 결과는 통과·거부뿐이라 원본 내용이 새지 않습니다. 이 트리거는 DB에 있고 social 모듈 코드가 아닙니다.
- **쓰기 도우미 `social/activities.ts`**: `projectPersonaActivity`(규칙 → insert, 같은 원천은 한 번), `withdrawPersonaActivities`(원천의 모든 투영에 withdrawn_at), `listPersonaActivities`(거두지 않은 행, 최근 순, 이 테이블만 읽음). social 모듈이 쓰는 유일한 길이고 커뮤니티를 import하지 않습니다(사실은 원본 모듈이 넘김).
- **원본 모듈 연결은 S-05와 함께**: 지금은 어떤 원본 모듈도 투영을 부르지 않습니다. 투영을 켜면 숨김·삭제·철회·방식 재선택·listed → unlisted 전환마다 `withdrawn_at`을 채우는 연결과 활동 목록·피드의 읽기 시점 원본 재확인(§11.3)이 함께 있어야 하는데, 읽는 화면이 없는 상태에서 쓰기만 켜면 철회 경로가 빠진 행이 쌓입니다. outbox 이벤트(커뮤니티 모듈이 같은 트랜잭션에서 만들고 worker 처리기가 이 도우미를 부름)도 그때 붙입니다. 활동 목록이 없으므로 지금 공개 응답에 활동이 나타날 길도 없습니다.

### 4. 작성 시점 페르소나(`community_posts`·`community_comments.persona_id`)

- 설계의 "글의 페르소나 귀속"과 ADR 0020의 약속대로 **글·댓글에 작성 시점의 페르소나를 고정**합니다. 투영 트리거가 "이 글이 이 페르소나의 것인가"를 원본 행 하나로 판정하려면 이 열이 있어야 하고(작성자 id로 판정하면 나중에 만든 표시명 페르소나에 예전 글을 붙일 수 있음), S-05에서 이 열이 없으면 소급해서 채울 근거가 사라집니다.
- 쓰는 순간(`createPost`·`createComment`, 공간 FOR SHARE 잠금 안): real → 실명 페르소나, display → 표시명 페르소나, **없으면 null — 다른 종류로 대신하지 않습니다**(표시명이 없는 사람의 표시명 글을 실명 페르소나에 붙이면 고른 단계를 넘어 실명 프로필로 끌어올림). anonymous → 조회하지 않고 null.
- DB: check `name_mode <> 'anonymous' or persona_id is null`(익명은 항상 null), INSERT 트리거 `community_persona_attribution_guard`(페르소나 주인 = 작성자, 페르소나 종류 = 방식), 고정 열 트리거(0020)를 고쳐 `persona_id`도 고정하되 **null로 비우는 것만** 허용(탈퇴 정리가 페르소나 행을 지우기 전에 비움).
- **기존 행 채우기**: real 글·댓글만, 작성 시각에 실명 프로필이 이미 있었을 때(`profiles.created_at <= 작성 시각`; S-01이 프로필마다 실명 페르소나를 만들었으므로 그때 있던 실명 페르소나) 그 페르소나. **display 글은 채우지 않습니다**: 지금까지 표시명 글은 계정 표시 이름(= 실명 페르소나의 공개 이름)으로 보였으므로, 나중에 만든 표시명 페르소나에 붙이면 두 페르소나가 이어지고 실명 페르소나에 붙이면 단계를 끌어올립니다. 그 글들은 영구히 투영되지 않습니다. 빈 DB에서는 채울 행이 없습니다.
- **작성자 표시는 바꾸지 않았습니다**: 표시명 글은 여전히 계정 표시 이름으로 보입니다(ADR 0020/0022). 표시명 페르소나가 있는 사람의 표시명 글을 그 페르소나 이름으로 보이게 하는 것은 **S-05에서 커뮤니티 글 투영을 켜기 전에** 해야 합니다 — 그렇지 않으면 공간 멤버가 "계정 이름으로 보이는 글"과 "표시명 프로필의 활동"을 맞춰 두 페르소나를 이을 수 있습니다(아래 결과·후속).
  - → [ADR 0030](0030-display-persona-names.md)에서 바꿈: 표시명 방식은 active 표시명 페르소나가 있어야 쓰고(403 `display_persona_required`), 이름은 고정한 `persona_id`의 표시명, `persona_id`가 없는 예전 글은 "표시명 없음"입니다.
- 탈퇴 정리(worker purge): 페르소나 활동 삭제 → 글·댓글의 `persona_id` 비움 → 페르소나 삭제(장부 `persona_activities`·`community_persona_refs`). 글·댓글 행은 기존 규칙대로 남습니다.
- `ArchiveTransfer`·`SeniorNote`의 `persona_id`는 이번에 두지 않았습니다: 옮긴 복사본(막힘 Q&A·선배 노트 초안)의 이름은 동의 행의 `display_mode`·`display_label`이고(ADR 0025), 시나리오 Q의 "복사본만 표시명에 나타남"은 복사본 선배 노트를 `senior_note` 원천으로 표시명 페르소나에 투영하는 일이라 S-05에서 선배 노트의 페르소나 귀속과 함께 정합니다. 그때까지 선배 노트 투영은 작성자·방식으로 판정합니다(트리거).

### 5. 속성 기반 회귀 테스트 (시드 고정, 의존성 추가 없음)

- fast-check를 들이지 않고 시드 고정 난수(mulberry32)로 세계를 만듭니다. 실패 메시지에 시드가 있어 같은 조합을 다시 만들 수 있고, `S02_PROPERTY_WORLDS`·`S02_PROPERTY_SEED`로 더 많이 돌릴 수 있습니다(기본 6개 세계 ≈ 13초, 25개 ≈ 50초 확인).
- 세계 하나: 학교, 공식 페이지(익명 기본, 글·댓글마다 익명/표시명 무작위), 실명·표시명·익명 사용자 방 2~4개(listed·unlisted 무작위), 그중 익명 방 일부는 글을 쓴 뒤 **실명·표시명으로 바뀜**(예약 → 7일 → worker 적용, 시나리오 Q), 사용자 2~4명(실명 프로필 있음/없음, 표시명 페르소나 있음/없음, 연결 켬/끔), 모든 방식의 글·댓글(서비스 함수로 작성, 시각은 서로 다른 밀리초). 그다음 원본 모듈이 하듯 **모든 글을 작성자의 모든 페르소나로 투영 시도**합니다(규칙이 거름).
- 속성: 모든 페르소나마다 공개 프로필 JSON·README 카드(HTTP 핸들러)·이전 공개 프로필 DTO·활동 목록에 익명 글·댓글의 id·제목·본문·제목/본문 SHA-256·작성 시각(ISO·epoch ms)이 0건. 활동 목록은 정확히 "그 페르소나로 작성 시점에 고정된 같은 종류 방식의 listed 공간 글"과 같고(다른 종류·익명·unlisted 없음), DB 전체에서 익명 글을 가리키는 활동 0행·익명 글·댓글의 `persona_id` 0건. 생성기가 빈 세계로 통과하지 않도록 익명 글 수·투영 수·페르소나 수 하한도 봅니다.
- 같은 파일의 고정 테스트: 작성 시점 페르소나(종류별·없을 때 null·불일치 거부·고친 뒤 붙이기 거부·비우기 허용), 투영 규칙과 트리거(속인 사실·SQL 직접 insert·null 페르소나 23502·프로필 글·withdrawn_at 외 변경 거부), 역할 권한(커뮤니티 테이블 19개 전부 권한 0, 소셜 테이블 SELECT만, users 열 3개만, `SET LOCAL ROLE` 뒤 글·댓글·스레드 번호·옮기기·동의·공감·공간 SELECT 42501, social 읽기 경로는 같은 결과). 도메인 테스트 `packages/domain/test/persona-activities.test.ts`(익명 원천 전수 조합 포함), worker `ops-purge`(페르소나 참조 비우기).

## 결과

- §8.3 불변조건 1의 세 겹(모듈 import·DB 권한·투영 경로)이 각각 자동 검사를 가집니다. 0~1단계 글이 페르소나 활동에 들어가려면 도메인 규칙·DB 트리거를 모두 통과해야 하는데 둘 다 익명을 거부하고, 테이블은 `persona_id NOT NULL`, 익명 글의 `persona_id`는 check로 null입니다.
- 공개 프로필·README 카드·이전 공개 프로필 DTO·(S-05 전의) 활동 목록에 대한 GP 게이트의 "S-02 회귀 테스트"가 있습니다. 피드·팔로우·추천·검색·OG·PDF는 지금 활동을 싣지 않으므로(OG·PDF·HTML은 공개 프로필 JSON만 그림, ADR 0028; 프로필은 검색 색인에 없음) 이 테스트가 그 출처를 덮고, 각 기능이 생기면 같은 속성 테스트에 그 응답을 더합니다(A-05의 "S-02 테스트 확장"도 같은 자리).
- 한계·후속:
  - **런타임 역할 전환 없음**(§2): 앱은 여전히 테이블 주인 권한의 한 계정으로 붙습니다. S-05에서 활동·피드 라우트를 `SET LOCAL ROLE peerchive_social` 트랜잭션으로 돌리고, 공개 포트폴리오 경로를 release 뷰로 옮길지 정합니다.
  - **원본 모듈 투영·철회 미연결**(§3): S-05에서 outbox 이벤트·처리기·철회 연결·읽기 시점 원본 재확인을 함께 붙입니다.
  - **표시명 글의 작성자 표시**(§4): 투영을 켜기 전에 표시명 페르소나 이름으로 바꿔야 합니다. 이미 계정 이름으로 보였던 글을 기억·저장한 사람에게는 되돌릴 수 없습니다(이름은 읽을 때의 값, ADR 0020).
  - `ArchiveTransfer`·`SeniorNote`의 `persona_id`, 0~1단계 분석 이벤트의 사용자 키 없음은 S-05·S-07 범위입니다(분석은 C-04부터 익명 글을 unlinked로 기록).
  - 경계 테스트는 상대 import만 따라갑니다. Nuxt 서버 auto-import(`server/utils`의 `requireDb` 등)는 그래프에 없지만 커뮤니티를 import하지 않습니다(C-05 테스트가 서버 전체를 덮음).
  - 트리거의 release 판정은 스냅샷의 `kind`·`studyNameMode` 키와 `consents` 상태에 기대므로, 스냅샷 형식이 바뀌면 이 함수도 고쳐야 합니다.

## 대안

- **ESLint `no-restricted-imports` 도입**: 표준이지만 저장소에 린터가 없고, 테이블 목록을 스키마 구역에서 읽는 규칙과 import 그래프 추적(공개 포트폴리오 경로가 닿는 모든 파일)을 설정만으로 표현하기 어렵습니다. 기존 경계 검사와 같은 테스트 방식을 골랐습니다.
- **social 모듈 파일만 검사(그래프를 따라가지 않음)**: 단순하지만 social이 import하는 다른 모듈이 커뮤니티를 import하면 놓칩니다.
- **역할을 migration 밖(운영 스크립트)에서만 만들기**: CREATEROLE 문제는 없지만 새 DB·테스트 DB마다 빠지기 쉽습니다. migration이 만들고, 권한이 없으면 넘어가고, 권한 목록은 DB 함수 하나로 둡니다.
- **역할에 공개 포트폴리오가 읽는 테이블까지 SELECT**: 지금 공개 프로필 경로 전체를 역할로 돌릴 수 있지만 선배 노트(익명 노트의 작성자 포함)·공개 후보 등 원천 테이블 권한을 주게 되어 "social은 활동·페르소나·공개 release 뷰만 읽음"(§8.3)과 어긋납니다.
- **투영 검사를 애플리케이션 규칙만으로**: 다른 경로(운영 스크립트·후속 코드)가 규칙을 건너뛰면 막을 것이 없습니다. DB 트리거가 마지막 경계입니다.
- **작성 시점 페르소나 없이 작성자 id로 투영 판정**: 열이 줄지만, 나중에 만든 표시명 페르소나에 예전 표시명 글이 붙거나 표시명이 없을 때 실명으로 대신하는 실수를 DB가 막을 수 없습니다.
- **기존 display 글을 지금의 표시명 페르소나(없으면 실명)로 채우기**: 활동 목록이 풍부해지지만 계정 이름으로 보였던 글이 표시명 프로필에 붙어 연결 플래그가 무의미해집니다.
- **fast-check 도입**: 축소(shrinking)가 있지만 DB 세계 생성이 대부분이라 이득이 작고 의존성이 늘어납니다. 시드 고정 생성기로 재현성을 확보했습니다.
- **원본 모듈 투영을 지금 바로 켜기**: S-02 범위에서 "쓸 수 있는 경로"를 실제로 돌려 볼 수 있지만, 철회 연결과 읽기 화면 없이 쓰기만 켜면 철회되지 않은 행이 쌓이고 표시명 글 작성자 표시 문제(§4)가 남은 채로 투영됩니다.
