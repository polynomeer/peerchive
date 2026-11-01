/**
 * 커뮤니티 신고 누적 임시 숨김·방 운영진 도구·제재 요청·이용 제한(제재)·운영자 작성자 확인 (C-06, PROOFU_EVOLUTION_PLAN §8.9.4·§8.9.6·§15,
 * SYSTEM_DESIGN §6.7 CommunitySanction·"Report 확장"·§8.1, DELIVERY_PLAN §4.1 C-06·§5.1 M, ADR 0023).
 *
 * - **임시 숨김**: 신고가 들어올 때마다(같은 트랜잭션) 그 글·댓글 행을 잠그고, 처리 전 신고의 서로 다른 인증 신고자 수(작성자·인증 해제·다른 학교 제외)가
 *   기준(공식 5·방 3, 환경 변수로 조정)에 이르면 `auto_hidden`으로 바꾸고 작성자에게 알립니다(신고 수·신고자 없음). 운영자 대기열에서 맨 앞에 옵니다.
 *   운영자가 기각하거나 조치 없이 처리하면 다시 보이고(복원), 가리기로 처리하면 `hidden`으로 확정됩니다(moderation/actions.ts가 이 파일의 함수를 부름).
 * - **방 운영진 도구**(canModerate: 사용자 방 owner·admin·moderator, 공식 페이지 모더레이터): 자기 공간의 글·댓글을 가리고(`space_hide`, 작성자에게
 *   공개 사유 안내, 운영 조치 행에 내부 메모) 되돌릴 수 있고, 작성자를 모른 채 **제재 요청**을 남깁니다. 응답에는 작성자 표시가 일반 멤버와 같고
 *   사람 id·핸들이 없습니다. 공간의 "쓰기 제한 n건"만 보이고 누구인지는 보이지 않습니다.
 * - **작성자 확인**(canResolveAuthor, 운영자만): 사유 필수, 확인마다 `community_author_lookups` 한 행(사유는 여기) + 감사 `community.author_lookup`(id만),
 *   시간당 20·하루 60회. 다른 어떤 경로(글 응답·알림·운영자 신고 상세·조회 기록·제재 목록·감사·분석)도 익명 작성자를 드러내지 않습니다.
 * - **제재**: 같은 운영자가 24시간 안에 한 작성자 확인으로만 발급(경고·쓰기 기간 제한·영구, 커뮤니티 전체 또는 그 공간). 짝인 운영 조치 행(kind sanction)이
 *   사유·당사자 안내·이의제기(조치마다 한 번)를 맡습니다. 쓰기 판정은 access.ts loadViewer → canWriteBoard·canReact·createRoom에서만 합니다.
 *
 * 이 파일은 서버 로그를 남기지 않습니다(C-05). 감사·분석은 id·코드만입니다.
 */
import { z } from 'zod'
import {
  AUTHOR_LOOKUP_DAILY_LIMIT,
  AUTHOR_LOOKUP_RATE_LIMIT,
  AUTHOR_LOOKUP_REASON_MAX,
  AUTHOR_LOOKUP_VALID_MS,
  AUTO_HIDE_THRESHOLDS,
  type AutoHideThresholds,
  MODERATION_NOTE_MAX,
  MODERATION_PUBLIC_REASON_MAX,
  REPORT_REASONS,
  SANCTION_LEVELS,
  SANCTION_MAX_DAYS,
  SANCTION_REQUEST_DAILY_LIMIT,
  SANCTION_REQUEST_DETAILS_MAX,
  SANCTION_REQUEST_RATE_LIMIT,
  SANCTION_SCOPES,
  SPACE_HIDE_NOTE_DEFAULT,
  SPACE_HIDE_RATE_LIMIT,
  type ItemReviewNoticeKind,
  autoHideThreshold,
  canModerate,
  canResolveAuthor,
  checkSanctionInput,
  isSanctionActive,
  parseAutoHideThreshold,
  qualifyingReporterCount,
  reportTargetKey,
  resolveAuthorDisplay,
  sanctionBlocksWrite,
  shouldAutoHide,
} from '@peerchive/domain'
import {
  and,
  appeals,
  communityAuthorLookups,
  communityComments,
  communityNotices,
  communityPosts,
  communitySanctionRequests,
  communitySanctions,
  communitySpaces,
  desc,
  eq,
  inArray,
  institutionAffiliations,
  isNull,
  moderationActions,
  ne,
  or,
  profiles,
  reports,
  schools,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, conflict, forbidden, invalid, notFound, rateLimited, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { loadReadableSpace, loadSpace, loadViewer, membershipFacts } from './access'
import { cancelTransfersForSourceInTx } from './archive-transfers'
import { displayPersonaNames } from './name-modes'
import { getPost } from './posts'
import type {
  AuthorLookupResultDto,
  CommunityPostDto,
  OperatorAuthorLookupDto,
  OperatorCommunityItemDto,
  OperatorSanctionDto,
  OperatorSanctionRequestDto,
  OperatorSpaceHideDto,
  SanctionRequestReceiptDto,
  SpaceModerationDto,
} from '../../../shared/types/api'

type PostRow = typeof communityPosts.$inferSelect
type CommentRow = typeof communityComments.$inferSelect
type SanctionRow = typeof communitySanctions.$inferSelect
type ItemKind = 'post' | 'comment'
export interface ItemRef {
  postId?: string | null
  commentId?: string | null
}

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)
const trimmed = (max: number) =>
  z
    .string({ error: requiredOr('invalid') })
    .trim()
    .min(1, { error: 'required' })
    .max(max, { error: 'too_long' })
const optionalTrimmed = (max: number) =>
  z
    .string({ error: 'invalid' })
    .trim()
    .max(max, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v : null))
const uuidField = z.uuid({ error: requiredOr('invalid') }).transform((v) => v.toLowerCase())

// ── 설정 ─────────────────────────────────────────────────────────────────

let thresholdsOverride: AutoHideThresholds | null = null

/** 기준 수: `PEERCHIVE_COMMUNITY_AUTO_HIDE_OFFICIAL`(기본 5)·`PEERCHIVE_COMMUNITY_AUTO_HIDE_ROOM`(기본 3), 정수 2~50. */
export function autoHideThresholds(env: Record<string, string | undefined> = process.env): AutoHideThresholds {
  if (thresholdsOverride) return thresholdsOverride
  return {
    official: parseAutoHideThreshold(env.PEERCHIVE_COMMUNITY_AUTO_HIDE_OFFICIAL, AUTO_HIDE_THRESHOLDS.official),
    room: parseAutoHideThreshold(env.PEERCHIVE_COMMUNITY_AUTO_HIDE_ROOM, AUTO_HIDE_THRESHOLDS.room),
  }
}

export function setAutoHideThresholdsForTesting(value: AutoHideThresholds | null): void {
  thresholdsOverride = value
}

// ── 공통 불러오기 ─────────────────────────────────────────────────────────

interface LoadedItem {
  kind: ItemKind
  post: PostRow
  comment: CommentRow | null
  /** 이 글·댓글(post 또는 comment) 행. */
  item: PostRow | CommentRow
  targetKey: string
}

async function loadItem(db: DbExecutor, kind: ItemKind, rawId: unknown, lock = false): Promise<LoadedItem> {
  if (!isUuid(rawId)) throw notFound()
  const id = rawId.toLowerCase()
  if (kind === 'post') {
    const q = db.select().from(communityPosts).where(eq(communityPosts.id, id)).limit(1)
    const [post] = lock ? await q.for('update') : await q
    if (!post) throw notFound()
    return { kind, post, comment: null, item: post, targetKey: reportTargetKey({ type: 'community_post', postId: post.id }) }
  }
  const q = db.select().from(communityComments).where(eq(communityComments.id, id)).limit(1)
  const [comment] = lock ? await q.for('update') : await q
  if (!comment) throw notFound()
  const [post] = await db.select().from(communityPosts).where(eq(communityPosts.id, comment.postId)).limit(1)
  if (!post) throw notFound()
  return { kind, post, comment, item: comment, targetKey: reportTargetKey({ type: 'community_comment', commentId: comment.id }) }
}

const itemCols = (kind: ItemKind, id: string) => (kind === 'post' ? { communityPostId: id, communityCommentId: null } : { communityPostId: null, communityCommentId: id })
const tableOf = (kind: ItemKind) => (kind === 'post' ? communityPosts : communityComments)

/** 작성자에게 임시 숨김·복원 알림(허용 목록 payload: 대상 종류만). 계정이 active일 때만. */
async function notifyItemReview(tx: DbExecutor, loaded: LoadedItem, kind: ItemReviewNoticeKind, now: Date): Promise<void> {
  const [author] = await tx.select({ status: users.status }).from(users).where(eq(users.id, loaded.item.authorId)).limit(1)
  if (author?.status !== 'active') return
  // 같은 글에 읽지 않은 같은 종류의 알림이 있으면 하나로 둡니다(글·사람·종류마다 한 행).
  await tx
    .insert(communityNotices)
    .values({ userId: loaded.item.authorId, spaceId: loaded.post.spaceId, kind, postId: loaded.post.id, payload: { target: loaded.kind }, createdAt: now })
    .onConflictDoNothing()
}

// ── 신고 누적 임시 숨김 ──────────────────────────────────────────────────

/** 그 공간 기준으로 지금 active 학교 인증이 있는 사람(학교 연결 공간은 그 학교, 아니면 아무 학교). */
async function verifiedAmong(db: DbExecutor, userIds: string[], schoolId: string | null): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const rows = await db
    .selectDistinct({ userId: institutionAffiliations.userId })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .innerJoin(users, eq(users.id, institutionAffiliations.userId))
    .where(
      and(
        inArray(institutionAffiliations.userId, userIds),
        eq(institutionAffiliations.status, 'active'),
        eq(users.status, 'active'),
        schoolId ? sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${schoolId}` : undefined,
      ),
    )
  return new Set(rows.map((r) => r.userId))
}

/**
 * 신고를 저장한 같은 트랜잭션에서 부릅니다(moderation/reports.ts → targets.ts → reporting.ts). 글·댓글 행을 잠가 동시 신고를 줄 세운 뒤
 * 처리 전 신고의 서로 다른 인증 신고자 수를 세어 기준에 이르면 auto_hidden으로 바꿉니다. 바꿨으면 true.
 */
export async function applyReportThresholdInTx(tx: DbExecutor, ref: ItemRef, triggeredBy: string, now: Date): Promise<boolean> {
  const kind: ItemKind = ref.commentId ? 'comment' : 'post'
  const loaded = await loadItem(tx, kind, ref.commentId ?? ref.postId, true)
  if (loaded.item.status !== 'published') return false
  const space = await loadSpace(tx, loaded.post.spaceId)
  const open = await tx
    .select({ reporterId: reports.reporterId, status: reports.status })
    .from(reports)
    .where(and(eq(reports.targetKey, loaded.targetKey), inArray(reports.status, ['open', 'in_review'])))
  const eligible = await verifiedAmong(tx, [...new Set(open.map((r) => r.reporterId))], space.schoolId)
  const qualifying = qualifyingReporterCount(open, loaded.item.authorId, eligible)
  if (!shouldAutoHide({ status: loaded.item.status, qualifying, threshold: autoHideThreshold(space.row.kind, autoHideThresholds()) })) return false
  const table = tableOf(kind)
  await tx.update(table).set({ status: 'auto_hidden', updatedAt: now }).where(and(eq(table.id, loaded.item.id), eq(table.status, 'published')))
  // 우선 검토 기한(SLA)의 시작점(C-10, ADR 0027): 그때 처리 전인 같은 대상의 신고에 숨김 시각을 남깁니다(운영 지표·상태 확인이 커뮤니티 테이블 없이 씀).
  await tx
    .update(reports)
    .set({ autoHiddenAt: now })
    .where(and(eq(reports.targetKey, loaded.targetKey), inArray(reports.status, ['open', 'in_review']), isNull(reports.autoHiddenAt)))
  // 가려진 글·답변은 아카이브로 옮길 수 없습니다(C-09): 진행 중 옮기기를 취소합니다.
  await cancelTransfersForSourceInTx(tx, kind === 'post' ? { postId: loaded.item.id } : { commentId: loaded.item.id }, 'source_unavailable', now)
  await notifyItemReview(tx, loaded, 'item_auto_hidden', now)
  await emitAnalytics(tx, { name: 'community_auto_hidden', actorId: triggeredBy, unlinked: true, props: { targetKind: kind }, now })
  return true
}

/** 운영자가 조치 없이 닫으면(기각·조치 없음) 임시 숨김을 풉니다: auto_hidden → published + 작성자 알림. 바꿨으면 true. */
export async function restoreAutoHiddenInTx(tx: DbExecutor, ref: ItemRef, now: Date): Promise<boolean> {
  const kind: ItemKind = ref.commentId ? 'comment' : 'post'
  const loaded = await loadItem(tx, kind, ref.commentId ?? ref.postId, true).catch(() => null)
  if (!loaded || loaded.item.status !== 'auto_hidden') return false
  const table = tableOf(kind)
  await tx.update(table).set({ status: 'published', updatedAt: now }).where(eq(table.id, loaded.item.id))
  await notifyItemReview(tx, loaded, 'item_restored', now)
  return true
}

/** 운영자 대기열의 우선순위 표시: 글·댓글 id → 지금 상태. */
export async function communityItemStatuses(db: DbExecutor, postIds: string[], commentIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (postIds.length) for (const r of await db.select({ id: communityPosts.id, status: communityPosts.status }).from(communityPosts).where(inArray(communityPosts.id, postIds))) out.set(r.id, r.status)
  if (commentIds.length) {
    for (const r of await db.select({ id: communityComments.id, status: communityComments.status }).from(communityComments).where(inArray(communityComments.id, commentIds))) out.set(r.id, r.status)
  }
  return out
}

// ── 가리기 효과(운영 조치·방 운영진 공통) ─────────────────────────────────

const HIDE_KINDS = ['hide_post', 'hide_comment', 'space_hide'] as const

/** 운영 조치 hide_post·hide_comment(트랜잭션 안): 게시 중·임시 숨김·(방 운영진이) 가린 것을 hidden으로. 아니면 409 `target_not_public`. 본문은 남깁니다. */
export async function hideCommunityItemInTx(tx: DbExecutor, target: ItemKind, id: string, now: Date): Promise<void> {
  const table = tableOf(target)
  const [row] = await tx.select({ id: table.id, status: table.status }).from(table).where(eq(table.id, id)).limit(1).for('update')
  if (!row) throw notFound()
  if (row.status === 'deleted_by_author') throw conflict('target_not_public')
  await tx.update(table).set({ status: 'hidden', updatedAt: now }).where(eq(table.id, id))
  await cancelTransfersForSourceInTx(tx, target === 'post' ? { postId: id } : { commentId: id }, 'source_unavailable', now)
}

/**
 * 가리기 되돌림: 되돌리는 조치(exceptActionId) 말고 그 대상에 아직 효력이 있는 가리기(운영자 hide_*·방 운영진 space_hide)가 없고 지금 hidden이면 published로.
 * 작성자가 지웠거나 탈퇴 정리됐으면 그대로입니다.
 */
export async function unhideCommunityItemInTx(tx: DbExecutor, target: ItemKind, id: string, now: Date, exceptActionId?: string): Promise<void> {
  const col = target === 'post' ? moderationActions.communityPostId : moderationActions.communityCommentId
  const [other] = await tx
    .select({ id: moderationActions.id })
    .from(moderationActions)
    .where(
      and(
        eq(col, id),
        inArray(moderationActions.kind, [...HIDE_KINDS]),
        isNull(moderationActions.reversedAt),
        exceptActionId ? ne(moderationActions.id, exceptActionId) : undefined,
      ),
    )
    .limit(1)
  if (other) return
  const table = tableOf(target)
  await tx.update(table).set({ status: 'published', updatedAt: now }).where(and(eq(table.id, id), eq(table.status, 'hidden')))
}

// ── 방 운영진: 가리기·되돌리기 ───────────────────────────────────────────

export const spaceHideSchema = z.object({
  /** 작성자에게 보일 사유(필수). */
  publicReason: trimmed(MODERATION_PUBLIC_REASON_MAX),
  /** 운영자만 보는 메모(선택). */
  note: optionalTrimmed(MODERATION_NOTE_MAX),
})
export const spaceUnhideSchema = z.object({ note: optionalTrimmed(MODERATION_NOTE_MAX) })

/** 방 운영진 판정: 읽을 수 있고(아니면 404) canModerate(아니면 403 `moderate_not_allowed`), active 공간(아니면 409). */
async function moderatorContext(tx: DbExecutor, actor: Actor, spaceId: string, now: Date, requireActive = true) {
  const ctx = await loadReadableSpace(tx, actor, spaceId, false, now)
  if (!canModerate(ctx.viewer, ctx.facts, membershipFacts(ctx.membership))) throw forbidden('moderate_not_allowed')
  if (requireActive && ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
  return ctx
}

/**
 * POST /community/posts/:id/hide, /community/comments/:id/hide {publicReason, note?} — 방 운영진이 자기 공간의 게시 중인 글·댓글을 가립니다.
 * 운영 조치 행(kind space_hide, 공간 id 없음) + 작성자 안내(공개 사유) + 감사(id만). 응답은 일반 멤버와 같은 스레드 DTO(작성자 id 없음).
 * 403 moderate_not_allowed, 404, 409 target_not_open·space_not_active, 422, 429(시간당 30).
 */
export async function spaceHideItem(db: DbExecutor, actor: Actor, kind: ItemKind, rawId: unknown, rawInput: unknown, now = new Date()): Promise<CommunityPostDto> {
  const input = parseInput(spaceHideSchema, rawInput)
  const postId = await db.transaction(async (tx) => {
    const peek = await loadItem(tx, kind, rawId)
    await moderatorContext(tx, actor, peek.post.spaceId, now)
    const loaded = await loadItem(tx, kind, peek.item.id, true)
    if (loaded.item.status !== 'published') throw conflict('target_not_open')
    if (!(await hitRateLimit(tx, 'community_space_hide', actor.userId, SPACE_HIDE_RATE_LIMIT, now))) throw rateLimited()
    const [action] = await tx
      .insert(moderationActions)
      .values({
        kind: 'space_hide',
        outcome: 'resolved',
        targetType: kind === 'post' ? 'community_post' : 'community_comment',
        targetKey: loaded.targetKey,
        ...itemCols(kind, loaded.item.id),
        internalNote: input.note ?? SPACE_HIDE_NOTE_DEFAULT,
        publicReason: input.publicReason,
        notifyOwner: true,
        createdBy: actor.userId,
        createdAt: now,
      })
      .returning({ id: moderationActions.id })
    const table = tableOf(kind)
    await tx.update(table).set({ status: 'hidden', updatedAt: now }).where(eq(table.id, loaded.item.id))
    await cancelTransfersForSourceInTx(tx, kind === 'post' ? { postId: loaded.item.id } : { commentId: loaded.item.id }, 'source_unavailable', now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.space_hide',
      targetType: kind === 'post' ? 'community_post' : 'community_comment',
      targetId: loaded.item.id,
      metadata: { actionId: action!.id, spaceId: loaded.post.spaceId },
    })
    return loaded.post.id
  })
  return getPost(db, actor, postId, now)
}

/**
 * POST /community/posts/:id/unhide, /community/comments/:id/unhide {note?} — 방 운영진이 자기 공간의 방 운영진 가리기를 되돌립니다(누가 가렸든).
 * 운영자의 가리기(hide_*)가 함께 있으면 대상은 계속 가려집니다. 409 not_space_hidden.
 */
export async function spaceUnhideItem(db: DbExecutor, actor: Actor, kind: ItemKind, rawId: unknown, rawInput: unknown, now = new Date()): Promise<CommunityPostDto> {
  const input = parseInput(spaceUnhideSchema, rawInput ?? {})
  const postId = await db.transaction(async (tx) => {
    const peek = await loadItem(tx, kind, rawId)
    await moderatorContext(tx, actor, peek.post.spaceId, now)
    const loaded = await loadItem(tx, kind, peek.item.id, true)
    const col = kind === 'post' ? moderationActions.communityPostId : moderationActions.communityCommentId
    const active = await tx
      .select({ id: moderationActions.id })
      .from(moderationActions)
      .where(and(eq(col, loaded.item.id), eq(moderationActions.kind, 'space_hide'), isNull(moderationActions.reversedAt)))
      .for('update')
    if (active.length === 0) throw conflict('not_space_hidden')
    await tx
      .update(moderationActions)
      .set({ reversedAt: now, reversedBy: actor.userId, reverseNote: input.note ?? '방 운영진이 되돌림', reverseCause: 'space' })
      .where(inArray(moderationActions.id, active.map((a) => a.id)))
    await unhideCommunityItemInTx(tx, kind, loaded.item.id, now)
    for (const a of active) {
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'community.space_unhide',
        targetType: kind === 'post' ? 'community_post' : 'community_comment',
        targetId: loaded.item.id,
        metadata: { actionId: a.id, spaceId: loaded.post.spaceId },
      })
    }
    return loaded.post.id
  })
  return getPost(db, actor, postId, now)
}

// ── 방 운영진: 운영 화면·제재 요청 ───────────────────────────────────────

const requestStatusForRequester = (s: 'open' | 'resolved' | 'dismissed') => (s === 'open' ? ('received' as const) : s)

/**
 * GET /community/spaces/:slug/moderation — 방 운영진의 공간 운영 화면: 지금 효력이 있는 방 운영진 가리기, 이 공간의 제재 요청과 상태
 * (처리됨이면 제재가 있었는지만), 이 공간 범위의 쓰기 제한 개수. **누구에게 무엇이 내려졌는지(작성자 id·핸들·이름)는 없습니다.**
 */
export async function getSpaceModeration(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<SpaceModerationDto> {
  const space = await loadSpace(db, ref)
  const ctx = await moderatorContext(db, actor, space.row.id, now, false)
  const spaceId = ctx.space.row.id
  const activeHide = and(eq(moderationActions.kind, 'space_hide'), isNull(moderationActions.reversedAt))
  const postHides = await db
    .select({ action: moderationActions, postId: communityPosts.id })
    .from(moderationActions)
    .innerJoin(communityPosts, eq(communityPosts.id, moderationActions.communityPostId))
    .where(and(activeHide, eq(communityPosts.spaceId, spaceId)))
    .limit(100)
  const commentHides = await db
    .select({ action: moderationActions, postId: communityComments.postId })
    .from(moderationActions)
    .innerJoin(communityComments, eq(communityComments.id, moderationActions.communityCommentId))
    .innerJoin(communityPosts, eq(communityPosts.id, communityComments.postId))
    .where(and(activeHide, eq(communityPosts.spaceId, spaceId)))
    .limit(100)
  const hideRows = [...postHides, ...commentHides].sort((x, y) => y.action.createdAt.getTime() - x.action.createdAt.getTime())
  const requestRows = await db
    .select()
    .from(communitySanctionRequests)
    .where(eq(communitySanctionRequests.spaceId, spaceId))
    .orderBy(desc(communitySanctionRequests.createdAt), desc(communitySanctionRequests.id))
    .limit(100)
  const commentPosts = await postIdsOfComments(db, requestRows.map((r) => r.commentId).filter((id): id is string => !!id))
  const sanctioned = requestRows.length
    ? new Set(
        (await db.select({ requestId: communitySanctions.requestId }).from(communitySanctions).where(inArray(communitySanctions.requestId, requestRows.map((r) => r.id)))).map(
          (r) => r.requestId,
        ),
      )
    : new Set<string | null>()
  const spaceSanctions = await db
    .select({ scope: communitySanctions.scope, spaceId: communitySanctions.spaceId, level: communitySanctions.level, until: communitySanctions.until, revokedAt: communitySanctions.revokedAt })
    .from(communitySanctions)
    .where(and(eq(communitySanctions.spaceId, spaceId), isNull(communitySanctions.revokedAt)))
  return {
    space: { slug: ctx.space.row.slug, name: ctx.space.row.name, kind: ctx.space.row.kind },
    hides: hideRows.map(({ action, postId }) => ({
      actionId: action.id,
      targetType: action.communityCommentId ? 'comment' : 'post',
      postId,
      commentId: action.communityCommentId,
      publicReason: action.publicReason,
      createdAt: action.createdAt.toISOString(),
    })),
    requests: requestRows.map((r) => ({
      id: r.id,
      targetType: r.commentId ? 'comment' : 'post',
      postId: r.postId ?? commentPosts.get(r.commentId!) ?? '',
      commentId: r.commentId,
      reason: r.reason,
      status: requestStatusForRequester(r.status),
      outcome: r.status === 'open' ? null : sanctioned.has(r.id) ? 'sanctioned' : 'no_action',
      mine: r.requestedBy === actor.userId,
      createdAt: r.createdAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    })),
    activeSpaceRestrictions: spaceSanctions.filter((s) => sanctionBlocksWrite(s, spaceId, now)).length,
  }
}

async function postIdsOfComments(db: DbExecutor, commentIds: string[]): Promise<Map<string, string>> {
  if (commentIds.length === 0) return new Map()
  const rows = await db.select({ id: communityComments.id, postId: communityComments.postId }).from(communityComments).where(inArray(communityComments.id, commentIds))
  return new Map(rows.map((r) => [r.id, r.postId]))
}

export const sanctionRequestSchema = z.object({
  targetType: z.enum(['post', 'comment'], { error: requiredOr('invalid') }),
  targetId: uuidField,
  reason: z.enum(REPORT_REASONS, { error: requiredOr('invalid') }),
  details: trimmed(SANCTION_REQUEST_DETAILS_MAX),
})

/**
 * POST /community/sanction-requests {targetType: post|comment, targetId, reason, details} — 방 운영진이 자기 공간의 글·댓글을 가리켜
 * 운영자에게 제재를 요청합니다(작성자를 모름). 같은 사람·대상의 처리 전 요청이 있으면 그것(200, created false). 201·403·404·422·429.
 */
export async function createSanctionRequest(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<SanctionRequestReceiptDto> {
  const input = parseInput(sanctionRequestSchema, rawInput)
  return db.transaction(async (tx) => {
    const loaded = await loadItem(tx, input.targetType, input.targetId)
    await moderatorContext(tx, actor, loaded.post.spaceId, now, false)
    const existing = async () => {
      const [row] = await tx
        .select()
        .from(communitySanctionRequests)
        .where(and(eq(communitySanctionRequests.requestedBy, actor.userId), eq(communitySanctionRequests.targetKey, loaded.targetKey), eq(communitySanctionRequests.status, 'open')))
        .limit(1)
      return row
    }
    const dup = await existing()
    if (dup) return requestReceipt(dup, false)
    if (!(await hitRateLimit(tx, 'community_sanction_request', actor.userId, SANCTION_REQUEST_RATE_LIMIT, now))) throw rateLimited()
    if (!(await hitRateLimit(tx, 'community_sanction_request_daily', actor.userId, SANCTION_REQUEST_DAILY_LIMIT, now))) throw rateLimited()
    let row: typeof communitySanctionRequests.$inferSelect
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(communitySanctionRequests)
          .values({
            spaceId: loaded.post.spaceId,
            requestedBy: actor.userId,
            postId: input.targetType === 'post' ? loaded.item.id : null,
            commentId: input.targetType === 'comment' ? loaded.item.id : null,
            targetKey: loaded.targetKey,
            reason: input.reason,
            details: input.details,
            createdAt: now,
          })
          .returning()
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) !== '23505') throw error
      const again = await existing()
      if (again) return requestReceipt(again, false)
      throw error
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.sanction_request',
      targetType: 'community_sanction_request',
      targetId: row.id,
      metadata: { spaceId: loaded.post.spaceId, targetType: input.targetType, reason: input.reason },
    })
    return requestReceipt(row, true)
  })
}

function requestReceipt(row: typeof communitySanctionRequests.$inferSelect, created: boolean): SanctionRequestReceiptDto {
  return { id: row.id, status: requestStatusForRequester(row.status), created, createdAt: row.createdAt.toISOString() }
}

// ── 운영자: 신고 상세의 글·댓글 ─────────────────────────────────────────

/**
 * 운영자 화면의 글·댓글: 지금 행(가린 글도 본문 포함 — 이의제기 판단용), 공간 이름, 작성자 표시(익명은 `익명`). 작성자 id는 없습니다
 * (작성자 확인은 lookupAuthor만). 지운 글은 본문이 비어 있습니다. 없으면 null.
 */
export async function operatorCommunityItem(db: DbExecutor, target: ItemRef): Promise<OperatorCommunityItemDto | null> {
  const loaded = await loadItem(db, target.commentId ? 'comment' : 'post', target.commentId ?? target.postId).catch(() => null)
  if (!loaded) return null
  const { post, comment, item } = loaded
  const [space] = await db.select({ slug: communitySpaces.slug, name: communitySpaces.name, kind: communitySpaces.kind }).from(communitySpaces).where(eq(communitySpaces.id, post.spaceId)).limit(1)
  const [author] = await db
    .select({ id: users.id, status: users.status, purgedAt: users.purgedAt, realName: users.realName })
    .from(users)
    .where(eq(users.id, item.authorId))
    .limit(1)
  // 표시명 글은 고정한 표시명 페르소나의 이름만(계정 이름 아님, ADR 0030). 화면과 같은 표시입니다.
  const displayNames = item.nameMode === 'display' ? await displayPersonaNames(db, [item.personaId]) : new Map<string, string>()
  const display = resolveAuthorDisplay(
    item.nameMode,
    {
      userId: item.authorId,
      status: author?.status ?? 'deleted',
      purged: !author || author.purgedAt !== null,
      displayPersonaName: item.personaId ? (displayNames.get(item.personaId) ?? null) : null,
      realName: author?.realName ?? null,
    },
    null,
  )
  return {
    space: { slug: space!.slug, name: space!.name, kind: space!.kind },
    postId: post.id,
    commentId: comment?.id ?? null,
    title: comment ? null : post.title || null,
    body: item.body || null,
    status: item.status,
    nameMode: item.nameMode,
    authorLabel: display.label ?? '익명',
    ...(item.nameMode === 'affiliated_anonymous' && { affiliationLabel: item.affiliationLabel }),
    createdAt: item.createdAt.toISOString(),
    edited: item.editedAt !== null,
  }
}

// ── 운영자: 제재 요청 ────────────────────────────────────────────────────

/** GET /operator/community/sanction-requests?status=open|resolved|dismissed(기본 open). 요청자 이름은 운영자에게 보입니다. 작성자는 없습니다. */
export async function listSanctionRequests(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>): Promise<OperatorSanctionRequestDto[]> {
  await requireOperator(db, actor)
  const status = typeof rawQuery.status === 'string' && rawQuery.status ? rawQuery.status : 'open'
  if (!['open', 'resolved', 'dismissed'].includes(status)) throw invalid({ status: 'invalid' })
  const rows = await db
    .select({ request: communitySanctionRequests, requester: users.displayName })
    .from(communitySanctionRequests)
    .innerJoin(users, eq(users.id, communitySanctionRequests.requestedBy))
    .where(eq(communitySanctionRequests.status, status as 'open'))
    .orderBy(status === 'open' ? communitySanctionRequests.createdAt : desc(communitySanctionRequests.createdAt))
    .limit(100)
  return Promise.all(rows.map(({ request, requester }) => toOperatorRequest(db, request, requester)))
}

async function toOperatorRequest(db: DbExecutor, r: typeof communitySanctionRequests.$inferSelect, requester: string): Promise<OperatorSanctionRequestDto> {
  const item = await operatorCommunityItem(db, { postId: r.postId, commentId: r.commentId })
  const sanctionRows = await db.select({ id: communitySanctions.id }).from(communitySanctions).where(eq(communitySanctions.requestId, r.id))
  return {
    id: r.id,
    status: r.status,
    targetType: r.commentId ? 'comment' : 'post',
    targetId: (r.commentId ?? r.postId)!,
    reason: r.reason,
    details: r.details,
    requestedBy: requester,
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
    closeNote: r.closeNote,
    item,
    sanctionIds: sanctionRows.map((s) => s.id),
  }
}

const noteSchema = z.object({ note: trimmed(MODERATION_NOTE_MAX) })

/** POST /operator/community/sanction-requests/:id/dismiss {note} — 제재 없이 닫음. 409 already_closed. */
export async function dismissSanctionRequest(db: DbExecutor, actor: Actor, rawId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorSanctionRequestDto> {
  await requireOperator(db, actor)
  const input = parseInput(noteSchema, rawInput)
  if (!isUuid(rawId)) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(communitySanctionRequests).where(eq(communitySanctionRequests.id, rawId.toLowerCase())).limit(1).for('update')
    if (!row) throw notFound()
    if (row.status !== 'open') throw conflict('already_closed')
    const [updated] = await tx
      .update(communitySanctionRequests)
      .set({ status: 'dismissed', closedAt: now, closedBy: actor.userId, closeNote: input.note })
      .where(eq(communitySanctionRequests.id, row.id))
      .returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.sanction_request_dismiss', targetType: 'community_sanction_request', targetId: row.id, metadata: {} })
    const [me] = await tx.select({ name: users.displayName }).from(users).where(eq(users.id, row.requestedBy)).limit(1)
    return toOperatorRequest(tx, updated!, me?.name ?? '')
  })
}

// ── 운영자: 작성자 확인 ──────────────────────────────────────────────────

export const authorLookupSchema = z
  .object({
    targetType: z.enum(['post', 'comment'], { error: requiredOr('invalid') }),
    targetId: uuidField,
    reason: trimmed(AUTHOR_LOOKUP_REASON_MAX),
    reportId: uuidField.optional(),
    requestId: uuidField.optional(),
  })
  .refine((v) => !(v.reportId && v.requestId), { error: 'one_basis_only', path: ['requestId'] })

/**
 * POST /operator/community/author-lookups {targetType, targetId, reason, reportId?|requestId?} — 운영자만(canResolveAuthor, 아니면 403 operator_only).
 * 근거 신고·요청을 주면 그 대상과 같아야 합니다(422 `reportId|requestId: mismatch`). 한도 시간당 20·하루 60(429).
 * 한 트랜잭션에서 조회 기록(사유는 여기) + 감사 `community.author_lookup`(id만: 조회 id·근거 id) 뒤 작성자의 내부 id·핸들·계정 상태와
 * 그 사람의 제재 이력을 돌려줍니다. 이메일·실명은 싣지 않습니다. 201.
 */
export async function lookupAuthor(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<AuthorLookupResultDto> {
  const viewer = await loadViewer(db, actor, null, now)
  if (!canResolveAuthor(viewer)) throw forbidden('operator_only')
  const input = parseInput(authorLookupSchema, rawInput)
  return db.transaction(async (tx) => {
    const loaded = await loadItem(tx, input.targetType, input.targetId)
    if (input.reportId) {
      const [report] = await tx.select({ targetKey: reports.targetKey }).from(reports).where(eq(reports.id, input.reportId)).limit(1)
      if (!report || report.targetKey !== loaded.targetKey) throw invalid({ reportId: 'mismatch' })
    }
    if (input.requestId) {
      const [request] = await tx.select({ targetKey: communitySanctionRequests.targetKey }).from(communitySanctionRequests).where(eq(communitySanctionRequests.id, input.requestId)).limit(1)
      if (!request || request.targetKey !== loaded.targetKey) throw invalid({ requestId: 'mismatch' })
    }
    if (!(await hitRateLimit(tx, 'community_author_lookup', actor.userId, AUTHOR_LOOKUP_RATE_LIMIT, now))) throw rateLimited()
    if (!(await hitRateLimit(tx, 'community_author_lookup_daily', actor.userId, AUTHOR_LOOKUP_DAILY_LIMIT, now))) throw rateLimited()
    const [lookup] = await tx
      .insert(communityAuthorLookups)
      .values({
        operatorId: actor.userId,
        targetType: input.targetType,
        postId: input.targetType === 'post' ? loaded.item.id : null,
        commentId: input.targetType === 'comment' ? loaded.item.id : null,
        authorId: loaded.item.authorId,
        reason: input.reason,
        reportId: input.reportId ?? null,
        requestId: input.requestId ?? null,
        createdAt: now,
      })
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.author_lookup',
      targetType: input.targetType === 'post' ? 'community_post' : 'community_comment',
      targetId: loaded.item.id,
      metadata: { lookupId: lookup!.id, reportId: input.reportId ?? null, requestId: input.requestId ?? null },
    })
    // §6.1 operator_identity_lookup(C-10): 근거 종류만, 사용자 키 없이(운영자 행동을 사람과 잇지 않음).
    const basis = input.reportId ? 'report' : input.requestId ? 'sanction_request' : 'none'
    await emitAnalytics(tx, { name: 'community_author_lookup', actorId: actor.userId, unlinked: true, props: { basis }, now })
    const [author] = await tx
      .select({ id: users.id, status: users.status, purgedAt: users.purgedAt, handle: profiles.handle })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, loaded.item.authorId))
      .limit(1)
    const history = await tx.select().from(communitySanctions).where(eq(communitySanctions.userId, loaded.item.authorId)).orderBy(desc(communitySanctions.createdAt)).limit(50)
    return {
      lookupId: lookup!.id,
      targetType: input.targetType,
      targetId: loaded.item.id,
      postId: loaded.post.id,
      spaceId: loaded.post.spaceId,
      author: { userId: loaded.item.authorId, handle: author?.handle ?? null, status: author?.status ?? 'deleted', purged: !author || author.purgedAt !== null },
      // 소속 표시 익명(A-05, ADR 0042): 표시에 쓴 소속 id는 사유를 남긴 이 확인 경로로만 운영자에게 보입니다.
      ...(loaded.item.nameMode === 'affiliated_anonymous' && { affiliationId: loaded.item.affiliationId }),
      sanctions: await toOperatorSanctions(tx, history, now),
      createdAt: lookup!.createdAt.toISOString(),
      validUntil: new Date(lookup!.createdAt.getTime() + AUTHOR_LOOKUP_VALID_MS).toISOString(),
    }
  })
}

/** GET /operator/community/author-lookups?target=<글·댓글 id> — 작성자 확인 기록(최근 100). **확인한 작성자는 싣지 않습니다**(기록 열람이 새 확인이 되지 않게). */
export async function listAuthorLookups(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>): Promise<OperatorAuthorLookupDto[]> {
  await requireOperator(db, actor)
  const target = rawQuery.target
  if (target !== undefined && target !== '' && !isUuid(target)) throw invalid({ target: 'invalid' })
  const t = typeof target === 'string' && target ? target.toLowerCase() : null
  const rows = await db
    .select({ lookup: communityAuthorLookups, operator: users.displayName, commentPost: communityComments.postId })
    .from(communityAuthorLookups)
    .innerJoin(users, eq(users.id, communityAuthorLookups.operatorId))
    .leftJoin(communityComments, eq(communityComments.id, communityAuthorLookups.commentId))
    .where(t ? or(eq(communityAuthorLookups.postId, t), eq(communityAuthorLookups.commentId, t)) : undefined)
    .orderBy(desc(communityAuthorLookups.createdAt), desc(communityAuthorLookups.id))
    .limit(100)
  const sanctionedBy = new Set(
    rows.length
      ? (await db.select({ lookupId: communitySanctions.lookupId }).from(communitySanctions).where(inArray(communitySanctions.lookupId, rows.map((r) => r.lookup.id)))).map((r) => r.lookupId)
      : [],
  )
  return rows.map(({ lookup, operator, commentPost }) => ({
    id: lookup.id,
    operator,
    targetType: lookup.targetType as 'post' | 'comment',
    targetId: (lookup.postId ?? lookup.commentId)!,
    postId: lookup.postId ?? commentPost ?? '',
    reason: lookup.reason,
    reportId: lookup.reportId,
    requestId: lookup.requestId,
    createdAt: lookup.createdAt.toISOString(),
    sanctioned: sanctionedBy.has(lookup.id),
  }))
}

// ── 운영자: 제재 발급·목록·해제 ─────────────────────────────────────────

export const issueSanctionSchema = z.object({
  lookupId: uuidField,
  level: z.enum(SANCTION_LEVELS, { error: requiredOr('invalid') }),
  scope: z.enum(SANCTION_SCOPES, { error: requiredOr('invalid') }),
  /** 쓰기 기간 제한의 일수(1~365). 다른 수준에는 주지 않습니다. */
  days: z.number({ error: 'invalid' }).int({ error: 'invalid' }).min(1, { error: 'invalid' }).max(SANCTION_MAX_DAYS, { error: 'too_long' }).nullish(),
  /** 내부 메모(운영자만). */
  note: trimmed(MODERATION_NOTE_MAX),
  /** 당사자에게 보일 사유(필수: 이의제기 안내와 함께 보임). */
  publicReason: trimmed(MODERATION_PUBLIC_REASON_MAX),
})

/**
 * POST /operator/community/sanctions {lookupId, level, scope, days?, note, publicReason} — 운영자만. 같은 운영자가 24시간 안에 한 작성자 확인이어야 합니다
 * (409 lookup_not_yours·lookup_expired, 탈퇴 정리된 작성자 409 author_unavailable). space 범위는 그 글·댓글의 공간입니다. 한 트랜잭션에서
 * 운영 조치 행(kind sanction, 당사자 안내 켬) + 제재 행 + 근거 요청 닫기(resolved) + 감사(id·코드만) + 분석(수준·범위만). 201.
 */
export async function issueSanction(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<OperatorSanctionDto> {
  await requireOperator(db, actor)
  const input = parseInput(issueSanctionSchema, rawInput)
  const until = input.days ? new Date(now.getTime() + input.days * 24 * 60 * 60 * 1000) : null
  const checked = checkSanctionInput({ level: input.level, scope: input.scope, until }, now)
  if (!checked.ok) throw invalid({ [checked.field === 'until' ? 'days' : 'scope']: checked.reason })
  return db.transaction(async (tx) => {
    const [lookup] = await tx.select().from(communityAuthorLookups).where(eq(communityAuthorLookups.id, input.lookupId)).limit(1).for('update')
    if (!lookup) throw notFound()
    if (lookup.operatorId !== actor.userId) throw conflict('lookup_not_yours')
    if (now.getTime() - lookup.createdAt.getTime() > AUTHOR_LOOKUP_VALID_MS) throw conflict('lookup_expired')
    if (!lookup.authorId) throw conflict('author_unavailable')
    const [author] = await tx.select({ purgedAt: users.purgedAt }).from(users).where(eq(users.id, lookup.authorId)).limit(1)
    if (!author || author.purgedAt) throw conflict('author_unavailable')
    const kind = lookup.targetType as ItemKind
    const loaded = await loadItem(tx, kind, lookup.postId ?? lookup.commentId)
    const [action] = await tx
      .insert(moderationActions)
      .values({
        kind: 'sanction',
        outcome: 'resolved',
        targetType: kind === 'post' ? 'community_post' : 'community_comment',
        targetKey: loaded.targetKey,
        ...itemCols(kind, loaded.item.id),
        internalNote: input.note,
        publicReason: input.publicReason,
        notifyOwner: true,
        createdBy: actor.userId,
        createdAt: now,
      })
      .returning({ id: moderationActions.id })
    const [sanction] = await tx
      .insert(communitySanctions)
      .values({
        userId: lookup.authorId,
        scope: input.scope,
        spaceId: input.scope === 'space' ? loaded.post.spaceId : null,
        level: input.level,
        until: checked.until,
        actionId: action!.id,
        lookupId: lookup.id,
        reportId: lookup.reportId,
        requestId: lookup.requestId,
        issuedBy: actor.userId,
        createdAt: now,
      })
      .returning()
    if (lookup.requestId) {
      await tx
        .update(communitySanctionRequests)
        .set({ status: 'resolved', closedAt: now, closedBy: actor.userId, closeNote: '제재 발급' })
        .where(and(eq(communitySanctionRequests.id, lookup.requestId), eq(communitySanctionRequests.status, 'open')))
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.sanction_issue',
      targetType: 'community_sanction',
      targetId: sanction!.id,
      metadata: { actionId: action!.id, lookupId: lookup.id, level: input.level, scope: input.scope, spaceId: sanction!.spaceId, requestId: lookup.requestId, reportId: lookup.reportId },
    })
    await emitAnalytics(tx, { name: 'community_sanction_issued', actorId: actor.userId, unlinked: true, props: { level: input.level, scope: input.scope }, now })
    const [dto] = await toOperatorSanctions(tx, [sanction!], now)
    return dto!
  })
}

async function toOperatorSanctions(db: DbExecutor, rows: SanctionRow[], now: Date): Promise<OperatorSanctionDto[]> {
  if (rows.length === 0) return []
  const actionIds = rows.map((r) => r.actionId)
  const spaceIds = [...new Set(rows.map((r) => r.spaceId).filter((id): id is string => !!id))]
  const [actionRows, appealRows, issuerRows, spaceRows] = await Promise.all([
    db.select().from(moderationActions).where(inArray(moderationActions.id, actionIds)),
    db.select({ id: appeals.id, actionId: appeals.actionId, status: appeals.status }).from(appeals).where(inArray(appeals.actionId, actionIds)),
    db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [...new Set(rows.map((r) => r.issuedBy))])),
    spaceIds.length
      ? db.select({ id: communitySpaces.id, slug: communitySpaces.slug, name: communitySpaces.name }).from(communitySpaces).where(inArray(communitySpaces.id, spaceIds))
      : [],
  ])
  const actionBy = new Map(actionRows.map((a) => [a.id, a]))
  const appealBy = new Map(appealRows.map((a) => [a.actionId, a]))
  const issuerBy = new Map(issuerRows.map((u) => [u.id, u.name]))
  const spaceBy = new Map(spaceRows.map((s) => [s.id, { slug: s.slug, name: s.name }]))
  const commentPosts = await postIdsOfComments(db, actionRows.map((a) => a.communityCommentId).filter((id): id is string => !!id))
  return rows.map((s) => {
    const a = actionBy.get(s.actionId)
    const appeal = appealBy.get(s.actionId)
    return {
      id: s.id,
      actionId: s.actionId,
      level: s.level,
      scope: s.scope,
      space: s.spaceId ? (spaceBy.get(s.spaceId) ?? null) : null,
      until: s.until?.toISOString() ?? null,
      active: isSanctionActive(s, now),
      createdAt: s.createdAt.toISOString(),
      revokedAt: s.revokedAt?.toISOString() ?? null,
      issuedBy: issuerBy.get(s.issuedBy) ?? '',
      targetType: a?.communityCommentId ? 'comment' : 'post',
      targetId: (a?.communityCommentId ?? a?.communityPostId) ?? '',
      postId: a?.communityPostId ?? commentPosts.get(a?.communityCommentId ?? '') ?? '',
      lookupId: s.lookupId,
      reportId: s.reportId,
      requestId: s.requestId,
      internalNote: a?.internalNote ?? '',
      publicReason: a?.publicReason ?? null,
      appeal: appeal ? { id: appeal.id, status: appeal.status } : null,
    }
  })
}

/**
 * GET /operator/community/sanctions?status=active|all(기본 active) — 제재 목록(최근 100). **대상자(사람)는 싣지 않습니다**: 제재 목록과 대상 글을
 * 함께 보는 것이 작성자 확인의 우회가 되지 않게. 대상자가 필요하면 사유를 적고 작성자 확인을 다시 합니다.
 */
export async function listSanctions(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>, now = new Date()): Promise<OperatorSanctionDto[]> {
  await requireOperator(db, actor)
  const status = typeof rawQuery.status === 'string' && rawQuery.status ? rawQuery.status : 'active'
  if (status !== 'active' && status !== 'all') throw invalid({ status: 'invalid' })
  const rows = await db
    .select()
    .from(communitySanctions)
    .where(status === 'active' ? isNull(communitySanctions.revokedAt) : undefined)
    .orderBy(desc(communitySanctions.createdAt), desc(communitySanctions.id))
    .limit(200)
  const dtos = await toOperatorSanctions(db, rows, now)
  return (status === 'active' ? dtos.filter((d) => d.active) : dtos).slice(0, 100)
}

/** 제재를 되돌림(트랜잭션 안, 운영자 해제·이의제기 되돌림 공통). 이미 되돌렸으면 false. */
export async function revokeSanctionByActionInTx(tx: DbExecutor, actionId: string, operatorId: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(communitySanctions)
    .set({ revokedAt: now, revokedBy: operatorId })
    .where(and(eq(communitySanctions.actionId, actionId), isNull(communitySanctions.revokedAt)))
    .returning({ id: communitySanctions.id })
  return rows.length > 0
}

/** POST /operator/community/sanctions/:id/revoke {note} — 운영자 해제(조치 행을 lift로 되돌림). 409 already_revoked. */
export async function revokeSanction(db: DbExecutor, actor: Actor, rawId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorSanctionDto> {
  await requireOperator(db, actor)
  const input = parseInput(noteSchema, rawInput)
  if (!isUuid(rawId)) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(communitySanctions).where(eq(communitySanctions.id, rawId.toLowerCase())).limit(1).for('update')
    if (!row) throw notFound()
    if (row.revokedAt) throw conflict('already_revoked')
    await revokeSanctionByActionInTx(tx, row.actionId, actor.userId, now)
    await tx
      .update(moderationActions)
      .set({ reversedAt: now, reversedBy: actor.userId, reverseNote: input.note, reverseCause: 'lift' })
      .where(and(eq(moderationActions.id, row.actionId), isNull(moderationActions.reversedAt)))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.sanction_revoke', targetType: 'community_sanction', targetId: row.id, metadata: { actionId: row.actionId } })
    const [after] = await tx.select().from(communitySanctions).where(eq(communitySanctions.id, row.id)).limit(1)
    const [dto] = await toOperatorSanctions(tx, [after!], now)
    return dto!
  })
}

// ── 운영자: 방 운영진 가리기 목록·되돌림 ─────────────────────────────────

/** GET /operator/community/space-hides — 방 운영진 가리기(최근 100). 가린 사람 이름은 운영자에게 보입니다. 작성자는 없습니다. */
export async function listSpaceHides(db: DbExecutor, actor: Actor): Promise<OperatorSpaceHideDto[]> {
  await requireOperator(db, actor)
  const rows = await db
    .select({ action: moderationActions, creator: users.displayName })
    .from(moderationActions)
    .innerJoin(users, eq(users.id, moderationActions.createdBy))
    .where(eq(moderationActions.kind, 'space_hide'))
    .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
    .limit(100)
  const commentPosts = await postIdsOfComments(db, rows.map((r) => r.action.communityCommentId).filter((id): id is string => !!id))
  const postIds = [...new Set(rows.map((r) => r.action.communityPostId ?? commentPosts.get(r.action.communityCommentId ?? '')).filter((id): id is string => !!id))]
  const spaceOf = new Map<string, { slug: string; name: string }>()
  if (postIds.length) {
    const ps = await db
      .select({ id: communityPosts.id, slug: communitySpaces.slug, name: communitySpaces.name })
      .from(communityPosts)
      .innerJoin(communitySpaces, eq(communitySpaces.id, communityPosts.spaceId))
      .where(inArray(communityPosts.id, postIds))
    for (const p of ps) spaceOf.set(p.id, { slug: p.slug, name: p.name })
  }
  return rows.map(({ action: a, creator }) => {
    const postId = a.communityPostId ?? commentPosts.get(a.communityCommentId ?? '') ?? ''
    return {
      actionId: a.id,
      space: spaceOf.get(postId) ?? null,
      targetType: a.communityCommentId ? 'comment' : 'post',
      postId,
      commentId: a.communityCommentId,
      publicReason: a.publicReason,
      internalNote: a.internalNote,
      createdBy: creator,
      createdAt: a.createdAt.toISOString(),
      reversedAt: a.reversedAt?.toISOString() ?? null,
      reverseCause: (a.reverseCause as OperatorSpaceHideDto['reverseCause']) ?? null,
    }
  })
}

/** POST /operator/community/space-hides/:actionId/reverse {note} — 운영자가 방 운영진 가리기를 되돌립니다(lift). 409 already_reversed. */
export async function reverseSpaceHide(db: DbExecutor, actor: Actor, rawId: unknown, rawInput: unknown, now = new Date()): Promise<{ actionId: string; reversed: true }> {
  await requireOperator(db, actor)
  const input = parseInput(noteSchema, rawInput)
  if (!isUuid(rawId)) throw notFound()
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(moderationActions).where(and(eq(moderationActions.id, rawId.toLowerCase()), eq(moderationActions.kind, 'space_hide'))).limit(1).for('update')
    if (!a) throw notFound()
    if (a.reversedAt) throw conflict('already_reversed')
    await tx.update(moderationActions).set({ reversedAt: now, reversedBy: actor.userId, reverseNote: input.note, reverseCause: 'lift' }).where(eq(moderationActions.id, a.id))
    const kind: ItemKind = a.communityCommentId ? 'comment' : 'post'
    await unhideCommunityItemInTx(tx, kind, (a.communityCommentId ?? a.communityPostId)!, now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'moderation.lift',
      targetType: kind === 'post' ? 'community_post' : 'community_comment',
      targetId: a.communityCommentId ?? a.communityPostId,
      metadata: { actionId: a.id, kind: 'space_hide' },
    })
    return { actionId: a.id, reversed: true as const }
  })
}
