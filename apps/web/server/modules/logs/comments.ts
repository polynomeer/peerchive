/**
 * 로그별 피드백 댓글 (E-10, PROOFU_EVOLUTION_PLAN §16, DELIVERY_PLAN §4.4 E-10, ADR 0054).
 *
 * - 팀 안에서만: 로그를 읽을 수 있는 active 멤버가 읽고(그 밖에는 로그와 같은 404), owner/editor/reviewer가 씁니다(viewer 403).
 * - 댓글은 로그(entry)에 붙고 쓸 때의 revision 번호만 맥락으로 남깁니다. 로그를 고쳐도(새 revision) 댓글은 그대로입니다.
 * - 보관(archived) 과제는 새 댓글·수정 409 `project_archived`. 삭제·숨김은 허용합니다.
 * - 수정은 작성자 본인(게시 상태)만, 삭제도 작성자 본인만(본문을 비우는 소프트 삭제), 숨김·숨김 해제는 owner만.
 * - 본문 1~2000자(앞뒤 공백 제거), 생성·수정은 사용자당 시간 한도(`log_comment`). 로그 하나에 댓글 200개까지(409 `limit_reached`).
 * - 감사 이벤트는 댓글 id·로그 id만 남기고 본문은 넣지 않습니다. 알림·분석 이벤트·기여 장부 집계는 없습니다.
 * - 공개 스냅샷(publication/snapshot.ts)·공개 DTO·검색·케이스는 이 테이블을 읽지 않습니다(허용 목록에 없음, ADR 0011).
 * - 익명 스터디 기록(ADR 0026 부록)은 로그와 같이 작성자를 멤버 참조로 가립니다(loadMemberRefs).
 */
import {
  LOG_COMMENT_BODY_MAX,
  LOG_COMMENT_LIMIT,
  type LogCommentRef,
  type Membership,
  canDeleteLogComment,
  canEditLogComment,
  canHideLogComment,
  canSeeLogCommentBody,
  canWriteLogComment,
  hasLogCommentRole,
  isProjectArchived,
  normalizeLogCommentBody,
} from '@peerchive/domain'
import { asc, eq, inArray, logComments, profiles, sql, users, type DbExecutor } from '@peerchive/db'
import { z } from 'zod'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, notFound, rateLimited } from '../errors'
import { type ProjectRow, isUuid, loadReadableProject } from '../projects/access'
import { type MemberRefs, loadMemberRefs } from '../projects/member-refs'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { loadReadableLog } from './logs'
import type { LogCommentDto, LogCommentListDto } from '../../../shared/types/api'

export type { LogCommentDto, LogCommentListDto }

/** 댓글 쓰기·수정 한도(사용자당). */
export const LOG_COMMENT_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 60 * 1000 }

type CommentRow = typeof logComments.$inferSelect

const bodySchema = z
  .string({ error: (i) => (i.input === undefined ? 'required' : 'invalid') })
  .transform((v, ctx) => {
    const body = normalizeLogCommentBody(v)
    if (!body) {
      ctx.addIssue({ code: 'custom', message: 'required' })
      return z.NEVER
    }
    if (body.length > LOG_COMMENT_BODY_MAX) {
      ctx.addIssue({ code: 'custom', message: 'too_long' })
      return z.NEVER
    }
    return body
  })
const commentInputSchema = z.object({ body: bodySchema })
const hiddenInputSchema = z.object({ hidden: z.boolean({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }) })

// ── DTO ──────────────────────────────────────────────────────────────────

interface Viewing {
  actor: Actor
  project: ProjectRow
  membership: Membership
  refs: MemberRefs
}

async function authorsOf(db: DbExecutor, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, { displayName: string; handle: string | null }>()
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, handle: profiles.handle })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(inArray(users.id, [...new Set(userIds)]))
  return new Map(rows.map((row) => [row.id, { displayName: row.displayName, handle: row.handle }]))
}

async function toDtos(db: DbExecutor, viewing: Viewing, rows: CommentRow[]): Promise<LogCommentDto[]> {
  const { actor, project, membership, refs } = viewing
  const viewer = { userId: actor.userId }
  const authors = await authorsOf(
    db,
    rows.map((row) => row.authorId),
  )
  return rows.map((row) => {
    const ref: LogCommentRef = { authorId: row.authorId, status: row.status }
    const visible = canSeeLogCommentBody(viewer, membership, ref)
    const author = authors.get(row.authorId)
    return {
      id: row.id,
      logId: row.logEntryId,
      status: row.status,
      author: visible && author ? refs.person({ userId: row.authorId, displayName: author.displayName, handle: author.handle }) : null,
      body: visible ? row.body : null,
      revisionNo: row.revisionNo,
      createdAt: row.createdAt.toISOString(),
      editedAt: visible ? (row.editedAt?.toISOString() ?? null) : null,
      mine: row.authorId === actor.userId,
      canEdit: canEditLogComment(viewer, project, membership, ref),
      canDelete: canDeleteLogComment(viewer, project, membership, ref),
      canHide: canHideLogComment(viewer, project, membership, ref),
    }
  })
}

async function viewingOf(db: DbExecutor, actor: Actor, project: ProjectRow, membership: Membership): Promise<Viewing> {
  return { actor, project, membership, refs: await loadMemberRefs(db, project, actor.userId) }
}

/**
 * 댓글과 그 과제 접근 컨텍스트. 없거나 읽을 수 없으면 똑같이 404. 트랜잭션 안에서 댓글 행을 잠급니다.
 */
async function loadComment(tx: DbExecutor, actor: Actor, commentId: unknown) {
  if (!isUuid(commentId)) throw notFound()
  const [comment] = await tx.select().from(logComments).where(eq(logComments.id, commentId)).limit(1).for('update')
  if (!comment) throw notFound()
  const { project, membership } = await loadReadableProject(tx, actor, comment.projectId)
  return { comment, project, membership }
}

async function single(tx: DbExecutor, actor: Actor, project: ProjectRow, membership: Membership, row: CommentRow): Promise<LogCommentDto> {
  const [dto] = await toDtos(tx, await viewingOf(tx, actor, project, membership), [row])
  return dto!
}

// ── 조회 ─────────────────────────────────────────────────────────────────

/** GET /logs/:id/comments — 오래된 순(최대 200개). 지운·숨긴 댓글은 자리만 남깁니다. */
export async function listLogComments(db: DbExecutor, actor: Actor, logId: unknown): Promise<LogCommentListDto> {
  const { project, membership, log } = await loadReadableLog(db, actor, logId)
  const rows = await db
    .select()
    .from(logComments)
    .where(eq(logComments.logEntryId, log.entry.id))
    .orderBy(asc(logComments.createdAt), asc(logComments.id))
    .limit(LOG_COMMENT_LIMIT)
  return {
    items: await toDtos(db, await viewingOf(db, actor, project, membership), rows),
    canComment: canWriteLogComment({ userId: actor.userId }, project, membership),
    archived: isProjectArchived(project),
  }
}

// ── 쓰기 ─────────────────────────────────────────────────────────────────

/** 쓰기 역할 확인: 역할이 없으면 403, 역할은 있지만 보관된 과제면 409 `project_archived`. */
function assertWritable(actor: Actor, project: ProjectRow, membership: Membership): void {
  if (!hasLogCommentRole({ userId: actor.userId }, project, membership)) throw forbidden()
  if (isProjectArchived(project)) throw conflict('project_archived')
}

/** POST /logs/:id/comments {body} — owner/editor/reviewer. 로그 행을 잠가 개수 한도를 직렬화합니다. */
export async function createLogComment(
  db: DbExecutor,
  actor: Actor,
  logId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<LogCommentDto> {
  return db.transaction(async (tx) => {
    const { project, membership, log } = await loadReadableLog(tx, actor, logId, { lock: true })
    assertWritable(actor, project, membership)
    const { body } = parseInput(commentInputSchema, rawInput)
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(logComments)
      .where(eq(logComments.logEntryId, log.entry.id))
    if ((count?.n ?? 0) >= LOG_COMMENT_LIMIT) throw conflict('limit_reached')
    if (!(await hitRateLimit(tx, 'log_comment', actor.userId, LOG_COMMENT_RATE_LIMIT, now))) throw rateLimited()
    const [row] = await tx
      .insert(logComments)
      .values({
        projectId: project.id,
        logEntryId: log.entry.id,
        authorId: actor.userId,
        revisionNo: log.revision.revisionNo,
        body,
        createdAt: now,
      })
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'log_comment.create',
      targetType: 'log_comment',
      targetId: row!.id,
      projectId: project.id,
      metadata: { logId: log.entry.id },
    })
    return single(tx, actor, project, membership, row!)
  })
}

/** PATCH /log-comments/:id {body} — 작성자 본인(게시 상태, 지금도 쓰기 역할). 같은 본문이면 바꾸지 않고 돌려줍니다. */
export async function editLogComment(
  db: DbExecutor,
  actor: Actor,
  commentId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<LogCommentDto> {
  return db.transaction(async (tx) => {
    const { comment, project, membership } = await loadComment(tx, actor, commentId)
    if (comment.authorId !== actor.userId || comment.status !== 'published') throw forbidden()
    assertWritable(actor, project, membership)
    if (!canEditLogComment({ userId: actor.userId }, project, membership, comment)) throw forbidden()
    const { body } = parseInput(commentInputSchema, rawInput)
    if (body === comment.body) return single(tx, actor, project, membership, comment)
    if (!(await hitRateLimit(tx, 'log_comment', actor.userId, LOG_COMMENT_RATE_LIMIT, now))) throw rateLimited()
    const [row] = await tx.update(logComments).set({ body, editedAt: now }).where(eq(logComments.id, comment.id)).returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'log_comment.edit',
      targetType: 'log_comment',
      targetId: comment.id,
      projectId: project.id,
      metadata: { logId: comment.logEntryId },
    })
    return single(tx, actor, project, membership, row!)
  })
}

/** DELETE /log-comments/:id — 작성자 본인. 본문을 비우고 자리는 남깁니다. 이미 지웠으면 그대로 돌려줍니다(재전송). */
export async function deleteLogComment(db: DbExecutor, actor: Actor, commentId: unknown, now = new Date()): Promise<LogCommentDto> {
  return db.transaction(async (tx) => {
    const { comment, project, membership } = await loadComment(tx, actor, commentId)
    if (comment.authorId !== actor.userId) throw forbidden()
    if (comment.status === 'deleted') return single(tx, actor, project, membership, comment)
    if (!canDeleteLogComment({ userId: actor.userId }, project, membership, comment)) throw forbidden()
    const [row] = await tx
      .update(logComments)
      .set({ status: 'deleted', body: '', deletedAt: now, hiddenAt: null })
      .where(eq(logComments.id, comment.id))
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'log_comment.delete',
      targetType: 'log_comment',
      targetId: comment.id,
      projectId: project.id,
      metadata: { logId: comment.logEntryId },
    })
    return single(tx, actor, project, membership, row!)
  })
}

/** PUT /log-comments/:id/hidden {hidden} — owner. 지운 댓글은 409 `comment_deleted`. 이미 그 상태면 바꾸지 않습니다. */
export async function setLogCommentHidden(
  db: DbExecutor,
  actor: Actor,
  commentId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<LogCommentDto> {
  return db.transaction(async (tx) => {
    const { comment, project, membership } = await loadComment(tx, actor, commentId)
    if (membership.role !== 'owner') throw forbidden()
    const { hidden } = parseInput(hiddenInputSchema, rawInput)
    if (comment.status === 'deleted') throw conflict('comment_deleted')
    if (!canHideLogComment({ userId: actor.userId }, project, membership, comment)) throw forbidden()
    if ((comment.status === 'hidden') === hidden) return single(tx, actor, project, membership, comment)
    const [row] = await tx
      .update(logComments)
      .set(hidden ? { status: 'hidden', hiddenAt: now } : { status: 'published', hiddenAt: null })
      .where(eq(logComments.id, comment.id))
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: hidden ? 'log_comment.hide' : 'log_comment.unhide',
      targetType: 'log_comment',
      targetId: comment.id,
      projectId: project.id,
      metadata: { logId: comment.logEntryId },
    })
    return single(tx, actor, project, membership, row!)
  })
}
