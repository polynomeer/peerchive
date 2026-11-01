import { describe, expect, it } from 'vitest'
import {
  OPEN_TASK_LIMIT,
  PROJECT_ROLES,
  TASK_CONVERT_TAGS,
  TASK_LIMIT,
  TASK_STATUSES,
  boardStep,
  canChangeRetroMode,
  canDeleteTask,
  canManageTasks,
  checkTaskConvert,
  checkTaskOrder,
  dropTarget,
  insertTaskAt,
  isRetrospectiveLog,
  isTaskStatus,
  locateTask,
  logSourceFor,
  opensTask,
  planTaskMove,
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

describe('board view moves (E-09): drag, keyboard and buttons share one plan', () => {
  const columns = { todo: ['a', 'b', 'c'], doing: ['d'], done: [] as string[] }

  it('insertTaskAt clamps the 1-based position and removes the task first', () => {
    expect(insertTaskAt(['a', 'b', 'c'], 'x', 1)).toEqual(['x', 'a', 'b', 'c'])
    expect(insertTaskAt(['a', 'b', 'c'], 'x', 99)).toEqual(['a', 'b', 'c', 'x'])
    expect(insertTaskAt(['a', 'b', 'c'], 'a', 3)).toEqual(['b', 'c', 'a'])
    expect(insertTaskAt(['a', 'b'], 'x', 0)).toEqual(['x', 'a', 'b'])
  })

  it('locateTask finds the column and index', () => {
    expect(locateTask(columns, 'c')).toEqual({ status: 'todo', index: 2 })
    expect(locateTask(columns, 'd')).toEqual({ status: 'doing', index: 0 })
    expect(locateTask(columns, 'zz')).toBeNull()
  })

  it('planTaskMove: same column → full permutation (same as list ▲▼), other column → status + position, same spot → none', () => {
    expect(planTaskMove(columns, 'a', { status: 'todo', index: 2 })).toEqual({ kind: 'reorder', status: 'todo', taskIds: ['b', 'c', 'a'] })
    expect(planTaskMove(columns, 'c', { status: 'todo', index: 0 })).toEqual({ kind: 'reorder', status: 'todo', taskIds: ['c', 'a', 'b'] })
    expect(planTaskMove(columns, 'b', { status: 'todo', index: 1 })).toEqual({ kind: 'none' })
    expect(planTaskMove(columns, 'b', { status: 'doing', index: 0 })).toEqual({ kind: 'status', status: 'doing', position: 1 })
    expect(planTaskMove(columns, 'b', { status: 'doing', index: 7 })).toEqual({ kind: 'status', status: 'doing', position: 2 })
    expect(planTaskMove(columns, 'd', { status: 'done', index: 0 })).toEqual({ kind: 'status', status: 'done', position: 1 })
    expect(planTaskMove(columns, 'nope', { status: 'done', index: 0 })).toEqual({ kind: 'none' })
  })

  it('boardStep: up/down within a column, left/right keep the row (clamped), edges → null', () => {
    expect(boardStep(columns, 'a', 'up')).toBeNull()
    expect(boardStep(columns, 'a', 'down')).toEqual({ status: 'todo', index: 1 })
    expect(boardStep(columns, 'c', 'down')).toBeNull()
    expect(boardStep(columns, 'c', 'up')).toEqual({ status: 'todo', index: 1 })
    expect(boardStep(columns, 'a', 'left')).toBeNull()
    expect(boardStep(columns, 'c', 'right')).toEqual({ status: 'doing', index: 1 })
    expect(boardStep(columns, 'a', 'right')).toEqual({ status: 'doing', index: 0 })
    expect(boardStep(columns, 'd', 'right')).toEqual({ status: 'done', index: 0 })
    expect(boardStep(columns, 'd', 'left')).toEqual({ status: 'todo', index: 0 })
    expect(boardStep({ ...columns, done: ['e'] }, 'e', 'right')).toBeNull()
  })

  it('dropTarget (drag handler): before a card, at the end, or onto itself; plans match the button path', () => {
    expect(dropTarget(columns, 'a', 'todo', 'c')).toEqual({ status: 'todo', index: 1 })
    expect(dropTarget(columns, 'a', 'todo', null)).toEqual({ status: 'todo', index: 2 })
    expect(dropTarget(columns, 'b', 'todo', 'b')).toEqual({ status: 'todo', index: 1 })
    expect(dropTarget(columns, 'b', 'doing', 'd')).toEqual({ status: 'doing', index: 0 })
    expect(dropTarget(columns, 'b', 'done', null)).toEqual({ status: 'done', index: 0 })
    expect(dropTarget(columns, 'b', 'todo', 'gone')).toEqual({ status: 'todo', index: 2 })
    // 드래그로 'a'를 'c' 앞에 놓은 것과 ▼(아래로) 한 번은 같은 요청입니다.
    expect(planTaskMove(columns, 'a', dropTarget(columns, 'a', 'todo', 'c'))).toEqual(planTaskMove(columns, 'a', boardStep(columns, 'a', 'down')!))
    expect(planTaskMove(columns, 'd', dropTarget(columns, 'd', 'todo', 'a'))).toEqual(planTaskMove(columns, 'd', boardStep(columns, 'd', 'left')!))
  })
})
