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
  type BoardKind,
  activeWriteRestriction,
  canReadBoard,
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
  inArray,
  isNotNull,
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
import { isFeatureOn } from '../features'
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
    ...(isFeatureOn('alumni') && { alumniHistorySchoolIds: await alumniHistorySchoolIds(db, actor.userId) }),
    communityWriteSuspended: restriction !== null,
    writeRestriction: restriction,
    schools: [...new Map(rows.map((r) => [r.schoolId, { id: r.schoolId, name: r.schoolName, departmentLabel: r.departmentLabel }])).values()],
  }
}

/**
 * 졸업생 인증 이력이 있는 정본 학교 id(A-04, ADR 0041). @peerchive/domain `countsAsAlumniHistory`와 같은 조건: standing alumni + 인증된 적 있음
 * (verified_at) + active 또는 expired(인증 뒤 메일 확인이 끝남). revoked(이유 무관)·pending·인증 전 만료·재학생 이력은 세지 않습니다.
 * P2 alumni 플래그가 켜졌을 때만 부릅니다(꺼지면 열람은 active 인증만 — 기존 동작).
 */
async function alumniHistorySchoolIds(db: DbExecutor, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(
      and(
        eq(institutionAffiliations.userId, userId),
        eq(institutionAffiliations.standing, 'alumni'),
        isNotNull(institutionAffiliations.verifiedAt),
        inArray(institutionAffiliations.status, ['active', 'expired']),
      ),
    )
  return rows.map((r) => r.schoolId)
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

/** 게시판 단위로 읽는 문맥(A-04): `alumniHistoryOnly`면 졸업생 인증 이력으로만 읽는 사람입니다(쓰기·공감·운영 자격 없음). */
export interface BoardReadContext extends SpaceContext {
  alumniHistoryOnly: boolean
}

/**
 * 게시판(과 그 글·댓글)을 읽을 수 있는 공간만(아니면 404). 공간을 읽으면(canReadSpace) 그대로, 아니면 졸업생 인증 이력으로 그 게시판을 읽는지
 * (canReadBoard → readsByAlumniHistory, A-04·ADR 0041 — 공식 학교 페이지의 졸업생·자유 게시판만, 플래그가 켜졌을 때만).
 */
export async function loadBoardReadableSpace(
  db: DbExecutor,
  actor: Actor,
  ref: unknown,
  boardKind: BoardKind,
  lock = false,
  now = new Date(),
): Promise<BoardReadContext> {
  const ctx = await loadSpaceContext(db, actor, ref, lock, now)
  const m = membershipFacts(ctx.membership)
  if (canReadSpace(ctx.viewer, ctx.facts, m)) return { ...ctx, alumniHistoryOnly: false }
  if (canReadBoard(ctx.viewer, ctx.facts, m, boardKind)) return { ...ctx, alumniHistoryOnly: true }
  throw notFound()
}

/** 403 `write_restricted`(C-06): 이용 제한 중. 수준·범위·기한만 싣습니다(어느 글·누구의 요청 때문인지는 없음). */
export function writeRestricted(r: WriteRestriction): ServiceError {
  return new ServiceError('FORBIDDEN', 'write_restricted', undefined, { level: r.level, scope: r.scope, until: r.until?.toISOString() ?? null })
}
