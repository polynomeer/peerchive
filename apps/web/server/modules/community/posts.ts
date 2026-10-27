/**
 * 커뮤니티 글·댓글·공감·스레드 익명 번호 (C-04, PROOFU_EVOLUTION_PLAN §8.5·§8.9.1·§8.9.6·§8.9.7, SYSTEM_DESIGN §6.7 Post·Comment·ThreadAlias·
 * Reaction·§8.1·§8.2·§9.1, DELIVERY_PLAN §4.1 C-04·§5.1 K, ADR 0020·0022).
 *
 * - 모든 읽기·쓰기는 공간 정책 함수를 거칩니다(loadReadableSpace → canReadSpace, 쓰기는 canWriteBoard·canCommentOnBoard·canReact).
 *   읽을 수 없으면 404(글이 있는지도 드러내지 않음), 읽을 수는 있지만 쓸 자격이 없으면 403, 보관·제한된 공간은 409 `space_not_active`.
 * - **작성 시점 고정(ADR 0020)**: 글·댓글을 넣는 트랜잭션에서 공간 행을 `FOR SHARE`로 잠그고(방식 변경 예약·worker 적용은 FOR UPDATE라 기다림)
 *   그 순간의 예약까지 읽어 `nameModeAtWrite`가 돌려준 값만 `name_mode`에 넣습니다. 고치기·지우기는 이 열을 건드리지 않으며 DB 트리거가
 *   바꾸려는 UPDATE를 거부합니다(migration 0020).
 * - **스레드 익명 번호**: 익명으로 쓸 때만 `thread_aliases`에 번호를 받습니다(assignThreadAlias). 같은 스레드의 번호를 정할 때는 글 행을
 *   `FOR UPDATE`로 잠가 순서를 정합니다(잠금 순서: 공간 FOR SHARE → 글 FOR UPDATE).
 * - **응답(DTO)**: 사람 id·핸들·프로필 링크·별칭 행 id가 없습니다. 작성자 표시는 resolveAuthorDisplay + 스레드 번호(threadAuthorView)이고,
 *   보는 사람이 방장·모더레이터·운영자여도 같습니다(`mine`만 그 사람의 글에 true). 공감은 개수와 내가 눌렀는지만.
 *   소규모(active 멤버 10명 미만) 사용자 방의 익명 글·댓글은 시각을 `today`/`this_week`/`earlier`로만 보냅니다(DB에는 정확한 시각).
 * - 지운 글·댓글은 행을 남기고(번호·답글 유지) 제목·본문을 비웁니다. 가린 글(운영 조치)은 본문을 남기지만 응답에는 싣지 않습니다.
 * - C-09(ADR 0025): 질문 게시판 글의 글쓴이는 최상위 댓글 하나를 "채택된 답변"으로 고릅니다(바꾸기·풀기). 글 응답에 채택 여부와
 *   "아카이브로 옮겨짐" 표시, 보는 사람이 관련된 옮기기 요청 요약(archive-transfers.ts)이 붙습니다. 글·답변을 지우면 진행 중 옮기기는 취소됩니다.
 * - 감사 기록을 남기지 않습니다: 작성자 id와 글 id를 한 행에 남기면 익명 글의 작성자를 찾는 길(C-06의 사유 기록 경로 밖)이 생기기 때문입니다.
 *   분석 이벤트는 허용 목록(게시판 종류·방식·답글 여부·대상 종류)만, 익명 글·댓글은 사용자 키 없이(unlinked) 남깁니다.
 */
import { z } from 'zod'
import {
  ANONYMITY_OPERATOR_NOTE,
  COMMENT_BODY_MAX,
  COMMENT_RATE_LIMIT,
  NAME_MODES,
  POST_BODY_MAX,
  POST_PAGE_SIZE,
  POST_RATE_LIMIT,
  THREAD_COMMENT_LIMIT,
  type AuthorProfileBits,
  type CommunityItemStatus,
  type NameMode,
  assignThreadAlias,
  canChangeOwnItem,
  canCommentOnBoard,
  canReact,
  canWriteBoard,
  checkItemBody,
  checkPostTitle,
  composerNameModeNote,
  effectiveNameMode,
  isOfficialKind,
  isOpenItem,
  itemPlaceholder,
  nameModeAtWrite,
  resolveAuthorDisplay,
  shouldBucketTimes,
  threadAuthorView,
  timeBucket,
  writeRestrictionText,
} from '@peerchive/domain'
import {
  and,
  asc,
  boards,
  communityComments,
  communityPosts,
  communityReactions,
  communitySpaces,
  desc,
  eq,
  inArray,
  institutionAffiliations,
  ne,
  schools,
  sql,
  threadAliases,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, rateLimited, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { type SpaceContext, loadReadableSpace, membershipFacts, writeRestricted } from './access'
import { cancelTransfersForAnswerChangeInTx, cancelTransfersForSourceInTx, postArchiveInfo } from './archive-transfers'
import { loadScheduledChange } from './name-modes'
import type {
  BoardPostsDto,
  CommunityAuthorDto,
  CommunityCommentDto,
  CommunityComposerDto,
  CommunityPostDto,
  CommunityPostSummaryDto,
  CommunityReactionDto,
  CommunityThreadSpaceDto,
} from '../../../shared/types/api'

type BoardRow = typeof boards.$inferSelect
type PostRow = typeof communityPosts.$inferSelect
type CommentRow = typeof communityComments.$inferSelect

// ── 불러오기 ─────────────────────────────────────────────────────────────

async function findBoard(db: DbExecutor, boardId: unknown): Promise<BoardRow> {
  if (!isUuid(boardId)) throw notFound()
  const [board] = await db.select().from(boards).where(eq(boards.id, boardId.toLowerCase())).limit(1)
  if (!board) throw notFound()
  return board
}

async function findPost(db: DbExecutor, postId: unknown, lock = false): Promise<PostRow> {
  if (!isUuid(postId)) throw notFound()
  const query = db.select().from(communityPosts).where(eq(communityPosts.id, postId.toLowerCase())).limit(1)
  const [post] = lock ? await query.for('update') : await query
  if (!post) throw notFound()
  return post
}

async function findComment(db: DbExecutor, commentId: unknown, lock = false): Promise<CommentRow> {
  if (!isUuid(commentId)) throw notFound()
  const query = db.select().from(communityComments).where(eq(communityComments.id, commentId.toLowerCase())).limit(1)
  const [comment] = lock ? await query.for('update') : await query
  if (!comment) throw notFound()
  return comment
}

/** 쓰기 트랜잭션의 첫 잠금: 공간 행 FOR SHARE(방식 변경 예약·worker 적용과 직렬화, ADR 0020). */
async function shareLockSpace(tx: DbExecutor, spaceId: string): Promise<void> {
  await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.id, spaceId)).limit(1).for('share')
}

const boardFacts = (b: BoardRow) => ({ kind: b.kind, writeRole: b.writeRole })

/**
 * 쓰기 공통 전제: 읽을 수 있음(아니면 404) → active 공간(아니면 409) → 이용 제한(C-06, 403 `write_restricted` + 수준·범위·기한) → 자격(아니면 403).
 * 제한 안내에는 어느 글·누구의 요청 때문인지 싣지 않습니다(사유는 본인의 운영 조치 안내에).
 */
function assertWritable(ctx: SpaceContext, allowed: boolean): void {
  if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
  if (ctx.viewer.writeRestriction) throw writeRestricted(ctx.viewer.writeRestriction)
  if (!allowed) throw forbidden('write_not_allowed')
}

/** 지금 쓰면 고정될 방식과 글쓰기 화면 안내. */
async function composerFor(db: DbExecutor, ctx: SpaceContext, board: BoardRow, now: Date, target: 'post' | 'comment'): Promise<CommunityComposerDto> {
  const official = isOfficialKind(ctx.space.row.kind)
  const scheduled = official ? null : await loadScheduledChange(db, ctx.space.row.id)
  const mode: NameMode = official
    ? 'anonymous'
    : effectiveNameMode(ctx.space.row.currentNameMode, scheduled && { status: scheduled.status, toMode: scheduled.toMode, effectiveAt: scheduled.effectiveAt }, now)
  const m = membershipFacts(ctx.membership)
  const allowed =
    target === 'post' ? canWriteBoard(ctx.viewer, ctx.facts, m, boardFacts(board)) : canCommentOnBoard(ctx.viewer, ctx.facts, m, boardFacts(board))
  const [me] = mode === 'real' ? await db.select({ realName: users.realName }).from(users).where(eq(users.id, ctx.viewer.userId)).limit(1) : []
  return {
    canWrite: allowed && ctx.space.row.status === 'active',
    restriction: ctx.viewer.writeRestriction
      ? {
          level: ctx.viewer.writeRestriction.level,
          scope: ctx.viewer.writeRestriction.scope,
          until: ctx.viewer.writeRestriction.until?.toISOString() ?? null,
          message: writeRestrictionText(ctx.viewer.writeRestriction),
        }
      : null,
    nameMode: mode,
    choices: official ? ['anonymous', 'display'] : [mode],
    note: composerNameModeNote(ctx.space.row.kind, mode),
    anonymityNote: official || mode === 'anonymous' ? ANONYMITY_OPERATOR_NOTE : null,
    realNameRequired: mode === 'real' && !me?.realName,
  }
}

// ── 작성자 표시 ──────────────────────────────────────────────────────────

interface ThreadContext {
  ctx: SpaceContext
  now: Date
  authors: Map<string, AuthorProfileBits>
  aliases: Map<string, Map<string, number>>
  bucket: (mode: NameMode) => boolean
}

/** 작성자 재료(읽는 시점의 값). 실명 글이 있는 학교 연결 공간이면 그 학교 인증 여부도. */
async function loadAuthors(db: DbExecutor, ctx: SpaceContext, items: ReadonlyArray<{ authorId: string; nameMode: NameMode }>): Promise<Map<string, AuthorProfileBits>> {
  const ids = [...new Set(items.map((i) => i.authorId))]
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: users.id, status: users.status, purgedAt: users.purgedAt, displayName: users.displayName, realName: users.realName })
    .from(users)
    .where(inArray(users.id, ids))
  const realAuthors = [...new Set(items.filter((i) => i.nameMode === 'real').map((i) => i.authorId))]
  const verified = new Set<string>()
  if (ctx.space.schoolId && realAuthors.length) {
    const aff = await db
      .select({ userId: institutionAffiliations.userId })
      .from(institutionAffiliations)
      .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
      .where(
        and(
          inArray(institutionAffiliations.userId, realAuthors),
          eq(institutionAffiliations.status, 'active'),
          sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${ctx.space.schoolId}`,
        ),
      )
    for (const a of aff) verified.add(a.userId)
  }
  return new Map(
    rows.map((r) => [
      r.id,
      { userId: r.id, status: r.status, purged: r.purgedAt !== null, displayName: r.displayName, realName: r.realName, schoolVerified: verified.has(r.id) },
    ]),
  )
}

async function loadAliases(db: DbExecutor, postIds: string[]): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>()
  if (postIds.length === 0) return out
  const rows = await db.select().from(threadAliases).where(inArray(threadAliases.postId, postIds))
  for (const r of rows) {
    const m = out.get(r.postId) ?? new Map<string, number>()
    m.set(r.userId, r.aliasNo)
    out.set(r.postId, m)
  }
  return out
}

async function threadContext(db: DbExecutor, ctx: SpaceContext, items: ReadonlyArray<{ authorId: string; nameMode: NameMode }>, postIds: string[], now: Date): Promise<ThreadContext> {
  const [authors, aliases] = await Promise.all([loadAuthors(db, ctx, items), loadAliases(db, postIds)])
  // 공식 페이지는 멤버 수를 세지 않습니다(학교 인증 구성원 전체). 사용자 방은 loadSpaceContext가 센 active 멤버 수.
  return { ctx, now, authors, aliases, bucket: (mode) => shouldBucketTimes({ kind: ctx.space.row.kind, activeMembers: ctx.facts.activeMembers }, mode) }
}

function authorOf(tc: ThreadContext, postId: string, item: { authorId: string; nameMode: NameMode; status: CommunityItemStatus }): CommunityAuthorDto {
  const bits = tc.authors.get(item.authorId) ?? { userId: item.authorId, status: 'deleted' as const, purged: true, displayName: '', realName: null }
  const display = resolveAuthorDisplay(item.nameMode, bits, { userId: tc.ctx.viewer.userId })
  return threadAuthorView(display, tc.aliases.get(postId)?.get(item.authorId), isOpenItem(item.status))
}

function timesOf(tc: ThreadContext, item: { nameMode: NameMode; createdAt: Date; editedAt: Date | null }) {
  const bucketed = tc.bucket(item.nameMode)
  return {
    createdAt: bucketed ? null : item.createdAt.toISOString(),
    createdBucket: bucketed ? timeBucket(item.createdAt, tc.now) : null,
    edited: item.editedAt !== null,
    editedAt: bucketed || !item.editedAt ? null : item.editedAt.toISOString(),
  }
}

// ── 공감·개수 ─────────────────────────────────────────────────────────────

async function reactionCounts(db: DbExecutor, target: 'post' | 'comment', ids: string[], viewerId: string): Promise<Map<string, { count: number; mine: boolean }>> {
  const out = new Map<string, { count: number; mine: boolean }>()
  if (ids.length === 0) return out
  const col = target === 'post' ? communityReactions.postId : communityReactions.commentId
  const rows = await db
    .select({ id: col, n: sql<number>`count(*)::int`, mine: sql<boolean>`bool_or(${communityReactions.userId} = ${viewerId})` })
    .from(communityReactions)
    .where(inArray(col, ids))
    .groupBy(col)
  for (const r of rows) if (r.id) out.set(r.id, { count: r.n, mine: !!r.mine })
  return out
}

async function commentCounts(db: DbExecutor, postIds: string[]): Promise<Map<string, number>> {
  if (postIds.length === 0) return new Map()
  const rows = await db
    .select({ postId: communityComments.postId, n: sql<number>`count(*)::int` })
    .from(communityComments)
    .where(and(inArray(communityComments.postId, postIds), eq(communityComments.status, 'published')))
    .groupBy(communityComments.postId)
  return new Map(rows.map((r) => [r.postId, r.n]))
}

// ── DTO ──────────────────────────────────────────────────────────────────

function spaceDto(ctx: SpaceContext): CommunityThreadSpaceDto {
  return {
    slug: ctx.space.row.slug,
    name: ctx.space.row.name,
    kind: ctx.space.row.kind,
    official: isOfficialKind(ctx.space.row.kind),
    status: ctx.space.row.status,
  }
}

function summaryOf(tc: ThreadContext, post: PostRow, comments: number, reactions: number): CommunityPostSummaryDto {
  const open = isOpenItem(post.status)
  return {
    id: post.id,
    boardId: post.boardId,
    status: post.status,
    title: open ? post.title : null,
    placeholder: itemPlaceholder('post', post.status),
    nameMode: post.nameMode,
    author: authorOf(tc, post.id, post),
    ...timesOf(tc, post),
    commentCount: comments,
    reactionCount: reactions,
  }
}

function commentOf(tc: ThreadContext, post: PostRow, c: CommentRow, reactions: { count: number; mine: boolean } | undefined, canComment: boolean): CommunityCommentDto {
  const open = isOpenItem(c.status)
  const mine = c.authorId === tc.ctx.viewer.userId
  const active = tc.ctx.space.row.status === 'active'
  return {
    id: c.id,
    parentId: c.parentCommentId,
    status: c.status,
    body: open ? c.body : null,
    placeholder: itemPlaceholder('comment', c.status),
    nameMode: c.nameMode,
    author: authorOf(tc, post.id, c),
    ...timesOf(tc, c),
    version: c.version,
    reactionCount: reactions?.count ?? 0,
    reacted: reactions?.mine ?? false,
    canEdit: mine && open && active,
    canDelete: mine && c.status !== 'deleted_by_author' && active,
    canReport: !mine && open,
    canReply: open && canComment && c.parentCommentId === null && isOpenItem(post.status),
    canReact: open && !mine && active && canReact(tc.ctx.viewer, tc.ctx.facts, membershipFacts(tc.ctx.membership)),
    accepted: open && post.acceptedCommentId === c.id,
    replies: [],
  }
}

async function postDetail(db: DbExecutor, ctx: SpaceContext, post: PostRow, now: Date): Promise<CommunityPostDto> {
  const [board] = await db.select().from(boards).where(eq(boards.id, post.boardId)).limit(1)
  const comments = await db
    .select()
    .from(communityComments)
    .where(eq(communityComments.postId, post.id))
    .orderBy(asc(communityComments.createdAt), asc(communityComments.id))
    .limit(THREAD_COMMENT_LIMIT)
  const tc = await threadContext(db, ctx, [post, ...comments], [post.id], now)
  const [postReactions, commentReactions, composer] = await Promise.all([
    reactionCounts(db, 'post', [post.id], ctx.viewer.userId),
    reactionCounts(db, 'comment', comments.map((c) => c.id), ctx.viewer.userId),
    composerFor(db, ctx, board!, now, 'comment'),
  ])
  const canComment = composer.canWrite && isOpenItem(post.status)
  const dtos = comments.map((c) => commentOf(tc, post, c, commentReactions.get(c.id), canComment))
  const byId = new Map(dtos.map((d) => [d.id, d]))
  const top: CommunityCommentDto[] = []
  for (const d of dtos) {
    const parent = d.parentId ? byId.get(d.parentId) : undefined
    if (parent) parent.replies.push(d)
    else top.push(d)
  }
  const open = isOpenItem(post.status)
  const mine = post.authorId === ctx.viewer.userId
  const active = ctx.space.row.status === 'active'
  const pr = postReactions.get(post.id)
  const acceptedOpen = post.acceptedCommentId ? dtos.some((d) => d.id === post.acceptedCommentId && d.accepted) : false
  return {
    ...summaryOf(tc, post, dtos.filter((d) => d.status === 'published').length, pr?.count ?? 0),
    body: open ? post.body : null,
    version: post.version,
    reacted: pr?.mine ?? false,
    canEdit: mine && open && active,
    canDelete: mine && post.status !== 'deleted_by_author' && active,
    canReport: !mine && open,
    canReact: open && !mine && active && canReact(ctx.viewer, ctx.facts, membershipFacts(ctx.membership)),
    space: spaceDto(ctx),
    board: { id: board!.id, title: board!.title, kind: board!.kind },
    composer: { ...composer, canWrite: canComment },
    acceptedCommentId: acceptedOpen ? post.acceptedCommentId : null,
    canAccept: mine && open && active && board!.kind === 'question',
    archive: await postArchiveInfo(db, ctx, post, board!.kind, now),
    comments: top,
  }
}

// ── 읽기 ─────────────────────────────────────────────────────────────────

const listQuery = z.object({ cursor: z.uuid({ error: 'invalid' }).optional() })

/**
 * GET /community/boards/:id/posts?cursor= — 최신 글부터 20개. 작성자가 지운 글은 목록에서 빼고, 가린 글은 자리 표시("운영 조치로 가려진 글입니다").
 * cursor는 그 쪽의 마지막 글 id(시각을 담지 않음: 소규모 익명 방의 시각 버킷을 우회하지 못하게). 읽을 수 없으면 404.
 */
export async function listBoardPosts(db: DbExecutor, actor: Actor, boardId: unknown, rawQuery: unknown, now = new Date()): Promise<BoardPostsDto> {
  const { cursor } = parseInput(listQuery, rawQuery ?? {})
  const board = await findBoard(db, boardId)
  const ctx = await loadReadableSpace(db, actor, board.spaceId, false, now)
  let after: { createdAt: Date; id: string } | null = null
  if (cursor) {
    const [row] = await db
      .select({ createdAt: communityPosts.createdAt, id: communityPosts.id })
      .from(communityPosts)
      .where(and(eq(communityPosts.id, cursor.toLowerCase()), eq(communityPosts.boardId, board.id)))
      .limit(1)
    if (!row) throw invalid({ cursor: 'invalid' })
    after = row
  }
  const rows = await db
    .select()
    .from(communityPosts)
    .where(
      and(
        eq(communityPosts.boardId, board.id),
        ne(communityPosts.status, 'deleted_by_author'),
        after ? sql`(${communityPosts.createdAt}, ${communityPosts.id}) < (${after.createdAt.toISOString()}::timestamptz, ${after.id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(communityPosts.createdAt), desc(communityPosts.id))
    .limit(POST_PAGE_SIZE + 1)
  const page = rows.slice(0, POST_PAGE_SIZE)
  const ids = page.map((p) => p.id)
  const [tc, comments, reactions, composer] = await Promise.all([
    threadContext(db, ctx, page, ids, now),
    commentCounts(db, ids),
    reactionCounts(db, 'post', ids, actor.userId),
    composerFor(db, ctx, board, now, 'post'),
  ])
  return {
    space: spaceDto(ctx),
    board: { id: board.id, title: board.title, kind: board.kind, writeRole: board.writeRole },
    composer,
    items: page.map((p) => summaryOf(tc, p, comments.get(p.id) ?? 0, reactions.get(p.id)?.count ?? 0)),
    nextCursor: rows.length > POST_PAGE_SIZE ? page[page.length - 1]!.id : null,
  }
}

/** GET /community/posts/:id — 글 + 댓글(답글 한 단계). 지운 글도 자리 표시와 남은 댓글을 보여 줍니다. 읽을 수 없으면 404. */
export async function getPost(db: DbExecutor, actor: Actor, postId: unknown, now = new Date()): Promise<CommunityPostDto> {
  const post = await findPost(db, postId)
  const ctx = await loadReadableSpace(db, actor, post.spaceId, false, now)
  return postDetail(db, ctx, post, now)
}

// ── 쓰기 ─────────────────────────────────────────────────────────────────

const requestedMode = z.enum(NAME_MODES, { error: 'invalid' }).nullish()

export const createPostSchema = z.object({ title: z.unknown(), body: z.unknown(), nameMode: requestedMode })
export const createCommentSchema = z.object({
  body: z.unknown(),
  parentCommentId: z.uuid({ error: 'invalid' }).nullish(),
  nameMode: requestedMode,
})
export const editPostSchema = z.object({
  title: z.unknown().optional(),
  body: z.unknown().optional(),
  expectedVersion: z.number({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }).int({ error: 'invalid' }).min(1, { error: 'invalid' }),
})
export const editCommentSchema = z.object({
  body: z.unknown(),
  expectedVersion: z.number({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }).int({ error: 'invalid' }).min(1, { error: 'invalid' }),
})

function titleOrThrow(raw: unknown): string {
  const checked = checkPostTitle(raw)
  if (!checked.ok) throw invalid({ title: checked.reason })
  return checked.value
}

function bodyOrThrow(raw: unknown, max: number): string {
  const checked = checkItemBody(raw, max)
  if (!checked.ok) throw invalid({ body: checked.reason })
  return checked.value
}

/**
 * 같은 트랜잭션에서(공간 행 FOR SHARE 잠금 뒤) 고정할 방식. 실명 방식인데 실명이 없으면 403 `real_name_required`(쓰기 전에 입력, ADR 0020).
 * 공식 페이지에서 실명을 고르면 422 `nameMode: real_not_allowed`, 사용자 방에서 공간 방식과 다른 방식을 고르면 422 `nameMode: mode_fixed`.
 */
async function decideNameMode(tx: DbExecutor, ctx: SpaceContext, now: Date, requested: NameMode | null | undefined): Promise<NameMode> {
  const official = isOfficialKind(ctx.space.row.kind)
  const scheduled = official ? null : await loadScheduledChange(tx, ctx.space.row.id)
  const decided = nameModeAtWrite(
    {
      kind: ctx.space.row.kind,
      currentNameMode: ctx.space.row.currentNameMode,
      scheduledChange: scheduled && { status: scheduled.status, toMode: scheduled.toMode, effectiveAt: scheduled.effectiveAt },
    },
    now,
    requested ?? undefined,
  )
  if (!decided.ok) throw invalid({ nameMode: decided.reason })
  if (decided.mode === 'real') {
    const [me] = await tx.select({ realName: users.realName }).from(users).where(eq(users.id, ctx.viewer.userId)).limit(1)
    if (!me?.realName) throw new ServiceError('FORBIDDEN', 'real_name_required', undefined, { requirement: 'real_name' })
  }
  return decided.mode
}

/** 익명으로 쓰면 그 스레드 번호를 정해 넣습니다(글 행을 잠근 트랜잭션 안에서). */
async function ensureAlias(tx: DbExecutor, post: Pick<PostRow, 'id' | 'authorId' | 'nameMode'>, userId: string, writeMode: NameMode, now: Date): Promise<void> {
  const existing = await tx.select({ userId: threadAliases.userId, aliasNo: threadAliases.aliasNo }).from(threadAliases).where(eq(threadAliases.postId, post.id))
  const plan = assignThreadAlias({ existing, userId, postAuthorId: post.authorId, postNameMode: post.nameMode, writeMode })
  if (!plan.insert) return
  await tx.insert(threadAliases).values({ postId: post.id, userId, aliasNo: plan.aliasNo, createdAt: now })
}

async function rateLimitOrThrow(tx: DbExecutor, scope: string, userId: string, rule: { limit: number; windowMs: number }, now: Date) {
  if (!(await hitRateLimit(tx, scope, userId, rule, now))) throw rateLimited()
}

/**
 * POST /community/boards/:id/posts {title, body, nameMode?} — 201 + 글. 401, 403 `write_not_allowed`(공지 게시판은 운영진·모더레이터,
 * 공식 학과 페이지는 같은 학과)·`real_name_required`, 404(읽을 수 없음), 409 `space_not_active`, 422 `title`·`body`·`nameMode`, 429(시간당 10개).
 */
export async function createPost(db: DbExecutor, actor: Actor, boardId: unknown, rawInput: unknown, now = new Date()): Promise<CommunityPostDto> {
  const input = parseInput(createPostSchema, rawInput)
  const title = titleOrThrow(input.title)
  const body = bodyOrThrow(input.body, POST_BODY_MAX)
  const postId = await db.transaction(async (tx) => {
    const board = await findBoard(tx, boardId)
    await shareLockSpace(tx, board.spaceId)
    const ctx = await loadReadableSpace(tx, actor, board.spaceId, false, now)
    assertWritable(ctx, canWriteBoard(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), boardFacts(board)))
    const mode = await decideNameMode(tx, ctx, now, input.nameMode)
    await rateLimitOrThrow(tx, 'community_post_create', actor.userId, POST_RATE_LIMIT, now)
    const [post] = await tx
      .insert(communityPosts)
      .values({ boardId: board.id, spaceId: board.spaceId, authorId: actor.userId, nameMode: mode, title, body, createdAt: now, updatedAt: now })
      .returning()
    await ensureAlias(tx, post!, actor.userId, mode, now)
    await emitAnalytics(tx, { name: 'post_created', actorId: actor.userId, unlinked: mode === 'anonymous', props: { kind: board.kind, mode }, now })
    return post!.id
  })
  return getPost(db, actor, postId, now)
}

/**
 * POST /community/posts/:id/comments {body, parentCommentId?, nameMode?} — 201 + 스레드. 답글은 최상위 댓글에만(422 `parentCommentId: not_top_level`),
 * 지운·가린 글·댓글에는 409 `post_not_open`·`parent_not_open`. 댓글의 방식은 그 댓글을 쓰는 순간의 방식입니다(글의 방식이 아님).
 * 글쓴이에게 새 댓글 알림(글쓴이 자신의 댓글은 제외, 쓴 사람은 싣지 않음). 429(시간당 60개).
 */
export async function createComment(db: DbExecutor, actor: Actor, postId: unknown, rawInput: unknown, now = new Date()): Promise<CommunityPostDto> {
  const input = parseInput(createCommentSchema, rawInput)
  const body = bodyOrThrow(input.body, COMMENT_BODY_MAX)
  const id = await db.transaction(async (tx) => {
    const peek = await findPost(tx, postId)
    await shareLockSpace(tx, peek.spaceId)
    const ctx = await loadReadableSpace(tx, actor, peek.spaceId, false, now)
    // 같은 스레드의 번호를 정하려고 글 행을 잠급니다(공간 다음).
    const post = await findPost(tx, peek.id, true)
    const [board] = await tx.select().from(boards).where(eq(boards.id, post.boardId)).limit(1)
    assertWritable(ctx, canCommentOnBoard(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), boardFacts(board!)))
    if (!isOpenItem(post.status)) throw conflict('post_not_open')
    let parentId: string | null = null
    if (input.parentCommentId) {
      const [parent] = await tx
        .select()
        .from(communityComments)
        .where(and(eq(communityComments.id, input.parentCommentId.toLowerCase()), eq(communityComments.postId, post.id)))
        .limit(1)
      if (!parent) throw invalid({ parentCommentId: 'invalid' })
      if (parent.parentCommentId) throw invalid({ parentCommentId: 'not_top_level' })
      if (!isOpenItem(parent.status)) throw conflict('parent_not_open')
      parentId = parent.id
    }
    const mode = await decideNameMode(tx, ctx, now, input.nameMode)
    await rateLimitOrThrow(tx, 'community_comment_create', actor.userId, COMMENT_RATE_LIMIT, now)
    await tx
      .insert(communityComments)
      .values({ postId: post.id, parentCommentId: parentId, authorId: actor.userId, nameMode: mode, body, createdAt: now, updatedAt: now })
    await ensureAlias(tx, post, actor.userId, mode, now)
    if (post.authorId !== actor.userId) await notifyPostAuthor(tx, post, now)
    await emitAnalytics(tx, { name: 'comment_created', actorId: actor.userId, unlinked: mode === 'anonymous', props: { mode, reply: parentId !== null }, now })
    return post.id
  })
  return getPost(db, actor, id, now)
}

/** 글쓴이에게 "새 댓글" 알림. 읽지 않은 알림이 있으면 개수만 올립니다(글·사람마다 한 행). 댓글 쓴 사람·내용은 넣지 않습니다. */
async function notifyPostAuthor(tx: DbExecutor, post: PostRow, now: Date): Promise<void> {
  await tx.execute(sql`
    insert into community_notices (user_id, space_id, kind, post_id, payload, created_at)
    select u.id, ${post.spaceId}, 'post_commented', ${post.id}, '{"count":1}'::jsonb, ${now.toISOString()}::timestamptz
    from users u where u.id = ${post.authorId} and u.status = 'active'
    on conflict (post_id, user_id, kind) where post_id is not null and read_at is null
    do update set payload = jsonb_build_object('count', least(coalesce((community_notices.payload->>'count')::int, 0) + 1, 999)), created_at = excluded.created_at`)
}

/**
 * PATCH /community/posts/:id {title?, body?, expectedVersion} — 본인 글만(아니면 403), 게시 중인 글만(409 `not_open`), version이 다르면
 * 409 `version_conflict`(+currentVersion). 이름 표시 방식(name_mode)은 바꾸지 않습니다(고정, DB 트리거).
 */
export async function editPost(db: DbExecutor, actor: Actor, postId: unknown, rawInput: unknown, now = new Date()): Promise<CommunityPostDto> {
  const input = parseInput(editPostSchema, rawInput)
  const title = input.title === undefined ? undefined : titleOrThrow(input.title)
  const body = input.body === undefined ? undefined : bodyOrThrow(input.body, POST_BODY_MAX)
  const id = await db.transaction(async (tx) => {
    const peek = await findPost(tx, postId)
    await shareLockSpace(tx, peek.spaceId)
    const ctx = await loadReadableSpace(tx, actor, peek.spaceId)
    const post = await findPost(tx, peek.id, true)
    ownChangeOrThrow(canChangeOwnItem(post, actor.userId, ctx.space.row.status, 'edit'))
    if (post.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: post.version })
    if (title === undefined && body === undefined) return post.id
    await tx
      .update(communityPosts)
      .set({ ...(title !== undefined && { title }), ...(body !== undefined && { body }), editedAt: now, updatedAt: now, version: post.version + 1 })
      .where(and(eq(communityPosts.id, post.id), eq(communityPosts.version, post.version)))
    return post.id
  })
  return getPost(db, actor, id, now)
}

function ownChangeOrThrow(check: ReturnType<typeof canChangeOwnItem>): void {
  if (check === 'not_author') throw forbidden('not_author')
  if (check === 'not_open') throw conflict('not_open')
  if (check === 'space_not_active') throw conflict('space_not_active')
}

/**
 * DELETE /community/posts/:id — 본인 글 지우기(행은 남기고 제목·본문을 비움, 스레드 번호·댓글 유지). 가린 글도 스스로 지울 수 있습니다.
 * 이미 지웠으면 409 `not_open`. 그 글의 공감은 지웁니다(개수만 있던 것).
 */
export async function deletePost(db: DbExecutor, actor: Actor, postId: unknown, now = new Date()): Promise<CommunityPostDto> {
  const id = await db.transaction(async (tx) => {
    const peek = await findPost(tx, postId)
    await shareLockSpace(tx, peek.spaceId)
    const ctx = await loadReadableSpace(tx, actor, peek.spaceId)
    const post = await findPost(tx, peek.id, true)
    ownChangeOrThrow(canChangeOwnItem(post, actor.userId, ctx.space.row.status, 'delete'))
    await tx
      .update(communityPosts)
      .set({ status: 'deleted_by_author', title: '', body: '', deletedAt: now, updatedAt: now, version: post.version + 1 })
      .where(eq(communityPosts.id, post.id))
    await tx.delete(communityReactions).where(eq(communityReactions.postId, post.id))
    // 지운 글은 옮길 수 없습니다(C-09): 이 글의 진행 중 옮기기를 취소합니다.
    await cancelTransfersForSourceInTx(tx, { postId: post.id }, 'source_unavailable', now, actor.userId)
    return post.id
  })
  return getPost(db, actor, id, now)
}

/** PATCH /community/comments/:id {body, expectedVersion} — 글 고치기와 같은 규칙. 200 + 스레드. */
export async function editComment(db: DbExecutor, actor: Actor, commentId: unknown, rawInput: unknown, now = new Date()): Promise<CommunityPostDto> {
  const input = parseInput(editCommentSchema, rawInput)
  const body = bodyOrThrow(input.body, COMMENT_BODY_MAX)
  const id = await db.transaction(async (tx) => {
    const peek = await findComment(tx, commentId)
    const post = await findPost(tx, peek.postId)
    await shareLockSpace(tx, post.spaceId)
    const ctx = await loadReadableSpace(tx, actor, post.spaceId)
    const comment = await findComment(tx, peek.id, true)
    ownChangeOrThrow(canChangeOwnItem(comment, actor.userId, ctx.space.row.status, 'edit'))
    if (comment.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: comment.version })
    await tx
      .update(communityComments)
      .set({ body, editedAt: now, updatedAt: now, version: comment.version + 1 })
      .where(and(eq(communityComments.id, comment.id), eq(communityComments.version, comment.version)))
    return post.id
  })
  return getPost(db, actor, id, now)
}

/** DELETE /community/comments/:id — 본인 댓글 지우기(행·번호·답글 유지, 본문 비움). 200 + 스레드. */
export async function deleteComment(db: DbExecutor, actor: Actor, commentId: unknown, now = new Date()): Promise<CommunityPostDto> {
  const id = await db.transaction(async (tx) => {
    const peek = await findComment(tx, commentId)
    const post = await findPost(tx, peek.postId)
    await shareLockSpace(tx, post.spaceId)
    const ctx = await loadReadableSpace(tx, actor, post.spaceId)
    const comment = await findComment(tx, peek.id, true)
    ownChangeOrThrow(canChangeOwnItem(comment, actor.userId, ctx.space.row.status, 'delete'))
    await tx
      .update(communityComments)
      .set({ status: 'deleted_by_author', body: '', deletedAt: now, updatedAt: now, version: comment.version + 1 })
      .where(eq(communityComments.id, comment.id))
    await tx.delete(communityReactions).where(eq(communityReactions.commentId, comment.id))
    // 지운 답변은 옮길 수 없습니다(C-09).
    await cancelTransfersForSourceInTx(tx, { commentId: comment.id }, 'source_unavailable', now, actor.userId)
    return post.id
  })
  return getPost(db, actor, id, now)
}

// ── 채택된 답변(C-09) ─────────────────────────────────────────────────────

export const acceptAnswerSchema = z.object({ commentId: z.uuid({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }) })

/**
 * PUT /community/posts/:id/accepted-answer {commentId} — 질문 게시판 글의 글쓴이만(403 `not_author`). 이 글의 게시 중인 최상위 댓글 하나를 채택합니다
 * (바꾸면 이전 채택은 풀림). 409 `not_question_board`·`not_open`·`space_not_active`·`comment_not_open`, 422 `commentId: invalid|not_top_level`.
 * 채택이 바뀌면 이전 답변을 옮기던 진행 중 요청은 취소됩니다. 글의 version은 올리지 않습니다(내용 변경이 아님). 200 + 스레드.
 */
export async function setAcceptedAnswer(db: DbExecutor, actor: Actor, postId: unknown, rawInput: unknown, now = new Date()): Promise<CommunityPostDto> {
  const input = rawInput === null ? null : parseInput(acceptAnswerSchema, rawInput)
  const id = await db.transaction(async (tx) => {
    const peek = await findPost(tx, postId)
    await shareLockSpace(tx, peek.spaceId)
    const ctx = await loadReadableSpace(tx, actor, peek.spaceId, false, now)
    const post = await findPost(tx, peek.id, true)
    if (post.authorId !== actor.userId) throw forbidden('not_author')
    const [board] = await tx.select({ kind: boards.kind }).from(boards).where(eq(boards.id, post.boardId)).limit(1)
    if (board?.kind !== 'question') throw conflict('not_question_board')
    if (!isOpenItem(post.status)) throw conflict('not_open')
    if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
    let commentId: string | null = null
    if (input) {
      const [comment] = await tx
        .select()
        .from(communityComments)
        .where(and(eq(communityComments.id, input.commentId.toLowerCase()), eq(communityComments.postId, post.id)))
        .limit(1)
      if (!comment) throw invalid({ commentId: 'invalid' })
      if (comment.parentCommentId) throw invalid({ commentId: 'not_top_level' })
      if (!isOpenItem(comment.status)) throw conflict('comment_not_open')
      commentId = comment.id
    }
    if (post.acceptedCommentId === commentId) return post.id
    await tx.update(communityPosts).set({ acceptedCommentId: commentId, updatedAt: now }).where(eq(communityPosts.id, post.id))
    await cancelTransfersForAnswerChangeInTx(tx, post.id, commentId, now, actor.userId)
    return post.id
  })
  return getPost(db, actor, id, now)
}

// ── 공감 ─────────────────────────────────────────────────────────────────

/**
 * PUT|DELETE /community/posts/:id/reaction, /community/comments/:id/reaction — 공감 켜기·끄기(사람마다 한 번, 두 번 켜도 하나).
 * 응답은 개수와 내가 눌렀는지만(누가 눌렀는지는 어디에도 없음). 자기 글 409 `own_item`, 지운·가린 대상 409 `target_not_open`,
 * 보관·제한된 공간 409 `space_not_active`, 읽을 수 없으면 404.
 */
export async function setReaction(
  db: DbExecutor,
  actor: Actor,
  target: 'post' | 'comment',
  targetId: unknown,
  on: boolean,
  now = new Date(),
): Promise<CommunityReactionDto> {
  return db.transaction(async (tx) => {
    const item = target === 'post' ? await findPost(tx, targetId) : await findComment(tx, targetId)
    const spaceId = target === 'post' ? (item as PostRow).spaceId : (await findPost(tx, (item as CommentRow).postId)).spaceId
    const ctx = await loadReadableSpace(tx, actor, spaceId, false, now)
    if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
    if (ctx.viewer.writeRestriction) throw writeRestricted(ctx.viewer.writeRestriction)
    if (!canReact(ctx.viewer, ctx.facts, membershipFacts(ctx.membership))) throw forbidden('write_not_allowed')
    if (item.authorId === actor.userId) throw conflict('own_item')
    if (!isOpenItem(item.status)) throw conflict('target_not_open')
    const where =
      target === 'post'
        ? and(eq(communityReactions.postId, item.id), eq(communityReactions.userId, actor.userId))
        : and(eq(communityReactions.commentId, item.id), eq(communityReactions.userId, actor.userId))
    if (on) {
      try {
        const inserted = await tx.transaction(async (sp) =>
          sp
            .insert(communityReactions)
            .values({ ...(target === 'post' ? { postId: item.id } : { commentId: item.id }), userId: actor.userId, kind: 'empathy', createdAt: now })
            .onConflictDoNothing()
            .returning({ id: communityReactions.id }),
        )
        if (inserted.length) await emitAnalytics(tx, { name: 'reaction_added', actorId: actor.userId, unlinked: item.nameMode === 'anonymous', props: { target }, now })
      } catch (error) {
        if (sqlState(error) !== '23505') throw error
      }
    } else {
      await tx.delete(communityReactions).where(where)
    }
    const counts = await reactionCounts(tx, target, [item.id], actor.userId)
    return { count: counts.get(item.id)?.count ?? 0, reacted: counts.get(item.id)?.mine ?? false }
  })
}

// ── 신고·운영 조치·탈퇴 정리용(reporting.ts가 씀) ─────────────────────────

/** 신고 대상 글: 신고자가 읽을 수 있는 게시 중인 글(아니면 404). */
export async function reportablePost(db: DbExecutor, actor: Actor, postId: unknown): Promise<PostRow> {
  const post = await findPost(db, postId)
  await loadReadableSpace(db, actor, post.spaceId)
  if (!isOpenItem(post.status)) throw notFound()
  return post
}

/** 신고 대상 댓글: 신고자가 읽을 수 있는 게시 중인 댓글(아니면 404). */
export async function reportableComment(db: DbExecutor, actor: Actor, commentId: unknown): Promise<CommentRow> {
  const comment = await findComment(db, commentId)
  const post = await findPost(db, comment.postId)
  await loadReadableSpace(db, actor, post.spaceId)
  if (!isOpenItem(comment.status)) throw notFound()
  return comment
}

/** 글·댓글이 하나라도 있는 공간 id(운영자 화면 묶음용). */
export async function spaceIdsOfItems(db: DbExecutor, postIds: string[], commentIds: string[]): Promise<{ posts: Map<string, string>; comments: Map<string, string> }> {
  const posts = new Map<string, string>()
  const comments = new Map<string, string>()
  if (postIds.length) for (const r of await db.select({ id: communityPosts.id, spaceId: communityPosts.spaceId }).from(communityPosts).where(inArray(communityPosts.id, postIds))) posts.set(r.id, r.spaceId)
  if (commentIds.length) {
    const rows = await db
      .select({ id: communityComments.id, postId: communityComments.postId, spaceId: communityPosts.spaceId })
      .from(communityComments)
      .innerJoin(communityPosts, eq(communityPosts.id, communityComments.postId))
      .where(inArray(communityComments.id, commentIds))
    for (const r of rows) comments.set(r.id, r.spaceId)
  }
  return { posts, comments }
}

