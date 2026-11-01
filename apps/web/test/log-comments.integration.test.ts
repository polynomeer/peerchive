/**
 * E-10 로그별 피드백 댓글 통합 테스트(실제 PostgreSQL, ADR 0054). DATABASE_URL이 없으면 건너뜁니다.
 * 팀 안에서만 읽고 쓰기(비멤버·나간 멤버 404, viewer 403), 로그 수정 뒤에도 유지, 작성자 수정·삭제, owner 숨김,
 * 보관 과제 읽기 전용, 공개 스냅샷·공개 조회·후보 미리보기에 댓글이 들어가지 않는지(회귀)를 봅니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { and, auditEvents, eq, logComments, projects, publicationCandidates, type DbExecutor } from '@peerchive/db'
import {
  LOG_COMMENT_RATE_LIMIT,
  createLogComment,
  deleteLogComment,
  editLogComment,
  listLogComments,
  setLogCommentHidden,
} from '../server/modules/logs/comments'
import { createLog, getLog, listLogs, reviseLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { leaveProject } from '../server/modules/projects/members'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate, decideConsent, getCandidate } from '../server/modules/publication/candidates'
import { getPublicPublication } from '../server/modules/publication/public-read'
import { publishCandidate } from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }

async function teamWith(db: DbExecutor, ...roles: Array<'editor' | 'reviewer' | 'viewer'>) {
  const owner = await createUser(db, { displayName: '김소유' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' }, T0)
  const members = []
  for (const role of roles) {
    const user = await createUser(db, { displayName: `팀원 ${role}` })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members.push(user)
  }
  return { owner, project, members }
}

describe.skipIf(!databaseUrl)('log feedback comments (PostgreSQL, E-10)', () => {
  afterAll(closeTestDb)

  it('members read; owner/editor/reviewer write; viewer is forbidden; strangers and former members get NOT_FOUND', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor', 'reviewer', 'viewer')
      const [editor, reviewer, viewer] = [members[0]!, members[1]!, members[2]!]
      const stranger = await createUser(tx)
      const { log } = await createLog(tx, { userId: editor.id }, project.id, { tag: 'progress', body: '로그인 API 완성' }, at(1))

      const c1 = await createLogComment(tx, { userId: reviewer.id }, log.id, { body: '  테스트 케이스도 남겨 주세요 \r\n 좋아요 ' }, at(2))
      expect(c1).toMatchObject({
        logId: log.id,
        status: 'published',
        body: '테스트 케이스도 남겨 주세요 \n 좋아요',
        revisionNo: 1,
        createdAt: at(2).toISOString(),
        editedAt: null,
        mine: true,
        canEdit: true,
        canDelete: true,
        canHide: false,
        author: { userId: reviewer.id, displayName: '팀원 reviewer' },
      })
      await createLogComment(tx, { userId: owner.id }, log.id, { body: '확인했어요' }, at(3))

      const forViewer = await listLogComments(tx, { userId: viewer.id }, log.id)
      expect(forViewer.canComment).toBe(false)
      expect(forViewer.items.map((c) => c.body)).toEqual(['테스트 케이스도 남겨 주세요 \n 좋아요', '확인했어요'])
      expect(forViewer.items.every((c) => !c.canEdit && !c.canDelete && !c.canHide)).toBe(true)
      await expectServiceError(createLogComment(tx, { userId: viewer.id }, log.id, { body: '저도' }, at(4)), 'FORBIDDEN')
      expect((await listLogComments(tx, { userId: owner.id }, log.id)).items.map((c) => c.canHide)).toEqual([true, true])

      // 비멤버: 목록·작성·수정·삭제·숨김 모두 404(존재를 드러내지 않음).
      await expectServiceError(listLogComments(tx, { userId: stranger.id }, log.id), 'NOT_FOUND')
      await expectServiceError(createLogComment(tx, { userId: stranger.id }, log.id, { body: '몰래' }, at(4)), 'NOT_FOUND')
      await expectServiceError(editLogComment(tx, { userId: stranger.id }, c1.id, { body: '몰래' }, at(4)), 'NOT_FOUND')
      await expectServiceError(deleteLogComment(tx, { userId: stranger.id }, c1.id, at(4)), 'NOT_FOUND')
      await expectServiceError(setLogCommentHidden(tx, { userId: stranger.id }, c1.id, { hidden: true }, at(4)), 'NOT_FOUND')
      await expectServiceError(listLogComments(tx, { userId: stranger.id }, 'not-a-uuid'), 'NOT_FOUND')
      await expectServiceError(deleteLogComment(tx, { userId: stranger.id }, crypto.randomUUID(), at(4)), 'NOT_FOUND')

      // 나간 멤버는 자기 댓글도 더는 볼 수 없습니다(404).
      await leaveProject(tx, { userId: reviewer.id }, project.id)
      await expectServiceError(listLogComments(tx, { userId: reviewer.id }, log.id), 'NOT_FOUND')
      await expectServiceError(deleteLogComment(tx, { userId: reviewer.id }, c1.id, at(5)), 'NOT_FOUND')

      // 로그 DTO의 댓글 수(게시 상태만).
      expect((await getLog(tx, { userId: owner.id }, log.id)).commentCount).toBe(2)
      expect((await listLogs(tx, { userId: viewer.id }, project.id, {})).items[0]!.commentCount).toBe(2)

      // 감사: 댓글 id·로그 id만(본문 없음).
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, c1.id), eq(auditEvents.action, 'log_comment.create')))
      expect(audits).toEqual([expect.objectContaining({ targetType: 'log_comment', projectId: project.id, metadata: { logId: log.id } })])
    })
  })

  it('validates bodies (1–2000 chars) and rate-limits creation', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const { log } = await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '진행' }, at(1))
      await expectServiceError(createLogComment(tx, { userId: owner.id }, log.id, { body: '   ' }, at(2)), 'VALIDATION')
      await expectServiceError(createLogComment(tx, { userId: owner.id }, log.id, {}, at(2)), 'VALIDATION')
      await expect(createLogComment(tx, { userId: owner.id }, log.id, { body: '가'.repeat(2001) }, at(2))).rejects.toMatchObject({ fields: { body: 'too_long' } })
      expect((await createLogComment(tx, { userId: owner.id }, log.id, { body: '가'.repeat(2000) }, at(2))).body).toHaveLength(2000)
      for (let i = 1; i < LOG_COMMENT_RATE_LIMIT.limit; i++) await createLogComment(tx, { userId: owner.id }, log.id, { body: `댓글 ${i}` }, at(2))
      await expectServiceError(createLogComment(tx, { userId: owner.id }, log.id, { body: '한도 초과' }, at(2)), 'RATE_LIMITED')
    })
  })

  it('comments stay on the log across revisions and keep the revision they were written on', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const editor = members[0]!
      const { log } = await createLog(tx, { userId: editor.id }, project.id, { tag: 'progress', body: '초안' }, at(1))
      const before = await createLogComment(tx, { userId: owner.id }, log.id, { body: '근거 링크가 있으면 좋겠어요' }, at(2))
      const revised = await reviseLog(tx, { userId: editor.id }, log.id, { expectedRevision: 1, body: '초안 + 링크' }, at(3))
      expect(revised.revisionNo).toBe(2)
      expect(revised.commentCount).toBe(1)
      const after = await createLogComment(tx, { userId: owner.id }, log.id, { body: '반영 확인' }, at(4))
      const list = await listLogComments(tx, { userId: editor.id }, log.id)
      expect(list.items.map((c) => [c.id, c.revisionNo, c.body])).toEqual([
        [before.id, 1, '근거 링크가 있으면 좋겠어요'],
        [after.id, 2, '반영 확인'],
      ])
    })
  })

  it('only the author edits and deletes (soft, body cleared); the owner hides and unhides but cannot edit or delete', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor', 'reviewer')
      const [editor, reviewer] = [members[0]!, members[1]!]
      const { log } = await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '진행' }, at(1))
      const c = await createLogComment(tx, { userId: editor.id }, log.id, { body: '처음 의견' }, at(2))

      const edited = await editLogComment(tx, { userId: editor.id }, c.id, { body: '고친 의견' }, at(3))
      expect(edited).toMatchObject({ body: '고친 의견', editedAt: at(3).toISOString(), revisionNo: 1 })
      await expectServiceError(editLogComment(tx, { userId: owner.id }, c.id, { body: '남의 글' }, at(3)), 'FORBIDDEN')
      await expectServiceError(deleteLogComment(tx, { userId: owner.id }, c.id, at(3)), 'FORBIDDEN')
      await expectServiceError(setLogCommentHidden(tx, { userId: editor.id }, c.id, { hidden: true }, at(3)), 'FORBIDDEN')

      // owner 숨김: 작성자·owner만 본문을 보고, 다른 멤버에게는 자리만.
      const hidden = await setLogCommentHidden(tx, { userId: owner.id }, c.id, { hidden: true }, at(4))
      expect(hidden).toMatchObject({ status: 'hidden', body: '고친 의견', canHide: true })
      const forReviewer = (await listLogComments(tx, { userId: reviewer.id }, log.id)).items[0]!
      expect(forReviewer).toMatchObject({ status: 'hidden', body: null, author: null, editedAt: null })
      expect((await listLogComments(tx, { userId: editor.id }, log.id)).items[0]).toMatchObject({ status: 'hidden', body: '고친 의견', canEdit: false, canDelete: true })
      expect((await getLog(tx, { userId: reviewer.id }, log.id)).commentCount).toBe(0)
      await expectServiceError(editLogComment(tx, { userId: editor.id }, c.id, { body: '숨김 중 수정' }, at(5)), 'FORBIDDEN')
      // 같은 상태로 다시 보내면 바꾸지 않습니다(감사 한 번).
      await setLogCommentHidden(tx, { userId: owner.id }, c.id, { hidden: true }, at(5))
      const unhidden = await setLogCommentHidden(tx, { userId: owner.id }, c.id, { hidden: false }, at(6))
      expect(unhidden).toMatchObject({ status: 'published', body: '고친 의견' })
      const hideAudits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, c.id))
      expect(hideAudits.map((a) => a.action).sort()).toEqual(['log_comment.create', 'log_comment.edit', 'log_comment.hide', 'log_comment.unhide'])
      expect(hideAudits.every((a) => JSON.stringify(a.metadata) === JSON.stringify({ logId: log.id }))).toBe(true)

      // 작성자 삭제: 본문을 비우고 자리는 남김. 재전송은 그대로, 지운 댓글은 숨김 대상이 아님.
      const deleted = await deleteLogComment(tx, { userId: editor.id }, c.id, at(7))
      expect(deleted).toMatchObject({ status: 'deleted', body: null, author: null, canDelete: false, canEdit: false, canHide: false, mine: true })
      const [row] = await tx.select().from(logComments).where(eq(logComments.id, c.id))
      expect(row).toMatchObject({ status: 'deleted', body: '', deletedAt: at(7) })
      expect((await deleteLogComment(tx, { userId: editor.id }, c.id, at(8))).status).toBe('deleted')
      await expectServiceError(setLogCommentHidden(tx, { userId: owner.id }, c.id, { hidden: true }, at(8)), 'CONFLICT', 'comment_deleted')
      expect((await listLogComments(tx, { userId: owner.id }, log.id)).items).toEqual([expect.objectContaining({ id: c.id, status: 'deleted', body: null })])
    })
  })

  it('archived projects are read-only for new comments and edits; delete and hide still work', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const editor = members[0]!
      const { log } = await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '진행' }, at(1))
      const c = await createLogComment(tx, { userId: editor.id }, log.id, { body: '의견' }, at(2))
      await tx.update(projects).set({ lifecycle: 'archived' }).where(eq(projects.id, project.id))
      const list = await listLogComments(tx, { userId: editor.id }, log.id)
      expect(list).toMatchObject({ canComment: false, archived: true })
      expect(list.items[0]).toMatchObject({ canEdit: false, canDelete: true })
      await expectServiceError(createLogComment(tx, { userId: editor.id }, log.id, { body: '새 의견' }, at(3)), 'CONFLICT', 'project_archived')
      await expectServiceError(editLogComment(tx, { userId: editor.id }, c.id, { body: '수정' }, at(3)), 'CONFLICT', 'project_archived')
      expect((await setLogCommentHidden(tx, { userId: owner.id }, c.id, { hidden: true }, at(3))).status).toBe('hidden')
      expect((await deleteLogComment(tx, { userId: editor.id }, c.id, at(4))).status).toBe('deleted')
    })
  })

  it('regression: comments never enter the candidate snapshot, preview or the public publication', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const editor = members[0]!
      const ownerLog = (await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '파서 완성' }, at(1))).log
      const editorLog = (await createLog(tx, { userId: editor.id }, project.id, { tag: 'progress', body: '파이프 구현' }, at(2))).log
      const secrets = ['COMMENT_SECRET_피드백_1', 'COMMENT_SECRET_피드백_2', 'COMMENT_SECRET_숨김_3']
      const c1 = await createLogComment(tx, { userId: editor.id }, ownerLog.id, { body: secrets[0]! }, at(3))
      const c2 = await createLogComment(tx, { userId: owner.id }, editorLog.id, { body: secrets[1]! }, at(4))
      const c3 = await createLogComment(tx, { userId: owner.id }, editorLog.id, { body: secrets[2]! }, at(5))
      await setLogCommentHidden(tx, { userId: owner.id }, c3.id, { hidden: true }, at(6))
      const ids = [c1.id, c2.id, c3.id]

      const candidate = await createCandidate(
        tx,
        { userId: owner.id },
        project.id,
        {
          level: 'full',
          title: '셸 구현 과제',
          summary: '파이프와 리다이렉션을 구현했다.',
          slug: `case-${crypto.randomUUID().slice(0, 8)}`,
          logIds: [ownerLog.id, editorLog.id],
          artifactVersionIds: [],
          exposure: { [owner.id]: 'name' },
          consentSelf: true,
        },
        at(10),
        ORIGINS,
      )
      const ready = await decideConsent(tx, { userId: editor.id }, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(11))
      expect(ready.status).toBe('ready')
      await publishCandidate(tx, { userId: owner.id }, candidate.id, { manifestHash: ready.manifestHash, idempotencyKey: 'k-e10' }, at(12))

      const [row] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidate.id))
      const pub = await getPublicPublication(tx, candidate.slug, at(13))
      const preview = await getCandidate(tx, { userId: owner.id }, candidate.id, at(13))
      // 로그 본문은 실렸는지 확인해 스냅샷이 비어서 통과하는 것이 아님을 보입니다.
      expect(JSON.stringify(pub)).toContain('파이프 구현')
      for (const text of [JSON.stringify(row), JSON.stringify(pub), JSON.stringify(preview)]) {
        for (const secret of [...secrets, ...ids]) expect(text).not.toContain(secret)
        expect(text).not.toMatch(/comment/i)
      }
    })
  })
})
