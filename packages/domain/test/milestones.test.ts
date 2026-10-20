import { describe, expect, it } from 'vitest'
import {
  MILESTONE_LIMIT,
  MILESTONE_TEMPLATE,
  PROJECT_ROLES,
  SCAN_STATUSES,
  SNAPSHOT_LIMIT,
  canAttachAsEvidence,
  canManageMilestones,
  canUseAsSnapshot,
  checkMilestoneOrder,
  checkSnapshotTarget,
  type Membership,
  type ProjectRole,
} from '../src'

const project = { id: 'p1' }
const m = (userId: string, role: ProjectRole, overrides: Partial<Membership> = {}): Membership => ({
  projectId: 'p1',
  userId,
  role,
  status: 'active',
  ...overrides,
})
const as = (userId: string) => ({ userId })

describe('canManageMilestones', () => {
  it.each(PROJECT_ROLES)('only active owner/editor manage milestones (%s)', (role) => {
    expect(canManageMilestones(as('u1'), project, m('u1', role))).toBe(role === 'owner' || role === 'editor')
  })

  it('denies non-members, inactive members, anonymous, other-project memberships and admin bypass', () => {
    expect(canManageMilestones(as('u1'), project, null)).toBe(false)
    expect(canManageMilestones(as('u1'), project, m('u1', 'owner', { status: 'left' }))).toBe(false)
    expect(canManageMilestones(as('u1'), project, m('u1', 'editor', { status: 'invited' }))).toBe(false)
    expect(canManageMilestones({ userId: null }, project, m('u1', 'owner'))).toBe(false)
    expect(canManageMilestones(as('u1'), project, m('u1', 'owner', { projectId: 'p2' }))).toBe(false)
    expect(canManageMilestones(as('u1'), project, m('u2', 'owner'))).toBe(false)
    expect(canManageMilestones({ userId: 'admin', isAdmin: true }, project, null)).toBe(false)
  })
})

describe('checkMilestoneOrder', () => {
  const existing = ['a', 'b', 'c']

  it('accepts any full permutation, including the current order', () => {
    expect(checkMilestoneOrder(existing, ['a', 'b', 'c'])).toBe('ok')
    expect(checkMilestoneOrder(existing, ['c', 'a', 'b'])).toBe('ok')
    expect(checkMilestoneOrder([], [])).toBe('ok')
  })

  it('rejects duplicates before anything else', () => {
    expect(checkMilestoneOrder(existing, ['a', 'a', 'b'])).toBe('duplicate')
    expect(checkMilestoneOrder(existing, ['a', 'b', 'c', 'c'])).toBe('duplicate')
  })

  it('rejects missing, extra or unknown ids as a mismatch', () => {
    expect(checkMilestoneOrder(existing, ['a', 'b'])).toBe('mismatch')
    expect(checkMilestoneOrder(existing, ['a', 'b', 'c', 'd'])).toBe('mismatch')
    expect(checkMilestoneOrder(existing, ['a', 'b', 'x'])).toBe('mismatch')
    expect(checkMilestoneOrder(existing, [])).toBe('mismatch')
  })
})

describe('snapshot rules', () => {
  it.each(SCAN_STATUSES)('only clean versions can be snapshots (%s)', (status) => {
    expect(canUseAsSnapshot(status)).toBe(status === 'clean')
  })

  it('is stricter than evidence: in-progress versions are evidence but not snapshots', () => {
    for (const status of ['pending', 'scanning'] as const) {
      expect(canAttachAsEvidence(status)).toBe(true)
      expect(canUseAsSnapshot(status)).toBe(false)
    }
  })

  it('treats missing and other-project versions the same (not_found), then checks status', () => {
    expect(checkSnapshotTarget('p1', null)).toBe('not_found')
    expect(checkSnapshotTarget('p1', undefined)).toBe('not_found')
    expect(checkSnapshotTarget('p1', { projectId: 'p2', scanStatus: 'clean' })).toBe('not_found')
    expect(checkSnapshotTarget('p1', { projectId: 'p2', scanStatus: 'pending' })).toBe('not_found')
    expect(checkSnapshotTarget('p1', { projectId: 'p1', scanStatus: 'pending' })).toBe('not_clean')
    expect(checkSnapshotTarget('p1', { projectId: 'p1', scanStatus: 'quarantined' })).toBe('not_clean')
    expect(checkSnapshotTarget('p1', { projectId: 'p1', scanStatus: 'clean' })).toBe('ok')
  })
})

describe('limits and template', () => {
  it('keeps the agreed limits', () => {
    expect(MILESTONE_LIMIT).toBe(12)
    expect(SNAPSHOT_LIMIT).toBe(6)
  })

  it('template fits within the limit and has unique, short names', () => {
    expect(MILESTONE_TEMPLATE).toEqual(['기획', '중간발표', '구현', '검증', '최종제출'])
    expect(MILESTONE_TEMPLATE.length).toBeLessThanOrEqual(MILESTONE_LIMIT)
    expect(new Set(MILESTONE_TEMPLATE).size).toBe(MILESTONE_TEMPLATE.length)
    for (const title of MILESTONE_TEMPLATE) expect(title.length).toBeLessThanOrEqual(80)
  })
})
