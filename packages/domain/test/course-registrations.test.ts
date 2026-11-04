import { describe, expect, it } from 'vitest'
import {
  ENROLLMENT_MIN_GROUP,
  currentTerm,
  enrollmentCountForHub,
  isRegistrableTerm,
  nextTerm,
  registrableTerms,
  registrationPhase,
  semesterEndsAt,
  termRefLabel,
} from '../src'

const d = (iso: string) => new Date(iso)

describe('currentTerm / registrableTerms (E-01, Asia/Seoul calendar)', () => {
  it('maps Seoul months to terms: Jan–Feb previous winter, Mar–Jun spring, Jul–Aug summer, Sep–Dec fall', () => {
    expect(currentTerm(d('2026-11-02T09:00:00Z'))).toEqual({ year: 2026, semester: 'fall' })
    expect(currentTerm(d('2027-01-15T00:00:00Z'))).toEqual({ year: 2026, semester: 'winter' })
    expect(currentTerm(d('2027-03-01T00:00:00Z'))).toEqual({ year: 2027, semester: 'spring' })
    expect(currentTerm(d('2027-07-01T00:00:00Z'))).toEqual({ year: 2027, semester: 'summer' })
    // 서울 날짜 기준: UTC로는 12월 31일이어도 서울은 1월 1일.
    expect(currentTerm(d('2026-12-31T15:00:00Z'))).toEqual({ year: 2026, semester: 'winter' })
    expect(currentTerm(d('2026-12-31T14:59:59Z'))).toEqual({ year: 2026, semester: 'fall' })
  })

  it('the current term is the earliest term whose end (semesterEndsAt) is not yet past — same boundary as the catalog', () => {
    for (let t = d('2025-01-01T00:00:00Z').getTime(); t < d('2028-01-01T00:00:00Z').getTime(); t += 6 * 60 * 60 * 1000) {
      const now = new Date(t)
      const term = currentTerm(now)
      expect(semesterEndsAt(term.year, term.semester).getTime()).toBeGreaterThanOrEqual(t)
      const next = nextTerm(term)
      expect(semesterEndsAt(next.year, next.semester).getTime()).toBeGreaterThan(semesterEndsAt(term.year, term.semester).getTime())
    }
  })

  it('the current term and the next two terms are registrable (ADR 0060 D-06)', () => {
    const now = d('2026-11-02T09:00:00Z')
    expect(registrableTerms(now)).toEqual([
      { year: 2026, semester: 'fall' },
      { year: 2026, semester: 'winter' },
      { year: 2027, semester: 'spring' },
    ])
    expect(isRegistrableTerm({ year: 2026, semester: 'fall' }, now)).toBe(true)
    expect(isRegistrableTerm({ year: 2026, semester: 'winter' }, now)).toBe(true)
    expect(isRegistrableTerm({ year: 2027, semester: 'spring' }, now)).toBe(true)
    expect(isRegistrableTerm({ year: 2027, semester: 'summer' }, now)).toBe(false)
    expect(isRegistrableTerm({ year: 2026, semester: 'spring' }, now)).toBe(false)
    expect(registrableTerms(d('2027-02-20T00:00:00Z'))).toEqual([
      { year: 2026, semester: 'winter' },
      { year: 2027, semester: 'spring' },
      { year: 2027, semester: 'summer' },
    ])
    expect(termRefLabel({ year: 2026, semester: 'fall' })).toBe('2026년 2학기')
  })

  it('phase: ended by the term row end (operator-adjustable), otherwise current/upcoming by calendar', () => {
    const now = d('2026-11-02T09:00:00Z')
    expect(registrationPhase({ year: 2026, semester: 'fall', endsAt: semesterEndsAt(2026, 'fall') }, now)).toBe('current')
    expect(registrationPhase({ year: 2026, semester: 'winter', endsAt: semesterEndsAt(2026, 'winter') }, now)).toBe('upcoming')
    expect(registrationPhase({ year: 2026, semester: 'fall', endsAt: d('2026-11-01T00:00:00Z') }, now)).toBe('ended')
  })
})

describe('enrollmentCountForHub (n ≥ 5 only)', () => {
  it('hides counts below 5', () => {
    expect(ENROLLMENT_MIN_GROUP).toBe(5)
    expect(enrollmentCountForHub(0)).toBeNull()
    expect(enrollmentCountForHub(4)).toBeNull()
    expect(enrollmentCountForHub(5)).toBe(5)
    expect(enrollmentCountForHub(12)).toBe(12)
  })
})
