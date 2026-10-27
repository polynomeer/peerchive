# 0032. 타입 라우트 표 비우기: 화면 API 호출은 응답 타입을 DTO로 직접 주고, nitro의 경로별 타입 추론은 쓰지 않음

- 상태: 채택
- 날짜: 2026-10-28

## 맥락

nitro는 `server/api/**`의 handler마다 경로·메서드·응답 타입을 모아 타입 라우트 표(`.nuxt/types/nitro-routes.d.ts`의 `InternalApi`)를 만들고, `$fetch`·`useFetch`의 타입이 이 표로 URL에 맞는 메서드와 응답을 고릅니다. S-03(ADR 0031)에서 라우트 하나만 늘어도 `pnpm typecheck`가 화면의 첫 `$fetch<T>(…)` 호출에서 TS2589(타입 인스턴스화 한도)로 실패했고, 그때는 봇 전용 `/api/internal/**`를 `types:extend` 훅으로 표에서 빼 버텼습니다(여유 거의 없음). S-04(팔로우·차단)가 라우트를 8개쯤 더하므로 라우트 수에 따라 무너지지 않는 해결이 필요했습니다.

원인(nitropack 2.13.4 `nitropack/types`, nuxt 4.5.2 `useFetch`):

- 경로 고르기(`MatchedRoutes`)는 URL 타입 하나를 **표의 모든 키**와 세그먼트별로 맞춰 점수(`CalcMatchScore`)를 내고 가장 높은 점수(`MaxTuple`)를 고르는 조건부 타입입니다. URL 하나에 라우트 수만큼, 템플릿 문자열(`` `/api/v1/x/${id}` ``)이면 동적 세그먼트 비교까지 더해 비쌉니다.
- `$fetch<T>(url, opts)`·`useFetch<T>(…)`처럼 타입 인자를 직접 주면 TypeScript는 나머지 타입 인자를 추론하지 않고 기본값을 씁니다. 요청 타입 기본값은 `NitroFetchRequest` = **표의 모든 키의 합집합**이라, 옵션 타입(`AvailableRouterMethod<R>`)이 키마다 다시 `MatchedRoutes`를 돌려 라우트 수의 제곱만큼 펼칩니다. 결과는 캐시되므로 이 비용을 맨 처음 그 타입을 계산하는 문장 하나가 모두 떠안고, 문장당 한도(인스턴스화 500만 회)를 넘으면 TS2589입니다.

재현(라우트 227개 표, `__probe` 정적 GET 20개 추가):

- 원래 코드: `AnalyticsPreferenceSection.vue`의 `$fetch<…>('/api/v1/me/preferences', { method: 'PATCH', … })`에서 TS2589.
- 처음 검토한 해결(타입 인자를 준 호출을 모두 `apiFetch<T>(url: string, …)` 래퍼·`useFetch<T, …, string>`으로 바꿈, 196곳): 제곱 비용은 사라졌지만 **제네릭 없는 호출**인 `ClaimItem.vue`의 ``$fetch(`/api/v1/claim-revisions/${…}/endorsement`, { method: 'DELETE' })``가 같은 TS2589로 실패했습니다. probe를 5개로 줄여도 같았습니다. 즉 이 앱 규모(200개 넘는 라우트)에서는 템플릿 URL 하나의 경로 고르기도 한도에 붙어 있어, 래퍼로는 경계를 조금 옮길 뿐입니다.

## 결정

- `apps/web/nuxt.config.ts`의 `nitro.hooks['types:extend']`에서 **`types.routes = {}`** 로 타입 라우트 표를 비웁니다(S-03의 `/api/internal/**` 제외를 대신함). nitro 2.13.4에는 표 생성을 끄는 설정이 없고(`typescript` 옵션은 tsconfig·runtimeConfig 타입·internalPaths뿐), 이 훅이 표를 파일로 쓰기 직전에 부르는 공식 확장 지점입니다. 바뀌는 것은 생성 타입 파일뿐이고 서버 라우팅·빌드 결과·런타임은 같습니다.
- 표가 비면 `InternalApi`에 키가 없어 `MatchedRoutes`가 돌 대상이 없고, `$fetch`·`useFetch`의 타입 비용이 라우트 수와 무관해집니다.
- **화면 코드 규칙**(새 코드 포함): 응답을 쓰는 API 호출은 응답 타입을 `shared/types/api`의 DTO로 직접 줍니다(`$fetch<T>(…)`, `useFetch<T>(…)`, `useRequestFetch()<T>(…)`). 지금까지의 방식 그대로이며 호출부 변경은 없습니다. 타입 인자 없는 `$fetch(url)`의 결과는 `unknown`이므로 결과를 쓰려면 타입 인자를 주세요. 래퍼는 두지 않습니다(표가 비어 있으면 줄 이득이 없음).

## 결과

- `pnpm --filter web typecheck`: 라우트를 120개(`__probe`의 정적 GET 60개 + 동적 `[id]` POST 60개) 더해도 통과(검증 뒤 삭제). 소요 시간은 표가 있을 때 약 26초 → 약 19초(같은 기기, 각 두 번 잰 값).
- 잃는 것: 제네릭 없는 `$fetch(url, opts)` 호출(지금 33곳, 대부분 결과를 쓰지 않는 DELETE·POST)의 **메서드 검사**(예: `POST`만 있는 경로에 `PUT`)와 **응답 타입 추론**. 타입 인자를 준 호출(190곳 넘게)은 원래 요청 타입이 표 전체 합집합이라 메서드 검사도, 표에서 온 응답 타입도 없었으므로(주어진 DTO가 그대로 응답 타입) 바뀌지 않습니다. URL 오타는 원래도 잡지 않았습니다(`NitroFetchRequest`에 `string`이 들어 있음).
- DTO와 서버 handler 반환값의 일치는 지금처럼 handler가 DTO 타입을 반환하도록 쓰고 통합 테스트·E2E로 확인합니다. 표가 이 일치를 검사한 적은 없습니다(타입 인자를 주면 표의 응답 타입을 쓰지 않음).
- 서버 코드는 `$fetch`로 자기 API를 부르지 않으므로 영향이 없습니다. 테스트 tsconfig(`test/tsconfig.json`)는 Nuxt 생성 타입을 쓰지 않습니다.
- 다시 켜는 조건: nitro(또는 Nuxt)를 올릴 때 경로 고르기 타입이 라우트 수에 덜 민감해졌거나 표를 일부 경로로만 좁히는 공식 설정이 생기면 그때 다시 봅니다.

## 대안

- **`/api/internal/**`처럼 화면이 부르지 않는 경로만 더 빼기**(S-03 방식): 화면이 부르는 경로만 해도 200개가 넘어 S-04에서 다시 넘습니다.
- **타입 인자를 준 호출을 래퍼(`apiFetch<T>(url: string, …)`)로 바꾸고 표는 유지**: 제곱 비용은 없어지지만 위 재현처럼 제네릭 없는 템플릿 URL 호출이 같은 한도에 걸리고, 196곳을 바꾸고도 `useFetch`는 자동 키(이름으로 붙음) 때문에 감쌀 수 없어 `useFetch<T, NuxtError, string>`처럼 써야 했습니다. 제네릭 없는 호출까지 래퍼로 바꾸면 표를 비운 것과 타입 안전성은 같고 변경만 큽니다.
- **표를 유지하고 제네릭 없는 호출 + 결과 타입 주석(`const x: Dto = await $fetch(url)`)으로 서버 응답과 DTO를 맞춰 보기**: 가장 강한 검사지만 호출마다 경로 고르기 비용이 들어 같은 한도에 걸립니다.
- **nitropack 타입 패치(pnpm patch)**: lockfile·업그레이드 부담이 크고 생성 타입보다 고치기 어렵습니다.
