/**
 * 커뮤니티 공간 신고·조치용 읽기 (C-02, SYSTEM_DESIGN §6.7 "Report 확장"·§8.1, ADR 0015·0019).
 *
 * 신고·운영 조치 모듈(moderation)은 커뮤니티 테이블을 직접 읽지 않고 이 함수들을 부릅니다.
 * - 신고 대상: 신고자가 읽을 수 있거나(canReadSpace) 소개를 볼 수 있는(canPreviewSpace) 공간만. 아니면 404(존재를 숨김).
 * - 운영자 화면에는 공간 정보(이름·소개·종류·상태·멤버 수)만 싣습니다. 게시판·멤버 목록·글은 싣지 않습니다.
 * - 조치 당사자(이의제기·안내)는 그 사용자 방의 active owner입니다. 공식 페이지는 운영자가 운영하므로 당사자가 없습니다.
 * - 글·댓글(C-04): 신고자가 읽을 수 있는 게시 중인 것만 신고 대상(아니면 404). 운영자는 그 글·댓글 하나만 보고(작성자 id 없음, 익명은 `익명`),
 *   조치는 가리기(hide_post·hide_comment, 삭제 아님)이며 되돌리면 다시 보입니다. 당사자는 작성자입니다.
 */
import { canPreviewSpace, canReadSpace, isSpaceSlug, resolveAuthorDisplay } from '@peerchive/domain'
import { and, communityComments, communityPosts, communitySpaces, eq, inArray, spaceMemberships, users, type DbExecutor } from '@peerchive/db'
import { type Actor, conflict, invalid, notFound } from '../errors'
import { isUuid } from '../projects/access'
import { loadSpace, loadSpaceContext, membershipFacts } from './access'
import { toOperatorSpaceDto } from './official'
import { reportableComment, reportablePost, spaceIdsOfItems } from './posts'
import { memberCounts } from './spaces'
import type { OperatorCommunityItemDto, OperatorSpaceDto } from '../../../shared/types/api'

/** 신고 대상 `{spaceSlug}` → 공간 id. 형식이 틀리면 422 `targetRef.spaceSlug`, 볼 수 없으면 404. */
export async function resolveReportableSpace(db: DbExecutor, actor: Actor, rawRef: unknown): Promise<string> {
  const slug = (rawRef as { spaceSlug?: unknown } | null)?.spaceSlug
  if (!isSpaceSlug(slug)) throw invalid({ 'targetRef.spaceSlug': 'invalid' })
  const ctx = await loadSpaceContext(db, actor, slug)
  const m = membershipFacts(ctx.membership)
  if (!canReadSpace(ctx.viewer, ctx.facts, m) && !canPreviewSpace(ctx.viewer, ctx.facts, m)) throw notFound()
  return ctx.space.row.id
}

/** 공간 id → 이름(운영자·신고자·당사자 화면의 대상 표시). */
export async function communitySpaceLabels(db: DbExecutor, ids: readonly string[]): Promise<Map<string, { name: string; slug: string }>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: communitySpaces.id, name: communitySpaces.name, slug: communitySpaces.slug }).from(communitySpaces).where(inArray(communitySpaces.id, [...ids]))
  return new Map(rows.map((r) => [r.id, { name: r.name, slug: r.slug }]))
}

/** 조치 당사자: 사용자 방·스터디 방의 active owner. */
export async function communitySpaceOwnerIds(db: DbExecutor, spaceId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: spaceMemberships.userId })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.role, 'owner'), eq(spaceMemberships.status, 'active')))
  return rows.map((r) => r.userId)
}

/** 운영자 신고 상세의 공간 정보. 없으면 null. */
export async function operatorSpaceContent(db: DbExecutor, spaceId: string): Promise<OperatorSpaceDto | null> {
  try {
    const space = await loadSpace(db, spaceId)
    return toOperatorSpaceDto(space, (await memberCounts(db, [space.row.id])).get(space.row.id) ?? 0)
  } catch (error) {
    if ((error as { code?: string }).code === 'NOT_FOUND') return null
    throw error
  }
}

// ── 글·댓글 신고·가리기(C-04, ADR 0022) ──────────────────────────────────

const itemRef = (raw: unknown, key: 'postId' | 'commentId'): string => {
  const value = (raw as Record<string, unknown> | null)?.[key]
  if (!isUuid(value)) throw invalid({ [`targetRef.${key}`]: 'invalid' })
  return value.toLowerCase()
}

/** 신고 대상 `{postId}` → 글 id. 신고자가 읽을 수 있는 게시 중인 글만(아니면 404), 형식이 틀리면 422. */
export async function resolveReportablePost(db: DbExecutor, actor: Actor, rawRef: unknown): Promise<string> {
  return (await reportablePost(db, actor, itemRef(rawRef, 'postId'))).id
}

/** 신고 대상 `{commentId}` → 댓글 id. 신고자가 읽을 수 있는 게시 중인 댓글만(아니면 404). */
export async function resolveReportableComment(db: DbExecutor, actor: Actor, rawRef: unknown): Promise<string> {
  return (await reportableComment(db, actor, itemRef(rawRef, 'commentId'))).id
}

/** 글·댓글 id → 그 공간 이름(대상 표시 "커뮤니티 글 · 공간"). 제목·본문은 싣지 않습니다. */
export async function communityItemLabels(db: DbExecutor, postIds: readonly string[], commentIds: readonly string[]): Promise<Map<string, string>> {
  const { posts, comments } = await spaceIdsOfItems(db, [...postIds], [...commentIds])
  const names = await communitySpaceLabels(db, [...new Set([...posts.values(), ...comments.values()])])
  const out = new Map<string, string>()
  for (const [id, spaceId] of [...posts, ...comments]) out.set(id, names.get(spaceId)?.name ?? '공간')
  return out
}

/** 조치 당사자: 글·댓글의 작성자(이의제기·안내). 익명 글이어도 본인에게만 쓰입니다. */
export async function communityItemAuthorIds(db: DbExecutor, target: { postId?: string | null; commentId?: string | null }): Promise<string[]> {
  if (target.postId) {
    const [row] = await db.select({ authorId: communityPosts.authorId }).from(communityPosts).where(eq(communityPosts.id, target.postId)).limit(1)
    return row ? [row.authorId] : []
  }
  if (target.commentId) {
    const [row] = await db.select({ authorId: communityComments.authorId }).from(communityComments).where(eq(communityComments.id, target.commentId)).limit(1)
    return row ? [row.authorId] : []
  }
  return []
}

/**
 * 운영자 신고 상세의 글·댓글: 지금 행(가린 글도 본문 포함 — 이의제기 판단용), 공간 이름, 작성자 표시(익명은 `익명`). 작성자 id는 없습니다.
 * 지운 글은 본문이 비어 있습니다. 없으면 null.
 */
export async function operatorCommunityItem(db: DbExecutor, target: { postId?: string | null; commentId?: string | null }): Promise<OperatorCommunityItemDto | null> {
  let post: typeof communityPosts.$inferSelect | undefined
  let comment: typeof communityComments.$inferSelect | undefined
  if (target.commentId) {
    ;[comment] = await db.select().from(communityComments).where(eq(communityComments.id, target.commentId)).limit(1)
    if (!comment) return null
    ;[post] = await db.select().from(communityPosts).where(eq(communityPosts.id, comment.postId)).limit(1)
  } else if (target.postId) {
    ;[post] = await db.select().from(communityPosts).where(eq(communityPosts.id, target.postId)).limit(1)
  }
  if (!post) return null
  const item = comment ?? post
  const [space] = await db.select({ slug: communitySpaces.slug, name: communitySpaces.name, kind: communitySpaces.kind }).from(communitySpaces).where(eq(communitySpaces.id, post.spaceId)).limit(1)
  const [author] = await db
    .select({ id: users.id, status: users.status, purgedAt: users.purgedAt, displayName: users.displayName, realName: users.realName })
    .from(users)
    .where(eq(users.id, item.authorId))
    .limit(1)
  const display = resolveAuthorDisplay(
    item.nameMode,
    { userId: item.authorId, status: author?.status ?? 'deleted', purged: !author || author.purgedAt !== null, displayName: author?.displayName ?? '', realName: author?.realName ?? null },
    null,
  )
  return {
    space: { slug: space!.slug, name: space!.name, kind: space!.kind },
    postId: post.id,
    title: comment ? null : post.title || null,
    body: item.body || null,
    status: item.status,
    nameMode: item.nameMode,
    authorLabel: display.label ?? '익명',
    createdAt: item.createdAt.toISOString(),
    edited: item.editedAt !== null,
  }
}

/** 운영 조치 hide_post·hide_comment(트랜잭션 안): 게시 중(또는 자동 숨김)인 것만 hidden으로. 아니면 409 `target_not_public`. 본문은 남깁니다. */
export async function hideCommunityItemInTx(tx: DbExecutor, target: 'post' | 'comment', id: string, now: Date): Promise<void> {
  const table = target === 'post' ? communityPosts : communityComments
  const [row] = await tx.select({ id: table.id, status: table.status }).from(table).where(eq(table.id, id)).limit(1).for('update')
  if (!row) throw notFound()
  if (row.status !== 'published' && row.status !== 'auto_hidden') throw conflict('target_not_public')
  await tx.update(table).set({ status: 'hidden', updatedAt: now }).where(eq(table.id, id))
}

/** 가리기 되돌림(이의제기 reverse): 지금 hidden일 때만 published로(작성자가 지웠거나 탈퇴 정리됐으면 그대로). */
export async function unhideCommunityItemInTx(tx: DbExecutor, target: 'post' | 'comment', id: string, now: Date): Promise<void> {
  const table = target === 'post' ? communityPosts : communityComments
  await tx.update(table).set({ status: 'published', updatedAt: now }).where(and(eq(table.id, id), eq(table.status, 'hidden')))
}
