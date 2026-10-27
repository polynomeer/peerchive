# 0031. 항목별 공개 범위·과제 수행 목록: 저장하지 않는 기본값 + 한 줄로 늘어선 다섯 단계 + 비공개 계정 좁힘 + 공개 경로는 늘 비로그인 판정 + 실명 페르소나에만 두는 과목·학기·제목 목록

- 상태: 채택
- 날짜: 2026-10-28

## 맥락

S-03은 DELIVERY_PLAN §4.2 공개 프로필·팔로우 백로그의 셋째 항목입니다: "5단계 audience와 `follow_lists` 2단계. 공개 사례 항목은 공개 절차로만 나타나고 설정으로 넓힐 수 없음. `ProjectListing`은 과목·학기·제목만, 엠바고 중에는 제목 제외. 설정 변경 전후 비공개 과제 공간 접근 결과 동일". 수용 시나리오는 §5.2 S(모든 항목을 전체 공개로 바꿔도 동의가 끝나지 않은 공개 후보·비공개 과제 공간·엠바고 중인 과제 제목은 프로필에 없음, 목록에는 고른 과제의 과목·학기·제목만, 다른 멤버 이름·로그 없음). 관련 설계:

- SYSTEM_DESIGN §6.7.1: `VisibilitySetting(persona_id, item_kind ∈ project_list/posts/notes_and_studies/follow_lists, audience ∈ public/signed_in/same_institution/approved_followers/private)`, `(persona_id, item_kind)` 유일, `follow_lists`는 public/private만, 초기안 기본값 `project_list = private`·나머지는 공개 계정 `signed_in`/비공개 계정 `approved_followers`. `ProjectListing(project_member_id, persona_id, shown_at, hidden_at?)` — 멤버가 고른 과제만, 노출 필드는 과목·학기·`Project.title`, 엠바고 중 제목 제외, `anonymous` 스터디 방의 과제 등록 불가.
- §8.3 불변조건 2와 권한 표: `VisibilitySetting`·`account_privacy`는 공개 사례 집합을 좁힐 수만 있음. "과제 수행 목록·공개 글·선배 노트·스터디 기록" 줄은 열마다 "`public`일 때 / `signed_in` 이상 / `same_institution` 이상 / `approved_followers` 이상 / 본인 가능". 비공개 계정은 나머지 항목을 `approved_followers` 이하로 제한. `same_institution`은 두 사람의 활성 `InstitutionAffiliation`이 같은 기관인지, 표시명 페르소나에 쓰면 소속이 추정될 수 있으니 설정 화면에 안내. 정책 함수 `canViewPersona`·`canViewPersonaItem(itemKind)`를 API·OG·PDF가 함께 씀. §9.2 `PUT /personas/:id/visibility`(본인, 공개 사례 항목은 받지 않음).
- 지금 코드: 공개 경로(`/api/v1/public/profiles/:handle`·README 카드, 이것만 그리는 `/u/:handle` HTML·OG·`/print`)는 세션 미들웨어가 건너뛰어 쿠키를 읽지 않습니다(ADR 0012·0014). 팔로우·차단은 아직 없습니다(S-04). ADR 0028은 표시명 프로필에 케이스 스터디를 두지 않기로 했습니다(공개 사례에 계정 이름이 있어 두 프로필이 이어지므로). ADR 0029는 social 모듈이 커뮤니티 테이블을 import하지 않고, social DB 역할의 권한 목록을 `peerchive_apply_social_grants()` 하나에 두었습니다.

## 결정

### 1. 정책: 다섯 단계를 한 줄로 (`@peerchive/domain` `visibility.ts`)

- §8.3 표의 "X 이상"을 그대로 **선형 순서**로 둡니다: `public(0) ⊃ signed_in(1) ⊃ same_institution(2) ⊃ approved_followers(3) ⊃ private(4)`. 보는 사람의 가까움(`viewerCloseness`)은 겹치는 열 중 가장 가까운 것(비로그인 0, 로그인 1, 같은 기관 2, 승인된 팔로워 3, 본인 4)이고, `canViewPersonaItem`은 `가까움 ≥ 항목이 요구하는 단계`입니다. 그래서 승인된 팔로워는 다른 학교여도 `same_institution` 항목을 봅니다(표의 "승인된 팔로워" 열이 `approved_followers` 이상이면 가능).
- `canViewPersona`는 페르소나 active + 차단당하지 않음(본인은 차단과 무관)입니다. `canViewPersonaItem`은 이것을 먼저 봅니다.
- **기본값은 저장하지 않고 계산**합니다(`defaultAudience`): `project_list` = private, `posts`·`notes_and_studies` = 공개 계정 signed_in / 비공개 계정 approved_followers. 바꾼 항목만 행으로 남깁니다. 계정 공개 설정을 바꾸면 기본값도 따라 바뀌고, 페르소나를 만들 때 행을 채우는 코드·backfill이 없습니다. 화면·API는 `isDefault`로 구분해 보여 줍니다.
- `follow_lists`는 signed_in을 받을 수 없으므로 설계의 "나머지는 signed_in" 기본값을 그대로 쓸 수 없습니다. **두 단계 중 좁은 쪽인 private**을 기본값으로 둡니다(팔로우 목록 자체가 S-04에서 생김 — 아래 결과의 열린 질문).
- **비공개 계정 좁힘**(`effectiveAudience`): 저장한 값이 public·signed_in·same_institution이어도 비공개 계정이면 approved_followers로 적용합니다(`follow_lists`의 public도). 저장 값은 그대로 두어 공개 계정으로 돌아가면 다시 그 값입니다. API는 저장 값(`audience`)과 적용 값(`effective`)을 함께 줍니다.
- **승인된 팔로워 = S-04 전까지 본인만**: `PersonaViewer.approvedFollower`·`blocked`는 social의 `personaViewerFor`가 채우며 지금은 늘 false입니다. S-04는 이 함수에 팔로우 승인·차단 조회만 더하면 되고 도메인 함수는 바뀌지 않습니다.
- `same_institution`은 열람자와 주인의 active 학교 인증이 가리키는 **정본 학교**(병합 반영)가 하나라도 겹치는지로 봅니다(`activeAffiliationSchoolIds`). 인증을 해제하면 다음 요청부터 못 봅니다.

### 2. 저장: `visibility_settings` (migration `0028_visibility_settings`)

- 기본 키 `(persona_id, item_kind)`, enum `visibility_item_kind`·`visibility_audience`, check `item_kind <> 'follow_lists' or audience in ('public','private')`. 공개 사례·케이스 스터디는 enum에 없어서 DB에도 둘 자리가 없습니다.
- `PUT /api/v1/personas/:id/visibility {items: {itemKind: audience}}` — 바꿀 항목만 보냅니다. 남의 페르소나·없는 id는 입력 검사보다 먼저 404. 422: 목록 밖 이름(`cases`·`case_studies`·`publications` 등은 `publication_procedure`, 그 밖은 `unknown_item`), 받지 않는 값 `invalid`(follow_lists의 signed_in 등), 표시명 페르소나의 `project_list`를 private 밖으로 `real_persona_only`, 빈 요청 `items: required`. 하나라도 틀리면 아무것도 쓰지 않습니다. `GET /api/v1/personas/:id/visibility`는 네 항목의 저장 값/기본값·적용 값·고를 수 있는 값.
- 감사 `persona.visibility_update`에는 `{kind, items}`(페르소나 종류와 바뀐 항목 이름)만 남기고 audience 값은 남기지 않습니다. 같은 값이면 쓰지도 감사하지도 않습니다.

### 3. 과제 수행 목록: `project_listings`, 실명 페르소나만

- 열: `project_member_id`, `persona_id`, `shown_at`, `hidden_at` + 무결성용 `persona_kind`(check `= 'real'`), `user_id`. 복합 외래 키 셋 — `(project_member_id, user_id) → project_members(id, user_id)`, `(persona_id, user_id) → personas(id, user_id)`, `(persona_id, persona_kind) → personas(id, kind)` — 로 **멤버십의 주인 = 페르소나의 주인**이고 **실명 페르소나**임을 DB가 보장합니다(대상 unique `project_members_id_user_key`·`personas_id_kind_key` 추가). 숨기면 `hidden_at`만 채우고, 다시 올리면 같은 행의 `shown_at`을 새로 씁니다.
- **실명 페르소나만**: 표시명 프로필에 팀 과제를 올리면 팀원(과목·학기·제목을 아는 사람)이 그 표시명 프로필을 자기 팀원의 실명과 바로 잇습니다. ADR 0028이 표시명 프로필에 케이스 스터디를 두지 않은 것과 같은 이유입니다. 표시명 페르소나의 `project_list`는 private만 받고, 목록 API는 409 `real_persona_only`, 공개 DTO의 `projects`는 늘 null입니다.
- 올릴 수 있는 과제(`listingBlock`): **active 멤버**의 과제만(나가거나 내보내지면 행이 남아도 읽을 때 빠짐), 스터디 기록은 **실명 방만** — `anonymous` 방은 409 `anonymous_study`(ADR 0026), `display` 방도 409 `display_study`(실명 목록에 올리면 그 방의 표시명과 실명 프로필이 이어짐). 방 방식이 나중에 바뀌어도 읽을 때 같은 함수로 다시 거릅니다. 내리기는 언제나 됩니다.
- API: `GET /api/v1/personas/:id/project-listings`(내가 active 멤버인 과제·목록 여부·엠바고 여부·막힌 이유, 본인에게는 엠바고 중에도 제목), `PUT /api/v1/personas/:id/project-listings {projectId, shown}`(남의 페르소나·active 멤버가 아닌 과제 404). 과제 id를 경로가 아니라 본문에 둔 이유는 아래 결과의 "타입 라우트 표"입니다. 감사 `persona.project_listing_update`는 `{shown}`과 대상 페르소나·과제 id만.
- **노출**(`visiblePersonaProjects`): `{courseTitle, termLabel, title}` 세 필드뿐(과제 id·종류·멤버·로그·파일 없음). 엠바고는 `getProjectEmbargo`와 같은 계산(`computeEffectiveEmbargo`: 과제 embargo_until + 학기 엠바고 + 과제 엠바고, 해제되지 않은 것)을 한 번에 하고, 걸려 있으면 `title: null`(과목·학기는 그대로). 최근 학기 먼저. 병합된 과목은 정본 과목 이름.
- 과제 공간의 멤버십·읽기 권한(`loadReadableProject`)은 이 표를 보지 않습니다. 통합 테스트가 주인·팀원·같은 학교의 외부인의 과제 읽기 결과를 설정·목록 변경 전, 전체 공개 뒤, 다시 좁힌 뒤에 비교합니다.

### 4. 어디서 판정하나: 공개 경로는 늘 비로그인

- 공개 프로필 JSON·README 카드(그리고 이 JSON만 그리는 `/u/:handle` SSR HTML·OG·`/print`)는 쿠키를 읽지 않으므로 `ANONYMOUS_VIEWER`로 `canViewPersonaItem('project_list')`를 판정합니다. 즉 이 경로에는 **`project_list`가 전체 공개일 때만** 목록이 실리고(`projects: [...]`), 아니면 `projects: null`. 캐시·검색 엔진·링크 미리보기가 받는 응답이 보는 사람과 무관하게 같습니다.
- 로그인·같은 기관·본인 범위는 세션을 읽는 기존 `GET /api/v1/profiles/:handle`에 `projects`를 더해 줍니다(`getProfileProjects`, `cache-control: private, no-store`). `/u/:handle` 화면은 SSR 응답에 목록이 없을 때만 **브라우저에서** 이 API를 불러 붙입니다. 보는 사람에 따라 달라지는 내용이 SSR HTML·payload에 들어가지 않습니다. 인쇄 보기는 공개 JSON만 씁니다(로그인 범위 목록은 인쇄물에 없음).
- **공개 사례·케이스 스터디·타임라인은 이 설정과 무관**합니다. 계속 게시 중인 release·동의가 끝난 것만(T-11~T-14 경로 그대로) 나오고, `projects` 목록은 과제 공간의 제목일 뿐 공개 사례로 이어지는 링크가 없습니다. 시나리오 S 테스트는 모든 항목을 전체 공개로 둔 채 동의 대기 후보의 제목·요약·slug·id, 고르지 않은 비공개 과제 제목, 엠바고 과제 제목, 팀원의 이름·handle·id, 로그 본문·id, 과제 id가 공개 JSON·README 카드·이전 공개 프로필 DTO(E2E는 HTML·SSR payload·인쇄 보기까지)에 0건임을 봅니다.
- `posts`·`notes_and_studies`·`follow_lists` 설정은 지금 저장·판정만 됩니다. 이 항목을 실제로 보여 주는 활동 목록·팔로우 목록(S-04·S-05)이 같은 `canViewItem`을 거칩니다.

### 5. social 모듈 경계와 DB 역할

- 코드는 `server/modules/social/visibility.ts`입니다. 커뮤니티 모듈·테이블은 import하지 않고(S-02 import 그래프 테스트가 그대로 통과), 과제·학기·과목·엠바고·학교 인증 테이블은 커뮤니티 테이블이 아니므로 읽습니다. 프로젝트·엠바고 모듈을 import하지 않고 필요한 열만 직접 읽습니다(읽는 열 = 역할에 준 열).
- migration 0028이 `peerchive_apply_social_grants()`를 `CREATE OR REPLACE`로 넓히고 다시 부릅니다: `visibility_settings`·`project_listings`는 표 SELECT, `project_members(id, project_id, user_id, status)`·`projects(id, title, kind, course_term_id, embargo_until, study_name_mode)`·`course_terms(id, course_id, year, semester)`·`courses(id, title, merged_into)`·`embargoes(project_id, course_term_id, until, revoked_at)`·`institution_affiliations(user_id, school_id, status)`·`schools(id, merged_into)`는 **열 SELECT만**. 과제 설명·목표·멤버 역할·로그·파일·공개 후보·메일 해시·학과는 여전히 권한이 없습니다. 테스트가 `SET LOCAL ROLE peerchive_social`로 목록 경로(같은 기관 판정 포함)를 그대로 실행합니다.
- 탈퇴 정리(worker `purgeAccount`)는 페르소나를 지우기 전에 두 표의 그 사람 행을 지우고, 혼자 남은 과제를 지울 때는 그 과제 멤버십을 가리키는 목록 행(이미 나간 다른 멤버의 것)을 먼저 지웁니다.

### 6. 화면

- `/settings/visibility`(머리글 메뉴 "공개 범위", `/settings/personas`에서도 링크): 페르소나를 고르고 네 항목의 범위를 고릅니다(고를 수 없는 값은 목록에 없음, 기본값·적용 값 표시). 공개 사례·케이스 스터디는 여기서 바뀌지 않는다는 안내, 비공개 계정 안내, **표시명 프로필에 `같은 기관`을 고르면 소속 추정 경고**. 실명 프로필이면 아래에 과제 고르기(체크박스, 엠바고 중 안내, 익명·표시명 스터디 기록은 고를 수 없음).
- `/u/:handle`·`/print`에 "과제 수행 목록" 구역(과목 · 학기 · 제목, 엠바고 중이면 "제목 비공개 기간(엠바고)"). README 카드에도 같은 세 필드.

## 결과

- 시나리오 S의 코드 쪽 조건(전체 공개여도 동의 전 후보·비공개 과제·엠바고 제목·팀원·로그 0건, 목록은 세 필드, 설정 전후 과제 공간 접근 동일)을 통합 테스트·E2E(`s-visibility.spec.ts`)가 확인합니다. 정책 행렬은 도메인 단위 테스트(비로그인·로그인·같은 기관·승인된 팔로워·본인 × 다섯 단계, 비공개 계정, 기본값)가 봅니다.
- **타입 라우트 표**: 이 작업에서 화면의 `$fetch<T>(…)` 호출이 TS2589(타입 인스턴스화 한도)에 닿았습니다. 제네릭을 직접 주면 nitro의 요청 타입이 라우트 표 전체가 되어 라우트 수의 거의 제곱만큼 타입을 펼치는데, 라우트가 하나만 늘어도 넘는 경계였습니다. `nuxt.config.ts`의 `types:extend` 훅으로 화면이 부르지 않는 봇 전용 `/api/internal/**`를 타입 표에서 빼고(서버 라우팅은 그대로), 새 라우트 키를 둘(`…/visibility`, `…/project-listings`)로 줄였습니다(로그인 범위 목록은 새 라우트 대신 기존 `/profiles/:handle`에 실음). **여유가 거의 없어 S-04에서 라우트를 더하면 다시 넘을 수 있었습니다** — [ADR 0032](0032-empty-typed-route-table.md)에서 타입 라우트 표를 통째로 비워 해결했습니다(`/api/internal/**` 제외 훅을 대신함, 제네릭 없는 템플릿 URL 호출도 한도에 붙어 있었음).
- 열린 질문:
  - `follow_lists` 기본값(이 ADR은 private). 공개 계정의 팔로우 목록을 기본 공개로 둘지는 S-04에서 정합니다.
  - 운영 조치로 가린 과제(신고 숨김)를 목록에서 뺄 규칙: 지금 과제 단위 숨김이 없어 해당 없음. 생기면 `visiblePersonaProjects`에서 먼저 거릅니다(§8.3 "신고 숨김은 공개 범위보다 먼저").
  - 같은 기관 판정이 사람마다 두 번 학교 인증을 읽습니다. 팔로우 피드(S-05)처럼 여러 페르소나를 한 번에 판정할 때는 묶어 읽기가 필요합니다.
  - 목록에 올린 과제 제목을 나중에 바꾸면 다음 요청부터 새 제목이 보입니다(제목 고정 없음). 팀원이 제목을 바꿀 수 있는 팀 과제도 같습니다.

## 대안

- **페르소나를 만들 때 네 행을 채우기**: 조회는 단순하지만 기본값이 계정 공개 설정을 따라가지 않고(비공개 전환 때 행을 다시 써야 함), 기존 페르소나 backfill과 탈퇴 정리 대상이 늘어납니다.
- **비공개 계정이면 저장 자체를 거부**: 사용자가 공개로 돌아갈 때 이전 선택을 잃고, §8.3의 "제한"은 적용 시점의 규칙으로 충분합니다.
- **공개 경로에서도 쿠키를 읽어 판정**: 같은 URL의 응답이 보는 사람마다 달라져 공개 조회 공통 handler의 캐시·noindex·운영 스위치 가정(ADR 0012)이 깨지고, 보는 사람에 따라 다른 내용이 SSR payload에 섞입니다.
- **표시명 프로필에도 목록 허용(경고만)**: 팀원이 과목·학기·제목으로 바로 연결할 수 있어 S-02의 분리 목표와 맞지 않습니다. 개인 과제만 허용하는 절충도 팀 여부가 나중에 바뀔 수 있어 고르지 않았습니다.
- **새 라우트 `GET /profiles/:handle/projects`**: 깔끔하지만 위 타입 라우트 표 한도에 걸렸습니다. 같은 세션 경로인 기존 `/profiles/:handle`에 싣는 것으로 대신했습니다. (ADR 0032 뒤로는 이 제약이 없습니다.)
