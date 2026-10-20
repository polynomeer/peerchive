import { describe, expect, it } from 'vitest'
import {
  CHECKIN_STATS_MIN_GROUP,
  type CheckinStatRow,
  aggregateCheckinStats,
  checkCheckinWeek,
  dueNotices,
  isoWeekOf,
  isoWeekRange,
} from '../src/index'

describe('ISO weeks in Asia/Seoul', () => {
  it('uses the Seoul date (UTC Sunday 15:00 is already Monday in Seoul)', () => {
    expect(isoWeekOf(new Date('2026-10-18T14:59:59Z'))).toBe('2026-W42') // 일 23:59 KST
    expect(isoWeekOf(new Date('2026-10-18T15:00:00Z'))).toBe('2026-W43') // 월 00:00 KST
    expect(isoWeekOf(new Date('2026-10-20T03:00:00Z'), 1)).toBe('2026-W42')
  })

  it('assigns year boundaries by the Thursday rule', () => {
    expect(isoWeekOf(new Date('2026-12-31T03:00:00Z'))).toBe('2026-W53')
    expect(isoWeekOf(new Date('2027-01-03T03:00:00Z'))).toBe('2026-W53')
    expect(isoWeekOf(new Date('2027-01-04T03:00:00Z'))).toBe('2027-W01')
    expect(isoWeekOf(new Date('2025-12-29T03:00:00Z'))).toBe('2026-W01')
  })

  it('maps a week back to Monday–Sunday and rejects impossible weeks', () => {
    expect(isoWeekRange('2026-W43')).toEqual({ from: '2026-10-19', to: '2026-10-25' })
    expect(isoWeekRange('2026-W01')).toEqual({ from: '2025-12-29', to: '2026-01-04' })
    expect(isoWeekRange('2026-W53')).toEqual({ from: '2026-12-28', to: '2027-01-03' })
    expect(isoWeekRange('2027-W53')).toBeNull()
    expect(isoWeekRange('2026-W00')).toBeNull()
    expect(isoWeekRange('2026-43')).toBeNull()
    expect(isoWeekRange('2026-W1')).toBeNull()
  })

  it('allows check-ins for this week and last week only', () => {
    const now = new Date('2026-10-20T03:00:00Z')
    expect(checkCheckinWeek('2026-W43', now)).toBe('ok')
    expect(checkCheckinWeek('2026-W42', now)).toBe('ok')
    expect(checkCheckinWeek('2026-W41', now)).toBe('out_of_range')
    expect(checkCheckinWeek('2026-W44', now)).toBe('out_of_range')
    expect(checkCheckinWeek('nope', now)).toBe('invalid')
  })
})

describe('aggregateCheckinStats (n ≥ 5 threshold)', () => {
  const row = (userId: string, overrides: Partial<CheckinStatRow> = {}): CheckinStatRow => ({
    userId,
    timeBucket: 'lt5h',
    difficulty: 3,
    shareForStats: true,
    ...overrides,
  })

  it('returns null below the threshold of distinct sharing contributors', () => {
    expect(CHECKIN_STATS_MIN_GROUP).toBe(5)
    expect(aggregateCheckinStats([])).toBeNull()
    const four = ['a', 'b', 'c', 'd'].map((id) => row(id))
    expect(aggregateCheckinStats(four)).toBeNull()
    // 같은 사람이 여러 주 공유해도 한 명입니다.
    expect(aggregateCheckinStats([...four, row('a'), row('b')])).toBeNull()
    // 공유하지 않은 체크인은 세지 않습니다.
    expect(aggregateCheckinStats([...four, row('e', { shareForStats: false })])).toBeNull()
  })

  it('aggregates only shared check-ins once the threshold is met, without identities', () => {
    const rows = [
      row('a', { timeBucket: 'none', difficulty: 1 }),
      row('b'),
      row('c'),
      row('d', { timeBucket: 'ten_plus', difficulty: 5 }),
      row('e', { difficulty: 4 }),
      row('f', { shareForStats: false, timeBucket: 'lt2h', difficulty: 2 }),
    ]
    const stats = aggregateCheckinStats(rows)
    expect(stats).toEqual({
      contributors: 5,
      timeBuckets: { none: 1, lt2h: 0, lt5h: 3, lt10h: 0, ten_plus: 1 },
      difficulty: { 1: 1, 2: 0, 3: 2, 4: 1, 5: 1 },
    })
    expect(JSON.stringify(stats)).not.toContain('"a"')
    expect(aggregateCheckinStats(rows, 6)).toBeNull()
  })
})

describe('dueNotices (Asia/Seoul schedule)', () => {
  const kst = (iso: string) => new Date(`${iso}+09:00`)

  it('sends the check-in reminder from Sunday 20:00 until the Monday 12:00 deadline', () => {
    expect(dueNotices(kst('2026-10-25T19:59:59'))).toEqual([])
    expect(dueNotices(kst('2026-10-25T20:00:00'))).toEqual([{ kind: 'checkin_reminder', isoWeek: '2026-W43' }])
    expect(dueNotices(kst('2026-10-26T11:59:00'))).toEqual([{ kind: 'checkin_reminder', isoWeek: '2026-W43' }])
    expect(dueNotices(kst('2026-10-26T12:00:00'))).toEqual([])
  })

  it('sends the weekly summary for last week from Tuesday 10:00 for 24 hours', () => {
    expect(dueNotices(kst('2026-10-27T09:59:00'))).toEqual([])
    expect(dueNotices(kst('2026-10-27T10:00:00'))).toEqual([{ kind: 'weekly_summary', isoWeek: '2026-W43' }])
    expect(dueNotices(kst('2026-10-28T09:59:00'))).toEqual([{ kind: 'weekly_summary', isoWeek: '2026-W43' }])
    expect(dueNotices(kst('2026-10-28T10:00:00'))).toEqual([])
  })
})
