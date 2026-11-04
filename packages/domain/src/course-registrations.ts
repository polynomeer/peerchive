/**
 * 이번 학기 과목 등록 (E-01, PROOFU_EVOLUTION_PLAN §8.7, DELIVERY_PLAN §4.4 E-01, ADR 0046).
 *
 * - 학생이 학교·과목 검색으로 직접 고릅니다(크롤링·계정 연동 없음). 등록 = (사용자, 개설 학기). 개설 학기가 과목을 정합니다.
 * - 등록할 수 있는 학기는 **지금 학기와 다음 학기**뿐입니다(`registrableTerms`). 학기 구간은 카탈로그의 학기 종료 규칙(`semesterEndsAt`)과
 *   같은 달력 경계를 씁니다: 겨울 계절학기(전년도) 1–2월, 1학기 3–6월, 여름 계절학기 7–8월, 2학기 9–12월(서울 날짜).
 * - 등록 정보는 본인만 봅니다. 과목 허브의 "이번 학기 수강 중 N명"은 n ≥ 5일 때만(`enrollmentCountForHub`, ADR 0027의 5 미만 가림과 같은 기준).
 *
 * 런타임 의존성 없음.
 */
import { ANALYTICS_MIN_GROUP, suppressSmall } from './analytics'
import { SEMESTER_LABELS, type Semester } from './courses'

/** 한 학기에 등록할 수 있는 과목 수(사용자별). */
export const COURSE_REGISTRATION_TERM_LIMIT = 15
/** 과목 허브의 "이번 학기 수강 중" 수를 보여 주는 최소 인원. */
export const ENROLLMENT_MIN_GROUP = ANALYTICS_MIN_GROUP

export interface TermRef {
  year: number
  semester: Semester
}

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000

/** 서울 날짜 기준 지금 학기. 1–2월은 전년도 겨울 계절학기입니다(학기 종료 규칙 `semesterEndsAt`과 같은 경계). */
export function currentTerm(now: Date): TermRef {
  const seoul = new Date(now.getTime() + SEOUL_OFFSET_MS)
  const year = seoul.getUTCFullYear()
  const month = seoul.getUTCMonth() + 1
  if (month <= 2) return { year: year - 1, semester: 'winter' }
  if (month <= 6) return { year, semester: 'spring' }
  if (month <= 8) return { year, semester: 'summer' }
  return { year, semester: 'fall' }
}

/** 학기 순서상 바로 다음 학기(1학기 → 여름 → 2학기 → 겨울 → 다음 해 1학기). */
export function nextTerm(term: TermRef): TermRef {
  switch (term.semester) {
    case 'spring':
      return { year: term.year, semester: 'summer' }
    case 'summer':
      return { year: term.year, semester: 'fall' }
    case 'fall':
      return { year: term.year, semester: 'winter' }
    case 'winter':
      return { year: term.year + 1, semester: 'spring' }
  }
}

/** 등록할 수 있는 학기: 지금 학기와 이후 두 학기(ADR 0060 D-06: 11~12월 겨울 계절학기 다음의 봄학기도 등록할 수 있게). */
export function registrableTerms(now: Date): [TermRef, TermRef, TermRef] {
  const current = currentTerm(now)
  const next = nextTerm(current)
  return [current, next, nextTerm(next)]
}

export function isRegistrableTerm(term: TermRef, now: Date): boolean {
  return registrableTerms(now).some((t) => t.year === term.year && t.semester === term.semester)
}

export const termRefLabel = (term: TermRef) => `${term.year}년 ${SEMESTER_LABELS[term.semester]}`

export type RegistrationPhase = 'upcoming' | 'current' | 'ended'

/**
 * 등록 학기의 단계. 끝남은 개설 학기의 종료 시각(`course_terms.ends_at`, 운영자가 고칠 수 있음)으로 판정하고,
 * 아직 끝나지 않았으면 달력상 지금 학기인지로 current/upcoming을 나눕니다.
 */
export function registrationPhase(term: TermRef & { endsAt: Date }, now: Date): RegistrationPhase {
  if (term.endsAt.getTime() <= now.getTime()) return 'ended'
  const current = currentTerm(now)
  return current.year === term.year && current.semester === term.semester ? 'current' : 'upcoming'
}

/** 허브에 보일 수강 인원. 5명 미만이면 null(아무것도 표시하지 않음). */
export function enrollmentCountForHub(count: number, minGroup = ENROLLMENT_MIN_GROUP): number | null {
  return suppressSmall(count, minGroup)
}
