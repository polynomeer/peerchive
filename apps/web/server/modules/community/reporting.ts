/**
 * 커뮤니티 공간 신고·조치용 읽기 (C-02, SYSTEM_DESIGN §6.7 "Report 확장"·§8.1, ADR 0015·0019).
 *
 * 신고·운영 조치 모듈(moderation)은 커뮤니티 테이블을 직접 읽지 않고 이 함수들을 부릅니다.
 * - 신고 대상: 신고자가 읽을 수 있거나(canReadSpace) 소개를 볼 수 있는(canPreviewSpace) 공간만. 아니면 404(존재를 숨김).
 * - 운영자 화면에는 공간 정보(이름·소개·종류·상태·멤버 수)만 싣습니다. 게시판·멤버 목록·글은 싣지 않습니다.
 * - 조치 당사자(이의제기·안내)는 그 사용자 방의 active owner입니다. 공식 페이지는 운영자가 운영하므로 당사자가 없습니다.
 * - 글·댓글(C-04): 신고자가 읽을 수 있는 게시 중인 것만 신고 대상(아니면 404). 운영자는 그 글·댓글 하나만 보고(작성자 id 없음, 익명은 `익명`),
 *   조치는 가리기(hide_post·hide_comment, 삭제 아님)이며 되돌리면 다시 보입니다. 당사자는 작성자입니다.
 * - C-06(ADR 0023): 신고 저장 뒤 임시 숨김 판정(applyReportThresholdInTx), 조치 없이 닫을 때 복원, 대기열 우선순위용 상태, 방 운영진 가리기·제재의
 *   되돌림을 moderation.ts에서 다시 내보냅니다.
 */
import { canPreviewSpace, canReadSpace, isSpaceSlug } from '@peerchive/domain'
import { and, communityComments, communityPosts, communitySpaces, eq, inArray, spaceMemberships, type DbExecutor } from '@peerchive/db'
import { type Actor, invalid, notFound } from '../errors'
import { isUuid } from '../projects/access'
import { loadSpace, loadSpaceContext, membershipFacts } from './access'
import { toOperatorSpaceDto } from './official'
import { reportableComment, reportablePost, spaceIdsOfItems } from './posts'
import { memberCounts } from './spaces'
import type { OperatorSpaceDto } from '../../../shared/types/api'

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

// ── C-06(ADR 0023): 임시 숨김·가리기 효과·제재 되돌림 — moderation 모듈은 이 어댑터만 부릅니다 ──────────

export {
  applyReportThresholdInTx,
  communityItemStatuses,
  hideCommunityItemInTx,
  operatorCommunityItem,
  restoreAutoHiddenInTx,
  revokeSanctionByActionInTx,
  unhideCommunityItemInTx,
} from './moderation'

// ── C-07(ADR 0024): 모집 글·지원 메시지 신고·가리기 — moderation 모듈은 이 어댑터만 부릅니다 ──────────

export {
  hideRecruitmentItemInTx,
  operatorRecruitmentItem,
  recruitmentItemLabels,
  recruitmentItemPartyIds,
  recruitmentItemVisible,
  reportableApplication as resolveReportableApplication,
  reportableRecruitment as resolveReportableRecruitment,
  unhideRecruitmentItemInTx,
} from './recruitments'

// ── A-07(ADR 0045): 동문회·OB 방 항목(명부 항목·일정·투표·앨범 사진·방별 프로필) 신고·숨김 — moderation 모듈은 이 어댑터만 부릅니다 ──────────

export {
  hideRoomItemInTx,
  operatorRoomItem,
  resolveReportableRoomItem,
  roomItemKindOf,
  roomItemLabels,
  roomItemOwnerIds,
  roomItemVisible,
  unhideRoomItemInTx,
} from './room-item-reports'
