import { describe, expect, it } from 'vitest'
import {
  CERTIFICATE_MAX_BYTES,
  CERTIFICATE_PENDING_TTL_MS,
  FEATURES_OFF,
  canDecideCertificate,
  certificateFileDue,
  checkCertificateUpload,
  checkInviteIssue,
  decideCohortApproval,
  decideInviteRedemption,
  formatInviteCode,
  generateInviteCode,
  institutionNameKey,
  inviteCodeHashMessage,
  isEligibleCohortApprover,
  labelKey,
  normalizeCohortLabel,
  normalizeInstitutionName,
  normalizeInviteCode,
  parseFeatureFlags,
  parseFlagValue,
  standingLabelFor,
} from '../src'

const NOW = new Date('2026-11-01T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

describe('P2 feature flags', () => {
  it('are off by default and for unknown values', () => {
    expect(parseFeatureFlags({})).toEqual(FEATURES_OFF)
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'maybe' })).toEqual(FEATURES_OFF)
    expect(parseFlagValue(undefined)).toBeNull()
    expect(parseFlagValue('  ')).toBeNull()
    for (const v of ['on', 'ON', '1', 'true', 'yes']) expect(parseFlagValue(v)).toBe(true)
    for (const v of ['off', '0', 'false', 'no', 'enabled']) expect(parseFlagValue(v)).toBe(false)
  })
  it('turn on per area, or all via PEERCHIVE_FEATURE_P2 with per-area off', () => {
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'on' })).toEqual({ alumni: false, topics: false, institutions: true })
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_P2: 'on' })).toEqual({ alumni: true, topics: true, institutions: true })
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_P2: 'on', PEERCHIVE_FEATURE_P2_ALUMNI: 'off' })).toEqual({ alumni: false, topics: true, institutions: true })
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_P2: 'off', PEERCHIVE_FEATURE_P2_TOPICS: '1' })).toEqual({ alumni: false, topics: true, institutions: false })
  })
})

describe('institution names, cohorts and labels', () => {
  it('uses the same name key as courses.labelKey', () => {
    for (const name of ['피어 캠프', 'Code-Squad 12', 'ＡＢＣ 스쿨', 'C++ 부트캠프 #1']) expect(institutionNameKey(name)).toBe(labelKey(name))
  })
  it('normalizes institution names and cohort labels', () => {
    expect(normalizeInstitutionName('  피어   캠프 ')).toBe('피어 캠프')
    expect(normalizeInstitutionName('a\nb')).toBeNull()
    expect(normalizeInstitutionName('가'.repeat(81))).toBeNull()
    expect(normalizeCohortLabel(' 12  기 ')).toEqual({ ok: true, value: '12 기', key: '12기' })
    expect(normalizeCohortLabel('Spring 2026')).toEqual({ ok: true, value: 'Spring 2026', key: 'spring2026' })
    expect(normalizeCohortLabel('')).toEqual({ ok: false, reason: 'required' })
    expect(normalizeCohortLabel(undefined)).toEqual({ ok: false, reason: 'required' })
    expect(normalizeCohortLabel('가'.repeat(21))).toEqual({ ok: false, reason: 'too_long' })
    expect(normalizeCohortLabel('1\t기')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeCohortLabel(3)).toEqual({ ok: false, reason: 'invalid' })
  })
  it('labels standing by institution kind', () => {
    expect(standingLabelFor('university', 'student')).toBe('재학생')
    expect(standingLabelFor('university', 'alumni')).toBe('졸업생')
    expect(standingLabelFor('bootcamp', 'student')).toBe('수강생')
    expect(standingLabelFor('training_program', 'alumni')).toBe('수료생')
  })
})

describe('invite codes', () => {
  it('generates 12-character Crockford codes and normalizes input', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateInviteCode()))
    expect(codes.size).toBe(200)
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
      expect(formatInviteCode(normalizeInviteCode(code)!)).toBe(code)
    }
    expect(normalizeInviteCode(' abcd efgh-jkmn ')).toBe('ABCDEFGHJKMN')
    expect(normalizeInviteCode('oOiI-lL00-1111')).toBe('001111001111')
    expect(normalizeInviteCode('ABCD-EFGH-JKM')).toBeNull()
    expect(normalizeInviteCode('ABCD-EFGH-JKMU')).toBeNull()
    expect(normalizeInviteCode(123)).toBeNull()
    expect(inviteCodeHashMessage('ABCDEFGHJKMN')).toBe('invite-code:v1:ABCDEFGHJKMN')
  })
  it('rejects revoked, then expired, then exhausted codes', () => {
    const base = { expiresAt: new Date(NOW.getTime() + DAY), maxUses: 2, usedCount: 1, revokedAt: null }
    expect(decideInviteRedemption(base, NOW)).toEqual({ ok: true })
    expect(decideInviteRedemption({ ...base, usedCount: 2 }, NOW)).toEqual({ ok: false, reason: 'invite_code_exhausted' })
    expect(decideInviteRedemption({ ...base, expiresAt: NOW }, NOW)).toEqual({ ok: false, reason: 'invite_code_expired' })
    expect(decideInviteRedemption({ ...base, usedCount: 2, expiresAt: NOW, revokedAt: NOW }, NOW)).toEqual({ ok: false, reason: 'invite_code_revoked' })
  })
  it('checks issue limits', () => {
    expect(checkInviteIssue({ maxUses: 30 }, NOW)).toEqual({ ok: true, maxUses: 30, expiresAt: new Date(NOW.getTime() + 14 * DAY) })
    expect(checkInviteIssue({ maxUses: 1, expiresInDays: 90 }, NOW)).toMatchObject({ ok: true })
    expect(checkInviteIssue({ maxUses: 1001 }, NOW)).toEqual({ ok: false, field: 'maxUses', reason: 'invalid' })
    expect(checkInviteIssue({ maxUses: '3' }, NOW)).toEqual({ ok: false, field: 'maxUses', reason: 'invalid' })
    expect(checkInviteIssue({ maxUses: 3, expiresInDays: 0 }, NOW)).toEqual({ ok: false, field: 'expiresInDays', reason: 'invalid' })
  })
})

describe('cohort approval', () => {
  const request = { userId: 'r', status: 'pending', method: 'cohort_approval', institutionId: 'i', cohortId: 'c' }
  const member = (userId: string, method = 'invite_code', extra: Partial<{ cohortId: string | null; institutionId: string; status: string }> = {}) => ({
    userId,
    status: 'active',
    method,
    institutionId: 'i',
    cohortId: 'c',
    ...extra,
  })
  it('only same-cohort members verified by a non-approval method are eligible', () => {
    expect(isEligibleCohortApprover(member('a'), request)).toBe(true)
    expect(isEligibleCohortApprover(member('a', 'certificate_check'), request)).toBe(true)
    expect(isEligibleCohortApprover(member('a', 'cohort_approval'), request)).toBe(false)
    expect(isEligibleCohortApprover(member('a', 'invite_code', { cohortId: 'other' }), request)).toBe(false)
    expect(isEligibleCohortApprover(member('a', 'invite_code', { cohortId: null }), request)).toBe(false)
    expect(isEligibleCohortApprover(member('a', 'invite_code', { institutionId: 'j' }), request)).toBe(false)
    expect(isEligibleCohortApprover(member('a', 'invite_code', { status: 'revoked' }), request)).toBe(false)
  })
  it('needs two distinct approvals; rejects self, duplicate, ineligible and finished requests', () => {
    expect(decideCohortApproval(request, 'a', [member('a')], [])).toEqual({ ok: true, approvals: 1, verified: false })
    expect(decideCohortApproval(request, 'b', [member('b')], ['a'])).toEqual({ ok: true, approvals: 2, verified: true })
    expect(decideCohortApproval(request, 'a', [member('a')], ['a'])).toEqual({ ok: false, reason: 'already_approved' })
    expect(decideCohortApproval(request, 'r', [member('r')], [])).toEqual({ ok: false, reason: 'self_approval' })
    expect(decideCohortApproval(request, 'a', [member('a', 'cohort_approval')], [])).toEqual({ ok: false, reason: 'not_eligible' })
    expect(decideCohortApproval({ ...request, status: 'active' }, 'a', [member('a')], [])).toEqual({ ok: false, reason: 'not_pending' })
    expect(decideCohortApproval({ ...request, method: 'invite_code' }, 'a', [member('a')], [])).toEqual({ ok: false, reason: 'not_pending' })
  })
})

describe('certificate checks', () => {
  it('accepts images and PDFs up to 10MB with a matching extension', () => {
    expect(checkCertificateUpload({ declaredType: 'application/pdf', fileName: '수료증.PDF', byteSize: 100 })).toEqual({
      ok: true,
      mediaType: 'application/pdf',
      extension: 'pdf',
      byteSize: 100,
    })
    expect(checkCertificateUpload({ declaredType: 'image/gif', fileName: 'a.gif', byteSize: 1 })).toMatchObject({ ok: false, field: 'declaredType' })
    expect(checkCertificateUpload({ declaredType: 'image/png', fileName: 'a.jpg', byteSize: 1 })).toMatchObject({ ok: false, reason: 'extension_mismatch' })
    expect(checkCertificateUpload({ declaredType: 'image/png', fileName: 'a.png', byteSize: CERTIFICATE_MAX_BYTES + 1 })).toMatchObject({ ok: false, reason: 'too_large' })
    expect(checkCertificateUpload({ declaredType: 'image/png', fileName: 'a.png', byteSize: 0 })).toMatchObject({ ok: false, reason: 'invalid' })
  })
  it('decides when a file is due for deletion', () => {
    const base = { decidedAt: null, affiliationStatus: 'pending', scanStatus: 'clean', uploadedAt: NOW, createdAt: NOW, filePurgedAt: null }
    expect(certificateFileDue(base, NOW)).toEqual({ due: false })
    expect(certificateFileDue({ ...base, decidedAt: NOW }, NOW)).toEqual({ due: true, reason: 'decided' })
    expect(certificateFileDue({ ...base, affiliationStatus: 'revoked' }, NOW)).toEqual({ due: true, reason: 'closed' })
    expect(certificateFileDue({ ...base, scanStatus: 'quarantined' }, NOW)).toEqual({ due: true, reason: 'rejected_scan' })
    expect(certificateFileDue({ ...base, uploadedAt: null }, new Date(NOW.getTime() + DAY))).toEqual({ due: true, reason: 'not_uploaded' })
    expect(certificateFileDue(base, new Date(NOW.getTime() + CERTIFICATE_PENDING_TTL_MS))).toEqual({ due: true, reason: 'stale' })
    expect(certificateFileDue({ ...base, decidedAt: NOW, filePurgedAt: NOW }, NOW)).toEqual({ due: false })
  })
  it('only pending, clean, undecided checks can be decided', () => {
    const base = { decidedAt: null, affiliationStatus: 'pending', scanStatus: 'clean', filePurgedAt: null }
    expect(canDecideCertificate(base)).toBe(true)
    expect(canDecideCertificate({ ...base, scanStatus: 'scanning' })).toBe(false)
    expect(canDecideCertificate({ ...base, decidedAt: NOW })).toBe(false)
    expect(canDecideCertificate({ ...base, affiliationStatus: 'revoked' })).toBe(false)
  })
})
