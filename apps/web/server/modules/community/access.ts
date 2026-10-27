/**
 * 커뮤니티 접근 판정의 재료(C-02, SYSTEM_DESIGN §6.7·§8.1·§8.2, ADR 0019).
 *
 * 이 모듈(server/modules/community)만 커뮤니티 테이블(community_spaces·space_memberships·boards·space_invitations·official_page_requests)을
 * 읽고 씁니다. 공개 조회 모듈(publication/public-*, course-hub, portfolio, search)은 이 모듈을 import하지 않습니다
 * (test/community.integration.test.ts가 소스로 확인). 권한 판정은 모두 @peerchive/domain의 정책 함수(canReadSpace·canJoinSpace·
 * canWriteBoard·canModerate·canManageSpace)를 거칩니다.
 *
 * 학교는 정본으로 비교합니다: 공간·소속이 병합 전 학교를 가리켜도 coalesce(merged_into, id)로 읽습니다.
 */
import {
  type CommunityViewer,
  type MembershipFacts,
  type SpaceFacts,
  type WriteRestriction,
  activeWriteRestriction,
  canReadSpace,
  departmentKey,
  isOfficialKind,
  isSpaceSlug,
} from '@peerchive/domain'
import {
  and,
  communitySanctions,
  communitySpaces,
  eq,
  isNull,
  institutionAffiliations,
  schools,
  spaceMemberships,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { isOperator } from '../catalog/operators'
import { type Actor, ServiceError, notFound } from '../errors'
import { isUuid } from '../projects/access'

export type SpaceRow = typeof communitySpaces.$inferSelect
export type MembershipRow = typeof spaceMemberships.$inferSelect

export type LoadedViewer = CommunityViewer & {
  schools: Array<{ id: string; name: string; departmentLabel: string | null }>
  /** 판정하는 공간 기준으로 지금 쓰기를 막는 제재(C-06). 본인의 응답(글쓰기 안내)에만 씁니다. */
  writeRestriction: WriteRestriction | null
}

/** 되돌리지 않은 제재(C-06). 효력(기한·범위)은 @peerchive/domain activeWriteRestriction이 판정합니다. */
async function loadOpenSanctions(db: DbExecutor, userId: string) {
  return db
    .select({ scope: communitySanctions.scope, spaceId: communitySanctions.spaceId, level: communitySanctions.level, until: communitySanctions.until, revokedAt: communitySanctions.revokedAt })
    .from(communitySanctions)
    .where(and(eq(communitySanctions.userId, userId), isNull(communitySanctions.revokedAt)))
}

/**
 * 요청한 사람의 커뮤니티 자격: 계정 상태·운영자 여부·active 학교 인증(정본 학교 + 자기 신고 학과 키) + 이용 제한(C-06).
 * `spaceId`는 판정하는 공간(그 공간 범위 제재까지 셈). null이면 공간 밖 판정(방 만들기 등: 커뮤니티 전체 제재만).
 */
export async function loadViewer(db: DbExecutor, actor: Actor, spaceId: string | null = null, now = new Date()): Promise<LoadedViewer> {
  const [user] = await db.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1)
  const rows = await db
    .select({
      schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
      schoolName: sql<string>`coalesce((select c.name from schools c where c.id = ${schools.mergedInto}), ${schools.name})`,
      departmentLabel: institutionAffiliations.departmentLabel,
    })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(and(eq(institutionAffiliations.userId, actor.userId), eq(institutionAffiliations.status, 'active')))
  const restriction = activeWriteRestriction(await loadOpenSanctions(db, actor.userId), spaceId, now)
  return {
    userId: actor.userId,
    status: user?.status ?? 'deleted',
    operator: await isOperator(db, actor.userId),
    affiliations: rows.map((r) => ({ schoolId: r.schoolId, departmentKey: departmentKey(r.departmentLabel) })),
    communityWriteSuspended: restriction !== null,
    writeRestriction: restriction,
    schools: [...new Map(rows.map((r) => [r.schoolId, { id: r.schoolId, name: r.schoolName, departmentLabel: r.departmentLabel }])).values()],
  }
}

/** 공간 행 + 정본 학교 id·이름. */
export interface LoadedSpace {
  row: SpaceRow
  schoolId: string | null
  schoolName: string | null
}

const spaceColumns = {
  row: communitySpaces,
  schoolId: sql<string | null>`coalesce(${schools.mergedInto}, ${schools.id})`,
  schoolName: sql<string | null>`coalesce((select c.name from schools c where c.id = ${schools.mergedInto}), ${schools.name})`,
}

export async function loadSpacesWhere(db: DbExecutor, where: ReturnType<typeof and>): Promise<LoadedSpace[]> {
  return db.select(spaceColumns).from(communitySpaces).leftJoin(schools, eq(schools.id, communitySpaces.schoolId)).where(where)
}

/** slug 또는 id로 공간을 찾습니다(잠금 선택). 형식이 틀리거나 없으면 404. */
export async function loadSpace(db: DbExecutor, ref: unknown, lock = false): Promise<LoadedSpace> {
  let where
  if (isSpaceSlug(ref)) where = eq(communitySpaces.slug, ref)
  else if (isUuid(ref)) where = eq(communitySpaces.id, ref.toLowerCase())
  else throw notFound()
  if (lock) {
    // 공간 행을 먼저 잠급니다(멤버십·정원·승계를 같은 순서로 바꾸기 위해).
    const [locked] = await db.select({ id: communitySpaces.id }).from(communitySpaces).where(where).limit(1).for('update')
    if (!locked) throw notFound()
  }
  const [loaded] = await db.select(spaceColumns).from(communitySpaces).leftJoin(schools, eq(schools.id, communitySpaces.schoolId)).where(where).limit(1)
  if (!loaded) throw notFound()
  return loaded
}

export async function findMembership(db: DbExecutor, spaceId: string, userId: string, lock = false): Promise<MembershipRow | null> {
  const query = db
    .select()
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.userId, userId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  return row ?? null
}

export async function activeMemberCount(db: DbExecutor, spaceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.status, 'active')))
  return row?.n ?? 0
}

export function spaceFacts(space: LoadedSpace, activeMembers: number): SpaceFacts {
  return {
    kind: space.row.kind,
    schoolId: space.schoolId,
    departmentKey: space.row.departmentKey,
    discovery: space.row.discovery,
    joinPolicy: space.row.joinPolicy,
    status: space.row.status,
    capacity: space.row.capacity,
    activeMembers,
  }
}

export const membershipFacts = (m: MembershipRow | null): MembershipFacts | null => (m ? { role: m.role, status: m.status } : null)

export interface SpaceContext {
  viewer: LoadedViewer
  space: LoadedSpace
  membership: MembershipRow | null
  facts: SpaceFacts
}

/** 공간 + 요청한 사람(그 공간 기준의 제재 포함) + 멤버십 + 판정 재료를 한 번에. */
export async function loadSpaceContext(db: DbExecutor, actor: Actor, ref: unknown, lock = false, now = new Date()): Promise<SpaceContext> {
  const space = await loadSpace(db, ref, lock)
  const [viewer, membership, count] = await Promise.all([
    loadViewer(db, actor, space.row.id, now),
    findMembership(db, space.row.id, actor.userId, lock),
    isOfficialKind(space.row.kind) ? Promise.resolve(0) : activeMemberCount(db, space.row.id),
  ])
  return { viewer, space, membership, facts: spaceFacts(space, count) }
}

/** 읽을 수 있는 공간만(아니면 404). */
export async function loadReadableSpace(db: DbExecutor, actor: Actor, ref: unknown, lock = false, now = new Date()): Promise<SpaceContext> {
  const ctx = await loadSpaceContext(db, actor, ref, lock, now)
  if (!canReadSpace(ctx.viewer, ctx.facts, membershipFacts(ctx.membership))) throw notFound()
  return ctx
}

/** 403 `write_restricted`(C-06): 이용 제한 중. 수준·범위·기한만 싣습니다(어느 글·누구의 요청 때문인지는 없음). */
export function writeRestricted(r: WriteRestriction): ServiceError {
  return new ServiceError('FORBIDDEN', 'write_restricted', undefined, { level: r.level, scope: r.scope, until: r.until?.toISOString() ?? null })
}
