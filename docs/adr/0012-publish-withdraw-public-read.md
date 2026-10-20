# 0012. 게시·철회·익명 공개 조회: 트랜잭션 재검사 + 요청마다 DB 상태 확인(no-store) + 운영 스위치

- 상태: 채택
- 날짜: 2026-10-20

## 맥락

T-12는 게시·철회·익명 공개 조회와 파생 데이터 차단입니다(DELIVERY_PLAN T-12: "트랜잭션 재검사, 철회 직후 익명 조회·파일·검색 차단", 시나리오 D·E·I). 처음으로 로그인하지 않은 사람에게 데이터를 내주는 기능입니다. 지켜야 할 불변조건(SYSTEM_DESIGN §1):

1. 공개 경로는 승인된 release 스냅샷만 읽습니다.
3. 엠바고 중인 과제의 게시 요청은 서버가 거부합니다.
4. 동의가 철회되면 공개 사례·파일·검색 등이 차단되고, 읽기 경로는 상태를 먼저 확인하므로 파생 데이터 정리가 늦어도 노출되지 않습니다.

그 밖에: 게시 트랜잭션에서 권한·참여·동의·파일 clean·엠바고·보류를 다시 검사하고 낡은 후보는 409(§7.2), 게시는 owner만·대리 게시 없음, 당사자는 자기 동의 철회(§8), 공개 파일은 release 활성 상태를 확인한 뒤 짧게만 제공(§10), 캐시 키에 version·access_epoch(§11), 권한 누출 때 공개 읽기 전체를 막는 운영 스위치(§14), 철회는 언제든·내려받은 사본은 회수 불가 안내(PROOFU_EVOLUTION_PLAN §9.3).

## 결정

### release와 상태

- ADR 0011대로 별도 release 테이블 없이 **게시한 후보 행이 release**입니다. 추가 열: `publication_candidates.release_no`(공개 안 1부터, "공개 버전 vN")·`published_at`·`replaced_at`·`withdrawn_at`, 후보 상태 `replaced`. `publications.access_epoch`(0부터)·`first_published_at`·`withdrawn_at`·`withdraw_cause`(owner/consent_revoked)·`withdraw_note`. 공개마다 `status = 'published'`인 후보는 하나(부분 unique), `(publication_id, release_no)` unique. migration `0010_publish_withdraw`.
- `current_release_id`는 마지막으로 게시한 release를 가리키고 철회 뒤에도 이력으로 남습니다. 공개 조회는 "공개 published + 그 release published + current + 엠바고 없음"일 때만 내줍니다(도메인 `canServePublicRelease`).
- **게시 중 다음 버전**: 게시 중인 공개에도 후보를 만들 수 있습니다(새 도메인 이벤트 `republish`: published → published, publish와 같은 전제 조건). 공개 상태는 published로 남고, 새 버전을 게시하기 전까지 지금 release를 계속 제공합니다. 게시하면 이전 release는 `replaced`(내용·파일 제공 중단)입니다. 제한됨(T-15)은 계속 409 `publication_locked`.
- **slug 고정**: 한 번 게시한 공개는 slug를 바꿀 수 없습니다(422 `slug: locked`). 퍼진 링크가 다른 사례를 가리키지 않게 합니다.
- **탈퇴·정지한 당사자**: 그 동의는 granted라도 유효하지 않습니다(ready·게시 모두, 후보 blocker `subject_inactive`). 이미 게시된 release를 탈퇴 때 자동 철회하는 규칙은 열린 질문입니다.

### 게시 `POST /candidates/:id/publish {manifestHash, idempotencyKey?}`

- owner만(editor 이하 403, 비멤버 404). 한 트랜잭션에서 프로젝트 → 공개 → 후보 순서로 행을 잠그고 다시 검사: 멤버십·역할 → 후보가 열려 있음(409 `superseded`) → 요청 해시 = 후보 해시(409 `stale_manifest`) → `assertPublishable`(409 `embargo_active`) → ready 재계산(`refreshReadiness`) → 도메인 `publish`/`republish` 전이(모든 당사자 granted(현재 해시·active 계정), 스냅샷의 모든 파일(고른 파일 + 마일스톤 스냅샷)이 **지금** clean, 열린 보류 없음 — 보류는 T-15까지 없음). 깨지면 409 `publish_blocked` + `blockers[]`(방금 계산한 값)와 `candidateStatus`. 실패한 시도는 아무것도 남기지 않습니다(rollback).
- 성공: 후보 → published(`release_no` = 최대 + 1, `published_at`), 이전 published → replaced, 공개 → published·`current_release_id`·`level`·`access_epoch + 1`·`first_published_at`(처음만)·철회 정보 비움, outbox `publication.published`, 감사 `publication.publish`. 응답 200 `{publication, release, idempotent: false}`.
- **idempotent**: (후보, manifest 해시)가 자연 키입니다. 이미 그 후보가 지금 release로 게시되어 있으면 아무것도 바꾸지 않고 200 `idempotent: true`. `idempotencyKey`는 받기만 하고 저장하지 않습니다(같은 후보·해시면 키가 달라도 같은 결과). 철회·대체된 release는 다시 게시할 수 없고(409 `superseded`) 새 후보를 만들어야 합니다.

### 철회

- owner 철회 `POST /publications/:id/withdraw {reason?}`(300자): 공개 → withdrawn(도메인 `withdraw`), 지금 release → withdrawn, 열려 있던 다음 버전 후보 → superseded, `access_epoch + 1`, outbox `publication.withdrawn`, 감사 `publication.withdraw`를 **한 트랜잭션**에. 이미 철회됐으면 그대로 200, 게시된 적 없으면 409 `not_published`.
- 동의 철회 `POST /publications/:id/consents/revoke {note?}`: 지금 release의 당사자 본인(나간 멤버 포함, 당사자 아닌 멤버 403 `not_subject`, 그 밖에는 404). 동의 → revoked, 게시 중이면 같은 트랜잭션에서 철회(원인 `consent_revoked`). 보류(restricted) 대신 철회를 고른 이유: 공개를 바로 닫는 것이 가장 단순하고 안전하며, owner의 다음 행동(새 후보)이 같습니다.
- 다시 공개: owner가 철회된 지금 release에서 `exclude-declined`를 쓰면 거절·철회한 사람의 자료를 뺀 새 후보가 생깁니다(ADR 0011의 이어받기 규칙 그대로: 자기 관련 부분이 같은 granted만 이어받음). 공개 상태는 `start_new_candidate` → `create_candidate`로 갑니다.
- `GET /me/publication-consents`: 내가 동의해 지금 게시 중인 공개(화면 `/consents`의 "내 동의 철회").

### 익명 공개 조회

- `GET /api/v1/public/publications/:slug` → `{slug, level, version, publishedAt, firstPublishedAt, snapshot}`. snapshot은 저장된 값 그대로(사후 작성 표시 포함). 공개·후보·프로젝트 id, 동의·철회 정보는 싣지 않습니다.
- `GET /api/v1/public/publications/:slug/artifacts/:versionId` → 그 버전이 **지금 release 스냅샷**에 있고 지금도 clean이며 같은 프로젝트 파일일 때만 스트림(도메인 `canServePublicArtifact`). 같은 프로젝트의 clean 파일이라도 스냅샷에 없거나 이전 release에만 있으면 404. 파일 이름은 스냅샷의 공개 표시 이름(원래 이름 아님).
- **매 요청 DB 확인**: 공개·release 상태, 엠바고, 파일 검사 상태를 요청마다 읽습니다. 메모리·HTTP 캐시가 없으므로 철회·대체 커밋 직후 다음 요청부터 404이고, worker가 멈춰도 같습니다(테스트는 같은 트랜잭션 안에서 확인). **게시 뒤에 걸린 엠바고도 공개 조회를 막습니다.**
- 내줄 수 없는 모든 경우는 같은 404(`not_found`)입니다. 이유(철회·엠바고·없음)를 드러내지 않습니다.
- 공개 조회 비공개 테이블 접근은 정책 판정용 행(공개·후보 행, 엠바고 계산용 프로젝트·학기·엠바고, 파일 버전 상태)뿐이고, 로그·선언 등으로 DTO를 다시 만들지 않습니다.

### 쿠키·세션

- 세션 미들웨어는 `/api/v1/public/**`를 건너뜁니다. 쿠키를 읽지 않고, 무효 쿠키를 지우거나 sliding 연장도 하지 않으므로 응답에 `Set-Cookie`가 없고 로그인 여부와 무관하게 같은 응답입니다.
- 공개 페이지 `/p/[slug]`(SSR)는 `public` 레이아웃(로그인 상태를 읽지 않음)을 쓰고, auth 플러그인은 `/p/**`에서 `/api/v1/me`를 부르지 않습니다. 그래서 로그인한 사람이 열어도 HTML·payload에 이메일·이름이 들어가지 않습니다(스모크 테스트로 확인). 페이지는 쿠키를 넘기지 않는 `$fetch`로 공개 API만 부르고 `PublicSnapshotView`로만 그립니다. 다른 화면으로 옮기면 그때 클라이언트에서 로그인 상태를 확인합니다.

### 캐시·헤더

| 대상 | 헤더 |
|---|---|
| 공개 JSON | `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`(기본) |
| 공개 파일 | 위 + 판별한 `Content-Type`, `Content-Security-Policy: sandbox; default-src 'none'`, `Content-Disposition`(이미지 inline·PDF attachment, 공개 표시 이름), `Cross-Origin-Resource-Policy: same-origin`, `ETag: "pe<access_epoch>-r<release_no>-<sha256 앞 16자>"`, `X-Robots-Tag`는 항상 noindex |
| 공개 페이지 HTML | `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, robots meta·`X-Robots-Tag` noindex(기본), 오류 시 404/503 상태 |
| 운영 스위치 503 | `Cache-Control: no-store`, `Retry-After: 300`, 본문 `public_reads_disabled` |

- **no-store를 고른 이유**: `public, max-age=0, must-revalidate`는 공유 캐시가 저장한 뒤 재검증하는 방식이라 조건부 요청 처리와 CDN 동작을 함께 검증해야 하고, `private, max-age=60`은 철회 뒤에도 브라우저가 60초 동안 파일을 다시 보여 줄 수 있습니다. 파일럿 규모에서는 매 요청 DB 확인 비용이 작으므로 "철회가 즉시 우선"을 택했습니다. ETag에 access_epoch·공개 버전을 넣어 두었으므로 나중에 짧은 캐시를 켜더라도 철회·새 버전이 캐시 키를 바꿉니다.
- **색인**: 파일럿 동안 기본 noindex. `PEERCHIVE_PUBLIC_INDEXING=1`이면 공개 JSON·페이지에서 noindex를 뺍니다(파일은 항상 noindex).
- Open Graph는 스냅샷의 제목·요약(160자)만 씁니다. 이미지는 없습니다.

### 운영 스위치

- `PEERCHIVE_PUBLIC_READS_DISABLED=1`(true/yes/on): `/api/v1/public/**`가 DB를 건드리지 않고 503 `public_reads_disabled`(서버 미들웨어, handler에서도 한 번 더 확인). 공개 페이지는 503과 "잠시 볼 수 없음" 안내. 요청마다 환경 변수를 읽지만, 실제로 바꾸려면 프로세스 환경을 바꿔 재시작해야 합니다(DB 플래그·관리 화면은 T-15).

### 파생 데이터

- 철회는 DB 상태를 먼저 바꾸고 같은 트랜잭션에 outbox `publication.withdrawn {publicationId, projectId, releaseId, releaseNo, accessEpoch, cause}`를 남깁니다. worker가 같은 이름의 큐로 받아 등록된 정리 handler(`registerDerivedCleanup`: 검색 색인·과목 집계 T-13, 포트폴리오·케이스 T-14)를 실행하고 감사 `publication.derived_cleanup`을 (공개, access_epoch)마다 한 번 남깁니다(advisory lock + 기존 기록 확인으로 중복 전달에도 하나). 지금은 파생 데이터가 없어 handler가 없고 감사만 남습니다.
- `publication.published`도 큐를 두고 등록된 `onPublished` handler를 부릅니다(지금은 없음, T-13 색인용).
- 읽기는 worker에 기대지 않습니다. 정리 handler는 "보이지 않게"가 아니라 "남은 사본 지우기"이고, 늦거나 실패해도 공개 읽기는 이미 막혀 있습니다(§14 철회 목표: DB 변경 즉시 차단, 파생 정리 5분).

### 상태 코드 요약

| 경로 | 성공 | 오류 |
|---|---|---|
| `POST /candidates/:id/publish` | 200(재시도도 200 `idempotent`) | 403, 404, 409 `superseded`·`stale_manifest`·`embargo_active`·`publish_blocked`(+blockers)·`publication_locked`, 422 |
| `POST /publications/:id/withdraw` | 200(이미 철회도 200) | 403, 404, 409 `not_published`, 422 |
| `POST /publications/:id/consents/revoke` | 200(이미 철회도 200) | 403 `not_subject`(멤버), 404, 422 |
| `GET /me/publication-consents` | 200 | 401 |
| `GET /public/publications/:slug` | 200 | 404, 503 `public_reads_disabled` |
| `GET /public/publications/:slug/artifacts/:versionId` | 200 | 404, 503 |
| `POST /projects/:id/publication-candidates` | 201 | (ADR 0011) + 422 `slug: locked`, 게시 중이면 허용·제한됨 409 `publication_locked` |

## 결과

- 철회는 한 행의 상태 변경으로 즉시 효력이 생기고, 캐시 무효화·worker 성공에 기대지 않습니다. 대신 공개 조회마다 DB 쿼리 3–4개(공개+release, 엠바고, 파일)가 듭니다. 트래픽이 커지면 access_epoch를 키로 짧은 캐시(≤60초)를 다시 검토합니다.
- 이미 내려받은 파일·외부 검색엔진 캐시는 회수할 수 없으므로, 게시·철회·동의 철회 확인 대화상자와 공개 페이지에 그 사실을 적었습니다.
- 한계: 보류(hold)·신고·운영 제한(T-15) 없음(신고 링크는 자리만), 운영 스위치는 환경 변수뿐(재시작 필요), S3 서명 URL 대신 서버 프록시 스트림(ADR 0007의 배포 전 과제), 이미지 EXIF 제거 없음(ADR 0007 TODO — 공개 파일에도 해당), 탈퇴한 당사자가 있는 게시 중 release를 자동으로 철회하지 않음, 공개 페이지 SSR의 "로그인 사용자 HTML에 이메일 없음"은 빌드 서버 스모크로 확인(자동 테스트는 경로 규칙과 공개 API 수준).

## 대안

- **`Cache-Control: public, max-age=0, must-revalidate` + ETag 304**: 대역폭은 줄지만 중간 캐시의 저장·재검증 동작에 기대게 되고, 지금 트래픽에는 이득이 작습니다.
- **`private, max-age=60` 파일 캐시**: §10의 "60초 이하"와 맞지만 철회 직후 브라우저에서 계속 보일 수 있습니다. 지금은 no-store.
- **동의 철회 시 restricted로 두고 owner 결정 대기**: owner가 다른 결정을 할 여지가 있지만, 당사자의 철회 의사를 지연시키고 상태가 하나 더 늘어납니다.
- **게시 중 수정 금지(철회 후 재게시만)**: 단순하지만 수정할 때마다 공개가 끊기고 `replaced`가 필요 없어집니다. 공개 버전 수정은 새 버전 생성(§1-7)이므로 게시 중 다음 버전을 허용했습니다.
- **공개 조회 결과 메모리 캐시 + 철회 시 무효화**: 여러 프로세스에서 무효화 누락 위험이 있고, worker·이벤트 실패가 노출로 이어집니다.
