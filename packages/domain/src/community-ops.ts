/**
 * 커뮤니티 운영 도구·계측 규칙 (C-10, DELIVERY_PLAN §4.1 C-10·§6.1·§7 GC·§9.1, ADR 0027).
 *
 * - **신고 처리 기한(SLA)**: 임시 숨김된 글·댓글(우선 검토)은 숨김 시각부터 기본 24시간, 나머지 신고는 첫 신고부터 기본 72시간.
 *   환경 변수로 바꿉니다(`PEERCHIVE_REPORT_SLA_AUTO_HIDDEN_HOURS`·`PEERCHIVE_REPORT_SLA_HOURS`). 기한의 75%가 지나면 `due_soon`, 넘으면 `overdue`.
 * - **주간 운영 시간**: 서울 ISO 주마다 분야별 분(신고 검토·공식 페이지·학교 인증 지원·큐레이션·기타). 주 합계는 7일(10080분)을 넘지 못합니다.
 * - **커뮤니티 지표**(computeCommunityMetrics): 분석 이벤트(사람 행동, 사용자 키 없는 이벤트는 사람 단위 지표에서 제외) + 운영 기록(신고·조치·제재·작성자 확인)의
 *   집계. **모든 칸에 5 미만 가림**(ANALYTICS_MIN_GROUP)을 적용하고, 잴 수 없는 지표는 null + 이유입니다.
 * - CSV(communityMetricsCsv): 같은 집계를 `section,metric,dimension,value` 줄로. id·이름·글이 들어갈 자리가 없습니다.
 */
import { ANALYTICS_MIN_GROUP, suppressSmall, type AnalyticsEventName, type RateMetric } from './analytics'
import { ARCHIVE_TRANSFER_TARGETS } from './archive-transfers'
import { isoWeekOf, isoWeekRange } from './checkins'
import { SANCTION_LEVELS as SANCTION_LEVEL_KEYS } from './community-moderation'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

// ── 신고 처리 기한(SLA) ──────────────────────────────────────────────────

export const REPORT_SLA_DEFAULT_AUTO_HIDDEN_HOURS = 24
export const REPORT_SLA_DEFAULT_HOURS = 72
export const REPORT_SLA_MAX_HOURS = 720
/** 기한의 이 비율이 지나면 "곧 기한"(due_soon)입니다. */
export const REPORT_SLA_DUE_SOON_RATIO = 0.75
export const REPORT_SLA_ENV = { autoHidden: 'PEERCHIVE_REPORT_SLA_AUTO_HIDDEN_HOURS', normal: 'PEERCHIVE_REPORT_SLA_HOURS' } as const

export interface ReportSlaTargets {
  autoHiddenHours: number
  normalHours: number
}

export type ReportSlaState = 'ok' | 'due_soon' | 'overdue'
export type ReportPriority = 'auto_hidden' | 'normal'

/** 1~720 정수 시간. 비었거나 틀리면 fallback. */
export function parseSlaHours(raw: string | undefined, fallback: number): number {
  const text = raw?.trim()
  if (!text || !/^\d+$/.test(text)) return fallback
  const n = Number(text)
  return n >= 1 && n <= REPORT_SLA_MAX_HOURS ? n : fallback
}

export function reportSlaTargets(env: Readonly<Record<string, string | undefined>>): ReportSlaTargets {
  return {
    autoHiddenHours: parseSlaHours(env[REPORT_SLA_ENV.autoHidden], REPORT_SLA_DEFAULT_AUTO_HIDDEN_HOURS),
    normalHours: parseSlaHours(env[REPORT_SLA_ENV.normal], REPORT_SLA_DEFAULT_HOURS),
  }
}

export interface ReportGroupClock {
  /** 묶음의 첫 신고 시각. */
  firstReportedAt: Date
  /** 신고 누적 임시 숨김 시각(없으면 null). 있으면 우선 검토 기한을 씁니다. */
  autoHiddenAt: Date | null
}

export interface ReportSlaView {
  priority: ReportPriority
  /** 기한 계산 시작(숨김 시각 또는 첫 신고). */
  startedAt: Date
  targetHours: number
  dueAt: Date
  /** 시작부터 지금(또는 끝난 시각)까지 초. */
  ageSeconds: number
  state: ReportSlaState
}

export function slaState(elapsedMs: number, targetHours: number): ReportSlaState {
  const target = targetHours * HOUR_MS
  if (elapsedMs > target) return 'overdue'
  if (elapsedMs >= target * REPORT_SLA_DUE_SOON_RATIO) return 'due_soon'
  return 'ok'
}

/** 묶음 하나의 기한 판정. `endAt`(처리한 시각)이 있으면 그 시각까지로 잽니다(끝난 묶음의 기한 준수 여부). */
export function reportGroupSla(clock: ReportGroupClock, targets: ReportSlaTargets, now: Date, endAt: Date | null = null): ReportSlaView {
  const priority: ReportPriority = clock.autoHiddenAt ? 'auto_hidden' : 'normal'
  const startedAt = clock.autoHiddenAt ?? clock.firstReportedAt
  const targetHours = priority === 'auto_hidden' ? targets.autoHiddenHours : targets.normalHours
  const end = endAt ?? now
  const elapsed = Math.max(0, end.getTime() - startedAt.getTime())
  return {
    priority,
    startedAt,
    targetHours,
    dueAt: new Date(startedAt.getTime() + targetHours * HOUR_MS),
    ageSeconds: Math.floor(elapsed / 1000),
    state: slaState(elapsed, targetHours),
  }
}

/** 중앙값(빈 배열 null). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** 표본이 minGroup 미만이면 null인 중앙값(시간, 소수 첫째 자리). */
export function suppressedMedianHours(durationsMs: readonly number[], minGroup = ANALYTICS_MIN_GROUP): number | null {
  if (durationsMs.length < minGroup) return null
  const m = median(durationsMs)
  return m === null ? null : Math.round((m / HOUR_MS) * 10) / 10
}

// ── 주간 운영 시간 ───────────────────────────────────────────────────────

export const OPS_TIME_CATEGORIES = ['reports', 'official_pages', 'affiliation_support', 'curation', 'other'] as const
export type OpsTimeCategory = (typeof OPS_TIME_CATEGORIES)[number]
export const OPS_TIME_NOTE_MAX = 200
export const OPS_TIME_WEEK_MINUTES_MAX = 7 * 24 * 60
/** 기록·수정할 수 있는 지난 주 수(이번 주 포함 53주 안). */
export const OPS_TIME_EDITABLE_WEEKS = 52
/** 내 기록 목록에 보여 줄 최근 주 수. */
export const OPS_TIME_LIST_WEEKS = 12

export type OpsTimeWeekCheck = 'ok' | 'invalid' | 'future' | 'too_old'

/** 그 주를 기록할 수 있는지: 올바른 ISO 주, 이번 주 이후가 아님, 52주보다 오래되지 않음. */
export function checkOpsTimeWeek(week: string, now: Date): OpsTimeWeekCheck {
  const range = isoWeekRange(week)
  if (!range) return 'invalid'
  const current = isoWeekRange(isoWeekOf(now))!
  if (range.from > current.from) return 'future'
  const oldest = isoWeekRange(isoWeekOf(now, OPS_TIME_EDITABLE_WEEKS))!
  if (range.from < oldest.from) return 'too_old'
  return 'ok'
}

export type OpsTimeMinutes = Record<OpsTimeCategory, number>

export function opsTimeTotal(minutes: OpsTimeMinutes): number {
  return OPS_TIME_CATEGORIES.reduce((sum, c) => sum + minutes[c], 0)
}

/** [from, to) 서울 시각 범위에 걸친 ISO 주 목록(오래된 것부터, 최대 60주). */
export function isoWeeksBetween(from: Date, to: Date): string[] {
  const out: string[] = []
  let cursor = isoWeekOf(from)
  const last = isoWeekOf(new Date(to.getTime() - 1))
  for (let i = 0; i < 60; i++) {
    out.push(cursor)
    if (cursor === last) break
    const range = isoWeekRange(cursor)!
    cursor = isoWeekOf(new Date(Date.parse(`${range.to}T12:00:00Z`) + DAY_MS))
  }
  return out
}

// ── 커뮤니티 지표 ────────────────────────────────────────────────────────

/** 공간별 보기를 허용하는 최소 active 멤버 수(초안). 운영자가 명시적으로 고를 때만, 이 수 이상인 공간만. */
export const COMMUNITY_SPACE_BREAKDOWN_MIN_MEMBERS = 20

/** 사람 단위(주간 활성) 지표가 세는 커뮤니티 행동 이벤트. 사용자 키 없는 이벤트(actorHash null)는 셀 수 없어 빠집니다. */
export const COMMUNITY_ACTIVITY_EVENTS = [
  'space_created',
  'space_joined',
  'name_mode_scheduled',
  'post_created',
  'comment_created',
  'reaction_added',
  'recruitment_created',
  'application_submitted',
  'recruitment_closed',
  'study_record_enabled',
] as const satisfies readonly AnalyticsEventName[]

export const COMMUNITY_BOARD_KINDS = ['free', 'freshmen', 'alumni', 'question', 'info', 'recruiting', 'notice', 'general'] as const
export const COMMUNITY_NAME_MODES = ['real', 'display', 'anonymous'] as const
/** 스터디 기록 전환(§6.1): 기록이 이 주 수 이상 이어진 스터디. */
export const STUDY_LOG_MIN_WEEKS = 3

export interface CommunityEventRow {
  name: AnalyticsEventName
  occurredAt: Date
  /** null = 사용자 키 없음(익명 글·댓글, 신고·숨김·제재·옮기기). */
  actorHash: string | null
  projectHash: string | null
  props: Readonly<Record<string, unknown>>
}

/** 운영 기록에서 읽은 신고 묶음(같은 대상의 신고들, 처리된 묶음은 같은 조치). 내용·사람 없음. */
export interface ReportCaseFact {
  /** 커뮤니티 대상인지(공간·글·댓글·모집·지원)와 글·댓글인지. */
  community: boolean
  item: boolean
  firstReportedAt: Date
  reports: number
  firstActionAt: Date | null
  autoHiddenAt: Date | null
  closedAt: Date | null
  /** 처리한 조치 종류(none = 기각·조치 없음 → 임시 숨김이면 복원). */
  actionKind: string | null
}

export interface SanctionFact {
  level: (typeof SANCTION_LEVEL_KEYS)[number]
  createdAt: Date
}

export interface AuthorLookupFact {
  createdAt: Date
  /** 신고 또는 제재 요청과 이어졌는지. */
  linked: boolean
}

export interface NotAvailable {
  value: null
  reason: string
}

export interface CommunityMetrics {
  from: string
  to: string
  minGroup: number
  activity: {
    /** 주마다 키 있는 커뮤니티 행동 이벤트의 서로 다른 사람 수. */
    weeklyActive: Array<{ week: string; users: number | null }>
    keyedEvents: number | null
    /** 사용자 키 없는 커뮤니티 이벤트 수(사람 단위로 셀 수 없음). */
    unkeyedEvents: number | null
  }
  writing: {
    posts: number | null
    comments: number | null
    postsByBoard: Record<(typeof COMMUNITY_BOARD_KINDS)[number], number | null>
    postsByMode: Record<(typeof COMMUNITY_NAME_MODES)[number], number | null>
    commentsByMode: Record<(typeof COMMUNITY_NAME_MODES)[number], number | null>
    /** 익명으로 쓴 글·댓글 비율. */
    anonymousShare: RateMetric
    /** 표시명·실명으로 쓴 글·댓글 비율(§6.2 익명 외 활동 비중). */
    namedShare: RateMetric
  }
  moderation: {
    reportsFiled: number | null
    communityReportsFiled: number | null
    /** 커뮤니티 신고(이벤트) ÷ 글(이벤트) × 100 / × 1000. 분자·분모 중 하나라도 가려지면 null. */
    reportsPer100Posts: number | null
    reportsPer1000Posts: number | null
    casesClosed: number | null
    medianFirstActionHours: number | null
    medianResolutionHours: number | null
    /** 자동 숨김 → 검토 완료(§6.1 "검토 중앙값 24시간 이내"). */
    medianAutoHiddenResolutionHours: number | null
    slaMet: RateMetric
    /** 신고된 글·댓글 묶음 중 임시 숨김된 비율. */
    autoHideRate: RateMetric
    /** 처리된 임시 숨김 중 복원(기각·조치 없음)된 비율. */
    restoreRate: RateMetric
    sanctionsByLevel: Record<(typeof SANCTION_LEVEL_KEYS)[number], number | null>
    authorLookups: number | null
    /** 작성자 확인 중 신고·제재 요청과 이어진 비율(목표 100%). */
    authorLookupsLinked: RateMetric
    /** 지금(기간과 무관) 처리 전 묶음과 기한 넘김. */
    openCases: number | null
    overdueCases: number | null
    overdueAutoHidden: number | null
  }
  conversion: {
    transfers: Record<(typeof ARCHIVE_TRANSFER_TARGETS)[number], { requested: number | null; completed: number | null; rate: number | null }>
    /** 핵심: 질문 글 → 막힘 Q&A·막힘 로그로 옮겨진 비율(근사: 기간 안 질문 글 대비 기간 안 완료). */
    questionToStuck: RateMetric
    studyRecordsEnabled: number | null
    /** 핵심: 스터디 방이 생긴 모집 마감 → 스터디 기록 로그가 3주 이상(서로 다른 ISO 주)인 스터디 과제. */
    studyRecordConversion: RateMetric
    /** 로그가 있는 스터디 과제 중 게시(공개 사례)까지 간 과제. */
    studyPublished: RateMetric
    recruitmentsCreated: Record<'team' | 'study', number | null>
    recruitmentsClosed: Record<'project' | 'study_room' | 'cancelled', number | null>
    /** 끝난 모집(마감 + 취소) 중 과제 공간·스터디 방이 만들어진 비율. */
    recruitmentFillRate: RateMetric
  }
  opsTime: {
    weeks: Array<{ week: string; minutes: Record<OpsTimeCategory, number | null>; total: number | null; operators: number | null }>
    totalMinutes: number | null
  }
  notAvailable: Record<'archiveInflow' | 'revisit' | 'writeTime' | 'studyToSeniorNote', NotAvailable>
}

export interface OpsTimeFact extends OpsTimeMinutes {
  week: string
  operatorKey: string
}

export interface CommunityMetricsInput {
  events: readonly CommunityEventRow[]
  cases: readonly ReportCaseFact[]
  /** 지금 처리 전인 묶음(기간과 무관). */
  openCases: readonly ReportCaseFact[]
  sanctions: readonly SanctionFact[]
  lookups: readonly AuthorLookupFact[]
  opsTime: readonly OpsTimeFact[]
  targets: ReportSlaTargets
}

export const COMMUNITY_METRICS_NOT_AVAILABLE: CommunityMetrics['notAvailable'] = {
  archiveInflow: { value: null, reason: '과목 허브·과제 공간을 "처음 연" 시점을 이벤트로 남기지 않습니다(페이지 조회 추적 없음).' },
  revisit: { value: null, reason: '방문(페이지 조회) 이벤트를 남기지 않아 주 1회 재방문을 잴 수 없습니다. 주간 활성(키 있는 행동)으로 대신 봅니다.' },
  writeTime: { value: null, reason: '작성·체류 시간은 재지 않습니다(인터뷰·관찰).' },
  studyToSeniorNote: { value: null, reason: '선배 노트 게시 이벤트는 스터디와 이어지지 않아 스터디 → 선배 노트 전환은 셀 수 없습니다(공개 사례 게시만 셈).' },
}

function rate(numerator: number, denominator: number, minGroup: number): RateMetric {
  const n = suppressSmall(numerator, minGroup)
  const d = suppressSmall(denominator, minGroup)
  return { numerator: n, denominator: d, rate: n === null || d === null || denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 1000 }
}

const keysOf = <K extends string>(keys: readonly K[], fn: (k: K) => number | null) => Object.fromEntries(keys.map((k) => [k, fn(k)])) as Record<K, number | null>

/** 커뮤니티 지표 계산(순수 함수). events·cases는 [from, to) 범위 밖이 섞여 있어도 됩니다(여기서 거름). */
export function computeCommunityMetrics(input: CommunityMetricsInput, range: { from: Date; to: Date; now: Date }, minGroup = ANALYTICS_MIN_GROUP): CommunityMetrics {
  const { from, to, now } = range
  const within = (d: Date | null) => !!d && d >= from && d < to
  const ev = input.events.filter((e) => within(e.occurredAt))
  const sup = (n: number) => suppressSmall(n, minGroup)
  const count = (pred: (e: CommunityEventRow) => boolean) => ev.filter(pred).length
  const named = (name: AnalyticsEventName) => (e: CommunityEventRow) => e.name === name

  // 주간 활성(키 있는 행동만)
  const activity = ev.filter((e) => (COMMUNITY_ACTIVITY_EVENTS as readonly string[]).includes(e.name))
  const weeks = isoWeeksBetween(from, to)
  const weekly = weeks.map((week) => ({
    week,
    users: sup(new Set(activity.filter((e) => e.actorHash !== null && isoWeekOf(e.occurredAt) === week).map((e) => e.actorHash)).size),
  }))
  const communityAll = ev.filter(
    (e) => (COMMUNITY_ACTIVITY_EVENTS as readonly string[]).includes(e.name) || /^(community_|archive_transfer_)/.test(e.name) || e.name === 'course_qa_published',
  )

  // 글쓰기
  const posts = ev.filter(named('post_created'))
  const comments = ev.filter(named('comment_created'))
  const anon = [...posts, ...comments].filter((e) => e.props.mode === 'anonymous').length
  const namedWrites = [...posts, ...comments].filter((e) => e.props.mode === 'display' || e.props.mode === 'real').length
  const writes = posts.length + comments.length

  // 신고·처리
  const communityReports = count(named('community_report_filed'))
  const per = (k: number) => (sup(communityReports) === null || sup(posts.length) === null ? null : Math.round((communityReports / posts.length) * k * 10) / 10)
  const filedCases = input.cases.filter((c) => within(c.firstReportedAt))
  const reportsFiled = filedCases.reduce((s, c) => s + c.reports, 0)
  const closed = input.cases.filter((c) => within(c.closedAt))
  const firstAction = closed.filter((c) => c.firstActionAt).map((c) => c.firstActionAt!.getTime() - c.firstReportedAt.getTime())
  const resolution = closed.map((c) => c.closedAt!.getTime() - c.firstReportedAt.getTime())
  const autoClosed = closed.filter((c) => c.autoHiddenAt)
  const autoResolution = autoClosed.map((c) => c.closedAt!.getTime() - c.autoHiddenAt!.getTime())
  const met = closed.filter((c) => reportGroupSla(c, input.targets, now, c.closedAt).state !== 'overdue').length
  const reportedItems = filedCases.filter((c) => c.item)
  const restored = autoClosed.filter((c) => c.actionKind === 'none').length
  const open = input.openCases
  const overdueOpen = open.filter((c) => reportGroupSla(c, input.targets, now).state === 'overdue')
  const lookups = input.lookups.filter((l) => within(l.createdAt))
  const sanctions = input.sanctions.filter((s) => within(s.createdAt))

  // 전환
  const transfers = Object.fromEntries(
    ARCHIVE_TRANSFER_TARGETS.map((t) => {
      const requested = count((e) => e.name === 'archive_transfer_requested' && e.props.target === t)
      const completed = count((e) => e.name === 'archive_transfer_completed' && e.props.target === t)
      const r = rate(completed, requested, minGroup)
      return [t, { requested: r.denominator, completed: r.numerator, rate: r.rate }]
    }),
  ) as CommunityMetrics['conversion']['transfers']
  const questions = posts.filter((e) => e.props.kind === 'question').length
  const toStuck = count((e) => e.name === 'archive_transfer_completed' && (e.props.target === 'course_qa' || e.props.target === 'stuck_log'))
  const studyRooms = count((e) => e.name === 'recruitment_closed' && e.props.kind === 'study' && e.props.outcome === 'study_room')
  const studyWeeks = new Map<string, Set<string>>()
  for (const e of ev) {
    if (e.name !== 'log_saved' || e.props.origin !== 'study' || e.props.revision === true || !e.projectHash) continue
    const set = studyWeeks.get(e.projectHash) ?? new Set<string>()
    set.add(isoWeekOf(e.occurredAt))
    studyWeeks.set(e.projectHash, set)
  }
  const sustained = [...studyWeeks.values()].filter((w) => w.size >= STUDY_LOG_MIN_WEEKS).length
  const studyPublishedProjects = new Set(
    ev.filter((e) => e.name === 'publication_published' && e.props.origin === 'study' && e.projectHash && studyWeeks.has(e.projectHash)).map((e) => e.projectHash),
  ).size
  const closedBy = (outcome: string) => count((e) => e.name === 'recruitment_closed' && e.props.outcome === outcome)
  const filled = closedBy('project') + closedBy('study_room')

  // 운영 시간(주·분야별 합계, 사람별 없음)
  const timeWeeks = weeks.map((week) => {
    const rows = input.opsTime.filter((r) => r.week === week)
    const minutes = keysOf(OPS_TIME_CATEGORIES, (c) => sup(rows.reduce((s, r) => s + r[c], 0)))
    return { week, minutes, total: sup(rows.reduce((s, r) => s + opsTimeTotal(r), 0)), operators: sup(new Set(rows.map((r) => r.operatorKey)).size) }
  })
  const timeTotal = input.opsTime.filter((r) => weeks.includes(r.week)).reduce((s, r) => s + opsTimeTotal(r), 0)

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    minGroup,
    activity: {
      weeklyActive: weekly,
      keyedEvents: sup(communityAll.filter((e) => e.actorHash !== null).length),
      unkeyedEvents: sup(communityAll.filter((e) => e.actorHash === null).length),
    },
    writing: {
      posts: sup(posts.length),
      comments: sup(comments.length),
      postsByBoard: keysOf(COMMUNITY_BOARD_KINDS, (k) => sup(posts.filter((e) => e.props.kind === k).length)),
      postsByMode: keysOf(COMMUNITY_NAME_MODES, (m) => sup(posts.filter((e) => e.props.mode === m).length)),
      commentsByMode: keysOf(COMMUNITY_NAME_MODES, (m) => sup(comments.filter((e) => e.props.mode === m).length)),
      anonymousShare: rate(anon, writes, minGroup),
      namedShare: rate(namedWrites, writes, minGroup),
    },
    moderation: {
      reportsFiled: sup(reportsFiled),
      communityReportsFiled: sup(communityReports),
      reportsPer100Posts: per(100),
      reportsPer1000Posts: per(1000),
      casesClosed: sup(closed.length),
      medianFirstActionHours: suppressedMedianHours(firstAction, minGroup),
      medianResolutionHours: suppressedMedianHours(resolution, minGroup),
      medianAutoHiddenResolutionHours: suppressedMedianHours(autoResolution, minGroup),
      slaMet: rate(met, closed.length, minGroup),
      autoHideRate: rate(reportedItems.filter((c) => c.autoHiddenAt).length, reportedItems.length, minGroup),
      restoreRate: rate(restored, autoClosed.length, minGroup),
      sanctionsByLevel: keysOf(SANCTION_LEVEL_KEYS, (l) => sup(sanctions.filter((s) => s.level === l).length)),
      authorLookups: sup(lookups.length),
      authorLookupsLinked: rate(lookups.filter((l) => l.linked).length, lookups.length, minGroup),
      openCases: sup(open.length),
      overdueCases: sup(overdueOpen.length),
      overdueAutoHidden: sup(overdueOpen.filter((c) => c.autoHiddenAt).length),
    },
    conversion: {
      transfers,
      questionToStuck: rate(toStuck, questions, minGroup),
      studyRecordsEnabled: sup(count(named('study_record_enabled'))),
      studyRecordConversion: rate(sustained, studyRooms, minGroup),
      studyPublished: rate(studyPublishedProjects, studyWeeks.size, minGroup),
      recruitmentsCreated: keysOf(['team', 'study'] as const, (k) => sup(count((e) => e.name === 'recruitment_created' && e.props.kind === k))),
      recruitmentsClosed: keysOf(['project', 'study_room', 'cancelled'] as const, (o) => sup(closedBy(o))),
      recruitmentFillRate: rate(filled, filled + closedBy('cancelled'), minGroup),
    },
    opsTime: { weeks: timeWeeks, totalMinutes: sup(timeTotal) },
    notAvailable: COMMUNITY_METRICS_NOT_AVAILABLE,
  }
}

/** 공간별 보기(운영자가 고른 공간 하나, active 멤버 N 이상). 이름·id 없이 개수만. */
export interface SpaceItemFact {
  kind: 'post' | 'comment'
  boardKind: string | null
  mode: string
  createdAt: Date
  /** 익명이 아닌 글·댓글의 작성자 키(서로 다른 작성자 수에만 씀, 응답에 나가지 않음). 익명은 null. */
  namedAuthorKey: string | null
}

export interface SpaceBreakdown {
  postsByBoard: Record<(typeof COMMUNITY_BOARD_KINDS)[number], number | null>
  postsByMode: Record<(typeof COMMUNITY_NAME_MODES)[number], number | null>
  commentsByMode: Record<(typeof COMMUNITY_NAME_MODES)[number], number | null>
  anonymousShare: RateMetric
  /** 익명이 아닌 글·댓글을 쓴 서로 다른 사람 수. */
  namedWriters: number | null
  reportCases: number | null
  autoHidden: number | null
}

export function computeSpaceBreakdown(
  items: readonly SpaceItemFact[],
  cases: readonly ReportCaseFact[],
  range: { from: Date; to: Date },
  minGroup = ANALYTICS_MIN_GROUP,
): SpaceBreakdown {
  const within = (d: Date) => d >= range.from && d < range.to
  const sup = (n: number) => suppressSmall(n, minGroup)
  const inRange = items.filter((i) => within(i.createdAt))
  const posts = inRange.filter((i) => i.kind === 'post')
  const comments = inRange.filter((i) => i.kind === 'comment')
  const filed = cases.filter((c) => within(c.firstReportedAt))
  return {
    postsByBoard: keysOf(COMMUNITY_BOARD_KINDS, (k) => sup(posts.filter((p) => p.boardKind === k).length)),
    postsByMode: keysOf(COMMUNITY_NAME_MODES, (m) => sup(posts.filter((p) => p.mode === m).length)),
    commentsByMode: keysOf(COMMUNITY_NAME_MODES, (m) => sup(comments.filter((p) => p.mode === m).length)),
    anonymousShare: rate(inRange.filter((i) => i.mode === 'anonymous').length, inRange.length, minGroup),
    namedWriters: sup(new Set(inRange.map((i) => i.namedAuthorKey).filter((k): k is string => k !== null)).size),
    reportCases: sup(filed.length),
    autoHidden: sup(filed.filter((c) => c.autoHiddenAt).length),
  }
}

// ── CSV ──────────────────────────────────────────────────────────────────

const csvCell = (v: string | number | null) => {
  const text = v === null ? '' : String(v)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

const rateRows = (section: string, metric: string, r: RateMetric): Array<[string, string, string, number | null]> => [
  [section, metric, 'numerator', r.numerator],
  [section, metric, 'denominator', r.denominator],
  [section, metric, 'rate', r.rate],
]

/**
 * 집계 CSV(파일럿 보고서용). 머리 줄 `section,metric,dimension,value`. 가린 값은 빈 칸. id·이름·글·공간별 값은 넣지 않습니다
 * (dimension은 코드·ISO 주·날짜뿐).
 */
export function communityMetricsCsv(m: CommunityMetrics): string {
  const rows: Array<[string, string, string, number | string | null]> = [
    ['range', 'from', '', m.from],
    ['range', 'to', '', m.to],
    ['range', 'min_group', '', m.minGroup],
  ]
  for (const w of m.activity.weeklyActive) rows.push(['activity', 'weekly_active_users', w.week, w.users])
  rows.push(['activity', 'keyed_events', '', m.activity.keyedEvents], ['activity', 'unkeyed_events', '', m.activity.unkeyedEvents])
  rows.push(['writing', 'posts', '', m.writing.posts], ['writing', 'comments', '', m.writing.comments])
  for (const [k, v] of Object.entries(m.writing.postsByBoard)) rows.push(['writing', 'posts_by_board', k, v])
  for (const [k, v] of Object.entries(m.writing.postsByMode)) rows.push(['writing', 'posts_by_mode', k, v])
  for (const [k, v] of Object.entries(m.writing.commentsByMode)) rows.push(['writing', 'comments_by_mode', k, v])
  rows.push(...rateRows('writing', 'anonymous_share', m.writing.anonymousShare), ...rateRows('writing', 'named_share', m.writing.namedShare))
  const mod = m.moderation
  rows.push(
    ['moderation', 'reports_filed', '', mod.reportsFiled],
    ['moderation', 'community_reports_filed', '', mod.communityReportsFiled],
    ['moderation', 'reports_per_100_posts', '', mod.reportsPer100Posts],
    ['moderation', 'reports_per_1000_posts', '', mod.reportsPer1000Posts],
    ['moderation', 'cases_closed', '', mod.casesClosed],
    ['moderation', 'median_first_action_hours', '', mod.medianFirstActionHours],
    ['moderation', 'median_resolution_hours', '', mod.medianResolutionHours],
    ['moderation', 'median_auto_hidden_resolution_hours', '', mod.medianAutoHiddenResolutionHours],
    ...rateRows('moderation', 'sla_met', mod.slaMet),
    ...rateRows('moderation', 'auto_hide_rate', mod.autoHideRate),
    ...rateRows('moderation', 'restore_rate', mod.restoreRate),
  )
  for (const [k, v] of Object.entries(mod.sanctionsByLevel)) rows.push(['moderation', 'sanctions_by_level', k, v])
  rows.push(['moderation', 'author_lookups', '', mod.authorLookups], ...rateRows('moderation', 'author_lookups_linked', mod.authorLookupsLinked))
  rows.push(['moderation', 'open_cases_now', '', mod.openCases], ['moderation', 'overdue_cases_now', '', mod.overdueCases], ['moderation', 'overdue_auto_hidden_now', '', mod.overdueAutoHidden])
  const conv = m.conversion
  for (const [k, v] of Object.entries(conv.transfers)) {
    rows.push(['conversion', 'transfers_requested', k, v.requested], ['conversion', 'transfers_completed', k, v.completed], ['conversion', 'transfers_rate', k, v.rate])
  }
  rows.push(...rateRows('conversion', 'question_to_stuck', conv.questionToStuck), ['conversion', 'study_records_enabled', '', conv.studyRecordsEnabled])
  rows.push(...rateRows('conversion', 'study_record_conversion', conv.studyRecordConversion), ...rateRows('conversion', 'study_published', conv.studyPublished))
  for (const [k, v] of Object.entries(conv.recruitmentsCreated)) rows.push(['conversion', 'recruitments_created', k, v])
  for (const [k, v] of Object.entries(conv.recruitmentsClosed)) rows.push(['conversion', 'recruitments_closed', k, v])
  rows.push(...rateRows('conversion', 'recruitment_fill_rate', conv.recruitmentFillRate))
  for (const w of m.opsTime.weeks) {
    for (const [k, v] of Object.entries(w.minutes)) rows.push(['ops_time', 'minutes', `${w.week}:${k}`, v])
    rows.push(['ops_time', 'total_minutes', w.week, w.total], ['ops_time', 'operators_reporting', w.week, w.operators])
  }
  rows.push(['ops_time', 'total_minutes', 'all', m.opsTime.totalMinutes])
  for (const k of Object.keys(m.notAvailable)) rows.push(['not_available', k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), '', null])
  return ['section,metric,dimension,value', ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n'
}
