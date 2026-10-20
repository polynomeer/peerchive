/**
 * T-15 운영 조치 파생 데이터 handler. payload 검사는 DB 없이, handler는 실제 PostgreSQL(rollback)로 봅니다.
 * 공개·release·조치 행은 직접 넣습니다(조치 규칙 자체는 웹 테스트가 봄). 이 테스트가 만든 공개·노트의 행만 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  courses,
  createDb,
  eq,
  moderationActions,
  projects,
  publicationCandidates,
  publications,
  releaseHiddenItems,
  schools,
  searchDocuments,
  seniorNotes,
  users,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { searchIndexHandler } from '../src/course-hub-derived'
import { handleModerationAction, parseModerationPayload } from '../src/moderation-derived'
import { parsePublicationPayload } from '../src/publication-events'

const id = () => crypto.randomUUID()

const stuckLog = (key: string, symptom: string) => ({
  key,
  tag: 'stuck',
  source: 'web',
  retrospective: false,
  author: null,
  body: '',
  payload: { symptom, keywords: ['list'], timeBucket: 'lt2h' },
  links: [],
  claimedDate: null,
  recordedAt: '2025-10-01T00:00:00.000Z',
  revisionNo: 1,
  milestone: null,
  resolves: null,
  evidence: [],
})

describe('moderation payloads', () => {
  it('accepts an action id and phase only; publication events accept the restricted cause', () => {
    const ok = { actionId: id(), phase: 'applied' }
    expect(parseModerationPayload({ ...ok, extra: 1 })).toEqual(ok)
    expect(parseModerationPayload({ ...ok, phase: 'reversed' })).toEqual({ ...ok, phase: 'reversed' })
    expect(parseModerationPayload({ ...ok, phase: 'other' })).toBeNull()
    expect(parseModerationPayload({ ...ok, actionId: 'x' })).toBeNull()
    expect(parseModerationPayload(null)).toBeNull()
    const pub = { publicationId: id(), projectId: id(), releaseId: id(), releaseNo: 1, accessEpoch: 2, cause: 'restricted' }
    expect(parsePublicationPayload(pub)).toEqual(pub)
  })
})

const url = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!url)('moderation derived data (PostgreSQL)', () => {
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

  it('hide_item removes the stuck search document; reindexing skips hidden items; reversal re-creates it', async () => {
    await rollback(async (tx) => {
      const [user] = await tx.insert(users).values({ displayName: 'w', privateEmail: `w+${id()}@example.test` }).returning()
      const [project] = await tx.insert(projects).values({ ownerId: user!.id, title: 'p' }).returning()
      const [publication] = await tx
        .insert(publications)
        .values({ projectId: project!.id, slug: `case-${id().slice(0, 8)}`, level: 'summary', status: 'published', accessEpoch: 1, createdBy: user!.id })
        .returning()
      const snapshot = {
        format: 'peerchive.public-snapshot',
        schemaVersion: 1,
        level: 'summary',
        slug: 'x',
        title: '과제',
        summary: '요약',
        kind: 'individual',
        retrospective: false,
        course: null,
        members: [],
        milestones: [],
        logs: [stuckLog('l_a', '연결 리스트 순환'), stuckLog('l_b', '해시 충돌')],
        claims: [],
        artifacts: [],
      }
      const [release] = await tx
        .insert(publicationCandidates)
        .values({
          publicationId: publication!.id,
          projectId: project!.id,
          version: 1,
          level: 'summary',
          status: 'published',
          snapshot,
          manifest: {},
          manifestHash: 'a'.repeat(64),
          selection: {},
          createdBy: user!.id,
          releaseNo: 1,
          publishedAt: new Date(),
        })
        .returning()
      await tx.update(publications).set({ currentReleaseId: release!.id }).where(eq(publications.id, publication!.id))
      const event = { publicationId: publication!.id, projectId: project!.id, releaseId: release!.id, releaseNo: 1, accessEpoch: 1 }
      await searchIndexHandler.onPublished!(tx, event)
      const docs = () => tx.select().from(searchDocuments).where(eq(searchDocuments.publicationId, publication!.id))
      expect((await docs()).map((d) => d.itemKey).sort()).toEqual(['l_a', 'l_b', null])

      const [action] = await tx
        .insert(moderationActions)
        .values({
          kind: 'hide_item',
          outcome: 'resolved',
          targetType: 'publication_item',
          targetKey: `publication_item:${publication!.id}:log:l_a`,
          publicationId: publication!.id,
          releaseId: release!.id,
          itemKind: 'log',
          itemKey: 'l_a',
          internalNote: 'n',
          createdBy: user!.id,
        })
        .returning()
      await tx.insert(releaseHiddenItems).values({ publicationId: publication!.id, releaseId: release!.id, itemKind: 'log', itemKey: 'l_a', actionId: action!.id })
      expect(await handleModerationAction(tx, { actionId: action!.id, phase: 'applied' })).toBe(1)
      expect((await docs()).map((d) => d.itemKey).sort()).toEqual(['l_b', null])
      // 중복 전달·다시 색인해도 가린 항목은 만들지 않습니다.
      expect(await handleModerationAction(tx, { actionId: action!.id, phase: 'applied' })).toBe(0)
      await tx.delete(searchDocuments).where(eq(searchDocuments.publicationId, publication!.id))
      await searchIndexHandler.onPublished!(tx, event)
      expect((await docs()).map((d) => d.itemKey).sort()).toEqual(['l_b', null])

      // 되돌림: 가린 표시를 풀고 이벤트를 처리하면 빠진 문서만 다시 만듭니다.
      await tx.update(releaseHiddenItems).set({ liftedAt: new Date() }).where(eq(releaseHiddenItems.actionId, action!.id))
      await tx.update(moderationActions).set({ reversedAt: new Date(), reversedBy: user!.id, reverseCause: 'appeal' }).where(eq(moderationActions.id, action!.id))
      expect(await handleModerationAction(tx, { actionId: action!.id, phase: 'reversed' })).toBe(1)
      expect((await docs()).map((d) => d.itemKey).sort()).toEqual(['l_a', 'l_b', null])
      // 늦게 온 applied 이벤트는 지금 상태(되돌림)를 따르므로 지우지 않습니다.
      await handleModerationAction(tx, { actionId: action!.id, phase: 'applied' })
      expect(await docs()).toHaveLength(3)
    })
  })

  it('hide_note removes the note document; reversal reindexes the published version', async () => {
    await rollback(async (tx) => {
      const [user] = await tx.insert(users).values({ displayName: 'n', privateEmail: `n+${id()}@example.test` }).returning()
      const [school] = await tx.insert(schools).values({ name: 's', nameKey: `s${id()}` }).returning()
      const [course] = await tx.insert(courses).values({ schoolId: school!.id, title: 'c', titleKey: `c${id()}` }).returning()
      const [note] = await tx
        .insert(seniorNotes)
        .values({ courseId: course!.id, authorId: user!.id, displayMode: 'anonymous', answers: { firstWeek: '명세', timeSink: '디버깅' }, noAnswersConfirmed: true, status: 'hidden', publishedAt: new Date() })
        .returning()
      await tx.insert(searchDocuments).values({ kind: 'note', seniorNoteId: note!.id, noteVersion: 1, title: 't', snippet: 's', searchText: '명세' })
      const [action] = await tx
        .insert(moderationActions)
        .values({ kind: 'hide_note', outcome: 'resolved', targetType: 'senior_note', targetKey: `senior_note:${note!.id}`, seniorNoteId: note!.id, internalNote: 'n', createdBy: user!.id })
        .returning()
      expect(await handleModerationAction(tx, { actionId: action!.id, phase: 'applied' })).toBe(1)
      expect(await tx.select().from(searchDocuments).where(eq(searchDocuments.seniorNoteId, note!.id))).toEqual([])
      await tx.update(seniorNotes).set({ status: 'published' }).where(eq(seniorNotes.id, note!.id))
      expect(await handleModerationAction(tx, { actionId: action!.id, phase: 'reversed' })).toBe(1)
      expect(await tx.select().from(searchDocuments).where(eq(searchDocuments.seniorNoteId, note!.id))).toHaveLength(1)
      expect(await handleModerationAction(tx, { actionId: id(), phase: 'applied' })).toBe(0)
    })
  })
})
