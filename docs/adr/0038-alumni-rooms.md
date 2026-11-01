# 0038. 동문회·OB 방: 사용자 방 `template = alumni` + 방 안에서만 보이는 방별 프로필(실명 방은 이름 고정·표시명 방은 방별 이름·익명 방은 없음) + 자기 신고 배지(인증 배지는 읽을 때만 계산) + 기수 변경 이력 + 나가기·탈퇴·익명 전환 시 삭제

- 상태: 채택
- 날짜: 2026-11-01

## 맥락

A-01은 DELIVERY_PLAN §4.3 P2 백로그의 졸업생 공간 첫 항목입니다: "`template = alumni` 사용자 방, 방별 프로필이 방 밖·공개 프로필·PersonaActivity에 0건, 실명 방은 이름 고정, 기수 자기 신고와 운영진 수정 이력". 관련 설계와 앞선 결정:

- PROOFU_EVOLUTION_PLAN §8.9.9: 동문회·OB 방은 사용자 방(§8.9.4)의 템플릿. 방마다 다른 이름·사진(“12기 김지민”), 신분 배지 `현역`·`OB`·`n기`·`졸업생`, 기수는 자기 신고이고 운영진이 수정 가능. 이름 표시 기본값은 실명 또는 표시명이며 익명은 권장하지 않음.
- SYSTEM_DESIGN §6.7.2 RoomProfile: `space_id, user_id, display_name?, avatar_version_id?, badges[](current/ob/alumni/cohort), cohort_label?, bio?` — 방 멤버에게만 보이고 Persona·PersonaActivity·공개 프로필과 연결하지 않음. `real` 방은 이름 고정·사진·배지·소개만 방별, `display` 방은 이름도 방별, `anonymous` 방에는 만들지 않음. §6.7.2 "공간 종류 확장": 사용자 방에 `template(none/alumni)`.
- ADR 0019(공간·멤버십), 0020·0030(작성 시점 이름 표시 방식 고정, 표시명 = 표시명 페르소나, 계정 표시 이름을 커뮤니티에 쓰지 않음), 0021(커뮤니티 경계: 스키마 "커뮤니티" 구역의 표는 공개 경로가 읽지 않음), 0028·0029(페르소나, social 모듈·DB 역할은 커뮤니티 표에 닿지 않음 + 속성 기반 회귀 테스트), 0037 §1(P2 플래그 `alumni`, 꺼지면 404).

## 결정

### 1. 템플릿: `community_spaces.template` (migration `0034_alumni_rooms`)

- 새 enum `community_space_template(general, alumni)`, 열 `template not null default 'general'`. 설계 초안의 `none` 대신 `general`(“일반 방”)을 썼습니다. 기존 행은 모두 general입니다.
- check `community_spaces_template_check`: alumni는 `user_room`만(공식 페이지·스터디 방 불가). 새 enum 타입이라 `ALTER TYPE ADD VALUE` 문제는 없고, 그래도 check는 `::text`로 비교합니다.
- `POST /community/spaces {…, template?}`: `alumni`는 P2 `alumni` 플래그가 켜져 있을 때만(꺼져 있으면 **404** — 그런 값이 있는지도 드러내지 않음, ADR 0037 §1), 알 수 없는 값은 422. 이름 표시 방식은 그대로 만들 때 고르고, 화면은 alumni + 익명을 고르면 “동문 네트워킹에는 권장하지 않음”을 보여 줍니다(막지는 않음).
- **플래그가 꺼지면 기존 alumni 방은 일반 방처럼 동작합니다**: 응답의 `template`은 `general`(`effectiveTemplate`), 글·댓글에 방별 이름·배지를 붙이지 않고(고정한 표시명 페르소나 이름으로 돌아감), 방별 프로필 API는 404. 방 자체(게시판·멤버십)는 영향 없음. 행은 지우지 않으므로 다시 켜면 돌아옵니다.

### 2. 방별 프로필 `room_profiles`

- `(space_id, user_id)` 하나. 열: `display_name?`(1–30자), `badges text[]`(check: `current`·`ob`·`alumni`의 부분집합, 현역·OB 동시 불가), `cohort_label?`(1–20자), `bio?`(1–200자). **커뮤니티 구역**에 두어 C-05·S-02 경계 검사(스키마 머리말로 표 목록을 읽음)와 social DB 역할 권한 검사가 자동으로 덮습니다. social 역할에는 아무 권한도 주지 않습니다(`peerchive_apply_social_grants`는 표를 이름으로만 허용하므로 다시 정의하지 않음).
- 만들기·보기: alumni 방의 **active 멤버만**(`loadReadableSpace` → `canReadSpace`, 아니면 404 — 운영자도 멤버가 아니면 404). alumni 방이 아니면 404. **지금 효력이 있는** 이름 표시 방식(`nameModeNow`: 효력 시각이 지난 예약 포함)이 익명이면 409 `room_profiles_unavailable`.
- 이름 규칙:
  - `real` 방: 이름은 실명(`users.real_name`, 없으면 `실명 미입력`)으로 고정. `displayName`을 보내면 422 `name_fixed`. 배지·기수·소개만 방별입니다. 표시명 방에서 정한 방별 이름은 지우지 않고(방식이 다시 바뀌면 씀) 실명 방에서는 읽지 않습니다.
  - `display` 방: 방별 이름 **필수**(422 `required`). 실명 방에서 만든 뒤 표시명으로 바뀌어 이름이 없으면 `방별 이름 없음`.
  - `anonymous` 방: 방별 프로필이 없습니다. 방이 익명으로 바뀌면 worker의 이름 표시 방식 적용(`applyNameModeChange`)이 같은 트랜잭션에서 그 방의 프로필과 기수 이력을 지웁니다(되돌려도 살아나지 않음). 적용 전이라도 효력 시각이 지나면 API는 409, 글에는 붙이지 않습니다.
  - 계정 표시 이름(`users.display_name`)·핸들·페르소나 id는 어디에도 싣지 않습니다(ADR 0030). 응답은 사람 id 대신 방 안에서만 쓰는 `room_profiles.id`로 프로필을 가리킵니다.
- 사진(`avatar_version_id`)은 **이번 범위에서 미뤘습니다**. 올리려면 파일 검사·EXIF 제거·짧은 서명 URL(T-05·ADR 0007) 경로가 필요하고, 같은 파이프라인을 쓰는 A-02 앨범과 함께 붙이는 편이 맞습니다. 그 전까지 표에 열을 두지 않습니다.
- 저장은 전체 교체(`PUT …/room-profile`), 사용자당 시간당 30번, 보관·제한된 방은 409 `space_not_active`, 커뮤니티 쓰기 제한(C-06) 중이면 403 `write_restricted`(소개 글도 쓰기이므로). 지우기(`DELETE …/room-profile`)는 멱등이고 보관된 방에서도 됩니다.

### 3. 신분 배지

- **현역·OB·졸업생은 자기 신고**입니다(OB 문화의 신분은 Peerchive가 확인할 수 있는 사실이 아님). 기수 배지(`cohort`)는 저장하지 않고 기수가 있으면 응답에서 붙입니다(`displayBadges`).
- **사용자가 “인증” 배지를 고를 수는 없습니다**: 입력 배지는 세 값만(`cohort`·`verified` 등 그 밖의 값은 422). 대신 **학교를 연결한 방**에서 졸업생 배지를 고른 사람이 그 학교의 active 졸업생 인증(C-01 `standing = alumni`)이 있으면 읽을 때 `alumniVerified: true`를 붙입니다(저장하지 않으므로 인증이 해제되면 다음 요청부터 사라짐). 학교 무관 방에서는 계산하지 않습니다 — 그 방 멤버에게 다른 학교 인증 사실을 드러내지 않기 위해서입니다.

### 4. 기수와 변경 이력 `room_profile_cohort_changes`

- 기수는 자기 신고이고, **방장·운영진(admin)**이 `PUT …/room-profiles/:id/cohort {cohortLabel}`로 고칠 수 있습니다(모더레이터·멤버 403, 멤버가 아니면 404, 다른 방의 프로필 id 404).
- **모든 기수 변경**(본인이 바꾼 것 포함)을 `(space, subject, changed_by, from_label, to_label, created_at)`으로 남깁니다. 같은 값이면 남기지 않습니다(check `from is distinct from to`).
- 이력은 **방장·운영진과 본인만** 봅니다(`GET …/room-profiles/:id/cohort-history`, 그 밖 403). 운영자 화면은 따로 두지 않았고, 운영자는 감사 기록(`community.room_profile_cohort_edit`: 프로필 id·본인 여부·비움 여부만, 값 없음)으로 봅니다. 일반 멤버에게 숨긴 이유: 누가 누구의 기수를 고쳤는지가 방 안 갈등의 재료가 되고, 확인할 필요가 있는 사람은 본인과 운영진입니다.
- 이력의 바꾼 사람은 `subject`(본인)·`manager`(방장·운영진)·`unknown`(탈퇴)과, 그 사람의 이 방 프로필 이름(없으면 null)만 보입니다.

### 5. 글·댓글에서의 이름과 배지

- 작성자 표시(`resolveAuthorDisplay`)는 그대로 **글에 고정한 방식**(ADR 0020)만 봅니다. alumni 방(플래그 켜짐, 지금 익명 방이 아님)에서:
  - **표시명 글·댓글**: 작성자에게 방별 프로필이 있으면 그 **방별 이름**, 없으면 지금처럼 고정한 표시명 페르소나 이름.
  - **실명 글·댓글**: 실명 그대로(방별 이름은 쓰지 않음).
  - 둘 다 게시 중이면 `author.roomProfile {badges, cohortLabel, alumniVerified}`를 붙입니다. **익명 글에는 방별 프로필을 찾지도 않고**, 지운·가린 글과 탈퇴한 작성자에게는 붙이지 않습니다.
- 방별 이름은 읽을 때의 값입니다(표시명 페르소나 이름과 같은 규칙). 방을 나가면 프로필이 지워지므로 그 사람의 예전 표시명 글은 페르소나 이름으로 돌아갑니다.
- 같은 방 멤버는 한 글에서 방별 이름과(활동 카드가 있다면) 표시명 페르소나를 함께 볼 수 있습니다. 이것은 지금도 표시명 글이 페르소나 이름을 보여 주는 것과 같은 범위이고, 방 밖으로는 아무것도 나가지 않습니다(아래 6).

### 6. 경계: 방 밖에는 0건

- 방별 프로필은 커뮤니티 모듈(`server/modules/community/room-profiles.ts`)만 읽고 씁니다. 공개 프로필·README 카드·활동 목록·피드·추천·검색은 이 표를 읽지 않고, social DB 역할은 권한이 없습니다.
- S-02 속성 기반 테스트(`identity-boundary.integration.test.ts`)의 무작위 세계에 alumni 방과 고유 표식의 방별 이름·기수·소개를 넣고, 모든 페르소나의 공개 JSON·README 카드·예전 프로필 DTO·활동 목록(모든 보는 사람)·팔로우 목록·모든 사람의 피드·추천에 그 값과 프로필 id가 0건인지, 공개 검색 API와 `search_documents`에도 없는지 봅니다. social 역할 테스트는 `room_profiles`·`room_profile_cohort_changes`가 커뮤니티 표 목록에 있고 `SET ROLE`로 읽으면 거부되는지 봅니다. 별도 난수(시드 ^ 0xa01)를 써서 기존 세계는 바뀌지 않습니다.
- 감사 기록에는 id·종류·플래그만(이름·기수·소개 값 없음). 분석 이벤트는 더하지 않았습니다.

### 7. 삭제

| 일 | 방별 프로필 | 그 사람에 대한 기수 이력 | 그 사람이 바꾼 남의 기수 이력 |
|---|---|---|---|
| 방 나가기(`leaveSpace`)·내보내기(`removeMember`) | 같은 트랜잭션에서 삭제 | 삭제 | 그대로 |
| 내 프로필 지우기 | 삭제 | 삭제 | 그대로 |
| 방이 익명으로 바뀜(worker) | 그 방 전체 삭제 | 그 방 전체 삭제 | – |
| 탈퇴 정리(worker purge) | 삭제(`room_profiles`) | 삭제(`room_profile_cohort_changes`) | 행은 남기고 `changed_by`만 비움(`room_profile_cohort_actors`) |

- 기수는 그 사람의 자기 신고 정보라 그 사람이 떠나면 이력도 지웁니다. 남의 이력에서 바꾼 사람 칸만 비우는 것은 이름 표시 방식 변경 이력(C-03)과 같은 규칙입니다. 삭제 장부에는 종류별 개수만 남습니다(ADR 0016).
- 방 보관은 프로필을 지우지 않습니다(멤버는 보관된 방을 읽기만 함).

### 8. 화면

- `/community` 방 만들기: 플래그가 켜져 있을 때만 “방 종류”(일반·동문회·OB).
- `/community/s/:slug`: alumni 방(익명 아님)이면 멤버에게 “방별 프로필·신분 배지” 링크.
- `/community/room-profiles/:slug`: 내 프로필(실명 방은 이름 고정 안내, 표시명 방은 방별 이름), 배지(현역·OB는 하나만), 기수, 소개, 지우기. 멤버 목록(이름·배지·기수·소개), 방장·운영진은 기수 고치기, 방장·운영진·본인은 이력 보기. Nuxt 중첩 라우트를 만들지 않으려고 `/community/s/:slug` 아래가 아닌 별도 경로에 두었습니다(같은 `/community/**` 가드·noindex).
- 글 목록·글·댓글의 이름 옆에 배지(`RoomBadges`, 졸업생 인증은 `졸업생 인증`).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| 모든 새 경로 | – | 플래그 꺼짐 404, 401 |
| (기존) `POST /community/spaces {template}` | 201 | `alumni` + 플래그 꺼짐 404, 422 `template` |
| `GET /community/spaces/:slug/room-profiles` | 200 | 404(멤버 아님·alumni 아님), 409 `room_profiles_unavailable` |
| `PUT /community/spaces/:slug/room-profile` | 200 | 403 `write_restricted`, 404, 409 `space_not_active`·`room_profiles_unavailable`, 422 `displayName: required\|name_fixed\|too_long\|invalid`·`badges: invalid\|conflict`·`cohortLabel`·`bio`, 429 |
| `DELETE /community/spaces/:slug/room-profile` | 200(멱등) | 404 |
| `PUT /community/spaces/:slug/room-profiles/:id/cohort` | 200 | 403(방장·운영진 아님), 404, 409, 422 `cohortLabel` |
| `GET /community/spaces/:slug/room-profiles/:id/cohort-history` | 200 | 403(방장·운영진·본인 아님), 404, 409 |

## 결과

- 동문회·OB 방에서 멤버는 방마다 다른 이름(표시명 방)과 배지·기수·소개를 쓰고, 그 값은 방 안에서만 보입니다. 공개·소셜 출력에 0건인 것을 기존 S-02 속성 테스트가 함께 지킵니다.
- 플래그를 끄면 새 경로가 404이고 기존 alumni 방은 일반 방처럼 보입니다.
- 한계: 배지는 자기 신고라 거짓 신고를 막지 못합니다(사칭은 신고로 — 방별 프로필은 아직 신고 대상이 아니고, 글·댓글 신고와 방 운영진의 기수 수정으로 대응). 졸업생 인증 표시는 학교 연결 방에서만입니다. 기관(I-02)의 기수 방과 `institution_cohorts` 연결은 I-02에서 정합니다. 사진은 A-02와 함께.

## 대안

- **방별 프로필을 페르소나의 한 종류로**: 페르소나 테이블·활동 투영·공개 프로필 경로와 섞여 S-02 경계가 흐려집니다. 커뮤니티 표로 두었습니다.
- **배지를 모두 저장(`cohort` 포함)·인증 배지 저장**: 기수와 배지가 어긋날 수 있고, 인증 상태가 바뀌어도 남습니다. 기수 배지는 기수에서, 인증 표시는 읽을 때 계산합니다.
- **기수 이력을 모든 멤버에게**: 투명하지만 기수 수정이 방 안 다툼의 재료가 됩니다. 본인과 방장·운영진으로 충분합니다.
- **나간 사람의 기수 이력을 남기고 익명화**: 남은 행이 “누군가의 기수가 n기였다”를 계속 말합니다. 그 사람의 자기 신고 정보라 지웁니다.
- **익명 방에서도 배지만 보이기**: 소규모 방에서 기수·배지가 익명을 깨뜨립니다(§6.7 소규모 익명 방 규칙과 같은 이유). 익명 방에는 아무것도 없습니다.
- **실명 방에서도 방별 이름 허용**: 실명 방의 의미(실명으로 쓴다)를 깨뜨립니다. 설계대로 이름은 고정했습니다.
