/**
 * T-04 빌드 로그 서비스 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { auditEvents, eq, logEntries, logRevisions, sql, type DbExecutor } from '@peerchive/db'
import { createLog, getLog, listLogRevisions, listLogs, reviseLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { removeMember } from '../server/modules/projects/members'
import { createProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))

const stuckInput = { tag: 'stuck', payload: { symptom: 'CORS 에러', timeBucket: 'lt2h', attempts: ['프록시 설정'] } }
const solutionFor = (stuckId: string) => ({
  tag: 'solution',
  body: '서버 응답 헤더를 추가해 해결',
  payload: { method: 'Access-Control-Allow-Origin 헤더 추가', notAnswerConfirmed: true },
  resolvesEntryId: stuckId,
})

/** owner가 만든 팀 프로젝트에 role로 초대·수락된 멤버를 붙입니다. */
async function teamWith(db: DbExecutor, ...roles: Array<'editor' | 'reviewer' | 'viewer'>) {
  const owner = await createUser(db, { displayName: '소유자' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' })
  const members = []
  for (const role of roles) {
    const user = await createUser(db, { displayName: role })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members.push(user)
  }
  return { owner, project, members }
}

describe.skipIf(!databaseUrl)('build log services (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('owner/editor write logs with revision 1; recordedAt is server time, claimedDate is kept separately', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const editor = members[0]!
      const { log, created } = await createLog(
        tx,
        { userId: editor.id },
        project.id,
        { tag: 'progress', body: ' 로그인 API 완성 ', claimedDate: '2026-11-01', links: [{ url: 'https://github.com/x/y/pull/1' }] },
        T0,
      )
      expect(created).toBe(true)
      expect(log).toMatchObject({
        projectId: project.id,
        tag: 'progress',
        source: 'web',
        revisionNo: 1,
        body: '로그인 API 완성',
        payload: {},
        links: [{ url: 'https://github.com/x/y/pull/1', title: null }],
        claimedDate: '2026-11-01',
        createdAt: T0.toISOString(),
        recordedAt: T0.toISOString(),
        author: { userId: editor.id, displayName: 'editor', handle: null },
        canRevise: true,
        resolves: null,
        resolvedBy: [],
      })
      // owner는 남의 로그를 읽을 수 있지만 고칠 수 없습니다.
      expect((await getLog(tx, { userId: owner.id }, log.id)).canRevise).toBe(false)
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, log.id))
      expect(audits).toEqual([expect.objectContaining({ action: 'log.create', metadata: { tag: 'progress' } })])
    })
  })

  it('reviewer/viewer can read but not write (FORBIDDEN); non-members get NOT_FOUND', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'reviewer', 'viewer')
      const [reviewer, viewer] = members
      const stranger = await createUser(tx)
      const { log } = await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '진행' }, T0)

      for (const user of [reviewer!, viewer!]) {
        await expectServiceError(createLog(tx, { userId: user.id }, project.id, { tag: 'progress', body: 'x' }), 'FORBIDDEN')
        expect((await listLogs(tx, { userId: user.id }, project.id, {})).items.map((l) => l.id)).toEqual([log.id])
        expect((await getLog(tx, { userId: user.id }, log.id)).canRevise).toBe(false)
        await expectServiceError(
          reviseLog(tx, { userId: user.id }, log.id, { expectedRevision: 1, body: '덮어쓰기' }),
          'FORBIDDEN',
        )
      }

      await expectServiceError(createLog(tx, { userId: stranger.id }, project.id, { tag: 'progress', body: 'x' }), 'NOT_FOUND')
      await expectServiceError(listLogs(tx, { userId: stranger.id }, project.id, {}), 'NOT_FOUND')
      await expectServiceError(getLog(tx, { userId: stranger.id }, log.id), 'NOT_FOUND')
      await expectServiceError(listLogRevisions(tx, { userId: stranger.id }, log.id), 'NOT_FOUND')
      await expectServiceError(
        reviseLog(tx, { userId: stranger.id }, log.id, { expectedRevision: 1, body: 'x' }),
        'NOT_FOUND',
      )
      await expectServiceError(getLog(tx, { userId: stranger.id }, crypto.randomUUID()), 'NOT_FOUND')
      await expectServiceError(getLog(tx, { userId: owner.id }, 'not-a-uuid'), 'NOT_FOUND')
    })
  })

  it('returns field-specific 422s for payloads, links and future claimedDate', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const actor = { userId: owner.id }
      const bad = await expectServiceError(
        createLog(tx, actor, project.id, { tag: 'stuck', payload: { symptom: '', timeBucket: 'week', extra: 1 } }, T0),
        'VALIDATION',
      )
      expect(bad.fields).toEqual({ payload: 'unknown_key', 'payload.symptom': 'required', 'payload.timeBucket': 'invalid' })
      const links = await expectServiceError(
        createLog(tx, actor, project.id, { tag: 'progress', body: 'x', links: [{ url: 'javascript:alert(1)' }] }, T0),
        'VALIDATION',
      )
      expect(links.fields).toEqual({ 'links.0.url': 'invalid_url' })
      const future = await expectServiceError(
        createLog(tx, actor, project.id, { tag: 'progress', body: 'x', claimedDate: '2026-11-04' }, T0),
        'VALIDATION',
      )
      expect(future.fields).toEqual({ claimedDate: 'too_far_future' })
      await createLog(tx, actor, project.id, { tag: 'progress', body: 'x', claimedDate: '2026-11-03' }, T0)
      const body = await expectServiceError(createLog(tx, actor, project.id, { tag: 'retro' }, T0), 'VALIDATION')
      expect(body.fields).toEqual({ body: 'required' })
    })
  })

  it('a solution resolves a stuck log of the same project; several solutions per stuck are allowed', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const other = await teamWith(tx)
      const actor = { userId: owner.id }
      const { log: stuck } = await createLog(tx, actor, project.id, stuckInput, at(0))
      const { log: s1 } = await createLog(tx, actor, project.id, solutionFor(stuck.id), at(1))
      const { log: s2 } = await createLog(tx, { userId: members[0]!.id }, project.id, solutionFor(stuck.id), at(2))
      expect(s1.resolves).toMatchObject({ id: stuck.id, tag: 'stuck', summary: 'CORS 에러' })

      const detail = await getLog(tx, actor, stuck.id)
      expect(detail.resolvedBy.map((r) => r.id)).toEqual([s1.id, s2.id])
      expect(detail.resolvedBy[1]).toMatchObject({ tag: 'solution', summary: '서버 응답 헤더를 추가해 해결' })

      // 다른 프로젝트의 막힘·없는 로그는 구분 없이 not_found(422).
      const { log: foreignStuck } = await createLog(tx, { userId: other.owner.id }, other.project.id, stuckInput, at(0))
      const cross = await expectServiceError(createLog(tx, actor, project.id, solutionFor(foreignStuck.id)), 'VALIDATION')
      expect(cross.fields).toEqual({ resolvesEntryId: 'not_found' })
      const missing = await expectServiceError(createLog(tx, actor, project.id, solutionFor(crypto.randomUUID())), 'VALIDATION')
      expect(missing.fields).toEqual({ resolvesEntryId: 'not_found' })

      // 막힘이 아닌 로그는 해결할 수 없고, 해결 로그는 자기 자신을 가리킬 수 없습니다.
      const notStuck = await expectServiceError(createLog(tx, actor, project.id, solutionFor(s1.id)), 'VALIDATION')
      expect(notStuck.fields).toEqual({ resolvesEntryId: 'not_stuck' })
      const self = await expectServiceError(
        reviseLog(tx, actor, s1.id, { expectedRevision: 1, payload: solutionFor(s1.id).payload, resolvesEntryId: s1.id }),
        'VALIDATION',
      )
      expect(self.fields).toEqual({ resolvesEntryId: 'self' })

      // 막힘이 아닌 태그는 resolvesEntryId를 받지 않습니다.
      const notAllowed = await expectServiceError(
        createLog(tx, actor, project.id, { tag: 'progress', body: 'x', resolvesEntryId: stuck.id }),
        'VALIDATION',
      )
      expect(notAllowed.fields).toEqual({ resolvesEntryId: 'not_allowed' })
    })
  })

  it('meeting attendees must be (former) members of the project', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'viewer')
      const stranger = await createUser(tx)
      const actor = { userId: owner.id }
      const payload = (attendees: string[]) => ({ attendees, decisions: ['MySQL'], followUps: ['ERD 작성'] })
      const { log } = await createLog(tx, actor, project.id, { tag: 'meeting', payload: payload([owner.id, members[0]!.id]) })
      expect(log.payload).toEqual(payload([owner.id, members[0]!.id]))
      const bad = await expectServiceError(
        createLog(tx, actor, project.id, { tag: 'meeting', payload: payload([owner.id, stranger.id]) }),
        'VALIDATION',
      )
      expect(bad.fields).toEqual({ 'payload.attendees': 'not_member' })
    })
  })

  it('revisions append history; stale expectedRevision → 409 with currentRevision; tag cannot change', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const actor = { userId: owner.id }
      const { log } = await createLog(tx, actor, project.id, { ...stuckInput, claimedDate: '2026-11-01' }, at(0))

      const r2 = await reviseLog(
        tx,
        actor,
        log.id,
        { expectedRevision: 1, payload: { ...stuckInput.payload, symptom: 'CORS preflight 실패' }, body: '정정: 증상 구체화' },
        at(5),
      )
      expect(r2).toMatchObject({
        revisionNo: 2,
        body: '정정: 증상 구체화',
        claimedDate: '2026-11-01', // 생략한 필드는 이어받음
        createdAt: at(0).toISOString(),
        recordedAt: at(5).toISOString(),
      })

      // 다른 탭이 revision 1을 들고 저장하면 409이고 현재 번호를 알려 줍니다.
      const stale = await expectServiceError(
        reviseLog(tx, actor, log.id, { expectedRevision: 1, payload: stuckInput.payload, body: '덮어쓰기' }),
        'CONFLICT',
        'stale_revision',
      )
      expect(stale.details).toEqual({ currentRevision: 2 })

      const tagChange = await expectServiceError(
        reviseLog(tx, actor, log.id, { expectedRevision: 2, tag: 'solution', payload: stuckInput.payload }),
        'VALIDATION',
      )
      expect(tagChange.fields).toEqual({ tag: 'immutable' })
      // DB도 revision의 tag가 entry와 다르면 거부합니다(복합 외래 키).
      const fkState = await tx
        .transaction(async (sp) => {
          await sp.insert(logRevisions).values({ logEntryId: log.id, revisionNo: 9, tag: 'solution', body: '' })
        })
        .then(
          () => 'inserted',
          (error: unknown) => String((error as { cause?: { code?: string } }).cause?.code ?? error),
        )
      expect(fkState).toBe('23503')

      const noChange = await expectServiceError(
        reviseLog(tx, actor, log.id, {
          expectedRevision: 2,
          payload: { attempts: ['프록시 설정'], timeBucket: 'lt2h', symptom: 'CORS preflight 실패' },
        }),
        'VALIDATION',
      )
      expect(noChange.fields).toEqual({ _: 'no_changes' })

      const r3 = await reviseLog(tx, actor, log.id, { expectedRevision: 2, payload: r2.payload, claimedDate: null }, at(9))
      expect(r3).toMatchObject({ revisionNo: 3, claimedDate: null, body: '정정: 증상 구체화' })

      const history = await listLogRevisions(tx, actor, log.id)
      expect(history.map((r) => [r.revisionNo, r.recordedAt])).toEqual([
        [1, at(0).toISOString()],
        [2, at(5).toISOString()],
        [3, at(9).toISOString()],
      ])
      expect(history[0]).toMatchObject({ tag: 'stuck', body: '', payload: { symptom: 'CORS 에러' }, claimedDate: '2026-11-01' })
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, log.id))
      expect(audits.map((a) => a.action).sort()).toEqual(['log.create', 'log.revise', 'log.revise'])
      expect(audits.every((a) => !JSON.stringify(a.metadata).includes('CORS'))).toBe(true)
    })
  })

  it('only the author revises, and only while still owner/editor', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor', 'editor')
      const [author, other] = members
      const { log } = await createLog(tx, { userId: author!.id }, project.id, { tag: 'progress', body: '초안' })
      await expectServiceError(reviseLog(tx, { userId: owner.id }, log.id, { expectedRevision: 1, body: 'owner 수정' }), 'FORBIDDEN')
      await expectServiceError(reviseLog(tx, { userId: other!.id }, log.id, { expectedRevision: 1, body: '남의 수정' }), 'FORBIDDEN')
      expect((await reviseLog(tx, { userId: author!.id }, log.id, { expectedRevision: 1, body: '본인 수정' })).revisionNo).toBe(2)

      // 내보낸 뒤에는 그 프로젝트의 로그를 읽을 수도 없습니다. 로그 자체는 남습니다.
      await removeMember(tx, { userId: owner.id }, project.id, author!.id)
      await expectServiceError(reviseLog(tx, { userId: author!.id }, log.id, { expectedRevision: 2, body: 'x' }), 'NOT_FOUND')
      expect((await getLog(tx, { userId: owner.id }, log.id)).body).toBe('본인 수정')
    })
  })

  it('a retried create with the same clientId returns the existing log instead of duplicating', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const clientId = crypto.randomUUID()
      const first = await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '한 번만', clientId })
      const retry = await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '한 번만', clientId })
      expect(first.created).toBe(true)
      expect(retry).toEqual({ created: false, log: first.log })
      // 같은 clientId라도 다른 작성자면 별개입니다.
      const otherAuthor = await createLog(tx, { userId: members[0]!.id }, project.id, { tag: 'progress', body: 'x', clientId })
      expect(otherAuthor.created).toBe(true)
      const [{ count }] = (await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(logEntries)
        .where(eq(logEntries.projectId, project.id))) as [{ count: number }]
      expect(count).toBe(2)
    })
  })

  it('lists newest first with cursor pagination and tag/author filters', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const editor = members[0]!
      const ids: string[] = []
      for (let i = 0; i < 5; i++) {
        const author = i % 2 === 0 ? owner.id : editor.id
        const input = i === 3 ? stuckInput : { tag: 'progress', body: `진행 ${i}` }
        ids.push((await createLog(tx, { userId: author }, project.id, input, at(i))).log.id)
      }
      // 같은 시각에 만든 로그도 id로 순서가 정해져 빠짐없이 이어집니다.
      ids.push((await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '동시' }, at(4))).log.id)

      const seen: string[] = []
      let cursor: string | undefined
      for (let page = 0; page < 5; page++) {
        const result = await listLogs(tx, { userId: editor.id }, project.id, { limit: '2', ...(cursor && { cursor }) })
        seen.push(...result.items.map((l) => l.id))
        if (!result.nextCursor) break
        cursor = result.nextCursor
      }
      expect(seen).toHaveLength(6)
      expect(new Set(seen).size).toBe(6)
      expect(seen.slice(2)).toEqual([ids[3], ids[2], ids[1], ids[0]])

      const stuckOnly = await listLogs(tx, { userId: editor.id }, project.id, { tag: 'stuck' })
      expect(stuckOnly).toEqual({ items: [expect.objectContaining({ id: ids[3], tag: 'stuck' })], nextCursor: null })
      const mine = await listLogs(tx, { userId: editor.id }, project.id, { author: editor.id })
      expect(mine.items.map((l) => l.id)).toEqual([ids[3], ids[1]])

      const badCursor = await expectServiceError(listLogs(tx, { userId: editor.id }, project.id, { cursor: 'abc' }), 'VALIDATION')
      expect(badCursor.fields).toEqual({ cursor: 'invalid' })
      await expectServiceError(listLogs(tx, { userId: editor.id }, project.id, { limit: '100' }), 'VALIDATION')
    })
  })
})
