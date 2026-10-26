/**
 * C-01 학교 메일 인증의 DB 없는 단위 테스트: 해시·코드 생성·메일 문구·설정(pepper, 과목 허브 작성 정책 플래그).
 */
import { describe, expect, it } from 'vitest'
import {
  affiliationCodeMail,
  generateAffiliationCode,
  hashAffiliationCode,
  hashSchoolEmail,
} from '../server/modules/affiliation/affiliations'
import { resolveAffiliationConfig } from '../server/modules/affiliation/config'
import { constantTimeEqualHex } from '../server/modules/security/tokens'

const PEPPER = 'unit-test-affiliation-pepper-0123456789abcdef'
const STRONG = 'a3f1c9e27b5d4f8a9c0e1b2d3f4a5b6c7d8e9f0a1b2c3d4e'

describe('affiliation hashing', () => {
  it('hashes the canonical address with the pepper (hex 64, case-insensitive, pepper-dependent)', () => {
    const h = hashSchoolEmail(PEPPER, 'kim@stu.yu.ac.kr')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSchoolEmail(PEPPER, 'KIM@stu.yu.ac.kr')).toBe(h)
    expect(hashSchoolEmail(`${PEPPER}x`, 'kim@stu.yu.ac.kr')).not.toBe(h)
    expect(hashSchoolEmail(PEPPER, 'kim2@stu.yu.ac.kr')).not.toBe(h)
  })

  it('binds code hashes to the affiliation id and compares in constant time', () => {
    const id = '7d0c7a5e-2a51-4a4e-9a55-2b1c3d4e5f60'
    const h = hashAffiliationCode(PEPPER, id, '012345')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(hashAffiliationCode(PEPPER, id.toUpperCase(), '012345')).toBe(h)
    expect(hashAffiliationCode(PEPPER, '00000000-0000-4000-8000-000000000000', '012345')).not.toBe(h)
    expect(constantTimeEqualHex(h, hashAffiliationCode(PEPPER, id, '012345'))).toBe(true)
    expect(constantTimeEqualHex(h, hashAffiliationCode(PEPPER, id, '012346'))).toBe(false)
    expect(constantTimeEqualHex(h, '')).toBe(false)
  })

  it('generates six-digit codes (leading zeros kept)', () => {
    const codes = Array.from({ length: 300 }, generateAffiliationCode)
    for (const c of codes) expect(c).toMatch(/^\d{6}$/)
    expect(new Set(codes).size).toBeGreaterThan(250)
  })

  it('writes a Korean code mail with validity and an ignore notice, without address or school', () => {
    const mail = affiliationCodeMail('048213')
    expect(mail.subject).toBe('Peerchive 학교 메일 인증 코드')
    expect(mail.text).toContain('인증 코드: 048213')
    expect(mail.text).toContain('10분')
    expect(mail.text).toContain('요청하지 않았다면 이 메일을 무시하세요')
    expect(mail.html).toContain('048213')
    expect(mail.text).not.toContain('@')
  })
})

describe('affiliation config', () => {
  it('uses a dev pepper and allows the policy flag 0 outside production', () => {
    const dev = resolveAffiliationConfig({ NODE_ENV: 'development', PEERCHIVE_HUB_REQUIRE_AFFILIATION: '0' })
    expect(dev.pepper).toMatch(/^dev-only/)
    expect(dev.policy).toEqual({ requireAffiliation: false })
    expect(dev.problems).toEqual([])
    expect(resolveAffiliationConfig({ NODE_ENV: 'test' }).policy).toEqual({ requireAffiliation: true })
    expect(resolveAffiliationConfig({ NODE_ENV: 'test', PEERCHIVE_HUB_REQUIRE_AFFILIATION: 'yes' }).policy).toEqual({ requireAffiliation: true })
  })

  it('refuses to start in production without a strong pepper or with the policy turned off', () => {
    expect(resolveAffiliationConfig({}).problems).toHaveLength(1)
    expect(resolveAffiliationConfig({ PEERCHIVE_AFFILIATION_PEPPER: 'change-me-change-me-change-me-change-me' }).problems).toHaveLength(1)
    const ok = resolveAffiliationConfig({ NODE_ENV: 'production', PEERCHIVE_AFFILIATION_PEPPER: STRONG })
    expect(ok).toEqual({ pepper: STRONG, policy: { requireAffiliation: true }, problems: [] })
    const off = resolveAffiliationConfig({ PEERCHIVE_AFFILIATION_PEPPER: STRONG, PEERCHIVE_HUB_REQUIRE_AFFILIATION: '0' })
    expect(off.problems.join()).toContain('PEERCHIVE_HUB_REQUIRE_AFFILIATION=0')
    expect(off.policy.requireAffiliation).toBe(true)
    expect(resolveAffiliationConfig({ PEERCHIVE_AFFILIATION_PEPPER: STRONG, PEERCHIVE_HUB_REQUIRE_AFFILIATION: 'no' }).problems).toHaveLength(1)
  })
})
