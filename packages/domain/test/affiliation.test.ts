import { describe, expect, it } from 'vitest'
import {
  AFFILIATION_CODE_MAX_ATTEMPTS,
  AFFILIATION_CODE_TTL_MS,
  AFFILIATION_RATE_LIMITS,
  affiliationBadgeLabel,
  canChangeStanding,
  checkSchoolDomain,
  decideCodeAttempt,
  findMatchingSchoolDomain,
  normalizeAffiliationCode,
  normalizeDepartmentLabel,
  normalizeMailDomain,
  parseSchoolEmail,
  schoolDomainMatches,
} from '../src/index'

describe('school mail domains', () => {
  it('normalizes to lowercase ASCII (IDN → punycode) and rejects malformed hosts, IPs and single labels', () => {
    expect(normalizeMailDomain(' Stu.YU.ac.KR. ')).toBe('stu.yu.ac.kr')
    expect(normalizeMailDomain('영남대.한국')).toBe('xn--q20bm8b7y2a.xn--3e0b707e')
    expect(normalizeMailDomain('ｙｕ.ac.kr')).toBe('yu.ac.kr') // 전각 → 같은 도메인(메일도 같은 곳으로 감)
    for (const bad of ['', 'localhost', 'kr', '1.2.3.4', 'a..kr', '-yu.ac.kr', 'yu-.ac.kr', 'yu.ac.kr/x', 'yu.ac.kr:25', 'a@b.kr', '*.ac.kr', 'yu ac.kr', '[::1]']) {
      expect(normalizeMailDomain(bad), bad).toBeNull()
    }
  })

  it('refuses TLD-only, shared suffixes (ac.kr …) and webmail as school domains', () => {
    expect(checkSchoolDomain('YU.ac.kr')).toEqual({ ok: true, domain: 'yu.ac.kr' })
    expect(checkSchoolDomain('kr')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkSchoolDomain('ac.kr')).toEqual({ ok: false, reason: 'shared_suffix' })
    expect(checkSchoolDomain('edu.au')).toEqual({ ok: false, reason: 'shared_suffix' })
    expect(checkSchoolDomain('Gmail.com')).toEqual({ ok: false, reason: 'webmail' })
    expect(checkSchoolDomain('naver.com')).toEqual({ ok: false, reason: 'webmail' })
  })

  it('matches the registered domain or its subdomains only (no lookalikes)', () => {
    expect(schoolDomainMatches('yu.ac.kr', 'yu.ac.kr')).toBe(true)
    expect(schoolDomainMatches('stu.yu.ac.kr', 'yu.ac.kr')).toBe(true)
    expect(schoolDomainMatches('a.b.yu.ac.kr', 'yu.ac.kr')).toBe(true)
    expect(schoolDomainMatches('evilyu.ac.kr', 'yu.ac.kr')).toBe(false)
    expect(schoolDomainMatches('yu.ac.kr.evil.com', 'yu.ac.kr')).toBe(false)
    expect(schoolDomainMatches('ac.kr', 'yu.ac.kr')).toBe(false)
    // 키릴 문자 'у'(U+0443)를 쓴 비슷한 도메인은 punycode가 달라 일치하지 않음
    const lookalike = normalizeMailDomain('уu.ac.kr')!
    expect(lookalike.startsWith('xn--')).toBe(true)
    expect(schoolDomainMatches(lookalike, 'yu.ac.kr')).toBe(false)
  })

  it('picks the most specific registered domain', () => {
    const rows = [{ domain: 'yu.ac.kr', id: 1 }, { domain: 'stu.yu.ac.kr', id: 2 }]
    expect(findMatchingSchoolDomain('a.stu.yu.ac.kr', rows)?.id).toBe(2)
    expect(findMatchingSchoolDomain('yu.ac.kr', rows)?.id).toBe(1)
    expect(findMatchingSchoolDomain('knu.ac.kr', rows)).toBeNull()
  })
})

describe('school email addresses', () => {
  it('lowercases, normalizes the domain and strips +tags for the duplicate key only', () => {
    expect(parseSchoolEmail(' Kim.Min+Peer@STU.yu.ac.kr ')).toEqual({
      address: 'kim.min+peer@stu.yu.ac.kr',
      canonical: 'kim.min@stu.yu.ac.kr',
      domain: 'stu.yu.ac.kr',
    })
    for (const bad of ['', 'no-at', '@yu.ac.kr', 'a@@yu.ac.kr', 'a@b@yu.ac.kr', '.a@yu.ac.kr', 'a.@yu.ac.kr', 'a..b@yu.ac.kr', '김@yu.ac.kr', 'a b@yu.ac.kr', '+tag@yu.ac.kr', 'a@localhost', `${'a'.repeat(65)}@yu.ac.kr`]) {
      expect(parseSchoolEmail(bad), bad).toBeNull()
    }
  })
})

describe('department label and standing', () => {
  it('normalizes the self-reported department (optional, ≤40, no control characters)', () => {
    expect(normalizeDepartmentLabel('  컴퓨터공학과  ')).toEqual({ ok: true, value: '컴퓨터공학과' })
    expect(normalizeDepartmentLabel('컴퓨터\n공학과')).toEqual({ ok: true, value: '컴퓨터 공학과' })
    expect(normalizeDepartmentLabel('   ')).toEqual({ ok: true, value: null })
    expect(normalizeDepartmentLabel(null)).toEqual({ ok: true, value: null })
    expect(normalizeDepartmentLabel('가'.repeat(41))).toEqual({ ok: false, reason: 'too_long' })
    expect(normalizeDepartmentLabel('가'.repeat(40))).toMatchObject({ ok: true })
    expect(normalizeDepartmentLabel('a\u0000b')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeDepartmentLabel(3)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('lets a student become alumni but not the reverse', () => {
    expect(canChangeStanding('student', 'alumni')).toBe(true)
    expect(canChangeStanding('alumni', 'alumni')).toBe(true)
    expect(canChangeStanding('alumni', 'student')).toBe(false)
  })

  it('formats the public badge without department or domain', () => {
    expect(affiliationBadgeLabel('한빛대학교', 'student')).toBe('한빛대학교 인증')
    expect(affiliationBadgeLabel('한빛대학교', 'alumni')).toBe('한빛대학교 인증 · 졸업생')
  })
})

describe('verification codes', () => {
  const now = new Date('2026-11-01T00:00:00Z')
  const fresh = { expiresAt: new Date(now.getTime() + AFFILIATION_CODE_TTL_MS), attempts: 0, usedAt: null }

  it('accepts only six digits', () => {
    expect(normalizeAffiliationCode(' 012345 ')).toBe('012345')
    for (const bad of ['12345', '1234567', 'abcdef', '12 345', 123456, null]) expect(normalizeAffiliationCode(bad)).toBeNull()
  })

  it('counts wrong attempts, locks after five, and never checks expired/used/locked codes', () => {
    expect(AFFILIATION_CODE_TTL_MS).toBe(10 * 60 * 1000)
    expect(AFFILIATION_CODE_MAX_ATTEMPTS).toBe(5)
    expect(decideCodeAttempt(fresh, true, now)).toEqual({ kind: 'verified' })
    expect(decideCodeAttempt(fresh, false, now)).toEqual({ kind: 'mismatch', attempts: 1, attemptsLeft: 4 })
    expect(decideCodeAttempt({ ...fresh, attempts: 3 }, false, now)).toEqual({ kind: 'mismatch', attempts: 4, attemptsLeft: 1 })
    expect(decideCodeAttempt({ ...fresh, attempts: 4 }, false, now)).toEqual({ kind: 'locked', attempts: 5 })
    expect(decideCodeAttempt({ ...fresh, attempts: 5 }, true, now)).toEqual({ kind: 'locked', attempts: 5 })
    expect(decideCodeAttempt({ ...fresh, expiresAt: now }, true, now)).toEqual({ kind: 'expired' })
    expect(decideCodeAttempt({ ...fresh, usedAt: now }, true, now)).toEqual({ kind: 'used' })
  })

  it('rate limits requests per user, per address and per IP within an hour', () => {
    expect(AFFILIATION_RATE_LIMITS.perUser).toEqual({ limit: 5, windowMs: 60 * 60 * 1000 })
    expect(AFFILIATION_RATE_LIMITS.perAddress).toEqual({ limit: 3, windowMs: 60 * 60 * 1000 })
    expect(AFFILIATION_RATE_LIMITS.perIp.windowMs).toBe(60 * 60 * 1000)
    expect(AFFILIATION_RATE_LIMITS.perIp.limit).toBeGreaterThan(AFFILIATION_RATE_LIMITS.perUser.limit)
  })
})
