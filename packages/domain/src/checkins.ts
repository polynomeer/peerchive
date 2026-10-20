/**
 * 주간 체크인·디스코드 알림 일정 규칙 (PROOFU_EVOLUTION_PLAN §6.4, SYSTEM_DESIGN §6.3 WeeklyCheckin·§11.2, pilot-kit §3, T-09).
 *
 * - 주는 서울 날짜 기준 ISO 주(월~일)이며 `YYYY-Www`로 씁니다(연도는 ISO 주 연도: 그 주 목요일이 속한 해).
 * - 체크인은 이번 주와 지난주만 쓰고 고칠 수 있습니다(일요일 20시 알림, 월요일 12시 마감 뒤에도 늦게 낼 수 있게).
 * - 통계 공유는 체크인과 따로 동의하며 기본은 꺼짐입니다. 집계는 공유에 동의한 서로 다른 사람이
 *   임계값(초안 5명) 이상일 때만 결과를 돌려주고, 미만이면 null입니다(§11.2).
 * - 알림 일정(서울): 체크인 알림은 일요일 20:00~월요일 12:00(마감) 사이, 주간 요약은 화요일 10:00~수요일 10:00 사이에
 *   "보낼 때"입니다. 봇이 그 사이 언제든 물어보면 (채널, 종류, 주)마다 한 번만 만들어집니다(서버의 unique).
 *   창을 놓치면(봇이 하루 넘게 꺼져 있었으면) 늦은 알림을 보내지 않습니다.
 */
/** 🧱막힘 로그 payload의 시간 구간(apps/web logs/payloads.ts TIME_BUCKETS와 같은 값). */
export type LogTimeBucket = 'lt30m' | 'lt2h' | 'half_day' | 'day_plus'

export const CHECKIN_TIME_BUCKETS = ['none', 'lt2h', 'lt5h', 'lt10h', 'ten_plus'] as const
export type CheckinTimeBucket = (typeof CHECKIN_TIME_BUCKETS)[number]

/** 기록을 못 했거나 덜 한 이유(pilot-kit §3 6번, 복수 선택). */
export const CHECKIN_SKIP_REASONS = ['busy', 'bothersome', 'nothing_to_log', 'unsure_where', 'other'] as const
export type CheckinSkipReason = (typeof CHECKIN_SKIP_REASONS)[number]

export const CHECKIN_NOTE_MAX = 200
export const CHECKIN_DIFFICULTY_MIN = 1
export const CHECKIN_DIFFICULTY_MAX = 5
/** 익명 집계 최소 인원(초안, pilot에서 확정, §11.2). */
export const CHECKIN_STATS_MIN_GROUP = 5

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const ISO_WEEK_PATTERN = /^(\d{4})-W(\d{2})$/

const pad = (n: number, width = 2) => String(n).padStart(width, '0')
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** UTC 자정 기준 날짜 ms의 ISO 주. */
function isoWeekOfDateMs(dayMs: number): string {
  const weekday = (new Date(dayMs).getUTCDay() + 6) % 7 // 월 0 … 일 6
  const thursday = new Date(dayMs + (3 - weekday) * DAY_MS)
  const year = thursday.getUTCFullYear()
  const dayOfYear = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS)
  return `${year}-W${pad(Math.floor(dayOfYear / 7) + 1)}`
}

/** 그 시각의 서울 날짜가 속한 ISO 주(`YYYY-Www`). `weeksAgo`만큼 앞선 주를 돌려줄 수 있습니다. */
export function isoWeekOf(at: Date, weeksAgo = 0): string {
  const seoulDay = Date.parse(`${isoDate(at.getTime() + SEOUL_OFFSET_MS)}T00:00:00Z`)
  return isoWeekOfDateMs(seoulDay - weeksAgo * 7 * DAY_MS)
}

/** `YYYY-Www`의 서울 날짜 범위(월~일). 형식이 틀리거나 그 해에 없는 주(예: W53이 없는 해)면 null. */
export function isoWeekRange(week: string): { from: string; to: string } | null {
  const match = ISO_WEEK_PATTERN.exec(week)
  if (!match) return null
  const year = Number(match[1])
  const n = Number(match[2])
  if (n < 1 || n > 53) return null
  const jan4 = Date.UTC(year, 0, 4)
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS
  const monday = week1Monday + (n - 1) * 7 * DAY_MS
  if (isoWeekOfDateMs(monday) !== week) return null
  return { from: isoDate(monday), to: isoDate(monday + 6 * DAY_MS) }
}

export type CheckinWeekCheck = 'ok' | 'invalid' | 'out_of_range'

/** 체크인을 쓰거나 고칠 수 있는 주인지: 이번 주와 지난주만. */
export function checkCheckinWeek(week: string, now: Date): CheckinWeekCheck {
  if (!isoWeekRange(week)) return 'invalid'
  return week === isoWeekOf(now) || week === isoWeekOf(now, 1) ? 'ok' : 'out_of_range'
}

/**
 * 체크인 한 줄을 🧱막힘 로그로 옮길 때의 시간 구간. 체크인은 "이번 주 이 과제에 쓴 시간", 막힘은 "막혀 있던 시간"이라
 * 뜻이 같지 않으므로 가장 가까운 구간으로만 옮기고, 작성자가 로그 화면에서 고칠 수 있습니다(ADR 0009).
 */
export const STUCK_TIME_BUCKET_FROM_CHECKIN: Record<CheckinTimeBucket, LogTimeBucket> = {
  none: 'lt30m',
  lt2h: 'lt2h',
  lt5h: 'half_day',
  lt10h: 'day_plus',
  ten_plus: 'day_plus',
}

// ── 익명 집계(§11.2) ────────────────────────────────────────────────────

export interface CheckinStatRow {
  userId: string
  timeBucket: CheckinTimeBucket
  difficulty: number
  shareForStats: boolean
}

export interface CheckinStats {
  /** 통계 공유에 동의한 서로 다른 사람 수. */
  contributors: number
  /** 공유한 체크인의 시간 구간별 개수. */
  timeBuckets: Record<CheckinTimeBucket, number>
  /** 공유한 체크인의 난이도(1~5)별 개수. */
  difficulty: Record<1 | 2 | 3 | 4 | 5, number>
}

/**
 * 같은 과목·과제 유형 묶음의 체크인 분포. 통계 공유에 동의한 체크인만 쓰고, 동의한 사람이 `minGroup`명 미만이면 null.
 * 개인을 구분할 값(userId·메모)은 결과에 넣지 않습니다. 과목 허브 API(T-10 이후)가 이 함수를 씁니다.
 */
export function aggregateCheckinStats(
  rows: readonly CheckinStatRow[],
  minGroup = CHECKIN_STATS_MIN_GROUP,
): CheckinStats | null {
  const shared = rows.filter(
    (row) =>
      row.shareForStats &&
      Number.isInteger(row.difficulty) &&
      row.difficulty >= CHECKIN_DIFFICULTY_MIN &&
      row.difficulty <= CHECKIN_DIFFICULTY_MAX,
  )
  const contributors = new Set(shared.map((row) => row.userId)).size
  if (contributors < Math.max(1, minGroup)) return null
  const timeBuckets = Object.fromEntries(CHECKIN_TIME_BUCKETS.map((b) => [b, 0])) as Record<CheckinTimeBucket, number>
  const difficulty: CheckinStats['difficulty'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  for (const row of shared) {
    timeBuckets[row.timeBucket] += 1
    difficulty[row.difficulty as 1 | 2 | 3 | 4 | 5] += 1
  }
  return { contributors, timeBuckets, difficulty }
}

// ── 디스코드 알림 일정 ───────────────────────────────────────────────────

export type DiscordNoticeKind = 'checkin_reminder' | 'weekly_summary'

export interface DueNotice {
  kind: DiscordNoticeKind
  /** 체크인 알림은 그 주(일요일이 속한 주), 주간 요약은 요약할 지난주. */
  isoWeek: string
}

/**
 * 지금 보낼 알림(서울 시각 기준).
 * - 체크인 알림: 일요일 20:00 ≤ 지금 < 월요일 12:00 → 방금 끝나는(끝난) 주.
 * - 주간 요약: 화요일 10:00 ≤ 지금 < 수요일 10:00 → 지난주.
 */
export function dueNotices(now: Date): DueNotice[] {
  const local = new Date(now.getTime() + SEOUL_OFFSET_MS)
  const weekday = (local.getUTCDay() + 6) % 7 // 월 0 … 일 6
  const hour = local.getUTCHours()
  const due: DueNotice[] = []
  if (weekday === 6 && hour >= 20) due.push({ kind: 'checkin_reminder', isoWeek: isoWeekOf(now) })
  if (weekday === 0 && hour < 12) due.push({ kind: 'checkin_reminder', isoWeek: isoWeekOf(now, 1) })
  if ((weekday === 1 && hour >= 10) || (weekday === 2 && hour < 10)) {
    due.push({ kind: 'weekly_summary', isoWeek: isoWeekOf(now, 1) })
  }
  return due
}
