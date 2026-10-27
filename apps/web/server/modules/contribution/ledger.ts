/**
 * 기여 장부·동료평가 리포트 데이터 (T-08, PROOFU_EVOLUTION_PLAN §7, SYSTEM_DESIGN §6.4 ContributionReport, pilot-kit §4.1).
 *
 * - GET /projects/:id/contribution?from=&to= — 멤버(읽기 전용 포함). 비멤버 404.
 * - 기간은 서울 날짜(양 끝 포함, 기본은 이번 ISO 주 월~일)이며, 기록은 플랫폼이 기록한 시각(created_at·completed_at)으로
 *   기간에 넣습니다. 학생이 적은 수행일(claimedDate)은 쓰지 않습니다(자기 기입 날짜로 기간을 옮길 수 없게).
 * - 멤버별로 종류별 개수와 근거(선언)만 보여 주고, 점수·비율·순위를 만들지 않습니다. 순서는 이름순입니다.
 * - 포함하는 멤버: active 멤버는 언제나(기록이 없으면 "기록 없음"), 나간·내보낸 멤버는 그 기간에 기록(로그·완료한 할 일·
 *   파일·회의 참석)이 있거나 기간 안에 선언 revision을 저장했을 때만. 초대만 받은 사람은 넣지 않습니다.
 * - 이 프로젝트의 행만 읽습니다(모든 쿼리가 project_id로 거름). 응답에 이메일을 싣지 않습니다.
 * - 리포트는 저장하지 않고 요청 때마다 만듭니다(인쇄용 HTML 페이지, ADR 0008).
 */
import { z } from 'zod'
import {
  LOG_TAGS,
  checkPeriod,
  includeInLedger,
  openDays,
  orderMembersByName,
  periodBounds,
  projectWeekNo,
  seoulWeek,
} from '@peerchive/domain'
import {
  and,
  artifactVersions,
  artifacts,
  asc,
  claimRevisions,
  eq,
  isNotNull,
  logEntries,
  logRevisions,
  lt,
  milestoneSnapshots,
  milestones,
  ne,
  profiles,
  projectMembers,
  roleClaims,
  sql,
  tasks,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { type Actor, invalid } from '../errors'
import { summarize } from '../logs/logs'
import { claimedDateSchema } from '../logs/payloads'
import { parseInput } from '../validation'
import { loadPersonMask, loadReadableProject } from '../projects/access'
import { projectClaimDtos } from './claims'
import {
  CONTRIBUTION_DISCLAIMER,
  type ContributionDto,
  type LedgerMemberDto,
  type LogTag,
  type UnresolvedStuckDto,
} from '../../../shared/types/api'

export type { ContributionDto }

/** 미해결 막힘 목록 최대 길이. */
export const UNRESOLVED_STUCK_MAX = 20

export const contributionQuerySchema = z
  .object({
    from: claimedDateSchema.optional(),
    to: claimedDateSchema.optional(),
  })
  .superRefine((query, ctx) => {
    if (query.from && !query.to) ctx.addIssue({ code: 'custom', path: ['to'], message: 'required' })
    if (query.to && !query.from) ctx.addIssue({ code: 'custom', path: ['from'], message: 'required' })
  })

const emptyCounts = (): Record<LogTag, number> =>
  Object.fromEntries(LOG_TAGS.map((tag) => [tag, 0])) as Record<LogTag, number>

/** 해결 로그(현재 revision이 이 막힘을 가리키고 기간 끝 전에 만든 것)가 있는지. 같은 프로젝트 안에서만 봅니다. */
function resolvedBefore(projectId: string, stuckId: typeof logEntries.id, end: Date) {
  return sql`exists (
    select 1 from log_entries sol
    join log_revisions sr on sr.id = sol.current_revision_id
    where sol.project_id = ${projectId} and sol.tag = 'solution'
      and sr.resolves_entry_id = ${stuckId} and sol.created_at < ${end.toISOString()}::timestamptz)`
}

/** 기간 장부. */
export async function getContribution(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawQuery: unknown,
  now = new Date(),
): Promise<ContributionDto> {
  const query = parseInput(contributionQuerySchema, rawQuery)
  const { from, to } = query.from && query.to ? { from: query.from, to: query.to } : seoulWeek(now)
  const period = checkPeriod(from, to)
  if (period !== 'ok') throw invalid({ to: period })
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  const { start, end } = periodBounds(from, to)
  const inPeriod = (column: Parameters<typeof lt>[0]) =>
    and(sql`${column} >= ${start.toISOString()}::timestamptz`, sql`${column} < ${end.toISOString()}::timestamptz`)

  const [rawMembers, logCounts, stuckResolved, tasksDone, uploads, meetings, claimActivity] = await Promise.all([
    db
      .select({
        userId: projectMembers.userId,
        status: projectMembers.status,
        displayName: users.displayName,
        handle: profiles.handle,
      })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .leftJoin(profiles, eq(profiles.userId, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, project.id), ne(projectMembers.status, 'invited'))),
    db
      .select({ userId: logEntries.authorId, tag: logEntries.tag, n: sql<number>`count(*)::int` })
      .from(logEntries)
      .where(and(eq(logEntries.projectId, project.id), isNotNull(logEntries.currentRevisionId), inPeriod(logEntries.createdAt)))
      .groupBy(logEntries.authorId, logEntries.tag),
    db
      .select({ userId: logEntries.authorId, n: sql<number>`count(*)::int` })
      .from(logEntries)
      .where(
        and(
          eq(logEntries.projectId, project.id),
          eq(logEntries.tag, 'stuck'),
          inPeriod(logEntries.createdAt),
          resolvedBefore(project.id, logEntries.id, end),
        ),
      )
      .groupBy(logEntries.authorId),
    db
      .select({ userId: tasks.completedBy, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.projectId, project.id),
          eq(tasks.status, 'done'),
          isNotNull(tasks.completedBy),
          inPeriod(tasks.completedAt),
        ),
      )
      .groupBy(tasks.completedBy),
    db
      .select({ userId: artifactVersions.uploaderId, n: sql<number>`count(*)::int` })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(
        and(
          eq(artifacts.projectId, project.id),
          eq(artifactVersions.scanStatus, 'clean'),
          inPeriod(artifactVersions.createdAt),
        ),
      )
      .groupBy(artifactVersions.uploaderId),
    db
      .select({ payload: logRevisions.payload })
      .from(logEntries)
      .innerJoin(logRevisions, eq(logRevisions.id, logEntries.currentRevisionId))
      .where(and(eq(logEntries.projectId, project.id), eq(logEntries.tag, 'meeting'), inPeriod(logEntries.createdAt))),
    db
      .selectDistinct({ userId: roleClaims.userId })
      .from(claimRevisions)
      .innerJoin(roleClaims, eq(roleClaims.id, claimRevisions.claimId))
      .where(and(eq(roleClaims.projectId, project.id), inPeriod(claimRevisions.recordedAt))),
  ])
  // 익명 스터디 기록(C-08)은 다른 멤버 이름을 가립니다(이름순 정렬도 가린 이름 기준).
  const mask = await loadPersonMask(db, project, actor.userId)
  const members = rawMembers.map(mask)

  const tally = new Map<string, Omit<LedgerMemberDto, 'member' | 'active' | 'claims'>>()
  const entry = (userId: string) => {
    let row = tally.get(userId)
    if (!row) {
      row = { logCounts: emptyCounts(), stuckResolved: 0, tasksCompleted: 0, artifactsUploaded: 0, meetingsAttended: 0 }
      tally.set(userId, row)
    }
    return row
  }
  for (const row of logCounts) entry(row.userId).logCounts[row.tag] = row.n
  for (const row of stuckResolved) entry(row.userId).stuckResolved = row.n
  for (const row of tasksDone) if (row.userId) entry(row.userId).tasksCompleted = row.n
  for (const row of uploads) entry(row.userId).artifactsUploaded = row.n
  for (const { payload } of meetings) {
    const attendees = Array.isArray(payload.attendees) ? (payload.attendees as unknown[]) : []
    for (const id of new Set(attendees.filter((a): a is string => typeof a === 'string'))) entry(id).meetingsAttended += 1
  }
  const claimedInPeriod = new Set(claimActivity.map((row) => row.userId))

  const included = orderMembersByName(
    members.filter((m) => includeInLedger(m.status, tally.has(m.userId) || claimedInPeriod.has(m.userId))),
  )
  const claims = await projectClaimDtos(
    db,
    actor,
    project,
    membership,
    included.map((m) => m.userId),
  )

  const asOf = now < end ? now : new Date(end.getTime() - 1)
  const [unresolved, milestone] = await Promise.all([
    db
      .select({
        id: logEntries.id,
        createdAt: logEntries.createdAt,
        authorId: logEntries.authorId,
        body: logRevisions.body,
        payload: logRevisions.payload,
        displayName: users.displayName,
        handle: profiles.handle,
      })
      .from(logEntries)
      .innerJoin(logRevisions, eq(logRevisions.id, logEntries.currentRevisionId))
      .innerJoin(users, eq(users.id, logEntries.authorId))
      .leftJoin(profiles, eq(profiles.userId, logEntries.authorId))
      .where(
        and(
          eq(logEntries.projectId, project.id),
          eq(logEntries.tag, 'stuck'),
          lt(logEntries.createdAt, end),
          sql`not ${resolvedBefore(project.id, logEntries.id, end)}`,
        ),
      )
      .orderBy(asc(logEntries.createdAt), asc(logEntries.id))
      .limit(UNRESOLVED_STUCK_MAX),
    nearestMilestone(db, project.id, from, start, end),
  ])

  return {
    project: { id: project.id, title: project.title },
    period: { from, to, timeZone: 'Asia/Seoul', weekNo: projectWeekNo(project.createdAt, from, to) },
    generatedAt: now.toISOString(),
    members: included.map((m) => ({
      member: { userId: m.userId, displayName: m.displayName, handle: m.handle },
      active: m.status === 'active',
      ...(tally.get(m.userId) ?? entry(m.userId)),
      claims: claims.filter((c) => c.author.userId === m.userId),
    })),
    unresolvedStuck: unresolved.map(
      (row): UnresolvedStuckDto => ({
        id: row.id,
        summary: summarize('stuck', row.body, row.payload),
        author: mask({ userId: row.authorId, displayName: row.displayName, handle: row.handle }),
        createdAt: row.createdAt.toISOString(),
        openDays: openDays(row.createdAt, asOf),
      }),
    ),
    milestone,
    disclaimer: CONTRIBUTION_DISCLAIMER,
  }
}

/**
 * 기간 시작일 이후 예정일이 가장 이른 마일스톤(없으면 null)과 그 기간에 등록한 스냅샷 수.
 * 예정일 없는 마일스톤은 고르지 않습니다.
 */
async function nearestMilestone(db: DbExecutor, projectId: string, from: string, start: Date, end: Date) {
  const [row] = await db
    .select({ id: milestones.id, title: milestones.title, dueAt: milestones.dueAt })
    .from(milestones)
    .where(and(eq(milestones.projectId, projectId), isNotNull(milestones.dueAt), sql`${milestones.dueAt} >= ${from}::date`))
    .orderBy(asc(milestones.dueAt), asc(milestones.position))
    .limit(1)
  if (!row) return null
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(milestoneSnapshots)
    .where(
      and(
        eq(milestoneSnapshots.milestoneId, row.id),
        sql`${milestoneSnapshots.createdAt} >= ${start.toISOString()}::timestamptz`,
        lt(milestoneSnapshots.createdAt, end),
      ),
    )
  return { title: row.title, dueAt: row.dueAt, snapshotsInPeriod: count?.n ?? 0 }
}

/**
 * POST /projects/:id/report-exports {from, to} — 동료평가 리포트를 인쇄(PDF로 저장)했다는 표시(T-16 pilot 지표 report_exported).
 * 멤버만(읽을 수 없으면 404). 저장하는 것은 분석 이벤트(기간 일수)뿐입니다. 204.
 */
export async function recordReportExport(db: DbExecutor, actor: Actor, projectId: unknown, rawInput: unknown, now = new Date()): Promise<void> {
  const query = parseInput(contributionQuerySchema, rawInput)
  const { from, to } = query.from && query.to ? { from: query.from, to: query.to } : seoulWeek(now)
  const period = checkPeriod(from, to)
  if (period !== 'ok') throw invalid({ to: period })
  await db.transaction(async (tx) => {
    const { project } = await loadReadableProject(tx, actor, projectId)
    const { start, end } = periodBounds(from, to)
    const days = Math.max(1, Math.min(400, Math.round((end.getTime() - start.getTime()) / 86_400_000)))
    await emitAnalytics(tx, { name: 'report_exported', actorId: actor.userId, projectId: project.id, props: { days } })
  })
}
