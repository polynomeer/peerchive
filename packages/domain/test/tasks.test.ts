import { describe, expect, it } from 'vitest'
import {
  OPEN_TASK_LIMIT,
  PROJECT_ROLES,
  TASK_CONVERT_TAGS,
  TASK_LIMIT,
  TASK_STATUSES,
  canChangeRetroMode,
  canDeleteTask,
  canManageTasks,
  checkTaskConvert,
  checkTaskOrder,
  isRetrospectiveLog,
  isTaskStatus,
  logSourceFor,
  opensTask,
  statusChange,
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

describe('canManageTasks', () => {
  it.each(PROJECT_ROLES)('only active owner/editor manage tasks (%s)', (role) => {
    expect(canManageTasks(as('u1'), project, m('u1', role))).toBe(role === 'owner' || role === 'editor')
  })

  it('denies non-members, inactive members, anonymous, other-project memberships and admin bypass', () => {
    expect(canManageTasks(as('u1'), project, null)).toBe(false)
    expect(canManageTasks(as('u1'), project, m('u1', 'owner', { status: 'left' }))).toBe(false)
    expect(canManageTasks(as('u1'), project, m('u1', 'editor', { status: 'removed' }))).toBe(false)
    expect(canManageTasks({ userId: null }, project, m('u1', 'owner'))).toBe(false)
    expect(canManageTasks(as('u1'), project, m('u1', 'owner', { projectId: 'p2' }))).toBe(false)
    expect(canManageTasks(as('u1'), project, m('u2', 'owner'))).toBe(false)
    expect(canManageTasks({ userId: 'admin', isAdmin: true }, project, null)).toBe(false)
  })
})

describe('task status transitions', () => {
  it('knows the three statuses', () => {
    expect(TASK_STATUSES).toEqual(['todo', 'doing', 'done'])
    expect(isTaskStatus('doing')).toBe(true)
    expect(isTaskStatus('archived')).toBe(false)
    expect(isTaskStatus(undefined)).toBe(false)
  })

  it('classifies every pair of statuses', () => {
    expect(statusChange('todo', 'todo')).toBe('same')
    expect(statusChange('done', 'done')).toBe('same')
    expect(statusChange('todo', 'done')).toBe('complete')
    expect(statusChange('doing', 'done')).toBe('complete')
    expect(statusChange('done', 'todo')).toBe('reopen')
    expect(statusChange('done', 'doing')).toBe('reopen')
    expect(statusChange('todo', 'doing')).toBe('move')
    expect(statusChange('doing', 'todo')).toBe('move')
  })

  it('only reopening a done task counts against the open limit', () => {
    expect(opensTask('done', 'todo')).toBe(true)
    expect(opensTask('done', 'doing')).toBe(true)
    expect(opensTask('todo', 'doing')).toBe(false)
    expect(opensTask('doing', 'done')).toBe(false)
    expect(opensTask('done', 'done')).toBe(false)
  })
})

describe('checkTaskOrder (same rule as milestones)', () => {
  it('accepts full permutations and rejects duplicates and mismatches', () => {
    expect(checkTaskOrder(['a', 'b'], ['b', 'a'])).toBe('ok')
    expect(checkTaskOrder(['a', 'b'], ['a', 'a'])).toBe('duplicate')
    expect(checkTaskOrder(['a', 'b'], ['a'])).toBe('mismatch')
    expect(checkTaskOrder(['a', 'b'], ['a', 'x'])).toBe('mismatch')
  })
})

describe('conversion to a build log and deletion', () => {
  it('converts only done tasks, and only once', () => {
    expect(checkTaskConvert({ status: 'done', logEntryId: null })).toBe('ok')
    expect(checkTaskConvert({ status: 'doing', logEntryId: null })).toBe('not_done')
    expect(checkTaskConvert({ status: 'todo', logEntryId: null })).toBe('not_done')
    expect(checkTaskConvert({ status: 'done', logEntryId: 'l1' })).toBe('already_converted')
    // 되돌렸다가 다시 완료해도 두 번째 전환은 안 됩니다.
    expect(checkTaskConvert({ status: 'todo', logEntryId: 'l1' })).toBe('already_converted')
  })

  it('keeps converted tasks as the origin of their log', () => {
    expect(canDeleteTask({ logEntryId: null })).toBe(true)
    expect(canDeleteTask({ logEntryId: 'l1' })).toBe(false)
  })

  it('offers stuck, decision and progress as conversion tags', () => {
    expect(TASK_CONVERT_TAGS).toEqual(['stuck', 'decision', 'progress'])
  })

  it('keeps the agreed limits', () => {
    expect(OPEN_TASK_LIMIT).toBe(200)
    expect(TASK_LIMIT).toBeGreaterThanOrEqual(OPEN_TASK_LIMIT)
  })
})

describe('retrospective mode', () => {
  it.each(PROJECT_ROLES)('only the active owner changes retro mode (%s)', (role) => {
    expect(canChangeRetroMode(as('u1'), project, m('u1', role))).toBe(role === 'owner')
  })

  it('denies inactive owners, non-members and admin bypass', () => {
    expect(canChangeRetroMode(as('u1'), project, m('u1', 'owner', { status: 'left' }))).toBe(false)
    expect(canChangeRetroMode(as('u1'), project, null)).toBe(false)
    expect(canChangeRetroMode({ userId: 'admin', isAdmin: true }, project, null)).toBe(false)
  })

  it('derives log source and retrospective flag from the project mode at creation', () => {
    expect(logSourceFor(false, 'web')).toEqual({ source: 'web', retrospective: false })
    expect(logSourceFor(true, 'web')).toEqual({ source: 'retro', retrospective: true })
    // 할 일 전환 로그는 출처를 task로 남기고, 사후 작성 여부는 표시로 따로 남깁니다.
    expect(logSourceFor(false, 'task')).toEqual({ source: 'task', retrospective: false })
    expect(logSourceFor(true, 'task')).toEqual({ source: 'task', retrospective: true })
    // 디스코드 수집(T-09)도 출처를 discord로 남깁니다.
    expect(logSourceFor(false, 'discord')).toEqual({ source: 'discord', retrospective: false })
    expect(logSourceFor(true, 'discord')).toEqual({ source: 'discord', retrospective: true })
  })

  it('treats a log as retrospective if its source is retro or it was flagged at creation', () => {
    expect(isRetrospectiveLog({ source: 'retro', retrospective: false })).toBe(true)
    expect(isRetrospectiveLog({ source: 'task', retrospective: true })).toBe(true)
    expect(isRetrospectiveLog({ source: 'web', retrospective: false })).toBe(false)
    expect(isRetrospectiveLog({ source: 'task', retrospective: false })).toBe(false)
  })
})
