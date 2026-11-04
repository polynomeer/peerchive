# 0057. AI 회고 인터뷰: 서버 AI 설정(`PEERCHIVE_AI_ENABLED=on` + `ANTHROPIC_API_KEY`)이 있을 때만 켜지는 기능(`features.ai`, 플래그 아님) + 학생별·과제별 사용 동의(기본 꺼짐, owner/editor만) + 고정 첫 질문 → 답마다 Claude가 꼬리 질문(3개 이상이면 끝낼 수 있음, 5개에서 끝, 학생이 일찍 끝내기 가능) → 빌드 로그 초안 구조화 JSON(🔨·🧱·⚖️·✅·🪞, 최대 5개, 로그 검증 규칙 통과분만) + 초안은 본인만·승인 전 로그 0건·고친 뒤 승인하면 source `ai`(`AI 초안`, 공개 스냅샷까지)·첫 revision `ai_generated`·`approved_at` + 보내는 데이터는 이 과제 이름·이 학생의 이번 주 체크인·최근 자기 로그 5개 요약·이 세션 답뿐 + 질문·답변은 초안을 만들면 삭제, 세션·초안 7일 상한(worker 정리) + 공용 `@peerchive/ai`(공식 `@anthropic-ai/sdk`, `claude-opus-5-5`, effort `medium`, 구조화 출력, 서버 쪽 거절 대체 `fallbacks: "default"`, system 캐시, 타임아웃·재시도, 오류 503 `ai_unavailable`·`ai_declined`) + 사용자·전체 하루 호출 수·전체 하루 토큰 상한(429) + 토큰 수만 날짜·기능·모델별 집계(`ai_usage_daily`)

- 상태: 채택
- 날짜: 2026-11-02

## 맥락

E-12는 DELIVERY_PLAN §4.4 P1 보완 백로그의 열두 번째 항목입니다: "학생이 켤 때만, 질문·답변으로 만든 로그 초안은 학생 승인 후 저장, `AI 초안` 표시, 해당 팀 데이터만 사용, 학습 미사용 API 조건, AI가 꺼져도 폼 체크인 그대로". 같은 절은 "AI 항목(E-12~E-14)은 공급자 키가 없으면 꺼진 상태로 동작하고 핵심 기능은 AI 없이 쓸 수 있어야 합니다"라고 정합니다. 관련 설계와 앞선 결정:

- PROOFU_EVOLUTION_PLAN §6.4(MVP는 60초 폼, P1에서 3분짜리 AI 회고 인터뷰 — "이번 주 가장 오래 걸린 건?", "그걸 어떻게 풀었어?" — 학기 말 15분 인터뷰는 이번 범위 밖, "AI가 만든 기록은 학생이 승인해야 저장"), §6.5 입력 경로 표, §15 AI 정책(생성물 표시·승인 필수, 비공개 데이터는 해당 팀 작업에만, 학습 미사용 API 조건, AI 없이도 핵심 기능 사용), §4.3(AI 사용을 감점 신호로 표시하지 않음 — 출처를 숨기지도 않음).
- ADR 0009(주간 체크인 폼·한 줄을 로그로 옮기기), T-04 빌드 로그(태그별 구조화 필드, revision), T-07(로그 source·사후 작성 표시를 만들 때 고정), ADR 0011(공개 스냅샷 허용 목록 — 로그 `source`는 이미 옮김), ADR 0016(감사는 id·개수만, 분석 수집 거부, 탈퇴 정리·삭제 장부), ADR 0055(외부 공급자 패키지·테스트 전용 가짜 공급자 모양).
- 스키마에는 처음부터 `log_source`의 `ai`, `log_revisions.ai_generated`·`approved_at`이 있었고 화면 라벨 `SOURCE_LABELS.ai = 'AI 초안'`도 있었습니다. 이 자리를 씁니다.
- E-13(회의 요약)·E-14(케이스 다듬기)가 같은 Claude 클라이언트를 다시 쓰므로 공용 패키지로 둡니다.
- 변경: D-10: 팀을 나가거나 내보내지면 그 과제의 AI 회고 세션·초안·켜기 행을 같은 트랜잭션에서 지웁니다 ([ADR 0060](0060-open-question-decisions.md)).

## 결정

### 1. 켜짐: 서버 설정 + 학생 동의(두 단계)

- **서버**: `PEERCHIVE_AI_ENABLED=on`이고 `ANTHROPIC_API_KEY`가 있을 때만(`aiProviderKind`). 키만 있다고 켜지지 않게 한 것은, 다른 용도로 둔 키가 학생 글을 보내기 시작하지 않게 하고, 사고 때 `PEERCHIVE_AI_ENABLED=off` 하나로 즉시 끄기 위해서입니다. `PEERCHIVE_AI_PROVIDER`는 기본 `anthropic`, `fake`는 `NODE_ENV=test`에서만. `GET /api/v1/features`의 `ai`(E-05·E-11처럼 플래그 영역이 아니라 공급자 설정값)가 이것을 알리고, 꺼져 있으면 새 경로 모두 404·화면 칸 없음. **폼 체크인(ADR 0009)은 한 줄도 바뀌지 않습니다**(테스트·E2E로 확인).
- **학생**: 과제마다 직접 켭니다(`ai_retro_opt_ins`, 행이 있으면 켜짐, 기본 꺼짐). 다른 과제·다른 팀원에게 번지지 않습니다. 켜기 전 화면에 보내는 것·보존·승인 원칙을 먼저 보여 줍니다. 끄면 진행 중 세션·초안을 지웁니다.
- 쓸 수 있는 사람: 그 과제의 active owner/editor(승인한 초안이 빌드 로그가 되므로 `canWriteLog`와 같음). reviewer/viewer 403, 비멤버 404. 켜지 않았으면 시작·답하기 403 `ai_opt_in_required`.

### 2. 인터뷰 흐름

- 시작(`POST …/ai-retro/session`): 첫 질문은 고정 문구 "이번 주 이 과제에서 가장 오래 걸린 건 뭐였어요?" — **AI를 부르지 않습니다**(비용·지연 없음). 학생·과제마다 세션 하나(진행 중이면 그대로, 초안이 남아 있으면 409 `drafts_pending`).
- 답하기(`POST …/answers {questionNo, answer?, finish?}`): Claude가 다음 질문을 정합니다(구조화 출력 `{finish, next_question}`). 질문이 3개 이상이고 모델이 재료가 충분하다고 하면 끝내고, 5개에서는 묻지 않고 끝냅니다(`nextInterviewStep`). 학생은 "여기까지 정리"(`finish: true`, 답 1개 이상)로 일찍 끝낼 수 있습니다. 모델이 빈 질문을 내면 고정 꼬리 질문(어떻게 풀었는지 → 결정 → 확인 → 다시 한다면)을 씁니다. 학기 말 15분 인터뷰는 다음 범위입니다.
- 끝나면 같은 요청에서 초안 호출(`{drafts: [...]}`): 태그는 🔨진행·🧱막힘·⚖️결정·✅검증·🪞회고만(💡해결은 연결할 막힘이, 🗣️회의는 참석자가 필요해 뺌). 필드 이름은 빌드 로그 구조화 필드와 같고(`stuck.symptom·keywords·attempts·time_bucket` 등), 서버가 로그 한도에 맞게 자르고(`aiDraftToLogInput`) 로그 검증(`validateLogContent`)을 통과한 것만 최대 5개 저장합니다. 🧱막힘의 "과제 답 아님" 확인은 늘 false로 두어 학생이 직접 체크합니다. 남길 초안이 없으면 세션을 지우고 `noDrafts`.
- 동시성: AI 호출은 **트랜잭션 밖**에서 하고, 저장할 때 세션 행을 잠가 질문 수가 그대로인지 확인합니다(다르면 409 `stale_question`, 다른 탭). AI가 실패하면 아무것도 저장하지 않으므로 학생은 같은 답으로 다시 시도합니다.
- 한 요청의 AI 호출은 최대 2번(꼬리 질문 + 초안). 세션당 최대 5번(질문 4 + 초안 1).

### 3. 초안 승인·버리기와 `AI 초안` 표시

- 초안은 본인만 봅니다. 팀원·다른 과제 경로로는 초안 id가 있어도 404(존재를 드러내지 않음). 운영 화면도 없습니다.
- 승인(`POST …/drafts/:draftId/approve`): 화면이 빌드 로그 입력 필드(LogFields)로 초안을 열어 학생이 고친 뒤 보냅니다. 서버는 로그 작성과 **같은** `parseLogInput`·`insertLog`를 쓰고(태그는 초안 것으로 고정, `resolvesEntryId` 무시, 재전송은 초안 id를 `clientId`로 묶음) 검증 실패는 422(초안 남음), 편집 권한이 없으면 403입니다. 만든 로그는 **source `ai`**(`logSourceFor`의 새 출처 `ai`, 사후 작성 모드면 retrospective도 고정)이고 첫 revision에 `ai_generated = true`·`approved_at = 승인 시각`. 초안 행은 지우고, 마지막 초안이면 세션도 지웁니다.
- 표시: 과제 화면 로그에 `AI 초안` 배지. 공개 스냅샷은 이미 허용 목록에 로그 `source`를 옮기므로(ADR 0011) 공개 페이지에 "출처 AI 초안"이 그대로 남습니다 — 스냅샷 코드는 바꾸지 않았고 회귀 테스트로 확인합니다. 학생이 이후 고친 revision은 `ai_generated = false`지만 로그의 출처는 바뀌지 않습니다(사람이 고쳐도 AI 초안에서 시작했음을 숨기지 않음, §4.3).
- 버리기(`DELETE …/drafts/:draftId`)·전체 버리기(`DELETE …/session`)는 로그를 쓰지 않습니다.

### 4. AI에 보내는 것(이것뿐)

| 보냄 | 안 보냄 |
|---|---|
| 고정 system 프롬프트(질문용·초안용 두 개, 상수) | 사용자 id·이메일·이름, 날짜·시각 |
| 이 과제의 이름 | 다른 팀원의 로그·체크인·이름·인터뷰 |
| 이 학생의 이번 주(서울 ISO 주) 체크인: 시간 구간·난이도·한 줄 | 다른 과제(내 다른 과제 포함)·다른 팀의 어떤 데이터 |
| 이 학생이 이 과제에 쓴 최근 로그 5개의 태그와 한 줄 요약(80자, `summarize`) | 로그 본문 전체·링크·파일·댓글·선언 |
| 이 세션의 질문과 이 학생의 답(각 1000자 이내) | 공개 여부·과목·학교 정보 |

- 학생 글은 `<context>`·`<interview>` 구획에 넣고 닫는 태그를 무력화하며(`neutralizePromptText`), system 프롬프트가 구획 안의 글을 지시로 따르지 않게 합니다.
- 테스트가 가짜 공급자로 받은 글 전체에서 팀원 로그·팀원 체크인·팀원 인터뷰 답·내 다른 과제 이름·로그·체크인·다른 팀 과제·외부 사용자 이름·사용자 id·이메일·과제 id 표지가 0건임을 확인합니다.

### 5. 보존

- 질문·답변(`ai_retro_sessions.transcript`)은 **초안을 만드는 순간 비웁니다**(초안만 남음). 세션·초안은 마지막 초안을 처리하면 지우고, 그러지 않아도 만든 지 **7일**(`expires_at`) 뒤 worker 주기 작업 `ai-retro-sessions`(매시 19분)가 지우며 웹도 읽을 때 만료된 것을 지웁니다. 켜기를 끄면 즉시 지웁니다.
- 탈퇴 정리: 그 사람의 초안·세션·켜기 행을 지우고, 혼자 과제를 지울 때 그 과제에 남은 예전 멤버의 행도 지웁니다.
- 승인한 로그는 일반 빌드 로그와 같은 보존(학생 자료).
- 사용량(`ai_usage_daily`): 날짜(UTC)·기능(`retro_interview.turn`·`retro_interview.drafts`)·모델별 호출·토큰(입력·출력·캐시 읽기·캐시 쓰기)·거절·대체·실패 수만. 사람·과제·내용 없음. 비용 추적용으로 운영 기간 동안 보존(RUNBOOK §8).
- 감사(`ai_retro.opt_in|opt_out|draft_approve|draft_discard|session_discard`): id·태그·개수·`edited` 플래그만. 분석 이벤트 `ai_retro_drafts_proposed {drafts, questions, endedEarly}`·`ai_retro_draft_resolved {decision, tag, edited}` + 승인 로그의 `log_saved {source: ai}`, 수집 거부를 따름. 서버 로그에는 기능 이름·오류 종류·상태 코드만(프롬프트·출력 없음).

### 6. 공용 Claude 클라이언트 `@peerchive/ai`

- 공식 `@anthropic-ai/sdk`(직접 fetch·OpenAI 호환 shim 없음). 버전은 저장소의 "공개 14일 지난 버전만" 규칙(pnpm `minimumReleaseAge`)에 따라 **0.135.0**(MIT)입니다 — 1.x(2026-10-21~)는 아직 14일이 지나지 않아 설치되지 않습니다.
- 인터페이스 `AiProvider.generateStructured({feature, system, messages, schema(zod), maxTokens, effort})` → `{data, usage, model, fallback}`. 실패는 `AiError(kind: refusal | max_tokens | invalid_output | rate_limited | unavailable, status, usage)` — 메시지에는 종류·상태만. E-13·E-14는 이 인터페이스와 웹 `callAi`(상한·사용량·오류 변환)를 그대로 씁니다.
- 요청 모양(claude-api 지침): `client.beta.messages.create` + `betas: ['server-side-fallback-2026-07-01']` + `fallbacks: 'default'`(분류기 거절 때 API가 Anthropic 권장 대체 모델로 같은 요청을 다시 돌림, `PEERCHIVE_AI_FALLBACKS=off`로 끔) + `output_config: {effort, format: json_schema}`(zod → `betaZodOutputFormat`의 JSON Schema). 구조화 출력과 서버 쪽 대체를 같이 쓰는 조합을 금지하는 문서가 없고 SDK 타입도 둘을 함께 받아 둘 다 씁니다(대체 모델 Claude Opus 5·Opus 4.8도 구조화 출력을 지원). 실제 키로 확인하지 않았으므로 400이 나오면 `PEERCHIVE_AI_FALLBACKS=off`로 내립니다(RUNBOOK).
- 응답은 **`stop_reason`을 먼저** 봅니다: `refusal`(대체 모델까지 거절 — 부분 출력 버림, `stop_details.category`는 정보용) → `ai_declined`, `max_tokens` → 실패, `end_turn`일 때만 텍스트를 JSON.parse + zod 검증. SDK의 `parse()`는 잘린 출력에서도 먼저 파싱하다 출력 일부가 섞인 예외를 던지므로 쓰지 않습니다.
- 모델 `claude-opus-5-5`(`PEERCHIVE_AI_MODEL`로 바꿈). `thinking`은 보내지 않습니다(Opus 5.5는 늘 adaptive, `disabled`는 400). `temperature`·`top_p`·`top_k`·assistant prefill은 보내지 않습니다(400). **effort**: 꼬리 질문·초안 모두 `medium`(Opus 5.5 기본값과 같음 — 짧은 한국어 질문과 최대 5개 구조화 초안에 충분하고, 라우트마다 고정해 캐시를 깨지 않음. 꼬리 질문 지연이 문제면 `low`로 내릴 후보). **max_tokens**(생각 포함): 꼬리 질문 4096(짧은 JSON), 초안 16000.
- 프롬프트 캐싱: 고정 system 블록에 `cache_control`(5분), 바뀌는 맥락·인터뷰·작업 지시는 그 뒤 user 메시지에만. system에 날짜·id·과제 이름을 넣지 않습니다(테스트가 system이 두 상수 중 하나인지 확인). 지금 system은 Opus 5.5 최소 캐시 길이(512토큰)보다 짧아 실제로는 캐시되지 않을 수 있습니다 — 오류는 아니고, 프롬프트가 길어지면 그대로 캐시됩니다.
- 클라이언트 `timeout` 60초(`PEERCHIVE_AI_TIMEOUT_MS`), `maxRetries` 2(`PEERCHIVE_AI_MAX_RETRIES`, SDK가 429·5xx·연결 오류 재시도). 인증은 `apiKey`만 넘기고 `authToken: null`(둘 다 보내면 401).
- 오류 변환(SDK 타입 클래스로만): `RateLimitError` → `rate_limited`, `APIConnectionError`(시간 초과 포함)·그 밖의 `APIError`·`AnthropicError` → `unavailable`. 웹은 모두 **503**(`ai_declined` 또는 `ai_unavailable`)으로 바꾸고 공급자 응답·학생 글을 싣지 않습니다(새 서비스 오류 코드 `UNAVAILABLE`).
- 테스트: 가짜 공급자(`createFakeAiProvider`, `NODE_ENV=test`가 아니면 throw, 받은 글 기록)와 가짜 `fetch`로 요청 모양·응답 처리만 봅니다. **실제 네트워크 호출은 없습니다.**

### 7. 비용 상한·사용량

- 부르기 전에(넘으면 429 `rate_limited`, 공급자 호출 0): 서버 전체 하루(UTC) 토큰 합계 `PEERCHIVE_AI_GLOBAL_DAILY_TOKENS`(기본 5,000,000, 0이면 없음) → 사용자마다 하루 호출 `PEERCHIVE_AI_USER_DAILY_REQUESTS`(기본 40 ≈ 인터뷰 8번) → 서버 전체 하루 호출 `PEERCHIVE_AI_GLOBAL_DAILY_REQUESTS`(기본 2000). 호출 수는 기존 `rate_limit_buckets`(사용자 id 해시), 토큰은 `ai_usage_daily` 합계.
- 부른 뒤 성공·실패 모두 `ai_usage_daily`에 더합니다(대체 모델이 답하면 그 모델 행에, 실패는 요청 모델 행에).

### 8. 학습 미사용·데이터 보존 조건(ZDR)

- Anthropic 상용 API 조건은 기본적으로 API 입력·출력을 모델 학습에 쓰지 않습니다. 이것이 §15 "학습 미사용 API 조건"의 근거입니다(소비자용 Claude 앱 조건과 다름).
- 영구 무보존(ZDR)은 조직 단위 별도 약정이며 이 코드로 켜지 않습니다. 서버 쪽 거절 대체의 "sticky routing" 기록은 ZDR 조직에서는 남지 않는다고 문서가 밝힙니다. **운영자는 켜기 전에 조직의 데이터 보존 설정(보존 기간·ZDR 여부)과 지역을 Console에서 확인하고 개인정보 처리방침에 적어야 합니다**(RUNBOOK §4.12).

### 9. 경로

| 경로 | 성공 | 오류 |
|---|---|---|
| `GET /api/v1/projects/:id/ai-retro` | 200 `AiRetroStateDto {optedIn, canUse, session, drafts}` | 404(AI 꺼짐·읽을 수 없는 과제) |
| `PUT …/ai-retro/opt-in {enabled}` | 200 상태 | 403(reviewer/viewer), 404 |
| `POST …/ai-retro/session` | 200 상태(첫 질문) | 403 `ai_opt_in_required`·권한, 409 `drafts_pending`, 404 |
| `DELETE …/ai-retro/session` | 200 상태 | 404(세션 없음) |
| `POST …/ai-retro/answers {questionNo, answer?, finish?}` | 200 상태(다음 질문 또는 초안·`noDrafts`) | 422(`answer` 필수·1000자), 409 `stale_question`·`drafts_pending`, 429, 503 `ai_unavailable`·`ai_declined`, 403, 404 |
| `POST …/ai-retro/drafts/:draftId/approve` | 201 `{log, state}` | 422(로그 검증), 403, 404(남의 초안·없음·만료) |
| `DELETE …/ai-retro/drafts/:draftId` | 200 상태 | 404 |

## 결과

- 서버에 키를 넣고 학생이 켜면, 체크인 옆에서 3분 안팎의 질문에 답해 막힘·결정·검증 로그 초안을 받고 고쳐서 남길 수 있습니다. 학생이 승인하지 않은 AI 글은 빌드 로그·공개·검색·기여 장부 어디에도 들어가지 않고, 승인한 글은 `AI 초안`으로 끝까지 표시됩니다.
- 새 패키지 `@peerchive/ai`(`@anthropic-ai/sdk` 0.135.0 MIT, `zod` 4.6.5), migration `0052_ai_retro_interview`(enum `ai_retro_session_status`, 분석 이벤트 enum 두 값, 테이블 `ai_retro_opt_ins`·`ai_retro_sessions`·`ai_retro_drafts`·`ai_usage_daily`, 빈 DB 처음부터 migrate 확인), 도메인 `ai-retro.ts`, 웹 `server/modules/ai/{ai,retro-interview}.ts`, 화면 `AiRetroSection.vue`, worker 작업 `ai-retro-sessions`.
- 테스트: `@peerchive/ai` 단위(설정·요청 모양·거절·상한·형식 오류·SDK 오류 변환·내용 비노출·가짜 공급자), domain(질문 수·초안 변환·구획 무력화), web 통합(꺼짐 404·폼 체크인 그대로, 켜기 범위·권한, 질문 흐름·최소/최대 질문·일찍 끝내기·낡은 질문 409, 초안 검증·버림, 보낸 데이터 표지 검사, 팀원에게 안 보임, 승인 로그 source ai·revision 표시·공개 스냅샷 출처, 버리기 0건, 거절·상한·공급자 오류 503·저장 없음·사용량, 비용 상한 3종, 7일 만료·끄기 삭제, 분석 수집 거부), worker(만료 정리·탈퇴 정리), E2E `e12-ai-retro.spec.ts`(공급자 없는 기본 서버: 404·칸 없음·폼 체크인 동작).
- 한계: 실제 Claude 응답으로는 확인하지 않았습니다(키 없음, 네트워크 금지). 질문·초안 품질·한국어 어투·effort·max_tokens는 pilot에서 조정합니다. 거절·실패가 잦으면 학생은 폼 체크인·직접 작성으로 돌아갑니다. 팀에서 나간 멤버의 세션·켜기 행은 7일 정리·탈퇴 정리 전까지 남습니다(읽기는 404). 학기 말 15분 인터뷰·케이스 재료 생성은 범위 밖입니다.

## 대안

- **키만 있으면 켜짐**: 설정이 하나 줄지만 다른 용도의 키가 기능을 켜고, 사고 때 키를 지워야만 끌 수 있습니다. 명시적 스위치를 둡니다.
- **과제 단위(owner가 팀 전체) 켜기**: 한 번에 켜지지만 §15 "학생이 켤 때만"과 맞지 않고 다른 팀원의 동의 없이 그 사람 화면에 AI가 생깁니다. 학생별·과제별로 둡니다.
- **질문·답변 영구 보관**: 학기 말 회고 재료가 되지만 AI용 원문이 오래 남습니다. 초안 생성 때 지우고, 필요한 내용은 학생이 승인한 로그로만 남깁니다.
- **초안을 바로 로그(초안 상태 revision)로 저장**: 테이블이 줄지만 승인 전 AI 글이 팀 타임라인·공개 후보·검색에 섞일 위험이 있습니다. 별도 테이블에 두고 승인 때만 로그를 만듭니다.
- **SDK `messages.parse()`**: 코드가 짧지만 잘린 출력·대체 경계에서 `stop_reason`을 보기 전에 예외가 나고 그 메시지에 출력 일부가 섞일 수 있습니다.
- **강제 tool 호출로 JSON 받기**: Opus 5.5에서 `tool_choice` any/tool은 400. 구조화 출력을 씁니다.
- **스트리밍**: 첫 글자가 빨라지지만 짧은 JSON에는 이점이 작고 부분 출력 처리가 늘어납니다. 비스트리밍 + 상한을 둡니다.
- **매 질문을 템플릿으로만(AI 없이)**: 비용이 없지만 꼬리 질문이 답에 맞지 않습니다. 첫 질문과 빈 응답 대비 질문만 템플릿입니다.
