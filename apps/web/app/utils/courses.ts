/**
 * 학교·과목·학기·엠바고 화면 도우미(T-10). 이름은 모두 학생이 입력한 값이라 화면에 "학생 작성"을 붙입니다.
 * 엠바고 상태는 색이 아니라 글자로 보여 줍니다.
 */
import { SEMESTER_LABELS, seoulDate } from '@peerchive/domain'
import type { CourseTermDto, EmbargoDto, Semester } from '~~/shared/types/api'

export const SEMESTER_OPTIONS: Array<{ value: Semester; label: string }> = (
  ['spring', 'summer', 'fall', 'winter'] as const
).map((value) => ({ value, label: SEMESTER_LABELS[value] }))

/** "2026년 2학기" */
export function termLabel(term: Pick<CourseTermDto, 'year' | 'semester'>): string {
  return `${term.year}년 ${SEMESTER_LABELS[term.semester]}`
}

/** 서울 날짜(YYYY-MM-DD). */
export function seoulDay(iso: string): string {
  return seoulDate(new Date(iso))
}

/** 헤더 배지 문구. 엠바고 중이 아니면 null. */
export function embargoBadge(embargo: EmbargoDto | null | undefined): string | null {
  if (!embargo?.active || !embargo.until) return null
  const day = seoulDay(embargo.until)
  return embargo.source === 'course_term_end'
    ? `🔒 학기 종료(${day})까지 공개 불가 · 엠바고`
    : `🔒 ${day}까지 공개 불가 · 엠바고`
}

/** 409 응답의 비슷한 항목 안내. */
export const CATALOG_CONFLICT_MESSAGES: Record<string, string> = {
  already_exists: '같은 이름이 이미 있습니다. 아래에서 고르세요.',
  similar_exists: '비슷한 이름이 이미 있습니다. 같은 곳이면 아래에서 고르고, 다른 곳이면 “그래도 새로 만들기”를 누르세요.',
  rate_limited: '짧은 시간에 너무 많이 만들었습니다. 잠시 뒤 다시 시도하세요.',
}
