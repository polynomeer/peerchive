/**
 * C-07 도메인 규칙(ADR 0024): 올리기·보기·지원 자격, 모집 인원, 상태 전이, 지원 순서(시각만), 알림 payload, 분석 허용 목록.
 */
import { describe, expect, it } from 'vitest'
import {
  type CommunityViewer,
  type RecruitmentFacts,
  type SpaceFacts,
  ACTIONS_BY_TARGET,
  APPLICATION_STATUS_TEXT,
  RECRUITER_APPLICATION_KEYS,
  RECRUITMENT_NOT_SELECTED_TEXT,
  applicationTransition,
  canAcceptMore,
  canApply,
  canPostRecruitment,
  canViewRecruitment,
  checkClosesAt,
  checkOptionalText,
  checkRecruitmentCapacity,
  checkRecruitmentTitle,
  isRecruitmentAccepting,
  orderApplications,
  recruitmentNoticeText,
  recruitmentOutcome,
  recruitmentTransition,
  reportTargetKey,
  roomNameModeFor,
  sanitizeAnalyticsProps,
  sanitizeRecruitmentNoticePayload,
  studyRoomNameFor,
} from '../src/index'

const NOW = new Date('2026-11-05T09:00:00Z')
const S1 = '00000000-0000-4000-8000-000000000001'
const S2 = '00000000-0000-4000-8000-000000000002'

const viewer = (over: Partial<CommunityViewer> = {}): CommunityViewer => ({
  userId: 'u1',
  status: 'active',
  operator: false,
  affiliations: [{ schoolId: S1, departmentKey: null }],
  communityWriteSuspended: false,
  ...over,
})
const official: SpaceFacts = { kind: 'official_school', schoolId: S1, departmentKey: null, discovery: 'listed', joinPolicy: 'open', status: 'active', capacity: 300, activeMembers: 0 }
const room: SpaceFacts = { kind: 'user_room', schoolId: S1, departmentKey: null, discovery: 'listed', joinPolicy: 'open', status: 'active', capacity: 300, activeMembers: 3 }
const board = { kind: 'recruiting' as const, writeRole: 'member' as const }

const facts = (over: Partial<RecruitmentFacts> = {}): RecruitmentFacts => ({
  host: null,
  courseSchoolId: S1,
  kind: 'study',
  createdBy: 'owner',
  status: 'open',
  closesAt: null,
  hidden: false,
  teamFindingDisabled: false,
  ...over,
})

describe('C-07 posting eligibility', () => {
  const post = (v: CommunityViewer, over: Partial<Parameters<typeof canPostRecruitment>[1]> = {}) =>
    canPostRecruitment(v, { host: null, courseSchoolId: S1, kind: 'team', hasCourse: true, teamFindingDisabled: false, recruitingBoard: null, ...over })

  it('course context needs a verified affiliation with the (canonical) course school', () => {
    expect(post(viewer())).toEqual({ ok: true })
    expect(post(viewer({ affiliations: [{ schoolId: S2, departmentKey: null }] }))).toEqual({ ok: false, reason: 'affiliation_required' })
    expect(post(viewer({ affiliations: [] }))).toEqual({ ok: false, reason: 'affiliation_required' })
    expect(post(viewer({ status: 'suspended' }))).toEqual({ ok: false, reason: 'not_found' })
  })

  it('team kind requires a course and is blocked when the course disabled team finding; study is not', () => {
    expect(post(viewer(), { hasCourse: false, courseSchoolId: null, host: { space: official, membership: null }, recruitingBoard: board })).toEqual({ ok: false, reason: 'course_required' })
    expect(post(viewer(), { teamFindingDisabled: true })).toEqual({ ok: false, reason: 'team_finding_disabled' })
    expect(post(viewer(), { kind: 'study', teamFindingDisabled: true })).toEqual({ ok: true })
    expect(post(viewer(), { kind: 'study', hasCourse: false, courseSchoolId: null })).toEqual({ ok: false, reason: 'host_required' })
  })

  it('space context follows the space read/write policy and needs a recruiting board', () => {
    const inOfficial = { host: { space: official, membership: null }, hasCourse: false, courseSchoolId: null, kind: 'study' as const }
    expect(post(viewer(), { ...inOfficial, recruitingBoard: board })).toEqual({ ok: true })
    expect(post(viewer(), { ...inOfficial, recruitingBoard: null })).toEqual({ ok: false, reason: 'no_recruiting_board' })
    // 다른 학교: 공식 페이지를 읽을 수 없음 → 404
    expect(post(viewer({ affiliations: [{ schoolId: S2, departmentKey: null }] }), { ...inOfficial, recruitingBoard: board })).toEqual({ ok: false, reason: 'not_found' })
    // 방: 멤버만 읽고 씀
    const inRoom = { host: { space: room, membership: null }, hasCourse: false, courseSchoolId: null, kind: 'study' as const, recruitingBoard: board }
    expect(post(viewer(), inRoom)).toEqual({ ok: false, reason: 'not_found' })
    expect(post(viewer(), { ...inRoom, host: { space: room, membership: { role: 'member', status: 'active' } } })).toEqual({ ok: true })
    // 모더레이터 전용 모집 게시판
    expect(post(viewer(), { ...inRoom, host: { space: room, membership: { role: 'member', status: 'active' } }, recruitingBoard: { kind: 'recruiting', writeRole: 'moderator' } })).toEqual({
      ok: false,
      reason: 'write_not_allowed',
    })
  })

  it('a community write restriction (sanction) blocks posting', () => {
    expect(post(viewer({ communityWriteSuspended: true }))).toEqual({ ok: false, reason: 'write_restricted' })
  })
})

describe('C-07 visibility and applying', () => {
  it('readers of the host only; hidden or team-finding-disabled team posts are visible to the recruiter only', () => {
    expect(canViewRecruitment(viewer(), facts())).toBe(true)
    expect(canViewRecruitment(viewer({ affiliations: [{ schoolId: S2, departmentKey: null }] }), facts())).toBe(false)
    expect(canViewRecruitment(viewer(), facts({ hidden: true }))).toBe(false)
    expect(canViewRecruitment(viewer({ userId: 'owner' }), facts({ hidden: true }))).toBe(true)
    expect(canViewRecruitment(viewer(), facts({ kind: 'team', teamFindingDisabled: true }))).toBe(false)
    expect(canViewRecruitment(viewer(), facts({ kind: 'study', teamFindingDisabled: true }))).toBe(true)
    // 방에 올린 모집: 방 멤버만
    expect(canViewRecruitment(viewer(), facts({ host: { space: room, membership: null } }))).toBe(false)
    expect(canViewRecruitment(viewer(), facts({ host: { space: room, membership: { role: 'member', status: 'active' } } }))).toBe(true)
    // 인증이 해제된 모집자도 자기 모집을 못 봄(C-05와 같음)
    expect(canViewRecruitment(viewer({ userId: 'owner', affiliations: [] }), facts())).toBe(false)
  })

  it('apply: not own, open and before closes_at, once, not sanctioned', () => {
    expect(canApply(viewer(), facts(), null, NOW)).toEqual({ ok: true })
    expect(canApply(viewer({ userId: 'owner' }), facts(), null, NOW)).toEqual({ ok: false, reason: 'own_recruitment' })
    expect(canApply(viewer(), facts({ status: 'closed' }), null, NOW)).toEqual({ ok: false, reason: 'recruitment_not_open' })
    expect(canApply(viewer(), facts({ closesAt: new Date(NOW.getTime() - 1) }), null, NOW)).toEqual({ ok: false, reason: 'recruitment_not_open' })
    expect(canApply(viewer(), facts(), { status: 'withdrawn' }, NOW)).toEqual({ ok: false, reason: 'already_applied' })
    expect(canApply(viewer({ communityWriteSuspended: true }), facts(), null, NOW)).toEqual({ ok: false, reason: 'write_restricted' })
    expect(canApply(viewer(), facts({ hidden: true }), null, NOW)).toEqual({ ok: false, reason: 'not_found' })
    expect(isRecruitmentAccepting({ status: 'open', closesAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(true)
  })
})

describe('C-07 capacity, transitions and ordering', () => {
  it('accepts up to capacity', () => {
    expect(canAcceptMore(0, 2)).toBe(true)
    expect(canAcceptMore(1, 2)).toBe(true)
    expect(canAcceptMore(2, 2)).toBe(false)
  })

  it('application transitions', () => {
    expect(applicationTransition('pending', 'accept')).toBe('accepted')
    expect(applicationTransition('accepted', 'accept')).toBeNull()
    expect(applicationTransition('declined', 'accept')).toBeNull()
    expect(applicationTransition('pending', 'decline')).toBe('declined')
    expect(applicationTransition('accepted', 'decline')).toBe('declined')
    expect(applicationTransition('withdrawn', 'decline')).toBeNull()
    expect(applicationTransition('accepted', 'withdraw')).toBe('withdrawn')
    expect(applicationTransition('declined', 'withdraw')).toBeNull()
  })

  it('recruitment transitions: close needs an accepted applicant, both only from open', () => {
    expect(recruitmentTransition('open', 'close', 0)).toEqual({ ok: false, reason: 'no_accepted' })
    expect(recruitmentTransition('open', 'close', 1)).toEqual({ ok: true, status: 'closed' })
    expect(recruitmentTransition('open', 'cancel', 0)).toEqual({ ok: true, status: 'cancelled' })
    expect(recruitmentTransition('closed', 'cancel', 0)).toEqual({ ok: false, reason: 'recruitment_not_open' })
    expect(recruitmentTransition('cancelled', 'close', 3)).toEqual({ ok: false, reason: 'recruitment_not_open' })
    expect(recruitmentOutcome('team', 'closed')).toBe('project')
    expect(recruitmentOutcome('study', 'closed')).toBe('study_room')
    expect(recruitmentOutcome('study', 'cancelled')).toBe('cancelled')
    expect(recruitmentOutcome('study', 'open')).toBeNull()
  })

  it('orders applications by application time only (then id), never by any other signal', () => {
    const rows = [
      { id: 'c', createdAt: new Date('2026-11-01T10:00:00Z'), forks: 99, endorsements: 50 },
      { id: 'b', createdAt: new Date('2026-11-01T09:00:00Z'), forks: 0, endorsements: 0 },
      { id: 'a', createdAt: new Date('2026-11-01T10:00:00Z'), forks: 1, endorsements: 1 },
    ]
    expect(orderApplications(rows).map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a'])
    // 모집자 DTO 키에 순위·활동량·거절 사유가 없음
    for (const k of RECRUITER_APPLICATION_KEYS) expect(k).not.toMatch(/rank|score|fork|endorse|activity|count|reason/i)
  })
})

describe('C-07 input', () => {
  it('title, description, capacity, closes_at, room name mode', () => {
    expect(checkRecruitmentTitle('  운영체제   스터디 ')).toEqual({ ok: true, value: '운영체제 스터디' })
    expect(checkRecruitmentTitle('')).toEqual({ ok: false, reason: 'required' })
    expect(checkRecruitmentTitle('가'.repeat(81))).toEqual({ ok: false, reason: 'too_long' })
    expect(checkOptionalText(undefined, 10)).toEqual({ ok: true, value: '' })
    expect(checkOptionalText('a\u0000', 10)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkOptionalText('가'.repeat(11), 10)).toEqual({ ok: false, reason: 'too_long' })
    expect(checkRecruitmentCapacity(1)).toEqual({ ok: false, reason: 'too_small' })
    expect(checkRecruitmentCapacity(21)).toEqual({ ok: false, reason: 'too_large' })
    expect(checkRecruitmentCapacity(2.5)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkRecruitmentCapacity(20)).toEqual({ ok: true, value: 20 })
    expect(checkClosesAt(undefined, NOW)).toEqual({ ok: true, value: null })
    expect(checkClosesAt('2026-11-01T00:00:00Z', NOW)).toEqual({ ok: false, reason: 'past' })
    expect(checkClosesAt('2027-06-01T00:00:00Z', NOW)).toEqual({ ok: false, reason: 'too_far' })
    expect(roomNameModeFor('study', undefined)).toEqual({ ok: true, value: 'display' })
    expect(roomNameModeFor('study', 'anonymous')).toEqual({ ok: true, value: 'anonymous' })
    expect(roomNameModeFor('team', 'display')).toEqual({ ok: false, reason: 'not_allowed' })
    expect(studyRoomNameFor('운영자 스터디')).toEqual({ ok: false, reason: 'reserved' })
    expect(studyRoomNameFor('가'.repeat(80))).toMatchObject({ ok: true, value: '가'.repeat(40) })
  })
})

describe('C-07 notices, moderation targets and analytics', () => {
  it('notice payloads carry the kind only; declining never carries a reason', () => {
    expect(sanitizeRecruitmentNoticePayload({ recruitmentKind: 'team' })).toEqual({ recruitmentKind: 'team' })
    expect(sanitizeRecruitmentNoticePayload({ recruitmentKind: 'team', reason: '실력 부족' })).toBeNull()
    expect(sanitizeRecruitmentNoticePayload({ title: '모집' })).toBeNull()
    expect(recruitmentNoticeText('recruitment_not_selected', { recruitmentKind: 'study' })).toBe(RECRUITMENT_NOT_SELECTED_TEXT)
    expect(APPLICATION_STATUS_TEXT.declined).toBe('모집이 마감되었거나 선정되지 않았습니다.')
  })

  it('recruitments and applications are report targets with their own hide actions', () => {
    expect(ACTIONS_BY_TARGET.community_recruitment).toEqual(['none', 'hide_recruitment'])
    expect(ACTIONS_BY_TARGET.community_application).toEqual(['none', 'hide_application'])
    expect(reportTargetKey({ type: 'community_recruitment', recruitmentId: 'x' })).toBe('community_recruitment:x')
  })

  it('analytics carry the kind and the outcome only', () => {
    expect(sanitizeAnalyticsProps('recruitment_created', { kind: 'team' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('application_submitted', { kind: 'study' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('recruitment_closed', { kind: 'study', outcome: 'study_room' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('recruitment_closed', { kind: 'study', outcome: 'study_room', applicants: 3 }).ok).toBe(false)
    expect(sanitizeAnalyticsProps('recruitment_created', { kind: 'team', courseId: S1 }).ok).toBe(false)
    expect(sanitizeAnalyticsProps('project_created', { origin: 'recruitment' }).ok).toBe(true)
  })
})
