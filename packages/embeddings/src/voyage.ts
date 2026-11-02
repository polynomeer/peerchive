/**
 * Voyage AI 임베딩 어댑터 (E-05, ADR 0055). Anthropic은 임베딩 API가 없고 문서에서 Voyage AI를 권합니다.
 *
 * - `POST https://api.voyageai.com/v1/embeddings`, `Authorization: Bearer <VOYAGE_API_KEY>`,
 *   본문 `{ input: string[], model, input_type: 'document'|'query', output_dimension, truncation: true }`.
 *   응답 `{ object: 'list', data: [{ object: 'embedding', embedding: number[], index }], model, usage: { total_tokens } }`.
 *   (2026-11 docs.voyageai.com 확인: 요청당 글 최대 1,000개, voyage-4-lite는 요청당 1M 토큰, `output_dimension` 256·512·1024·2048.)
 * - 글을 로그에 남기지 않습니다. 오류 메시지에도 상태 코드만 싣습니다(응답 본문·입력 글 없음).
 * - 429·5xx·네트워크 오류는 `retryable`(재시도·속도 제한은 부르는 쪽 `withRetry`·`RateGate`).
 */
import { type EmbeddingInputType, type EmbeddingProvider, EmbeddingProviderError, checkVectors } from './provider'

export const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings'
/** 기본 모델(2026-11 현재 Voyage 4 계열의 가벼운 모델). `PEERCHIVE_EMBEDDINGS_MODEL`로 바꿉니다. */
export const VOYAGE_DEFAULT_MODEL = 'voyage-4-lite'
/** 기본 차원. 저장 크기를 줄이려 512(모델 기본 1024보다 작음). */
export const VOYAGE_DEFAULT_DIMS = 512
export const VOYAGE_ALLOWED_DIMS = [256, 512, 1024, 2048] as const
/** 요청당 글 수 상한(Voyage 1,000). 부르는 쪽 배치 크기가 이보다 크면 나눕니다. */
export const VOYAGE_MAX_BATCH = 1000

export interface VoyageOptions {
  apiKey: string
  model?: string
  dims?: number
  /** 테스트에서 가짜 fetch를 넣습니다(네트워크 없음). */
  fetch?: typeof fetch
  endpoint?: string
  /** 요청 제한 시간(ms). */
  timeoutMs?: number
}

function retryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 5 * 60_000) : null
}

export function createVoyageProvider(options: VoyageOptions): EmbeddingProvider {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error('VOYAGE_API_KEY is empty')
  const model = options.model?.trim() || VOYAGE_DEFAULT_MODEL
  const dims = options.dims ?? VOYAGE_DEFAULT_DIMS
  if (!(VOYAGE_ALLOWED_DIMS as readonly number[]).includes(dims)) throw new Error(`embedding dims must be one of ${VOYAGE_ALLOWED_DIMS.join(', ')}`)
  const doFetch = options.fetch ?? globalThis.fetch
  const endpoint = options.endpoint ?? VOYAGE_ENDPOINT
  const timeoutMs = options.timeoutMs ?? 30_000

  async function embedBatch(texts: readonly string[], inputType: EmbeddingInputType): Promise<number[][]> {
    let response: Response
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ input: texts, model, input_type: inputType, output_dimension: dims, truncation: true }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      throw new EmbeddingProviderError('voyage request failed', null, true)
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      throw new EmbeddingProviderError(`voyage responded ${response.status}`, response.status, retryable, retryAfter(response.headers.get('retry-after')))
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new EmbeddingProviderError('voyage response is not JSON', response.status, false)
    }
    const data = (body as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) throw new EmbeddingProviderError('voyage response has no data', response.status, false)
    const ordered = [...data].sort((a, b) => Number((a as { index?: number }).index) - Number((b as { index?: number }).index))
    return checkVectors(
      ordered.map((d) => (d as { embedding?: unknown }).embedding),
      texts.length,
      dims,
    )
  }

  return {
    name: 'voyage',
    model,
    dims,
    async embed(texts, inputType = 'document') {
      const out: number[][] = []
      for (let i = 0; i < texts.length; i += VOYAGE_MAX_BATCH) out.push(...(await embedBatch(texts.slice(i, i + VOYAGE_MAX_BATCH), inputType)))
      return out
    },
  }
}
