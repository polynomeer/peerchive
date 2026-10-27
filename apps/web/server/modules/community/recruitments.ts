/**
 * 모집(팀원 찾기·스터디 모집)·지원·마감 (C-07, PROOFU_EVOLUTION_PLAN §8.8·§8.9.5, SYSTEM_DESIGN §6.7 Recruitment·Application·§8.1·§9.1,
 * DELIVERY_PLAN §4.1 C-07, ADR 0024).
 *
 * - 모든 경로는 `/api/v1/community/recruitments/**`(로그인 필수, noindex·no-store)이고 판정은 @peerchive/domain의 canViewRecruitment·
 *   canPostRecruitment·canApply(→ canReadSpace·canWriteBoard·학교 인증)를 거칩니다. 볼 수 없으면 404(존재를 숨김).
 * - **지원자 목록은 모집자만**(GET …/applications). 모더레이터·운영자·다른 지원자는 볼 수 없고(읽을 수 없으면 404, 읽을 수 있으면 403
 *   `recruiter_only`), 운영자 화면·감사 기록에도 지원자가 없습니다(지원·수락·거절은 감사를 남기지 않음 — 감사 조회로 지원자를 찾을 수 없게).
 *   지원 순서는 지원 시각뿐이고 활동량·포크 수·확인 수 같은 필드가 없습니다. 지원자 수는 모집자에게만 보입니다.
 * - 거절 사유는 받지도 저장하지도 않습니다. 거절·마감(선정되지 않음) 알림은 같은 문장입니다.
 * - 마감: 팀원 찾기 → 비공개 과제 공간(모집자 owner, 학기 연결 시 엠바고), 스터디 → createStudyRoomInternal(초대 전용·목록 비노출, 모집 때 고른
 *   이름 표시 방식). 선정된 사람에게는 화면 알림만 보내고, 그 사람이 모집 화면에서 "초대 받기"를 누르면 그때 초대 링크(7일·한 번만, 해시만 저장)를
 *   발급해 돌려줍니다 — 수락해야 멤버가 됩니다(자동 멤버십 없음). 과제 공간 제목은 과목 이름으로 만들고 모집 글 내용은 옮기지 않습니다(커뮤니티 글이
 *   커뮤니티 테이블 밖으로 나가지 않게, C-05 센티넬).
 * - 커뮤니티 모듈은 서버 로그를 남기지 않습니다.
 */
import { z } from 'zod'
import {
  APPLICATION_CASES_MAX,
  APPLICATION_CREATE_LIMIT,
  APPLICATION_MESSAGE_HIDDEN_TEXT,
  APPLICATION_MESSAGE_MAX,
  APPLICATION_STATUS_TEXT,
  RECRUITMENT_CREATE_LIMIT,
  RECRUITMENT_DESCRIPTION_MAX,
  RECRUITMENT_INVITE_LIMIT,
  RECRUITMENT_KINDS,
  type ApplicationStatus,
  type RecruitmentFacts,
  type RecruitmentHostFacts,
  type RecruitmentKind,
  type RecruitmentNoticeKind,
  applicationTransition,
  canAcceptMore,
  canApply,
  canManageSpace,
  canPostRecruitment,
  canReadRecruitmentHost,
  canViewRecruitment,
  checkClosesAt,
  checkOptionalText,
  checkRecruitmentCapacity,
  checkRecruitmentTitle,
  hasSchoolAffiliation,
  isRecruitmentAccepting,
  orderApplications,
  recruitmentOutcome,
  recruitmentTransition,
  roomNameModeFor,
  sanitizeRecruitmentNoticePayload,
  studyRoomNameFor,
  canLinkReleaseToPortfolio,
} from '@peerchive/domain'
import {
  and,
  asc,
  boards,
  communityNotices,
  communitySpaces,
  courseTerms,
  courses,
  desc,
  eq,
  inArray,
  invitations,
  isNull,
  profiles,
  projectMembers,
  publications,
  recruitmentApplications,
  recruitments,
  schools,
  spaceInvitations,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { loadCanonicalTerm } from '../catalog/catalog'
import { requireOperator } from '../catalog/operators'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, rateLimited } from '../errors'
import { HANDLE_PATTERN } from '../identity/profiles'
import { isUuid } from '../projects/access'
import { issueInvitationInTx } from '../projects/invitations'
import { insertProjectInTx } from '../projects/projects'
import { loadServedRelease } from '../publication/public-read'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import {
  type LoadedViewer,
  type SpaceContext,
  findMembership,
  loadReadableSpace,
  loadSpace,
  loadSpaceContext,
  loadViewer,
  membershipFacts,
  writeRestricted,
} from './access'
import { issueSpaceInvitationInTx } from './invitations'
import { createStudyRoomInternal } from './spaces'
import type {
  ApplicationAttachmentOptionsDto,
  ApplicationAttachmentsDto,
  CourseTeamFindingEntryDto,
  MyApplicationDto,
  MyRecruitmentsDto,
  OperatorRecruitmentItemDto,
  RecruitmentApplicationDto,
  RecruitmentDetailDto,
  RecruitmentListDto,
  RecruitmentSummaryDto,
} from '../../../shared/types/api'

type RecruitmentRow = typeof recruitments.$inferSelect
type ApplicationRow = typeof recruitmentApplications.$inferSelect

/** 목록 한 번에 최대 50개(최근 것부터). */
export const RECRUITMENT_PAGE_SIZE = 50

// ── 판정 재료 ────────────────────────────────────────────────────────────

/** 과목(정본) + 정본 학교 + 팀원 찾기 꺼짐. */
export interface CourseFacts {
  id: string
  title: string
  code: string | null
  schoolId: string
  schoolName: string
  teamFindingDisabled: boolean
}

/** 과목 id(병합된 id도 됨) → 정본 과목 사실. 없으면 null. */
export async function loadCourseFacts(db: DbExecutor, courseId: string): Promise<CourseFacts | null> {
  const [row] = await db
    .select({ id: courses.id, mergedInto: courses.mergedInto })
    .from(courses)
    .where(eq(courses.id, courseId.toLowerCase()))
    .limit(1)
  if (!row) return null
  const id = row.mergedInto ?? row.id
  const [c] = await db
    .select({
      id: courses.id,
      title: courses.title,
      code: courses.code,
      teamFindingDisabled: courses.teamFindingDisabled,
      schoolId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
      schoolName: sql<string>`coalesce((select s2.name from schools s2 where s2.id = ${schools.mergedInto}), ${schools.name})`,
    })
    .from(courses)
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(eq(courses.id, id))
    .limit(1)
  return c ?? null
}

interface RecruitmentContext {
  row: RecruitmentRow
  viewer: LoadedViewer
  host: SpaceContext | null
  course: CourseFacts | null
  facts: RecruitmentFacts
}

function hostFacts(host: SpaceContext | null, course: CourseFacts | null): RecruitmentHostFacts {
  return {
    host: host ? { space: host.facts, membership: membershipFacts(host.membership) } : null,
    courseSchoolId: course?.schoolId ?? null,
  }
}

function recruitmentFacts(row: RecruitmentRow, host: SpaceContext | null, course: CourseFacts | null): RecruitmentFacts {
  return {
    ...hostFacts(host, course),
    kind: row.kind,
    createdBy: row.createdBy,
    status: row.status,
    closesAt: row.closesAt,
    hidden: row.hiddenAt !== null,
    teamFindingDisabled: course?.teamFindingDisabled ?? false,
  }
}

async function loadRow(db: DbExecutor, id: unknown, lock: boolean): Promise<RecruitmentRow> {
  if (!isUuid(id)) throw notFound()
  const query = db.select().from(recruitments).where(eq(recruitments.id, id.toLowerCase())).limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

/** 모집 + 판정 재료. 볼 수 없으면 404. `lock`이면 모집 행을 FOR UPDATE(공간보다 먼저 잠그지 않음: 공간은 읽기만). */
async function loadViewableRecruitment(db: DbExecutor, actor: Actor, id: unknown, now: Date, lock = false): Promise<RecruitmentContext> {
  const row = await loadRow(db, id, lock)
  const host = row.spaceId ? await loadSpaceContext(db, actor, row.spaceId, false, now) : null
  const viewer = host ? host.viewer : await loadViewer(db, actor, null, now)
  const course = row.courseId ? await loadCourseFacts(db, row.courseId) : null
  const facts = recruitmentFacts(row, host, course)
  if (!canViewRecruitment(viewer, facts)) throw notFound()
  return { row, viewer, host, course, facts }
}

const isRecruiter = (ctx: RecruitmentContext, actor: Actor) => ctx.row.createdBy === actor.userId

// ── DTO ──────────────────────────────────────────────────────────────────

async function termsById(db: DbExecutor, ids: string[]): Promise<Map<string, { id: string; year: number; semester: 'spring' | 'summer' | 'fall' | 'winter' }>> {
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: courseTerms.id, year: courseTerms.year, semester: courseTerms.semester }).from(courseTerms).where(inArray(courseTerms.id, ids))
  return new Map(rows.map((r) => [r.id, r]))
}

async function myStatuses(db: DbExecutor, userId: string, recruitmentIds: string[]): Promise<Map<string, ApplicationStatus>> {
  if (recruitmentIds.length === 0) return new Map()
  const rows = await db
    .select({ recruitmentId: recruitmentApplications.recruitmentId, status: recruitmentApplications.status })
    .from(recruitmentApplications)
    .where(and(eq(recruitmentApplications.applicantId, userId), inArray(recruitmentApplications.recruitmentId, recruitmentIds)))
  return new Map(rows.map((r) => [r.recruitmentId, r.status]))
}

function toSummary(
  row: RecruitmentRow,
  ctx: { host: SpaceContext | null; course: CourseFacts | null },
  actor: Actor,
  term: { id: string; year: number; semester: 'spring' | 'summer' | 'fall' | 'winter' } | null,
  myStatus: ApplicationStatus | null,
  now: Date,
): RecruitmentSummaryDto {
  const mine = row.createdBy === actor.userId
  const space = ctx.host?.space ?? null
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    capacity: row.capacity,
    closesAt: row.closesAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    accepting: row.hiddenAt === null && isRecruitmentAccepting(row, now),
    course: ctx.course ? { id: ctx.course.id, title: ctx.course.title, code: ctx.course.code, schoolName: ctx.course.schoolName } : null,
    term,
    space: space ? { slug: space.row.slug, name: space.row.name, official: space.row.kind === 'official_school' || space.row.kind === 'official_department' } : null,
    roomNameMode: row.roomNameMode,
    mine,
    hidden: mine && row.hiddenAt !== null,
    myApplicationStatus: myStatus,
  }
}

/**
 * 첨부를 지금 기준으로 다시 확인합니다: 프로필은 지원자 본인의 것이고 숨기지 않았으며 계정이 active, 공개 사례는 지금 제공 중이고 지원자가 그 과제의
 * active 멤버. 아니면 응답에서 뺍니다(철회·숨김된 사례는 사라짐).
 */
async function liveAttachments(db: DbExecutor, applicantId: string, handle: string | null, slugs: readonly string[], now: Date): Promise<ApplicationAttachmentsDto> {
  let profile: ApplicationAttachmentsDto['profile'] = null
  if (handle) {
    const [p] = await db
      .select({ handle: profiles.handle })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(eq(profiles.userId, applicantId), eq(profiles.handle, handle), isNull(profiles.hiddenAt), eq(users.status, 'active')))
      .limit(1)
    profile = p ? { handle: p.handle } : null
  }
  const cases: ApplicationAttachmentsDto['cases'] = []
  for (const slug of slugs) {
    const c = await ownServedCase(db, applicantId, slug, now)
    if (c) cases.push(c)
  }
  return { profile, cases }
}

/**
 * 지원자가 active 멤버인 과제의, 지금 제공 중인 공개 사례. 아니면 null.
 * 익명 스터디 방의 기록(C-08, ADR 0026)은 사람과 연결하지 않으므로 첨부할 수 없고(not_yours와 같은 응답), 이미 붙인 것도 읽을 때 빠집니다.
 */
async function ownServedCase(db: DbExecutor, userId: string, slug: string, now: Date): Promise<{ slug: string; title: string } | null> {
  const served = await loadServedRelease(db, slug, now)
  if (!served || !canLinkReleaseToPortfolio(served.snapshot)) return null
  const [m] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, served.publication.projectId), eq(projectMembers.userId, userId), eq(projectMembers.status, 'active')))
    .limit(1)
  return m ? { slug: served.publication.slug, title: served.snapshot.title } : null
}

async function toMyApplication(db: DbExecutor, app: ApplicationRow, recruitment: RecruitmentSummaryDto | null, recRow: RecruitmentRow | null, now: Date): Promise<MyApplicationDto> {
  return {
    id: app.id,
    status: app.status,
    statusText: APPLICATION_STATUS_TEXT[app.status],
    message: app.message,
    attachments: await liveAttachments(db, app.applicantId, app.profileHandle, app.caseSlugs, now),
    createdAt: app.createdAt.toISOString(),
    invitationAvailable: app.status === 'accepted' && recRow?.status === 'closed' && (recRow.resultProjectId !== null || recRow.resultSpaceId !== null),
    recruitment: recruitment ? { id: recruitment.id, kind: recruitment.kind, title: recruitment.title, status: recruitment.status } : null,
  }
}

async function countApplications(db: DbExecutor, recruitmentId: string): Promise<Record<ApplicationStatus, number>> {
  const rows = await db
    .select({ status: recruitmentApplications.status, n: sql<number>`count(*)::int` })
    .from(recruitmentApplications)
    .where(eq(recruitmentApplications.recruitmentId, recruitmentId))
    .groupBy(recruitmentApplications.status)
  const out: Record<ApplicationStatus, number> = { pending: 0, accepted: 0, declined: 0, withdrawn: 0 }
  for (const r of rows) out[r.status] = r.n
  return out
}

async function detailOf(db: DbExecutor, actor: Actor, ctx: RecruitmentContext, now: Date): Promise<RecruitmentDetailDto> {
  const { row } = ctx
  const [app] = await db
    .select()
    .from(recruitmentApplications)
    .where(and(eq(recruitmentApplications.recruitmentId, row.id), eq(recruitmentApplications.applicantId, actor.userId)))
    .limit(1)
  const term = row.termId ? ((await termsById(db, [row.termId])).get(row.termId) ?? null) : null
  const summary = toSummary(row, ctx, actor, term, app?.status ?? null, now)
  const decision = canApply(ctx.viewer, ctx.facts, app ?? null, now)
  const recruiter = isRecruiter(ctx, actor)
  let resultSlug: string | null = null
  if (recruiter && row.resultSpaceId) {
    const [s] = await db.select({ slug: communitySpaces.slug }).from(communitySpaces).where(eq(communitySpaces.id, row.resultSpaceId)).limit(1)
    resultSlug = s?.slug ?? null
  }
  const counts = recruiter ? await countApplications(db, row.id) : null
  return {
    ...summary,
    description: row.description,
    canApply: decision.ok,
    applyBlockedReason: decision.ok ? null : decision.reason,
    myApplication: app ? await toMyApplication(db, app, summary, row, now) : null,
    recruiter: counts
      ? {
          applicationCount: counts.pending + counts.accepted + counts.declined,
          pendingCount: counts.pending,
          acceptedCount: counts.accepted,
          result: { projectId: row.resultProjectId, spaceSlug: resultSlug },
        }
      : null,
    canReport: !recruiter && row.hiddenAt === null,
  }
}

// ── 만들기 ───────────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const createRecruitmentSchema = z.object({
  kind: z.enum(RECRUITMENT_KINDS, { error: requiredOr('invalid') }),
  spaceSlug: z.string({ error: 'invalid' }).nullish(),
  courseId: z.uuid({ error: 'invalid' }).nullish(),
  termId: z.uuid({ error: 'invalid' }).nullish(),
  title: z.unknown(),
  description: z.unknown().optional(),
  capacity: z.unknown(),
  closesAt: z.unknown().optional(),
  roomNameMode: z.unknown().optional(),
})

/** 공간의 모집 게시판(첫 번째). 없으면 null. */
async function recruitingBoardOf(db: DbExecutor, spaceId: string): Promise<{ kind: 'recruiting'; writeRole: 'member' | 'moderator' } | null> {
  const [b] = await db
    .select({ writeRole: boards.writeRole })
    .from(boards)
    .where(and(eq(boards.spaceId, spaceId), eq(boards.kind, 'recruiting')))
    .orderBy(asc(boards.position), asc(boards.createdAt))
    .limit(1)
  return b ? { kind: 'recruiting', writeRole: b.writeRole } : null
}

function postError(reason: string): ServiceError {
  switch (reason) {
    case 'not_found':
      return notFound()
    case 'write_restricted':
      return new ServiceError('FORBIDDEN', 'write_restricted')
    case 'affiliation_required':
      return new ServiceError('FORBIDDEN', 'affiliation_required', undefined, { requirement: 'school_affiliation' })
    case 'write_not_allowed':
      return forbidden('write_not_allowed')
    case 'course_required':
      return invalid({ courseId: 'required' })
    case 'host_required':
      return invalid({ spaceSlug: 'required' })
    default:
      // no_recruiting_board, team_finding_disabled
      return conflict(reason)
  }
}

/**
 * POST /community/recruitments {kind, spaceSlug?, courseId?, termId?, title, description?, capacity, closesAt?, roomNameMode?} — 201 상세.
 * 403 `affiliation_required`(과목 학교 인증 없음)·`write_not_allowed`·`write_restricted`, 404(읽을 수 없는 공간·없는 과목), 409 `no_recruiting_board`·
 * `team_finding_disabled`, 422(`title`·`description`·`capacity`·`closesAt`·`courseId: required`·`termId: not_in_course`·`roomNameMode`), 429(하루 5개).
 */
export async function createRecruitment(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<RecruitmentDetailDto> {
  const input = parseInput(createRecruitmentSchema, rawInput)
  const fields: Record<string, string> = {}
  const title = checkRecruitmentTitle(input.title)
  if (!title.ok) fields.title = title.reason
  const description = checkOptionalText(input.description, RECRUITMENT_DESCRIPTION_MAX)
  if (!description.ok) fields.description = description.reason
  const capacity = checkRecruitmentCapacity(input.capacity)
  if (!capacity.ok) fields.capacity = capacity.reason
  const closesAt = checkClosesAt(input.closesAt, now)
  if (!closesAt.ok) fields.closesAt = closesAt.reason
  const roomMode = roomNameModeFor(input.kind, input.roomNameMode)
  if (!roomMode.ok) fields.roomNameMode = roomMode.reason
  // 스터디는 마감 때 방 이름이 되므로 공간 이름 규칙(예약어 포함)을 미리 확인합니다.
  if (title.ok && input.kind === 'study') {
    const room = studyRoomNameFor(title.value)
    if (!room.ok) fields.title = room.reason
  }
  if (input.termId && !input.courseId) fields.termId = 'not_in_course'
  if (Object.keys(fields).length) throw invalid(fields)

  const id = await db.transaction(async (tx) => {
    // 공간은 읽기만 하므로 FOR SHARE(보관·제한과 겹치지 않게).
    const host = input.spaceSlug ? await loadSpaceContext(tx, actor, input.spaceSlug, false, now) : null
    if (host) await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.id, host.space.row.id)).for('share')
    const course = input.courseId ? await loadCourseFacts(tx, input.courseId) : null
    if (input.courseId && !course) throw notFound()
    let termId: string | null = null
    if (input.termId) {
      const term = await loadCanonicalTerm(tx, input.termId.toLowerCase())
      const termCourse = term ? await loadCourseFacts(tx, term.courseId) : null
      if (!term || !termCourse || termCourse.id !== course!.id) throw invalid({ termId: 'not_in_course' })
      termId = term.id
    }
    const viewer = host ? host.viewer : await loadViewer(tx, actor, null, now)
    const decision = canPostRecruitment(viewer, {
      ...hostFacts(host, course),
      kind: input.kind,
      hasCourse: course !== null,
      teamFindingDisabled: course?.teamFindingDisabled ?? false,
      recruitingBoard: host ? await recruitingBoardOf(tx, host.space.row.id) : null,
    })
    if (!decision.ok) {
      if (decision.reason === 'write_restricted' && viewer.writeRestriction) throw writeRestricted(viewer.writeRestriction)
      throw postError(decision.reason)
    }
    if (!(await hitRateLimit(tx, 'community_recruitment_create', actor.userId, RECRUITMENT_CREATE_LIMIT, now))) throw rateLimited()
    const [row] = await tx
      .insert(recruitments)
      .values({
        kind: input.kind,
        spaceId: host?.space.row.id ?? null,
        courseId: course?.id ?? null,
        termId,
        title: (title as { value: string }).value,
        description: (description as { value: string }).value,
        capacity: (capacity as { value: number }).value,
        roomNameMode: (roomMode as { value: 'real' | 'display' | 'anonymous' | null }).value,
        closesAt: (closesAt as { value: Date | null }).value,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.recruitment_create',
      targetType: 'community_recruitment',
      targetId: row!.id,
      metadata: { kind: row!.kind, spaceId: row!.spaceId, courseId: row!.courseId },
    })
    await emitAnalytics(tx, { name: 'recruitment_created', actorId: actor.userId, props: { kind: row!.kind }, now })
    return row!.id
  })
  return getRecruitment(db, actor, id, now)
}

// ── 읽기 ─────────────────────────────────────────────────────────────────

/** GET /community/recruitments/:id — 볼 수 있으면 상세(모집자에게는 지원 수·결과 링크), 아니면 404. */
export async function getRecruitment(db: DbExecutor, actor: Actor, id: unknown, now = new Date()): Promise<RecruitmentDetailDto> {
  const ctx = await loadViewableRecruitment(db, actor, id, now)
  return detailOf(db, actor, ctx, now)
}

const listSchema = z.object({
  space: z.string({ error: 'invalid' }).optional(),
  course: z.string({ error: 'invalid' }).optional(),
  kind: z.enum(RECRUITMENT_KINDS, { error: 'invalid' }).optional(),
})

/**
 * GET /community/recruitments?space=slug | ?course=id [&kind=] — 공간(읽을 수 있는 사람) 또는 과목(그 학교 인증 사용자) 맥락의 모집 목록.
 * 최근 것부터 50개. 가린 모집·팀원 찾기가 꺼진 과목의 팀원 모집은 모집자 본인에게만 나옵니다. 읽을 수 없으면 404.
 */
export async function listRecruitments(db: DbExecutor, actor: Actor, query: unknown, now = new Date()): Promise<RecruitmentListDto> {
  const q = parseInput(listSchema, query)
  if (!q.space === !q.course) throw invalid({ space: 'required' })
  let host: SpaceContext | null = null
  let course: CourseFacts | null = null
  let viewer: LoadedViewer
  let where
  if (q.space) {
    host = await loadReadableSpace(db, actor, q.space, false, now)
    viewer = host.viewer
    where = eq(recruitments.spaceId, host.space.row.id)
  } else {
    if (!isUuid(q.course)) throw notFound()
    course = await loadCourseFacts(db, q.course)
    viewer = await loadViewer(db, actor, null, now)
    // 과목 맥락은 그 과목 학교(정본)의 active 인증 사용자만(공개 과목 허브와 달리 커뮤니티 데이터). 아니면 404.
    if (!course || viewer.status !== 'active' || !hasSchoolAffiliation(viewer, course.schoolId)) throw notFound()
    where = eq(recruitments.courseId, course.id)
  }
  const rows = await db
    .select()
    .from(recruitments)
    .where(and(where, q.kind ? eq(recruitments.kind, q.kind) : undefined))
    .orderBy(desc(recruitments.createdAt), desc(recruitments.id))
    .limit(RECRUITMENT_PAGE_SIZE * 2)
  const items = await visibleSummaries(db, actor, viewer, rows, { host, course }, now)

  const board = host ? await recruitingBoardOf(db, host.space.row.id) : null
  const post = (kind: RecruitmentKind) =>
    canPostRecruitment(viewer, {
      ...hostFacts(host, course),
      kind,
      hasCourse: course !== null,
      teamFindingDisabled: course?.teamFindingDisabled ?? false,
      recruitingBoard: board,
    })
  const team = post('team')
  const study = post('study')
  const terms = course
    ? await db
        .select({ id: courseTerms.id, year: courseTerms.year, semester: courseTerms.semester })
        .from(courseTerms)
        .where(and(eq(courseTerms.courseId, course.id), isNull(courseTerms.mergedInto)))
        .orderBy(desc(courseTerms.year), desc(courseTerms.semester))
        .limit(20)
    : []
  return {
    context: {
      space: host ? { slug: host.space.row.slug, name: host.space.row.name, official: host.space.row.kind === 'official_school' || host.space.row.kind === 'official_department' } : null,
      course: course ? { id: course.id, title: course.title, code: course.code, schoolName: course.schoolName } : null,
    },
    items: items.slice(0, RECRUITMENT_PAGE_SIZE),
    canPost: { team: team.ok, study: study.ok },
    postBlockedReasons: { team: team.ok ? null : team.reason, study: study.ok ? null : study.reason },
    teamFindingDisabled: course?.teamFindingDisabled ?? false,
    terms,
  }
}

/** 행들을 판정해 볼 수 있는 것만 카드로. 공간·과목 판정 재료는 행마다 읽되 같은 것은 한 번만. */
async function visibleSummaries(
  db: DbExecutor,
  actor: Actor,
  viewer: LoadedViewer,
  rows: RecruitmentRow[],
  known: { host: SpaceContext | null; course: CourseFacts | null },
  now: Date,
): Promise<RecruitmentSummaryDto[]> {
  const hosts = new Map<string, SpaceContext | null>()
  if (known.host) hosts.set(known.host.space.row.id, known.host)
  const coursesBy = new Map<string, CourseFacts | null>()
  if (known.course) coursesBy.set(known.course.id, known.course)
  const visible: Array<{ row: RecruitmentRow; host: SpaceContext | null; course: CourseFacts | null }> = []
  for (const row of rows) {
    let host: SpaceContext | null = null
    if (row.spaceId) {
      if (!hosts.has(row.spaceId)) hosts.set(row.spaceId, await loadSpaceContext(db, actor, row.spaceId, false, now).catch(() => null))
      host = hosts.get(row.spaceId) ?? null
      if (!host) continue
    }
    let course: CourseFacts | null = null
    if (row.courseId) {
      if (!coursesBy.has(row.courseId)) coursesBy.set(row.courseId, await loadCourseFacts(db, row.courseId))
      course = coursesBy.get(row.courseId) ?? null
    }
    // 공간 기준 판정은 그 공간의 viewer(공간 범위 제재 포함), 아니면 공간 밖 viewer.
    if (!canViewRecruitment(host ? host.viewer : viewer, recruitmentFacts(row, host, course))) continue
    visible.push({ row, host, course })
  }
  const terms = await termsById(db, [...new Set(visible.map((v) => v.row.termId).filter((x): x is string => !!x))])
  const statuses = await myStatuses(db, actor.userId, visible.map((v) => v.row.id))
  return visible.map((v) => toSummary(v.row, v, actor, v.row.termId ? (terms.get(v.row.termId) ?? null) : null, statuses.get(v.row.id) ?? null, now))
}

/** GET /community/recruitments/mine — 내가 올린 모집(볼 수 있는 것)과 내 지원(상태만, 지금 볼 수 없는 모집이면 제목 없음). */
export async function listMyRecruitments(db: DbExecutor, actor: Actor, now = new Date()): Promise<MyRecruitmentsDto> {
  const viewer = await loadViewer(db, actor, null, now)
  const created = await db
    .select()
    .from(recruitments)
    .where(eq(recruitments.createdBy, actor.userId))
    .orderBy(desc(recruitments.createdAt), desc(recruitments.id))
    .limit(RECRUITMENT_PAGE_SIZE)
  const createdDtos = await visibleSummaries(db, actor, viewer, created, { host: null, course: null }, now)
  const apps = await db
    .select()
    .from(recruitmentApplications)
    .where(eq(recruitmentApplications.applicantId, actor.userId))
    .orderBy(desc(recruitmentApplications.createdAt), desc(recruitmentApplications.id))
    .limit(RECRUITMENT_PAGE_SIZE)
  const recRows = apps.length ? await db.select().from(recruitments).where(inArray(recruitments.id, apps.map((a) => a.recruitmentId))) : []
  const recById = new Map(recRows.map((r) => [r.id, r]))
  const visible = new Map((await visibleSummaries(db, actor, viewer, recRows, { host: null, course: null }, now)).map((s) => [s.id, s]))
  const applications: MyApplicationDto[] = []
  for (const app of apps) {
    const summary = visible.get(app.recruitmentId) ?? null
    applications.push(await toMyApplication(db, app, summary, summary ? (recById.get(app.recruitmentId) ?? null) : null, now))
  }
  return { created: createdDtos, applications }
}

/**
 * GET /community/recruitments/course-entry?courseId= — 과목 허브의 "이 과목 팀원 찾기" 링크를 보일지. 그 과목 학교 인증이 있고 팀원 찾기가
 * 꺼지지 않았을 때만 true. 과목이 없거나 형식이 틀리면 404. 공개 과목 허브 응답은 이 값을 모릅니다(화면이 로그인한 경우에만 따로 물음).
 */
export async function courseTeamFindingEntry(db: DbExecutor, actor: Actor, courseId: unknown, now = new Date()): Promise<CourseTeamFindingEntryDto> {
  if (!isUuid(courseId)) throw notFound()
  const course = await loadCourseFacts(db, courseId)
  if (!course) throw notFound()
  const viewer = await loadViewer(db, actor, null, now)
  return { available: viewer.status === 'active' && hasSchoolAffiliation(viewer, course.schoolId) && !course.teamFindingDisabled }
}

/** GET /community/recruitments/attachment-options — 지원서에 붙일 수 있는 내 공개 프로필·내가 팀원인 지금 공개 중인 사례(최대 20개). */
export async function attachmentOptions(db: DbExecutor, actor: Actor, now = new Date()): Promise<ApplicationAttachmentOptionsDto> {
  const [p] = await db
    .select({ handle: profiles.handle })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(profiles.userId, actor.userId), isNull(profiles.hiddenAt), eq(users.status, 'active')))
    .limit(1)
  const pubs = await db
    .select({ slug: publications.slug })
    .from(publications)
    .innerJoin(projectMembers, eq(projectMembers.projectId, publications.projectId))
    .where(and(eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active'), eq(publications.status, 'published')))
    .orderBy(desc(publications.updatedAt))
    .limit(20)
  const cases: ApplicationAttachmentOptionsDto['cases'] = []
  for (const { slug } of pubs) {
    const c = await ownServedCase(db, actor.userId, slug, now)
    if (c) cases.push(c)
  }
  return { profile: p ? { handle: p.handle } : null, cases }
}

// ── 지원 ─────────────────────────────────────────────────────────────────

export const applySchema = z.object({
  message: z.unknown().optional(),
  attachProfile: z.boolean({ error: 'invalid' }).optional(),
  caseSlugs: z.array(z.string({ error: 'invalid' }).trim().toLowerCase(), { error: 'invalid' }).max(APPLICATION_CASES_MAX, { error: 'too_many' }).optional(),
})

function applyError(reason: string, ctx: RecruitmentContext): ServiceError {
  if (reason === 'not_found') return notFound()
  if (reason === 'write_restricted') return ctx.viewer.writeRestriction ? writeRestricted(ctx.viewer.writeRestriction) : forbidden('write_restricted')
  if (reason === 'own_recruitment') return forbidden('own_recruitment')
  return conflict(reason)
}

/**
 * POST /community/recruitments/:id/applications {message?, attachProfile?, caseSlugs?} — 201 내 지원. 첨부는 지원자 자신의 공개 프로필과 자신이
 * 팀원인 지금 공개 중인 사례만(아니면 422 `attachProfile: not_public`·`caseSlugs.N: not_yours`). 404, 403 `own_recruitment`·`write_restricted`,
 * 409 `recruitment_not_open`·`already_applied`, 422, 429(하루 20번). 감사 기록은 남기지 않습니다(지원자 목록은 모집자만).
 */
export async function applyToRecruitment(db: DbExecutor, actor: Actor, id: unknown, rawInput: unknown, now = new Date()): Promise<MyApplicationDto> {
  const input = parseInput(applySchema, rawInput)
  const message = checkOptionalText(input.message, APPLICATION_MESSAGE_MAX)
  if (!message.ok) throw invalid({ message: message.reason })
  const slugs = [...new Set(input.caseSlugs ?? [])]
  return db.transaction(async (tx) => {
    const ctx = await loadViewableRecruitment(tx, actor, id, now, true)
    const [existing] = await tx
      .select({ status: recruitmentApplications.status })
      .from(recruitmentApplications)
      .where(and(eq(recruitmentApplications.recruitmentId, ctx.row.id), eq(recruitmentApplications.applicantId, actor.userId)))
      .limit(1)
    const decision = canApply(ctx.viewer, ctx.facts, existing ?? null, now)
    if (!decision.ok) throw applyError(decision.reason, ctx)
    // 첨부 확인(지원 시점).
    let handle: string | null = null
    const fields: Record<string, string> = {}
    if (input.attachProfile) {
      const [p] = await tx
        .select({ handle: profiles.handle })
        .from(profiles)
        .where(and(eq(profiles.userId, actor.userId), isNull(profiles.hiddenAt)))
        .limit(1)
      if (!p || !HANDLE_PATTERN.test(p.handle)) fields.attachProfile = 'not_public'
      else handle = p.handle
    }
    for (const [i, slug] of slugs.entries()) if (!(await ownServedCase(tx, actor.userId, slug, now))) fields[`caseSlugs.${i}`] = 'not_yours'
    if (Object.keys(fields).length) throw invalid(fields)
    if (!(await hitRateLimit(tx, 'community_application_create', actor.userId, APPLICATION_CREATE_LIMIT, now))) throw rateLimited()
    const [app] = await tx
      .insert(recruitmentApplications)
      .values({ recruitmentId: ctx.row.id, applicantId: actor.userId, message: message.value, profileHandle: handle, caseSlugs: slugs, createdAt: now, updatedAt: now })
      .returning()
    await emitAnalytics(tx, { name: 'application_submitted', actorId: actor.userId, props: { kind: ctx.row.kind }, now })
    return toMyApplication(tx, app!, null, ctx.row, now)
  })
}

/** POST /community/recruitments/:id/withdraw — 지원자 본인이 모집 중에 지원을 취소. 200. 404, 409 `not_applied`·`recruitment_not_open`·`not_withdrawable`. */
export async function withdrawApplication(db: DbExecutor, actor: Actor, id: unknown, now = new Date()): Promise<MyApplicationDto> {
  return db.transaction(async (tx) => {
    const ctx = await loadViewableRecruitment(tx, actor, id, now, true)
    const [app] = await tx
      .select()
      .from(recruitmentApplications)
      .where(and(eq(recruitmentApplications.recruitmentId, ctx.row.id), eq(recruitmentApplications.applicantId, actor.userId)))
      .limit(1)
      .for('update')
    if (!app) throw conflict('not_applied')
    if (ctx.row.status !== 'open') throw conflict('recruitment_not_open')
    const next = applicationTransition(app.status, 'withdraw')
    if (!next) throw conflict('not_withdrawable')
    const [updated] = await tx
      .update(recruitmentApplications)
      .set({ status: next, decidedAt: now, updatedAt: now })
      .where(eq(recruitmentApplications.id, app.id))
      .returning()
    return toMyApplication(tx, updated!, null, ctx.row, now)
  })
}

// ── 모집자 ───────────────────────────────────────────────────────────────

/** 모집자만(읽을 수 없으면 404, 읽을 수 있지만 모집자가 아니면 403 `recruiter_only`). 모더레이터·운영자도 같습니다. */
async function loadAsRecruiter(db: DbExecutor, actor: Actor, id: unknown, now: Date, lock = false): Promise<RecruitmentContext> {
  const ctx = await loadViewableRecruitment(db, actor, id, now, lock)
  if (!isRecruiter(ctx, actor)) throw forbidden('recruiter_only')
  return ctx
}

/**
 * GET /community/recruitments/:id/applications — **모집자만**. 지원 시각 순서(같으면 id)만, 철회한 지원은 빼고, 지원자는 표시 이름과 지원자가 붙인
 * 공개 첨부(지금도 공개인 것)만. 활동량·포크 수·확인 수·순위·거절 사유 필드는 없습니다.
 */
export async function listApplications(db: DbExecutor, actor: Actor, id: unknown, now = new Date()): Promise<RecruitmentApplicationDto[]> {
  const ctx = await loadAsRecruiter(db, actor, id, now)
  const rows = await db
    .select({ app: recruitmentApplications, displayName: users.displayName })
    .from(recruitmentApplications)
    .innerJoin(users, eq(users.id, recruitmentApplications.applicantId))
    .where(and(eq(recruitmentApplications.recruitmentId, ctx.row.id), sql`${recruitmentApplications.status} <> 'withdrawn'`))
    .orderBy(asc(recruitmentApplications.createdAt), asc(recruitmentApplications.id))
  const ordered = orderApplications(rows.map((r) => ({ ...r, id: r.app.id, createdAt: r.app.createdAt })))
  const out: RecruitmentApplicationDto[] = []
  for (const r of ordered) out.push(await toRecruiterApplication(db, r.app, r.displayName, now))
  return out
}

async function toRecruiterApplication(db: DbExecutor, app: ApplicationRow, displayName: string, now: Date): Promise<RecruitmentApplicationDto> {
  const hidden = app.messageHiddenAt !== null
  return {
    id: app.id,
    applicant: { displayName },
    message: hidden ? APPLICATION_MESSAGE_HIDDEN_TEXT : app.message,
    messageHidden: hidden,
    attachments: await liveAttachments(db, app.applicantId, app.profileHandle, app.caseSlugs, now),
    status: app.status,
    createdAt: app.createdAt.toISOString(),
    decidedAt: app.decidedAt?.toISOString() ?? null,
  }
}

async function loadApplicationOf(tx: DbExecutor, recruitmentId: string, applicationId: unknown): Promise<ApplicationRow> {
  if (!isUuid(applicationId)) throw notFound()
  const [app] = await tx
    .select()
    .from(recruitmentApplications)
    .where(and(eq(recruitmentApplications.id, applicationId.toLowerCase()), eq(recruitmentApplications.recruitmentId, recruitmentId)))
    .limit(1)
    .for('update')
  if (!app) throw notFound()
  return app
}

async function notify(tx: DbExecutor, recruitment: RecruitmentRow, userIds: string[], kind: RecruitmentNoticeKind, now: Date): Promise<void> {
  if (userIds.length === 0) return
  const payload = sanitizeRecruitmentNoticePayload({ recruitmentKind: recruitment.kind })
  if (!payload) throw new Error('recruitment notice payload not allowed')
  // 계정이 active인 사람에게만(탈퇴 요청 계정 제외). 모집·사람·종류마다 한 행(unique).
  const active = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, userIds), eq(users.status, 'active')))
  if (active.length === 0) return
  await tx
    .insert(communityNotices)
    .values(active.map((u) => ({ userId: u.id, spaceId: null, recruitmentId: recruitment.id, kind, payload: { ...payload }, createdAt: now })))
    .onConflictDoNothing()
}

/** POST /community/recruitments/:id/applications/:appId/accept — 모집자, 모집 중, 검토 중인 지원, 모집 인원까지(409 `capacity_full`). 200 목록 한 줄. */
export async function acceptApplication(db: DbExecutor, actor: Actor, id: unknown, applicationId: unknown, now = new Date()): Promise<RecruitmentApplicationDto> {
  return db.transaction(async (tx) => {
    const ctx = await loadAsRecruiter(tx, actor, id, now, true)
    if (ctx.row.status !== 'open') throw conflict('recruitment_not_open')
    const app = await loadApplicationOf(tx, ctx.row.id, applicationId)
    const next = applicationTransition(app.status, 'accept')
    if (!next) throw conflict('not_pending')
    const counts = await countApplications(tx, ctx.row.id)
    if (!canAcceptMore(counts.accepted, ctx.row.capacity)) throw conflict('capacity_full', { capacity: ctx.row.capacity })
    const [updated] = await tx.update(recruitmentApplications).set({ status: next, decidedAt: now, updatedAt: now }).where(eq(recruitmentApplications.id, app.id)).returning()
    const [u] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, app.applicantId)).limit(1)
    return toRecruiterApplication(tx, updated!, u?.displayName ?? '', now)
  })
}

/**
 * POST /community/recruitments/:id/applications/:appId/decline — 모집자, 모집 중, 검토 중·선정된 지원. **사유를 받지 않습니다**(본문은 무시).
 * 지원자에게 "모집이 마감되었거나 선정되지 않았습니다" 알림. 200.
 */
export async function declineApplication(db: DbExecutor, actor: Actor, id: unknown, applicationId: unknown, now = new Date()): Promise<RecruitmentApplicationDto> {
  return db.transaction(async (tx) => {
    const ctx = await loadAsRecruiter(tx, actor, id, now, true)
    if (ctx.row.status !== 'open') throw conflict('recruitment_not_open')
    const app = await loadApplicationOf(tx, ctx.row.id, applicationId)
    const next = applicationTransition(app.status, 'decline')
    if (!next) throw conflict('not_pending')
    const [updated] = await tx.update(recruitmentApplications).set({ status: next, decidedAt: now, updatedAt: now }).where(eq(recruitmentApplications.id, app.id)).returning()
    await notify(tx, ctx.row, [app.applicantId], 'recruitment_not_selected', now)
    const [u] = await tx.select({ displayName: users.displayName }).from(users).where(eq(users.id, app.applicantId)).limit(1)
    return toRecruiterApplication(tx, updated!, u?.displayName ?? '', now)
  })
}

/**
 * POST /community/recruitments/:id/close — 모집자. 선정된 사람이 한 명 이상(409 `no_accepted`), 모집 중(409 `recruitment_not_open`).
 * - 팀원 찾기: 비공개 과제 공간(owner = 모집자, 제목은 과목 이름 + "팀 과제", 학기가 있으면 연결·엠바고).
 * - 스터디: 스터디 방(초대 전용·목록 비노출·모집 때 고른 이름 표시 방식, owner = 모집자). 커뮤니티 전체 이용 제한 중이면 403 `write_restricted`.
 * 검토 중인 지원은 선정되지 않음으로 닫고 알림, 선정된 사람에게는 "초대를 받을 수 있음" 알림. 200 상세.
 */
export async function closeRecruitment(db: DbExecutor, actor: Actor, id: unknown, now = new Date()): Promise<RecruitmentDetailDto> {
  await db.transaction(async (tx) => {
    const ctx = await loadAsRecruiter(tx, actor, id, now, true)
    const apps = await tx.select().from(recruitmentApplications).where(eq(recruitmentApplications.recruitmentId, ctx.row.id)).for('update')
    const accepted = apps.filter((a) => a.status === 'accepted')
    const t = recruitmentTransition(ctx.row.status, 'close', accepted.length)
    if (!t.ok) throw conflict(t.reason)
    let resultProjectId: string | null = null
    let resultSpaceId: string | null = null
    if (ctx.row.kind === 'team') {
      const course = ctx.course ?? (ctx.row.courseId ? await loadCourseFacts(tx, ctx.row.courseId) : null)
      const title = [...`${course?.title ?? '팀'} 팀 과제`].slice(0, 120).join('')
      const project = await insertProjectInTx(
        tx,
        actor.userId,
        { title, kind: 'team', courseTermId: ctx.row.termId, summaryByStudent: null, goal: null, constraints: null, retroMode: false },
        'recruitment',
      )
      resultProjectId = project.id
    } else {
      const outside = await loadViewer(tx, actor, null, now)
      if (outside.writeRestriction) throw writeRestricted(outside.writeRestriction)
      const name = studyRoomNameFor(ctx.row.title)
      if (!name.ok) throw invalid({ title: name.reason })
      const schoolId = ctx.host?.space.schoolId ?? ctx.course?.schoolId ?? null
      const room = await createStudyRoomInternal(
        tx,
        { ownerId: actor.userId, name: name.value, schoolId, nameMode: ctx.row.roomNameMode ?? 'display', linkedCourseId: ctx.row.courseId },
        now,
      )
      resultSpaceId = room.id
    }
    await tx
      .update(recruitments)
      .set({ status: t.status, closedAt: now, updatedAt: now, resultProjectId, resultSpaceId })
      .where(eq(recruitments.id, ctx.row.id))
    const pending = apps.filter((a) => a.status === 'pending')
    if (pending.length) {
      await tx
        .update(recruitmentApplications)
        .set({ status: 'declined', decidedAt: now, updatedAt: now })
        .where(inArray(recruitmentApplications.id, pending.map((a) => a.id)))
      await notify(tx, ctx.row, pending.map((a) => a.applicantId), 'recruitment_not_selected', now)
    }
    await notify(tx, ctx.row, accepted.map((a) => a.applicantId), 'recruitment_invited', now)
    const outcome = recruitmentOutcome(ctx.row.kind, t.status)!
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.recruitment_close',
      targetType: 'community_recruitment',
      targetId: ctx.row.id,
      metadata: { kind: ctx.row.kind, outcome, accepted: accepted.length, projectId: resultProjectId, spaceId: resultSpaceId },
    })
    await emitAnalytics(tx, { name: 'recruitment_closed', actorId: actor.userId, props: { kind: ctx.row.kind, outcome }, now })
  })
  return getRecruitment(db, actor, id, now)
}

/** POST /community/recruitments/:id/cancel — 모집자, 모집 중. 검토 중·선정된 지원자에게 "모집이 취소되었습니다" 알림(이유 없음). 200 상세. */
export async function cancelRecruitment(db: DbExecutor, actor: Actor, id: unknown, now = new Date()): Promise<RecruitmentDetailDto> {
  await db.transaction(async (tx) => {
    const ctx = await loadAsRecruiter(tx, actor, id, now, true)
    const t = recruitmentTransition(ctx.row.status, 'cancel', 0)
    if (!t.ok) throw conflict(t.reason)
    await tx.update(recruitments).set({ status: t.status, closedAt: now, updatedAt: now }).where(eq(recruitments.id, ctx.row.id))
    const open = await tx
      .select({ applicantId: recruitmentApplications.applicantId })
      .from(recruitmentApplications)
      .where(and(eq(recruitmentApplications.recruitmentId, ctx.row.id), inArray(recruitmentApplications.status, ['pending', 'accepted'])))
    await notify(tx, ctx.row, open.map((a) => a.applicantId), 'recruitment_cancelled', now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.recruitment_cancel',
      targetType: 'community_recruitment',
      targetId: ctx.row.id,
      metadata: { kind: ctx.row.kind, notified: open.length },
    })
    await emitAnalytics(tx, { name: 'recruitment_closed', actorId: actor.userId, props: { kind: ctx.row.kind, outcome: 'cancelled' }, now })
  })
  return getRecruitment(db, actor, id, now)
}

// ── 선정된 지원자의 초대 받기 ────────────────────────────────────────────

export interface IssuedRecruitmentInvitation {
  kind: 'project' | 'space'
  /** 원문 토큰. handler가 URL로 만들어 한 번만 응답합니다. 저장·로그 금지. */
  token: string
}

/**
 * POST /community/recruitments/:id/invitation — 마감된 모집에서 선정된 지원자 본인이 초대 링크를 받습니다(모집자 이름으로 발급, 7일·한 번만).
 * 다시 받으면 이전 링크를 취소합니다. 수락은 기존 초대 화면(과제 `/invite/…`, 스터디 방 `/community/invite/…`)에서 본인이 합니다(자동 멤버십 없음).
 * 404, 409 `not_selected`·`not_closed`·`already_member`·`invitation_unavailable`(모집자가 더는 owner가 아니거나 방이 보관·제한됨), 429(시간당 10번).
 */
export async function issueRecruitmentInvitation(db: DbExecutor, actor: Actor, id: unknown, now = new Date()): Promise<IssuedRecruitmentInvitation> {
  return db.transaction(async (tx) => {
    const ctx = await loadViewableRecruitment(tx, actor, id, now, true)
    const [app] = await tx
      .select()
      .from(recruitmentApplications)
      .where(and(eq(recruitmentApplications.recruitmentId, ctx.row.id), eq(recruitmentApplications.applicantId, actor.userId)))
      .limit(1)
      .for('update')
    if (!app || app.status !== 'accepted') throw conflict('not_selected')
    if (ctx.row.status !== 'closed') throw conflict('not_closed')
    if (!(await hitRateLimit(tx, 'community_recruitment_invite', actor.userId, RECRUITMENT_INVITE_LIMIT, now))) throw rateLimited()
    const recruiterId = ctx.row.createdBy
    if (ctx.row.kind === 'team') {
      const projectId = ctx.row.resultProjectId
      if (!projectId) throw conflict('invitation_unavailable')
      const [owner] = await tx
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, recruiterId), eq(projectMembers.status, 'active')))
        .limit(1)
      if (owner?.role !== 'owner') throw conflict('invitation_unavailable')
      const [already] = await tx
        .select({ status: projectMembers.status })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active')))
        .limit(1)
      if (already) throw conflict('already_member')
      if (app.projectInvitationId) {
        await tx.update(invitations).set({ revokedAt: now }).where(and(eq(invitations.id, app.projectInvitationId), isNull(invitations.usedAt), isNull(invitations.revokedAt)))
      }
      const issued = await issueInvitationInTx(tx, { projectId, role: 'editor', createdBy: recruiterId }, now)
      await tx.update(recruitmentApplications).set({ projectInvitationId: issued.invitation.id, updatedAt: now }).where(eq(recruitmentApplications.id, app.id))
      return { kind: 'project', token: issued.token }
    }
    const spaceId = ctx.row.resultSpaceId
    if (!spaceId) throw conflict('invitation_unavailable')
    const space = await loadSpace(tx, spaceId)
    const recruiterMembership = await findMembership(tx, spaceId, recruiterId)
    const recruiterViewer = await loadViewer(tx, { userId: recruiterId }, spaceId, now)
    const facts = { kind: space.row.kind, schoolId: space.schoolId, departmentKey: space.row.departmentKey, discovery: space.row.discovery, joinPolicy: space.row.joinPolicy, status: space.row.status, capacity: space.row.capacity, activeMembers: 0 }
    if (space.row.status !== 'active' || !canManageSpace(recruiterViewer, facts, membershipFacts(recruiterMembership), 'invite')) throw conflict('invitation_unavailable')
    const mine = await findMembership(tx, spaceId, actor.userId)
    if (mine?.status === 'active') throw conflict('already_member')
    if (app.spaceInvitationId) {
      await tx
        .update(spaceInvitations)
        .set({ revokedAt: now })
        .where(and(eq(spaceInvitations.id, app.spaceInvitationId), isNull(spaceInvitations.usedAt), isNull(spaceInvitations.revokedAt)))
    }
    const issued = await issueSpaceInvitationInTx(tx, spaceId, recruiterId, now)
    await tx.update(recruitmentApplications).set({ spaceInvitationId: issued.invitation.id, updatedAt: now }).where(eq(recruitmentApplications.id, app.id))
    return { kind: 'space', token: issued.token }
  })
}

// ── 운영자: 과목 팀원 찾기 끄기(큐레이터 자리) ─────────────────────────

export const teamFindingSchema = z.object({ disabled: z.boolean({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }) })

/**
 * POST /operator/community/courses/:id/team-finding {disabled} — 수업이 팀을 배정하는 과목이라 팀원 찾기를 숨김(§8.8 "과목 큐레이터가 표시").
 * 큐레이터 역할이 생기기 전까지 운영자만(403 `operator_only`). 정본 과목에 저장합니다. 켜면 그 과목의 팀원 모집은 모집자 외에는 보이지 않고
 * 새로 올릴 수 없습니다(409 `team_finding_disabled`). 스터디 모집은 영향 없음. 200 `{courseId, teamFindingDisabled}`.
 */
export async function setCourseTeamFinding(db: DbExecutor, actor: Actor, courseId: unknown, rawInput: unknown): Promise<{ courseId: string; teamFindingDisabled: boolean }> {
  await requireOperator(db, actor)
  const input = parseInput(teamFindingSchema, rawInput)
  if (!isUuid(courseId)) throw notFound()
  const course = await loadCourseFacts(db, courseId)
  if (!course) throw notFound()
  return db.transaction(async (tx) => {
    await tx.update(courses).set({ teamFindingDisabled: input.disabled }).where(eq(courses.id, course.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'community.course_team_finding', targetType: 'course', targetId: course.id, metadata: { disabled: input.disabled } })
    return { courseId: course.id, teamFindingDisabled: input.disabled }
  })
}

// ── 신고·운영 조치 어댑터(moderation 모듈은 reporting.ts를 거쳐 부름) ─────

/** 신고 대상 `{recruitmentId}`: 신고자가 볼 수 있고 가려지지 않은 모집만(아니면 404). 형식이 틀리면 422. */
export async function reportableRecruitment(db: DbExecutor, actor: Actor, rawRef: unknown, now = new Date()): Promise<string> {
  const value = (rawRef as { recruitmentId?: unknown } | null)?.recruitmentId
  if (!isUuid(value)) throw invalid({ 'targetRef.recruitmentId': 'invalid' })
  const ctx = await loadViewableRecruitment(db, actor, value, now)
  if (ctx.row.hiddenAt) throw notFound()
  return ctx.row.id
}

/** 신고 대상 `{applicationId}`: **그 모집의 모집자만**(지원 메시지를 보는 사람은 모집자뿐). 다른 사람·가려진 메시지는 404. */
export async function reportableApplication(db: DbExecutor, actor: Actor, rawRef: unknown, now = new Date()): Promise<string> {
  const value = (rawRef as { applicationId?: unknown } | null)?.applicationId
  if (!isUuid(value)) throw invalid({ 'targetRef.applicationId': 'invalid' })
  const [app] = await db.select().from(recruitmentApplications).where(eq(recruitmentApplications.id, value.toLowerCase())).limit(1)
  if (!app || app.messageHiddenAt || app.status === 'withdrawn') throw notFound()
  const ctx = await loadViewableRecruitment(db, actor, app.recruitmentId, now).catch(() => null)
  if (!ctx || ctx.row.createdBy !== actor.userId) throw notFound()
  return app.id
}

/** 조치 당사자: 모집 글은 모집자, 지원 메시지는 지원자. */
export async function recruitmentItemPartyIds(db: DbExecutor, target: { recruitmentId?: string | null; applicationId?: string | null }): Promise<string[]> {
  if (target.recruitmentId) {
    const [r] = await db.select({ userId: recruitments.createdBy }).from(recruitments).where(eq(recruitments.id, target.recruitmentId)).limit(1)
    return r ? [r.userId] : []
  }
  if (target.applicationId) {
    const [a] = await db.select({ userId: recruitmentApplications.applicantId }).from(recruitmentApplications).where(eq(recruitmentApplications.id, target.applicationId)).limit(1)
    return a ? [a.userId] : []
  }
  return []
}

/** 대상 표시 글("모집 글 · 팀원" 등). 제목·메시지는 싣지 않습니다. */
export async function recruitmentItemLabels(db: DbExecutor, recruitmentIds: readonly string[], applicationIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (recruitmentIds.length) {
    for (const r of await db.select({ id: recruitments.id, kind: recruitments.kind }).from(recruitments).where(inArray(recruitments.id, [...recruitmentIds]))) {
      out.set(r.id, r.kind === 'team' ? '팀원 모집' : '스터디 모집')
    }
  }
  if (applicationIds.length) {
    for (const a of await db
      .select({ id: recruitmentApplications.id, kind: recruitments.kind })
      .from(recruitmentApplications)
      .innerJoin(recruitments, eq(recruitments.id, recruitmentApplications.recruitmentId))
      .where(inArray(recruitmentApplications.id, [...applicationIds]))) {
      out.set(a.id, a.kind === 'team' ? '팀원 모집' : '스터디 모집')
    }
  }
  return out
}

/** 운영 조치 hide_recruitment·hide_application(트랜잭션 안). 이미 가렸으면 409 `target_not_public`. */
export async function hideRecruitmentItemInTx(tx: DbExecutor, target: 'recruitment' | 'application', id: string, now: Date): Promise<void> {
  if (target === 'recruitment') {
    const [r] = await tx.select({ hiddenAt: recruitments.hiddenAt }).from(recruitments).where(eq(recruitments.id, id)).limit(1).for('update')
    if (!r) throw notFound()
    if (r.hiddenAt) throw conflict('target_not_public')
    await tx.update(recruitments).set({ hiddenAt: now, updatedAt: now }).where(eq(recruitments.id, id))
    return
  }
  const [a] = await tx.select({ hiddenAt: recruitmentApplications.messageHiddenAt }).from(recruitmentApplications).where(eq(recruitmentApplications.id, id)).limit(1).for('update')
  if (!a) throw notFound()
  if (a.hiddenAt) throw conflict('target_not_public')
  await tx.update(recruitmentApplications).set({ messageHiddenAt: now, updatedAt: now }).where(eq(recruitmentApplications.id, id))
}

/** 되돌림(이의제기·해제): 가림을 풉니다. */
export async function unhideRecruitmentItemInTx(tx: DbExecutor, target: 'recruitment' | 'application', id: string, now: Date): Promise<void> {
  if (target === 'recruitment') await tx.update(recruitments).set({ hiddenAt: null, updatedAt: now }).where(eq(recruitments.id, id))
  else await tx.update(recruitmentApplications).set({ messageHiddenAt: null, updatedAt: now }).where(eq(recruitmentApplications.id, id))
}

/** 운영자 신고 상세: 그 모집 글 또는 지원 메시지 하나만(가린 것도 내용 포함). 모집자·지원자 id·지원자 목록 없음. */
export async function operatorRecruitmentItem(db: DbExecutor, target: { recruitmentId?: string | null; applicationId?: string | null }): Promise<OperatorRecruitmentItemDto | null> {
  if (target.recruitmentId) {
    const [r] = await db.select().from(recruitments).where(eq(recruitments.id, target.recruitmentId)).limit(1)
    if (!r) return null
    return { target: 'recruitment', kind: r.kind, title: r.title, description: r.description, message: null, status: r.status, hidden: r.hiddenAt !== null }
  }
  if (target.applicationId) {
    const [row] = await db
      .select({ app: recruitmentApplications, kind: recruitments.kind, title: recruitments.title })
      .from(recruitmentApplications)
      .innerJoin(recruitments, eq(recruitments.id, recruitmentApplications.recruitmentId))
      .where(eq(recruitmentApplications.id, target.applicationId))
      .limit(1)
    if (!row) return null
    return { target: 'application', kind: row.kind, title: row.title, description: null, message: row.app.message, status: row.app.status, hidden: row.app.messageHiddenAt !== null }
  }
  return null
}

/** 신고 대상이 지금 보이는지(대기열 우선순위·servedNow). */
export async function recruitmentItemVisible(db: DbExecutor, target: { recruitmentId?: string | null; applicationId?: string | null }): Promise<boolean> {
  const item = await operatorRecruitmentItem(db, target)
  return !!item && !item.hidden
}

export { canReadRecruitmentHost }
