import { describe, expect, it } from 'vitest'
import {
  PROJECT_ROLES,
  canChangeRole,
  canEditProject,
  canInvite,
  canLeave,
  canManageMembers,
  canRemoveMember,
  canTransferOwnership,
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
const owner = m('owner', 'owner')
const as = (userId: string) => ({ userId })

describe('canEditProject', () => {
  it.each([
    ['owner', true],
    ['editor', true],
    ['reviewer', false],
    ['viewer', false],
  ] as const)('%s → %s', (role, expected) => {
    expect(canEditProject(as('u1'), project, m('u1', role))).toBe(expected)
  })

  it('denies non-members, inactive members, anonymous and admins without membership', () => {
    expect(canEditProject(as('u1'), project, null)).toBe(false)
    expect(canEditProject(as('u1'), project, m('u1', 'editor', { status: 'left' }))).toBe(false)
    expect(canEditProject({ userId: null }, project, m('u1', 'editor'))).toBe(false)
    expect(canEditProject({ userId: 'a', isAdmin: true }, project, null)).toBe(false)
  })

  it('rejects a membership of another project', () => {
    expect(canEditProject(as('u1'), project, m('u1', 'owner', { projectId: 'p2' }))).toBe(false)
  })
})

describe('canManageMembers / canInvite', () => {
  it.each(PROJECT_ROLES)('only an active owner manages members (%s)', (role) => {
    expect(canManageMembers(as('u1'), project, m('u1', role))).toBe(role === 'owner')
  })

  it('denies a removed owner record and an admin bypass', () => {
    expect(canManageMembers(as('owner'), project, m('owner', 'owner', { status: 'removed' }))).toBe(false)
    expect(canManageMembers({ userId: 'x', isAdmin: true }, project, null)).toBe(false)
  })

  it.each(['editor', 'reviewer', 'viewer'] as const)('owner can invite as %s', (role) => {
    expect(canInvite(as('owner'), project, owner, role)).toBe(true)
  })

  it('nobody can invite as owner', () => {
    expect(canInvite(as('owner'), project, owner, 'owner')).toBe(false)
  })

  it('editors cannot invite', () => {
    expect(canInvite(as('u1'), project, m('u1', 'editor'), 'viewer')).toBe(false)
  })
})

describe('canChangeRole', () => {
  const target = m('u2', 'viewer')

  it('owner can change an active non-owner member to a non-owner role', () => {
    expect(canChangeRole(as('owner'), project, owner, target, 'editor')).toBe(true)
  })

  it('cannot assign owner through role change', () => {
    expect(canChangeRole(as('owner'), project, owner, target, 'owner')).toBe(false)
  })

  it('cannot change own role or an owner', () => {
    expect(canChangeRole(as('owner'), project, owner, owner, 'editor')).toBe(false)
    expect(canChangeRole(as('owner'), project, owner, m('u3', 'owner'), 'editor')).toBe(false)
  })

  it('cannot change inactive members or members of another project', () => {
    expect(canChangeRole(as('owner'), project, owner, m('u2', 'viewer', { status: 'left' }), 'editor')).toBe(false)
    expect(canChangeRole(as('owner'), project, owner, m('u2', 'viewer', { projectId: 'p2' }), 'editor')).toBe(false)
    expect(canChangeRole(as('owner'), project, owner, null, 'editor')).toBe(false)
  })

  it('non-owners cannot change roles', () => {
    expect(canChangeRole(as('u1'), project, m('u1', 'editor'), target, 'reviewer')).toBe(false)
  })
})

describe('canRemoveMember', () => {
  it('owner removes an active non-owner member', () => {
    expect(canRemoveMember(as('owner'), project, owner, m('u2', 'editor'))).toBe(true)
  })

  it('owner cannot remove self; editors cannot remove anyone', () => {
    expect(canRemoveMember(as('owner'), project, owner, owner)).toBe(false)
    expect(canRemoveMember(as('u1'), project, m('u1', 'editor'), m('u2', 'viewer'))).toBe(false)
  })

  it('cannot remove someone who already left', () => {
    expect(canRemoveMember(as('owner'), project, owner, m('u2', 'viewer', { status: 'left' }))).toBe(false)
  })
})

describe('canLeave', () => {
  it.each(['editor', 'reviewer', 'viewer'] as const)('active %s can leave', (role) => {
    expect(canLeave(as('u1'), project, m('u1', role))).toBe(true)
  })

  it('owner cannot leave without transferring ownership', () => {
    expect(canLeave(as('owner'), project, owner)).toBe(false)
  })

  it('non-members and inactive members cannot leave', () => {
    expect(canLeave(as('u1'), project, null)).toBe(false)
    expect(canLeave(as('u1'), project, m('u1', 'viewer', { status: 'removed' }))).toBe(false)
  })
})

describe('canTransferOwnership', () => {
  it('owner transfers to another active member', () => {
    expect(canTransferOwnership(as('owner'), project, owner, m('u2', 'viewer'))).toBe(true)
  })

  it('cannot transfer to self, to inactive members, or as non-owner', () => {
    expect(canTransferOwnership(as('owner'), project, owner, owner)).toBe(false)
    expect(canTransferOwnership(as('owner'), project, owner, m('u2', 'editor', { status: 'invited' }))).toBe(false)
    expect(canTransferOwnership(as('u1'), project, m('u1', 'editor'), m('u2', 'viewer'))).toBe(false)
  })

  it('admin has no implicit bypass', () => {
    expect(canTransferOwnership({ userId: 'a', isAdmin: true }, project, null, m('u2', 'viewer'))).toBe(false)
  })
})
