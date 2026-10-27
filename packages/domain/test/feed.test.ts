import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_VIEWER,
  type PersonaViewer,
  type SuggestionCandidate,
  canViewActivityKind,
  compareFeedItems,
  decodeActivityCursor,
  decodeFeedCursor,
  encodeActivityCursor,
  encodeFeedCursor,
  feedDay,
  feedRankKey,
  normalizeProfilePostBody,
  rankSuggestions,
  suggestionReasons,
  suggestionScore,
} from '../src'

const PUBLIC = { status: 'active' as const, accountPrivacy: 'public' as const }
const PRIVATE = { status: 'active' as const, accountPrivacy: 'private' as const }
const signedIn: PersonaViewer = { ...ANONYMOUS_VIEWER, signedIn: true }
const follower: PersonaViewer = { ...signedIn, approvedFollower: true }
const owner: PersonaViewer = { ...ANONYMOUS_VIEWER, signedIn: true, isOwner: true }
const blocked: PersonaViewer = { ...signedIn, blocked: true }

describe('profile post body', () => {
  it('normalizes line breaks and blank lines, rejects empty and >500 code points', () => {
    expect(normalizeProfilePostBody('  안녕\r\n\r\n\r\n\r\n하세요  ')).toEqual({ ok: true, body: '안녕\n\n하세요' })
    expect(normalizeProfilePostBody('   ')).toEqual({ ok: false, reason: 'required' })
    expect(normalizeProfilePostBody(3)).toEqual({ ok: false, reason: 'required' })
    expect(normalizeProfilePostBody('가'.repeat(500))).toMatchObject({ ok: true })
    expect(normalizeProfilePostBody('가'.repeat(501))).toEqual({ ok: false, reason: 'too_long' })
    // 코드 포인트로 셉니다(이모지 하나 = 1자).
    expect(normalizeProfilePostBody('😀'.repeat(500))).toMatchObject({ ok: true })
  })
})

describe('canViewActivityKind', () => {
  it('posts and notes follow their audience; cases follow the publication procedure (private account: followers only)', () => {
    expect(canViewActivityKind(PUBLIC, 'posts', null, ANONYMOUS_VIEWER)).toBe(false) // 기본 signed_in
    expect(canViewActivityKind(PUBLIC, 'posts', null, signedIn)).toBe(true)
    expect(canViewActivityKind(PUBLIC, 'posts', 'public', ANONYMOUS_VIEWER)).toBe(true)
    expect(canViewActivityKind(PUBLIC, 'notes_and_studies', 'approved_followers', signedIn)).toBe(false)
    expect(canViewActivityKind(PUBLIC, 'notes_and_studies', 'approved_followers', follower)).toBe(true)
    expect(canViewActivityKind(PUBLIC, 'posts', 'private', follower)).toBe(false)
    expect(canViewActivityKind(PUBLIC, 'posts', 'private', owner)).toBe(true)
    // 공개 사례는 공개 범위 설정과 무관: 공개 계정이면 비로그인도.
    expect(canViewActivityKind(PUBLIC, 'cases', 'private', ANONYMOUS_VIEWER)).toBe(true)
    expect(canViewActivityKind(PRIVATE, 'cases', null, signedIn)).toBe(false)
    expect(canViewActivityKind(PRIVATE, 'cases', null, follower)).toBe(true)
    expect(canViewActivityKind(PRIVATE, 'posts', 'public', signedIn)).toBe(false) // 비공개 계정은 approved_followers로 좁힘
    expect(canViewActivityKind(PRIVATE, 'posts', 'public', follower)).toBe(true)
    for (const kind of ['cases', 'posts', 'notes_and_studies'] as const) {
      expect(canViewActivityKind(PUBLIC, kind, 'public', blocked), kind).toBe(false)
      expect(canViewActivityKind({ ...PUBLIC, status: 'deactivated' }, kind, 'public', follower), kind).toBe(false)
    }
  })
})

describe('feed ranking', () => {
  const at = (iso: string) => new Date(iso)
  it('newest KST day first, records before posts within a day, then recency, then id', () => {
    const items = [
      { id: '00000000-0000-4000-8000-000000000001', itemKind: 'posts' as const, createdAt: at('2026-11-10T14:00:00Z') }, // KST 11-10 23:00
      { id: '00000000-0000-4000-8000-000000000002', itemKind: 'cases' as const, createdAt: at('2026-11-10T01:00:00Z') }, // KST 11-10 10:00
      { id: '00000000-0000-4000-8000-000000000003', itemKind: 'posts' as const, createdAt: at('2026-11-10T16:00:00Z') }, // KST 11-11 01:00
      { id: '00000000-0000-4000-8000-000000000004', itemKind: 'notes_and_studies' as const, createdAt: at('2026-11-10T03:00:00Z') }, // KST 11-10 12:00
      { id: '00000000-0000-4000-8000-000000000005', itemKind: 'posts' as const, createdAt: at('2026-11-10T14:00:00Z') }, // 같은 시각
      { id: '00000000-0000-4000-8000-000000000006', itemKind: 'posts' as const, createdAt: at('2026-11-09T14:59:59Z') }, // KST 11-09 23:59
    ]
    const order = [...items].sort(compareFeedItems).map((i) => i.id.slice(-1))
    expect(order).toEqual(['3', '4', '2', '5', '1', '6'])
    expect(feedDay(at('2026-11-10T15:00:00Z'))).toBe(feedDay(at('2026-11-11T14:59:59Z')))
    expect(feedDay(at('2026-11-10T14:59:59Z'))).toBe(feedDay(at('2026-11-10T15:00:00Z')) - 1)
  })

  it('cursors round-trip and reject garbage', () => {
    const key = feedRankKey({ id: '00000000-0000-4000-8000-00000000000a', itemKind: 'cases', createdAt: new Date('2026-11-10T01:00:00.123Z') })
    expect(decodeFeedCursor(encodeFeedCursor(key))).toEqual(key)
    for (const bad of [undefined, '', 'x', '1.2.3.abc', `1.2.3.${key.id}`, `1.0.3.${key.id}x`]) expect(decodeFeedCursor(bad), String(bad)).toBeNull()
    const item = { id: key.id, createdAt: new Date('2026-11-10T01:00:00.123Z') }
    expect(decodeActivityCursor(encodeActivityCursor(item))).toEqual({ at: item.createdAt.getTime(), id: item.id })
    expect(decodeActivityCursor('1.nope')).toBeNull()
  })
})

describe('suggestions', () => {
  const cand = (personaId: string, ownerKey: string, s: Partial<SuggestionCandidate['signals']>, tieKey: string): SuggestionCandidate => ({
    personaId,
    ownerKey,
    signals: { sharedCourses: 0, sameInstitution: false, sharedJobTargets: 0, ...s },
    tieKey,
  })
  it('scores only intersections, drops zero, keeps one persona per owner, breaks ties by the per-viewer key (never by popularity)', () => {
    expect(suggestionScore({ sharedCourses: 0, sameInstitution: false, sharedJobTargets: 0 })).toBe(0)
    expect(suggestionScore({ sharedCourses: 5, sameInstitution: true, sharedJobTargets: 9 })).toBe(9 + 2 + 3)
    expect(suggestionReasons({ sharedCourses: 1, sameInstitution: false, sharedJobTargets: 2 })).toEqual(['course', 'job_target'])
    const ranked = rankSuggestions([
      cand('a', 'u1', { sharedJobTargets: 1 }, 'k9'),
      cand('b', 'u2', { sharedJobTargets: 1 }, 'k1'),
      cand('c', 'u3', { sharedCourses: 1 }, 'k5'),
      cand('d', 'u3', { sharedJobTargets: 1 }, 'k0'), // 같은 사람의 다른 페르소나: 점수 낮아 빠짐
      cand('e', 'u4', {}, 'k0'),
    ])
    expect(ranked.map((c) => c.personaId)).toEqual(['c', 'b', 'a'])
    expect(rankSuggestions([cand('a', 'u1', { sharedJobTargets: 1 }, 'k1'), cand('b', 'u2', { sharedJobTargets: 1 }, 'k2')], 1).map((c) => c.personaId)).toEqual(['a'])
    // 입력 순서를 바꿔도 결과가 같음(결정적).
    const input = [cand('x', 'u1', { sharedJobTargets: 2 }, 'b'), cand('y', 'u2', { sharedJobTargets: 2 }, 'a'), cand('z', 'u3', { sameInstitution: true }, 'c')]
    expect(rankSuggestions(input).map((c) => c.personaId)).toEqual(rankSuggestions([...input].reverse()).map((c) => c.personaId))
  })
})
