/**
 * Claude API 어댑터 (E-12, ADR 0057). 공식 `@anthropic-ai/sdk`만 씁니다(직접 fetch·호환 shim 없음).
 *
 * 요청 모양(claude-api 지침 기준, 2026-11):
 * - `client.beta.messages.create` + `betas: ['server-side-fallback-2026-07-01']` + `fallbacks: 'default'`:
 *   안전 분류기가 거절하면 API가 같은 요청을 Anthropic 권장 대체 모델에서 다시 돌립니다(분류별 라우팅). `PEERCHIVE_AI_FALLBACKS=off`면 뺍니다.
 *   `"default"` 스칼라 형은 `-2026-07-01` 헤더와만 짝입니다(배열 형은 `-2026-06-01`, 섞으면 400).
 * - 구조화 출력: `output_config.format`에 zod 스키마에서 만든 JSON Schema(`betaZodOutputFormat`)를 넣고, 응답은 **`stop_reason`을 먼저 본 뒤**
 *   텍스트를 JSON.parse + zod로 직접 검증합니다. SDK의 `parse()`는 출력이 잘린 경우(`max_tokens`)에도 먼저 파싱하다 예외를 던지고
 *   그 메시지에 출력 일부가 섞일 수 있어 쓰지 않습니다.
 * - `thinking`은 보내지 않습니다(Claude Opus 5.5는 늘 adaptive, `disabled`는 400). 깊이는 `output_config.effort`로 라우트마다 고정합니다.
 * - `temperature`·`top_p`·`top_k`·assistant prefill은 보내지 않습니다(Opus 5.5에서 400).
 * - 프롬프트 캐싱: 고정 system 블록에 `cache_control`(5분), 요청마다 바뀌는 내용은 그 뒤 messages에만 둡니다.
 *   (system이 최소 캐시 길이 512토큰보다 짧으면 표시가 있어도 조용히 캐시되지 않습니다 — 오류 아님.)
 * - 클라이언트 `timeout`(ms)·`maxRetries`(SDK가 429·5xx·연결 오류를 지수 백오프로 재시도).
 * - 인증: 서버의 `ANTHROPIC_API_KEY`만 `apiKey`로 넘깁니다. SDK 1.x는 이 키를 `Authorization: Bearer`로 보내고, 넘긴 자격 증명 하나만 씁니다(환경 변수·디스크를 더 찾지 않음).
 * - API 버전: SDK 기본값(`2026-10-21`)을 그대로 씁니다. 코드에서 정하지 않습니다.
 * - 오류는 SDK 타입 오류 클래스로만 분류합니다(메시지 문자열 비교 없음). 공급자 응답 본문·입력 글은 오류에 싣지 않습니다.
 */
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import {
  AiError,
  type AiProvider,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage,
  checkMessages,
} from './provider'

/** 서버 쪽 거절 대체(`fallbacks: "default"`) beta 헤더. */
export const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export interface AnthropicProviderOptions {
  apiKey: string
  model: string
  timeoutMs: number
  maxRetries: number
  /** 서버 쪽 거절 대체를 켤지(기본 켬). */
  fallbacks: boolean
  /** 테스트에서 가짜 fetch를 넣습니다(네트워크 없음). */
  fetch?: typeof fetch
  baseURL?: string
}

function usageOf(usage: Anthropic.Beta.BetaUsage | null | undefined): AiUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadInputTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage?.cache_creation_input_tokens ?? 0,
  }
}

/** SDK 오류 → AiError. SDK 밖의 오류(프로그래밍 오류)는 그대로 던집니다. */
export function mapAnthropicError(error: unknown): unknown {
  if (error instanceof AiError) return error
  // 구체적인 것부터: 429 → 연결(시간 초과 포함) → 그 밖의 상태 오류 → SDK 기본 오류.
  if (error instanceof Anthropic.RateLimitError) return new AiError('rate_limited', 429)
  if (error instanceof Anthropic.APIConnectionError) return new AiError('unavailable', null)
  if (error instanceof Anthropic.APIError) return new AiError('unavailable', typeof error.status === 'number' ? error.status : null)
  if (error instanceof Anthropic.AnthropicError) return new AiError('unavailable', null)
  return error
}

/** 응답의 텍스트 블록을 이어 붙입니다(생각·대체 표시 블록은 건너뜀). */
function textOf(content: readonly Anthropic.Beta.BetaContentBlock[]): string {
  let out = ''
  for (const block of content) if (block.type === 'text') out += block.text
  return out
}

export function createAnthropicProvider(options: AnthropicProviderOptions): AiProvider {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is empty')
  const client = new Anthropic({
    apiKey,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.baseURL && { baseURL: options.baseURL }),
  })
  const model = options.model

  return {
    name: 'anthropic',
    model,
    async generateStructured<T>(request: AiStructuredRequest<T>): Promise<AiStructuredResult<T>> {
      checkMessages(request.messages)
      // parse 함수는 요청 본문에 넣지 않습니다(JSON Schema만).
      const { parse: _parse, ...format } = betaZodOutputFormat(request.schema)
      let response: Anthropic.Beta.BetaMessage
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: request.maxTokens,
          ...(options.fallbacks && { betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: 'default' as const }),
          system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
          messages: request.messages.map((m) => ({ role: m.role, content: m.text })),
          output_config: { effort: request.effort, format },
        })
      } catch (error) {
        throw mapAnthropicError(error)
      }
      const usage = usageOf(response.usage)
      // stop_reason을 먼저 봅니다. 거절이면 content가 비었거나 부분일 수 있으므로 읽지 않습니다.
      if (response.stop_reason === 'refusal') {
        throw new AiError('refusal', null, usage, response.stop_details?.category ?? null)
      }
      if (response.stop_reason === 'max_tokens' || response.stop_reason === 'model_context_window_exceeded') {
        throw new AiError('max_tokens', null, usage)
      }
      if (response.stop_reason !== 'end_turn') throw new AiError('invalid_output', null, usage)
      let parsed: unknown
      try {
        parsed = JSON.parse(textOf(response.content))
      } catch {
        throw new AiError('invalid_output', null, usage)
      }
      const checked = request.schema.safeParse(parsed)
      if (!checked.success) throw new AiError('invalid_output', null, usage)
      const fallback = (response.usage.iterations ?? []).some((entry) => entry.type === 'fallback_message')
      return { data: checked.data, usage, model: response.model, fallback }
    },
  }
}
