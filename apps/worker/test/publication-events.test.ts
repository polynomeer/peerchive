/**
 * 공개 철회 outbox 소비(T-12). payload 검사는 DB 없이, 정리·감사 기록은 실제 PostgreSQL(rollback)로 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { auditEvents, createDb, eq, projects, users, type Database, type DbExecutor } from '@peerchive/db'
import {
  type DerivedCleanupHandler,
  handlePublicationPublished,
  handlePublicationWithdrawn,
  parsePublicationPayload,
} from '../src/publication-events'

const id = () => crypto.randomUUID()

describe('parsePublicationPayload', () => {
  it('accepts ids and counters only, rejects anything malformed', () => {
    const ok = { publicationId: id(), projectId: id(), releaseId: id(), releaseNo: 1, accessEpoch: 2, cause: 'owner' }
    expect(parsePublicationPayload(ok)).toEqual(ok)
    expect(parsePublicationPayload({ ...ok, extra: 'x' })).toEqual(ok)
    expect(parsePublicationPayload({ ...ok, publicationId: 'nope' })).toBeNull()
    expect(parsePublicationPayload({ ...ok, accessEpoch: -1 })).toBeNull()
    expect(parsePublicationPayload({ ...ok, releaseNo: 1.5 })).toBeNull()
    expect(parsePublicationPayload({ ...ok, cause: 'other' })).toBeNull()
    expect(parsePublicationPayload(null)).toBeNull()
  })
})

const url = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!url)('publication.withdrawn consumer (PostgreSQL)', () => {
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

  it('runs registered cleanup handlers and records one derived_cleanup audit per (publication, epoch)', async () => {
    await rollback(async (tx) => {
      const [user] = await tx.insert(users).values({ displayName: 'w', privateEmail: `w+${id()}@example.test` }).returning()
      const [project] = await tx.insert(projects).values({ ownerId: user!.id, title: 'p' }).returning()
      const event = { publicationId: id(), projectId: project!.id, releaseId: id(), releaseNo: 1, accessEpoch: 3, cause: 'consent_revoked' }
      const seen: string[] = []
      const handlers: DerivedCleanupHandler[] = [
        { name: 'search-index', onWithdrawn: async (_db, e) => (seen.push(`search:${e.accessEpoch}`), 2) },
        { name: 'portfolio', onWithdrawn: async (_db, e) => (seen.push(`portfolio:${e.publicationId === event.publicationId}`), 1) },
      ]
      expect(await handlePublicationWithdrawn(tx, event, handlers)).toEqual({ status: 'cleaned', handlers: ['search-index', 'portfolio'], affected: 3 })
      expect(seen).toEqual(['search:3', 'portfolio:true'])
      // 중복 전달: handler를 다시 돌리지 않고 감사 기록도 하나.
      expect(await handlePublicationWithdrawn(tx, event, handlers)).toMatchObject({ status: 'already_recorded' })
      expect(seen).toHaveLength(2)
      const rows = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, event.publicationId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        actorId: null,
        action: 'publication.derived_cleanup',
        targetType: 'publication',
        projectId: project!.id,
        metadata: { accessEpoch: 3, releaseNo: 1, cause: 'consent_revoked', handlers: 'search-index,portfolio', affected: 3 },
      })
      // 다음 철회(새 epoch)는 새로 정리합니다. handler가 없어도(지금 상태) 감사는 남깁니다.
      expect(await handlePublicationWithdrawn(tx, { ...event, accessEpoch: 5 }, [])).toEqual({ status: 'cleaned', handlers: [], affected: 0 })
      expect(await tx.select().from(auditEvents).where(eq(auditEvents.targetId, event.publicationId))).toHaveLength(2)
      // 형식이 틀린 작업은 기록 없이 끝냅니다.
      expect(await handlePublicationWithdrawn(tx, { publicationId: 'x' }, handlers)).toMatchObject({ status: 'invalid' })
      expect(await handlePublicationPublished(tx, { ...event, accessEpoch: 6 }, [{ ...handlers[0]!, onPublished: async () => 4 }])).toBe(4)
    })
  })
})
