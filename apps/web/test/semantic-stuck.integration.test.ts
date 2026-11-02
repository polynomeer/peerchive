/**
 * E-05 유사 막힘 의미 검색 통합 테스트(실제 PostgreSQL, rollback, 결정적 가짜 공급자 — 네트워크 없음). DATABASE_URL이 없으면 DB 테스트는 건너뜁니다.
 * 검색 문서·벡터는 worker가 만드는 파생 데이터이므로 여기서는 같은 도메인·임베딩 함수로 직접 넣습니다(worker 자체는 apps/worker 테스트).
 * - 공급자가 없으면 두 경로 모두 404, features.semanticStuck false, 키워드 검색 결과는 공급자 유무와 같음.
 * - 비슷한 막힘 정렬(가짜 벡터), 자기 자신 제외, 철회·운영 조치 가림·엠바고는 다음 요청부터 제외(worker 정리 없이), 원본 카드가 안 보이면 404.
 * - 검색어 임베딩: input_type query, 검색어를 DB(한도 버킷·감사)·로그에 남기지 않음, IP마다 한도 429, 결과에 비공개 글 없음.
 */
import { createApp, createRouter, toWebHandler } from 'h3'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  auditEvents,
  eq,
  moderationActions,
  operators,
  publicationCandidates,
  publications,
  rateLimitBuckets,
  releaseHiddenItems,
  searchDocuments,
  sql,
  stuckEmbeddings,
  type DbExecutor,
} from '@peerchive/db'
import { type HubSnapshot, searchDocsFromSnapshot, stuckEmbeddingSources } from '@peerchive/domain'
import { type FakeEmbeddingProvider, createFakeEmbeddingProvider, embeddingContentHash, normalizeVector } from '@peerchive/embeddings'
import {
  semanticStuckEnabled,
  semanticStuckSearch,
  setEmbeddingProviderForTesting,
  similarToStuckCard,
} from '../server/modules/course-hub/similar-stuck'
import { createSemanticSearchHandler, createSimilarStuckHandler } from '../server/modules/course-hub/public-http'
import { searchPublic } from '../server/modules/course-hub/search'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { createLog } from '../server/modules/logs/logs'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { getPublicPublication } from '../server/modules/publication/public-read'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

/** 막힘(+해결) 하나를 게시하고, 같은 과제에 공개하지 않은 비공개 막힘 로그도 하나 둡니다. */
async function publishStuck(db: DbExecutor, owner: string, symptom: string, solution: string | null, privateText: string) {
  const actor = { userId: owner }
  const project = await createProject(db, actor, { title: '과제' }, T0)
  const stuck = (
    await createLog(db, actor, project.id, { tag: 'stuck', payload: { symptom, keywords: [], attempts: [privateText], timeBucket: 'half_day', answerCheck: true }, links: [] }, at(1))
  ).log
  const logIds = [stuck.id]
  if (solution) {
    const sol = (
      await createLog(db, actor, project.id, { tag: 'solution', payload: { method: solution, notAnswerConfirmed: true }, resolvesEntryId: stuck.id, links: [] }, at(1))
    ).log
    logIds.push(sol.id)
  }
  // 비공개(게시하지 않은) 막힘 로그.
  await createLog(db, actor, project.id, { tag: 'stuck', payload: { symptom: privateText, keywords: [], timeBucket: 'half_day', answerCheck: true }, links: [] }, at(1))
  const candidate = await createCandidate(
    db,
    actor,
    project.id,
    { level: 'summary', title: '공개 사례', summary: '요약', slug: `case-${token()}`, logIds, milestoneIds: [], exposure: { [owner]: 'name' }, consentSelf: true },
    at(2),
    ORIGINS,
  )
  const { publication } = await publishCandidate(db, actor, candidate.id, { manifestHash: candidate.manifestHash }, at(3))
  const pub = await getPublicPublication(db, publication.slug, at(4))
  const key = pub.snapshot.logs.find((l) => l.tag === 'stuck')!.key
  return { project, publication, slug: publication.slug, key }
}

/** worker의 검색 색인 + 임베딩 동기화와 같은 일을 직접 합니다(지금 release 스냅샷의 공개 글만). */
async function indexWithEmbeddings(db: DbExecutor, publicationId: string, provider: FakeEmbeddingProvider) {
  const [row] = await db
    .select({ release: publicationCandidates })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .where(eq(publications.id, publicationId))
  const snapshot = row!.release.snapshot as unknown as HubSnapshot
  for (const doc of searchDocsFromSnapshot(snapshot)) await db.insert(searchDocuments).values({ ...doc, publicationId, releaseId: row!.release.id })
  const sources = stuckEmbeddingSources(snapshot)
  const vectors = await provider.embed(sources.map((s) => s.text), 'document')
  for (const [i, s] of sources.entries()) {
    await db.insert(stuckEmbeddings).values({
      publicationId,
      releaseId: row!.release.id,
      itemKey: s.itemKey,
      model: provider.model,
      dims: provider.dims,
      contentHash: embeddingContentHash(provider.model, provider.dims, s.text),
      embedding: normalizeVector(vectors[i]!),
    })
  }
}

describe.skipIf(!databaseUrl)('E-05 semantic stuck search (PostgreSQL, fake provider)', () => {
  let fake: FakeEmbeddingProvider
  afterAll(closeTestDb)
  beforeEach(() => {
    fake = createFakeEmbeddingProvider({ dims: 64 })
    setEmbeddingProviderForTesting(fake)
  })
  afterEach(() => setEmbeddingProviderForTesting(undefined))

  async function corpus(tx: DbExecutor) {
    const t = token()
    const owner = await createUser(tx, { displayName: '작성자' })
    const a = await publishStuck(tx, owner.id, `${t} 좀비 프로세스가 남음`, `${t} waitpid로 자식 프로세스를 거둠`, `${t}비공개A`)
    const b = await publishStuck(tx, owner.id, `${t} 좀비 프로세스가 계속 남아요`, `${t} waitpid로 거둠`, `${t}비공개B`)
    const c = await publishStuck(tx, owner.id, `${t} CSS 그리드 레이아웃이 깨짐`, null, `${t}비공개C`)
    for (const p of [a, b, c]) await indexWithEmbeddings(tx, p.publication.id, fake)
    return { t, owner, a, b, c }
  }
  const mine = (results: Array<{ path: string }>, slugs: string[]) => results.filter((r) => slugs.some((s) => r.path.startsWith(`/p/${s}#`)))

  it('provider off: both routes 404, feature false, keyword search unchanged', async () => {
    await withRollback(async (tx) => {
      const { t, a } = await corpus(tx)
      const keywordOn = await searchPublic(tx, { q: t }, at(10))
      setEmbeddingProviderForTesting(null)
      expect(semanticStuckEnabled()).toBe(false)
      await expectServiceError(similarToStuckCard(tx, a.slug, a.key, {}, at(10)), 'NOT_FOUND')
      await expectServiceError(semanticStuckSearch(tx, { q: '좀비' }, 'ip-off', at(10)), 'NOT_FOUND')
      expect(await searchPublic(tx, { q: t }, at(10))).toEqual(keywordOn)
      expect(keywordOn.results.filter((r) => r.kind === 'stuck')).toHaveLength(3)
      setEmbeddingProviderForTesting(fake)
      expect(semanticStuckEnabled()).toBe(true)
    })
  })

  it('orders similar stuck items by meaning, excludes the card itself, and returns card fields only', async () => {
    await withRollback(async (tx) => {
      const { t, a, b, c } = await corpus(tx)
      const calls = fake.calls.length
      const out = await similarToStuckCard(tx, a.slug, a.key, {}, at(10))
      expect(fake.calls.length).toBe(calls) // 저장된 벡터만 씀(공급자 호출 없음)
      expect(out.indexed).toBe(true)
      const ours = mine(out.results, [a.slug, b.slug, c.slug])
      expect(ours[0]!.path).toBe(`/p/${b.slug}#public-${b.key}`)
      expect(ours.some((r) => r.path.startsWith(`/p/${a.slug}#`))).toBe(false)
      const cIndex = ours.findIndex((r) => r.path.startsWith(`/p/${c.slug}#`))
      expect(cIndex === -1 || cIndex > 0).toBe(true)
      expect(Object.keys(ours[0]!).sort()).toEqual(['course', 'kind', 'path', 'snippet', 'title'])
      // 결과·임베딩 입력 어디에도 비공개 글이 없습니다.
      expect(JSON.stringify(out)).not.toMatch(new RegExp(`${t}비공개`))
      for (const call of fake.calls) for (const text of call.texts) expect(text).not.toMatch(/비공개/)
      // 형식 오류·없는 카드.
      await expectServiceError(similarToStuckCard(tx, a.slug, a.key, { limit: '99' }, at(10)), 'VALIDATION')
      await expectServiceError(similarToStuckCard(tx, a.slug, 'no_such_key', {}, at(10)), 'NOT_FOUND')
      await expectServiceError(similarToStuckCard(tx, a.slug, '../x', {}, at(10)), 'NOT_FOUND')
    })
  })

  it('withdrawal, moderation hide and embargo drop items on the next request (no worker cleanup)', async () => {
    await withRollback(async (tx) => {
      const { owner, a, b, c } = await corpus(tx)
      const slugs = [a.slug, b.slug, c.slug]
      const paths = async (from = a) => mine((await similarToStuckCard(tx, from.slug, from.key, { limit: '10' }, at(10))).results, slugs).map((r) => r.path.split('#')[0])
      expect(await paths()).toContain(`/p/${b.slug}`)

      // 철회: 벡터·문서 행은 남아 있지만 다음 요청부터 빠지고, 철회된 카드를 원본으로 부르면 404.
      await withdrawPublication(tx, { userId: owner.id }, b.publication.id, {}, at(11))
      expect(await tx.select().from(stuckEmbeddings).where(eq(stuckEmbeddings.publicationId, b.publication.id))).toHaveLength(1)
      expect(await paths()).not.toContain(`/p/${b.slug}`)
      await expectServiceError(similarToStuckCard(tx, b.slug, b.key, {}, at(12)), 'NOT_FOUND')

      // 운영 조치로 가린 카드(C): 가리기 전에는 검색어로 찾힙니다.
      const viaQuery = async () => mine((await semanticStuckSearch(tx, { q: 'CSS 그리드 레이아웃', limit: '10' }, `ip-${token()}`, at(13))).results, slugs)
      expect((await viaQuery()).some((r) => r.path.startsWith(`/p/${c.slug}#`))).toBe(true)
      const op = await createUser(tx, { displayName: '운영자' })
      await tx.insert(operators).values({ userId: op.id })
      const [cRelease] = await tx.select({ id: publications.currentReleaseId }).from(publications).where(eq(publications.id, c.publication.id))
      const [action] = await tx
        .insert(moderationActions)
        .values({
          kind: 'hide_item',
          outcome: 'resolved',
          targetType: 'publication_item',
          targetKey: `publication_item:${c.publication.id}:log:${c.key}`,
          publicationId: c.publication.id,
          releaseId: cRelease!.id!,
          itemKind: 'log',
          itemKey: c.key,
          internalNote: 'n',
          createdBy: op.id,
        })
        .returning()
      await tx.insert(releaseHiddenItems).values({ publicationId: c.publication.id, releaseId: cRelease!.id!, itemKind: 'log', itemKey: c.key, actionId: action!.id })
      expect((await viaQuery()).some((r) => r.path.startsWith(`/p/${c.slug}#`))).toBe(false)
      await expectServiceError(similarToStuckCard(tx, c.slug, c.key, {}, at(13)), 'NOT_FOUND')

      // 엠바고(A): 원본으로도 결과로도 나오지 않습니다.
      const zombie = async () => mine((await semanticStuckSearch(tx, { q: '좀비 프로세스', limit: '10' }, `ip-${token()}`, at(15))).results, slugs)
      expect((await zombie()).map((r) => r.path.split('#')[0])).toEqual([`/p/${a.slug}`])
      await addProjectEmbargo(tx, { userId: owner.id }, a.project.id, { until: '2027-06-01T00:00:00Z', reason: '재수강' }, at(14))
      await expectServiceError(similarToStuckCard(tx, a.slug, a.key, {}, at(15)), 'NOT_FOUND')
      expect(await zombie()).toEqual([])
    })
  })

  it('query text is embedded as a query, never stored or logged, and is rate limited per IP', async () => {
    await withRollback(async (tx) => {
      const { a, b, c } = await corpus(tx)
      // 고유 꼬리는 글자마다 띄어 씁니다: 가짜 공급자는 공백 낀 bigram을 세지 않으므로 무작위 꼬리가 벡터를 흔들지 않습니다
      // (붙여 쓰면 해시 충돌로 약 0.2% 확률로 C가 앞서거나 A·B가 최소 점수 아래로 떨어짐).
      const secret = `좀비 프로세스 질문 ${[...token()].join(' ')}`
      const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')]
      try {
        const ip = `ip-${token()}`
        const out = await semanticStuckSearch(tx, { q: secret }, ip, at(10))
        expect(out.q).toBe(secret)
        expect(fake.calls.at(-1)).toEqual({ texts: [secret], inputType: 'query' })
        const ours = mine(out.results, [a.slug, b.slug, c.slug])
        expect(ours.length).toBeGreaterThanOrEqual(2)
        expect(ours.slice(0, 2).every((r) => !r.path.startsWith(`/p/${c.slug}#`))).toBe(true)
        // DB 어디에도(한도 버킷 키는 해시, 감사 기록 없음) 검색어가 없습니다.
        const [stored] = await tx.execute<{ n: number }>(
          sql`select (select count(*) from ${rateLimitBuckets} where ${rateLimitBuckets.key} like ${`%${secret}%`})::int
            + (select count(*) from ${auditEvents} where ${auditEvents.metadata}::text like ${`%${secret}%`})::int as n`,
        )
        expect(Number(stored!.n)).toBe(0)
        for (const spy of logs) for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(secret)

        // 빈 검색어는 공급자를 부르지 않습니다.
        const calls = fake.calls.length
        expect((await semanticStuckSearch(tx, { q: '  ' }, ip, at(10))).results).toEqual([])
        expect(fake.calls.length).toBe(calls)
        await expectServiceError(semanticStuckSearch(tx, { q: 'x'.repeat(101) }, ip, at(10)), 'VALIDATION')

        // IP마다 분당 한도(기본 10): 같은 분에 11번째는 429.
        const limited = `ip-${token()}`
        for (let i = 0; i < 10; i++) await semanticStuckSearch(tx, { q: '좀비' }, limited, at(20))
        await expectServiceError(semanticStuckSearch(tx, { q: '좀비' }, limited, at(20)), 'RATE_LIMITED')
        // 다른 IP는 영향을 받지 않습니다.
        await semanticStuckSearch(tx, { q: '좀비' }, `ip-${token()}`, at(20))
      } finally {
        for (const spy of logs) spy.mockRestore()
      }
    })
  })

  it('ignores vectors from another model or a replaced release (until the worker re-embeds)', async () => {
    await withRollback(async (tx) => {
      const { a, b } = await corpus(tx)
      const other = createFakeEmbeddingProvider({ dims: 32 })
      setEmbeddingProviderForTesting(other)
      // 차원이 다른 공급자로 바뀌면 저장된 벡터는 비교하지 않습니다.
      expect(await similarToStuckCard(tx, a.slug, a.key, {}, at(10))).toEqual({ indexed: false, results: [] })
      setEmbeddingProviderForTesting(fake)
      await tx.update(stuckEmbeddings).set({ model: 'old-model' }).where(eq(stuckEmbeddings.publicationId, b.publication.id))
      const out = await similarToStuckCard(tx, a.slug, a.key, {}, at(10))
      expect(out.results.some((r) => r.path.startsWith(`/p/${b.slug}#`))).toBe(false)
    })
  })

  it('HTTP: noindex/no-store, 404 when off, 429 per IP, 503 on provider failure without echoing the query', async () => {
    await withRollback(async (tx) => {
      const { a } = await corpus(tx)
      const ip = `198.51.100.${token()}`
      const app = createApp()
      const deps = { getDb: () => tx, now: () => at(30), getEnv: () => ({}), clientKey: () => ip }
      app.use(
        createRouter()
          .get('/api/v1/public/publications/:slug/stuck/:itemKey/similar', createSimilarStuckHandler(deps))
          .get('/api/v1/public/search/semantic', createSemanticSearchHandler(deps)),
      )
      const handler = toWebHandler(app)
      const get = (path: string) => handler(new Request(`http://localhost:3000${path}`))
      const similarPath = `/api/v1/public/publications/${a.slug}/stuck/${a.key}/similar`

      const ok = await get(similarPath)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(ok.headers.get('cache-control')).toBe('no-store')
      expect(ok.headers.get('set-cookie')).toBeNull()

      fake.failNext(1)
      const failed = await get(`/api/v1/public/search/semantic?q=${encodeURIComponent('비밀스러운 검색어')}`)
      expect(failed.status).toBe(503)
      const body = await failed.text()
      expect(body).toContain('embedding_unavailable')
      expect(body).not.toContain('비밀스러운')

      for (let i = 0; i < 9; i++) expect((await get('/api/v1/public/search/semantic?q=%EC%A2%80%EB%B9%84')).status).toBe(200)
      expect((await get('/api/v1/public/search/semantic?q=%EC%A2%80%EB%B9%84')).status).toBe(429)

      setEmbeddingProviderForTesting(null)
      expect((await get(similarPath)).status).toBe(404)
      expect((await get('/api/v1/public/search/semantic?q=x')).status).toBe(404)
    })
  })
})
