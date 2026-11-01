/**
 * 기관 운영 화면: 기관 페이지·기수 방 목록, 기수 방 만들기, 기관 집계 (I-02, PROOFU_EVOLUTION_PLAN §8.9.11, SYSTEM_DESIGN §6.7.2·§8.4,
 * DELIVERY_PLAN §4.3 I-02·§5.3 Z, ADR 0044).
 *
 * - 모든 경로는 P2 `institutions` 플래그 뒤(꺼져 있으면 404)이고, **운영자 또는 그 기관의 active 운영진**만 씁니다(아니면 403 `institution_staff_only`).
 * - 기관 페이지는 대학이 아닌 기관의 official_school 공간입니다(운영자가 `POST /operator/community/official-pages`로 엶). 운영진은 그 페이지에서
 *   모더레이터 범위의 운영 조치·설정·게시판 관리를 공간 정책 함수(@peerchive/domain isInstitutionStaffFor)로 받습니다(이 파일이 아님).
 * - **기수 방**: 기관 기수(`institution_cohorts`)에 묶인 사용자 방. 운영진·운영자가 기수마다 하나 만들고(보관되면 다시 만들 수 있음), 방장은
 *   없습니다. 동문회·OB 방 템플릿(A-01, ADR 0038 — 방별 프로필·배지·일정·투표·앨범·명부)을 쓰고, 그 기관·그 기수의 active 인증(수단 무관)이
 *   있는 사람만 들어오고 읽습니다(인증이 끝나면 다음 요청부터 404). 자유 가입·목록 노출로 고정입니다.
 * - **기관 집계**: 신분별 인증 회원 수·기관 페이지 최근 30일 글·댓글 수만, 모든 칸 5 미만 null(ADR 0027과 같은 suppressSmall), 합계 없음.
 * - **사람 목록이 없습니다**: 소속 사용자·기수 방 멤버·작성자·프로필·과제 공간을 기관 단위로 돌려주는 경로를 두지 않습니다(라우트 검사 테스트).
 *   기수 방 멤버 수도 5 미만이면 null입니다.
 */
import { z } from 'zod'
import {
  ALUMNI_ROOM_DEFAULT_BOARDS,
  ANALYTICS_MIN_GROUP,
  ROOM_NAME_MODES,
  SPACE_CAPACITY_REVIEW_MAX,
  SPACE_DESCRIPTION_MAX,
  checkSpaceName,
  suppressSmall,
} from '@peerchive/domain'
import {
  and,
  asc,
  communityComments,
  communityPosts,
  communitySpaces,
  eq,
  gte,
  inArray,
  institutionCohorts,
  isNotNull,
  ne,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, sqlState } from '../errors'
import { requireFeature } from '../features'
import { findOrCreateCohort, toInstitutionDto } from '../institutions/institutions'
import { verifiedMemberCount } from '../institutions/member-counts'
import { requireInstitutionManager } from '../institutions/staff'
import { parseInput } from '../validation'
import { type LoadedSpace, loadSpacesWhere } from './access'
import { getSpaceDetail, insertSpace, memberCounts } from './spaces'
import type { CohortRoomSummaryDto, InstitutionOverviewDto, InstitutionStatsDto, SpaceDetailDto } from '../../../shared/types/api'

const DAY_MS = 24 * 60 * 60 * 1000
const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

/** 그 기관(정본)의 기관 페이지(official_school). 대학이 아닌 기관은 병합하지 않으므로 school_id로 바로 찾습니다. */
async function institutionPage(db: DbExecutor, institutionId: string): Promise<LoadedSpace | null> {
  const [row] = await loadSpacesWhere(db, and(eq(communitySpaces.schoolId, institutionId), eq(communitySpaces.kind, 'official_school')))
  return row ?? null
}

async function cohortRoomSummaries(db: DbExecutor, institutionId: string): Promise<CohortRoomSummaryDto[]> {
  const rows = await db
    .select({ space: communitySpaces, cohortLabel: institutionCohorts.label })
    .from(communitySpaces)
    .innerJoin(institutionCohorts, eq(institutionCohorts.id, communitySpaces.cohortId))
    .where(and(eq(communitySpaces.schoolId, institutionId), eq(communitySpaces.kind, 'user_room'), isNotNull(communitySpaces.cohortId)))
    .orderBy(asc(institutionCohorts.labelKey), asc(communitySpaces.createdAt))
  const counts = await memberCounts(db, rows.map((r) => r.space.id))
  return rows.map((r) => ({
    slug: r.space.slug,
    name: r.space.name,
    cohortLabel: r.cohortLabel,
    status: r.space.status,
    nameMode: r.space.currentNameMode,
    // 기관 단위 화면에는 사람 수도 5 미만이면 싣지 않습니다(ADR 0027 임계값).
    memberCount: suppressSmall(counts.get(r.space.id) ?? 0),
  }))
}

/** GET /community/institutions/:id — 운영진·운영자. 기관 페이지와 기수 방 요약(사람 목록 없음). */
export async function getInstitutionOverview(db: DbExecutor, actor: Actor, institutionId: unknown): Promise<InstitutionOverviewDto> {
  requireFeature('institutions')
  const manager = await requireInstitutionManager(db, actor, institutionId)
  const page = await institutionPage(db, manager.institution.id)
  return {
    institution: toInstitutionDto(manager.institution),
    asOperator: manager.operator,
    page: page ? { slug: page.row.slug, name: page.row.name, status: page.row.status } : null,
    cohortRooms: await cohortRoomSummaries(db, manager.institution.id),
  }
}

// ── 기수 방 만들기 ───────────────────────────────────────────────────────

export const createCohortRoomSchema = z.object({
  cohortLabel: z.unknown(),
  name: z.unknown().optional(),
  description: z
    .string({ error: 'invalid' })
    .trim()
    .max(SPACE_DESCRIPTION_MAX, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v.normalize('NFC') : null)),
  /** 기본 display(동문 네트워킹 기본값, ADR 0038). 소속 표시 익명은 토픽 전용이라 고를 수 없습니다. */
  nameMode: z.enum(ROOM_NAME_MODES, { error: requiredOr('invalid') }).optional(),
})

/**
 * POST /community/institutions/:id/cohort-rooms {cohortLabel, name?, description?, nameMode?} — 운영진·운영자. 201 + 공간 상세.
 * 기수가 없으면 만듭니다(초대 코드 발급과 같은 findOrCreateCohort). 같은 기수에 보관되지 않은 방이 있으면 409 `cohort_room_exists`(+slug).
 * 이름 기본값 `기관 이름 기수`, 예약어 검사(사용자 방과 같음). 방장 없음, 동문회·OB 템플릿, 자유 가입·목록 노출, 정원 2000.
 */
export async function createCohortRoom(db: DbExecutor, actor: Actor, institutionId: unknown, rawInput: unknown, now = new Date()): Promise<SpaceDetailDto> {
  requireFeature('institutions')
  const manager = await requireInstitutionManager(db, actor, institutionId)
  const input = parseInput(createCohortRoomSchema, rawInput)
  const institution = manager.institution
  const slug = await db.transaction(async (tx) => {
    const cohort = await findOrCreateCohort(tx, institution.id, input.cohortLabel, actor.userId)
    const nameRaw = input.name === undefined || input.name === null || input.name === '' ? `${institution.name} ${cohort.label}` : input.name
    const checked = checkSpaceName(nameRaw, { reserved: true })
    if (!checked.ok) throw invalid({ name: checked.reason })
    // 같은 기수의 만들기를 직렬화합니다(부분 unique가 최종 판정).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`cohort_room:${cohort.id}`}))`)
    const [existing] = await tx
      .select({ slug: communitySpaces.slug })
      .from(communitySpaces)
      .where(and(eq(communitySpaces.cohortId, cohort.id), ne(communitySpaces.status, 'archived')))
      .limit(1)
    if (existing) throw conflict('cohort_room_exists', { slug: existing.slug })
    let row
    try {
      row = await insertSpace(
        tx,
        {
          kind: 'user_room',
          schoolId: institution.id,
          cohortId: cohort.id,
          name: checked.value,
          description: input.description,
          nameMode: input.nameMode ?? 'display',
          template: 'alumni',
          boards: ALUMNI_ROOM_DEFAULT_BOARDS,
          discovery: 'listed',
          joinPolicy: 'open',
          capacity: SPACE_CAPACITY_REVIEW_MAX,
          capacityRequested: null,
          createdBy: actor.userId,
          ownerId: null,
        },
        now,
      )
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('cohort_room_exists')
      throw error
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.cohort_room_create',
      targetType: 'community_space',
      targetId: row.id,
      metadata: { schoolId: institution.id, cohortId: cohort.id, nameMode: row.currentNameMode, byStaff: !manager.operator },
    })
    await emitAnalytics(tx, { name: 'space_created', actorId: actor.userId, props: { kind: 'user_room' }, now })
    return row.slug
  })
  return getSpaceDetail(db, actor, slug, now)
}

// ── 기관 집계 ────────────────────────────────────────────────────────────

/**
 * GET /community/institutions/:id/stats — 운영진·운영자. 신분별 인증 회원 수(사람 단위)·기관 페이지 최근 30일 게시 중인 글·댓글 수·기수 방 수.
 * 사람 수·글 수는 모두 5 미만이면 null(suppressSmall, ADR 0027). 합계·기수별·수단별 수는 싣지 않습니다(작은 칸을 빼기로 되살리지 못하게).
 */
export async function getInstitutionStats(db: DbExecutor, actor: Actor, institutionId: unknown, now = new Date()): Promise<InstitutionStatsDto> {
  requireFeature('institutions')
  const manager = await requireInstitutionManager(db, actor, institutionId)
  const id = manager.institution.id
  const [student, alumni, page] = await Promise.all([verifiedMemberCount(db, id, 'student'), verifiedMemberCount(db, id, 'alumni'), institutionPage(db, id)])
  const since = new Date(now.getTime() - 30 * DAY_MS)
  let pageStats: InstitutionStatsDto['page'] = null
  if (page) {
    const [posts] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(communityPosts)
      .where(and(eq(communityPosts.spaceId, page.row.id), eq(communityPosts.status, 'published'), gte(communityPosts.createdAt, since)))
    const [comments] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(communityComments)
      .innerJoin(communityPosts, eq(communityPosts.id, communityComments.postId))
      .where(and(eq(communityPosts.spaceId, page.row.id), eq(communityComments.status, 'published'), gte(communityComments.createdAt, since)))
    pageStats = { posts30d: suppressSmall(posts?.n ?? 0), comments30d: suppressSmall(comments?.n ?? 0) }
  }
  const [rooms] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(communitySpaces)
    .where(and(eq(communitySpaces.schoolId, id), isNotNull(communitySpaces.cohortId), inArray(communitySpaces.status, ['active', 'restricted'])))
  return {
    institution: toInstitutionDto(manager.institution),
    minGroup: ANALYTICS_MIN_GROUP,
    verifiedMembers: { student: suppressSmall(student), alumni: suppressSmall(alumni) },
    page: pageStats,
    cohortRooms: rooms?.n ?? 0,
    generatedAt: now.toISOString(),
  }
}
