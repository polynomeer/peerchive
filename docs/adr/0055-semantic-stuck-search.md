# 0055. 유사 막힘 의미 검색: 공급자 설정이 있을 때만 켜지는 기능(`semanticStuck`, 플래그 아님) + 공개 release 스냅샷의 막힘 증상·키워드·해결 방법만 임베딩(비공개 작업 공간 0건, 엠바고 중 0건) + `stuck_embeddings`(공개, 로그 키)마다 정규화한 `real[]` 벡터·내용 해시(같은 글은 다시 임베딩하지 않음) + worker 주기 동기화(검색 문서에서 대상 선택, 배치·재시도·분당 요청·실행당 비용 상한) + 읽기마다 지금 release·엠바고·가린 카드를 같은 쿼리에서 확인(철회·숨김은 다음 요청부터 제외) + 검색어는 임베딩만(저장·로그 없음, IP·전체 한도) + Voyage AI 어댑터·테스트 전용 가짜 공급자, pgvector는 운영 업그레이드 경로

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

E-05는 DELIVERY_PLAN §4.4 P1 보완 백로그의 다섯 번째 항목입니다: "공개 스냅샷의 막힘·해결 텍스트만 임베딩(비공개 작업 공간 0건), 철회·숨김 시 다음 요청부터 결과 제외, 임베딩 공급자가 없으면 키워드 검색으로 동작, 엠바고 과목 결과 제외". 로드맵(§3)상 단계 4 후보이고, 외부 공급자로 글을 보내는 첫 기능입니다. 관련 설계와 앞선 결정:

- ADR 0003(같은 PostgreSQL에서 `pg_trgm`·`pgvector`를 쓰려 함), 0011·0012(공개 읽기는 저장된 release 스냅샷만, 요청마다 상태 확인, 철회 즉시 404), 0013(과목 허브 검색 — `search_documents` 파생 색인을 worker가 outbox 게시·철회 이벤트로 만들고, 읽기는 원본 행과 조인해 `servableReleaseSql`로 같은 쿼리에서 확인), 0015(운영 조치 hide_item·`hiddenStuckSql`), 0016(탈퇴 정리), 0047(E-02 단계적 개방 — 막힘 결과는 `/p/:slug`라 허브 "준비 중"과 무관), 0049(E-04 막힘 카드 = 게시 중인 release의 🧱 로그).
- 개발·테스트 DB 이미지는 `postgres:16.10-alpine`(ops/docker-compose.yml)이라 **pgvector가 없습니다**. 다른 작업이 같은 이미지를 쓰므로 바꾸지 않습니다.
- Anthropic은 임베딩 API가 없고 문서에서 Voyage AI를 권합니다. 2026-11 Voyage 문서 기준 지금 모델은 Voyage 4 계열(`voyage-4-lite` 등, 기본 1024차원, `output_dimension` 256·512·1024·2048, 요청당 글 1,000개, voyage-4-lite는 요청당 1M 토큰)이고 `voyage-3.5-lite`는 "이전 모델"로 계속 쓸 수 있습니다.

## 결정

### 1. 켜짐 = 공급자 설정(플래그 아님)

- `PEERCHIVE_EMBEDDINGS_PROVIDER=voyage`와 `VOYAGE_API_KEY`가 **둘 다** 있을 때만 켜집니다. 키가 없거나 다른 값이면 꺼짐. `fake`는 `NODE_ENV=test`에서만(그 밖에서는 꺼짐, 직접 만들면 throw).
- 꺼지면 두 경로 모두 404, `GET /api/v1/features`의 `semanticStuck: false`(FeatureFlags 영역이 아니라 따로 붙인 값 — P1 플래그처럼 pilot 근거로 여닫는 것이 아니라 공급자 계약·키가 있어야 의미가 있기 때문), 화면 진입점 없음, worker 일정 없음. **키워드 검색(`/public/search`)은 한 줄도 바뀌지 않습니다**(테스트로 공급자 유무에 같은 결과 확인).
- 설정은 새 패키지 `@peerchive/embeddings`(런타임 npm 의존성 없음)가 해석하고 web·worker가 같이 씁니다: 모델(`PEERCHIVE_EMBEDDINGS_MODEL`, 기본 `voyage-4-lite`), 차원(`PEERCHIVE_EMBEDDINGS_DIMS`, 기본 512 — 저장 크기를 줄이려 모델 기본 1024보다 작게), 실행당 상한·배치·분당 요청·검색어 한도.

### 2. 공급자 인터페이스와 어댑터

- `EmbeddingProvider { name, model, dims, embed(texts, inputType?) }`. 반환 벡터는 개수·차원·유한한 수를 검사합니다.
- **Voyage 어댑터**: `fetch`로 `POST https://api.voyageai.com/v1/embeddings`(Bearer 키), 본문 `{input, model, input_type: 'document'|'query', output_dimension, truncation: true}`, 응답 `data[].embedding`을 `index`로 맞춤, 1,000개씩 나눔. 429·5xx·네트워크 오류는 재시도 대상(`Retry-After` 존중). 오류 메시지에는 상태 코드만(입력 글·응답 본문 없음).
- **가짜 공급자**(테스트 전용): 정규화한 글의 문자 bigram을 해시한 결정적 벡터 — 글자를 많이 공유하는 글끼리 유사도가 높아 정렬을 검사할 수 있고, 받은 글을 `calls`에 기록해 "비공개 글을 보내지 않았다"를 확인합니다. 테스트는 네트워크를 쓰지 않습니다(Voyage는 가짜 `fetch`로 요청 모양만 봄).

### 3. 무엇을 보내나: 공개 막힘·해결 글만

- 글 = 지금 게시 중이고 **엠바고가 없는** release 스냅샷의 🧱 로그 `막힘: <증상>` + `키워드: …` + 그 막힘을 가리키는 같은 스냅샷의 💡 해결 `해결: <방법>`(도메인 `stuckEmbeddingSources`, 2000자에서 자름). 운영 조치로 가린 로그(막힘·해결 모두)는 뺍니다.
- 스냅샷에 있어도 시도(`attempts`)·오류 원문(`errorText`)·본문·링크·사람 정보는 넣지 않습니다(카드와 해결 방법만으로 비슷함을 찾기에 충분하고, 외부로 나가는 글을 최소로).
- worker는 `search_documents`(kind stuck, T-13 search-index handler가 게시 이벤트로 만든 행)에서 대상을 고르고 release 스냅샷만 읽습니다. **비공개 작업 테이블(log_entries·log_revisions)·초안 후보·대체된 release는 읽지 않습니다**(테스트: 같은 과제의 비공개 로그·다른 비공개 과제·초안 후보·스냅샷 안 시도·오류 원문이 공급자 입력에 0건).
- 검색어: 사용자가 "의미로 찾기"에 적은 글은 `input_type: query`로 임베딩만 하고 DB·로그·감사에 남기지 않습니다(한도 버킷 키는 IP 해시뿐).

### 4. 저장: `stuck_embeddings`(real[]), pgvector는 업그레이드 경로

- (공개, 스냅샷 로그 키) unique, `release_id`(벡터를 만든 글이 들어 있던 지금 release), `model`·`dims`, `content_hash`(SHA-256(모델, 차원, 글) — 글 자체는 저장하지 않음), `embedding real[]`(단위 길이로 정규화, `cardinality = dims` check), `stale`, 시각. 외래 키는 기본 no action이라 탈퇴 정리가 공개를 지우기 전에 이 행을 지웁니다.
- 유사도 = 내적(정규화했으므로 코사인)을 SQL `unnest(a, b)`로 계산하고 지금 공개인 막힘 벡터 전체를 훑습니다. **규모 가정(pilot)**: 공개 막힘 카드 수만 개 이하 × 512차원이면 한 요청에 충분히 빠릅니다. 넘으면 pgvector로 옮깁니다: 운영 DB에 `vector` 확장 → `embedding vector(512)` 열 + HNSW(`vector_cosine_ops`) 인덱스 → `StuckVectorIndex` 구현만 `ORDER BY embedding <=> $1`로 교체(공개 조건 조인은 그대로). 웹의 읽기는 이 어댑터(`realArrayVectorIndex`) 하나로만 벡터를 비교합니다.
- 모델·차원을 바꾸면 기존 벡터는 비교에서 빠지고(읽기가 지금 공급자의 model·dims와 같은 행만 씀) 다음 동기화가 새로 임베딩합니다.

### 5. worker 동기화(같은 outbox 파이프라인)

- 주기 작업 `embeddings.stuck-sync`(기본 10분마다, `PEERCHIVE_EMBEDDINGS_CRON`, `off`로 끔, 공급자가 없으면 일정을 지움): 지금 release·published·엠바고 없음인 막힘 문서 중 벡터가 없거나, 다른 release·모델·차원이거나, `stale`인 것을 최대 1,000개 고릅니다.
- 글을 다시 만들어 해시를 비교: **같으면 `release_id`만 옮김**(새 버전 게시 때 바뀌지 않은 카드는 공급자 호출 0), 다르면 임베딩 목록에. 지금 글이 없으면(가린 카드) 벡터 삭제.
- 비용·속도: 실행당 공급자로 보내는 글 `PEERCHIVE_EMBEDDINGS_MAX_ITEMS_PER_RUN`(기본 200, 0이면 보내지 않음, 나머지는 다음 실행), 배치 `PEERCHIVE_EMBEDDINGS_BATCH_SIZE`(기본 64), 분당 요청 `PEERCHIVE_EMBEDDINGS_RPM`(기본 60), 재시도 지수 백오프 4회. 재시도 뒤에도 실패하면 그 실행은 멈추고 남은 글은 다음 실행으로(글·응답은 로그에 남기지 않고 개수만).
- 저장 직전에 그 release가 아직 게시 중인지 다시 확인합니다(그 사이 철회·대체면 쓰지 않음).
- 게시 이벤트를 받아 바로 임베딩하지 않고 주기 작업으로 둔 이유: 외부 호출의 재시도·한도·비용 상한을 한 곳에서 다루고, 게시·철회 handler(트랜잭션 안)를 외부 API 지연에 묶지 않기 위해서입니다. 대가로 새 게시물은 최대 한 주기 뒤에 "비슷한 막힘"에 들어갑니다(카드 화면은 `indexed: false`로 안내).

### 6. 정리와 읽기 때 확인

- **읽기가 기준**: 두 경로 모두 벡터를 검색 문서(같은 release의 막힘 문서) → 공개 → release(= 공개의 current_release_id) → 과제와 조인해 `servableReleaseSql`(공개·release published, 엠바고 없음)과 `not hiddenStuckSql()`을 **같은 쿼리에서** 확인합니다. 철회·제한·대체·엠바고·운영 조치 가림은 worker 정리를 기다리지 않고 다음 요청부터 빠지고(테스트: 행이 남은 채로 제외), 그 카드를 원본으로 부르면 404.
- 정리(남은 사본 줄이기, 선택): derived cleanup handler `stuck-embeddings` — 철회·제한 때 그 공개의 벡터 삭제, 새 release 게시 때 지금 스냅샷에 없는 카드의 벡터 삭제. 운영 조치 handler — hide_item(로그) 적용 때 가린 막힘 카드의 벡터 삭제, 적용·해제 때 같은 공개의 나머지를 `stale`(해결 글이 바뀌었을 수 있음). 탈퇴 정리 — 공개를 지우기 전에 벡터 삭제. 엠바고가 걸린 공개의 기존 벡터는 지우지 않습니다(읽기가 거르고, 풀리면 그대로 씀).
- 결과 DTO는 키워드 검색 결과와 같은 `SearchResultDto`(kind `stuck`, 제목 = 증상, 발췌 = 키워드, `/p/:slug#public-<키>`, 정본 과목 이름) — 카드에 이미 공개된 필드뿐이고 해결 방법·점수·내부 id는 싣지 않습니다.
- 단계적 개방(E-02): 키워드 검색과 같게 막힘 결과는 사례 페이지로 가므로 허브 "준비 중"으로 거르지 않습니다.

### 7. 경로·한도

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /api/v1/public/publications/:slug/stuck/:itemKey/similar?limit=` | 200 `{indexed, results}`(자기 카드 제외, 유사도 0.2 미만 제외, 기본 5·최대 10) | 404(꺼짐·카드가 지금 안 보임·형식이 틀린 키), 422 `limit`, 429(IP마다 분당 60), 503(운영 스위치) |
| `GET /api/v1/public/search/semantic?q=&course=&limit=` | 200 `{q, courseId, results}`(빈 검색어는 공급자 호출 없이 빈 결과, 없는 과목은 빈 결과) | 404(꺼짐), 422(`q` 100자 초과·`course`·`limit`), 429(IP마다 분당 `PEERCHIVE_EMBEDDINGS_QUERY_PER_MINUTE` 기본 10, 서버 전체 시간당 `PEERCHIVE_EMBEDDINGS_QUERY_PER_HOUR` 기본 300), 503 `embedding_unavailable`(공급자 오류, 검색어를 응답·로그에 싣지 않음)·운영 스위치 |

- 둘 다 공개 조회 공통 handler(no-store·nosniff·no-referrer·쿠키 없음)에 **늘 noindex**. 카드 경로는 저장된 벡터만 써서 공급자를 부르지 않습니다.

### 8. 화면

- 공개 사례 `/p/:slug`: 공급자가 켜져 있으면 "비슷한 막힘" 구역 — 🧱 기록마다 "비슷한 막힘 보기"(누를 때만 불러 요청 한도를 아낌).
- 막힘 Q&A 카드 `/stuck-qa/cards/:slug/:itemKey`(E-04 플래그가 켜졌을 때): "비슷한 막힘"을 화면이 뜬 뒤 자동으로.
- 검색 `/search`: "키워드로 찾기"·"의미로 찾기(막힘)" 전환(`mode=semantic`), 의미 검색은 화면이 뜬 뒤 클라이언트에서만 부름(SSR 없음), 429·503이면 키워드 검색을 안내. 공급자가 꺼져 있으면 전환이 없고 `mode`는 무시.

## 결과

- 공급자 계약과 키를 넣으면 후배가 "내 막힘과 비슷한 다른 학교·학기의 막힘"을 문장으로 찾고, 막힘 카드에서 비슷한 사례로 건너갈 수 있습니다. 공급자로 나가는 것은 이미 공개된 막힘·해결 글과 사용자가 친 검색어뿐이고, 공개를 내리면 다음 요청부터 결과에서 빠집니다.
- 새 패키지 `@peerchive/embeddings`(web·worker 의존), migration `0050_stuck_embeddings`(테이블 하나, 빈 DB 처음부터 migrate 확인), worker 일정 `embeddings.stuck-sync`, 도메인 `semantic-stuck.ts`.
- 테스트: embeddings 단위(설정·Voyage 요청 모양·가짜 공급자 정렬·재시도·한도), domain(보낼 글 규칙), worker(공개 글만 전송·비공개 0건·해시 재사용·비용 상한·재시도·엠바고·철회·가림·탈퇴 정리), web 통합(꺼짐 404·키워드 동일, 정렬, 철회·가림·엠바고 다음 요청 제외, 검색어 비저장·비로그, 한도, HTTP 헤더·503), E2E `e05-semantic-stuck.spec.ts`(공급자 없는 기본 서버에서 404·진입점 없음).
- 한계: 공급자 쪽 보존 정책은 Voyage 계약에 따릅니다(RUNBOOK에 확인 항목). 새 게시물은 최대 한 주기 늦게 들어갑니다. 해결 로그만 가렸을 때 다음 동기화 전까지는 이전 벡터(해결 포함)로 순위가 매겨질 수 있습니다(결과에 해결 글은 나오지 않음). 유사도 하한·결과 수는 고정값이고 pilot에서 조정합니다. 다국어 품질·한국어 짧은 증상의 품질은 모델에 따릅니다. 노트·Q&A·사례는 의미 검색 대상이 아닙니다.

## 대안

- **pgvector 이미지로 바꿈**: 인덱스·연산자를 바로 쓰지만 다른 사람이 쓰는 개발·테스트 이미지를 바꿔야 합니다. `real[]` + 어댑터로 시작하고 운영에서 옮깁니다.
- **벡터를 `search_documents`에 열로 추가**: 테이블은 줄지만 검색 문서는 새 release마다 지우고 다시 만들어 같은 글도 매번 다시 임베딩하게 되고, 공급자 없는 설치에도 빈 열이 생깁니다.
- **앱 메모리에서 유사도 계산**: SQL이 단순해지지만 공개 조건을 같은 쿼리에서 확인하려면 후보를 모두 읽어 와야 합니다. SQL 안에서 조건과 함께 계산합니다.
- **게시 handler에서 바로 임베딩**: 반영은 빠르지만 외부 API 지연·실패가 게시·철회 이벤트 처리를 붙잡고, 비용 상한을 한 곳에서 걸기 어렵습니다.
- **캐시 테이블(해시 → 벡터)로 철회 뒤에도 재사용**: 다시 게시할 때 호출이 줄지만 철회된 글에서 나온 벡터가 남습니다. 철회 때 지웁니다.
- **기능 플래그(P1 영역)로 여닫기**: 다른 P1과 모양이 같지만 공급자 없이 켜면 의미가 없고, 공급자가 있는데 끄는 경우는 공급자 설정을 지우면 됩니다.
- **검색어 임베딩 캐시**: 같은 검색어 비용이 줄지만 검색어를 저장하게 됩니다(요구사항 위반).
