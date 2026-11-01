/**
 * 동문회·OB 방 운영진 공지의 읽음 표시 (A-02, SYSTEM_DESIGN §6.7.2 NoticeRead·§8.4 "공지 읽음 확인: 읽음 수만", DELIVERY_PLAN §5.3 W, ADR 0039).
 *
 * - 대상: alumni 방(플래그 켜짐)의 **공지 게시판**(`notice`, 쓰기는 모더레이터 이상) 글 중 게시 중인 글. 그 밖의 글은 404·표시 없음.
 * - `POST /community/posts/:id/read` — 방 active 멤버가 읽었다고 표시(멱등, (글, 사람) 하나). 글을 연 화면이 부릅니다.
 * - 응답은 **읽음 수와 내가 읽었는지만**입니다. 누가 읽었는지는 방장·운영진·글쓴이·운영자 누구에게도 내보내지 않고, 그런 API도 없습니다.
 *   행에는 (글, 사람)이 있지만 "내가 읽었는지"와 중복 방지에만 씁니다.
 * - 방을 나가거나 내보내지거나 탈퇴하면 그 사람의 표시를 지웁니다(읽음 수가 그만큼 줄어듦). 플래그가 꺼지면 경로 404, 글에 읽음 수 없음.
 */
import { tracksNoticeReads } from '@peerchive/domain'
import { and, boards, communityPosts, eq, noticeReads, type DbExecutor } from '@peerchive/db'
import { type Actor, notFound } from '../errors'
import { requireFeature } from '../features'
import { type SpaceContext, loadReadableSpace } from './access'
import { countAll, uuidOr404 } from './alumni-room'
import { effectiveTemplate } from './room-profiles'
import type { NoticeReadsDto } from '../../../shared/types/api'

async function readsFor(db: DbExecutor, postId: string, viewerId: string): Promise<NoticeReadsDto> {
  const [{ n }] = (await db.select({ n: countAll }).from(noticeReads).where(eq(noticeReads.postId, postId))) as [{ n: number }]
  const [mine] = await db
    .select({ postId: noticeReads.postId })
    .from(noticeReads)
    .where(and(eq(noticeReads.postId, postId), eq(noticeReads.userId, viewerId)))
    .limit(1)
  return { count: n, readByMe: !!mine }
}

/** 글 상세(posts.ts)용: 읽음을 세는 글이면 읽음 수, 아니면 undefined. 읽음 표시는 하지 않습니다(GET에 부수 효과 없음). */
export async function noticeReadsForPost(db: DbExecutor, ctx: SpaceContext, post: { id: string; status: string }, boardKind: string): Promise<NoticeReadsDto | undefined> {
  if (!tracksNoticeReads(effectiveTemplate(ctx.space.row), boardKind) || ctx.space.row.kind !== 'user_room') return undefined
  if (ctx.membership?.status !== 'active') return undefined
  return readsFor(db, post.id, ctx.viewer.userId)
}

/**
 * POST /community/posts/:id/read — 읽었다고 표시(멱등). 200 + `{count, readByMe: true}`. 플래그 꺼짐·alumni 방이 아님·공지 게시판이 아님·
 * 게시 중이 아님·방 active 멤버가 아님은 모두 404. 보관된 방에서도 표시할 수 있습니다(읽기는 쓰기가 아님).
 */
export async function markNoticeRead(db: DbExecutor, actor: Actor, postId: unknown, now = new Date()): Promise<NoticeReadsDto> {
  requireFeature('alumni')
  const id = uuidOr404(postId)
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ post: communityPosts, boardKind: boards.kind })
      .from(communityPosts)
      .innerJoin(boards, eq(boards.id, communityPosts.boardId))
      .where(eq(communityPosts.id, id))
      .limit(1)
    if (!found) throw notFound()
    const ctx = await loadReadableSpace(tx, actor, found.post.spaceId, false, now)
    if (ctx.membership?.status !== 'active' || ctx.space.row.kind !== 'user_room') throw notFound()
    if (!tracksNoticeReads(effectiveTemplate(ctx.space.row), found.boardKind) || found.post.status !== 'published') throw notFound()
    await tx.insert(noticeReads).values({ postId: id, userId: actor.userId, spaceId: ctx.space.row.id, readAt: now }).onConflictDoNothing()
    return readsFor(tx, id, actor.userId)
  })
}
