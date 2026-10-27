import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_PROP_SPECS,
  type AnalyticsEventName,
  type AnalyticsEventRow,
  type ProfileReportFact,
  SOCIAL_EVENT_TIME_BUCKET_MS,
  computeProfileMetrics,
  reasonApplicable,
  reportTargetKey,
  sanitizeAnalyticsProps,
  socialEventTime,
  ACTIONS_BY_TARGET,
} from '../src'

const T0 = new Date('2027-03-02T09:17:43.123Z')
const hex = (n: number) => n.toString(16).padStart(64, '0')
const ev = (name: AnalyticsEventName, actor: number | null, props: Record<string, unknown> = {}): AnalyticsEventRow => ({
  name,
  actorHash: actor === null ? null : hex(actor),
  occurredAt: T0,
  projectHash: null,
  props,
})
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1)
const BASE = { reports: [] as ProfileReportFact[], activeFollows: 0, personas: { real: 0, display: 0, followerCountShown: 0 }, ownerLookups: 0 }

describe('S-07 persona report targets and impersonation', () => {
  it('persona, profile post and social link are separate targets with their own hide action', () => {
    expect(ACTIONS_BY_TARGET.persona).toEqual(['none', 'hide_persona'])
    expect(ACTIONS_BY_TARGET.profile_post).toEqual(['none', 'hide_profile_post'])
    expect(ACTIONS_BY_TARGET.social_link).toEqual(['none', 'hide_social_link'])
    expect(reportTargetKey({ type: 'persona', personaId: 'p1' })).toBe('persona:p1')
    expect(reportTargetKey({ type: 'profile_post', profilePostId: 'x' })).toBe('profile_post:x')
    expect(reportTargetKey({ type: 'social_link', socialLinkId: 'l' })).toBe('social_link:l')
  })

  it('impersonation is a profile-only reason', () => {
    expect(reasonApplicable('persona', 'impersonation')).toBe(true)
    expect(reasonApplicable('profile', 'impersonation')).toBe(true)
    for (const t of ['profile_post', 'social_link', 'publication', 'community_post'] as const) expect(reasonApplicable(t, 'impersonation')).toBe(false)
    expect(reasonApplicable('social_link', 'spam')).toBe(true)
  })
})

describe('S-07 §6.2 analytics events', () => {
  it('carry codes only: no persona id, handle or counterpart key can be stored', () => {
    const social: AnalyticsEventName[] = [
      'persona_created',
      'identity_link_toggled',
      'visibility_changed',
      'project_listed',
      'follow_requested',
      'follow_approved',
      'follower_removed',
      'block_created',
      'mute_created',
      'feed_item_opened',
      'social_link_verified',
    ]
    for (const name of social) {
      for (const key of Object.keys(ANALYTICS_PROP_SPECS[name])) expect(key, `${name}.${key}`).not.toMatch(/(Id|Ids|Hash)$|^(id|hash)$|[Hh]andle|[Nn]ame|[Uu]rl|[Uu]ser|[Pp]ersona/)
      for (const leak of [{ personaId: crypto.randomUUID() }, { handle: 'd-abc' }, { targetUserHash: hex(1) }, { blockedPersonaId: 'x' }, { url: 'https://x.test' }]) {
        expect(sanitizeAnalyticsProps(name, leak).ok, `${name} ${JSON.stringify(leak)}`).toBe(false)
      }
    }
    expect(sanitizeAnalyticsProps('follow_requested', { targetKind: 'display', pending: true, origin: 'suggestion' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('feed_item_opened', { sourceType: 'community_post' }).ok).toBe(true)
  })

  it('social event time is truncated to the hour', () => {
    expect(SOCIAL_EVENT_TIME_BUCKET_MS).toBe(3_600_000)
    expect(socialEventTime(T0).toISOString()).toBe('2027-03-02T09:00:00.000Z')
  })
})

describe('S-07 profile metrics', () => {
  it('suppresses every cell below 5', () => {
    const m = computeProfileMetrics({
      ...BASE,
      events: [...range(4).map((a) => ev('feed_item_opened', a, { sourceType: 'senior_note' })), ev('usefulness_marked', 1, { kind: 'helped' })],
      activeFollows: 4,
      personas: { real: 3, display: 1, followerCountShown: 2 },
      ownerLookups: 2,
    })
    expect(m.feedUsers).toBeNull()
    expect(m.followToRecord).toEqual({ numerator: null, denominator: null, rate: null })
    expect(m.relationRemovals.activeFollows).toBeNull()
    expect(m.relationRemovals.per1000Follows).toBeNull()
    expect(m.followerCountShown.rate).toBeNull()
    expect(m.ownerLookups).toBeNull()
  })

  it('follow → record use counts feed users who also marked helped or forked; feed composition counts records', () => {
    const events = [
      ...range(10).map((a) => ev('feed_item_opened', a, { sourceType: a <= 6 ? 'publication_release' : 'profile_post' })),
      ...range(5).map((a) => ev('usefulness_marked', a, { kind: 'helped' })),
      ev('plan_forked', 6),
      ev('usefulness_marked', 99, { kind: 'helped' }), // 피드를 쓰지 않은 사람은 분자에 들지 않음
      ev('usefulness_marked', 7, { kind: 'me_too' }), // 나도 막힘은 기록 활용이 아님
      ev('feed_item_opened', null, { sourceType: 'senior_note' }), // 키 없는 이벤트는 사람으로 세지 않음
    ]
    const m = computeProfileMetrics({ ...BASE, events })
    expect(m.feedUsers).toBe(10)
    expect(m.followToRecord).toEqual({ numerator: 6, denominator: 10, rate: 0.6 })
    expect(m.feedComposition).toEqual({ numerator: 7, denominator: 11, rate: 0.636 })
  })

  it('display adoption, impersonation on display personas, removals per 1000 follows', () => {
    const events = [
      ...range(10).map((a) => ev('persona_created', a, { kind: 'real' })),
      ...range(5).map((a) => ev('persona_created', a, { kind: 'display' })),
      ...range(3).map((a) => ev('block_created', a, { scope: 'origin_persona' })),
      ...range(2).map((a) => ev('mute_created', a)),
      ev('follower_removed', 1),
      ...range(6).map((a) => ev('follow_requested', a, { targetKind: 'real', pending: a <= 5, origin: a <= 5 ? 'suggestion' : 'profile' })),
    ]
    const reports: ProfileReportFact[] = [
      ...range(6).map((i) => ({ targetType: 'persona' as const, reason: 'impersonation', personaKind: 'display' as const, confirmed: i <= 5 })),
      { targetType: 'persona', reason: 'impersonation', personaKind: 'real', confirmed: true },
      ...range(5).map(() => ({ targetType: 'social_link' as const, reason: 'spam', personaKind: 'display' as const, confirmed: false })),
    ]
    const m = computeProfileMetrics({ ...BASE, events, reports, activeFollows: 200, personas: { real: 8, display: 2, followerCountShown: 5 } })
    expect(m.displayAdoption).toEqual({ numerator: 5, denominator: 10, rate: 0.5 })
    expect(m.impersonation).toEqual({ reports: 6, confirmed: 5 })
    expect(m.reportsByTarget).toEqual({ persona: 7, profilePost: null, socialLink: 5, legacyProfile: null })
    expect(m.relationRemovals).toEqual({ blocks: null, mutes: null, followerRemovals: null, activeFollows: 200, per1000Follows: 30 })
    expect(m.follows).toEqual({ requested: 6, pending: 5, approved: null, fromSuggestions: 5 })
    expect(m.followerCountShown).toEqual({ numerator: 5, denominator: 10, rate: 0.5 })
  })
})
