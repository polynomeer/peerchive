import { describe, expect, it } from 'vitest'
import {
  type Membership,
  type ProjectRole,
  canDeleteLogComment,
  canEditLogComment,
  canHideLogComment,
  canReadLogComments,
  canSeeLogCommentBody,
  canWriteLogComment,
  normalizeLogCommentBody,
} from '../src'

const P = { id: 'p1', lifecycle: 'active' }
const ARCHIVED = { id: 'p1', lifecycle: 'archived' }
const member = (userId: string, role: ProjectRole, status: Membership['status'] = 'active'): Membership => ({ projectId: 'p1', userId, role, status })

describe('log comment rules (E-10)', () => {
  it('normalizes bodies and rejects blank ones', () => {
    expect(normalizeLogCommentBody('  좋아요\r\n다음엔 테스트도 \r ')).toBe('좋아요\n다음엔 테스트도')
    expect(normalizeLogCommentBody(' \n\t ')).toBeNull()
  })

  it('every active member reads; owner/editor/reviewer write; viewer, left members and strangers do not', () => {
    for (const role of ['owner', 'editor', 'reviewer', 'viewer'] as const) {
      expect(canReadLogComments({ userId: 'u' }, P, member('u', role))).toBe(true)
      expect(canWriteLogComment({ userId: 'u' }, P, member('u', role))).toBe(role !== 'viewer')
    }
    expect(canReadLogComments({ userId: 'u' }, P, member('u', 'editor', 'left'))).toBe(false)
    expect(canWriteLogComment({ userId: 'u' }, P, member('u', 'editor', 'removed'))).toBe(false)
    expect(canReadLogComments({ userId: 'u' }, P, null)).toBe(false)
    expect(canReadLogComments({ userId: null }, P, member('u', 'owner'))).toBe(false)
    // 다른 사람·다른 과제의 멤버십은 거부.
    expect(canWriteLogComment({ userId: 'x' }, P, member('u', 'owner'))).toBe(false)
    expect(canWriteLogComment({ userId: 'u' }, { id: 'p2', lifecycle: 'active' }, member('u', 'owner'))).toBe(false)
  })

  it('archived projects are read-only for new comments and edits, but delete and hide still work', () => {
    const mine = { authorId: 'u', status: 'published' as const }
    expect(canWriteLogComment({ userId: 'u' }, ARCHIVED, member('u', 'owner'))).toBe(false)
    expect(canEditLogComment({ userId: 'u' }, ARCHIVED, member('u', 'owner'), mine)).toBe(false)
    expect(canDeleteLogComment({ userId: 'u' }, ARCHIVED, member('u', 'owner'), mine)).toBe(true)
    expect(canHideLogComment({ userId: 'u' }, ARCHIVED, member('u', 'owner'), mine)).toBe(true)
  })

  it('only the author edits (while published and still allowed to write) and deletes (any role, not twice)', () => {
    const c = { authorId: 'a', status: 'published' as const }
    expect(canEditLogComment({ userId: 'a' }, P, member('a', 'reviewer'), c)).toBe(true)
    expect(canEditLogComment({ userId: 'a' }, P, member('a', 'viewer'), c)).toBe(false)
    expect(canEditLogComment({ userId: 'a' }, P, member('a', 'editor'), { ...c, status: 'hidden' })).toBe(false)
    expect(canEditLogComment({ userId: 'o' }, P, member('o', 'owner'), c)).toBe(false)
    expect(canDeleteLogComment({ userId: 'a' }, P, member('a', 'viewer'), c)).toBe(true)
    expect(canDeleteLogComment({ userId: 'a' }, P, member('a', 'viewer'), { ...c, status: 'hidden' })).toBe(true)
    expect(canDeleteLogComment({ userId: 'a' }, P, member('a', 'viewer'), { ...c, status: 'deleted' })).toBe(false)
    expect(canDeleteLogComment({ userId: 'o' }, P, member('o', 'owner'), c)).toBe(false)
  })

  it('only the owner hides or unhides; deleted comments are not targets', () => {
    const c = { authorId: 'a', status: 'published' as const }
    expect(canHideLogComment({ userId: 'o' }, P, member('o', 'owner'), c)).toBe(true)
    expect(canHideLogComment({ userId: 'o' }, P, member('o', 'owner'), { ...c, status: 'hidden' })).toBe(true)
    expect(canHideLogComment({ userId: 'o' }, P, member('o', 'owner'), { ...c, status: 'deleted' })).toBe(false)
    expect(canHideLogComment({ userId: 'e' }, P, member('e', 'editor'), c)).toBe(false)
  })

  it('hidden bodies are visible to the author and the owner only; deleted bodies to nobody', () => {
    const hidden = { authorId: 'a', status: 'hidden' as const }
    expect(canSeeLogCommentBody({ userId: 'a' }, member('a', 'editor'), hidden)).toBe(true)
    expect(canSeeLogCommentBody({ userId: 'o' }, member('o', 'owner'), hidden)).toBe(true)
    expect(canSeeLogCommentBody({ userId: 'e' }, member('e', 'editor'), hidden)).toBe(false)
    expect(canSeeLogCommentBody({ userId: 'a' }, member('a', 'owner'), { authorId: 'a', status: 'deleted' })).toBe(false)
    expect(canSeeLogCommentBody({ userId: 'e' }, member('e', 'viewer'), { authorId: 'a', status: 'published' })).toBe(true)
  })
})
