import { describe, expect, it } from 'vitest'
import { claimStatus, endorseClaim, isClaimConfirmed, type Membership, type RoleClaim } from '../src'

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
