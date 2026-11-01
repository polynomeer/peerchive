/**
 * 공식 학교·학과 페이지와 운영자 커뮤니티 도구 (C-02, PROOFU_EVOLUTION_PLAN §8.9.3, SYSTEM_DESIGN §6.7 SpaceOpeningRequest·§8.1, DELIVERY_PLAN §4.1 C-02,
 * ADR 0019).
 *
 * 개설 요청(학생)
 * - `POST /community/official-requests {schoolId, departmentLabel?}`: 그 학교 active 인증이 있어야 함(403 `affiliation_required`), (학교, 학과)마다
 *   한 사람 한 번(이미 있으면 200 `created: false`). 이미 열린 공식 페이지가 있으면 409 `official_exists`(slug). 요청 수는 요청자에게 보이지 않습니다.
 * - 서로 다른 요청자 중 지금 그 학교 인증이 active인 수가 10에 이르거나, 운영자가 어떤 요청을 학생회 요청으로 표시하면 **운영자에게만 알립니다**:
 *   감사 `community.official_request.threshold`(처음 이를 때 한 번) + 운영자 목록의 `thresholdReached`. 자동으로 개설하지 않습니다.
 *
 * 운영자(모두 403 `operator_only`가 먼저)
 * - 공식 페이지 개설: `POST /operator/community/official-pages {schoolId, departmentLabel?, name?, description?}` → 201(기본 게시판 7개,
 *   이름 표시 anonymous 고정). 학교·학과마다 하나(409 `official_exists`).
 * - 공간 목록·제한·제한 해제·보관·정원 결정·모더레이터 지정. 운영자는 사용자 방의 게시판·멤버 목록을 읽지 않습니다(공간 정보만).
 *
 * 기관 페이지(I-02, ADR 0044): 대학이 아닌 기관의 공식 학교 페이지(종류는 official_school 그대로). P2 institutions 플래그가 켜져 있을 때만
 * 요청·개설할 수 있고(꺼져 있으면 404), 학과 페이지는 없습니다(422 `departmentLabel: not_supported`). 기본 게시판은 새내기 없이 `수료생`
 * (INSTITUTION_PAGE_DEFAULT_BOARDS). 개설 요청은 그 기관 active 인증이면 낼 수 있고(수요 신호), 여는 것은 대학과 같이 운영자입니다.
 */
import { z } from 'zod'
import {
  INSTITUTION_PAGE_DEFAULT_BOARDS,
  OFFICIAL_DEFAULT_BOARDS,
  SPACE_CAPACITY_MIN,
  SPACE_CAPACITY_REVIEW_MAX,
  SPACE_DESCRIPTION_MAX,
  SPACE_KINDS,
  SPACE_STATUSES,
  checkSpaceName,
  defaultOfficialName,
  departmentKey,
  hasSchoolAffiliation,
  isNonUniversityKind,
  isOfficialKind,
  normalizeDepartmentLabel,
  officialRequestThresholdReached,
} from '@peerchive/domain'
import {
  and,
  asc,
  communitySpaces,
  desc,
  eq,
  isNotNull,
  isNull,
  moderationActions,
  officialPageRequests,
  schools,
  spaceMemberships,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { loadCanonicalSchool } from '../catalog/catalog'
import { requireOperator } from '../catalog/operators'
import { type Actor, ServiceError, conflict, invalid, notFound, sqlState } from '../errors'
import { requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { type LoadedSpace, findMembership, loadSpace, loadSpacesWhere, loadViewer } from './access'
import { syncStudyRecordInTx } from './study-records'
import { archiveSpaceInTx, getSpaceDetail, insertSpace, memberCounts } from './spaces'
import type {
  OfficialPageRequestDto,
  OperatorOfficialRequestGroupDto,
  OperatorSpaceDto,
  SpaceDetailDto,
} from '../../../shared/types/api'

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

function parseDepartment(raw: unknown): { label: string | null; key: string } {
  const checked = normalizeDepartmentLabel(raw)
  if (!checked.ok) throw invalid({ departmentLabel: checked.reason })
  return { label: checked.value, key: departmentKey(checked.value) ?? '' }
}

/** 기관 페이지(I-02) 전제: 대학이 아닌 기관이면 플래그(꺼져 있으면 404)와 학과 없음(422). 대학이면 아무것도 하지 않습니다. */
function assertInstitutionPageTarget(school: { kind: string }, dept: { label: string | null }): void {
  if (!isNonUniversityKind(school.kind)) return
  requireFeature('institutions')
  if (dept.label) throw invalid({ departmentLabel: 'not_supported' })
}

/** 정본 학교의 공식 페이지(학과 키 ''는 학교 페이지). 병합 전 학교를 가리키는 페이지도 찾습니다. */
async function findOfficialPage(db: DbExecutor, schoolId: string, deptKey: string): Promise<LoadedSpace | null> {
  const [row] = await loadSpacesWhere(
    db,
    and(
      sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${schoolId}`,
      deptKey
        ? and(eq(communitySpaces.kind, 'official_department'), eq(communitySpaces.departmentKey, deptKey))
        : eq(communitySpaces.kind, 'official_school'),
    ),
  )
  return row ?? null
}

// ── 개설 요청 ────────────────────────────────────────────────────────────

export const officialRequestSchema = z.object({
  schoolId: z.string({ error: requiredOr('invalid') }),
  departmentLabel: z.unknown().optional(),
})

interface TargetStats {
  requesters: number
  studentCouncil: boolean
}

/** 묶음 통계: 서로 다른 요청자 중 지금 그 학교(정본) 인증이 active인 수 + 학생회 표시 여부. */
async function targetStats(db: DbExecutor, schoolId: string, deptKey: string): Promise<TargetStats> {
  const [row] = await db
    .select({
      requesters: sql<number>`count(distinct ${officialPageRequests.requesterId}) filter (where exists (
        select 1 from institution_affiliations a join schools s on s.id = a.school_id
        where a.user_id = ${officialPageRequests.requesterId} and a.status = 'active' and coalesce(s.merged_into, s.id) = ${schoolId}))::int`,
      council: sql<boolean>`bool_or(${officialPageRequests.source} = 'student_council')`,
    })
    .from(officialPageRequests)
    .innerJoin(schools, eq(schools.id, officialPageRequests.schoolId))
    .where(and(sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${schoolId}`, eq(officialPageRequests.departmentKey, deptKey)))
  return { requesters: row?.requesters ?? 0, studentCouncil: row?.council ?? false }
}

/** 같은 묶음의 요청을 직렬화합니다(기준 도달 알림을 한 번만). */
async function lockTarget(tx: DbExecutor, schoolId: string, deptKey: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`official_request:${schoolId}:${deptKey}`}))`)
}

async function notifyIfReached(tx: DbExecutor, before: TargetStats, schoolId: string, deptKey: string, actorId: string | null): Promise<boolean> {
  const after = await targetStats(tx, schoolId, deptKey)
  const reached = officialRequestThresholdReached(after.requesters, after.studentCouncil)
  if (reached && !officialRequestThresholdReached(before.requesters, before.studentCouncil)) {
    // 운영자 알림: 감사 기록(운영자 목록·감사 조회에 보임). 요청자 id는 넣지 않습니다.
    await recordAudit(tx, {
      actorId,
      action: 'community.official_request.threshold',
      targetType: 'school',
      targetId: schoolId,
      metadata: { department: deptKey !== '', requesters: after.requesters, studentCouncil: after.studentCouncil },
    })
    return true
  }
  return false
}

const toRequestDto = (row: typeof officialPageRequests.$inferSelect, school: { id: string; name: string }): OfficialPageRequestDto => ({
  id: row.id,
  school,
  departmentLabel: row.departmentLabel,
  createdAt: row.createdAt.toISOString(),
})

/**
 * POST /community/official-requests {schoolId, departmentLabel?} — 201(새 요청) / 200(이미 요청함, `created: false`).
 * 403 `affiliation_required`, 404(학교), 409 `official_exists`(+slug), 422 `departmentLabel`.
 */
export async function requestOfficialPage(
  db: DbExecutor,
  actor: Actor,
  rawInput: unknown,
  now = new Date(),
): Promise<{ request: OfficialPageRequestDto; created: boolean }> {
  const input = parseInput(officialRequestSchema, rawInput)
  const dept = parseDepartment(input.departmentLabel)
  const school = await loadCanonicalSchool(db, input.schoolId)
  assertInstitutionPageTarget(school, dept)
  const viewer = await loadViewer(db, actor)
  if (viewer.status !== 'active' || !hasSchoolAffiliation(viewer, school.id)) {
    throw new ServiceError('FORBIDDEN', 'affiliation_required', undefined, { requirement: 'school_affiliation', schoolId: school.id })
  }
  return db.transaction(async (tx) => {
    await lockTarget(tx, school.id, dept.key)
    const existingPage = await findOfficialPage(tx, school.id, dept.key)
    if (existingPage) throw conflict('official_exists', { slug: existingPage.row.slug })
    const [mine] = await tx
      .select()
      .from(officialPageRequests)
      .where(and(eq(officialPageRequests.schoolId, school.id), eq(officialPageRequests.departmentKey, dept.key), eq(officialPageRequests.requesterId, actor.userId)))
      .limit(1)
    if (mine) return { request: toRequestDto(mine, { id: school.id, name: school.name }), created: false }
    const before = await targetStats(tx, school.id, dept.key)
    let row
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(officialPageRequests)
          .values({ schoolId: school.id, departmentLabel: dept.label, departmentKey: dept.key, requesterId: actor.userId, createdAt: now })
          .returning()
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('request_in_progress')
      throw error
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.official_request',
      targetType: 'school',
      targetId: school.id,
      metadata: { department: dept.key !== '' },
    })
    await notifyIfReached(tx, before, school.id, dept.key, null)
    return { request: toRequestDto(row, { id: school.id, name: school.name }), created: true }
  })
}

/** GET /community/official-requests — 내 개설 요청(요청 수 없음). */
export async function listMyOfficialRequests(db: DbExecutor, actor: Actor): Promise<OfficialPageRequestDto[]> {
  const rows = await db
    .select({
      row: officialPageRequests,
      schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
      schoolName: sql<string>`coalesce((select c.name from schools c where c.id = ${schools.mergedInto}), ${schools.name})`,
    })
    .from(officialPageRequests)
    .innerJoin(schools, eq(schools.id, officialPageRequests.schoolId))
    .where(eq(officialPageRequests.requesterId, actor.userId))
    .orderBy(desc(officialPageRequests.createdAt))
  return rows.map((r) => toRequestDto(r.row, { id: r.schoolId, name: r.schoolName }))
}

/** GET /operator/community/official-requests — 운영자만. 학교·학과별 묶음(요청자 수·학생회 여부·기준 도달·열린 페이지). 기준 도달·많은 순. */
export async function listOfficialRequestGroups(db: DbExecutor, actor: Actor): Promise<OperatorOfficialRequestGroupDto[]> {
  await requireOperator(db, actor)
  const rows = await db
    .select({
      schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
      schoolName: sql<string>`max(coalesce((select c.name from schools c where c.id = ${schools.mergedInto}), ${schools.name}))`,
      departmentKey: officialPageRequests.departmentKey,
      departmentLabel: sql<string | null>`(array_agg(${officialPageRequests.departmentLabel} order by ${officialPageRequests.createdAt}))[1]`,
      first: sql<Date>`min(${officialPageRequests.createdAt})`,
      last: sql<Date>`max(${officialPageRequests.createdAt})`,
      latestId: sql<string>`(array_agg(${officialPageRequests.id} order by ${officialPageRequests.createdAt} desc))[1]`,
    })
    .from(officialPageRequests)
    .innerJoin(schools, eq(schools.id, officialPageRequests.schoolId))
    .groupBy(sql`coalesce(${schools.mergedInto}, ${schools.id})`, officialPageRequests.departmentKey)
  const groups: OperatorOfficialRequestGroupDto[] = []
  for (const r of rows) {
    const stats = await targetStats(db, r.schoolId, r.departmentKey)
    const page = await findOfficialPage(db, r.schoolId, r.departmentKey)
    groups.push({
      school: { id: r.schoolId, name: r.schoolName },
      departmentLabel: r.departmentLabel,
      departmentKey: r.departmentKey,
      requesters: stats.requesters,
      studentCouncil: stats.studentCouncil,
      thresholdReached: officialRequestThresholdReached(stats.requesters, stats.studentCouncil),
      existingSpaceSlug: page?.row.slug ?? null,
      firstRequestedAt: new Date(r.first).toISOString(),
      lastRequestedAt: new Date(r.last).toISOString(),
      latestRequestId: r.latestId,
    })
  }
  return groups.sort((a, b) => Number(b.thresholdReached) - Number(a.thresholdReached) || b.requesters - a.requesters || a.school.name.localeCompare(b.school.name))
}

/** POST /operator/community/official-requests/:id/student-council — 운영자가 학생회 요청임을 확인해 표시합니다(기준 도달로 봄). 200. */
export async function markStudentCouncilRequest(db: DbExecutor, actor: Actor, requestId: unknown): Promise<{ thresholdReached: boolean }> {
  await requireOperator(db, actor)
  if (!isUuid(requestId)) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ row: officialPageRequests, schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
      .from(officialPageRequests)
      .innerJoin(schools, eq(schools.id, officialPageRequests.schoolId))
      .where(eq(officialPageRequests.id, requestId.toLowerCase()))
      .limit(1)
    if (!row) throw notFound()
    await lockTarget(tx, row.schoolId, row.row.departmentKey)
    const before = await targetStats(tx, row.schoolId, row.row.departmentKey)
    if (row.row.source !== 'student_council') {
      await tx.update(officialPageRequests).set({ source: 'student_council', sourceMarkedBy: actor.userId }).where(eq(officialPageRequests.id, row.row.id))
      await recordAudit(tx, { actorId: actor.userId, action: 'community.official_request.student_council', targetType: 'school', targetId: row.schoolId, metadata: { requestId: row.row.id } })
      await notifyIfReached(tx, before, row.schoolId, row.row.departmentKey, actor.userId)
    }
    return { thresholdReached: true }
  })
}

// ── 공식 페이지 개설 ─────────────────────────────────────────────────────

export const createOfficialSchema = z.object({
  schoolId: z.string({ error: requiredOr('invalid') }),
  departmentLabel: z.unknown().optional(),
  name: z.unknown().optional(),
  description: z
    .string({ error: 'invalid' })
    .trim()
    .max(SPACE_DESCRIPTION_MAX, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v : null)),
})

/**
 * POST /operator/community/official-pages — 운영자만(403). 201 + 상세. 학교(정본)·학과(키)마다 하나(409 `official_exists`).
 * 이름 기본값: 학교 이름(+ 학과). 이름 표시 anonymous 고정, 기본 게시판 7개(공지는 모더레이터 전용).
 */
export async function createOfficialPage(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<SpaceDetailDto> {
  await requireOperator(db, actor)
  const input = parseInput(createOfficialSchema, rawInput)
  const dept = parseDepartment(input.departmentLabel)
  const school = await loadCanonicalSchool(db, input.schoolId)
  assertInstitutionPageTarget(school, dept)
  const institutionPage = isNonUniversityKind(school.kind)
  const nameRaw = input.name === undefined || input.name === null || input.name === '' ? defaultOfficialName(school.name, dept.label) : input.name
  const checked = checkSpaceName(nameRaw, { reserved: false })
  if (!checked.ok) throw invalid({ name: checked.reason })
  const kind = dept.label ? 'official_department' : 'official_school'
  const slug = await db.transaction(async (tx) => {
    await lockTarget(tx, school.id, dept.key)
    const existing = await findOfficialPage(tx, school.id, dept.key)
    if (existing) throw conflict('official_exists', { slug: existing.row.slug })
    let row
    try {
      row = await insertSpace(
        tx,
        {
          kind,
          schoolId: school.id,
          departmentLabel: dept.label,
          departmentKey: dept.label ? dept.key : null,
          name: checked.value,
          description: input.description,
          nameMode: 'anonymous',
          discovery: 'listed',
          joinPolicy: 'open',
          capacity: 100000,
          capacityRequested: null,
          createdBy: actor.userId,
          ownerId: null,
          boards: institutionPage ? INSTITUTION_PAGE_DEFAULT_BOARDS : OFFICIAL_DEFAULT_BOARDS,
        },
        now,
      )
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('official_exists')
      throw error
    }
    const stats = await targetStats(tx, school.id, dept.key)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.official_create',
      targetType: 'community_space',
      targetId: row.id,
      metadata: { kind, schoolId: school.id, requesters: stats.requesters, studentCouncil: stats.studentCouncil, institutionPage },
    })
    await emitAnalytics(tx, { name: 'space_created', actorId: actor.userId, props: { kind }, now })
    return row.slug
  })
  return getSpaceDetail(db, actor, slug)
}

// ── 운영자 공간 도구 ─────────────────────────────────────────────────────

export function toOperatorSpaceDto(space: LoadedSpace, memberCount: number): OperatorSpaceDto {
  return {
    id: space.row.id,
    slug: space.row.slug,
    kind: space.row.kind,
    name: space.row.name,
    description: space.row.description,
    school: space.schoolId && space.schoolName ? { id: space.schoolId, name: space.schoolName } : null,
    departmentLabel: space.row.departmentLabel,
    status: space.row.status,
    nameMode: space.row.currentNameMode,
    joinPolicy: space.row.joinPolicy,
    discovery: space.row.discovery,
    memberCount,
    capacity: space.row.capacity,
    capacityRequested: space.row.capacityRequested,
    createdAt: space.row.createdAt.toISOString(),
  }
}

const operatorListSchema = z.object({
  kind: z.enum(SPACE_KINDS, { error: 'invalid' }).optional(),
  status: z.enum(SPACE_STATUSES, { error: 'invalid' }).optional(),
  capacityRequested: z.enum(['1'], { error: 'invalid' }).optional(),
  schoolId: z.uuid({ error: 'invalid' }).optional(),
})

/** GET /operator/community/spaces?kind=&status=&capacityRequested=1&schoolId= — 운영자만. 공간 정보만(게시판·멤버 목록 없음), 최근 200개. */
export async function listSpacesForOperator(db: DbExecutor, actor: Actor, query: unknown): Promise<OperatorSpaceDto[]> {
  await requireOperator(db, actor)
  const q = parseInput(operatorListSchema, query)
  const rows = await loadSpacesWhere(
    db,
    and(
      q.kind ? eq(communitySpaces.kind, q.kind) : undefined,
      q.status ? eq(communitySpaces.status, q.status) : undefined,
      q.capacityRequested ? isNotNull(communitySpaces.capacityRequested) : undefined,
      q.schoolId ? sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${q.schoolId.toLowerCase()}` : undefined,
    ),
  )
  const sorted = rows.sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime()).slice(0, 200)
  const counts = await memberCounts(db, sorted.map((s) => s.row.id))
  return sorted.map((s) => toOperatorSpaceDto(s, counts.get(s.row.id) ?? 0))
}

async function operatorSpace(db: DbExecutor, actor: Actor, spaceId: unknown, lock = false): Promise<LoadedSpace> {
  await requireOperator(db, actor)
  return loadSpace(db, spaceId, lock)
}

async function operatorDto(db: DbExecutor, spaceId: string): Promise<OperatorSpaceDto> {
  const space = await loadSpace(db, spaceId)
  return toOperatorSpaceDto(space, (await memberCounts(db, [space.row.id])).get(space.row.id) ?? 0)
}

const noteSchema = z.object({
  note: z.string({ error: requiredOr('invalid') }).trim().min(1, { error: 'required' }).max(1000, { error: 'too_long' }),
})

/** 공간 제한(트랜잭션 안). active가 아니면 409 `target_not_public`. 신고 처리(restrict_space)와 운영자 직접 제한이 함께 씁니다. */
export async function restrictSpaceInTx(tx: DbExecutor, spaceId: string, now: Date): Promise<void> {
  const [row] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, spaceId)).limit(1).for('update')
  if (!row) throw notFound()
  if (row.status !== 'active') throw conflict('target_not_public')
  await tx.update(communitySpaces).set({ status: 'restricted', restrictedAt: now, updatedAt: now }).where(eq(communitySpaces.id, spaceId))
  await syncStudyRecordInTx(tx, spaceId, now)
}

/** 제한 해제(트랜잭션 안). 제한 상태가 아니면 아무것도 하지 않고 false. */
export async function liftSpaceRestrictionInTx(tx: DbExecutor, spaceId: string, now: Date): Promise<boolean> {
  const [row] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, spaceId)).limit(1).for('update')
  if (!row || row.status !== 'restricted') return false
  await tx.update(communitySpaces).set({ status: 'active', restrictedAt: null, updatedAt: now }).where(eq(communitySpaces.id, spaceId))
  await syncStudyRecordInTx(tx, spaceId, now)
  return true
}

/** 신고 없이 하는 운영자 직접 조치를 운영 조치 행으로 남깁니다(메모는 internal_note, 당사자 공개 사유 없음). */
async function recordDirectSpaceAction(
  tx: DbExecutor,
  actor: Actor,
  spaceId: string,
  kind: 'restrict_space' | 'archive_space',
  note: string,
): Promise<string> {
  const [action] = await tx
    .insert(moderationActions)
    .values({
      kind,
      outcome: 'resolved',
      targetType: 'community_space',
      targetKey: `community_space:${spaceId}`,
      communitySpaceId: spaceId,
      internalNote: note,
      createdBy: actor.userId,
    })
    .returning({ id: moderationActions.id })
  return action!.id
}

/** POST /operator/community/spaces/:id/restrict {note} — 운영자만. 200. 이미 active가 아니면 409. 신고 없이 하는 직접 조치(사유는 감사). */
export async function restrictSpace(db: DbExecutor, actor: Actor, spaceId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorSpaceDto> {
  const { note } = parseInput(noteSchema, rawInput)
  const space = await operatorSpace(db, actor, spaceId)
  await db.transaction(async (tx) => {
    await restrictSpaceInTx(tx, space.row.id, now)
    // 운영자 메모는 감사 기록이 아니라 운영 조치 행(internal_note)에 둡니다(감사에는 id만, ADR 0015).
    const actionId = await recordDirectSpaceAction(tx, actor, space.row.id, 'restrict_space', note)
    await recordAudit(tx, { actorId: actor.userId, action: 'community.space_restrict', targetType: 'community_space', targetId: space.row.id, metadata: { moderationActionId: actionId } })
  })
  return operatorDto(db, space.row.id)
}

/**
 * POST /operator/community/spaces/:id/lift-restriction {note} — 운영자만. restricted → active. 이 공간의 되돌리지 않은 restrict_space 조치는
 * lift로 되돌림 표시합니다. 제한 상태가 아니면 409 `not_restricted`.
 */
export async function liftSpaceRestriction(db: DbExecutor, actor: Actor, spaceId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorSpaceDto> {
  const { note } = parseInput(noteSchema, rawInput)
  const space = await operatorSpace(db, actor, spaceId)
  await db.transaction(async (tx) => {
    if (!(await liftSpaceRestrictionInTx(tx, space.row.id, now))) throw conflict('not_restricted')
    await tx
      .update(moderationActions)
      .set({ reversedAt: now, reversedBy: actor.userId, reverseNote: note, reverseCause: 'lift' })
      .where(and(eq(moderationActions.communitySpaceId, space.row.id), eq(moderationActions.kind, 'restrict_space'), isNull(moderationActions.reversedAt)))
    // 해제 메모는 위 restrict_space 조치 행의 reverse_note에 남았습니다.
    await recordAudit(tx, { actorId: actor.userId, action: 'community.space_lift', targetType: 'community_space', targetId: space.row.id, metadata: {} })
  })
  return operatorDto(db, space.row.id)
}

/** POST /operator/community/spaces/:id/archive {note} — 운영자만. 이미 보관됐으면 409 `already_archived`. */
export async function archiveSpaceByOperator(db: DbExecutor, actor: Actor, spaceId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorSpaceDto> {
  const { note } = parseInput(noteSchema, rawInput)
  const space = await operatorSpace(db, actor, spaceId)
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, space.row.id)).limit(1).for('update')
    if (row!.status === 'archived') throw conflict('already_archived')
    await archiveSpaceInTx(tx, space.row.id, now)
    const actionId = await recordDirectSpaceAction(tx, actor, space.row.id, 'archive_space', note)
    await recordAudit(tx, { actorId: actor.userId, action: 'community.space_archive', targetType: 'community_space', targetId: space.row.id, metadata: { cause: 'operator', moderationActionId: actionId } })
  })
  return operatorDto(db, space.row.id)
}

const capacitySchema = z.object({
  capacity: z
    .number({ error: requiredOr('invalid') })
    .int({ error: 'invalid' })
    .min(SPACE_CAPACITY_MIN, { error: 'too_small' })
    .max(SPACE_CAPACITY_REVIEW_MAX, { error: 'too_large' }),
})

/** POST /operator/community/spaces/:id/capacity {capacity} — 운영자 정원 검토(사용자 방만, 2~2000). 요청값을 지웁니다. 지금 멤버 수보다 작으면 422. */
export async function decideCapacity(db: DbExecutor, actor: Actor, spaceId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorSpaceDto> {
  const { capacity } = parseInput(capacitySchema, rawInput)
  const space = await operatorSpace(db, actor, spaceId)
  if (isOfficialKind(space.row.kind)) throw invalid({ capacity: 'not_applicable' })
  await db.transaction(async (tx) => {
    const count = (await memberCounts(tx, [space.row.id])).get(space.row.id) ?? 0
    if (capacity < count) throw invalid({ capacity: 'below_members' })
    await tx.update(communitySpaces).set({ capacity, capacityRequested: null, updatedAt: now }).where(eq(communitySpaces.id, space.row.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.capacity_decide', targetType: 'community_space', targetId: space.row.id, metadata: { capacity, requested: space.row.capacityRequested } })
  })
  return operatorDto(db, space.row.id)
}

const moderatorSchema = z.object({ userId: z.uuid({ error: requiredOr('invalid') }).transform((v) => v.toLowerCase()) })

/**
 * POST /operator/community/spaces/:id/moderators {userId} — 공식 페이지 모더레이터 지정(운영자만, §8.9.3 학교·학과마다 2~3명).
 * 대상은 그 학교 active 인증이 있어야 함(422 `userId: affiliation_required`). 사용자 방은 422 `not_official`.
 */
export async function assignModerator(db: DbExecutor, actor: Actor, spaceId: unknown, rawInput: unknown, now = new Date()): Promise<{ userIds: string[] }> {
  const { userId } = parseInput(moderatorSchema, rawInput)
  const space = await operatorSpace(db, actor, spaceId)
  if (!isOfficialKind(space.row.kind)) throw invalid({ space: 'not_official' })
  const target = await loadViewer(db, { userId })
  if (target.status !== 'active' || !hasSchoolAffiliation(target, space.schoolId)) throw invalid({ userId: 'affiliation_required' })
  await db.transaction(async (tx) => {
    await loadSpace(tx, space.row.id, true)
    const existing = await findMembership(tx, space.row.id, userId, true)
    if (existing) {
      await tx.update(spaceMemberships).set({ role: 'moderator', status: 'active', joinedAt: existing.joinedAt ?? now, endedAt: null, updatedAt: now }).where(eq(spaceMemberships.id, existing.id))
    } else {
      await tx.insert(spaceMemberships).values({ spaceId: space.row.id, userId, role: 'moderator', status: 'active', joinedAt: now, createdAt: now, updatedAt: now })
    }
    await recordAudit(tx, { actorId: actor.userId, action: 'community.moderator_assign', targetType: 'community_space', targetId: space.row.id, metadata: { userId } })
  })
  return listModerators(db, actor, space.row.id)
}

/** DELETE /operator/community/spaces/:id/moderators/:userId — 지정 해제(left). */
export async function unassignModerator(db: DbExecutor, actor: Actor, spaceId: unknown, userId: unknown, now = new Date()): Promise<{ userIds: string[] }> {
  const space = await operatorSpace(db, actor, spaceId)
  if (!isUuid(userId)) throw notFound()
  await db.transaction(async (tx) => {
    const existing = await findMembership(tx, space.row.id, userId.toLowerCase(), true)
    if (!existing || existing.role !== 'moderator' || existing.status !== 'active') throw notFound()
    await tx.update(spaceMemberships).set({ status: 'left', role: 'member', endedAt: now, updatedAt: now }).where(eq(spaceMemberships.id, existing.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.moderator_unassign', targetType: 'community_space', targetId: space.row.id, metadata: { userId: existing.userId } })
  })
  return listModerators(db, actor, space.row.id)
}

/** GET /operator/community/spaces/:id/moderators — 공식 페이지 모더레이터 사용자 id. */
export async function listModerators(db: DbExecutor, actor: Actor, spaceId: unknown): Promise<{ userIds: string[] }> {
  const space = await operatorSpace(db, actor, spaceId)
  const rows = await db
    .select({ userId: spaceMemberships.userId })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, space.row.id), eq(spaceMemberships.role, 'moderator'), eq(spaceMemberships.status, 'active')))
    .orderBy(asc(spaceMemberships.joinedAt))
  return { userIds: rows.map((r) => r.userId) }
}
