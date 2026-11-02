/**
 * E-05 임베딩 공급자: 설정 해석(키 없으면 꺼짐, fake는 test에서만), Voyage 요청 모양(가짜 fetch, 네트워크 없음),
 * 결정적 가짜 공급자의 유사도 정렬, 재시도·속도 제한.
 */
import { describe, expect, it } from 'vitest'
import {
  EmbeddingProviderError,
  FAKE_MODEL,
  RateGate,
  VOYAGE_DEFAULT_MODEL,
  VOYAGE_ENDPOINT,
  cosineSimilarity,
  createFakeEmbeddingProvider,
  createVoyageProvider,
  embeddingContentHash,
  embeddingProviderKind,
  normalizeVector,
  parseEmbeddingLimits,
  resolveEmbeddingProvider,
  withRetry,
} from '../src'

function mockFetch(respond: (body: Record<string, unknown>) => Response) {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url: String(url), init: init!, body })
    return respond(body)
  }) as typeof fetch
  return { fn, requests }
}

const vectorsFor = (body: Record<string, unknown>, dims: number) =>
  new Response(
    JSON.stringify({
      object: 'list',
      // 순서를 뒤집어 보내도 index로 맞춥니다.
      data: (body.input as string[]).map((_, index) => ({ object: 'embedding', embedding: Array.from({ length: dims }, () => index + 1), index })).reverse(),
      model: body.model,
      usage: { total_tokens: 3 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )

describe('embedding config', () => {
  it('is off unless provider=voyage and a key are both set; fake only under NODE_ENV=test', () => {
    expect(embeddingProviderKind({})).toBeNull()
    expect(embeddingProviderKind({ PEERCHIVE_EMBEDDINGS_PROVIDER: 'voyage' })).toBeNull()
    expect(embeddingProviderKind({ VOYAGE_API_KEY: 'k' })).toBeNull()
    expect(embeddingProviderKind({ PEERCHIVE_EMBEDDINGS_PROVIDER: 'voyage', VOYAGE_API_KEY: ' k ' })).toBe('voyage')
    expect(embeddingProviderKind({ PEERCHIVE_EMBEDDINGS_PROVIDER: 'openai', VOYAGE_API_KEY: 'k' })).toBeNull()
    expect(embeddingProviderKind({ PEERCHIVE_EMBEDDINGS_PROVIDER: 'fake', NODE_ENV: 'production' })).toBeNull()
    expect(embeddingProviderKind({ PEERCHIVE_EMBEDDINGS_PROVIDER: 'fake', NODE_ENV: 'test' })).toBe('fake')
    expect(resolveEmbeddingProvider({})).toBeNull()
    expect(() => createFakeEmbeddingProvider({ env: { NODE_ENV: 'development' } })).toThrow(/NODE_ENV=test/)
    const voyage = resolveEmbeddingProvider({ PEERCHIVE_EMBEDDINGS_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k', PEERCHIVE_EMBEDDINGS_DIMS: '300' })!
    expect([voyage.name, voyage.model, voyage.dims]).toEqual(['voyage', VOYAGE_DEFAULT_MODEL, 512])
    const custom = resolveEmbeddingProvider({ PEERCHIVE_EMBEDDINGS_PROVIDER: 'voyage', VOYAGE_API_KEY: 'k', PEERCHIVE_EMBEDDINGS_MODEL: 'voyage-3.5-lite', PEERCHIVE_EMBEDDINGS_DIMS: '256' })!
    expect([custom.model, custom.dims]).toEqual(['voyage-3.5-lite', 256])
  })

  it('parses limits with safe fallbacks (cost guard 0 allowed)', () => {
    expect(parseEmbeddingLimits({})).toEqual({ maxItemsPerRun: 200, batchSize: 64, requestsPerMinute: 60, queryPerMinutePerClient: 10, queryPerHourTotal: 300 })
    const l = parseEmbeddingLimits({ PEERCHIVE_EMBEDDINGS_MAX_ITEMS_PER_RUN: '0', PEERCHIVE_EMBEDDINGS_BATCH_SIZE: '5000', PEERCHIVE_EMBEDDINGS_RPM: 'x' })
    expect([l.maxItemsPerRun, l.batchSize, l.requestsPerMinute]).toEqual([0, 64, 60])
  })
})

describe('Voyage adapter (mocked fetch, no network)', () => {
  it('posts input/model/input_type/output_dimension with a bearer key and orders vectors by index', async () => {
    const { fn, requests } = mockFetch((body) => vectorsFor(body, 256))
    const provider = createVoyageProvider({ apiKey: 'secret-key', dims: 256, fetch: fn })
    const out = await provider.embed(['막힘 하나', '막힘 둘'], 'query')
    expect(out.map((v) => v[0])).toEqual([1, 2])
    expect(requests).toHaveLength(1)
    const [req] = requests
    expect(req!.url).toBe(VOYAGE_ENDPOINT)
    expect(req!.init.method).toBe('POST')
    expect((req!.init.headers as Record<string, string>).authorization).toBe('Bearer secret-key')
    expect(req!.body).toEqual({ input: ['막힘 하나', '막힘 둘'], model: VOYAGE_DEFAULT_MODEL, input_type: 'query', output_dimension: 256, truncation: true })
  })

  it('splits into requests of at most 1000 texts', async () => {
    const { fn, requests } = mockFetch((body) => vectorsFor(body, 256))
    const provider = createVoyageProvider({ apiKey: 'k', dims: 256, fetch: fn })
    expect(await provider.embed(Array.from({ length: 1001 }, (_, i) => `t${i}`))).toHaveLength(1001)
    expect(requests.map((r) => (r.body.input as string[]).length)).toEqual([1000, 1])
    expect(requests[0]!.body.input_type).toBe('document')
  })

  it('maps 429/5xx to retryable errors (with Retry-After) and rejects bad shapes; errors carry no input text', async () => {
    const limited = createVoyageProvider({ apiKey: 'k', dims: 256, fetch: mockFetch(() => new Response('{"detail":"slow"}', { status: 429, headers: { 'retry-after': '2' } })).fn })
    const error = await limited.embed(['비밀 아님']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EmbeddingProviderError)
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 })
    expect(String((error as Error).message)).not.toContain('비밀')
    const bad = createVoyageProvider({ apiKey: 'k', dims: 256, fetch: mockFetch(() => new Response('{"detail":"x"}', { status: 400 })).fn })
    await expect(bad.embed(['a'])).rejects.toMatchObject({ status: 400, retryable: false })
    const wrongDims = createVoyageProvider({ apiKey: 'k', dims: 256, fetch: mockFetch((b) => vectorsFor(b, 3)).fn })
    await expect(wrongDims.embed(['a'])).rejects.toMatchObject({ retryable: false })
    expect(() => createVoyageProvider({ apiKey: 'k', dims: 300 })).toThrow()
    expect(() => createVoyageProvider({ apiKey: ' ' })).toThrow()
  })
})

describe('fake provider and vector helpers', () => {
  it('is deterministic, records calls, and ranks textually similar inputs higher', async () => {
    const fake = createFakeEmbeddingProvider({ dims: 128 })
    expect(fake.model).toBe(FAKE_MODEL)
    const [q, a, b] = await fake.embed(['좀비 프로세스가 남음', '좀비 프로세스가 계속 남아요', 'CSS 그리드가 깨짐'])
    expect(cosineSimilarity(q!, a!)).toBeGreaterThan(cosineSimilarity(q!, b!))
    expect(await fake.embed(['좀비 프로세스가 남음'])).toEqual([q])
    expect(fake.calls.map((c) => c.texts.length)).toEqual([3, 1])
  })

  it('normalizes vectors and hashes (model, dims, text)', () => {
    const n = normalizeVector([3, 4])
    expect(n[0]).toBeCloseTo(0.6)
    expect(n[1]).toBeCloseTo(0.8)
    expect(normalizeVector([0, 0])).toEqual([0, 0])
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [1])).toBe(0)
    const h = embeddingContentHash('m', 8, '글')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(embeddingContentHash('m2', 8, '글')).not.toBe(h)
    expect(embeddingContentHash('m', 16, '글')).not.toBe(h)
  })
})

describe('retry and rate gate', () => {
  it('retries retryable errors with backoff (honoring Retry-After) and stops on others', async () => {
    const sleeps: number[] = []
    let n = 0
    const out = await withRetry(
      async () => {
        n++
        if (n === 1) throw new EmbeddingProviderError('429', 429, true, 5000)
        if (n === 2) throw new EmbeddingProviderError('503', 503, true)
        return 'ok'
      },
      { attempts: 4, baseDelayMs: 100, maxDelayMs: 1000, sleep: async (ms) => void sleeps.push(ms) },
    )
    expect(out).toBe('ok')
    expect(sleeps).toEqual([5000, 200])
    let m = 0
    await expect(
      withRetry(
        async () => {
          m++
          throw new EmbeddingProviderError('400', 400, false)
        },
        { attempts: 4, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} },
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(m).toBe(1)
  })

  it('spaces requests by 60s / rpm', async () => {
    let now = 0
    const sleeps: number[] = []
    const gate = RateGate.perMinute(30, async (ms) => {
      sleeps.push(ms)
      now += ms
    }, () => now)
    await gate.wait()
    await gate.wait()
    await gate.wait()
    expect(sleeps).toEqual([2000, 2000])
  })
})
