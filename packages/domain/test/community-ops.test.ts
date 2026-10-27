import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_PROP_SPECS,
  OPS_TIME_WEEK_MINUTES_MAX,
  REPORT_SLA_DEFAULT_AUTO_HIDDEN_HOURS,
  REPORT_SLA_DEFAULT_HOURS,
  type CommunityEventRow,
  type CommunityMetricsInput,
  type ReportCaseFact,
  checkOpsTimeWeek,
  communityMetricsCsv,
  computeCommunityMetrics,
  computeSpaceBreakdown,
  isoWeeksBetween,
  median,
  opsTimeTotal,
  parseSlaHours,
  reportGroupSla,
  reportSlaTargets,
  sanitizeAnalyticsProps,
  slaState,
  suppressedMedianHours,
} from '../src'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = new Date('2027-03-01T00:00:00Z') // 월요일 09:00 서울
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR)
const hex = (n: number) => n.toString(16).padStart(64, '0')
const TARGETS = { autoHiddenHours: 24, normalHours: 72 }

describe('report SLA', () => {
  it('parses env targets with defaults and bounds', () => {
    expect(reportSlaTargets({})).toEqual({ autoHiddenHours: REPORT_SLA_DEFAULT_AUTO_HIDDEN_HOURS, normalHours: REPORT_SLA_DEFAULT_HOURS })
    expect(reportSlaTargets({ PEERCHIVE_REPORT_SLA_AUTO_HIDDEN_HOURS: '12', PEERCHIVE_REPORT_SLA_HOURS: '48' })).toEqual({ autoHiddenHours: 12, normalHours: 48 })
    for (const bad of ['0', '-1', '721', '1.5', 'abc', ' ']) expect(parseSlaHours(bad, 24)).toBe(24)
    expect(parseSlaHours(' 720 ', 24)).toBe(720)
  })

  it('classifies ok / due_soon (75%) / overdue', () => {
    expect(slaState(17 * HOUR, 24)).toBe('ok')
    expect(slaState(18 * HOUR, 24)).toBe('due_soon')
    expect(slaState(24 * HOUR, 24)).toBe('due_soon')
    expect(slaState(24 * HOUR + 1, 24)).toBe('overdue')
  })

  it('auto-hidden groups use the hidden time and the 24h target; others the first report and 72h', () => {
    const hidden = reportGroupSla({ firstReportedAt: at(0), autoHiddenAt: at(10) }, TARGETS, at(30))
    expect(hidden).toMatchObject({ priority: 'auto_hidden', targetHours: 24, state: 'due_soon', ageSeconds: 20 * 3600 })
    expect(hidden.dueAt).toEqual(at(34))
    expect(reportGroupSla({ firstReportedAt: at(0), autoHiddenAt: at(10) }, TARGETS, at(35)).state).toBe('overdue')
    const normal = reportGroupSla({ firstReportedAt: at(0), autoHiddenAt: null }, TARGETS, at(35))
    expect(normal).toMatchObject({ priority: 'normal', targetHours: 72, state: 'ok' })
    expect(reportGroupSla({ firstReportedAt: at(0), autoHiddenAt: null }, TARGETS, at(80)).state).toBe('overdue')
    // 끝난 묶음은 처리 시각까지로 잼(지금 시각과 무관)
    expect(reportGroupSla({ firstReportedAt: at(0), autoHiddenAt: null }, TARGETS, at(500), at(10)).state).toBe('ok')
  })

  it('median and suppressed median hours', () => {
    expect(median([])).toBeNull()
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(suppressedMedianHours([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR])).toBeNull()
    expect(suppressedMedianHours([HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 30 * HOUR])).toBe(3)
  })
})

describe('ops time weeks', () => {
  it('accepts this week and up to 52 weeks back, rejects future, too old and malformed weeks', () => {
    const now = new Date('2027-03-03T03:00:00Z') // 2027-W09
    expect(checkOpsTimeWeek('2027-W09', now)).toBe('ok')
    expect(checkOpsTimeWeek('2027-W08', now)).toBe('ok')
    expect(checkOpsTimeWeek('2026-W10', now)).toBe('ok')
    expect(checkOpsTimeWeek('2026-W09', now)).toBe('too_old')
    expect(checkOpsTimeWeek('2027-W10', now)).toBe('future')
    for (const bad of ['2027-09', '2027-W9', '2027-W54', 'x', '2025-W53']) expect(checkOpsTimeWeek(bad, now)).toBe('invalid')
  })

  it('totals categories and lists ISO weeks in a range', () => {
    expect(opsTimeTotal({ reports: 60, official_pages: 30, affiliation_support: 0, curation: 15, other: 5 })).toBe(110)
    expect(OPS_TIME_WEEK_MINUTES_MAX).toBe(10080)
    expect(isoWeeksBetween(new Date('2027-02-28T15:00:00Z'), new Date('2027-03-14T15:00:00Z'))).toEqual(['2027-W09', '2027-W10'])
    expect(isoWeeksBetween(new Date('2027-02-27T15:00:00Z'), new Date('2027-03-01T15:00:00Z'))).toEqual(['2027-W08', '2027-W09'])
  })
})

describe('analytics allowlist for C-10', () => {
  it('post_created carries area (official/room/study) and community_author_lookup only a basis code', () => {
    expect(sanitizeAnalyticsProps('post_created', { kind: 'question', mode: 'anonymous', area: 'room' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('post_created', { area: 'my-room' }).ok).toBe(false)
    expect(sanitizeAnalyticsProps('community_author_lookup', { basis: 'report' }).ok).toBe(true)
    for (const leak of [{ reportId: 'x' }, { basis: 'because 신고 #12' }, { reason: '사유' }]) expect(sanitizeAnalyticsProps('community_author_lookup', leak).ok).toBe(false)
    expect(Object.keys(ANALYTICS_PROP_SPECS.community_author_lookup)).toEqual(['basis'])
  })
})

// ── 지표 fixture ──────────────────────────────────────────────────────────

const ev = (name: CommunityEventRow['name'], hours: number, props: Record<string, unknown> = {}, actor: number | null = null, project: number | null = null): CommunityEventRow => ({
  name,
  occurredAt: at(hours),
  actorHash: actor === null ? null : hex(actor),
  projectHash: project === null ? null : hex(project),
  props,
})

const kase = (over: Partial<ReportCaseFact>): ReportCaseFact => ({
  community: true,
  item: true,
  firstReportedAt: at(1),
  reports: 1,
  firstActionAt: null,
  autoHiddenAt: null,
  closedAt: null,
  actionKind: null,
  ...over,
})

function fixture(): CommunityMetricsInput {
  const events: CommunityEventRow[] = []
  // 주 1(2027-W09): 표시명 글 6명(키 있음), 익명 글 4개(키 없음), 익명 댓글 6개(키 없음), 질문 글 5개(익명)
  for (let i = 0; i < 6; i++) events.push(ev('post_created', 2 + i, { kind: 'free', mode: 'display', area: 'room' }, 100 + i))
  for (let i = 0; i < 4; i++) events.push(ev('post_created', 3 + i, { kind: 'general', mode: 'anonymous', area: 'room' }))
  for (let i = 0; i < 5; i++) events.push(ev('post_created', 4 + i, { kind: 'question', mode: 'anonymous', area: 'official' }))
  for (let i = 0; i < 6; i++) events.push(ev('comment_created', 5 + i, { mode: 'anonymous', reply: false }))
  // 같은 사람(100)이 다른 행동도 → 주간 활성은 여전히 6
  events.push(ev('space_joined', 6, { kind: 'user_room', policy: 'open' }, 100))
  // 주 2: 키 있는 사람 3명뿐 → 가림
  for (let i = 0; i < 3; i++) events.push(ev('reaction_added', 24 * 7 + 2, { target: 'post' }, 200 + i))
  // 신고 이벤트 10(키 없음)
  for (let i = 0; i < 10; i++) events.push(ev('community_report_filed', 12, { targetKind: 'post' }))
  // 옮기기: 질문 → Q&A 요청 6, 완료 5 / 막힘 로그 요청 2 → 가림
  for (let i = 0; i < 6; i++) events.push(ev('archive_transfer_requested', 20, { target: 'course_qa' }))
  for (let i = 0; i < 5; i++) events.push(ev('archive_transfer_completed', 30, { target: 'course_qa' }))
  for (let i = 0; i < 2; i++) events.push(ev('archive_transfer_requested', 20, { target: 'stuck_log' }))
  // 모집: 스터디 방 마감 6, 과제 0, 취소 4 → 성사 6/10
  for (let i = 0; i < 6; i++) events.push(ev('recruitment_closed', 40, { kind: 'study', outcome: 'study_room' }, 300 + i))
  for (let i = 0; i < 4; i++) events.push(ev('recruitment_closed', 40, { kind: 'team', outcome: 'cancelled' }, 310 + i))
  // 스터디 기록 로그: 과제 1~5는 3주, 과제 6은 1주 → 5/6 지속(분모는 스터디 방 6)
  for (let p = 1; p <= 6; p++) {
    const weeks = p <= 5 ? [0, 1, 2] : [0]
    for (const w of weeks) events.push(ev('log_saved', 24 * 7 * w + 50, { tag: 'progress', source: 'web', revision: false, origin: 'study' }, 400 + p, 900 + p))
  }
  // 범위 밖
  events.push(ev('post_created', -24, { kind: 'free', mode: 'display' }, 999))
  const cases: ReportCaseFact[] = []
  // 처리된 임시 숨김 6건: 숨김 1시간 뒤 첫 조치, 숨김 10시간 뒤 처리, 그중 5건 복원(none), 1건 숨김 확정
  for (let i = 0; i < 6; i++) {
    cases.push(kase({ firstReportedAt: at(1), autoHiddenAt: at(2), firstActionAt: at(3), closedAt: at(12), actionKind: i < 5 ? 'none' : 'hide_post', reports: 3 }))
  }
  // 처리된 일반 신고 5건(기록 대상 포함): 첫 신고 100시간 뒤 처리 → 기한(72) 넘김
  for (let i = 0; i < 5; i++) cases.push(kase({ community: i < 2, item: false, firstReportedAt: at(1), firstActionAt: at(50), closedAt: at(101), actionKind: 'none' }))
  const open = [kase({ firstReportedAt: at(1), autoHiddenAt: at(2) }), kase({ firstReportedAt: at(1) })]
  return {
    events,
    cases: [...cases, ...open],
    openCases: open,
    sanctions: [...Array.from({ length: 5 }, () => ({ level: 'warning' as const, createdAt: at(20) })), { level: 'permanent' as const, createdAt: at(20) }],
    lookups: Array.from({ length: 6 }, (_, i) => ({ createdAt: at(15), linked: i < 5 })),
    opsTime: [
      { week: '2027-W09', operatorKey: 'a', reports: 120, official_pages: 30, affiliation_support: 3, curation: 0, other: 0 },
      { week: '2027-W09', operatorKey: 'b', reports: 60, official_pages: 0, affiliation_support: 1, curation: 0, other: 0 },
      { week: '2026-W01', operatorKey: 'a', reports: 999, official_pages: 0, affiliation_support: 0, curation: 0, other: 0 },
    ],
    targets: TARGETS,
  }
}

describe('computeCommunityMetrics', () => {
  // 서울 2027-03-01(월) 0시 ~ 3주
  const FROM = new Date('2027-02-28T15:00:00Z')
  const range = { from: FROM, to: new Date(FROM.getTime() + 21 * DAY), now: at(24 * 30) }
  const m = computeCommunityMetrics(fixture(), range)

  it('weekly active counts keyed actors only; unkeyed (anonymous) events never become people', () => {
    expect(m.activity.weeklyActive.map((w) => w.week)).toEqual(['2027-W09', '2027-W10', '2027-W11'])
    // W09: 표시명 글 6명 + 모집 마감 10명(같은 사람의 다른 행동은 한 번), 익명 글·댓글 15개는 사람으로 세지 않음
    expect(m.activity.weeklyActive[0]!.users).toBe(16)
    expect(m.activity.weeklyActive[1]!.users).toBeNull() // 3명 → 가림
    expect(m.activity.weeklyActive[2]!.users).toBeNull()
    expect(m.activity.unkeyedEvents).toBe(38)
    expect(m.activity.keyedEvents).toBe(20)
  })

  it('writing by board and mode with anonymous share and suppression', () => {
    expect(m.writing.posts).toBe(15)
    expect(m.writing.comments).toBe(6)
    expect(m.writing.postsByBoard).toMatchObject({ free: 6, question: 5, general: null, notice: null })
    expect(m.writing.postsByMode).toMatchObject({ display: 6, anonymous: 9, real: null })
    expect(m.writing.commentsByMode).toMatchObject({ anonymous: 6, display: null })
    expect(m.writing.anonymousShare).toEqual({ numerator: 15, denominator: 21, rate: 0.714 })
    expect(m.writing.namedShare).toEqual({ numerator: 6, denominator: 21, rate: 0.286 })
  })

  it('moderation: reports per posts, medians, SLA met, auto-hide and restore rates, sanctions, lookups, open/overdue', () => {
    expect(m.moderation).toMatchObject({
      reportsFiled: 25,
      communityReportsFiled: 10,
      reportsPer100Posts: 66.7,
      reportsPer1000Posts: 666.7,
      casesClosed: 11,
      medianFirstActionHours: 2,
      medianResolutionHours: 11,
      medianAutoHiddenResolutionHours: 10,
      slaMet: { numerator: 6, denominator: 11, rate: 0.545 },
      autoHideRate: { numerator: 7, denominator: 8, rate: 0.875 },
      restoreRate: { numerator: 5, denominator: 6, rate: 0.833 },
      sanctionsByLevel: { warning: 5, write_suspended: null, permanent: null },
      authorLookups: 6,
      authorLookupsLinked: { numerator: 5, denominator: 6, rate: 0.833 },
      // 지금 처리 전 2건·기한 넘김 2건·그중 임시 숨김 1건: 모두 5 미만이라 가림
      openCases: null,
      overdueCases: null,
      overdueAutoHidden: null,
    })
  })

  it('conversion: transfers, question → stuck, study record (3 weeks), recruitment fill rate', () => {
    expect(m.conversion.transfers.course_qa).toEqual({ requested: 6, completed: 5, rate: 0.833 })
    expect(m.conversion.transfers.stuck_log).toEqual({ requested: null, completed: null, rate: null })
    expect(m.conversion.questionToStuck).toEqual({ numerator: 5, denominator: 5, rate: 1 })
    expect(m.conversion.studyRecordConversion).toEqual({ numerator: 5, denominator: 6, rate: 0.833 })
    expect(m.conversion.studyPublished).toEqual({ numerator: null, denominator: 6, rate: null })
    expect(m.conversion.recruitmentsClosed).toEqual({ project: null, study_room: 6, cancelled: null })
    expect(m.conversion.recruitmentFillRate).toEqual({ numerator: 6, denominator: 10, rate: 0.6 })
  })

  it('ops time: weekly totals by category, operators count suppressed, no per-operator values, weeks outside the range ignored', () => {
    const w09 = m.opsTime.weeks.find((w) => w.week === '2027-W09')!
    expect(w09).toEqual({ week: '2027-W09', minutes: { reports: 180, official_pages: 30, affiliation_support: null, curation: null, other: null }, total: 214, operators: null })
    expect(m.opsTime.totalMinutes).toBe(214)
    expect(JSON.stringify(m.opsTime)).not.toMatch(/"a"|"b"|operatorKey/)
  })

  it('every number cell is either null or at least 5 (suppression everywhere), and not-available metrics carry reasons', () => {
    const bad: string[] = []
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'number' && !path.endsWith('.rate') && !path.includes('Hours') && !path.endsWith('minGroup') && !path.includes('Per1') && v < 5) bad.push(`${path}=${v}`)
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`)
    }
    walk(m, 'm')
    expect(bad).toEqual([])
    for (const v of Object.values(m.notAvailable)) expect(v).toMatchObject({ value: null, reason: expect.any(String) })
  })

  it('CSV holds codes, weeks and numbers only (no hashes, ids or names); suppressed cells are empty', () => {
    const csv = communityMetricsCsv(m)
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe('section,metric,dimension,value')
    expect(lines).toContain('writing,posts_by_board,free,6')
    expect(lines).toContain('writing,posts_by_board,general,')
    expect(lines).toContain('moderation,median_auto_hidden_resolution_hours,,10')
    expect(lines).toContain('ops_time,minutes,2027-W09:reports,180')
    expect(csv).not.toMatch(/[0-9a-f]{32}/)
    for (const line of lines.slice(1)) {
      const [section, metric, dimension] = line.split(',')
      expect(section).toMatch(/^[a-z_]+$/)
      expect(metric).toMatch(/^[a-z_0-9]+$/)
      expect(dimension ?? '').toMatch(/^([a-z_]*|\d{4}-W\d{2}(:[a-z_]+)?|all)$/)
    }
  })
})

describe('computeSpaceBreakdown', () => {
  it('counts per board/mode, named writers without anonymous authors, suppresses small cells', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'post' as const, boardKind: 'free', mode: 'display', createdAt: at(1), namedAuthorKey: `u${i}` })),
      ...Array.from({ length: 7 }, () => ({ kind: 'comment' as const, boardKind: null, mode: 'anonymous', createdAt: at(1), namedAuthorKey: null })),
      { kind: 'post' as const, boardKind: 'free', mode: 'display', createdAt: at(-10), namedAuthorKey: 'old' },
    ]
    const b = computeSpaceBreakdown(items, [kase({ autoHiddenAt: at(2) })], { from: T0, to: at(100) })
    expect(b.postsByBoard.free).toBe(6)
    expect(b.commentsByMode.anonymous).toBe(7)
    expect(b.namedWriters).toBe(6)
    expect(b.anonymousShare).toEqual({ numerator: 7, denominator: 13, rate: 0.538 })
    expect(b.reportCases).toBeNull()
    expect(b.autoHidden).toBeNull()
  })
})
