import { describe, expect, it } from 'vitest'
import {
  LOG_TAGS,
  PROJECT_ROLES,
  canReviseLog,
  canWriteLog,
  checkResolveTarget,
  isLogTag,
  isTagChangeAllowed,
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

describe('canWriteLog', () => {
  it.each(PROJECT_ROLES)('only active owner/editor write (%s)', (role) => {
    expect(canWriteLog(as('u1'), project, m('u1', role))).toBe(role === 'owner' || role === 'editor')
  })

  it('denies non-members, inactive members, anonymous, other-project memberships and admin bypass', () => {
    expect(canWriteLog(as('u1'), project, null)).toBe(false)
    expect(canWriteLog(as('u1'), project, m('u1', 'editor', { status: 'left' }))).toBe(false)
    expect(canWriteLog(as('u1'), project, m('u1', 'editor', { status: 'invited' }))).toBe(false)
    expect(canWriteLog({ userId: null }, project, m('u1', 'editor'))).toBe(false)
    expect(canWriteLog(as('u1'), project, m('u1', 'owner', { projectId: 'p2' }))).toBe(false)
    expect(canWriteLog({ userId: 'admin', isAdmin: true }, project, null)).toBe(false)
    expect(canWriteLog({ userId: 'admin', isAdmin: true }, project, m('admin', 'viewer'))).toBe(false)
  })
})

describe('canReviseLog', () => {
  const log = { projectId: 'p1', authorId: 'u1' }

  it('lets the author revise while still an active owner/editor', () => {
    expect(canReviseLog(as('u1'), project, m('u1', 'editor'), log)).toBe(true)
    expect(canReviseLog(as('u1'), project, m('u1', 'owner'), log)).toBe(true)
  })

  it('denies the author after demotion to reviewer/viewer or leaving', () => {
    expect(canReviseLog(as('u1'), project, m('u1', 'reviewer'), log)).toBe(false)
    expect(canReviseLog(as('u1'), project, m('u1', 'viewer'), log)).toBe(false)
    expect(canReviseLog(as('u1'), project, m('u1', 'editor', { status: 'removed' }), log)).toBe(false)
  })

  it('denies other members including the owner, and admins', () => {
    expect(canReviseLog(as('owner'), project, m('owner', 'owner'), log)).toBe(false)
    expect(canReviseLog(as('u2'), project, m('u2', 'editor'), log)).toBe(false)
    expect(canReviseLog({ userId: 'admin', isAdmin: true }, project, null, log)).toBe(false)
  })

  it('denies a log of another project', () => {
    expect(canReviseLog(as('u1'), project, m('u1', 'editor'), { projectId: 'p2', authorId: 'u1' })).toBe(false)
  })
})

describe('checkResolveTarget', () => {
  const solution = { projectId: 'p1', entryId: 's1' }

  it('accepts a stuck log of the same project', () => {
    expect(checkResolveTarget(solution, { id: 'k1', projectId: 'p1', tag: 'stuck' })).toBe('ok')
    // 새로 만드는 해결 로그(아직 id 없음)
    expect(checkResolveTarget({ projectId: 'p1' }, { id: 'k1', projectId: 'p1', tag: 'stuck' })).toBe('ok')
  })

  it('allows several solutions for one stuck log (no exclusivity rule)', () => {
    const stuck = { id: 'k1', projectId: 'p1', tag: 'stuck' } as const
    expect(checkResolveTarget({ projectId: 'p1', entryId: 's1' }, stuck)).toBe('ok')
    expect(checkResolveTarget({ projectId: 'p1', entryId: 's2' }, stuck)).toBe('ok')
  })

  it('treats a missing target and a target in another project the same', () => {
    expect(checkResolveTarget(solution, null)).toBe('not_found')
    expect(checkResolveTarget(solution, { id: 'k1', projectId: 'p2', tag: 'stuck' })).toBe('not_found')
  })

  it('rejects self-resolution and non-stuck targets', () => {
    expect(checkResolveTarget(solution, { id: 's1', projectId: 'p1', tag: 'solution' })).toBe('self')
    expect(checkResolveTarget(solution, { id: 's1', projectId: 'p1', tag: 'stuck' })).toBe('self')
    for (const tag of LOG_TAGS.filter((t) => t !== 'stuck')) {
      expect(checkResolveTarget(solution, { id: 'x', projectId: 'p1', tag })).toBe('not_stuck')
    }
  })
})

describe('tags', () => {
  it('recognizes the seven tags only', () => {
    expect(LOG_TAGS).toHaveLength(7)
    expect(isLogTag('stuck')).toBe(true)
    expect(isLogTag('todo')).toBe(false)
    expect(isLogTag(undefined)).toBe(false)
  })

  it('never allows changing the tag', () => {
    expect(isTagChangeAllowed('stuck', undefined)).toBe(true)
    expect(isTagChangeAllowed('stuck', 'stuck')).toBe(true)
    expect(isTagChangeAllowed('stuck', 'solution')).toBe(false)
    expect(isTagChangeAllowed('stuck', null)).toBe(false)
  })
})
