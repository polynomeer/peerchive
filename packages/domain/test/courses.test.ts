import { describe, expect, it } from 'vitest'
import {
  COURSE_TAG_LIMIT,
  checkMerge,
  codeKey,
  computeEffectiveEmbargo,
  isAllowedTermYear,
  isEmbargoActive,
  labelKey,
  lowerEmbargo,
  normalizeLabel,
  normalizeTagSlug,
  raiseEmbargo,
  semesterEndsAt,
  seoulDate,
} from '../src'

const d = (iso: string) => new Date(iso)

describe('semesterEndsAt (Asia/Seoul end of day)', () => {
  it('spring → Jun 30, summer → Aug 31, fall → Dec 31 (23:59:59.999 KST)', () => {
    expect(semesterEndsAt(2026, 'spring').toISOString()).toBe('2026-06-30T14:59:59.999Z')
    expect(semesterEndsAt(2026, 'summer').toISOString()).toBe('2026-08-31T14:59:59.999Z')
    expect(semesterEndsAt(2026, 'fall').toISOString()).toBe('2026-12-31T14:59:59.999Z')
    expect(seoulDate(semesterEndsAt(2026, 'fall'))).toBe('2026-12-31')
  })

  it('winter → last day of February of the next year, leap years included', () => {
    expect(semesterEndsAt(2026, 'winter').toISOString()).toBe('2027-02-28T14:59:59.999Z')
    expect(semesterEndsAt(2027, 'winter').toISOString()).toBe('2028-02-29T14:59:59.999Z')
    expect(semesterEndsAt(2099, 'winter').toISOString()).toBe('2100-02-28T14:59:59.999Z') // 2100은 윤년 아님
    expect(seoulDate(semesterEndsAt(2023, 'winter'))).toBe('2024-02-29')
  })

  it('is active through the whole last Seoul day and not one millisecond after', () => {
    const until = semesterEndsAt(2026, 'fall')
    expect(isEmbargoActive({ now: d('2026-12-31T14:59:59.998Z'), embargoUntil: until })).toBe(true)
    expect(isEmbargoActive({ now: d('2026-12-31T15:00:00.000Z'), embargoUntil: until })).toBe(false)
  })

  it('allows years from 30 years ago up to next year (Seoul year)', () => {
    const now = d('2026-12-31T16:00:00Z') // 서울은 이미 2027-01-01
    expect(isAllowedTermYear(2028, now)).toBe(true)
    expect(isAllowedTermYear(2029, now)).toBe(false)
    expect(isAllowedTermYear(1997, now)).toBe(true)
    expect(isAllowedTermYear(1996, now)).toBe(false)
    expect(isAllowedTermYear(2026.5, now)).toBe(false)
  })
})

describe('label normalization', () => {
  it('collapses whitespace for display and ignores spacing/case/punctuation for keys', () => {
    expect(normalizeLabel('  운영   체제 ')).toBe('운영 체제')
    expect(labelKey('운영 체제')).toBe(labelKey('운영체제'))
    expect(labelKey('Operating Systems')).toBe(labelKey('operating-systems'))
    expect(labelKey('C++ 프로그래밍')).not.toBe(labelKey('C 프로그래밍'))
    expect(codeKey(' cse-3021 ')).toBe('CSE3021')
    expect(codeKey('  ')).toBeNull()
    expect(codeKey(null)).toBeNull()
  })

  it('normalizes tag slugs: lowercase, Korean allowed, spaces → hyphen, ≤ 40', () => {
    expect(normalizeTagSlug('  Process  Scheduling ')).toEqual({ ok: true, slug: 'process-scheduling' })
    expect(normalizeTagSlug('교착 상태 (Deadlock)')).toEqual({ ok: true, slug: '교착-상태-deadlock' })
    expect(normalizeTagSlug('--a__b--')).toEqual({ ok: true, slug: 'ab' })
    expect(normalizeTagSlug(' !!! ')).toEqual({ ok: false, error: 'required' })
    expect(normalizeTagSlug('가'.repeat(40))).toEqual({ ok: true, slug: '가'.repeat(40) })
    expect(normalizeTagSlug('가'.repeat(41))).toEqual({ ok: false, error: 'too_long' })
    expect(COURSE_TAG_LIMIT).toBe(12)
  })
})

describe('monotonic project embargo', () => {
  const fall2026 = semesterEndsAt(2026, 'fall')
  const spring2024 = semesterEndsAt(2024, 'spring')

  it('raises to the later date and never lowers when switching to an older term or removing it', () => {
    expect(raiseEmbargo(null, fall2026)).toEqual(fall2026)
    expect(raiseEmbargo(fall2026, spring2024)).toEqual(fall2026) // 옛 학기로 바꿔도 그대로
    expect(raiseEmbargo(fall2026)).toEqual(fall2026) // 학기를 떼도 그대로
    expect(raiseEmbargo(spring2024, fall2026, null)).toEqual(fall2026)
    expect(raiseEmbargo(null)).toBeNull()
  })

  it('operators can only lower (or clear), not raise', () => {
    expect(lowerEmbargo(fall2026, spring2024)).toEqual({ ok: true, until: spring2024 })
    expect(lowerEmbargo(fall2026, null)).toEqual({ ok: true, until: null })
    expect(lowerEmbargo(spring2024, fall2026)).toEqual({ ok: false, error: 'not_lower' })
    expect(lowerEmbargo(null, fall2026)).toEqual({ ok: false, error: 'not_lower' })
  })
})

describe('computeEffectiveEmbargo', () => {
  const now = d('2026-10-20T00:00:00Z')

  it('is inactive with no sources (and for retro projects linked to a past term)', () => {
    expect(computeEffectiveEmbargo({ projectEmbargoUntil: null }, now)).toEqual({ until: null, active: false, source: null })
    const past = semesterEndsAt(2024, 'spring')
    expect(computeEffectiveEmbargo({ projectEmbargoUntil: past }, now)).toEqual({
      until: past,
      active: false,
      source: 'course_term_end',
    })
  })

  it('takes the max of the project value, term embargoes and project embargoes', () => {
    const term = semesterEndsAt(2026, 'fall')
    expect(computeEffectiveEmbargo({ projectEmbargoUntil: term }, now)).toMatchObject({
      until: term,
      active: true,
      source: 'course_term_end',
    })
    const termEmbargo = d('2027-03-01T00:00:00Z')
    const projectEmbargo = d('2027-06-01T00:00:00Z')
    expect(
      computeEffectiveEmbargo(
        { projectEmbargoUntil: term, courseTermEmbargoes: [termEmbargo], projectEmbargoes: [d('2026-01-01T00:00:00Z')] },
        now,
      ),
    ).toEqual({ until: termEmbargo, active: true, source: 'course_term_embargo' })
    expect(
      computeEffectiveEmbargo({ projectEmbargoUntil: null, courseTermEmbargoes: [termEmbargo], projectEmbargoes: [projectEmbargo] }, now),
    ).toEqual({ until: projectEmbargo, active: true, source: 'project_embargo' })
  })

  it('becomes inactive after the date but does not imply publishing (no auto-publish)', () => {
    const term = semesterEndsAt(2026, 'fall')
    const after = computeEffectiveEmbargo({ projectEmbargoUntil: term }, d('2027-01-01T00:00:00Z'))
    expect(after).toEqual({ until: term, active: false, source: 'course_term_end' })
  })
})

describe('checkMerge', () => {
  it('rejects self, already-merged source or target, and cross-school course merges', () => {
    expect(checkMerge({ id: 'a', mergedInto: null }, { id: 'b', mergedInto: null })).toEqual({ ok: true })
    expect(checkMerge({ id: 'a', mergedInto: null }, { id: 'a', mergedInto: null })).toEqual({ ok: false, error: 'self' })
    expect(checkMerge({ id: 'a', mergedInto: 'c' }, { id: 'b', mergedInto: null })).toEqual({ ok: false, error: 'source_merged' })
    // b → a로 이미 병합됐다면 a를 b로 병합하는 것은 순환이므로 거부합니다.
    expect(checkMerge({ id: 'a', mergedInto: null }, { id: 'b', mergedInto: 'a' })).toEqual({ ok: false, error: 'target_merged' })
    expect(
      checkMerge({ id: 'a', mergedInto: null, schoolId: 's1' }, { id: 'b', mergedInto: null, schoolId: 's2' }),
    ).toEqual({ ok: false, error: 'different_school' })
    expect(
      checkMerge({ id: 'a', mergedInto: null, schoolId: 's1' }, { id: 'b', mergedInto: null, schoolId: 's1' }),
    ).toEqual({ ok: true })
  })
})
