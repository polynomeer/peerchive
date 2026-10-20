/**
 * 주간 체크인 화면 도우미(T-09, pilot-kit §3). 상태는 색이 아니라 글자로 보여 줍니다.
 */
import { isoWeekOf } from '@peerchive/domain'
import type { CheckinSkipReason, CheckinTimeBucket } from '~~/shared/types/api'

export const CHECKIN_TIME_OPTIONS: Array<{ value: CheckinTimeBucket; label: string }> = [
  { value: 'none', label: '0' },
  { value: 'lt2h', label: '~2시간' },
  { value: 'lt5h', label: '~5시간' },
  { value: 'lt10h', label: '~10시간' },
  { value: 'ten_plus', label: '10시간 이상' },
]

export const CHECKIN_TIME_LABELS = Object.fromEntries(CHECKIN_TIME_OPTIONS.map((o) => [o.value, o.label])) as Record<
  CheckinTimeBucket,
  string
>

export const DIFFICULTY_OPTIONS = [
  { value: 1, label: '1 쉬움' },
  { value: 2, label: '2' },
  { value: 3, label: '3 보통' },
  { value: 4, label: '4' },
  { value: 5, label: '5 매우 어려움' },
]

export const SKIP_REASON_OPTIONS: Array<{ value: CheckinSkipReason; label: string }> = [
  { value: 'busy', label: '바빠서' },
  { value: 'bothersome', label: '귀찮아서' },
  { value: 'nothing_to_log', label: '기록할 게 없어서' },
  { value: 'unsure_where', label: '어디에 써야 할지 몰라서' },
  { value: 'other', label: '기타' },
]

export const CHECKIN_NOTE_LIMIT = 200

/** 이번 주·지난주 ISO 주(서울). */
export function checkinWeeks(now = new Date()): { current: string; previous: string } {
  return { current: isoWeekOf(now), previous: isoWeekOf(now, 1) }
}
