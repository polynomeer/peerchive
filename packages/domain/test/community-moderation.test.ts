/**
 * C-06 도메인 규칙(ADR 0023): 서로 다른 인증 신고자 기준 수, 제재 입력·효력·범위, 작성자 확인 권한, 알림 payload 허용 목록, 분석 허용 목록.
 */
import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_TARGET,
  AUTO_HIDE_THRESHOLDS,
  type CommunityViewer,
  type SanctionFacts,
  type SpaceFacts,
  activeWriteRestriction,
  autoHideThreshold,
  canCreateRoom,
  canReact,
  canResolveAuthor,
  canWriteBoard,
  checkSanctionInput,
  isSanctionActive,
  itemReviewNoticeText,
  parseAutoHideThreshold,
  qualifyingReporterCount,
  sanctionBlocksWrite,
  sanitizeAnalyticsProps,
  sanitizeItemReviewPayload,
  shouldAutoHide,
  writeRestrictionText,
} from '../src/index'

const NOW = new Date('2026-11-05T09:00:00Z')
const day = 24 * 60 * 60 * 1000
const after = (ms: number) => new Date(NOW.getTime() + ms)

const sanction = (over: Partial<SanctionFacts> = {}): SanctionFacts => ({ scope: 'community', spaceId: null, level: 'write_suspended', until: after(day), revokedAt: null, ...over })

describe('auto-hide threshold (distinct verified reporters)', () => {
  it('uses 5 for official pages and 3 for rooms (study rooms count as rooms), overridable', () => {
    expect(AUTO_HIDE_THRESHOLDS).toEqual({ official: 5, room: 3 })
    expect(autoHideThreshold('official_school')).toBe(5)
    expect(autoHideThreshold('official_department')).toBe(5)
    expect(autoHideThreshold('user_room')).toBe(3)
    expect(autoHideThreshold('study_room')).toBe(3)
    expect(autoHideThreshold('user_room', { official: 7, room: 4 })).toBe(4)
  })

  it('parses env overrides only as integers 2..50', () => {
    expect(parseAutoHideThreshold(undefined, 3)).toBe(3)
    expect(parseAutoHideThreshold('', 3)).toBe(3)
    expect(parseAutoHideThreshold('4', 3)).toBe(4)
    for (const bad of ['1', '0', '51', '3.5', 'abc', '-3']) expect(parseAutoHideThreshold(bad, 3), bad).toBe(3)
  })

  it('counts each eligible reporter once; excludes the author, closed reports and reporters without an active affiliation', () => {
    const eligible = new Set(['a', 'b', 'c', 'author'])
    const reports = [
      { reporterId: 'a', status: 'open' as const },
      { reporterId: 'a', status: 'in_review' as const },
      { reporterId: 'author', status: 'open' as const },
      { reporterId: 'x', status: 'open' as const },
      { reporterId: 'b', status: 'dismissed' as const },
      { reporterId: 'c', status: 'in_review' as const },
    ]
    expect(qualifyingReporterCount(reports, 'author', eligible)).toBe(2)
    expect(qualifyingReporterCount([], 'author', eligible)).toBe(0)
  })

  it('hides only published items that reach the threshold', () => {
    expect(shouldAutoHide({ status: 'published', qualifying: 2, threshold: 3 })).toBe(false)
    expect(shouldAutoHide({ status: 'published', qualifying: 3, threshold: 3 })).toBe(true)
    expect(shouldAutoHide({ status: 'published', qualifying: 9, threshold: 3 })).toBe(true)
    for (const status of ['hidden', 'auto_hidden', 'deleted_by_author']) expect(shouldAutoHide({ status, qualifying: 9, threshold: 3 })).toBe(false)
  })

  it('resolve/dismiss choices stay hide/none; space_hide and sanction are separate paths', () => {
    expect(ACTIONS_BY_TARGET.community_post).toEqual(['none', 'hide_post'])
    expect(ACTIONS_BY_TARGET.community_comment).toEqual(['none', 'hide_comment'])
    expect(Object.values(ACTIONS_BY_TARGET).flat()).not.toContain('sanction')
    expect(Object.values(ACTIONS_BY_TARGET).flat()).not.toContain('space_hide')
  })
})

describe('sanction input and effect', () => {
  it('validates level × scope × until', () => {
    expect(checkSanctionInput({ level: 'warning', scope: 'space', until: null }, NOW)).toEqual({ ok: true, until: null })
    expect(checkSanctionInput({ level: 'warning', scope: 'community', until: after(day) }, NOW)).toMatchObject({ ok: false, field: 'until', reason: 'not_allowed' })
    expect(checkSanctionInput({ level: 'write_suspended', scope: 'space', until: null }, NOW)).toMatchObject({ ok: false, reason: 'required' })
    expect(checkSanctionInput({ level: 'write_suspended', scope: 'space', until: NOW }, NOW)).toMatchObject({ ok: false, reason: 'in_past' })
    expect(checkSanctionInput({ level: 'write_suspended', scope: 'space', until: after(366 * day) }, NOW)).toMatchObject({ ok: false, reason: 'too_long' })
    expect(checkSanctionInput({ level: 'write_suspended', scope: 'community', until: after(7 * day) }, NOW)).toEqual({ ok: true, until: after(7 * day) })
    expect(checkSanctionInput({ level: 'permanent', scope: 'space', until: null }, NOW)).toMatchObject({ ok: false, field: 'scope', reason: 'community_only' })
    expect(checkSanctionInput({ level: 'permanent', scope: 'community', until: null }, NOW)).toEqual({ ok: true, until: null })
  })

  it('write_suspended expires at until; revoked sanctions never apply; warning never blocks', () => {
    expect(isSanctionActive(sanction(), NOW)).toBe(true)
    expect(isSanctionActive(sanction(), after(day))).toBe(false)
    expect(isSanctionActive(sanction({ revokedAt: NOW }), NOW)).toBe(false)
    expect(isSanctionActive(sanction({ level: 'permanent', until: null }), after(1000 * day))).toBe(true)
    expect(sanctionBlocksWrite(sanction({ level: 'warning', until: null }), 'space-1', NOW)).toBe(false)
  })

  it('space scope blocks only that space (and not out-of-space actions); community scope blocks everywhere', () => {
    const inSpace = sanction({ scope: 'space', spaceId: 'space-1' })
    expect(sanctionBlocksWrite(inSpace, 'space-1', NOW)).toBe(true)
    expect(sanctionBlocksWrite(inSpace, 'space-2', NOW)).toBe(false)
    expect(sanctionBlocksWrite(inSpace, null, NOW)).toBe(false)
    expect(sanctionBlocksWrite(sanction(), 'space-2', NOW)).toBe(true)
    expect(sanctionBlocksWrite(sanction(), null, NOW)).toBe(true)
  })

  it('merges blocking sanctions: permanent wins, else the latest end; community scope wins over space', () => {
    expect(activeWriteRestriction([], 'space-1', NOW)).toBeNull()
    expect(activeWriteRestriction([sanction({ level: 'warning', until: null })], 'space-1', NOW)).toBeNull()
    expect(activeWriteRestriction([sanction({ scope: 'space', spaceId: 'space-2' })], 'space-1', NOW)).toBeNull()
    expect(
      activeWriteRestriction([sanction({ scope: 'space', spaceId: 'space-1', until: after(3 * day) }), sanction({ until: after(day) })], 'space-1', NOW),
    ).toEqual({ level: 'write_suspended', scope: 'community', until: after(3 * day) })
    expect(activeWriteRestriction([sanction({ scope: 'space', spaceId: 'space-1' })], 'space-1', NOW)).toMatchObject({ scope: 'space' })
    expect(activeWriteRestriction([sanction(), sanction({ level: 'permanent', until: null })], 'space-1', NOW)).toEqual({ level: 'permanent', scope: 'community', until: null })
    expect(writeRestrictionText({ level: 'write_suspended', scope: 'space', until: after(day) })).toContain('이 공간에서')
  })

  it('community policy functions honor communityWriteSuspended (writes, reactions, room creation) and never reading', () => {
    const v = (over: Partial<CommunityViewer> = {}): CommunityViewer => ({ userId: 'u', status: 'active', operator: false, affiliations: [{ schoolId: 's1', departmentKey: null }], ...over })
    const room: SpaceFacts = { kind: 'user_room', schoolId: null, departmentKey: null, discovery: 'listed', joinPolicy: 'open', status: 'active', capacity: 300, activeMembers: 3 }
    const member = { role: 'member' as const, status: 'active' as const }
    const board = { kind: 'free' as const, writeRole: 'member' as const }
    expect(canWriteBoard(v(), room, member, board)).toBe(true)
    expect(canWriteBoard(v({ communityWriteSuspended: true }), room, member, board)).toBe(false)
    expect(canReact(v({ communityWriteSuspended: true }), room, member)).toBe(false)
    expect(canCreateRoom(v({ communityWriteSuspended: true }), null)).toBe(false)
    expect(canCreateRoom(v(), null)).toBe(true)
  })
})

describe('author lookup permission and notices', () => {
  it('only active operators can resolve authors (owners and moderators cannot)', () => {
    expect(canResolveAuthor({ status: 'active', operator: true })).toBe(true)
    expect(canResolveAuthor({ status: 'active', operator: false })).toBe(false)
    expect(canResolveAuthor({ status: 'suspended', operator: true })).toBe(false)
    expect(canResolveAuthor(null)).toBe(false)
  })

  it('auto-hide/restore notice payload is the target kind only', () => {
    expect(sanitizeItemReviewPayload({ target: 'post' })).toEqual({ target: 'post' })
    expect(sanitizeItemReviewPayload({ target: 'comment' })).toEqual({ target: 'comment' })
    for (const bad of [{}, { target: 'space' }, { target: 'post', reports: 3 }, { target: 'post', reporterId: 'x' }]) expect(sanitizeItemReviewPayload(bad)).toBeNull()
    expect(itemReviewNoticeText('item_auto_hidden', { target: 'post' })).toContain('운영 검토 중')
    expect(itemReviewNoticeText('item_restored', { target: 'comment' })).toContain('댓글')
  })

  it('analytics events carry only target kind / level / scope', () => {
    expect(sanitizeAnalyticsProps('community_report_filed', { targetKind: 'post' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('community_auto_hidden', { targetKind: 'comment' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('community_sanction_issued', { level: 'permanent', scope: 'community' }).ok).toBe(true)
    for (const leak of [{ postId: 'x' }, { reports: 3 }, { reason: 'spam' }, { targetKind: 'space', spaceId: 'x' }]) {
      expect(sanitizeAnalyticsProps('community_auto_hidden', leak).ok).toBe(false)
    }
    expect(sanitizeAnalyticsProps('community_sanction_issued', { level: 'ban' }).ok).toBe(false)
  })
})
