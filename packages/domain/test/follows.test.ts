import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_VIEWER,
  type FollowFacts,
  type PersonaFacts,
  type PersonaViewer,
  blockHides,
  blockNeedsLinkConfirm,
  canFollow,
  canViewPersona,
  canViewPersonaItem,
  decideFollow,
  initialFollowStatus,
  showsFollowCounts,
} from '../src'

const PUBLIC: PersonaFacts = { status: 'active', accountPrivacy: 'public' }
const PRIVATE: PersonaFacts = { status: 'active', accountPrivacy: 'private' }
const facts = (over: Partial<FollowFacts> = {}): FollowFacts => ({
  signedIn: true,
  acting: { status: 'active' },
  target: PUBLIC,
  sameUser: false,
  targetHidden: false,
  blockedByActor: false,
  ...over,
})
const viewer = (over: Partial<PersonaViewer> = {}): PersonaViewer => ({ ...ANONYMOUS_VIEWER, ...over })

describe('canFollow / decideFollow (S-04, §8.3 팔로우 요청 줄)', () => {
  it('공개 계정은 바로 active, 비공개 계정은 pending', () => {
    expect(decideFollow(facts())).toEqual({ ok: true, status: 'active' })
    expect(decideFollow(facts({ target: PRIVATE }))).toEqual({ ok: true, status: 'pending' })
    expect(initialFollowStatus('public')).toBe('active')
    expect(initialFollowStatus('private')).toBe('pending')
  })

  it('비로그인은 불가', () => {
    expect(decideFollow(facts({ signedIn: false }))).toEqual({ ok: false, reason: 'signed_out' })
    expect(canFollow(facts({ signedIn: false }))).toBe(false)
  })

  it('자기 페르소나·같은 사용자의 다른 페르소나는 불가', () => {
    expect(decideFollow(facts({ sameUser: true }))).toEqual({ ok: false, reason: 'own_persona' })
  })

  it('대상이 비활성이거나 대상 주인이 나를 차단했으면 존재를 드러내지 않고 not_found', () => {
    expect(decideFollow(facts({ target: { ...PUBLIC, status: 'deactivated' } }))).toEqual({ ok: false, reason: 'not_found' })
    expect(decideFollow(facts({ targetHidden: true }))).toEqual({ ok: false, reason: 'not_found' })
    // 자기 페르소나 여부보다 먼저(차단당한 사람에게 "자기 것"이라는 정보도 주지 않음).
    expect(decideFollow(facts({ targetHidden: true, sameUser: true }))).toEqual({ ok: false, reason: 'not_found' })
  })

  it('주체 페르소나가 내 것이 아니거나 비활성이면 acting_persona', () => {
    expect(decideFollow(facts({ acting: null }))).toEqual({ ok: false, reason: 'acting_persona' })
    expect(decideFollow(facts({ acting: { status: 'deactivated' } }))).toEqual({ ok: false, reason: 'acting_persona' })
  })

  it('내가 바로 이 페르소나를 차단해 두었으면 blocked_by_you', () => {
    expect(decideFollow(facts({ blockedByActor: true }))).toEqual({ ok: false, reason: 'blocked_by_you' })
    expect(canFollow(facts({ blockedByActor: true }))).toBe(false)
  })
})

describe('승인된 팔로워 공개 범위·차단 404 (canViewPersonaItem + PersonaViewer)', () => {
  it('비공개 계정: 승인 전(로그인·같은 기관)에는 기본 정보만, 승인 뒤 approved_followers 항목', () => {
    const before = viewer({ signedIn: true, sameInstitution: true })
    const after = viewer({ signedIn: true, approvedFollower: true })
    expect(canViewPersona(PRIVATE, before)).toBe(true)
    for (const kind of ['project_list', 'posts', 'notes_and_studies'] as const) {
      expect(canViewPersonaItem(PRIVATE, kind, 'public', before), kind).toBe(false)
      expect(canViewPersonaItem(PRIVATE, kind, 'public', after), kind).toBe(true)
      expect(canViewPersonaItem(PRIVATE, kind, null, after), kind).toBe(kind !== 'project_list')
      expect(canViewPersonaItem(PRIVATE, kind, 'private', after), kind).toBe(false)
    }
    // 팔로우 목록: 비공개 계정은 public으로 저장해도 승인한 팔로워까지.
    expect(canViewPersonaItem(PRIVATE, 'follow_lists', 'public', before)).toBe(false)
    expect(canViewPersonaItem(PRIVATE, 'follow_lists', 'public', after)).toBe(true)
    expect(canViewPersonaItem(PUBLIC, 'follow_lists', 'public', ANONYMOUS_VIEWER)).toBe(true)
    expect(canViewPersonaItem(PUBLIC, 'follow_lists', null, after)).toBe(false)
  })

  it('공개 계정: 승인된 팔로워는 approved_followers 항목을 보고, 다른 학교여도 same_institution 항목을 봄', () => {
    const follower = viewer({ signedIn: true, approvedFollower: true })
    expect(canViewPersonaItem(PUBLIC, 'posts', 'approved_followers', follower)).toBe(true)
    expect(canViewPersonaItem(PUBLIC, 'posts', 'same_institution', follower)).toBe(true)
    expect(canViewPersonaItem(PUBLIC, 'posts', 'approved_followers', viewer({ signedIn: true, sameInstitution: true }))).toBe(false)
  })

  it('차단당한 사용자는 승인된 팔로워여도 기본 정보부터 404, 본인은 차단과 무관', () => {
    const blocked = viewer({ signedIn: true, approvedFollower: true, blocked: true })
    expect(canViewPersona(PUBLIC, blocked)).toBe(false)
    expect(canViewPersonaItem(PUBLIC, 'follow_lists', 'public', blocked)).toBe(false)
    expect(canViewPersonaItem(PUBLIC, 'posts', 'public', blocked)).toBe(false)
    expect(canViewPersona(PUBLIC, viewer({ isOwner: true, signedIn: true, blocked: true }))).toBe(true)
  })
})

describe('차단 범위·연결 추정 경고·팔로워 수 표시', () => {
  it('origin_persona는 그 페르소나만, all_personas는 모든 페르소나를 숨김', () => {
    expect(blockHides({ scope: 'origin_persona', originPersonaId: 'a' }, 'a')).toBe(true)
    expect(blockHides({ scope: 'origin_persona', originPersonaId: 'a' }, 'b')).toBe(false)
    expect(blockHides({ scope: 'all_personas', originPersonaId: 'a' }, 'b')).toBe(true)
  })

  it('all_personas는 다른 페르소나가 있고 연결이 비공개일 때만 확인 필요', () => {
    expect(blockNeedsLinkConfirm('all_personas', { hasOtherPersona: true, visible: false })).toBe(true)
    expect(blockNeedsLinkConfirm('all_personas', { hasOtherPersona: true, visible: true })).toBe(false)
    expect(blockNeedsLinkConfirm('all_personas', { hasOtherPersona: false, visible: false })).toBe(false)
    expect(blockNeedsLinkConfirm('origin_persona', { hasOtherPersona: true, visible: false })).toBe(false)
  })

  it('팔로워 수는 본인에게 늘, 다른 사람에게는 show_follower_count일 때만', () => {
    expect(showsFollowCounts({ showFollowerCount: false }, { isOwner: true })).toBe(true)
    expect(showsFollowCounts({ showFollowerCount: false }, { isOwner: false })).toBe(false)
    expect(showsFollowCounts({ showFollowerCount: true }, { isOwner: false })).toBe(true)
  })
})
