import { describe, expect, it } from 'vitest'
import { PROJECT_ROLES, canReadProjectWorkspace, type Membership } from '../src'

const project = { id: 'p1' }
const member = (overrides: Partial<Membership> = {}): Membership => ({
  projectId: 'p1',
  userId: 'u1',
  role: 'viewer',
  status: 'active',
  ...overrides,
})

describe('canReadProjectWorkspace', () => {
  it('denies anonymous visitors', () => {
    expect(canReadProjectWorkspace({ userId: null }, project, null)).toBe(false)
  })

  it('denies a logged-in non-member', () => {
    expect(canReadProjectWorkspace({ userId: 'u9' }, project, null)).toBe(false)
  })

  it.each(PROJECT_ROLES)('allows an active %s of the project', (role) => {
    expect(canReadProjectWorkspace({ userId: 'u1' }, project, member({ role }))).toBe(true)
  })

  it.each(['invited', 'left', 'removed'] as const)('denies a member with status %s', (status) => {
    expect(canReadProjectWorkspace({ userId: 'u1' }, project, member({ status }))).toBe(false)
  })

  it('denies an admin who is not a member (no default bypass)', () => {
    expect(canReadProjectWorkspace({ userId: 'admin', isAdmin: true }, project, null)).toBe(false)
  })

  it('rejects a membership for another project or another user', () => {
    expect(canReadProjectWorkspace({ userId: 'u1' }, project, member({ projectId: 'p2' }))).toBe(false)
    expect(canReadProjectWorkspace({ userId: 'u2' }, project, member())).toBe(false)
  })
})
