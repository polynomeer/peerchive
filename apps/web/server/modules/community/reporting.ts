/**
 * 커뮤니티 공간 신고·조치용 읽기 (C-02, SYSTEM_DESIGN §6.7 "Report 확장"·§8.1, ADR 0015·0019).
 *
 * 신고·운영 조치 모듈(moderation)은 커뮤니티 테이블을 직접 읽지 않고 이 함수들을 부릅니다.
 * - 신고 대상: 신고자가 읽을 수 있거나(canReadSpace) 소개를 볼 수 있는(canPreviewSpace) 공간만. 아니면 404(존재를 숨김).
 * - 운영자 화면에는 공간 정보(이름·소개·종류·상태·멤버 수)만 싣습니다. 게시판·멤버 목록·글은 싣지 않습니다.
 * - 조치 당사자(이의제기·안내)는 그 사용자 방의 active owner입니다. 공식 페이지는 운영자가 운영하므로 당사자가 없습니다.
 */
import { canPreviewSpace, canReadSpace, isSpaceSlug } from '@peerchive/domain'
import { and, communitySpaces, eq, inArray, spaceMemberships, type DbExecutor } from '@peerchive/db'
import { type Actor, invalid, notFound } from '../errors'
import { loadSpace, loadSpaceContext, membershipFacts } from './access'
import { toOperatorSpaceDto } from './official'
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
