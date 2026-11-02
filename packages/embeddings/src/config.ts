/**
 * 임베딩 설정 해석 (E-05, ADR 0055). 웹(검색어 임베딩)과 worker(공개 막힘 색인)가 같은 값을 읽습니다.
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_EMBEDDINGS_PROVIDER | (없음 = 꺼짐) | `voyage`면 Voyage AI(아래 키가 있어야 켜짐). `fake`는 NODE_ENV=test에서만. 그 밖의 값은 꺼짐 |
 * | VOYAGE_API_KEY | — | Voyage API 키. 없으면 꺼짐 |
 * | PEERCHIVE_EMBEDDINGS_MODEL | voyage-4-lite | 모델. 바꾸면 기존 벡터는 비교에서 빠지고 다음 실행부터 새로 임베딩 |
 * | PEERCHIVE_EMBEDDINGS_DIMS | 512 | 차원(256·512·1024·2048) |
 * | PEERCHIVE_EMBEDDINGS_MAX_ITEMS_PER_RUN | 200 | 비용 상한: worker 한 번 실행에 공급자로 보내는 글 수(0이면 보내지 않음) |
 * | PEERCHIVE_EMBEDDINGS_BATCH_SIZE | 64 | 요청 하나에 담는 글 수(1~1000) |
 * | PEERCHIVE_EMBEDDINGS_RPM | 60 | worker의 분당 요청 수 상한 |
 * | PEERCHIVE_EMBEDDINGS_QUERY_PER_MINUTE | 10 | 웹 "의미로 찾기" 검색어 임베딩: IP마다 분당 |
 * | PEERCHIVE_EMBEDDINGS_QUERY_PER_HOUR | 300 | 웹 검색어 임베딩: 서버 전체 시간당(비용 상한) |
 *
 * 공급자가 없으면 의미 검색 기능 전체가 꺼지고(API 404, 화면 진입점 숨김) 키워드 검색은 그대로입니다.
 */
import { createFakeEmbeddingProvider } from './fake'
import type { EmbeddingProvider } from './provider'
import { VOYAGE_ALLOWED_DIMS, VOYAGE_DEFAULT_DIMS, VOYAGE_DEFAULT_MODEL, createVoyageProvider } from './voyage'

export type EmbeddingsEnv = Readonly<Record<string, string | undefined>>

export const EMBEDDINGS_ENV_NAMES = [
  'NODE_ENV',
  'PEERCHIVE_EMBEDDINGS_PROVIDER',
  'VOYAGE_API_KEY',
  'PEERCHIVE_EMBEDDINGS_MODEL',
  'PEERCHIVE_EMBEDDINGS_DIMS',
  'PEERCHIVE_EMBEDDINGS_MAX_ITEMS_PER_RUN',
  'PEERCHIVE_EMBEDDINGS_BATCH_SIZE',
  'PEERCHIVE_EMBEDDINGS_RPM',
  'PEERCHIVE_EMBEDDINGS_QUERY_PER_MINUTE',
  'PEERCHIVE_EMBEDDINGS_QUERY_PER_HOUR',
] as const

export interface EmbeddingLimits {
  maxItemsPerRun: number
  batchSize: number
  requestsPerMinute: number
  queryPerMinutePerClient: number
  queryPerHourTotal: number
}

export const DEFAULT_EMBEDDING_LIMITS: EmbeddingLimits = {
  maxItemsPerRun: 200,
  batchSize: 64,
  requestsPerMinute: 60,
  queryPerMinutePerClient: 10,
  queryPerHourTotal: 300,
}

function intIn(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim()
  if (!value) return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

export function parseEmbeddingLimits(env: EmbeddingsEnv): EmbeddingLimits {
  const d = DEFAULT_EMBEDDING_LIMITS
  return {
    maxItemsPerRun: intIn(env.PEERCHIVE_EMBEDDINGS_MAX_ITEMS_PER_RUN, d.maxItemsPerRun, 0, 100_000),
    batchSize: intIn(env.PEERCHIVE_EMBEDDINGS_BATCH_SIZE, d.batchSize, 1, 1000),
    requestsPerMinute: intIn(env.PEERCHIVE_EMBEDDINGS_RPM, d.requestsPerMinute, 1, 10_000),
    queryPerMinutePerClient: intIn(env.PEERCHIVE_EMBEDDINGS_QUERY_PER_MINUTE, d.queryPerMinutePerClient, 1, 1000),
    queryPerHourTotal: intIn(env.PEERCHIVE_EMBEDDINGS_QUERY_PER_HOUR, d.queryPerHourTotal, 1, 1_000_000),
  }
}

/** 설정한 공급자 종류. 켜질 수 없는 설정이면 null(키 없음·알 수 없는 값·test 밖의 fake). */
export function embeddingProviderKind(env: EmbeddingsEnv): 'voyage' | 'fake' | null {
  const kind = env.PEERCHIVE_EMBEDDINGS_PROVIDER?.trim().toLowerCase() ?? ''
  if (kind === 'voyage') return env.VOYAGE_API_KEY?.trim() ? 'voyage' : null
  if (kind === 'fake') return env.NODE_ENV === 'test' ? 'fake' : null
  return null
}

/** 환경 변수로 공급자를 만듭니다. 꺼져 있으면 null. 차원이 틀리면 기본값. */
export function resolveEmbeddingProvider(env: EmbeddingsEnv, options: { fetch?: typeof fetch } = {}): EmbeddingProvider | null {
  const kind = embeddingProviderKind(env)
  if (!kind) return null
  const dims = intIn(env.PEERCHIVE_EMBEDDINGS_DIMS, VOYAGE_DEFAULT_DIMS, 1, 4096)
  if (kind === 'fake') return createFakeEmbeddingProvider({ dims: intIn(env.PEERCHIVE_EMBEDDINGS_DIMS, 64, 1, 4096), env })
  return createVoyageProvider({
    apiKey: env.VOYAGE_API_KEY!,
    model: env.PEERCHIVE_EMBEDDINGS_MODEL?.trim() || VOYAGE_DEFAULT_MODEL,
    dims: (VOYAGE_ALLOWED_DIMS as readonly number[]).includes(dims) ? dims : VOYAGE_DEFAULT_DIMS,
    ...(options.fetch && { fetch: options.fetch }),
  })
}
