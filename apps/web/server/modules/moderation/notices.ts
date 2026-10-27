/**
 * 운영 조치 안내·이의제기 (T-15, PROOFU_EVOLUTION_PLAN §9.4 "원인 확인과 이의제기 기록", ADR 0015).
 *
 * - 안내는 화면 안에서만(메일 없음): 공개 준비 화면·선배 노트·케이스 스터디 편집 화면의 안내 상자, `/me/moderation-notices` 목록.
 *   당사자(공개 owner·작성자·프로필 주인)에게 조치 종류·당사자용 사유(public_reason)·이의 상태만 보여 주고 내부 메모·신고 내용·신고자는 싣지 않습니다.
 *   목록은 운영자가 "당사자에게 알림"을 켠 조치만, 화면 안내 상자는 지금 효력이 있는 조치 모두(owner가 상태를 이해하도록)입니다.
 * - 이의제기 `POST /api/v1/appeals {actionId | reportId, message}`: 조치의 당사자만(아니면 404), 조치마다 한 번(409 already_appealed),
 *   조치 없음 409 not_appealable, 이미 되돌린 조치 409 already_reversed. 감사에는 메시지 글을 넣지 않습니다.
 */
import { z } from 'zod'
import { APPEAL_MESSAGE_MAX, type HiddenItemKind, canAppeal, clipText } from '@peerchive/domain'
import {
  and,
  appeals,
  caseStudies,
  desc,
  eq,
  inArray,
  isNull,
  moderationActions,
  ne,
  projectMembers,
  publicationCandidates,
  publications,
  reports,
  seniorNotes,
  sql,
  type DbExecutor,
  type SQL,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, notFound, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { affectedUserIds, pointerOf, targetLabels } from './targets'
import type { ActionRow } from './actions'
import type { AppealDto, ModerationNoticeDto, PublicSnapshot } from '../../../shared/types/api'

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const createAppealSchema = z
  .object({
    actionId: z.uuid({ error: 'invalid' }).transform((v) => v.toLowerCase()).optional(),
    reportId: z.uuid({ error: 'invalid' }).transform((v) => v.toLowerCase()).optional(),
    message: z
      .string({ error: requiredOr('invalid') })
      .trim()
      .min(1, { error: 'required' })
      .max(APPEAL_MESSAGE_MAX, { error: 'too_long' }),
  })
  .refine((v) => !!v.actionId !== !!v.reportId, { error: 'required', path: ['actionId'] })

function itemLabel(snapshot: PublicSnapshot, kind: HiddenItemKind, key: string): string {
  if (kind === 'log') {
    const log = snapshot.logs.find((l) => l.key === key)
    if (!log) return '기록'
    const p = log.payload as Record<string, unknown>
    const text = log.tag === 'stuck' ? String(p.symptom ?? '') : log.body || String(p.method ?? p.choice ?? p.target ?? '')
    return `기록: ${clipText(text, 40) || log.tag}`
  }
  if (kind === 'claim') {
    const claim = snapshot.claims.find((c) => c.key === key)
    return claim ? `역할 선언: ${clipText(claim.text, 40)}` : '역할 선언'
  }
  const file = snapshot.artifacts.find((a) => a.artifactVersionId === key)
  return file ? `파일: ${file.displayName}` : '파일'
}

/** 조치 행 → 당사자 안내 DTO(viewer가 당사자인지에 따라 canAppeal). */
async function toNotices(db: DbExecutor, actions: readonly ActionRow[], viewerId: string): Promise<ModerationNoticeDto[]> {
  const visible = actions.filter((a) => a.kind !== 'none')
  if (visible.length === 0) return []
  const ids = visible.map((a) => a.id)
  const pubIds = [...new Set(visible.map((a) => a.publicationId).filter((id): id is string => !!id))]
  const noteIds = [...new Set(visible.map((a) => a.seniorNoteId).filter((id): id is string => !!id))]
  const releaseIds = [...new Set(visible.filter((a) => a.kind === 'hide_item').map((a) => a.releaseId).filter((id): id is string => !!id))]
  const [appealRows, pubRows, noteRows, releaseRows, labels] = await Promise.all([
    db.select().from(appeals).where(inArray(appeals.actionId, ids)),
    pubIds.length ? db.select({ id: publications.id, projectId: publications.projectId }).from(publications).where(inArray(publications.id, pubIds)) : [],
    noteIds.length ? db.select({ id: seniorNotes.id, courseId: seniorNotes.courseId }).from(seniorNotes).where(inArray(seniorNotes.id, noteIds)) : [],
    releaseIds.length
      ? db.select({ id: publicationCandidates.id, snapshot: publicationCandidates.snapshot }).from(publicationCandidates).where(inArray(publicationCandidates.id, releaseIds))
      : [],
    targetLabels(db, visible.map((a) => pointerOf(a))),
  ])
  const appealBy = new Map(appealRows.map((a) => [a.actionId, a]))
  const projectBy = new Map(pubRows.map((p) => [p.id, p.projectId]))
  const courseBy = new Map(noteRows.map((n) => [n.id, n.courseId]))
  const snapshotBy = new Map(releaseRows.map((r) => [r.id, r.snapshot as unknown as PublicSnapshot]))
  // 댓글 조치의 당사자 화면 주소(그 글). 커뮤니티 모듈을 import하지 않고 글 id만 읽습니다(C-05 경계의 문서화된 예외, ADR 0022).
  const commentIds = visible.map((a) => a.communityCommentId).filter((id): id is string => !!id)
  const commentPostBy = new Map<string, string>()
  if (commentIds.length) {
    const rows = (await db.execute(sql`select id, post_id from community_comments where id in (${sql.join(
      commentIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`)) as unknown as Array<{
      id: string
      post_id: string
    }>
    for (const r of rows) commentPostBy.set(r.id, r.post_id)
  }
  const out: ModerationNoticeDto[] = []
  for (const a of visible) {
    const affected = await affectedUserIds(db, pointerOf(a))
    const appeal = appealBy.get(a.id)
    let ownerPath: string | null = null
    if (a.publicationId && projectBy.get(a.publicationId)) ownerPath = `/projects/${projectBy.get(a.publicationId)}/publish`
    else if (a.seniorNoteId) ownerPath = `/senior-notes?course=${courseBy.get(a.seniorNoteId) ?? ''}`
    else if (a.caseStudyId) ownerPath = `/portfolio/case-studies/${a.caseStudyId}`
    else if (a.profileUserId) ownerPath = '/onboarding'
    else if (a.communitySpaceId) ownerPath = '/community'
    else if (a.communityPostId) ownerPath = `/community/p/${a.communityPostId}`
    else if (a.communityCommentId) ownerPath = `/community/p/${commentPostBy.get(a.communityCommentId) ?? ''}`
    const snapshot = a.releaseId ? snapshotBy.get(a.releaseId) : undefined
    out.push({
      actionId: a.id,
      kind: a.kind as ModerationNoticeDto['kind'],
      targetType: a.targetType,
      targetLabel: labels.get(a.targetKey) ?? '',
      ownerPath,
      item: a.kind === 'hide_item' && a.itemKind && a.itemKey ? { kind: a.itemKind, key: a.itemKey, label: snapshot ? itemLabel(snapshot, a.itemKind, a.itemKey) : a.itemKind } : null,
      publicReason: a.publicReason,
      createdAt: a.createdAt.toISOString(),
      reversedAt: a.reversedAt?.toISOString() ?? null,
      appeal: appeal ? { status: appeal.status, createdAt: appeal.createdAt.toISOString(), decidedAt: appeal.decidedAt?.toISOString() ?? null } : null,
      canAppeal: affected.includes(viewerId) && canAppeal({ kind: a.kind, reversed: a.reversedAt !== null }, !!appeal) === 'ok',
    })
  }
  return out
}

/** 이 사용자가 당사자인 조치 조건(공개 owner·노트 작성자·케이스 작성자·프로필 주인·커뮤니티 방장(공간 조치)·글/댓글 작성자(C-04)). */
function affectedSql(userId: string): SQL {
  return sql`(
    (${moderationActions.publicationId} is not null and exists (select 1 from ${publications} p join ${projectMembers} pm on pm.project_id = p.project_id
      where p.id = ${moderationActions.publicationId} and pm.user_id = ${userId} and pm.role = 'owner' and pm.status = 'active'))
    or (${moderationActions.seniorNoteId} is not null and exists (select 1 from ${seniorNotes} n where n.id = ${moderationActions.seniorNoteId} and n.author_id = ${userId}))
    or (${moderationActions.caseStudyId} is not null and exists (select 1 from ${caseStudies} c where c.id = ${moderationActions.caseStudyId} and c.user_id = ${userId}))
    or ${moderationActions.profileUserId} = ${userId}
    or (${moderationActions.communitySpaceId} is not null and exists (select 1 from space_memberships sm
      where sm.space_id = ${moderationActions.communitySpaceId} and sm.user_id = ${userId} and sm.role = 'owner' and sm.status = 'active'))
    or (${moderationActions.communityPostId} is not null and exists (select 1 from community_posts cp where cp.id = ${moderationActions.communityPostId} and cp.author_id = ${userId}))
    or (${moderationActions.communityCommentId} is not null and exists (select 1 from community_comments cc where cc.id = ${moderationActions.communityCommentId} and cc.author_id = ${userId})))`
}

/** GET /me/moderation-notices — 내가 당사자인 조치 중 운영자가 알림을 켠 것(되돌린 것 포함, 최근 50). */
export async function listMyModerationNotices(db: DbExecutor, actor: Actor): Promise<ModerationNoticeDto[]> {
  const rows = await db
    .select()
    .from(moderationActions)
    .where(and(ne(moderationActions.kind, 'none'), eq(moderationActions.notifyOwner, true), affectedSql(actor.userId)))
    .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
    .limit(50)
  return toNotices(db, rows, actor.userId)
}

/** 화면 안내 상자용: 대상에 지금 효력이 있는(되돌리지 않은) 조치. */
async function activeNotices(db: DbExecutor, actor: Actor, where: SQL | undefined): Promise<ModerationNoticeDto[]> {
  const rows = await db
    .select()
    .from(moderationActions)
    .where(and(ne(moderationActions.kind, 'none'), isNull(moderationActions.reversedAt), where))
    .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
    .limit(50)
  return toNotices(db, rows, actor.userId)
}

export const publicationNotices = (db: DbExecutor, actor: Actor, publicationId: string) =>
  activeNotices(db, actor, eq(moderationActions.publicationId, publicationId))

export async function seniorNoteNotice(db: DbExecutor, actor: Actor, noteId: string): Promise<ModerationNoticeDto | null> {
  return (await activeNotices(db, actor, and(eq(moderationActions.seniorNoteId, noteId), eq(moderationActions.kind, 'hide_note'))))[0] ?? null
}

export async function caseStudyNotice(db: DbExecutor, actor: Actor, caseStudyId: string): Promise<ModerationNoticeDto | null> {
  return (await activeNotices(db, actor, and(eq(moderationActions.caseStudyId, caseStudyId), eq(moderationActions.kind, 'hide_case_study'))))[0] ?? null
}

/** POST /appeals {actionId | reportId, message} — 201 + 이의. 당사자가 아니거나 없으면 404, 409 not_appealable·already_appealed·already_reversed, 422. */
export async function createAppeal(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<AppealDto> {
  const input = parseInput(createAppealSchema, rawInput)
  return db.transaction(async (tx) => {
    let actionId = input.actionId ?? null
    if (input.reportId) {
      const [report] = await tx.select({ actionId: reports.actionId }).from(reports).where(eq(reports.id, input.reportId)).limit(1)
      actionId = report?.actionId ?? null
    }
    if (!actionId || !isUuid(actionId)) throw notFound()
    const [action] = await tx.select().from(moderationActions).where(eq(moderationActions.id, actionId)).limit(1).for('update')
    if (!action) throw notFound()
    // 당사자가 아니면 조치의 존재를 드러내지 않습니다.
    if (!(await affectedUserIds(tx, pointerOf(action))).includes(actor.userId)) throw notFound()
    const [existing] = await tx.select({ id: appeals.id }).from(appeals).where(eq(appeals.actionId, action.id)).limit(1)
    const check = canAppeal({ kind: action.kind, reversed: action.reversedAt !== null }, !!existing)
    if (check !== 'ok') throw conflict(check)
    let row
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp.insert(appeals).values({ actionId: action.id, appellantId: actor.userId, message: input.message, createdAt: now }).returning()
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('already_appealed')
      throw error
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'appeal.create',
      targetType: 'appeal',
      targetId: row.id,
      metadata: { actionId: action.id, kind: action.kind },
    })
    return { id: row.id, actionId: action.id, status: row.status, createdAt: row.createdAt.toISOString() }
  })
}

