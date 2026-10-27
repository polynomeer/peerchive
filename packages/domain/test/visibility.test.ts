import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_VIEWER,
  AUDIENCE_RANK,
  VISIBILITY_AUDIENCES,
  VISIBILITY_ITEM_KINDS,
  type PersonaFacts,
  type PersonaViewer,
  type VisibilityAudience,
  canViewPersona,
  canViewPersonaItem,
  defaultAudience,
  effectiveAudience,
  isAllowedAudience,
  isVisibilityItemKind,
  listingBlock,
  viewerCloseness,
} from '../src'

const viewer = (over: Partial<PersonaViewer> = {}): PersonaViewer => ({ ...ANONYMOUS_VIEWER, ...over })
const VIEWERS: Record<string, PersonaViewer> = {
  anonymous: viewer(),
  signedIn: viewer({ signedIn: true }),
  sameInstitution: viewer({ signedIn: true, sameInstitution: true }),
  approvedFollower: viewer({ signedIn: true, approvedFollower: true }),
  owner: viewer({ isOwner: true, signedIn: true }),
}
const PUBLIC: PersonaFacts = { status: 'active', accountPrivacy: 'public' }
const PRIVATE: PersonaFacts = { status: 'active', accountPrivacy: 'private' }

/** §8.3 표: 열(보는 사람) × audience → 볼 수 있는지(공개 계정). */
const EXPECTED: Record<string, Record<VisibilityAudience, boolean>> = {
  anonymous: { public: true, signed_in: false, same_institution: false, approved_followers: false, private: false },
  signedIn: { public: true, signed_in: true, same_institution: false, approved_followers: false, private: false },
  sameInstitution: { public: true, signed_in: true, same_institution: true, approved_followers: false, private: false },
  approvedFollower: { public: true, signed_in: true, same_institution: true, approved_followers: true, private: false },
  owner: { public: true, signed_in: true, same_institution: true, approved_followers: true, private: true },
}

describe('항목 이름·audience 검사 (S-03)', () => {
  it('공개 범위 항목은 넷뿐이고 공개 사례·케이스 스터디는 항목이 아니다', () => {
    expect(VISIBILITY_ITEM_KINDS).toEqual(['project_list', 'posts', 'notes_and_studies', 'follow_lists'])
    for (const k of VISIBILITY_ITEM_KINDS) expect(isVisibilityItemKind(k)).toBe(true)
    for (const k of ['cases', 'case_studies', 'publications', 'portfolio', '', null, 1]) expect(isVisibilityItemKind(k), String(k)).toBe(false)
  })

  it('follow_lists는 public·private만, 나머지는 다섯 단계 모두', () => {
    for (const a of VISIBILITY_AUDIENCES) {
      expect(isAllowedAudience('follow_lists', a), a).toBe(a === 'public' || a === 'private')
      for (const k of ['project_list', 'posts', 'notes_and_studies'] as const) expect(isAllowedAudience(k, a)).toBe(true)
    }
    expect(isAllowedAudience('posts', 'everyone')).toBe(false)
    expect(isAllowedAudience('posts', undefined)).toBe(false)
  })
})

describe('기본값·비공개 계정 좁힘', () => {
  it('기본값: project_list는 private, 글·노트는 공개 계정 signed_in / 비공개 계정 approved_followers, 팔로우 목록은 private', () => {
    expect(defaultAudience('project_list', 'public')).toBe('private')
    expect(defaultAudience('project_list', 'private')).toBe('private')
    expect(defaultAudience('posts', 'public')).toBe('signed_in')
    expect(defaultAudience('notes_and_studies', 'public')).toBe('signed_in')
    expect(defaultAudience('posts', 'private')).toBe('approved_followers')
    expect(defaultAudience('notes_and_studies', 'private')).toBe('approved_followers')
    expect(defaultAudience('follow_lists', 'public')).toBe('private')
    for (const k of VISIBILITY_ITEM_KINDS) for (const p of ['public', 'private'] as const) expect(isAllowedAudience(k, defaultAudience(k, p))).toBe(true)
  })

  it('비공개 계정은 저장 값이 넓어도 approved_followers 이하로 좁혀 적용하고, 더 좁은 값은 그대로 둔다', () => {
    for (const a of ['public', 'signed_in', 'same_institution'] as const) expect(effectiveAudience('posts', a, 'private')).toBe('approved_followers')
    expect(effectiveAudience('posts', 'approved_followers', 'private')).toBe('approved_followers')
    expect(effectiveAudience('posts', 'private', 'private')).toBe('private')
    expect(effectiveAudience('follow_lists', 'public', 'private')).toBe('approved_followers')
    expect(effectiveAudience('posts', 'public', 'public')).toBe('public')
    expect(effectiveAudience('posts', null, 'public')).toBe('signed_in')
  })
})

describe('canViewPersonaItem 행렬(§8.3 과제 수행 목록·공개 글·선배 노트·스터디 기록 줄)', () => {
  for (const [name, v] of Object.entries(VIEWERS)) {
    it(`공개 계정 × ${name}`, () => {
      for (const kind of ['project_list', 'posts', 'notes_and_studies'] as const)
        for (const a of VISIBILITY_AUDIENCES) expect(canViewPersonaItem(PUBLIC, kind, a, v), `${kind}/${a}`).toBe(EXPECTED[name]![a])
      expect(canViewPersonaItem(PUBLIC, 'follow_lists', 'public', v)).toBe(true)
      expect(canViewPersonaItem(PUBLIC, 'follow_lists', 'private', v)).toBe(name === 'owner')
    })
  }

  it('비공개 계정: 전체 공개로 저장해도 비로그인·로그인·같은 기관은 못 보고, 승인된 팔로워와 본인만 본다', () => {
    for (const kind of VISIBILITY_ITEM_KINDS) {
      expect(canViewPersonaItem(PRIVATE, kind, 'public', VIEWERS.anonymous!)).toBe(false)
      expect(canViewPersonaItem(PRIVATE, kind, 'public', VIEWERS.signedIn!)).toBe(false)
      expect(canViewPersonaItem(PRIVATE, kind, 'public', VIEWERS.sameInstitution!)).toBe(false)
      expect(canViewPersonaItem(PRIVATE, kind, 'public', VIEWERS.approvedFollower!)).toBe(true)
      expect(canViewPersonaItem(PRIVATE, kind, 'public', VIEWERS.owner!)).toBe(true)
    }
  })

  it('행이 없으면 기본값: 과제 수행 목록은 본인만, 글은 로그인 사용자부터', () => {
    expect(canViewPersonaItem(PUBLIC, 'project_list', null, VIEWERS.signedIn!)).toBe(false)
    expect(canViewPersonaItem(PUBLIC, 'project_list', null, VIEWERS.owner!)).toBe(true)
    expect(canViewPersonaItem(PUBLIC, 'posts', null, VIEWERS.anonymous!)).toBe(false)
    expect(canViewPersonaItem(PUBLIC, 'posts', null, VIEWERS.signedIn!)).toBe(true)
  })

  it('비활성 페르소나·차단은 항목도 기본 정보도 막고, 본인은 차단과 무관하다', () => {
    const off: PersonaFacts = { status: 'deactivated', accountPrivacy: 'public' }
    expect(canViewPersona(off, VIEWERS.owner!)).toBe(false)
    expect(canViewPersonaItem(off, 'posts', 'public', VIEWERS.anonymous!)).toBe(false)
    const blocked = viewer({ signedIn: true, sameInstitution: true, approvedFollower: true, blocked: true })
    expect(canViewPersona(PUBLIC, blocked)).toBe(false)
    expect(canViewPersonaItem(PUBLIC, 'posts', 'public', blocked)).toBe(false)
    expect(canViewPersona(PUBLIC, VIEWERS.anonymous!)).toBe(true)
    expect(canViewPersona(PRIVATE, VIEWERS.anonymous!)).toBe(true)
  })

  it('가까움은 겹치는 열 중 가장 가까운 것(비로그인 표시는 다른 플래그를 무시)', () => {
    expect(viewerCloseness(viewer({ sameInstitution: true, approvedFollower: true }))).toBe(AUDIENCE_RANK.public)
    expect(viewerCloseness(viewer({ signedIn: true, sameInstitution: true, approvedFollower: true }))).toBe(AUDIENCE_RANK.approved_followers)
    expect(viewerCloseness(VIEWERS.owner!)).toBe(AUDIENCE_RANK.private)
  })
})

describe('listingBlock (과제 수행 목록에 올릴 수 있는 과제)', () => {
  const team = { kind: 'team' as const, studyNameMode: null, membershipStatus: 'active' as const }
  it('실명 페르소나의 active 멤버만', () => {
    expect(listingBlock('real', team)).toBeNull()
    expect(listingBlock('display', team)).toBe('display_persona')
    for (const s of ['invited', 'left', 'removed'] as const) expect(listingBlock('real', { ...team, membershipStatus: s })).toBe('not_member')
  })
  it('스터디 기록은 실명 방만: 익명 방·표시명 방의 과제는 불가', () => {
    expect(listingBlock('real', { kind: 'study', studyNameMode: 'real', membershipStatus: 'active' })).toBeNull()
    expect(listingBlock('real', { kind: 'study', studyNameMode: 'anonymous', membershipStatus: 'active' })).toBe('anonymous_study')
    expect(listingBlock('real', { kind: 'study', studyNameMode: 'display', membershipStatus: 'active' })).toBe('display_study')
  })
})
