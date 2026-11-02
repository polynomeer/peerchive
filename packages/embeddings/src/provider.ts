/**
 * 임베딩 공급자 인터페이스와 벡터 도구 (E-05, ADR 0055).
 *
 * - 공급자는 글 목록을 같은 길이·같은 차원의 벡터 목록으로 바꿉니다. 어떤 글을 보낼지는 부르는 쪽이 정하며,
 *   Peerchive는 **공개 스냅샷의 막힘·해결 글**(worker)과 **사용자가 입력한 검색어**(웹, 저장·로그 없음)만 보냅니다.
 * - 저장하는 벡터는 단위 길이로 정규화합니다(코사인 유사도 = 내적). pgvector로 옮겨도 같은 값입니다.
 * - 내용 해시는 (모델, 차원, 글)의 SHA-256입니다. 같은 글을 다시 임베딩하지 않도록 비교에만 씁니다.
 */
import { createHash } from 'node:crypto'

/** 문서(색인할 글) 또는 검색어. Voyage는 `input_type`으로 구분해 검색 품질을 높입니다. */
export type EmbeddingInputType = 'document' | 'query'

export interface EmbeddingProvider {
  /** 공급자 이름(`voyage`·`fake`). */
  readonly name: string
  /** 모델 이름. 저장한 벡터와 지금 공급자의 모델이 다르면 비교하지 않습니다. */
  readonly model: string
  /** 벡터 차원. */
  readonly dims: number
  /** 글마다 벡터 하나(입력 순서 그대로). 실패하면 throw(`EmbeddingProviderError`). */
  embed(texts: readonly string[], inputType?: EmbeddingInputType): Promise<number[][]>
}

/** 공급자 호출 실패. `retryable`이면 재시도 대상(429·5xx·네트워크). */
export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    /** 서버가 알려 준 재시도 대기(ms, Retry-After). */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message)
    this.name = 'EmbeddingProviderError'
  }
}

/** 단위 길이로 정규화(영벡터는 그대로 0). 저장·비교 전에 부릅니다. */
export function normalizeVector(vector: readonly number[]): number[] {
  let sum = 0
  for (const v of vector) sum += v * v
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return vector.map(() => 0)
  return vector.map((v) => v / norm)
}

/** 코사인 유사도(길이가 다르면 0). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** (모델, 차원, 글)의 내용 해시(hex). */
export function embeddingContentHash(model: string, dims: number, text: string): string {
  return createHash('sha256').update(`${model}\n${dims}\n${text}`, 'utf8').digest('hex')
}

/** 공급자 응답 검사: 개수·차원·유한한 수. 틀리면 재시도하지 않는 오류. */
export function checkVectors(vectors: unknown, count: number, dims: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new EmbeddingProviderError('embedding count mismatch', null, false)
  return vectors.map((v) => {
    if (!Array.isArray(v) || v.length !== dims || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      throw new EmbeddingProviderError('embedding dimension mismatch', null, false)
    }
    return v as number[]
  })
}
