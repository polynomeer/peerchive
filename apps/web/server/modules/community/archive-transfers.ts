/**
 * 아카이브로 옮기기 (C-09, PROOFU_EVOLUTION_PLAN §8.3·§8.5·§8.9.8, SYSTEM_DESIGN §6.7 ArchiveTransfer·§8.2·§8.3·§9, DELIVERY_PLAN §4.1 C-09, ADR 0025).
 *
 * - **방향**: 커뮤니티 → 아카이브만. 이 파일(커뮤니티 모듈)이 커뮤니티 행을 읽어 아카이브 쪽 서비스(course-hub/course-qa·senior-notes, logs)에 **복사한 글**만
 *   넘깁니다. 아카이브 테이블은 커뮤니티 테이블을 가리키지 않고, 공개 읽기 경로는 커뮤니티 모듈·테이블을 import하지 않습니다(C-05 경계 검사).
 * - **동의 전 복사 없음**: 요청 때 복사할 글을 스냅샷으로 얼리고(`archive_transfers.snapshot`) 해시(content_hash)를 만듭니다. 필요한 사람 모두가 그 해시로
 *   동의한 트랜잭션에서만 복사본을 만들고, 끝나거나 취소되면 스냅샷 글을 지웁니다. 원 글을 나중에 고쳐도 스냅샷은 바뀌지 않습니다(동의한 화면 = 복사본).
 *   원 글·답변이 지워지거나 가려지면(운영 조치·신고 누적 임시 숨김·방 운영진) 진행 중 요청은 취소됩니다.
 * - **답한 사람 익명 유지**: 동의 요청은 답한 사람에게 커뮤니티 알림으로만 갑니다. 요청한 사람의 응답에는 답한 사람의 id·이름·고른 표시가 없고
 *   상태(대기·동의·거절)만 있습니다. 게시된 뒤에는 답한 사람이 고른 이름(익명이면 "답한 학생")만 공개됩니다.
 * - **이름 다시 고르기**: 막힘 Q&A는 각자 익명/표시명/실명(실명을 넣은 사람만) 중에서, 선배 노트는 기존 선배 노트 방식(이름/표시명/익명)에서 고릅니다.
 * - **원 글 열람 범위 유지**: 원 글은 그대로이고, 읽을 수 있는 사람에게 "아카이브로 옮겨짐" 표시만(링크·동의한 사람 없음, 공개 복사본이 지금 있을 때).
 * - 감사 기록을 남기지 않습니다(글쓴이 id와 글 id를 한 행에 남기지 않는다는 C-04 원칙). 분석은 옮길 곳 종류만, 사용자 키 없이.
 * 이 파일은 서버 로그를 남기지 않습니다(C-05).
 */
import { z } from 'zod'
import {
  ARCHIVE_CANCEL_REASON_LABELS,
  ARCHIVE_DISPLAY_MODES,
  ARCHIVE_TRANSFER_RATE_LIMIT,
  ARCHIVE_TRANSFER_TARGETS,
  ARCHIVE_TRANSFER_TTL_MS,
  COUNTERPART_STATUS_LABELS,
  COURSE_QA_ANONYMOUS_LABELS,
  SENIOR_NOTE_ANSWER_MAX,
  SENIOR_NOTE_DISPLAY_MODES,
  SENIOR_NOTE_DISPLAY_NAME_MAX,
  SENIOR_NOTE_QUESTIONS,
  type ArchiveCancelReason,
  type ArchiveConsentStatus,
  type ArchiveDisplayMode,
  type ArchiveNoticeKind,
  type ArchiveSnapshot,
  type ArchiveTransferTarget,
  archiveDisplayLabel,
  archiveHashInput,
  canStartTransfer,
  canWriteLog,
  courseQaCheckItems,
  evaluateConsents,
  isOpenItem,
  isTransferExpired,
  normalizeLabel,
  requiredConsents,
  runPublicationChecks,
} from '@peerchive/domain'
import {
  and,
  archiveTransferConsents,
  archiveTransfers,
  boards,
  communityComments,
  communityPosts,
  communitySpaces,
  courseQaItems,
  courses,
  desc,
  eq,
  inArray,
  or,
  projectMembers,
  projects,
  schools,
  seniorNotes,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { loadCanonicalCourse } from '../catalog/catalog'
import { courseQaForParty, createCourseQaItemInTx } from '../course-hub/course-qa'
import { assertCanWrite, createSeniorNoteDraftFromTransfer } from '../course-hub/senior-notes'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, rateLimited } from '../errors'
import { insertLog, parseLogInput } from '../logs/logs'
import { BODY_MAX as LOG_BODY_MAX, TIME_BUCKETS } from '../logs/payloads'
import { isUuid, loadReadableProject } from '../projects/access'
import { canonicalHash } from '../publication/manifest'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { type SpaceContext, loadReadableSpace, writeRestricted } from './access'
import type {
  ArchiveOptionsDto,
  ArchiveTransferDto,
  ArchiveTransferSummaryDto,
  PostArchiveDto,
  PublicationCheckDto,
} from '../../../shared/types/api'

type TransferRow = typeof archiveTransfers.$inferSelect
type ConsentRow = typeof archiveTransferConsents.$inferSelect
type PostRow = typeof communityPosts.$inferSelect
type CommentRow = typeof communityComments.$inferSelect

/** 막힘 로그 symptom 최대(로그 payload), 해결 방법 최대. */
const STUCK_SYMPTOM_MAX = 200
const SOLUTION_METHOD_MAX = 2000

const len = (s: string) => [...s].length

// ── 불러오기 ─────────────────────────────────────────────────────────────

async function findPost(db: DbExecutor, postId: unknown, lock = false): Promise<PostRow> {
  if (!isUuid(postId)) throw notFound()
  const query = db.select().from(communityPosts).where(eq(communityPosts.id, postId.toLowerCase())).limit(1)
  const [post] = lock ? await query.for('update') : await query
  if (!post) throw notFound()
  return post
}

async function findComment(db: DbExecutor, id: string | null): Promise<CommentRow | null> {
  if (!id) return null
  const [row] = await db.select().from(communityComments).where(eq(communityComments.id, id)).limit(1)
  return row ?? null
}

async function loadTransfer(db: DbExecutor, id: unknown, lock = false): Promise<TransferRow> {
  if (!isUuid(id)) throw notFound()
  const query = db.select().from(archiveTransfers).where(eq(archiveTransfers.id, id.toLowerCase())).limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

async function consentsOf(db: DbExecutor, transferId: string): Promise<ConsentRow[]> {
  return db.select().from(archiveTransferConsents).where(eq(archiveTransferConsents.transferId, transferId)).orderBy(archiveTransferConsents.createdAt)
}

async function names(db: DbExecutor, userId: string): Promise<{ displayName: string | null; realName: string | null }> {
  const [u] = await db.select({ displayName: users.displayName, realName: users.realName }).from(users).where(eq(users.id, userId)).limit(1)
  return { displayName: u?.displayName ?? null, realName: u?.realName ?? null }
}

/** 원 글 공간 행을 FOR SHARE로 잠급니다(글 쓰기와 같은 첫 잠금, ADR 0020). */
async function shareLockSpace(tx: DbExecutor, spaceId: string): Promise<void> {
  await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.id, spaceId)).limit(1).for('share')
}

// ── 알림 ─────────────────────────────────────────────────────────────────

/** 옮기기 알림 한 줄(요청·사람·종류마다 하나). payload는 옮길 곳 종류만(누가·무슨 글인지 없음). active 계정에만. */
async function notify(tx: DbExecutor, transfer: Pick<TransferRow, 'id' | 'spaceId' | 'target'>, userIds: readonly string[], kind: ArchiveNoticeKind, now: Date) {
  for (const userId of new Set(userIds)) {
    await tx.execute(sql`
      insert into community_notices (user_id, space_id, kind, archive_transfer_id, payload, created_at)
      select u.id, ${transfer.spaceId}, ${kind}, ${transfer.id}, ${JSON.stringify({ target: transfer.target })}::jsonb, ${now.toISOString()}::timestamptz
      from users u where u.id = ${userId} and u.status = 'active'
      on conflict (archive_transfer_id, kind, user_id) where archive_transfer_id is not null do nothing`)
  }
}

// ── 취소·만료 ────────────────────────────────────────────────────────────

/** 진행 중 요청을 닫습니다(스냅샷 글을 지움). 기다리던 사람·요청한 사람에게 취소 알림(행위자 본인 제외). 닫았으면 true. */
async function cancelInTx(tx: DbExecutor, transfer: TransferRow, reason: ArchiveCancelReason, now: Date, actorId: string | null): Promise<boolean> {
  const closed = await tx
    .update(archiveTransfers)
    .set({ status: 'cancelled', cancelReason: reason, cancelledAt: now, snapshot: null, updatedAt: now })
    .where(and(eq(archiveTransfers.id, transfer.id), eq(archiveTransfers.status, 'awaiting_consent')))
    .returning({ id: archiveTransfers.id })
  if (closed.length === 0) return false
  const parties = (await consentsOf(tx, transfer.id)).map((c) => c.userId).filter((id) => id !== actorId)
  await notify(tx, transfer, parties, 'archive_transfer_cancelled', now)
  return true
}

/**
 * 원 글·답변이 더는 옮길 수 없게 되면(작성자 삭제·운영 조치·신고 누적 임시 숨김·방 운영진 가리기) 그것을 쓰는 진행 중 요청을 모두 취소합니다.
 * 글·댓글 상태를 바꾸는 트랜잭션 안에서 부릅니다(posts.ts·moderation.ts). 취소한 수.
 */
export async function cancelTransfersForSourceInTx(
  tx: DbExecutor,
  source: { postId?: string | null; commentId?: string | null },
  reason: ArchiveCancelReason,
  now: Date,
  actorId: string | null = null,
): Promise<number> {
  const conds = []
  if (source.postId) conds.push(eq(archiveTransfers.sourcePostId, source.postId))
  if (source.commentId) conds.push(eq(archiveTransfers.sourceCommentId, source.commentId))
  if (conds.length === 0) return 0
  const open = await tx
    .select()
    .from(archiveTransfers)
    .where(and(eq(archiveTransfers.status, 'awaiting_consent'), or(...conds)))
    .for('update')
  let n = 0
  for (const t of open) if (await cancelInTx(tx, t, reason, now, actorId)) n++
  return n
}

/** 채택된 답변이 바뀌거나 풀리면: 그 글에서 이전 답변을 옮기던 진행 중 요청을 취소합니다(answer_changed). */
export async function cancelTransfersForAnswerChangeInTx(tx: DbExecutor, postId: string, newCommentId: string | null, now: Date, actorId: string): Promise<number> {
  const open = await tx
    .select()
    .from(archiveTransfers)
    .where(and(eq(archiveTransfers.sourcePostId, postId), eq(archiveTransfers.status, 'awaiting_consent')))
    .for('update')
  let n = 0
  for (const t of open) {
    if (t.sourceCommentId && t.sourceCommentId !== newCommentId && (await cancelInTx(tx, t, 'answer_changed', now, actorId))) n++
  }
  return n
}

async function expireIfDue(tx: DbExecutor, transfer: TransferRow, now: Date): Promise<TransferRow> {
  if (!isTransferExpired(transfer, now)) return transfer
  await cancelInTx(tx, transfer, 'expired', now, null)
  return loadTransfer(tx, transfer.id)
}

// ── 원 글의 옮기기 표시(posts.ts가 씀) ───────────────────────────────────

/**
 * 원 글 화면용: "아카이브로 옮겨짐" 표시(지금 공개된 복사본이 있을 때: 게시 중인 막힘 Q&A 또는 게시된 선배 노트)와
 * 보는 사람이 관련된 요청 요약(요청했거나 동의를 요청받은 것만). 다른 사람의 요청·동의한 사람은 싣지 않습니다.
 */
export async function postArchiveInfo(db: DbExecutor, ctx: SpaceContext, post: PostRow, boardKind: string, now: Date): Promise<PostArchiveDto> {
  const rows = await db.select().from(archiveTransfers).where(eq(archiveTransfers.sourcePostId, post.id)).orderBy(desc(archiveTransfers.createdAt)).limit(50)
  const done = rows.filter((r) => r.status === 'done')
  let archived = false
  const qaIds = done.map((r) => r.courseQaItemId).filter((id): id is string => !!id)
  const noteIds = done.map((r) => r.seniorNoteId).filter((id): id is string => !!id)
  if (qaIds.length) {
    const [live] = await db.select({ id: courseQaItems.id }).from(courseQaItems).where(and(inArray(courseQaItems.id, qaIds), eq(courseQaItems.status, 'published'))).limit(1)
    archived ||= !!live
  }
  if (!archived && noteIds.length) {
    const [live] = await db.select({ id: seniorNotes.id }).from(seniorNotes).where(and(inArray(seniorNotes.id, noteIds), eq(seniorNotes.status, 'published'))).limit(1)
    archived ||= !!live
  }
  const viewerId = ctx.viewer.userId
  const ids = rows.map((r) => r.id)
  const mine = ids.length
    ? await db
        .select({ transferId: archiveTransferConsents.transferId, status: archiveTransferConsents.status })
        .from(archiveTransferConsents)
        .where(and(inArray(archiveTransferConsents.transferId, ids), eq(archiveTransferConsents.userId, viewerId)))
    : []
  const myConsent = new Map(mine.map((m) => [m.transferId, m.status as ArchiveConsentStatus]))
  const transfers: ArchiveTransferSummaryDto[] = rows
    .filter((r) => r.initiatorId === viewerId || myConsent.has(r.id))
    .slice(0, 10)
    .map((r) => {
      const expired = isTransferExpired(r, now)
      return {
        id: r.id,
        target: r.target,
        status: expired ? 'cancelled' : r.status,
        cancelReason: expired ? 'expired' : ((r.cancelReason as ArchiveCancelReason | null) ?? null),
        myRole: r.initiatorId === viewerId ? 'initiator' : 'party',
        myConsent: r.initiatorId === viewerId ? null : (myConsent.get(r.id) ?? null),
        createdAt: r.createdAt.toISOString(),
      }
    })
  const open = isOpenItem(post.status)
  return {
    archived,
    canStart: open && post.authorId === viewerId && ctx.space.row.status === 'active' && !ctx.viewer.writeRestriction,
    questionBoard: boardKind === 'question',
    transfers,
  }
}

// ── 옮기기 시작 ──────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const createTransferSchema = z.object({
  target: z.enum(ARCHIVE_TRANSFER_TARGETS, { error: requiredOr('invalid') }),
  courseId: z.uuid({ error: 'invalid' }).optional(),
  projectId: z.uuid({ error: 'invalid' }).optional(),
  includeAnswer: z.boolean({ error: 'invalid' }).default(false),
  /** 막힘 Q&A의 내 이름(anonymous/display/real) 또는 선배 노트의 표시 방식(name/display/anonymous). */
  displayMode: z.string({ error: 'invalid' }).optional(),
  displayName: z
    .string({ error: 'invalid' })
    .transform(normalizeLabel)
    .pipe(z.string().max(SENIOR_NOTE_DISPLAY_NAME_MAX, { error: 'too_long' }))
    .nullish()
    .transform((v) => (v ? v : null)),
  timeBucket: z.enum(TIME_BUCKETS, { error: 'invalid' }).optional(),
  notAnswerConfirmed: z.boolean({ error: 'invalid' }).optional(),
  answerKey: z.enum(SENIOR_NOTE_QUESTIONS, { error: 'invalid' }).optional(),
  noAnswersConfirmed: z.boolean({ error: 'invalid' }).optional(),
  confirmWarnings: z.boolean({ error: 'invalid' }).default(false),
})

function startError(reason: 'source_not_open' | 'not_author' | 'not_question_board' | 'no_accepted_answer'): ServiceError {
  return reason === 'not_author' ? forbidden('not_author') : conflict(reason)
}

/** 원 글 공간의 정본 학교와 과목 학교(정본)가 같아야 합니다(학교 없는 방은 검사하지 않음). 정본 과목 행. */
async function courseFor(tx: DbExecutor, ctx: SpaceContext, courseId: string | undefined) {
  if (!courseId) throw invalid({ courseId: 'required' })
  const course = await loadCanonicalCourse(tx, courseId).catch(() => {
    throw invalid({ courseId: 'not_found' })
  })
  if (ctx.space.schoolId) {
    const [school] = await tx.select({ id: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` }).from(schools).where(eq(schools.id, course.schoolId)).limit(1)
    if (school?.id !== ctx.space.schoolId) throw invalid({ courseId: 'other_school' })
  }
  return course
}

function warningsOf(snapshot: ArchiveSnapshot): PublicationCheckDto[] {
  return runPublicationChecks(courseQaCheckItems(snapshot)).map((w) => ({ rule: w.rule, location: w.location, sample: w.sample, fixUrl: null }))
}

function labelOrThrow(role: 'asker' | 'answerer', mode: ArchiveDisplayMode, n: { displayName: string | null; realName: string | null }) {
  const r = archiveDisplayLabel(role, mode, n)
  if (!r.ok) throw invalid({ displayMode: r.reason })
  return r
}

function parseArchiveMode(raw: string | undefined): ArchiveDisplayMode {
  if (raw === undefined) throw invalid({ displayMode: 'required' })
  if (!(ARCHIVE_DISPLAY_MODES as readonly string[]).includes(raw)) throw invalid({ displayMode: 'invalid' })
  return raw as ArchiveDisplayMode
}

/**
 * POST /community/posts/:id/archive-transfers — 201 + 요청(요청한 사람 보기).
 * 401, 403 `not_author`·`hub_write_not_allowed`(막힘 Q&A·선배 노트: 과목 학교 인증)·`write_restricted`, 404(읽을 수 없음),
 * 409 `source_not_open`·`not_question_board`·`no_accepted_answer`·`transfer_pending`·`already_transferred`·`space_not_active`·
 * `checks_unconfirmed`(+warnings)·`limit_reached`(선배 노트), 422, 429.
 */
export async function createArchiveTransfer(db: DbExecutor, actor: Actor, postId: unknown, rawInput: unknown, now = new Date()): Promise<ArchiveTransferDto> {
  const input = parseInput(createTransferSchema, rawInput)
  const id = await db.transaction(async (tx) => {
    const peek = await findPost(tx, postId)
    await shareLockSpace(tx, peek.spaceId)
    const ctx = await loadReadableSpace(tx, actor, peek.spaceId, false, now)
    const post = await findPost(tx, peek.id, true)
    if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
    if (ctx.viewer.writeRestriction) throw writeRestricted(ctx.viewer.writeRestriction)
    const [board] = await tx.select({ kind: boards.kind }).from(boards).where(eq(boards.id, post.boardId)).limit(1)
    const accepted = post.acceptedCommentId ? await findComment(tx, post.acceptedCommentId) : null
    const includeAnswer = input.target === 'course_qa' ? true : input.target === 'stuck_log' ? input.includeAnswer : false
    const check = canStartTransfer({
      target: input.target,
      actorId: actor.userId,
      boardKind: board?.kind ?? '',
      post: { authorId: post.authorId, open: isOpenItem(post.status) },
      accepted: accepted ? { authorId: accepted.authorId, open: isOpenItem(accepted.status) && accepted.postId === post.id } : null,
      includeAnswer,
    })
    if (!check.ok) throw startError(check.reason)
    const [pending] = await tx
      .select({ id: archiveTransfers.id, expiresAt: archiveTransfers.expiresAt, status: archiveTransfers.status })
      .from(archiveTransfers)
      .where(and(eq(archiveTransfers.sourcePostId, post.id), eq(archiveTransfers.target, input.target), eq(archiveTransfers.status, 'awaiting_consent')))
      .limit(1)
      .for('update')
    if (pending) {
      const row = await loadTransfer(tx, pending.id, true)
      if (!isTransferExpired(row, now)) throw conflict('transfer_pending', { transferId: row.id })
      await cancelInTx(tx, row, 'expired', now, null)
    }
    if (input.target === 'course_qa') {
      const [live] = await tx
        .select({ id: courseQaItems.id })
        .from(archiveTransfers)
        .innerJoin(courseQaItems, eq(courseQaItems.id, archiveTransfers.courseQaItemId))
        .where(and(eq(archiveTransfers.sourcePostId, post.id), inArray(courseQaItems.status, ['published', 'hidden'])))
        .limit(1)
      if (live) throw conflict('already_transferred')
    }
    if (!(await hitRateLimit(tx, 'archive_transfer_create', actor.userId, ARCHIVE_TRANSFER_RATE_LIMIT, now))) throw rateLimited()

    const answer = includeAnswer ? accepted! : null
    const snapshot: ArchiveSnapshot = { questionTitle: post.title, questionBody: post.body, answerBody: answer?.body ?? null }
    const consentsNeeded = requiredConsents({ target: input.target, askerId: post.authorId, answererId: answer?.authorId ?? null, includeAnswer })
    const base = { target: input.target, spaceId: post.spaceId, sourcePostId: post.id, initiatorId: actor.userId, expiresAt: new Date(now.getTime() + ARCHIVE_TRANSFER_TTL_MS), createdAt: now, updatedAt: now }

    if (input.target === 'senior_note') {
      // 작성자 한 사람의 글 → 선배 노트 초안. 요청이 곧 동의이므로 바로 끝납니다(스냅샷을 남기지 않음).
      const course = await courseFor(tx, ctx, input.courseId)
      if (!input.answerKey) throw invalid({ answerKey: 'required' })
      if (input.noAnswersConfirmed !== true) throw invalid({ noAnswersConfirmed: 'confirm_required' })
      const mode = input.displayMode
      if (!mode) throw invalid({ displayMode: 'required' })
      if (!(SENIOR_NOTE_DISPLAY_MODES as readonly string[]).includes(mode)) throw invalid({ displayMode: 'invalid' })
      const body = post.body.replace(/\r\n?/g, '\n').trim()
      if (len(body) > SENIOR_NOTE_ANSWER_MAX) throw invalid({ source: 'too_long' })
      const note = await createSeniorNoteDraftFromTransfer(
        tx,
        actor,
        course,
        { answerKey: input.answerKey, body, displayMode: mode as (typeof SENIOR_NOTE_DISPLAY_MODES)[number], displayName: input.displayName ?? null },
        now,
      )
      const hash = canonicalHash(archiveHashInput({ target: 'senior_note', courseId: course.id, snapshot: { ...snapshot, answerBody: null }, askerLabel: null }))
      const [row] = await tx
        .insert(archiveTransfers)
        .values({ ...base, status: 'done', courseId: course.id, contentHash: hash, snapshot: null, completedAt: now, seniorNoteId: note.id })
        .returning()
      await tx.insert(archiveTransferConsents).values({ transferId: row!.id, userId: actor.userId, role: 'author', status: 'granted', contentHash: hash, createdAt: now, decidedAt: now })
      await emitAnalytics(tx, { name: 'archive_transfer_requested', actorId: actor.userId, unlinked: true, props: { target: 'senior_note' }, now })
      await emitAnalytics(tx, { name: 'archive_transfer_completed', actorId: actor.userId, unlinked: true, props: { target: 'senior_note' }, now })
      return row!.id
    }

    let courseId: string | null = null
    let projectId: string | null = null
    let timeBucket: string | null = null
    let askerLabel: string | null = null
    let askerMode: ArchiveDisplayMode | null = null
    if (input.target === 'course_qa') {
      const course = await courseFor(tx, ctx, input.courseId)
      // 과목 허브 작성 자격은 요청한 사람에게 적용합니다(그 과목 학교의 active 인증, ADR 0018).
      await assertCanWrite(tx, actor, course)
      courseId = course.id
      askerMode = parseArchiveMode(input.displayMode)
      askerLabel = labelOrThrow('asker', askerMode, await names(tx, actor.userId)).label
      const warnings = warningsOf(snapshot)
      if (warnings.length > 0 && !input.confirmWarnings) {
        throw new ServiceError('CONFLICT', 'checks_unconfirmed', undefined, {
          warnings: warnings.map((w) => ({ rule: w.rule, field: w.location.field, sample: w.sample })),
        })
      }
    } else {
      // stuck_log: 질문한 사람(=요청한 사람)이 owner/editor인 과제만.
      if (!input.projectId) throw invalid({ projectId: 'required' })
      const project = await loadReadableProject(tx, actor, input.projectId).catch(() => {
        throw invalid({ projectId: 'not_found' })
      })
      if (!canWriteLog({ userId: actor.userId }, project.project, project.membership)) throw invalid({ projectId: 'not_writable' })
      projectId = project.project.id
      if (!input.timeBucket) throw invalid({ timeBucket: 'required' })
      timeBucket = input.timeBucket
      if (len(snapshot.questionTitle) > STUCK_SYMPTOM_MAX || len(snapshot.questionBody) > LOG_BODY_MAX) throw invalid({ source: 'too_long' })
      if (snapshot.answerBody !== null) {
        if (len(snapshot.answerBody) > SOLUTION_METHOD_MAX) throw invalid({ source: 'too_long' })
        if (input.notAnswerConfirmed !== true) throw invalid({ notAnswerConfirmed: 'confirm_required' })
      }
    }
    const hash = canonicalHash(archiveHashInput({ target: input.target, courseId, snapshot, askerLabel }))
    const [row] = await tx
      .insert(archiveTransfers)
      .values({ ...base, sourceCommentId: answer?.id ?? null, courseId, projectId, timeBucket, snapshot, contentHash: hash })
      .returning()
    for (const c of consentsNeeded) {
      const own = c.userId === actor.userId
      await tx.insert(archiveTransferConsents).values({
        transferId: row!.id,
        userId: c.userId,
        role: c.role,
        status: own ? 'granted' : 'pending',
        displayMode: own ? askerMode : null,
        displayLabel: own ? askerLabel : null,
        contentHash: own ? hash : null,
        createdAt: now,
        decidedAt: own ? now : null,
      })
    }
    await emitAnalytics(tx, { name: 'archive_transfer_requested', actorId: actor.userId, unlinked: true, props: { target: input.target }, now })
    const others = consentsNeeded.filter((c) => c.userId !== actor.userId).map((c) => c.userId)
    if (others.length === 0) await completeInTx(tx, row!, now, actor.userId)
    else await notify(tx, row!, others, 'archive_consent_requested', now)
    return row!.id
  })
  return getArchiveTransfer(db, actor, id, now)
}

// ── 복사(모든 동의가 모였을 때) ───────────────────────────────────────────

/**
 * 모든 동의가 같은 해시로 모였는지 다시 확인하고 복사본을 만듭니다. 원 글·답변이 지금도 게시 중이고 채택된 답변이 그대로여야 합니다
 * (아니면 취소). 막힘 Q&A는 요청한 사람의 과목 허브 작성 자격도 다시 봅니다. 같은 트랜잭션에서 스냅샷을 지우고 done.
 */
async function completeInTx(tx: DbExecutor, transfer: TransferRow, now: Date, actorId: string): Promise<void> {
  const consents = await consentsOf(tx, transfer.id)
  if (evaluateConsents(consents.map((c) => ({ status: c.status as ArchiveConsentStatus, contentHash: c.contentHash })), transfer.contentHash) !== 'complete') return
  const snapshot = transfer.snapshot!
  const post = await findPost(tx, transfer.sourcePostId, true)
  const comment = transfer.sourceCommentId ? await findComment(tx, transfer.sourceCommentId) : null
  if (!isOpenItem(post.status) || (transfer.sourceCommentId && (!comment || !isOpenItem(comment.status)))) {
    await cancelInTx(tx, transfer, 'source_unavailable', now, null)
    return
  }
  if (transfer.sourceCommentId && post.acceptedCommentId !== transfer.sourceCommentId) {
    await cancelInTx(tx, transfer, 'answer_changed', now, null)
    return
  }
  const asker = consents.find((c) => c.role === 'asker')!
  const answerer = consents.find((c) => c.role === 'answerer') ?? null
  const result: Partial<Pick<TransferRow, 'courseQaItemId' | 'stuckLogId' | 'solutionLogId'>> = {}
  if (transfer.target === 'course_qa') {
    const course = await loadCanonicalCourse(tx, transfer.courseId).catch(() => null)
    const writable = course
      ? await assertCanWrite(tx, { userId: transfer.initiatorId }, course).then(
          () => true,
          () => false,
        )
      : false
    if (!course || !writable) {
      await cancelInTx(tx, transfer, 'target_unavailable', now, null)
      return
    }
    const askerAnon = asker.displayMode === 'anonymous'
    // 같은 사람이 질문하고 답했으면 답변 이름도 그 사람이 고른 이름입니다.
    const answererLabel = answerer?.displayLabel ?? asker.displayLabel!
    const answererAnon = answerer ? answerer.displayMode === 'anonymous' : askerAnon
    result.courseQaItemId = await createCourseQaItemInTx(
      tx,
      {
        transferId: transfer.id,
        courseId: course.id,
        questionTitle: snapshot.questionTitle,
        questionBody: snapshot.questionBody,
        answerBody: snapshot.answerBody ?? '',
        asker: { userId: asker.userId, label: asker.displayLabel!, anonymous: askerAnon },
        answerer: { userId: comment!.authorId, label: answererLabel, anonymous: answererAnon },
      },
      now,
    )
  } else if (transfer.target === 'stuck_log') {
    const askerActor = { userId: transfer.initiatorId }
    const project = await loadReadableProject(tx, askerActor, transfer.projectId).catch(() => null)
    if (!project || !canWriteLog(askerActor, project.project, project.membership)) {
      await cancelInTx(tx, transfer, 'target_unavailable', now, null)
      return
    }
    const stuck = await insertLog(
      tx,
      askerActor,
      project.project,
      project.membership,
      parseLogInput({ tag: 'stuck', body: snapshot.questionBody, payload: { symptom: snapshot.questionTitle, timeBucket: transfer.timeBucket } }, now),
      'web',
      now,
    )
    result.stuckLogId = stuck.log.id
    if (snapshot.answerBody) {
      const solution = await insertLog(
        tx,
        askerActor,
        project.project,
        project.membership,
        parseLogInput({ tag: 'solution', payload: { method: snapshot.answerBody, notAnswerConfirmed: true }, resolvesEntryId: stuck.log.id }, now),
        'web',
        now,
      )
      result.solutionLogId = solution.log.id
    }
  }
  await tx
    .update(archiveTransfers)
    .set({ status: 'done', completedAt: now, snapshot: null, updatedAt: now, ...result })
    .where(eq(archiveTransfers.id, transfer.id))
  await notify(
    tx,
    transfer,
    consents.map((c) => c.userId).filter((id) => id !== actorId),
    'archive_transfer_done',
    now,
  )
  await emitAnalytics(tx, { name: 'archive_transfer_completed', actorId, unlinked: true, props: { target: transfer.target }, now })
}

// ── 동의·거절·취소 ───────────────────────────────────────────────────────

export const consentSchema = z.object({
  decision: z.enum(['grant', 'decline'], { error: requiredOr('invalid') }),
  /** 동의 화면에 보인 내용의 해시(그대로 돌려보냄). 다르면 409 stale_content. */
  contentHash: z.string({ error: 'invalid' }).regex(/^[0-9a-f]{64}$/, { error: 'invalid' }).optional(),
  displayMode: z.enum(ARCHIVE_DISPLAY_MODES, { error: 'invalid' }).optional(),
})

/** 요청을 볼 수 있는 사람: 요청한 사람 또는 동의 행이 있는 사람이면서 지금 원 글 공간을 읽을 수 있는 사람(아니면 404). */
async function partyContext(tx: DbExecutor, actor: Actor, transfer: TransferRow, now: Date) {
  const consents = await consentsOf(tx, transfer.id)
  const mine = consents.find((c) => c.userId === actor.userId) ?? null
  if (transfer.initiatorId !== actor.userId && !mine) throw notFound()
  const ctx = await loadReadableSpace(tx, actor, transfer.spaceId, false, now)
  return { consents, mine, ctx }
}

/**
 * POST /community/archive-transfers/:id/consents {decision, contentHash?, displayMode?} — 동의를 요청받은 사람만. 200 + 요청.
 * 동의는 화면에 보인 해시(contentHash)와 내 이름(막힘 Q&A: displayMode)이 필요합니다. 거절하면 요청이 취소됩니다(사유 없음).
 * 404(당사자 아님·읽을 수 없음), 409 `not_pending`(끝났거나 취소·만료)·`already_decided`·`stale_content`, 422.
 */
export async function decideArchiveConsent(db: DbExecutor, actor: Actor, transferId: unknown, rawInput: unknown, now = new Date()): Promise<ArchiveTransferDto> {
  const input = parseInput(consentSchema, rawInput)
  const id = await db.transaction(async (tx) => {
    const peek = await loadTransfer(tx, transferId)
    await shareLockSpace(tx, peek.spaceId)
    let transfer = await loadTransfer(tx, peek.id, true)
    const { mine } = await partyContext(tx, actor, transfer, now)
    if (!mine) throw notFound()
    transfer = await expireIfDue(tx, transfer, now)
    if (transfer.status !== 'awaiting_consent') throw conflict('not_pending', { status: transfer.status })
    if (mine.status !== 'pending') throw conflict('already_decided')
    if (input.decision === 'decline') {
      await tx.update(archiveTransferConsents).set({ status: 'declined', decidedAt: now }).where(eq(archiveTransferConsents.id, mine.id))
      await cancelInTx(tx, transfer, 'declined', now, actor.userId)
      return transfer.id
    }
    if (!input.contentHash) throw invalid({ contentHash: 'required' })
    if (input.contentHash !== transfer.contentHash) throw conflict('stale_content')
    let displayMode: ArchiveDisplayMode | null = null
    let displayLabel: string | null = null
    if (transfer.target === 'course_qa') {
      displayMode = parseArchiveMode(input.displayMode)
      displayLabel = labelOrThrow(mine.role === 'asker' ? 'asker' : 'answerer', displayMode, await names(tx, actor.userId)).label
    }
    await tx
      .update(archiveTransferConsents)
      .set({ status: 'granted', contentHash: transfer.contentHash, displayMode, displayLabel, decidedAt: now })
      .where(eq(archiveTransferConsents.id, mine.id))
    await completeInTx(tx, transfer, now, actor.userId)
    return transfer.id
  })
  return getArchiveTransfer(db, actor, id, now)
}

/** POST /community/archive-transfers/:id/cancel — 요청한 사람만(아니면 404). 200 + 요청. 끝났거나 이미 닫혔으면 409 `not_pending`. */
export async function cancelArchiveTransfer(db: DbExecutor, actor: Actor, transferId: unknown, now = new Date()): Promise<ArchiveTransferDto> {
  const id = await db.transaction(async (tx) => {
    let transfer = await loadTransfer(tx, transferId, true)
    if (transfer.initiatorId !== actor.userId) throw notFound()
    await partyContext(tx, actor, transfer, now)
    transfer = await expireIfDue(tx, transfer, now)
    if (transfer.status !== 'awaiting_consent') throw conflict('not_pending', { status: transfer.status })
    await cancelInTx(tx, transfer, 'cancelled_by_initiator', now, actor.userId)
    return transfer.id
  })
  return getArchiveTransfer(db, actor, id, now)
}

// ── 읽기 ─────────────────────────────────────────────────────────────────

/**
 * GET /community/archive-transfers/:id — 요청한 사람 또는 동의를 요청받은 사람(지금 원 글 공간을 읽을 수 있어야 함, 아니면 404).
 * 요청한 사람 보기: 상대의 동의 상태만(답한 사람의 id·이름·고른 이름 없음). 동의할 사람 보기: 옮겨질 글 그대로(스냅샷)·요청한 사람이 고른 이름·경고·해시.
 * 만료된 요청은 이때 닫습니다.
 */
export async function getArchiveTransfer(db: DbExecutor, actor: Actor, transferId: unknown, now = new Date()): Promise<ArchiveTransferDto> {
  return db.transaction(async (tx) => {
    let transfer = await loadTransfer(tx, transferId)
    const { mine } = await partyContext(tx, actor, transfer, now)
    if (isTransferExpired(transfer, now)) {
      transfer = await expireIfDue(tx, await loadTransfer(tx, transfer.id, true), now)
    }
    const consents = await consentsOf(tx, transfer.id)
    return toDto(tx, actor, transfer, consents, mine)
  })
}

async function toDto(db: DbExecutor, actor: Actor, t: TransferRow, consents: ConsentRow[], mine: ConsentRow | null): Promise<ArchiveTransferDto> {
  const initiator = t.initiatorId === actor.userId
  const [course] = t.courseId
    ? await db
        .select({ id: courses.id, title: courses.title, schoolName: schools.name })
        .from(courses)
        .innerJoin(schools, eq(schools.id, courses.schoolId))
        .where(eq(courses.id, t.courseId))
        .limit(1)
    : []
  // 과제 이름은 요청한 사람(질문한 사람)에게만. 답한 사람에게는 "질문한 사람의 비공개 과제"로만 보입니다.
  const [project] = initiator && t.projectId ? await db.select({ id: projects.id, title: projects.title }).from(projects).where(eq(projects.id, t.projectId)).limit(1) : []
  const asker = consents.find((c) => c.role === 'asker' || c.role === 'author') ?? null
  const counterpart = initiator ? (consents.find((c) => c.userId !== actor.userId) ?? null) : null
  const awaiting = t.status === 'awaiting_consent'
  const snapshot = awaiting ? t.snapshot : null
  const viewerNames = await names(db, actor.userId)
  const myRole: 'asker' | 'answerer' = mine?.role === 'answerer' ? 'answerer' : 'asker'
  return {
    id: t.id,
    target: t.target,
    status: t.status,
    cancelReason: (t.cancelReason as ArchiveCancelReason | null) ?? null,
    cancelText: t.cancelReason ? ARCHIVE_CANCEL_REASON_LABELS[t.cancelReason as ArchiveCancelReason] : null,
    myRole: initiator ? 'initiator' : 'party',
    postId: t.sourcePostId,
    course: course ?? null,
    project: project ?? null,
    includesAnswer: t.sourceCommentId !== null,
    expiresAt: t.expiresAt.toISOString(),
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    preview: snapshot
      ? {
          questionTitle: snapshot.questionTitle,
          questionBody: snapshot.questionBody,
          answerBody: snapshot.answerBody,
          askerLabel: t.target === 'course_qa' ? (asker?.displayLabel ?? null) : null,
        }
      : null,
    warnings: snapshot && t.target === 'course_qa' ? warningsOf(snapshot).map((w) => ({ rule: w.rule, field: w.location.field, sample: w.sample })) : [],
    contentHash: awaiting ? t.contentHash : null,
    myConsent: mine ? { status: mine.status as ArchiveConsentStatus, displayMode: (mine.displayMode as ArchiveDisplayMode | null) ?? null, displayLabel: mine.displayLabel } : null,
    counterpart: counterpart ? { status: counterpart.status as ArchiveConsentStatus, text: COUNTERPART_STATUS_LABELS[counterpart.status as ArchiveConsentStatus] } : null,
    displayOptions:
      t.target === 'course_qa'
        ? { anonymousLabel: COURSE_QA_ANONYMOUS_LABELS[myRole], displayName: viewerNames.displayName, realName: viewerNames.realName }
        : null,
    canDecide: awaiting && !!mine && mine.status === 'pending',
    canCancel: awaiting && initiator,
    result: {
      courseQa: t.courseQaItemId ? await courseQaForParty(db, actor, t.courseQaItemId) : null,
      seniorNoteId: initiator ? t.seniorNoteId : null,
      projectId: initiator && t.status === 'done' ? t.projectId : null,
    },
  }
}

// ── 화면 선택지 ──────────────────────────────────────────────────────────

/**
 * GET /community/posts/:id/archive-options — "아카이브로 옮기기" 대화 상자의 선택지(글쓴이만, 아니면 403 not_author). 읽을 수 없으면 404.
 * 옮길 곳마다 지금 가능한지·이유, 원 글 공간의 학교(과목 고르기용), 내가 owner/editor인 과제, 내 표시명·실명 유무, 글자 수.
 */
export async function getArchiveOptions(db: DbExecutor, actor: Actor, postId: unknown, now = new Date()): Promise<ArchiveOptionsDto> {
  const post = await findPost(db, postId)
  const ctx = await loadReadableSpace(db, actor, post.spaceId, false, now)
  if (post.authorId !== actor.userId) throw forbidden('not_author')
  const [board] = await db.select({ kind: boards.kind }).from(boards).where(eq(boards.id, post.boardId)).limit(1)
  const accepted = post.acceptedCommentId ? await findComment(db, post.acceptedCommentId) : null
  const acceptedOpen = !!accepted && isOpenItem(accepted.status)
  const reasonFor = (target: ArchiveTransferTarget, includeAnswer: boolean) => {
    const r = canStartTransfer({
      target,
      actorId: actor.userId,
      boardKind: board?.kind ?? '',
      post: { authorId: post.authorId, open: isOpenItem(post.status) },
      accepted: accepted ? { authorId: accepted.authorId, open: acceptedOpen } : null,
      includeAnswer,
    })
    return r.ok ? null : r.reason
  }
  const projectRows = await db
    .select({ id: projects.id, title: projects.title })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active'), inArray(projectMembers.role, ['owner', 'editor'])))
    .orderBy(desc(projects.updatedAt))
    .limit(50)
  const me = await names(db, actor.userId)
  const answerIsMine = !!accepted && accepted.authorId === actor.userId
  return {
    postId: post.id,
    questionBoard: board?.kind === 'question',
    hasAcceptedAnswer: acceptedOpen,
    answerIsMine,
    school: ctx.space.schoolId ? { id: ctx.space.schoolId, name: ctx.space.schoolName ?? '' } : null,
    targets: {
      course_qa: reasonFor('course_qa', true),
      stuck_log: reasonFor('stuck_log', false),
      senior_note: reasonFor('senior_note', false),
    },
    projects: projectRows,
    displayName: me.displayName,
    hasRealName: !!me.realName,
    lengths: { title: len(post.title), body: len(post.body), answer: acceptedOpen ? len(accepted!.body) : 0 },
    limits: { stuckSymptom: STUCK_SYMPTOM_MAX, logBody: LOG_BODY_MAX, solution: SOLUTION_METHOD_MAX, noteAnswer: SENIOR_NOTE_ANSWER_MAX },
    timeBuckets: [...TIME_BUCKETS],
  }
}
