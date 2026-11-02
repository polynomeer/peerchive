/**
 * E-05 유사 막힘 임베딩 색인(worker). 결정적 가짜 공급자(NODE_ENV=test)만 쓰고 네트워크를 쓰지 않습니다. 실제 PostgreSQL(rollback).
 * - 공급자가 받는 글은 지금 게시 중인 공개 스냅샷의 막힘 증상·키워드·해결 방법뿐: 같은 과제의 비공개 로그, 다른 비공개 과제, 초안 후보,
 *   대체된 release, 스냅샷 안의 시도·오류 원문은 보내지 않습니다.
 * - 같은 글은 다시 임베딩하지 않고(새 release면 release만 옮김), 비용 상한·배치·재시도, 엠바고 제외, 철회·새 release·가림 정리.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  and,
  createDb,
  embargoes,
  eq,
  logEntries,
  logRevisions,
  moderationActions,
  projects,
  publicationCandidates,
  publications,
  releaseHiddenItems,
  stuckEmbeddings,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { EmbeddingProviderError, type FakeEmbeddingProvider, RateGate, createFakeEmbeddingProvider } from '@peerchive/embeddings'
import { searchIndexHandler } from '../src/course-hub-derived'
import { handleModerationAction } from '../src/moderation-derived'
import { handlePublicationPublished, handlePublicationWithdrawn } from '../src/publication-events'
import { STUCK_EMBEDDING_DEFAULT_CRON, parseStuckEmbeddingCron, stuckEmbeddingsCleanupHandler, syncStuckEmbeddings } from '../src/stuck-embeddings'

const id = () => crypto.randomUUID()
const LIMITS = { maxItemsPerRun: 100, batchSize: 10, requestsPerMinute: 10_000 }
const noWait = () => new RateGate(0, async () => {})
const FAST_RETRY = { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => {} }

const log = (key: string, tag: string, payload: Record<string, unknown>, resolves: string | null = null) => ({
  key,
  tag,
  source: 'web',
  retrospective: false,
  author: null,
  body: '',
  payload,
  links: [],
  claimedDate: null,
  recordedAt: '2025-10-01T00:00:00.000Z',
  revisionNo: 1,
  milestone: null,
  resolves,
  evidence: [],
})

const snapshotWith = (logs: unknown[]) => ({
  format: 'peerchive.public-snapshot',
  schemaVersion: 1,
  level: 'full',
  slug: 'x',
  title: '공개 사례',
  summary: '요약',
  kind: 'individual',
  retrospective: false,
  course: null,
  members: [],
  milestones: [],
  logs,
  claims: [],
  artifacts: [],
})

describe('parseStuckEmbeddingCron', () => {
  it('defaults to every 10 minutes and can be turned off', () => {
    expect(parseStuckEmbeddingCron(undefined)).toBe(STUCK_EMBEDDING_DEFAULT_CRON)
    expect(parseStuckEmbeddingCron('off')).toBeNull()
    expect(parseStuckEmbeddingCron('0 * * * *')).toBe('0 * * * *')
  })
})

const url = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!url)('stuck embeddings sync (PostgreSQL, fake provider)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined
  afterAll(async () => {
    await db?.$client.end()
  })

  async function rollback(fn: (tx: DbExecutor) => Promise<void>) {
    await expect(
      db!.transaction(async (tx) => {
        await fn(tx)
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  /** 공개 하나(검색 문서까지 색인). tok은 이 테스트의 글을 구분하는 표시. */
  async function published(tx: DbExecutor, tok: string) {
    const [user] = await tx.insert(users).values({ displayName: 'w', privateEmail: `w+${id()}@example.test` }).returning()
    const [project] = await tx.insert(projects).values({ ownerId: user!.id, title: 'p' }).returning()
    const [publication] = await tx
      .insert(publications)
      .values({ projectId: project!.id, slug: `case-${id().slice(0, 8)}`, level: 'full', status: 'published', accessEpoch: 1, createdBy: user!.id })
      .returning()
    const release = async (version: number, logs: unknown[], status: 'published' | 'awaiting_consent' = 'published') => {
      const [row] = await tx
        .insert(publicationCandidates)
        .values({
          publicationId: publication!.id,
          projectId: project!.id,
          version,
          level: 'full',
          status,
          snapshot: snapshotWith(logs),
          manifest: {},
          manifestHash: 'a'.repeat(64),
          selection: {},
          createdBy: user!.id,
          ...(status === 'published' && { releaseNo: version, publishedAt: new Date() }),
        })
        .returning()
      return row!
    }
    const r1 = await release(1, [
      log('l_a', 'stuck', { symptom: `${tok} 좀비 프로세스가 남음`, keywords: ['fork'], attempts: [`${tok} 시도 원문`], errorText: `${tok} 오류 원문` }),
      log('l_s', 'solution', { method: `${tok} waitpid로 거둠` }, 'l_a'),
      log('l_b', 'stuck', { symptom: `${tok} CSS 그리드가 깨짐`, keywords: [] }),
    ])
    await tx.update(publications).set({ currentReleaseId: r1.id }).where(eq(publications.id, publication!.id))
    const event = { publicationId: publication!.id, projectId: project!.id, releaseId: r1.id, releaseNo: 1, accessEpoch: 1 }
    await searchIndexHandler.onPublished!(tx, event)
    return { user: user!, project: project!, publication: publication!, r1, release, event }
  }

  const rowsOf = (tx: DbExecutor, publicationId: string) =>
    tx.select().from(stuckEmbeddings).where(eq(stuckEmbeddings.publicationId, publicationId)).orderBy(stuckEmbeddings.itemKey)
  const sentTexts = (fake: FakeEmbeddingProvider) => fake.calls.flatMap((c) => c.texts)

  it('embeds only public stuck + solution text; private logs, drafts and other projects are never sent', async () => {
    await rollback(async (tx) => {
      const tok = `T${id().slice(0, 6)}`
      const { user, project, publication, release } = await published(tx, tok)
      // 같은 과제의 비공개 막힘 로그(스냅샷에 넣지 않음) + 다른 비공개 과제의 막힘 로그.
      const [other] = await tx.insert(projects).values({ ownerId: user.id, title: '비공개 과제' }).returning()
      for (const projectId of [project.id, other!.id]) {
        const [entry] = await tx.insert(logEntries).values({ projectId, authorId: user.id, tag: 'stuck' }).returning()
        const [rev] = await tx
          .insert(logRevisions)
          .values({ logEntryId: entry!.id, revisionNo: 1, tag: 'stuck', body: `${tok} 비공개 본문`, payload: { symptom: `${tok} 비공개 증상`, keywords: [], timeBucket: 'lt2h' } })
          .returning()
        await tx.update(logEntries).set({ currentRevisionId: rev!.id }).where(eq(logEntries.id, entry!.id))
      }
      // 아직 게시하지 않은 초안 후보(비공개 글).
      await release(2, [log('l_d', 'stuck', { symptom: `${tok} 초안 증상` })], 'awaiting_consent')

      const fake = createFakeEmbeddingProvider({ dims: 32 })
      const r = await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(r.embedded).toBeGreaterThanOrEqual(2)
      const mine = sentTexts(fake).filter((t) => t.includes(tok))
      expect(mine.sort()).toEqual([`막힘: ${tok} CSS 그리드가 깨짐`, `막힘: ${tok} 좀비 프로세스가 남음\n키워드: fork\n해결: ${tok} waitpid로 거둠`])
      for (const t of sentTexts(fake)) expect(t).not.toMatch(/비공개 증상|비공개 본문|초안 증상|시도 원문|오류 원문/)
      expect(fake.calls.every((c) => c.inputType === 'document')).toBe(true)

      const rows = await rowsOf(tx, publication.id)
      expect(rows.map((x) => [x.itemKey, x.model, x.dims, x.embedding.length])).toEqual([
        ['l_a', fake.model, 32, 32],
        ['l_b', fake.model, 32, 32],
      ])
      // 단위 길이로 정규화해 저장합니다.
      expect(Math.sqrt(rows[0]!.embedding.reduce((s, v) => s + v * v, 0))).toBeCloseTo(1, 4)
      // 다시 돌려도 공급자를 부르지 않습니다.
      const calls = fake.calls.length
      const again = await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(fake.calls.length).toBe(calls)
      expect(again.embedded).toBe(0)
    })
  })

  it('new release with unchanged text moves the row without re-embedding; changed text re-embeds; dropped cards are cleaned', async () => {
    await rollback(async (tx) => {
      const tok = `T${id().slice(0, 6)}`
      const { publication, release, event } = await published(tx, tok)
      const fake = createFakeEmbeddingProvider({ dims: 16 })
      await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      const before = await rowsOf(tx, publication.id)

      await tx.update(publicationCandidates).set({ status: 'superseded', supersededAt: new Date() }).where(eq(publicationCandidates.publicationId, publication.id))
      const r2 = await release(2, [
        log('l_a', 'stuck', { symptom: `${tok} 좀비 프로세스가 남음`, keywords: ['fork'] }),
        log('l_s', 'solution', { method: `${tok} waitpid로 거둠` }, 'l_a'),
        log('l_c', 'stuck', { symptom: `${tok} 새 막힘` }),
      ])
      await tx.update(publications).set({ currentReleaseId: r2.id, accessEpoch: 2 }).where(eq(publications.id, publication.id))
      const event2 = { ...event, releaseId: r2.id, releaseNo: 2, accessEpoch: 2 }
      await handlePublicationPublished(tx, event2, [searchIndexHandler, stuckEmbeddingsCleanupHandler])
      // l_b는 새 스냅샷에 없으므로 정리 handler가 지웁니다.
      expect((await rowsOf(tx, publication.id)).map((x) => x.itemKey)).toEqual(['l_a'])

      fake.calls.length = 0
      const r = await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(sentTexts(fake).filter((t) => t.includes(tok))).toEqual([`막힘: ${tok} 새 막힘`])
      expect(r.reused).toBeGreaterThanOrEqual(1)
      const after = await rowsOf(tx, publication.id)
      expect(after.map((x) => [x.itemKey, x.releaseId])).toEqual([
        ['l_a', r2.id],
        ['l_c', r2.id],
      ])
      expect(after[0]!.contentHash).toBe(before[0]!.contentHash)
      expect(after[0]!.embeddedAt.getTime()).toBe(before[0]!.embeddedAt.getTime())

      // 철회: 정리 handler가 그 공개의 벡터를 모두 지웁니다.
      await tx.update(publications).set({ status: 'withdrawn', accessEpoch: 3 }).where(eq(publications.id, publication.id))
      await handlePublicationWithdrawn(tx, { ...event2, accessEpoch: 3 }, [stuckEmbeddingsCleanupHandler])
      expect(await rowsOf(tx, publication.id)).toEqual([])
      fake.calls.length = 0
      await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(sentTexts(fake).filter((t) => t.includes(tok))).toEqual([])
    })
  })

  it('cost guard caps items per run, batches requests, retries transient errors and defers on failure', async () => {
    await rollback(async (tx) => {
      const tok = `T${id().slice(0, 6)}`
      const { publication } = await published(tx, tok)
      const fake = createFakeEmbeddingProvider({ dims: 8 })
      // 다른 데이터가 DB에 있어도 이 공개의 두 카드가 상한 안에서 처리되는지만 봅니다: 상한 0이면 아무것도 보내지 않음.
      const none = await syncStuckEmbeddings(tx, fake, { ...LIMITS, maxItemsPerRun: 0 }, { gate: noWait() })
      expect(fake.calls).toEqual([])
      expect(none.deferred).toBeGreaterThanOrEqual(2)
      expect(await rowsOf(tx, publication.id)).toEqual([])

      // 일시 오류 두 번 → 재시도로 성공. 배치 크기 1이면 글마다 요청 하나.
      fake.failNext(2, new EmbeddingProviderError('503', 503, true))
      const ok = await syncStuckEmbeddings(tx, fake, { ...LIMITS, batchSize: 1 }, { gate: noWait(), retry: FAST_RETRY })
      expect(ok.failed).toBe(false)
      expect(fake.calls.filter((c) => c.texts.length > 0).every((c) => c.texts.length === 1)).toBe(true)
      expect(await rowsOf(tx, publication.id)).toHaveLength(2)

      // 영구 오류: 저장하지 않고 다음 실행으로 미룹니다.
      await tx.delete(stuckEmbeddings).where(eq(stuckEmbeddings.publicationId, publication.id))
      fake.failNext(1, new EmbeddingProviderError('400', 400, false))
      const failed = await syncStuckEmbeddings(tx, fake, { ...LIMITS, batchSize: 100 }, { gate: noWait(), retry: FAST_RETRY })
      expect(failed.failed).toBe(true)
      expect(await rowsOf(tx, publication.id)).toEqual([])
    })
  })

  it('embargoed projects are not sent; hidden logs are dropped and hiding a solution re-embeds without it', async () => {
    await rollback(async (tx) => {
      const tok = `T${id().slice(0, 6)}`
      const { user, project, publication, r1 } = await published(tx, tok)
      const fake = createFakeEmbeddingProvider({ dims: 8 })
      const [embargo] = await tx
        .insert(embargoes)
        .values({ scope: 'project', projectId: project.id, until: new Date(Date.now() + 86_400_000), reason: '시험', requestedBy: user.id })
        .returning()
      await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(sentTexts(fake).filter((t) => t.includes(tok))).toEqual([])
      await tx.update(embargoes).set({ revokedAt: new Date(), revokedBy: user.id }).where(eq(embargoes.id, embargo!.id))
      await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(await rowsOf(tx, publication.id)).toHaveLength(2)

      // 해결 로그(l_s)를 가림 → 그 공개의 벡터가 stale → 다음 실행이 해결 없이 다시 임베딩.
      const hide = async (itemKey: string) => {
        const [action] = await tx
          .insert(moderationActions)
          .values({
            kind: 'hide_item',
            outcome: 'resolved',
            targetType: 'publication_item',
            targetKey: `publication_item:${publication.id}:log:${itemKey}`,
            publicationId: publication.id,
            releaseId: r1.id,
            itemKind: 'log',
            itemKey,
            internalNote: 'n',
            createdBy: user.id,
          })
          .returning()
        await tx.insert(releaseHiddenItems).values({ publicationId: publication.id, releaseId: r1.id, itemKind: 'log', itemKey, actionId: action!.id })
        await handleModerationAction(tx, { actionId: action!.id, phase: 'applied' })
      }
      await hide('l_s')
      expect((await rowsOf(tx, publication.id)).every((x) => x.stale)).toBe(true)
      fake.calls.length = 0
      await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(sentTexts(fake).filter((t) => t.includes(tok))).toEqual([`막힘: ${tok} 좀비 프로세스가 남음\n키워드: fork`])
      expect((await rowsOf(tx, publication.id)).some((x) => x.stale)).toBe(false)

      // 막힘 카드(l_b)를 가림 → 그 벡터는 바로 삭제, 다시 만들지 않음.
      await hide('l_b')
      expect((await rowsOf(tx, publication.id)).map((x) => x.itemKey)).toEqual(['l_a'])
      fake.calls.length = 0
      await syncStuckEmbeddings(tx, fake, LIMITS, { gate: noWait() })
      expect(sentTexts(fake).filter((t) => t.includes(tok))).toEqual([])
      expect(await tx.select().from(stuckEmbeddings).where(and(eq(stuckEmbeddings.publicationId, publication.id), eq(stuckEmbeddings.itemKey, 'l_b')))).toEqual([])
    })
  })
})
