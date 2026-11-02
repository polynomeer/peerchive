# 0056. GitHub App 연동: 설정 여섯 개가 모두 있을 때만 켜짐(`features.github`, 플래그 아님) + OAuth App이 아니라 GitHub App(저장소 단위 설치·읽기 권한) + 회원 계정은 user-to-server OAuth로 GitHub 사용자 번호·로그인 이름만(토큰·메일 저장 없음) + 설치 id는 믿지 않고 설치한 사용자의 접근을 OAuth로 확인한 교집합 저장소만 고르기(과제당 하나, 저장소도 한 과제에만) + 일회용 state(해시만 저장·사용자/과제에 묶임·10분·한 번만) + 웹훅 서명(원문 바이트·상수 시간)·본문 1MB·전달 id 7일 재사용 거부·멱등 수집·끊는 이벤트는 API로 재확인 + 커밋·PR은 최소 필드의 **근거 후보**(자동 확정·집계 없음, 멤버만) + 선언 근거 `github`(주소·제목 복사, 해제 뒤 링크만 남음) + 공개 스냅샷 0건·로그 링크로 직접 붙인 비공개 저장소 주소만 공개 전 점검 `github_private` 경고 + 설치 토큰은 메모리에만·해제 때 폐기, migration 0051

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

E-11은 DELIVERY_PLAN §4.4 P1 보완 백로그 항목입니다: "저장소 단위 설치·과제 공간 연결, 커밋·PR을 기여 장부 근거 후보로(자동 확정 없음), 웹훅 서명 검증·재전송 방지, 연결 해제 시 토큰 폐기, 비공개 저장소 내용은 공개 스냅샷에 자동 포함 안 됨". 제품 기획 §7(기여 장부 — 자동 수집에 "(연동 시) 커밋·PR")과 §16, 위험 표의 "외부 API 의존 — 링크 우선, adapter·retry, 연동 없이도 사용 가능"(§9)이 기준입니다. 예산이 부족하면 먼저 미루는 항목(§9 1인 개발 지연)이지만 기능 자체는 구현해 두고 설정이 없으면 꺼진 상태로 둡니다. 관련 결정:

- ADR 0008(역할 선언·확인·근거 — 근거는 revision에 고정, 자기 확인 금지, 점수·비율 없음), 0009(디스코드: 일회용 코드 해시, 외부 id만 저장, 내부 API HMAC + nonce 재사용 거부 + 64KB 본문 상한), 0011(공개 스냅샷 허용 목록 — `buildPublicSnapshot`만 공개 데이터를 만듦, 공개 전 점검은 경고), 0016(탈퇴 정리·삭제 장부), 0026(익명 스터디 기록), 0055(E-05 — 기능 플래그가 아니라 외부 공급자 설정이 있을 때만 켜짐).
- `integrations.provider` enum에는 T-09부터 `github` 값이 있었지만 쓰지 않았습니다.

## 결정

### 1. 켜짐 = GitHub App 설정(플래그 아님)

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`(PEM, `\n` 이스케이프 허용), `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`이 **모두** 있고 RSA 키를 읽을 수 있을 때만 켜집니다. 사용자 확인(user-to-server OAuth)에 client id·secret이 필요해 요청의 네 값에 둘을 더했습니다.
- 일부만 있거나 키를 읽을 수 없으면 꺼짐 + 경고 한 줄(값 없음). production에서 웹훅 비밀이 32자 미만이면 꺼짐.
- 꺼지면 새 경로 모두 404(웹훅 포함), `GET /api/v1/features`의 `github: false`, 프로필 설정·과제 화면에 GitHub 칸이 없습니다. 역할 선언·기여 장부·공개는 한 줄도 달라지지 않습니다.

### 2. OAuth App이 아니라 GitHub App, Octokit 없이

- GitHub App은 저장소를 골라 설치하고(조직·개인), 권한이 저장소 단위로 좁고, 설치 토큰이 1시간짜리입니다. 권한: Repository **Metadata: read**(필수), **Contents: read**(push 웹훅), **Pull requests: read**. 이벤트: Push, Pull request, Repository. 설치·설치 저장소·권한 철회 이벤트는 GitHub App이 항상 보냅니다.
- 앱 JWT(RS256, `iat` 60초 전, `exp` 9분 뒤, `iss` 앱 id)와 웹훅 HMAC은 `node:crypto`만, API는 `fetch`만 씁니다. 필요한 호출이 여덟 개(설치 조회·설치 토큰·설치 저장소·OAuth 교환·사용자·사용자 설치 저장소·사용자 토큰 폐기·설치 토큰 폐기)뿐이라 Octokit(런타임 의존성 여러 개)을 들이지 않습니다. 요청마다 10초 제한, 오류 메시지는 호출 이름과 상태 코드만.
- 설치 토큰은 **메모리에만** 캐시하고(만료 5분 전까지) DB·로그에 남기지 않습니다. 사용자 토큰은 콜백 한 번 안에서만 쓰고 바로 `DELETE /applications/{client_id}/token`으로 폐기합니다. 저장하는 GitHub 비밀은 없습니다.

### 3. 회원 GitHub 계정(누구의 커밋인가)

- 커밋 메일로 맞추는 방법은 메일을 저장·비교해야 하고 위조가 쉬워 쓰지 않습니다. 회원이 프로필 설정에서 "GitHub 계정 연결" → GitHub 사용자 인증 → 콜백에서 `GET /user`로 **GitHub 사용자 번호와 로그인 이름만** 읽어 `integrations`(provider `github`, `external_id` = 번호, 새 열 `external_login`)에 한 행. 한 GitHub 계정은 한 회원에만(409 `github_account_in_use`), 회원은 계정 하나(바꾸면 교체).
- 해제는 행 삭제(디스코드의 `revoked_at`과 달리 남길 이유가 없음). GitHub 쪽 앱 권한은 GitHub 설정에서 철회하고, 철회하면 `github_app_authorization` 웹훅으로 연결 행을 지웁니다.

### 4. 저장소 연결 흐름과 일회용 state

1. owner가 "GitHub 연결" → state(`install`, 과제에 묶임) + `github.com/apps/<slug>/installations/new?state=`.
2. GitHub → Setup URL `GET /api/v1/github/setup?installation_id&state` → state 확인 → **installation id를 믿지 않고** 새 state(`install_verify`, 설치 id 포함)로 사용자 인증에 보냄. 조직 승인 대기(`setup_action=request`)면 과제 화면에 안내.
3. OAuth 콜백 → 사용자 토큰으로 `GET /user/installations/{id}/repositories`(그 사람이 그 설치에서 접근할 수 있는 저장소)와 설치 토큰으로 `GET /installation/repositories`의 **교집합**만 고르기 목록(state `select`, 30분, 저장소 id·이름·주소·비공개 여부)에 저장 → 토큰 폐기. 남의 설치 id를 주소에 넣어도 사용자가 접근할 수 없으면 403 `installation_not_accessible`(설치 확인은 회원 계정 연결과 별개).
4. `POST /projects/:id/github/link {repoId}` → 목록에 있는지 + **지금도** 설치에 있는지 다시 확인 → `github_repo_links`(과제당 연결 하나, 저장소도 연결 중인 과제 하나 — partial unique, 409 `already_linked`·`repo_in_use`).
- state(`github_oauth_states`)는 CSPRNG 32바이트 원문을 GitHub로 보내는 주소에만 싣고 `sha256('github-state:'+원문)`만 저장합니다. 서명한 값 대신 서버에 저장한 무작위 값이라 위조할 수 없고 `used_at`으로 한 번만 쓰입니다. 돌아온 요청의 로그인 사용자가 만든 사람과 다르면 쓰지 않고 실패(만든 사람은 다시 쓸 수 있음). 10분(고르기 30분) 만료. 실패는 화면 이동으로 짧은 이유 코드만 주소에 싣습니다(`?github=error:<code>`).
- 과제당 저장소 하나로 정했습니다. 팀 과제는 대개 저장소 하나이고, 여럿이면 후보 목록·공개 점검·해제 규칙이 복잡해집니다. 필요하면 unique 인덱스를 풀어 넓힐 수 있습니다.
- 스터디 기록(kind = study)은 익명 이름(ADR 0026)과 GitHub 로그인이 맞지 않아 쓰지 않습니다(404).

### 5. 웹훅

- `POST /api/github/webhook`(`/api/v1` 밖 — Origin CSRF 검사 없음, 세션 무시). 순서: 꺼짐 404 → 본문 1MB(선언 길이·실제 길이, 서명 전) 413 → `X-Hub-Signature-256`을 **받은 원문 바이트**로 상수 시간 비교(없음·틀림 401, 이유 구분 없음) → `X-GitHub-Delivery` GUID 형식(422) → 전달 id를 `github_webhook_deliveries`에 넣어 이미 있으면 409 `replayed`(7일 기억).
- 전달 id는 처리와 **같은 트랜잭션**에 넣습니다. 처리(또는 API 재확인)가 실패하면 기록이 남지 않아 GitHub의 재전달(같은 GUID)을 다시 받습니다.
- 전달 id는 서명 밖 헤더라 같은 본문을 새 id로 다시 보낼 수 있습니다. 그래서 수집은 멱등(커밋 SHA·PR 번호 unique, PR은 더 새 `updated_at`만 반영)이고, 연결을 **끊는** 이벤트(`installation` deleted·suspend, `installation_repositories` removed, `repository` deleted)는 GitHub API로 지금 상태를 다시 확인한 뒤에만 반영합니다. `github_app_authorization` revoked는 확인할 수단이 없어 그대로 반영합니다(잘못 지워져도 회원이 다시 연결하면 됨).
- 연결되지 않은 저장소, 설치 id가 연결과 다른 이벤트는 저장하지 않고 200 `ignored`.

### 6. 최소 데이터: 근거 후보(`github_items`)

- 커밋: SHA, 메시지 **첫 줄**(제어 문자 제거, 200자), 주소, 시각, 작성자 GitHub 번호. PR: 번호, 제목 첫 줄, 주소, 작성자 번호, 상태(open·closed·merged), 열린 시각, `updated_at`. 파일 목록·diff·본문·메일·작성자 이름은 받는 즉시 버립니다.
- push 커밋의 작성자: `author.username`이 보낸 사람(sender)이면 그 번호, 아니면 GitHub 계정을 연결한 회원의 로그인 이름(대소문자 무시)으로 찾습니다. 맞출 수 없는 커밋은 저장하지 않습니다. distinct 커밋만, push당 100개까지.
- 과제 멤버(읽기 전용 포함)만 봅니다(비공개 저장소 제목 포함, 비멤버 404). 멤버마다 그 사람 GitHub 계정이 작성한 최근 30개(`GET /projects/:id/github/items`). 계정을 연결하지 않은 멤버는 빈 목록.

### 7. 기여 장부: 후보는 근거가 아니라 재료

- 후보는 자동으로 선언·확인·집계되지 않습니다(장부 개수·리포트·주간 요약에 넣지 않음). 본인이 역할 선언의 근거로 고를 때만 근거가 됩니다: `evidence: [{kind:'github', id}]` — 지금 연결된 저장소의 같은 과제 후보이고 **작성자가 선언하는 사람의 GitHub 계정**일 때만(아니면 422 `not_found`). 고를 때 주소·제목을 `claim_evidence.github_url`·`github_title`에 복사하고 `github_item_id`로 후보를 가리킵니다. 확인은 다른 근거와 같이 팀원이 합니다(ADR 0008).
- 로그에는 학생이 주소를 링크(`links`)로 직접 붙입니다(과제 화면 후보 목록의 "주소 복사"). 로그 링크는 학생이 고른 주소·제목이므로 공개 대상이 될 수 있는 유일한 GitHub 유래 값입니다.
- 이어받기: 선언 수정에서 근거를 생략하면 이전 GitHub 근거를 그대로 이어받고, 명시할 때는 `{kind:'github', url}`로 **이전 revision에 있던 주소만** 다시 넣을 수 있습니다(새 주소를 직접 넣는 경로 없음).

### 8. 해제와 탈퇴

- owner의 저장소 해제(`DELETE /projects/:id/github`): 연결 행에 해제 시각·이유(`owner`), 그 연결의 후보 행 삭제, 선언 근거의 `github_item_id`만 비움(주소·제목은 남아 "링크만 남은 근거"), 다른 연결이 쓰지 않는 설치의 메모리 토큰 폐기(`DELETE /installation/token`). 앱 설치 자체는 다른 과제·사람이 쓸 수 있어 GitHub에서 owner가 지웁니다. 해제 뒤 같은 저장소의 이벤트는 무시됩니다.
- 설치 제거·정지·저장소 제외(확인된 경우)는 같은 정리를 이유 `uninstalled`·`repo_removed`로(행위자 없는 감사 기록).
- 연결 행은 지우지 않고 남깁니다(저장소 이름·주소·비공개 여부만). 공개 전 점검이 "예전에 연결했던 비공개 저장소 주소"도 알아보게 하기 위해서입니다.
- 탈퇴 정리(worker purge): 그 사람 GitHub 번호가 작성한 후보 전부(다른 과제 포함, 선언 근거 참조는 비움)·일회용 state·계정 연결 행 삭제, 혼자만 쓴 과제는 후보·연결·state까지 삭제. 삭제 장부 종류 `github_items`·`github_oauth_states`.

### 9. 공개: 자동 포함 0건, 직접 붙인 비공개 주소는 경고

- `github_items`와 선언의 GitHub 근거는 공개 스냅샷 허용 목록(ADR 0011) 밖입니다. 스냅샷의 선언 근거에는 로그·파일만 나갑니다(회귀 테스트: 표식 문자열을 넣은 GitHub 근거가 스냅샷에 0건).
- 공개 전 점검에 규칙 `github_private`를 더합니다: 공개될 로그 링크·글이 이 과제에 연결했던(지금·이전) **비공개** 저장소 주소(그 자체 또는 아래 경로)를 가리키면 경고(표본은 `owner/repo`). 다른 점검처럼 게시를 막지 않고 학생이 판단합니다. 공개 저장소로 바뀌면(`repository` publicized) 다음 후보부터 경고하지 않습니다.

### 10. 경로

| 경로 | 권한 | 설명 |
|---|---|---|
| `GET /api/v1/me/integrations/github` | 로그인 | `{linked, login, linkedAt}` |
| `POST /api/v1/me/integrations/github/link` | 로그인 | 201 `{url}`(사용자 인증 주소) |
| `DELETE /api/v1/me/integrations/github` | 로그인 | 204 |
| `GET /api/v1/projects/:id/github` | 멤버 | 연결·owner의 고르기 목록·내 계정 연결 여부 |
| `POST /api/v1/projects/:id/github/install` | owner | 201 `{url}`(앱 설치 주소) |
| `POST /api/v1/projects/:id/github/link` | owner | `{repoId}` |
| `DELETE /api/v1/projects/:id/github` | owner | 204 |
| `GET /api/v1/projects/:id/github/items[?mine=1]` | 멤버 | 멤버별 후보 |
| `GET /api/v1/github/setup` | 로그인 | GitHub App Setup URL(302) |
| `GET /api/v1/github/oauth/callback` | 로그인 | GitHub App Callback URL(302) |
| `POST /api/github/webhook` | 서명 | 웹훅 |

감사 기록 `github.identity_link|identity_unlink|repo_link|repo_unlink`(연결 id·저장소 번호·비공개 여부·이유만, 이름·주소·토큰 없음).

## 결과

- GitHub App을 등록하고 설정 여섯 개를 넣으면 owner가 과제 화면에서 저장소 하나를 연결하고, 각 회원이 GitHub 계정을 연결하면 자기 커밋·PR이 근거 후보로 보입니다. 후보는 본인이 골라야 근거가 되고 팀원이 확인해야 확인 상태가 됩니다. 비공개 저장소의 제목은 팀 밖으로 나가지 않고, 학생이 로그 링크로 붙인 주소만 공개 전 점검이 경고합니다.
- migration `0051_github_app`(enum 3, 테이블 4: `github_oauth_states`·`github_repo_links`·`github_items`·`github_webhook_deliveries`, `integrations.external_login`, `claim_evidence.github_item_id`·`github_url`·`github_title`과 종류 check 교체). 새 npm 의존성 없음.
- 테스트: web 단위(설정 해석·JWT 검증·서명·fetch 요청 모양·토큰 캐시·폐기·이벤트 해석), web 통합(state 만료·한 번만·사용자 결속, 설치 확인 교집합·위조 설치 id 거부·연결 시 재확인, 웹훅 서명 있음·없음·틀림·본문 상한·재사용 거부·미연결 무시·최소 필드·작성자 맞춤·PR 상태 순서·설치 제거 재확인·권한 철회, 근거 후보 첨부·남의 것 거부·해제 뒤 링크만·스냅샷 0건·`github_private` 경고), 스냅샷 허용 목록 표식, domain(`findPrivateRepoRefs`), worker 탈퇴 정리, E2E `e11-github.spec.ts`(설정 없는 기본 서버에서 404·진입점 없음).
- 한계: push 페이로드에는 커밋 작성자 번호가 없어 username으로 맞추므로, GitHub가 메일을 계정에 맞추지 못한 커밋(username 없음)은 후보가 되지 않습니다. 연결 전·계정 연결 전에 보낸 사람이 아닌 작성자의 커밋은 나중에 계정을 연결해도 소급되지 않습니다(백필 없음). GitHub Enterprise Server는 지원하지 않습니다(`github.com` 주소만). 설치 토큰 메모리 캐시는 프로세스마다라 여러 인스턴스면 각자 받습니다. `github_app_authorization` 재전송으로 회원 연결이 지워질 수 있습니다(재연결로 복구).

## 대안

- **OAuth App**: 권한이 사용자 전체 저장소(`repo` scope)라 너무 넓고 웹훅을 저장소마다 따로 달아야 합니다.
- **커밋 메일로 회원 맞추기**: 연결 단계가 없지만 메일을 저장·비교해야 하고 커밋 메일은 아무나 적을 수 있습니다.
- **Setup URL의 installation id를 그대로 믿기**: 한 단계 줄지만 남의 설치 id를 넣어 그 조직 저장소의 웹훅 데이터를 받을 수 있습니다.
- **서명한 stateless state(HMAC + 만료)**: DB가 필요 없지만 "한 번만"을 보장하려면 결국 사용 기록이 필요합니다.
- **사용자 토큰 저장 후 재사용**: 설치 저장소 재확인이 쉬워지지만 장기 비밀을 저장하게 됩니다(설치 토큰으로 충분).
- **후보를 기여 장부 개수에 자동 집계**: "커밋 수 = 기여"라는 점수화가 되고 ADR 0008의 원칙(점수·비율 없음, 본인 선언 + 팀원 확인)과 맞지 않습니다.
- **해제 때 선언 근거까지 삭제**: 깨끗하지만 이미 팀원이 확인한 선언의 근거가 조용히 사라집니다. 주소·제목만 남깁니다.
- **Octokit**: 재시도·페이지 처리가 들어 있지만 호출 여덟 개에 비해 의존성이 크고 E-05처럼 `fetch` 어댑터로 충분합니다.
