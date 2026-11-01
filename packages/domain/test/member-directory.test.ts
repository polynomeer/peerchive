import { describe, expect, it } from 'vitest'
import {
  DIRECTORY_CONTACT_METHOD_MAX,
  DIRECTORY_CURRENT_WORK_MAX,
  DIRECTORY_INTEREST_MAX,
  DIRECTORY_INTERESTS_MAX,
  DIRECTORY_MAX_PAGE,
  DIRECTORY_PAGE_SIZE,
  checkDirectoryEntryInput,
  directoryAvailable,
  filledDirectoryFields,
  parseDirectoryQuery,
} from '../src/member-directory'

describe('A-03 member directory consent', () => {
  it('exists only in non-anonymous alumni rooms', () => {
    expect(directoryAvailable('alumni', 'real')).toBe(true)
    expect(directoryAvailable('alumni', 'display')).toBe(true)
    expect(directoryAvailable('alumni', 'anonymous')).toBe(false)
    expect(directoryAvailable('general', 'real')).toBe(false)
  })

  it('requires explicit consent: true on every save', () => {
    for (const consent of [undefined, false, 'true', 1, null]) {
      const r = checkDirectoryEntryInput({ consent, currentWork: '백엔드 개발' })
      expect(r).toEqual({ ok: false, fields: { consent: 'required' } })
    }
    expect(checkDirectoryEntryInput({ consent: true }).ok).toBe(true)
  })

  it('every field is optional and can be emptied (blank → null, no interests → [])', () => {
    const r = checkDirectoryEntryInput({ consent: true, cohortLabel: '  ', currentWork: '', interests: ['', '  '], contactMethod: null })
    expect(r).toEqual({ ok: true, value: { cohortLabel: null, currentWork: null, interests: [], contactMethod: null } })
    expect(filledDirectoryFields((r as { ok: true; value: Parameters<typeof filledDirectoryFields>[0] }).value)).toBe(0)
    const full = checkDirectoryEntryInput({ consent: true, cohortLabel: ' 12기 ', currentWork: '스타트업  PM', interests: ['AI', 'ai', '등산'], contactMethod: '오픈채팅 링크는 방 공지 참고' })
    expect(full).toEqual({ ok: true, value: { cohortLabel: '12기', currentWork: '스타트업 PM', interests: ['AI', '등산'], contactMethod: '오픈채팅 링크는 방 공지 참고' } })
    expect(filledDirectoryFields((full as { ok: true; value: Parameters<typeof filledDirectoryFields>[0] }).value)).toBe(4)
  })

  it('caps lengths and interest count; rejects control characters and line breaks', () => {
    const fields = (raw: Record<string, unknown>) => (checkDirectoryEntryInput({ consent: true, ...raw }) as { ok: false; fields: Record<string, string> }).fields
    expect(fields({ currentWork: 'x'.repeat(DIRECTORY_CURRENT_WORK_MAX + 1) })).toEqual({ currentWork: 'too_long' })
    expect(checkDirectoryEntryInput({ consent: true, currentWork: 'x'.repeat(DIRECTORY_CURRENT_WORK_MAX) }).ok).toBe(true)
    expect(fields({ contactMethod: 'x'.repeat(DIRECTORY_CONTACT_METHOD_MAX + 1) })).toEqual({ contactMethod: 'too_long' })
    expect(fields({ contactMethod: 'a\nb' })).toEqual({ contactMethod: 'invalid' })
    expect(fields({ cohortLabel: 'a\u0007' })).toEqual({ cohortLabel: 'invalid' })
    expect(fields({ interests: 'AI' })).toEqual({ interests: 'invalid' })
    expect(fields({ interests: [1] })).toEqual({ interests: 'invalid' })
    expect(fields({ interests: ['x'.repeat(DIRECTORY_INTEREST_MAX + 1)] })).toEqual({ interests: 'too_long' })
    expect(fields({ interests: Array.from({ length: DIRECTORY_INTERESTS_MAX + 1 }, (_, i) => `관심${i}`) })).toEqual({ interests: 'too_many' })
    expect(checkDirectoryEntryInput({ consent: true, interests: Array.from({ length: DIRECTORY_INTERESTS_MAX }, (_, i) => `관심${i}`) }).ok).toBe(true)
  })

  it('query accepts only page and pageSize (≤ 20); no fetch-all or other formats', () => {
    expect(parseDirectoryQuery({})).toEqual({ ok: true, page: 1, pageSize: DIRECTORY_PAGE_SIZE })
    expect(parseDirectoryQuery(undefined)).toEqual({ ok: true, page: 1, pageSize: DIRECTORY_PAGE_SIZE })
    expect(parseDirectoryQuery({ page: '3', pageSize: '5' })).toEqual({ ok: true, page: 3, pageSize: 5 })
    expect(parseDirectoryQuery({ pageSize: String(DIRECTORY_PAGE_SIZE + 1) })).toEqual({ ok: false, fields: { pageSize: 'too_large' } })
    expect(parseDirectoryQuery({ pageSize: '1000' })).toEqual({ ok: false, fields: { pageSize: 'too_large' } })
    expect(parseDirectoryQuery({ page: String(DIRECTORY_MAX_PAGE + 1) })).toEqual({ ok: false, fields: { page: 'too_large' } })
    for (const bad of ['0', '-1', '1.5', 'abc', '', ['1', '2']]) expect(parseDirectoryQuery({ page: bad }).ok).toBe(false)
    expect(parseDirectoryQuery({ pageSize: '0' })).toEqual({ ok: false, fields: { pageSize: 'invalid' } })
    expect(parseDirectoryQuery({ all: '1' })).toEqual({ ok: false, fields: { all: 'unknown' } })
    expect(parseDirectoryQuery({ limit: '500', format: 'csv' })).toEqual({ ok: false, fields: { limit: 'unknown', format: 'unknown' } })
  })
})
