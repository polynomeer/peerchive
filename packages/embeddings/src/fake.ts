/**
 * 테스트 전용 결정적 가짜 공급자 (E-05, ADR 0055). 네트워크를 쓰지 않습니다.
 *
 * - 글을 정규화(NFKC·소문자)한 뒤 문자 bigram을 해시해 차원에 더한 벡터를 돌려줍니다. 같은 글은 늘 같은 벡터이고,
 *   글자를 많이 공유하는 글끼리 코사인 유사도가 높습니다(정렬 검사용).
 * - `NODE_ENV=test`가 아니면 만들 수 없습니다(실서비스에서 의미 없는 결과를 내지 않게).
 * - `calls`에 받은 글을 기록합니다(테스트가 "비공개 글을 보내지 않았다"를 확인).
 */
import type { EmbeddingInputType, EmbeddingProvider } from './provider'

export const FAKE_MODEL = 'fake-bigram-v1'

export interface FakeEmbeddingProvider extends EmbeddingProvider {
  readonly calls: Array<{ texts: string[]; inputType: EmbeddingInputType }>
  /** 다음 n번 호출을 실패시킵니다(재시도 테스트). */
  failNext(n: number, error?: Error): void
}

function hash32(value: string): number {
  // FNV-1a
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 결정적 bigram 해시 벡터(정규화하지 않음). */
export function fakeVector(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0)
  const chars = [...text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()]
  if (chars.length === 1) v[hash32(chars[0]!) % dims]! += 1
  for (let i = 0; i + 1 < chars.length; i++) {
    const gram = chars[i]! + chars[i + 1]!
    if (gram.trim().length < 2) continue
    v[hash32(gram) % dims]! += 1
  }
  return v
}

export function createFakeEmbeddingProvider(options: { dims?: number; env?: Readonly<Record<string, string | undefined>> } = {}): FakeEmbeddingProvider {
  const env = options.env ?? (globalThis.process?.env as Record<string, string | undefined> | undefined) ?? {}
  if (env.NODE_ENV !== 'test') throw new Error('fake embedding provider is only available when NODE_ENV=test')
  const dims = options.dims ?? 64
  const calls: FakeEmbeddingProvider['calls'] = []
  let failures: Error[] = []
  return {
    name: 'fake',
    model: FAKE_MODEL,
    dims,
    calls,
    failNext(n, error = new Error('fake failure')) {
      failures = Array.from({ length: n }, () => error)
    },
    async embed(texts, inputType = 'document') {
      calls.push({ texts: [...texts], inputType })
      const failure = failures.shift()
      if (failure) throw failure
      return texts.map((t) => fakeVector(t, dims))
    },
  }
}
