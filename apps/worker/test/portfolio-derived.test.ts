/**
 * T-14 케이스 스터디 이용 불가 표시 handler. 실제 PostgreSQL(rollback)로 철회·대체된 release에 고정된 케이스만 unavailable이 되는지 봅니다.
 * 공개·release 행은 직접 넣습니다(게시 규칙 자체는 웹 테스트가 봄). 이 테스트가 만든 공개·케이스의 행만 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  caseStudies,
  createDb,
  eq,
  projects,
  publicationCandidates,
  publications,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { caseStudiesCleanupHandler, markUnavailableCaseStudies, registerPortfolioDerived } from '../src/portfolio-derived'
import { derivedCleanupHandlers, handlePublicationPublished, handlePublicationWithdrawn } from '../src/publication-events'

const id = () => crypto.randomUUID()

describe('portfolio derived handler registration', () => {
  it('registers the case-studies handler once', () => {
    registerPortfolioDerived()
    registerPortfolioDerived()
    expect(derivedCleanupHandlers().map((h) => h.name)).toEqual(['case-studies'])
  })
})

const url = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!url)('case study availability cleanup (PostgreSQL)', () => {
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

  async function fixture(tx: DbExecutor) {
    const [user] = await tx.insert(users).values({ displayName: 'w', privateEmail: `w+${id()}@example.test` }).returning()
    const [project] = await tx.insert(projects).values({ ownerId: user!.id, title: 'p' }).returning()
    const [publication] = await tx
      .insert(publications)
      .values({ projectId: project!.id, slug: `case-${id().slice(0, 8)}`, level: 'summary', status: 'published', accessEpoch: 1, createdBy: user!.id })
      .returning()
    const release = async (version: number) => {
      const [row] = await tx
        .insert(publicationCandidates)
        .values({
          publicationId: publication!.id,
          projectId: project!.id,
          version,
          level: 'summary',
          status: 'published',
          snapshot: {},
          manifest: {},
          manifestHash: 'a'.repeat(64),
          selection: {},
          createdBy: user!.id,
          releaseNo: version,
          publishedAt: new Date(),
        })
        .returning()
      return row!
    }
    const caseFor = async (releaseId: string, releaseVersion: number, status: 'draft' | 'published' = 'published') => {
      const [row] = await tx
        .insert(caseStudies)
        .values({
          userId: user!.id,
          publicationId: publication!.id,
          releaseId,
          releaseVersion,
          memberKey: 'm_x',
          selfAnonymous: false,
          jobTarget: 'backend',
          title: '케이스',
          status,
          publishedAt: status === 'published' ? new Date() : null,
        })
        .returning()
      return row!
    }
    return { user: user!, project: project!, publication: publication!, release, caseFor }
  }

  const statusOf = async (tx: DbExecutor, caseId: string) => {
    const [row] = await tx.select().from(caseStudies).where(eq(caseStudies.id, caseId))
    return { status: row!.status, reason: row!.unavailableReason }
  }

  it('marks cases pinned to a replaced release (not the current one) on publish, idempotently and regardless of event order', async () => {
    await rollback(async (tx) => {
      const { project, publication, release, caseFor } = await fixture(tx)
      const r1 = await release(1)
      await tx.update(publications).set({ currentReleaseId: r1.id }).where(eq(publications.id, publication.id))
      const onOld = await caseFor(r1.id, 1)
      const draftOld = await caseFor(r1.id, 1, 'draft')
      const event1 = { publicationId: publication.id, projectId: project.id, releaseId: r1.id, releaseNo: 1, accessEpoch: 1 }
      // 지금 release에 고정된 케이스는 건드리지 않습니다.
      expect(await handlePublicationPublished(tx, event1, [caseStudiesCleanupHandler])).toBe(0)
      expect(await statusOf(tx, onOld.id)).toEqual({ status: 'published', reason: null })

      await tx.update(publicationCandidates).set({ status: 'replaced', replacedAt: new Date() }).where(eq(publicationCandidates.id, r1.id))
      const r2 = await release(2)
      await tx.update(publications).set({ currentReleaseId: r2.id, accessEpoch: 2 }).where(eq(publications.id, publication.id))
      const onNew = await caseFor(r2.id, 2)
      // 늦게 온 이전 이벤트로도 같은 결과(행 상태로 판정).
      expect(await handlePublicationPublished(tx, event1, [caseStudiesCleanupHandler])).toBe(2)
      expect(await statusOf(tx, onOld.id)).toEqual({ status: 'unavailable', reason: 'replaced' })
      expect(await statusOf(tx, draftOld.id)).toEqual({ status: 'unavailable', reason: 'replaced' })
      expect(await statusOf(tx, onNew.id)).toEqual({ status: 'published', reason: null })
      // 중복 전달: 바뀌는 행 없음.
      expect(await markUnavailableCaseStudies(tx, publication.id)).toBe(0)
    })
  })

  it('marks cases pinned to a withdrawn release on withdrawal and records the handler in the cleanup audit', async () => {
    await rollback(async (tx) => {
      const { project, publication, release, caseFor } = await fixture(tx)
      const r1 = await release(1)
      await tx.update(publications).set({ currentReleaseId: r1.id }).where(eq(publications.id, publication.id))
      const pinned = await caseFor(r1.id, 1)
      await tx.update(publications).set({ status: 'withdrawn', accessEpoch: 2 }).where(eq(publications.id, publication.id))
      await tx.update(publicationCandidates).set({ status: 'withdrawn', withdrawnAt: new Date() }).where(eq(publicationCandidates.id, r1.id))
      const outcome = await handlePublicationWithdrawn(
        tx,
        { publicationId: publication.id, projectId: project.id, releaseId: r1.id, releaseNo: 1, accessEpoch: 2, cause: 'owner' },
        [caseStudiesCleanupHandler],
      )
      expect(outcome).toEqual({ status: 'cleaned', handlers: ['case-studies'], affected: 1 })
      const [row] = await tx.select().from(caseStudies).where(eq(caseStudies.id, pinned.id))
      expect(row).toMatchObject({ status: 'unavailable', unavailableReason: 'withdrawn' })
      expect(row!.unavailableAt).toBeInstanceOf(Date)
    })
  })
})
