/**
 * pilot 분석 이벤트 규칙 (DELIVERY_PLAN §6 측정 계획, SYSTEM_DESIGN §14 관측, T-16, ADR 0016).
 *
 * - 이벤트 이름은 DELIVERY_PLAN §6의 최소 분석 이벤트 15개 + `login_succeeded`(활성화 지표의 가입 시점) + `affiliation_verified`(C-01, props는 standing만) + `space_created`·`space_joined`(C-02, 종류·가입 방식만) + `name_mode_scheduled`·`name_mode_applied`(C-03, 바꾸기 전·후 방식만) + `post_created`·`comment_created`·`reaction_added`(C-04, 게시판 종류·방식·답글 여부·대상 종류만) + `community_report_filed`·`community_auto_hidden`·`community_sanction_issued`(C-06, 대상 종류·제재 수준·범위만) + `recruitment_created`·`application_submitted`·`recruitment_closed`(C-07, 모집 종류·마감 결과만)입니다.
 * - props는 이벤트마다 허용 목록(ANALYTICS_PROP_SPECS)의 키만, 값은 정해진 enum 문자열·참거짓·범위 안의 정수만 받습니다.
 *   자유 문자열 필드는 없으므로 과제 본문·제목·파일 이름·URL·이메일·검색어가 들어갈 자리가 없습니다(§6 "본문·파일 내용·검색 원문·연락처 없음").
 *   목록 밖의 키·값이 하나라도 있으면 sanitizeAnalyticsProps가 거부하고, 웹 emitter는 그 이벤트를 버립니다(일부만 저장하지 않음).
 * - 지표(computePilotMetrics)는 이벤트만으로 계산하며, 작은 수(초안 5 미만)는 null로 가립니다(§11.2와 같은 임계값).
 *   기록 1회 작성 시간은 이벤트로 잴 수 없어 null입니다(인터뷰·관찰로 따로 잼).
 */

export const ANALYTICS_EVENT_NAMES = [
  'project_created',
  'log_saved',
  'evidence_attached',
  'milestone_snapshot_set',
  'checkin_submitted',
  'claim_endorsed',
  'report_exported',
  'candidate_prepared',
  'consent_completed',
  'publication_published',
  'publication_withdrawn',
  'plan_forked',
  'usefulness_marked',
  'senior_note_published',
  'portfolio_shared',
  'login_succeeded',
  'affiliation_verified',
  'space_created',
  'space_joined',
  'name_mode_scheduled',
  'name_mode_applied',
  'post_created',
  'comment_created',
  'reaction_added',
  'community_report_filed',
  'community_auto_hidden',
  'community_sanction_issued',
  'recruitment_created',
  'application_submitted',
  'recruitment_closed',
] as const
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

export type AnalyticsPropSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  /** 개수·수준·번호: 정수, min 이상 max 이하. */
  | { kind: 'int'; min: number; max: number }

export type AnalyticsPropValue = string | number | boolean
export type AnalyticsProps = Readonly<Record<string, AnalyticsPropValue>>

const LOG_TAGS = ['progress', 'stuck', 'solution', 'decision', 'meeting', 'validation', 'retro'] as const
const LOG_SOURCES = ['web', 'discord', 'ai', 'task', 'retro'] as const
const NAME_MODE_VALUES = ['real', 'display', 'anonymous'] as const
const enumOf = (values: readonly string[]): AnalyticsPropSpec => ({ kind: 'enum', values })
const bool: AnalyticsPropSpec = { kind: 'bool' }
const count = (max: number, min = 0): AnalyticsPropSpec => ({ kind: 'int', min, max })

/**
 * 이벤트별 허용 props. 새 키를 더할 때는 개인을 식별하거나 내용을 담을 수 없는 값(정해진 코드·개수)인지 먼저 확인하세요.
 * 모든 키는 선택입니다(없어도 됨). 목록 밖 키는 거부합니다.
 */
export const ANALYTICS_PROP_SPECS: Readonly<Record<AnalyticsEventName, Readonly<Record<string, AnalyticsPropSpec>>>> = {
  project_created: { kind: enumOf(['individual', 'team']), retro: bool, withCourse: bool, origin: enumOf(['web', 'fork', 'recruitment']) },
  log_saved: { tag: enumOf(LOG_TAGS), source: enumOf(LOG_SOURCES), revision: bool },
  evidence_attached: { target: enumOf(['log', 'claim']), files: count(20), links: count(10), logs: count(20) },
  milestone_snapshot_set: { retro: bool },
  checkin_submitted: {
    timeBucket: enumOf(['none', 'lt2h', 'lt5h', 'lt10h', 'ten_plus']),
    difficulty: count(5, 1),
    shareForStats: bool,
    promoted: bool,
    skipReasons: count(5),
  },
  claim_endorsed: { status: enumOf(['confirmed', 'disputed']) },
  report_exported: { days: count(400, 1) },
  candidate_prepared: {
    level: enumOf(['summary', 'full']),
    logs: count(1000),
    claims: count(1000),
    milestones: count(100),
    files: count(1000),
    derived: bool,
  },
  consent_completed: { decision: enumOf(['granted', 'declined']), allGranted: bool },
  publication_published: { level: enumOf(['summary', 'full']), releaseNo: count(10000, 1), republish: bool },
  publication_withdrawn: { cause: enumOf(['owner', 'consent_revoked', 'restricted']) },
  plan_forked: { milestones: count(100), references: count(1000) },
  usefulness_marked: { target: enumOf(['stuck_item', 'senior_note']), kind: enumOf(['me_too', 'helped']) },
  senior_note_published: { displayMode: enumOf(['name', 'display', 'anonymous']), answers: count(4) },
  portfolio_shared: { featured: count(5), competencies: count(12), skills: count(20) },
  login_succeeded: { newUser: bool },
  // 학교 메일 인증 성공(C-01). 학교 id·도메인은 넣지 않습니다(작은 학교는 학교만으로 사람을 좁힐 수 있음). 재학/졸업생 구분만.
  affiliation_verified: { standing: enumOf(['student', 'alumni']) },
  // 커뮤니티 공간(C-02). 공간·학교 id·이름은 넣지 않습니다(사용자 키만 해시). 종류·가입 방식만.
  space_created: { kind: enumOf(['official_school', 'official_department', 'user_room', 'study_room']) },
  space_joined: {
    kind: enumOf(['user_room', 'study_room']),
    policy: enumOf(['open', 'approval', 'invite']),
  },
  // 이름 표시 방식 변경(C-03). 공간 id·이름은 넣지 않습니다. 바꾸기 전·후 방식만.
  name_mode_scheduled: { from: enumOf(NAME_MODE_VALUES), to: enumOf(NAME_MODE_VALUES) },
  name_mode_applied: { from: enumOf(NAME_MODE_VALUES), to: enumOf(NAME_MODE_VALUES) },
  // 커뮤니티 글·댓글·공감(C-04). 글·공간·게시판 id·제목·본문은 넣지 않습니다. 게시판 종류·고정된 이름 표시 방식·답글 여부·공감 대상 종류만.
  // 익명 글·댓글은 사용자 키 없이 기록합니다(웹 emitter의 unlinked, SYSTEM_DESIGN §6.7 "익명 글과 프로필의 분리").
  post_created: { kind: enumOf(['free', 'freshmen', 'alumni', 'question', 'info', 'recruiting', 'notice', 'general']), mode: enumOf(NAME_MODE_VALUES) },
  comment_created: { mode: enumOf(NAME_MODE_VALUES), reply: bool },
  reaction_added: { target: enumOf(['post', 'comment']) },
  // C-06(ADR 0023): 대상 종류·제재 수준·범위만. 신고·글·공간·사람 id, 사유, 신고 수는 없습니다.
  community_report_filed: { targetKind: enumOf(['space', 'post', 'comment', 'recruitment', 'application']) },
  community_auto_hidden: { targetKind: enumOf(['post', 'comment']) },
  community_sanction_issued: { level: enumOf(['warning', 'write_suspended', 'permanent']), scope: enumOf(['community', 'space']) },
  // C-07(ADR 0024): 모집 종류·마감 결과만. 모집·공간·과목·사람 id, 제목, 지원자 수는 없습니다.
  recruitment_created: { kind: enumOf(['team', 'study']) },
  application_submitted: { kind: enumOf(['team', 'study']) },
  recruitment_closed: { kind: enumOf(['team', 'study']), outcome: enumOf(['project', 'study_room', 'cancelled']) },
}

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value)
}

export type SanitizeResult = { ok: true; props: Record<string, AnalyticsPropValue> } | { ok: false; violations: string[] }

/**
 * 허용 목록 검사. 통과하면 같은 키·값의 새 객체(키 정렬), 아니면 위반한 키 이름 목록(값은 싣지 않음).
 * undefined 값은 없는 키로 봅니다.
 */
export function sanitizeAnalyticsProps(name: AnalyticsEventName, props: Readonly<Record<string, unknown>> = {}): SanitizeResult {
  const specs = ANALYTICS_PROP_SPECS[name]
  if (!specs) return { ok: false, violations: ['_name'] }
  const violations: string[] = []
  const out: Record<string, AnalyticsPropValue> = {}
  for (const key of Object.keys(props).sort()) {
    const value = props[key]
    if (value === undefined) continue
    const spec = Object.hasOwn(specs, key) ? specs[key] : undefined
    if (!spec || !matches(spec, value)) {
      violations.push(key)
      continue
    }
    out[key] = value as AnalyticsPropValue
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true, props: out }
}

function matches(spec: AnalyticsPropSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
    case 'bool':
      return typeof value === 'boolean'
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max
  }
}

// ── 지표 (DELIVERY_PLAN §6) ──────────────────────────────────────────────

/** 작은 수 가림 임계값(초안, §11.2와 같음). */
export const ANALYTICS_MIN_GROUP = 5
/** 활성화 기준(§6): 가입 7일 이내 과제 생성 + 로그 3개 + 근거 하나. */
export const ACTIVATION_WINDOW_DAYS = 7
export const ACTIVATION_MIN_LOGS = 3
/** 기록 유지: 4주 중 3주 이상. */
export const RETENTION_WEEKS = 4
export const RETENTION_MIN_WEEKS = 3

export interface AnalyticsEventRow {
  name: AnalyticsEventName
  occurredAt: Date
  actorHash: string
  projectHash: string | null
  props: Readonly<Record<string, unknown>>
}

export interface RateMetric {
  denominator: number | null
  numerator: number | null
  /** 0~1, 소수 셋째 자리. 분자·분모 중 하나라도 가려지면 null. */
  rate: number | null
}

export interface PilotMetrics {
  from: string
  to: string
  minGroup: number
  /** 기간 안에 처음 로그인한(가입한) 사람 중 7일이 지난 사람 → 7일 안에 과제 생성 + 로그 3 + 근거 1. */
  activation: RateMetric
  /** `to` 이전 4주(7일 × 4)에 로그를 남긴 사람 → 그중 3주 이상 남긴 사람. */
  retention: RateMetric
  /** 기간 안에 공개 후보를 만든 과제(서로 다른 과제) → 그중 기간 안에 게시한 과제. "공개 허용이 확인된 종료 과제"는 이벤트로 알 수 없어 근사입니다. */
  caseConversion: RateMetric
  /** 북극성 지표 재료: 플랜 포크 수, "도움됐어요" 수, 합계. */
  northStar: { planForks: number | null; helpedMarks: number | null; total: number | null }
  /** 기여 리포트 인쇄(내보내기) 수와 서로 다른 과제 수. */
  reportExports: { exports: number | null; projects: number | null }
  /** 포트폴리오 판을 만든(공유한) 서로 다른 사람 수. */
  portfolioSharers: number | null
  seniorNotesPublished: number | null
  /** 기록 1회 작성 시간: 이벤트로 잴 수 없음(인터뷰·관찰). */
  writeTimeMedianMinutes: null
  /** 이벤트 이름별 기간 안 개수. */
  eventCounts: Record<AnalyticsEventName, number | null>
}

const DAY_MS = 24 * 60 * 60 * 1000

/** min 미만이면 null. */
export function suppressSmall(value: number, minGroup = ANALYTICS_MIN_GROUP): number | null {
  return value < minGroup ? null : value
}

function rateMetric(numerator: number, denominator: number, minGroup: number): RateMetric {
  const n = suppressSmall(numerator, minGroup)
  const d = suppressSmall(denominator, minGroup)
  return { denominator: d, numerator: n, rate: n === null || d === null ? null : Math.round((numerator / denominator) * 1000) / 1000 }
}

/**
 * 지표 계산(순수 함수). events에는 [from − 28일, to + 7일) 범위의 이벤트를 넘기면 충분합니다.
 * `now`는 활성화 분모(가입 뒤 7일이 지난 사람만)를 정합니다.
 */
export function computePilotMetrics(
  events: readonly AnalyticsEventRow[],
  range: { from: Date; to: Date; now: Date },
  minGroup = ANALYTICS_MIN_GROUP,
): PilotMetrics {
  const { from, to, now } = range
  const inRange = (e: AnalyticsEventRow) => e.occurredAt >= from && e.occurredAt < to
  const ranged = events.filter(inRange)

  // 활성화
  const signups = new Map<string, Date>()
  for (const e of events) {
    if (e.name !== 'login_succeeded' || e.props.newUser !== true) continue
    const prev = signups.get(e.actorHash)
    if (!prev || e.occurredAt < prev) signups.set(e.actorHash, e.occurredAt)
  }
  let cohort = 0
  let activated = 0
  for (const [actor, at] of signups) {
    if (at < from || at >= to) continue
    const end = new Date(at.getTime() + ACTIVATION_WINDOW_DAYS * DAY_MS)
    if (end > now) continue
    cohort++
    const mine = events.filter((e) => e.actorHash === actor && e.occurredAt >= at && e.occurredAt < end)
    const projects = mine.filter((e) => e.name === 'project_created').length
    const logs = mine.filter((e) => e.name === 'log_saved' && e.props.revision !== true).length
    const evidence = mine.filter((e) => e.name === 'evidence_attached').length
    if (projects >= 1 && logs >= ACTIVATION_MIN_LOGS && evidence >= 1) activated++
  }

  // 기록 유지
  const windowStart = to.getTime() - RETENTION_WEEKS * 7 * DAY_MS
  const weeksByActor = new Map<string, Set<number>>()
  for (const e of events) {
    if (e.name !== 'log_saved') continue
    const t = e.occurredAt.getTime()
    if (t < windowStart || t >= to.getTime()) continue
    const week = Math.floor((t - windowStart) / (7 * DAY_MS))
    const set = weeksByActor.get(e.actorHash) ?? new Set<number>()
    set.add(week)
    weeksByActor.set(e.actorHash, set)
  }
  const retained = [...weeksByActor.values()].filter((weeks) => weeks.size >= RETENTION_MIN_WEEKS).length

  // 사례 전환
  const prepared = new Set(ranged.filter((e) => e.name === 'candidate_prepared' && e.projectHash).map((e) => e.projectHash!))
  const published = new Set(
    ranged.filter((e) => e.name === 'publication_published' && e.projectHash && prepared.has(e.projectHash)).map((e) => e.projectHash!),
  )

  const countOf = (pred: (e: AnalyticsEventRow) => boolean) => ranged.filter(pred).length
  const planForks = countOf((e) => e.name === 'plan_forked')
  const helped = countOf((e) => e.name === 'usefulness_marked' && e.props.kind === 'helped')
  const exportsRows = ranged.filter((e) => e.name === 'report_exported')
  const eventCounts = Object.fromEntries(
    ANALYTICS_EVENT_NAMES.map((name) => [name, suppressSmall(countOf((e) => e.name === name), minGroup)]),
  ) as Record<AnalyticsEventName, number | null>

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    minGroup,
    activation: rateMetric(activated, cohort, minGroup),
    retention: rateMetric(retained, weeksByActor.size, minGroup),
    caseConversion: rateMetric(published.size, prepared.size, minGroup),
    northStar: {
      planForks: suppressSmall(planForks, minGroup),
      helpedMarks: suppressSmall(helped, minGroup),
      total: suppressSmall(planForks + helped, minGroup),
    },
    reportExports: {
      exports: suppressSmall(exportsRows.length, minGroup),
      projects: suppressSmall(new Set(exportsRows.map((e) => e.projectHash).filter(Boolean)).size, minGroup),
    },
    portfolioSharers: suppressSmall(new Set(ranged.filter((e) => e.name === 'portfolio_shared').map((e) => e.actorHash)).size, minGroup),
    seniorNotesPublished: suppressSmall(countOf((e) => e.name === 'senior_note_published'), minGroup),
    writeTimeMedianMinutes: null,
    eventCounts,
  }
}
