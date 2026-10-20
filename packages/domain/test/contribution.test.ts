import { describe, expect, it } from 'vitest'
import {
  addDays,
  canDeclareClaim,
  canEndorse,
  canReviseClaim,
  checkClaimEvidenceTarget,
  checkPeriod,
  claimStatus,
  claimStatusSummary,
  endorseClaim,
  includeInLedger,
  isClaimConfirmed,
  openDays,
  orderMembersByName,
  periodBounds,
  projectWeekNo,
  revisionStatus,
  seoulDate,
  seoulWeek,
  type Membership,
  type RoleClaim,
} from '../src'

const claim: RoleClaim = {
  id: 'c1',
  projectId: 'p1',
  userId: 'alice',
  revisions: [
    { id: 'c1r1', revisionNo: 1 },
    { id: 'c1r2', revisionNo: 2 },
  ],
}

const bobMembership: Membership = { projectId: 'p1', userId: 'bob', role: 'editor', status: 'active' }

describe('isClaimConfirmed', () => {
  it('is false with no endorsements', () => {
    expect(isClaimConfirmed(claim, [])).toBe(false)
    expect(claimStatus(claim, [])).toBe('unconfirmed')
  })

  it('is true when another member confirmed the latest revision', () => {
    expect(isClaimConfirmed(claim, [{ claimRevisionId: 'c1r2', endorserId: 'bob', status: 'confirmed' }])).toBe(true)
  })

  it('does not carry an endorsement of an older revision over to the latest', () => {
    const endorsements = [{ claimRevisionId: 'c1r1', endorserId: 'bob', status: 'confirmed' as const }]
    expect(isClaimConfirmed(claim, endorsements)).toBe(false)
    expect(claimStatus(claim, endorsements)).toBe('unconfirmed')
  })

  it('ignores self-endorsements even if one slipped into storage', () => {
    expect(isClaimConfirmed(claim, [{ claimRevisionId: 'c1r2', endorserId: 'alice', status: 'confirmed' }])).toBe(
      false,
    )
  })

  it('reports disputed when a member disputes the latest revision', () => {
    const endorsements = [
      { claimRevisionId: 'c1r2', endorserId: 'bob', status: 'confirmed' as const },
      { claimRevisionId: 'c1r2', endorserId: 'carol', status: 'disputed' as const },
    ]
    expect(claimStatus(claim, endorsements)).toBe('disputed')
    expect(isClaimConfirmed(claim, endorsements)).toBe(false)
  })

  it('ignores withdrawn endorsements', () => {
    expect(isClaimConfirmed(claim, [{ claimRevisionId: 'c1r2', endorserId: 'bob', status: 'withdrawn' }])).toBe(false)
  })
})

describe('endorseClaim', () => {
  it('rejects self-endorsement', () => {
    const result = endorseClaim({
      claim,
      claimRevisionId: 'c1r2',
      endorserId: 'alice',
      endorserMembership: { projectId: 'p1', userId: 'alice', role: 'owner', status: 'active' },
      status: 'confirmed',
    })
    expect(result).toEqual({ ok: false, error: { code: 'SELF_ENDORSEMENT' } })
  })

  it('rejects endorsers who are not active members of the same project', () => {
    const base = { claim, claimRevisionId: 'c1r2', endorserId: 'bob', status: 'confirmed' as const }
    expect(endorseClaim({ ...base, endorserMembership: null })).toMatchObject({
      ok: false,
      error: { code: 'NOT_PROJECT_MEMBER' },
    })
    expect(endorseClaim({ ...base, endorserMembership: { ...bobMembership, projectId: 'p2' } })).toMatchObject({
      ok: false,
      error: { code: 'NOT_PROJECT_MEMBER' },
    })
    expect(endorseClaim({ ...base, endorserMembership: { ...bobMembership, status: 'left' } })).toMatchObject({
      ok: false,
      error: { code: 'NOT_PROJECT_MEMBER' },
    })
  })

  it('rejects endorsing a revision that is no longer current', () => {
    expect(
      endorseClaim({
        claim,
        claimRevisionId: 'c1r1',
        endorserId: 'bob',
        endorserMembership: bobMembership,
        status: 'confirmed',
      }),
    ).toEqual({ ok: false, error: { code: 'REVISION_NOT_CURRENT', currentRevisionId: 'c1r2' } })
  })

  it('accepts a teammate endorsing the latest revision', () => {
    const result = endorseClaim({
      claim,
      claimRevisionId: 'c1r2',
      endorserId: 'bob',
      endorserMembership: bobMembership,
      status: 'confirmed',
    })
    expect(result).toEqual({ ok: true, endorsement: { claimRevisionId: 'c1r2', endorserId: 'bob', status: 'confirmed' } })
    if (result.ok) expect(isClaimConfirmed(claim, [result.endorsement])).toBe(true)
  })
})

describe('claim permissions', () => {
  const project = { id: 'p1' }
  const member = (userId: string, role: Membership['role'], status: Membership['status'] = 'active'): Membership => ({
    projectId: 'p1',
    userId,
    role,
    status,
  })
  const aliceClaim = { projectId: 'p1', userId: 'alice' }

  it('lets active owner/editor/reviewer declare, but not viewers, inactive or outside members', () => {
    for (const role of ['owner', 'editor', 'reviewer'] as const) {
      expect(canDeclareClaim({ userId: 'u' }, project, member('u', role))).toBe(true)
    }
    expect(canDeclareClaim({ userId: 'u' }, project, member('u', 'viewer'))).toBe(false)
    expect(canDeclareClaim({ userId: 'u' }, project, member('u', 'editor', 'left'))).toBe(false)
    expect(canDeclareClaim({ userId: 'u' }, project, { ...member('u', 'editor'), projectId: 'p2' })).toBe(false)
    expect(canDeclareClaim({ userId: null }, project, member('u', 'editor'))).toBe(false)
    expect(canDeclareClaim({ userId: 'u', isAdmin: true }, project, null)).toBe(false)
  })

  it('only the author may revise — not even the owner', () => {
    expect(canReviseClaim({ userId: 'alice' }, project, member('alice', 'editor'), aliceClaim)).toBe(true)
    expect(canReviseClaim({ userId: 'owner' }, project, member('owner', 'owner'), aliceClaim)).toBe(false)
    expect(canReviseClaim({ userId: 'alice' }, project, member('alice', 'viewer'), aliceClaim)).toBe(false)
    expect(canReviseClaim({ userId: 'alice' }, project, member('alice', 'editor', 'left'), aliceClaim)).toBe(false)
    expect(canReviseClaim({ userId: 'alice' }, project, member('alice', 'editor'), { ...aliceClaim, projectId: 'p2' })).toBe(false)
  })

  it('lets teammates (not the author, not viewers) endorse', () => {
    expect(canEndorse({ userId: 'bob' }, project, member('bob', 'editor'), aliceClaim)).toBe(true)
    expect(canEndorse({ userId: 'rev' }, project, member('rev', 'reviewer'), aliceClaim)).toBe(true)
    expect(canEndorse({ userId: 'owner' }, project, member('owner', 'owner'), aliceClaim)).toBe(true)
    expect(canEndorse({ userId: 'alice' }, project, member('alice', 'editor'), aliceClaim)).toBe(false)
    expect(canEndorse({ userId: 'vw' }, project, member('vw', 'viewer'), aliceClaim)).toBe(false)
    expect(canEndorse({ userId: 'bob' }, project, member('bob', 'editor', 'removed'), aliceClaim)).toBe(false)
  })

  it('endorseClaim rejects viewers with READ_ONLY_ROLE', () => {
    expect(
      endorseClaim({
        claim,
        claimRevisionId: 'c1r2',
        endorserId: 'bob',
        endorserMembership: { ...bobMembership, role: 'viewer' },
        status: 'confirmed',
      }),
    ).toEqual({ ok: false, error: { code: 'READ_ONLY_ROLE' } })
  })
})

describe('claim status summary', () => {
  it('counts people on the current revision only, and a dispute wins', () => {
    const endorsements = [
      { claimRevisionId: 'c1r1', endorserId: 'bob', status: 'confirmed' as const },
      { claimRevisionId: 'c1r2', endorserId: 'carol', status: 'confirmed' as const },
      { claimRevisionId: 'c1r2', endorserId: 'dan', status: 'confirmed' as const },
    ]
    expect(claimStatusSummary(claim, endorsements)).toEqual({ status: 'confirmed', confirmedCount: 2, disputedCount: 0 })
    const disputed = [...endorsements, { claimRevisionId: 'c1r2', endorserId: 'erin', status: 'disputed' as const }]
    expect(claimStatusSummary(claim, disputed)).toEqual({ status: 'disputed', confirmedCount: 2, disputedCount: 1 })
  })

  it('a new revision starts unconfirmed while old endorsements stay on their revision', () => {
    const endorsements = [{ claimRevisionId: 'c1r1', endorserId: 'bob', status: 'confirmed' as const }]
    expect(claimStatusSummary(claim, endorsements).status).toBe('unconfirmed')
    expect(revisionStatus(claim, 'c1r1', endorsements)).toBe('confirmed')
    expect(revisionStatus(claim, 'c1r2', endorsements)).toBe('unconfirmed')
  })
})

describe('checkClaimEvidenceTarget', () => {
  it('requires the same project and an attachable file', () => {
    expect(checkClaimEvidenceTarget('p1', { kind: 'log', projectId: 'p1' })).toBe('ok')
    expect(checkClaimEvidenceTarget('p1', { kind: 'log', projectId: 'p2' })).toBe('not_found')
    expect(checkClaimEvidenceTarget('p1', null)).toBe('not_found')
    expect(checkClaimEvidenceTarget('p1', { kind: 'artifact', projectId: 'p2', scanStatus: 'clean' })).toBe('not_found')
    for (const scanStatus of ['pending', 'scanning', 'clean'] as const) {
      expect(checkClaimEvidenceTarget('p1', { kind: 'artifact', projectId: 'p1', scanStatus })).toBe('ok')
    }
    for (const scanStatus of ['quarantined', 'failed'] as const) {
      expect(checkClaimEvidenceTarget('p1', { kind: 'artifact', projectId: 'p1', scanStatus })).toBe('not_attachable')
      expect(checkClaimEvidenceTarget('p1', { kind: 'artifact', projectId: 'p1', scanStatus }, { inherited: true })).toBe('ok')
    }
  })
})

describe('contribution periods (Asia/Seoul)', () => {
  it('uses Monday–Sunday weeks in Seoul time', () => {
    // 2026-10-25(일) 23:30 KST = 14:30 UTC → 그 주(10-19 ~ 10-25)
    expect(seoulWeek(new Date('2026-10-25T14:30:00Z'))).toEqual({ from: '2026-10-19', to: '2026-10-25' })
    // 2026-10-25(일) 15:30 UTC = 10-26(월) 00:30 KST → 다음 주
    expect(seoulWeek(new Date('2026-10-25T15:30:00Z'))).toEqual({ from: '2026-10-26', to: '2026-11-01' })
    expect(seoulWeek(new Date('2026-10-20T03:00:00Z'), 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' })
    expect(seoulDate(new Date('2026-12-31T15:00:00Z'))).toBe('2027-01-01')
  })

  it('turns inclusive Seoul dates into a half-open UTC range', () => {
    expect(periodBounds('2026-10-19', '2026-10-25')).toEqual({
      start: new Date('2026-10-18T15:00:00Z'),
      end: new Date('2026-10-25T15:00:00Z'),
    })
    expect(checkPeriod('2026-10-19', '2026-10-19')).toBe('ok')
    expect(checkPeriod('2026-10-19', '2026-10-18')).toBe('before_from')
    expect(checkPeriod('2026-01-01', '2027-01-02')).toBe('too_long')
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('numbers project weeks from the creation week and counts open days', () => {
    const created = new Date('2026-10-07T01:00:00Z') // 수요일
    expect(projectWeekNo(created, '2026-10-05', '2026-10-11')).toBe(1)
    expect(projectWeekNo(created, '2026-10-19', '2026-10-25')).toBe(3)
    expect(projectWeekNo(created, '2026-10-19', '2026-10-24')).toBeNull()
    expect(projectWeekNo(created, '2026-09-28', '2026-10-04')).toBeNull()
    expect(openDays(new Date('2026-10-19T14:00:00Z'), new Date('2026-10-20T10:00:00Z'))).toBe(2)
    expect(openDays(new Date('2026-10-19T14:00:00Z'), new Date('2026-10-20T16:00:00Z'))).toBe(3)
  })
})

describe('ledger membership and order', () => {
  it('orders by display name, never by activity', () => {
    const members = [
      { userId: 'b', displayName: '하늘', logs: 30 },
      { userId: 'a', displayName: '가람', logs: 1 },
      { userId: 'c', displayName: 'Alex', logs: 5 },
      { userId: 'd', displayName: '나래', logs: 0 },
    ]
    expect(orderMembersByName(members).map((m) => m.displayName)).toEqual(['가람', '나래', '하늘', 'Alex'])
  })

  it('always lists active members; former members only with activity; never invitees', () => {
    expect(includeInLedger('active', false)).toBe(true)
    expect(includeInLedger('left', false)).toBe(false)
    expect(includeInLedger('left', true)).toBe(true)
    expect(includeInLedger('removed', true)).toBe(true)
    expect(includeInLedger('invited', true)).toBe(false)
  })
})
