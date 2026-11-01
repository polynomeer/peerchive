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
  type RoomItemKind,
  communityMetricsCsv,
  computeCommunityMetrics,
  computeP2Metrics,
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
import { featureFlags } from '../features'
import { certificateDecisionDurations, currentCertificateSlaHours } from '../institutions/verification-queue'
import { currentReportSlaTargets } from '../moderation/sla'
import { parseMetricsRange } from '../ops/metrics'
import { opsTimeFacts } from '../ops/time-log'
import { isUuid } from '../projects/access'
import { hitRateLimit, type RateLimitRule } from '../security/rate-limit'
import type { CommunityMetricsDto, CommunityMetricsSpaceOptionDto, CommunitySpaceBreakdownDto, OperatorP2MetricsDto } from '../../../shared/types/api'

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

// ── A-07(ADR 0045): §6.2 P2 졸업생·토픽·기관 지표 ──────────────────────────
//
// `GET /api/v1/operator/metrics/community/p2?from=&to=` — 운영자만. 이 집계는 커뮤니티 테이블(동문 방·일정·공지·명부·토픽 글·댓글·옮기기)을 세므로
// C-05 경계에 따라 커뮤니티 모듈에 둡니다(운영 지표 라우트는 이 파일만 import). 사람 행동은 분석 이벤트(사용자 키 있는 것만 사람으로 셈), 나머지는
// 개수로만. **모든 칸 5 미만 null**, 꺼진 영역의 칸은 null(@peerchive/domain computeP2Metrics). 사람·방·기관 id·이름은 응답에 없습니다.

const P2_METRIC_EVENTS = [
  'alumni_room_created',
  'event_created',
  'rsvp_submitted',
  'directory_consent_changed',
  'topic_post_created',
  'completion_retro_published',
  'senior_note_published',
] as const

type CountRow = { n: number }
const one = async (db: DbExecutor, query: ReturnType<typeof sql>): Promise<number> => ((await db.execute(query)) as unknown as CountRow[])[0]?.n ?? 0

/** 방 항목·토픽·회고의 신고(기간 안 접수) — 종류·사유·확정(숨김·가리기, 되돌리지 않음)만. */
async function p2ReportFacts(db: DbExecutor, from: Date, to: Date) {
  const fromTs = sql`${from.toISOString()}::timestamptz`
  const toTs = sql`${to.toISOString()}::timestamptz`
  const rows = (await db.execute(sql`
    select r.target_type::text as target_type, r.room_item_kind::text as room_item_kind, r.reason::text as reason,
      coalesce(a.kind::text <> 'none' and a.reversed_at is null, false) as confirmed,
      coalesce((select s.kind::text from community_posts p join community_spaces s on s.id = p.space_id
        where p.id = coalesce(r.community_post_id, (select c.post_id from community_comments c where c.id = r.community_comment_id))) = 'topic', false) as topic
    from ${reports} r left join ${moderationActions} a on a.id = r.action_id
    where r.created_at >= ${fromTs} and r.created_at < ${toTs}
      and (r.target_type::text in ('room_item', 'completion_retro') or r.reason::text = 'affiliation_impersonation')`)) as unknown as Array<{
    target_type: string
    room_item_kind: RoomItemKind | null
    reason: string
    confirmed: boolean
    topic: boolean
  }>
  return rows
}

export async function getP2Metrics(db: DbExecutor, actor: Actor, rawQuery: unknown, now = new Date()): Promise<OperatorP2MetricsDto> {
  await requireOperator(db, actor)
  const { from, to } = parseMetricsRange(rawQuery, now)
  // 원시 SQL에는 Date를 바로 넘기지 않고 timestamptz로 바꿔 씁니다.
  const fromTs = sql`${from.toISOString()}::timestamptz`
  const toTs = sql`${to.toISOString()}::timestamptz`
  const flags = featureFlags()
  const events = await db
    .select({ name: analyticsEvents.name, occurredAt: analyticsEvents.occurredAt, actorHash: analyticsEvents.actorHash, projectHash: analyticsEvents.projectHash, props: analyticsEvents.props })
    .from(analyticsEvents)
    .where(and(gte(analyticsEvents.occurredAt, from), lt(analyticsEvents.occurredAt, to), inArray(analyticsEvents.name, [...P2_METRIC_EVENTS])))
  const reportRows = await p2ReportFacts(db, from, to)

  // 동문 방(보관되지 않은 alumni 템플릿 사용자 방).
  const alumniRooms = sql`select id, current_name_mode from community_spaces where template::text = 'alumni' and kind::text = 'user_room' and status::text <> 'archived'`
  const rooms = flags.alumni ? await one(db, sql`select count(*)::int as n from (${alumniRooms}) ar`) : 0
  const activeRooms = flags.alumni
    ? await one(
        db,
        sql`select count(*)::int as n from (${alumniRooms}) ar where exists (select 1 from room_events e where e.space_id = ar.id and e.created_at >= ${fromTs} and e.created_at < ${toTs})
          or exists (select 1 from community_posts p join boards b on b.id = p.board_id where p.space_id = ar.id and b.kind::text = 'notice' and p.created_at >= ${fromTs} and p.created_at < ${toTs})`,
      )
    : 0
  // 기간에 걸친(시작이 기간 끝 전이고, 반복이면 끝나는 날이 기간 시작 뒤) 숨기지 않은 일정: 응답한 (일정, 사람) 수 / 그 방 active 멤버 수 합.
  const periodEvents = sql`select e.id, e.space_id from room_events e join (${alumniRooms}) ar on ar.id = e.space_id
    where e.hidden_at is null and e.starts_at < ${toTs} and coalesce((e.repeat_until + 1)::timestamptz, e.starts_at) >= ${fromTs}`
  const rsvpResponders = flags.alumni
    ? await one(
        db,
        sql`select count(*)::int as n from (select distinct r.event_id, r.user_id from room_event_rsvps r join (${periodEvents}) pe on pe.id = r.event_id
          join space_memberships m on m.space_id = pe.space_id and m.user_id = r.user_id and m.status::text = 'active') x`,
      )
    : 0
  const rsvpAudience = flags.alumni
    ? await one(db, sql`select coalesce(sum((select count(*) from space_memberships m where m.space_id = pe.space_id and m.status::text = 'active')), 0)::int as n from (${periodEvents}) pe`)
    : 0
  const directoryEligible = flags.alumni
    ? await one(
        db,
        sql`select count(*)::int as n from space_memberships m join (${alumniRooms}) ar on ar.id = m.space_id
          where m.status::text = 'active' and ar.current_name_mode::text in ('real', 'display')`,
      )
    : 0
  const directoryCount = flags.alumni
    ? await one(
        db,
        sql`select count(*)::int as n from directory_entries d join (${alumniRooms}) ar on ar.id = d.space_id
          join space_memberships m on m.space_id = d.space_id and m.user_id = d.user_id and m.status::text = 'active'
          where ar.current_name_mode::text in ('real', 'display')`,
      )
    : 0

  // 토픽 답변(댓글)과 그중 선배 노트로 옮겨진 것.
  const topicComments = sql`select c.id from community_comments c join community_posts p on p.id = c.post_id join community_spaces s on s.id = p.space_id
    where s.kind::text = 'topic' and c.created_at >= ${fromTs} and c.created_at < ${toTs}`
  const answers = flags.topics ? await one(db, sql`select count(*)::int as n from (${topicComments}) tc`) : 0
  const moved = flags.topics
    ? await one(
        db,
        sql`select count(distinct t.source_comment_id)::int as n from archive_transfers t join (${topicComments}) tc on tc.id = t.source_comment_id
          where t.target::text = 'senior_note' and t.status::text = 'done'`,
      )
    : 0

  // 기관 인증(대학이 아닌 기관, 메일 제외).
  const methodRows = flags.institutions
    ? await db
        .select({ method: institutionAffiliations.method, n: sql<number>`count(*)::int` })
        .from(institutionAffiliations)
        .where(and(gte(institutionAffiliations.verifiedAt, from), lt(institutionAffiliations.verifiedAt, to), sql`${institutionAffiliations.method}::text <> 'email'`))
        .groupBy(institutionAffiliations.method)
    : []
  const byMethod = (m: string) => methodRows.find((r) => r.method === m)?.n ?? 0
  const revokedByOperator = flags.institutions
    ? await one(
        db,
        sql`select count(*)::int as n from institution_affiliations where revoked_reason = 'operator' and method::text <> 'email' and revoked_at >= ${fromTs} and revoked_at < ${toTs}`,
      )
    : 0
  const durations = flags.institutions ? await certificateDecisionDurations(db, from, to) : []

  const impersonation = reportRows.filter((r) => r.reason === 'affiliation_impersonation')
  const topicImpersonation = impersonation.filter((r) => r.topic)
  const institutionImpersonation = impersonation.filter((r) => r.target_type === 'room_item' || r.target_type === 'completion_retro')
  const metrics = computeP2Metrics(
    {
      flags,
      events,
      alumni: {
        rooms,
        activeRooms,
        rsvpResponders,
        rsvpAudience,
        directoryConsented: directoryCount,
        directoryEligible,
        reports: reportRows.filter((r) => r.target_type === 'room_item' && r.room_item_kind).map((r) => ({ kind: r.room_item_kind!, reason: r.reason, confirmed: r.confirmed })),
      },
      topics: { answers, movedToNotes: moved, impersonationReports: topicImpersonation.length, impersonationConfirmed: topicImpersonation.filter((r) => r.confirmed).length },
      institutions: {
        verifiedByMethod: { invite_code: byMethod('invite_code'), cohort_approval: byMethod('cohort_approval'), certificate_check: byMethod('certificate_check') },
        certificateDecisionMs: durations,
        certificateSlaHours: currentCertificateSlaHours(),
        revokedByOperator,
        impersonationReports: institutionImpersonation.length,
        impersonationConfirmed: institutionImpersonation.filter((r) => r.confirmed).length,
      },
    },
    ANALYTICS_MIN_GROUP,
  )
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    minGroup: ANALYTICS_MIN_GROUP,
    flags,
    generatedAt: now.toISOString(),
    notes: [
      `${ANALYTICS_MIN_GROUP} 미만인 값은 가렸습니다(null). 꺼진 영역은 비웁니다.`,
      '졸업생 → 선배 노트 공급은 동문 방 활동(방 만들기·일정·응답·명부)을 한 사람 중 같은 기간에 선배 노트·수료 회고를 게시한 비율입니다(같은 기간 근사, 토픽 참여는 사용자 키가 없어 빠짐).',
      '동문 방 활성은 기간 안에 일정을 만들었거나 공지를 올린 방의 비율, 참석 응답률은 기간에 걸친 일정의 (일정, 응답한 멤버) 수 / 그 방 지금 멤버 수입니다.',
      '수료증 처리 시간은 파일을 받은 시각부터 결정 시각까지입니다. 기관 기수 방에서 시작된 공개 사례 수는 잴 수 없어 비워 둡니다.',
      'P2 이벤트는 시 단위 시각이고, 익명 방의 일정·응답과 익명·소속 표시 익명 토픽 글, 익명 회고는 사용자 키가 없습니다.',
    ],
    alumni: metrics.alumni,
    topics: metrics.topics,
    institutions: metrics.institutions,
  }
}
