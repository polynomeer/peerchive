/**
 * 운영자용 커뮤니티 지표·공간별 보기·CSV 내보내기 (C-10, DELIVERY_PLAN §4.1 C-10·§6.1·§7 GC·§9.1, ADR 0027).
 *
 * - `GET /api/v1/operator/metrics/community?from=&to=&space=`: 분석 이벤트(사람 행동: 글·댓글·공감·가입·모집·옮기기·스터디 기록)와 운영 기록
 *   (신고·조치·제재·작성자 확인·주간 운영 시간)의 집계(@peerchive/domain computeCommunityMetrics). **모든 칸 5 미만 null**. 사용자 키 없는 이벤트
 *   (익명 글·댓글, 신고·숨김·제재·옮기기·작성자 확인)는 사람 단위 지표(주간 활성)에서 빠지고 개수 지표에만 들어갑니다.
 * - `space`(선택): 운영자가 **명시적으로 고른 공간 하나**만, active 멤버(공식 페이지는 그 학교 active 인증 사용자)가
 *   N(`PEERCHIVE_METRICS_SPACE_MIN_MEMBERS`, 기본 20, 10 미만 불가) 이상일 때만 공간별 보기를 붙입니다(아니면 409 `space_too_small`, 없으면 404).
 *   공간별 보기는 이벤트에 공간이 없으므로 커뮤니티 테이블에서 개수만 셉니다(이름·id·글은 응답에 없음, 종류만).
 * - `GET /api/v1/operator/metrics/community/spaces`: 공간별 보기를 고를 수 있는 공간 목록(운영자 화면 선택용, 이름 포함 — 내보내기에는 쓰지 않음).
 * - `GET /api/v1/operator/metrics/community/export?from=&to=`: 같은 집계의 CSV(공간별 보기 없음, id·이름·글 없음). 운영자마다 시간당 10회(429),
 *   감사 `metrics.export`(종류만).
 * 모두 운영자만(아니면 403 `operator_only`). 이 파일은 서버 로그를 남기지 않습니다(C-05).
 */
import {
  ANALYTICS_MIN_GROUP,
  COMMUNITY_SPACE_BREAKDOWN_MIN_MEMBERS,
  type AuthorLookupFact,
  type CommunityEventRow,
  type ReportCaseFact,
  type SanctionFact,
  type SpaceItemFact,
  communityMetricsCsv,
  computeCommunityMetrics,
  computeSpaceBreakdown,
  isoWeeksBetween,
} from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  boards,
  communityAuthorLookups,
  communityComments,
  communityPosts,
  communitySanctions,
  communitySpaces,
  eq,
  gte,
  inArray,
  institutionAffiliations,
  isNotNull,
  lt,
  moderationActions,
  or,
  reports,
  schools,
  spaceMemberships,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, conflict, notFound, rateLimited } from '../errors'
import { currentReportSlaTargets } from '../moderation/sla'
import { parseMetricsRange } from '../ops/metrics'
import { opsTimeFacts } from '../ops/time-log'
import { isUuid } from '../projects/access'
import { hitRateLimit, type RateLimitRule } from '../security/rate-limit'
import type { CommunityMetricsDto, CommunityMetricsSpaceOptionDto, CommunitySpaceBreakdownDto } from '../../../shared/types/api'

export const METRICS_EXPORT_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60 * 60 * 1000 }
export const METRICS_SPACE_MIN_MEMBERS_ENV = 'PEERCHIVE_METRICS_SPACE_MIN_MEMBERS'
/** 공간별 보기 기준의 하한(설정으로도 이보다 낮출 수 없음). */
export const METRICS_SPACE_MIN_MEMBERS_FLOOR = 10

let minMembersOverride: number | null = null
/** 테스트용: 공간별 보기 기준(null이면 환경 변수). */
export function setSpaceBreakdownMinMembersForTesting(n: number | null): void {
  minMembersOverride = n
}

export function spaceBreakdownMinMembers(env: Readonly<Record<string, string | undefined>> = (globalThis.process?.env ?? {}) as Record<string, string | undefined>): number {
  if (minMembersOverride !== null) return minMembersOverride
  const raw = env[METRICS_SPACE_MIN_MEMBERS_ENV]?.trim()
  const n = raw && /^\d+$/.test(raw) ? Number(raw) : COMMUNITY_SPACE_BREAKDOWN_MIN_MEMBERS
  return n >= METRICS_SPACE_MIN_MEMBERS_FLOOR && n <= 100000 ? n : COMMUNITY_SPACE_BREAKDOWN_MIN_MEMBERS
}

/** 지표가 읽는 이벤트: 커뮤니티 이벤트 전부 + 스터디 기록의 로그·게시(origin study). */
const COMMUNITY_EVENT_NAMES = [
  'space_created',
  'space_joined',
  'name_mode_scheduled',
  'post_created',
  'comment_created',
  'reaction_added',
  'community_report_filed',
  'community_auto_hidden',
  'community_sanction_issued',
  'community_author_lookup',
  'recruitment_created',
  'application_submitted',
  'recruitment_closed',
  'archive_transfer_requested',
  'archive_transfer_completed',
  'course_qa_published',
  'study_record_enabled',
] as const

async function loadEvents(db: DbExecutor, from: Date, to: Date): Promise<CommunityEventRow[]> {
  return db
    .select({
      name: analyticsEvents.name,
      occurredAt: analyticsEvents.occurredAt,
      actorHash: analyticsEvents.actorHash,
      projectHash: analyticsEvents.projectHash,
      props: analyticsEvents.props,
    })
    .from(analyticsEvents)
    .where(
      and(
        gte(analyticsEvents.occurredAt, from),
        lt(analyticsEvents.occurredAt, to),
        or(
          inArray(analyticsEvents.name, [...COMMUNITY_EVENT_NAMES]),
          and(inArray(analyticsEvents.name, ['log_saved', 'publication_published']), sql`${analyticsEvents.props}->>'origin' = 'study'`),
        ),
      ),
    )
}

type ReportFactRow = {
  targetType: string
  targetKey: string
  status: string
  createdAt: Date
  firstActionAt: Date | null
  autoHiddenAt: Date | null
  closedAt: Date | null
  actionId: string | null
  actionKind: string | null
}

const reportFactColumns = {
  targetType: reports.targetType,
  targetKey: reports.targetKey,
  status: reports.status,
  createdAt: reports.createdAt,
  firstActionAt: reports.firstActionAt,
  autoHiddenAt: reports.autoHiddenAt,
  closedAt: reports.closedAt,
  actionId: reports.actionId,
  actionKind: moderationActions.kind,
}

const minDate = (dates: Array<Date | null>) => {
  const xs = dates.filter((d): d is Date => !!d).map((d) => d.getTime())
  return xs.length ? new Date(Math.min(...xs)) : null
}

/** 신고 행 → 묶음(처리된 것은 같은 조치, 처리 전은 같은 대상). */
function toCases(rows: ReportFactRow[]): { cases: ReportCaseFact[]; open: ReportCaseFact[] } {
  const groups = new Map<string, ReportFactRow[]>()
  for (const r of rows) {
    const key = r.actionId ? `a:${r.actionId}` : `o:${r.targetKey}`
    const g = groups.get(key) ?? []
    g.push(r)
    groups.set(key, g)
  }
  const cases: ReportCaseFact[] = []
  const open: ReportCaseFact[] = []
  for (const [key, g] of groups) {
    const first = g[0]!
    const fact: ReportCaseFact = {
      community: first.targetType.startsWith('community_'),
      item: first.targetType === 'community_post' || first.targetType === 'community_comment',
      firstReportedAt: minDate(g.map((r) => r.createdAt))!,
      reports: g.length,
      firstActionAt: minDate(g.map((r) => r.firstActionAt)),
      autoHiddenAt: minDate(g.map((r) => r.autoHiddenAt)),
      closedAt: key.startsWith('a:') ? minDate(g.map((r) => r.closedAt)) : null,
      actionKind: first.actionKind,
    }
    cases.push(fact)
    if (!key.startsWith('a:')) open.push(fact)
  }
  return { cases, open }
}

/** 기간에 걸친 신고 묶음 + 지금 처리 전 묶음(묶음의 모든 신고를 다시 읽음). */
async function loadCases(db: DbExecutor, from: Date, to: Date, scope?: ReturnType<typeof and>): Promise<{ cases: ReportCaseFact[]; open: ReportCaseFact[] }> {
  const seeds = await db
    .select({ targetKey: reports.targetKey, actionId: reports.actionId })
    .from(reports)
    .where(
      and(
        scope,
        or(
          and(gte(reports.createdAt, from), lt(reports.createdAt, to)),
          and(gte(reports.closedAt, from), lt(reports.closedAt, to)),
          inArray(reports.status, ['open', 'in_review']),
        ),
      ),
    )
  const actionIds = [...new Set(seeds.map((s) => s.actionId).filter((id): id is string => !!id))]
  const openKeys = [...new Set(seeds.filter((s) => !s.actionId).map((s) => s.targetKey))]
  if (actionIds.length === 0 && openKeys.length === 0) return { cases: [], open: [] }
  const rows = await db
    .select(reportFactColumns)
    .from(reports)
    .leftJoin(moderationActions, eq(moderationActions.id, reports.actionId))
    .where(
      or(
        actionIds.length ? inArray(reports.actionId, actionIds) : sql`false`,
        openKeys.length ? and(inArray(reports.targetKey, openKeys), inArray(reports.status, ['open', 'in_review'])) : sql`false`,
      ),
    )
  return toCases(rows)
}

async function loadSanctions(db: DbExecutor, from: Date, to: Date): Promise<SanctionFact[]> {
  return db
    .select({ level: communitySanctions.level, createdAt: communitySanctions.createdAt })
    .from(communitySanctions)
    .where(and(gte(communitySanctions.createdAt, from), lt(communitySanctions.createdAt, to)))
}

async function loadLookups(db: DbExecutor, from: Date, to: Date): Promise<AuthorLookupFact[]> {
  const rows = await db
    .select({ createdAt: communityAuthorLookups.createdAt, reportId: communityAuthorLookups.reportId, requestId: communityAuthorLookups.requestId })
    .from(communityAuthorLookups)
    .where(and(gte(communityAuthorLookups.createdAt, from), lt(communityAuthorLookups.createdAt, to)))
  return rows.map((r) => ({ createdAt: r.createdAt, linked: r.reportId !== null || r.requestId !== null }))
}

// ── 공간별 보기 ──────────────────────────────────────────────────────────

const OFFICIAL_KINDS = ['official_school', 'official_department'] as const

/** 공간의 "active 멤버": 사용자 방·스터디 방은 active 멤버십, 공식 페이지는 그 학교(정본) active 인증 사용자(학과 페이지는 학교 기준 근사). */
async function activeMembers(db: DbExecutor, space: { id: string; kind: string; schoolId: string | null }): Promise<number> {
  if ((OFFICIAL_KINDS as readonly string[]).includes(space.kind)) {
    if (!space.schoolId) return 0
    const [row] = await db
      .select({ n: sql<number>`count(distinct ${institutionAffiliations.userId})::int` })
      .from(institutionAffiliations)
      .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
      .innerJoin(users, eq(users.id, institutionAffiliations.userId))
      .where(and(eq(institutionAffiliations.status, 'active'), eq(users.status, 'active'), sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${space.schoolId}`))
    return row?.n ?? 0
  }
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, space.id), eq(spaceMemberships.status, 'active')))
  return row?.n ?? 0
}

async function spaceBreakdown(db: DbExecutor, rawSpace: unknown, from: Date, to: Date, minGroup: number): Promise<CommunitySpaceBreakdownDto> {
  if (!isUuid(rawSpace)) throw notFound()
  const [space] = await db
    .select({ id: communitySpaces.id, kind: communitySpaces.kind, schoolId: communitySpaces.schoolId })
    .from(communitySpaces)
    .where(eq(communitySpaces.id, rawSpace.toLowerCase()))
    .limit(1)
  if (!space) throw notFound()
  const minMembers = spaceBreakdownMinMembers()
  if ((await activeMembers(db, space)) < minMembers) throw conflict('space_too_small', { minMembers })
  const posts = await db
    .select({ boardKind: boards.kind, mode: communityPosts.nameMode, createdAt: communityPosts.createdAt, authorId: communityPosts.authorId })
    .from(communityPosts)
    .innerJoin(boards, eq(boards.id, communityPosts.boardId))
    .where(and(eq(communityPosts.spaceId, space.id), gte(communityPosts.createdAt, from), lt(communityPosts.createdAt, to)))
  const comments = await db
    .select({ mode: communityComments.nameMode, createdAt: communityComments.createdAt, authorId: communityComments.authorId })
    .from(communityComments)
    .innerJoin(communityPosts, eq(communityPosts.id, communityComments.postId))
    .where(and(eq(communityPosts.spaceId, space.id), gte(communityComments.createdAt, from), lt(communityComments.createdAt, to)))
  const items: SpaceItemFact[] = [
    ...posts.map((p) => ({ kind: 'post' as const, boardKind: p.boardKind, mode: p.mode, createdAt: p.createdAt, namedAuthorKey: p.mode === 'anonymous' ? null : p.authorId })),
    ...comments.map((c) => ({ kind: 'comment' as const, boardKind: null, mode: c.mode, createdAt: c.createdAt, namedAuthorKey: c.mode === 'anonymous' ? null : c.authorId })),
  ]
  const inSpace = or(
    eq(reports.communitySpaceId, space.id),
    sql`${reports.communityPostId} in (select ${communityPosts.id} from ${communityPosts} where ${communityPosts.spaceId} = ${space.id})`,
    sql`${reports.communityCommentId} in (select c.id from ${communityComments} c join ${communityPosts} p on p.id = c.post_id where p.space_id = ${space.id})`,
  )
  const { cases } = await loadCases(db, from, to, and(inSpace))
  const breakdown = computeSpaceBreakdown(items, cases, { from, to }, minGroup)
  return { kind: space.kind, minMembers, ...breakdown }
}

// ── 공개 함수 ────────────────────────────────────────────────────────────

async function compute(db: DbExecutor, from: Date, to: Date, now: Date) {
  const targets = currentReportSlaTargets()
  const [events, { cases, open }, sanctions, lookups, opsTime] = await Promise.all([
    loadEvents(db, from, to),
    loadCases(db, from, to),
    loadSanctions(db, from, to),
    loadLookups(db, from, to),
    opsTimeFacts(db, isoWeeksBetween(from, to)),
  ])
  const metrics = computeCommunityMetrics({ events, cases, openCases: open, sanctions, lookups, opsTime, targets }, { from, to, now }, ANALYTICS_MIN_GROUP)
  return { metrics, targets }
}

const NOTES = [
  `모든 칸은 ${ANALYTICS_MIN_GROUP} 미만이면 가렸습니다(null). 비율은 분자·분모 중 하나라도 가려지면 null입니다.`,
  '익명 글·댓글과 신고·숨김·제재·작성자 확인·옮기기 이벤트에는 사용자 키가 없습니다. 주간 활성은 키 있는 행동(표시명·실명 글, 가입, 모집 등)을 한 사람만 셉니다.',
  '수집을 거부한 사람의 행동 이벤트는 들어가지 않습니다. 신고·조치·제재·작성자 확인·운영 시간은 운영 기록에서 셉니다.',
  '질문 → 막힘 전환·스터디 기록 전환·모집 성사는 이벤트끼리 잇지 않은 기간 단위 근사입니다(ADR 0027).',
  '공간별 보기는 운영자가 고른 공간 하나만, active 멤버가 기준 이상일 때만 나오고 내보내기에는 없습니다.',
]

/** GET /operator/metrics/community?from=&to=&space= */
export async function getCommunityMetrics(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>, now = new Date()): Promise<CommunityMetricsDto> {
  await requireOperator(db, actor)
  const { from, to } = parseMetricsRange(rawQuery, now)
  const { metrics, targets } = await compute(db, from, to, now)
  const space = rawQuery.space !== undefined && rawQuery.space !== '' ? await spaceBreakdown(db, rawQuery.space, from, to, ANALYTICS_MIN_GROUP) : null
  return { ...metrics, slaTargets: targets, space, generatedAt: now.toISOString(), notes: NOTES }
}

/** GET /operator/metrics/community/spaces — active 멤버 N 이상인 활성 공간(이름순, 200개). */
export async function listMetricsSpaces(db: DbExecutor, actor: Actor): Promise<CommunityMetricsSpaceOptionDto[]> {
  await requireOperator(db, actor)
  const minMembers = spaceBreakdownMinMembers()
  const rooms = await db
    .select({ id: communitySpaces.id, name: communitySpaces.name, kind: communitySpaces.kind })
    .from(communitySpaces)
    .innerJoin(spaceMemberships, and(eq(spaceMemberships.spaceId, communitySpaces.id), eq(spaceMemberships.status, 'active')))
    .where(and(eq(communitySpaces.status, 'active'), inArray(communitySpaces.kind, ['user_room', 'study_room'])))
    .groupBy(communitySpaces.id)
    .having(sql`count(*) >= ${minMembers}`)
  const officials = await db
    .select({ id: communitySpaces.id, name: communitySpaces.name, kind: communitySpaces.kind, schoolId: communitySpaces.schoolId })
    .from(communitySpaces)
    .where(and(eq(communitySpaces.status, 'active'), inArray(communitySpaces.kind, [...OFFICIAL_KINDS]), isNotNull(communitySpaces.schoolId)))
  const eligibleOfficials: CommunityMetricsSpaceOptionDto[] = []
  for (const o of officials) if ((await activeMembers(db, o)) >= minMembers) eligibleOfficials.push({ id: o.id, name: o.name, kind: o.kind })
  return [...rooms, ...eligibleOfficials].sort((a, b) => a.name.localeCompare(b.name, 'ko')).slice(0, 200)
}

/** GET /operator/metrics/community/export?from=&to= — CSV(공간별 보기 없음). 시간당 10회, 감사(종류만). */
export async function exportCommunityMetricsCsv(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>, now = new Date()): Promise<{ csv: string; filename: string }> {
  await requireOperator(db, actor)
  const { from, to } = parseMetricsRange(rawQuery, now)
  return db.transaction(async (tx) => {
    if (!(await hitRateLimit(tx, 'metrics_export', actor.userId, METRICS_EXPORT_RATE_LIMIT, now))) throw rateLimited()
    const { metrics } = await compute(tx, from, to, now)
    await recordAudit(tx, { actorId: actor.userId, action: 'metrics.export', targetType: 'metrics', metadata: { kind: 'community_csv' } })
    const day = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10)
    return { csv: communityMetricsCsv(metrics), filename: `peerchive-community-metrics-${day(from)}-${day(new Date(to.getTime() - 1))}.csv` }
  })
}
