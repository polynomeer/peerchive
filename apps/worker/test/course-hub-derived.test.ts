/**
 * T-13 파생 데이터 handler(검색 색인·유용성 신호·선배 노트 색인). payload 검사는 DB 없이, handler는 실제 PostgreSQL(rollback)로 봅니다.
 * 공개·release 행은 직접 넣습니다(게시 규칙 자체는 웹 테스트가 봄). 이 테스트가 만든 공개·노트의 행만 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  and,
  auditEvents,
  courseQaItems,
  courses,
  createDb,
  eq,
  projects,
  publicationCandidates,
  publications,
  schools,
  searchDocuments,
  seniorNotes,
  usefulnessSignals,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import {
  handleCourseQaPublished,
  handleCourseQaWithdrawn,
  parseCourseQaPayload,
  handleSeniorNotePublished,
  handleSeniorNoteWithdrawn,
  parseSeniorNotePayload,
  registerCourseHubDerived,
  searchIndexHandler,
  signalsCleanupHandler,
} from '../src/course-hub-derived'
import { derivedCleanupHandlers, handlePublicationPublished, handlePublicationWithdrawn } from '../src/publication-events'

const id = () => crypto.randomUUID()

const stuckLog = (key: string, symptom: string) => ({
  key,
  tag: 'stuck',
  source: 'web',
  retrospective: false,
  author: null,
  body: '',
  payload: { symptom, keywords: ['fork'], attempts: ['비공개 시도'], timeBucket: 'lt2h' },
  links: [],
  claimedDate: null,
  recordedAt: '2025-10-01T00:00:00.000Z',
  revisionNo: 1,
  milestone: null,
  resolves: null,
  evidence: [],
})

const snapshotWith = (title: string, logs: unknown[]) => ({
  format: 'peerchive.public-snapshot',
  schemaVersion: 1,
  level: 'summary',
  slug: 'x',
  title,
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

describe('parseCourseQaPayload (C-09)', () => {
  it('accepts the two ids only', () => {
    const ok = { courseQaItemId: id(), courseId: id() }
    expect(parseCourseQaPayload({ ...ok, extra: 'x' })).toEqual(ok)
    expect(parseCourseQaPayload({ ...ok, courseQaItemId: 'x' })).toBeNull()
    expect(parseCourseQaPayload(undefined)).toBeNull()
  })
})

describe('parseSeniorNotePayload', () => {
  it('accepts ids and a positive version only', () => {
    const ok = { seniorNoteId: id(), courseId: id(), version: 2 }
    expect(parseSeniorNotePayload({ ...ok, extra: 1 })).toEqual(ok)
    expect(parseSeniorNotePayload({ ...ok, version: 0 })).toBeNull()
    expect(parseSeniorNotePayload({ ...ok, seniorNoteId: 'x' })).toBeNull()
    expect(parseSeniorNotePayload(null)).toBeNull()
  })

  it('registers the search-index and usefulness-signals cleanup handlers once', () => {
    registerCourseHubDerived()
    registerCourseHubDerived()
    expect(derivedCleanupHandlers().map((h) => h.name)).toEqual(['search-index', 'usefulness-signals'])
  })
})

const url = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!url)('course hub derived data (PostgreSQL)', () => {
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

  async function publishedRelease(tx: DbExecutor) {
    const [user] = await tx.insert(users).values({ displayName: 'w', privateEmail: `w+${id()}@example.test` }).returning()
    const [project] = await tx.insert(projects).values({ ownerId: user!.id, title: 'p' }).returning()
    const [publication] = await tx
      .insert(publications)
      .values({ projectId: project!.id, slug: `case-${id().slice(0, 8)}`, level: 'summary', status: 'published', accessEpoch: 1, createdBy: user!.id })
      .returning()
    const release = async (version: number, snapshot: Record<string, unknown>) => {
      const [row] = await tx
        .insert(publicationCandidates)
        .values({
          publicationId: publication!.id,
          projectId: project!.id,
          version,
          level: 'summary',
          status: 'published',
          snapshot,
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
    const r1 = await release(1, snapshotWith('첫 버전', [stuckLog('l_a', '좀비 프로세스'), stuckLog('l_gone', '사라질 막힘')]))
    await tx.update(publications).set({ currentReleaseId: r1.id }).where(eq(publications.id, publication!.id))
    return { user: user!, project: project!, publication: publication!, r1, release }
  }

  const docsOf = (tx: DbExecutor, publicationId: string) =>
    tx.select().from(searchDocuments).where(eq(searchDocuments.publicationId, publicationId))

  it('indexes the current release on publish (idempotent, skips stale events), reindexes on replacement and cleans on withdrawal', async () => {
    await rollback(async (tx) => {
      const { user, project, publication, r1, release } = await publishedRelease(tx)
      const event = { publicationId: publication.id, projectId: project.id, releaseId: r1.id, releaseNo: 1, accessEpoch: 1 }
      const handlers = [searchIndexHandler, signalsCleanupHandler]

      expect(await handlePublicationPublished(tx, event, handlers)).toBe(3)
      expect((await docsOf(tx, publication.id)).map((d) => [d.kind, d.itemKey, d.searchText]).sort()).toEqual([
        ['case', null, '첫 버전 요약'],
        ['stuck', 'l_a', '좀비 프로세스 fork'],
        ['stuck', 'l_gone', '사라질 막힘 fork'],
      ])
      // 중복 전달: 행이 늘지 않습니다. 낡은 이벤트(다른 epoch)는 아무것도 하지 않습니다.
      expect(await searchIndexHandler.onPublished!(tx, event)).toBe(0)
      expect(await docsOf(tx, publication.id)).toHaveLength(3)
      expect(await searchIndexHandler.onPublished!(tx, { ...event, accessEpoch: 0 })).toBe(0)

      // 신호: 두 막힘 카드에 하나씩.
      for (const itemKey of ['l_a', 'l_gone']) {
        await tx.insert(usefulnessSignals).values({ userId: user.id, targetKind: 'stuck_item', publicationId: publication.id, itemKey, kind: 'me_too' })
      }

      // 새 버전(대체): r2에는 l_a만 있습니다.
      await tx.update(publicationCandidates).set({ status: 'replaced', replacedAt: new Date() }).where(eq(publicationCandidates.id, r1.id))
      const r2 = await release(2, snapshotWith('둘째 버전', [stuckLog('l_a', '좀비 프로세스')]))
      await tx.update(publications).set({ currentReleaseId: r2.id, accessEpoch: 2 }).where(eq(publications.id, publication.id))
      // 이전 이벤트가 늦게 와도 지금 release가 아니므로 색인하지 않습니다.
      expect(await searchIndexHandler.onPublished!(tx, event)).toBe(0)
      const event2 = { ...event, releaseId: r2.id, releaseNo: 2, accessEpoch: 2 }
      await handlePublicationPublished(tx, event2, handlers)
      const docs = await docsOf(tx, publication.id)
      expect(docs.every((d) => d.releaseId === r2.id)).toBe(true)
      expect(docs.map((d) => d.itemKey).sort()).toEqual(['l_a', null])
      // 지금 스냅샷에 없는 막힘 카드의 신호만 지웁니다(키는 공개마다 안정적이라 l_a는 유지).
      const signals = await tx.select().from(usefulnessSignals).where(eq(usefulnessSignals.publicationId, publication.id))
      expect(signals.map((s) => s.itemKey)).toEqual(['l_a'])

      // 철회: 문서·신호를 모두 지우고 감사 기록에 handler 이름을 남깁니다.
      await tx.update(publications).set({ status: 'withdrawn', accessEpoch: 3 }).where(eq(publications.id, publication.id))
      await tx.update(publicationCandidates).set({ status: 'withdrawn' }).where(eq(publicationCandidates.id, r2.id))
      const outcome = await handlePublicationWithdrawn(tx, { ...event2, accessEpoch: 3, cause: 'owner' }, handlers)
      expect(outcome).toEqual({ status: 'cleaned', handlers: ['search-index', 'usefulness-signals'], affected: 3 })
      expect(await docsOf(tx, publication.id)).toEqual([])
      expect(await tx.select().from(usefulnessSignals).where(eq(usefulnessSignals.publicationId, publication.id))).toEqual([])
      const [audit] = await tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, 'publication.derived_cleanup'), eq(auditEvents.targetId, publication.id)))
      expect(audit!.metadata).toMatchObject({ handlers: 'search-index,usefulness-signals', affected: 3 })
      // 철회가 먼저 처리된 뒤 늦은 게시 이벤트가 와도 다시 색인하지 않습니다.
      expect(await searchIndexHandler.onPublished!(tx, event2)).toBe(0)
      expect(await docsOf(tx, publication.id)).toEqual([])
    })
  })

  it('indexes a published senior note only at its current version and removes documents and signals on withdrawal', async () => {
    await rollback(async (tx) => {
      const [user] = await tx.insert(users).values({ displayName: 'n', privateEmail: `n+${id()}@example.test` }).returning()
      const [school] = await tx.insert(schools).values({ name: 's', nameKey: `s${id()}` }).returning()
      const [course] = await tx.insert(courses).values({ schoolId: school!.id, title: 'c', titleKey: `c${id()}` }).returning()
      const [note] = await tx
        .insert(seniorNotes)
        .values({
          courseId: course!.id,
          authorId: user!.id,
          displayMode: 'anonymous',
          answers: { firstWeek: '명세 읽기', timeSink: '파이프' },
          noAnswersConfirmed: true,
          status: 'published',
          publishedAt: new Date(),
        })
        .returning()
      const event = { seniorNoteId: note!.id, courseId: course!.id, version: 1 }
      const docs = () => tx.select().from(searchDocuments).where(eq(searchDocuments.seniorNoteId, note!.id))

      expect(await handleSeniorNotePublished(tx, event)).toBe(1)
      expect(await handleSeniorNotePublished(tx, event)).toBe(1)
      expect((await docs()).map((d) => [d.kind, d.noteVersion, d.searchText])).toEqual([['note', 1, '명세 읽기 파이프']])
      expect(await handleSeniorNotePublished(tx, { ...event, version: 2 })).toBe(0)
      expect(await handleSeniorNotePublished(tx, { seniorNoteId: 'x' })).toBe(0)
      await tx.insert(usefulnessSignals).values({ userId: user!.id, targetKind: 'senior_note', seniorNoteId: note!.id, kind: 'helped' })

      // 그 사이 다시 게시되어 있으면(같은 버전) 철회 이벤트는 지금 문서를 지우지 않습니다.
      expect(await handleSeniorNoteWithdrawn(tx, event)).toBe(0)
      expect(await docs()).toHaveLength(1)

      await tx.update(seniorNotes).set({ status: 'withdrawn', withdrawnAt: new Date() }).where(eq(seniorNotes.id, note!.id))
      expect(await handleSeniorNoteWithdrawn(tx, event)).toBe(2)
      expect(await docs()).toEqual([])
      expect(await tx.select().from(usefulnessSignals).where(eq(usefulnessSignals.seniorNoteId, note!.id))).toEqual([])
      // 철회된 노트의 늦은 게시 이벤트는 색인하지 않습니다.
      expect(await handleSeniorNotePublished(tx, event)).toBe(0)
    })
  })

  it('C-09: indexes a course Q&A only while published (copied text only) and removes documents and signals on withdrawal', async () => {
    await rollback(async (tx) => {
      const [user] = await tx.insert(users).values({ displayName: 'q', privateEmail: `q+${id()}@example.test` }).returning()
      const [school] = await tx.insert(schools).values({ name: 's', nameKey: `s${id()}` }).returning()
      const [course] = await tx.insert(courses).values({ schoolId: school!.id, title: 'c', titleKey: `c${id()}` }).returning()
      const [qa] = await tx
        .insert(courseQaItems)
        .values({
          courseId: course!.id,
          questionTitle: 'Fork 질문',
          questionBody: '좀비 프로세스',
          answerBody: 'waitpid',
          askerLabel: '질문한 학생',
          askerAnonymous: true,
          answererLabel: '코딩 곰',
          answererAnonymous: false,
          askerId: user!.id,
          answererId: user!.id,
          transferId: id(),
          publishedAt: new Date(),
        })
        .returning()
      const event = { courseQaItemId: qa!.id, courseId: course!.id }
      const docs = () => tx.select().from(searchDocuments).where(eq(searchDocuments.courseQaItemId, qa!.id))
      expect(await handleCourseQaPublished(tx, event)).toBe(1)
      expect(await handleCourseQaPublished(tx, event)).toBe(1)
      // 이름(고른 표시)은 색인하지 않습니다.
      expect((await docs()).map((d) => [d.kind, d.searchText])).toEqual([['qa', 'fork 질문 좀비 프로세스 waitpid']])
      await tx.insert(usefulnessSignals).values({ userId: user!.id, targetKind: 'course_qa', courseQaItemId: qa!.id, kind: 'me_too' })
      // 지금도 published면 철회 이벤트는 아무것도 지우지 않음
      expect(await handleCourseQaWithdrawn(tx, event)).toBe(0)
      await tx.update(courseQaItems).set({ status: 'withdrawn', withdrawnAt: new Date(), withdrawnBy: 'asker' }).where(eq(courseQaItems.id, qa!.id))
      expect(await handleCourseQaWithdrawn(tx, event)).toBe(2)
      expect(await docs()).toEqual([])
      // 철회된 뒤 늦게 온 게시 이벤트는 색인하지 않음
      expect(await handleCourseQaPublished(tx, event)).toBe(0)
      expect(await handleCourseQaPublished(tx, { courseQaItemId: 'x' })).toBe(0)
    })
  })
})
