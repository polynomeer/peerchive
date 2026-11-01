import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_TARGET,
  ANALYTICS_PROP_SPECS,
  type AnalyticsEventRow,
  CERTIFICATE_SLA_DEFAULT_HOURS,
  P2_EVENT_NAMES,
  ROOM_ITEM_KINDS,
  type P2MetricsInput,
  certificateSlaHours,
  computeP2Metrics,
  isActionApplicable,
  percentile,
  queueSla,
  reasonApplicable,
  reportTargetKey,
  sanitizeAnalyticsProps,
  summarizeDecisionTimes,
} from '../src'

const HOUR = 60 * 60 * 1000
const T0 = new Date('2027-03-02T00:00:00Z')
const hex = (n: number) => n.toString(16).padStart(64, '0')

describe('A-07 room item reports', () => {
  it('room items have one reversible hide action and a kind-qualified target key', () => {
    expect(ACTIONS_BY_TARGET.room_item).toEqual(['none', 'hide_room_item'])
    expect(isActionApplicable('room_item', 'hide_retro')).toBe(false)
    expect(reportTargetKey({ type: 'room_item', kind: 'event', itemId: 'abc' })).toBe('room_item:event:abc')
    expect(ROOM_ITEM_KINDS).toEqual(['directory_entry', 'event', 'poll', 'album_photo', 'room_profile'])
  })

  it('affiliation impersonation applies to posts, comments, retros and to directory entries and room profiles only', () => {
    for (const t of ['community_post', 'community_comment', 'completion_retro'] as const) expect(reasonApplicable(t, 'affiliation_impersonation')).toBe(true)
    expect(reasonApplicable('room_item', 'affiliation_impersonation', 'directory_entry')).toBe(true)
    expect(reasonApplicable('room_item', 'affiliation_impersonation', 'room_profile')).toBe(true)
    for (const k of ['event', 'poll', 'album_photo'] as const) expect(reasonApplicable('room_item', 'affiliation_impersonation', k)).toBe(false)
    expect(reasonApplicable('room_item', 'affiliation_impersonation')).toBe(false)
    expect(reasonApplicable('persona', 'affiliation_impersonation')).toBe(false)
    // 기존 규칙 그대로: 표시명 사칭은 프로필에만, 그 밖의 사유는 어디든.
    expect(reasonApplicable('room_item', 'impersonation', 'room_profile')).toBe(false)
    expect(reasonApplicable('room_item', 'spam', 'event')).toBe(true)
  })
})

describe('A-07 P2 events allowlist', () => {
  it('has no slot for ids, names or persona values and rounds the right events', () => {
    expect(P2_EVENT_NAMES).toHaveLength(6)
    for (const name of P2_EVENT_NAMES) {
      const keys = Object.keys(ANALYTICS_PROP_SPECS[name])
      for (const k of keys) expect(k).not.toMatch(/id|handle|persona|name|slug|space|school|institution|cohortLabel|title/i)
      expect(sanitizeAnalyticsProps(name, { personaId: 'x' }).ok).toBe(false)
      expect(sanitizeAnalyticsProps(name, { spaceId: 'x' }).ok).toBe(false)
    }
    expect(sanitizeAnalyticsProps('topic_post_created', { labelScope: 'institution_kind', broadened: true }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('affiliation_verified', { standing: 'alumni', method: 'certificate_check' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('affiliation_verified', { method: 'sms' }).ok).toBe(false)
    expect(sanitizeAnalyticsProps('directory_consent_changed', { consented: true, filled: 5 }).ok).toBe(false)
  })
})

describe('A-07 verification queue helpers', () => {
  it('certificate SLA defaults to 72h (§6.2 median 3 days) and accepts a valid override', () => {
    expect(CERTIFICATE_SLA_DEFAULT_HOURS).toBe(72)
    expect(certificateSlaHours({})).toBe(72)
    expect(certificateSlaHours({ PEERCHIVE_CERTIFICATE_SLA_HOURS: '48' })).toBe(48)
    expect(certificateSlaHours({ PEERCHIVE_CERTIFICATE_SLA_HOURS: 'x' })).toBe(72)
  })

  it('queue SLA states and no SLA for member-approved queues', () => {
    expect(queueSla(T0, new Date(T0.getTime() + 10 * HOUR), 72)!.state).toBe('ok')
    expect(queueSla(T0, new Date(T0.getTime() + 60 * HOUR), 72)!.state).toBe('due_soon')
    expect(queueSla(T0, new Date(T0.getTime() + 73 * HOUR), 72)!.state).toBe('overdue')
    expect(queueSla(T0, T0, null)).toBeNull()
  })

  it('median and p90 decision times are suppressed under 5 decisions', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9)
    const four = summarizeDecisionTimes([1, 2, 3, 4].map((h) => h * HOUR), 72)
    expect(four).toMatchObject({ decided: null, medianHours: null, p90Hours: null })
    const five = summarizeDecisionTimes([10, 20, 30, 40, 100].map((h) => h * HOUR), 72)
    expect(five).toMatchObject({ decided: 5, medianHours: 30, p90Hours: 100, medianTargetHours: 72 })
    expect(five.withinSla).toEqual({ numerator: null, denominator: 5, rate: null })
  })
})

describe('A-07 P2 metrics', () => {
  const event = (name: AnalyticsEventRow['name'], actor: number | null, props: Record<string, unknown> = {}): AnalyticsEventRow => ({
    name,
    occurredAt: T0,
    actorHash: actor === null ? null : hex(actor),
    projectHash: null,
    props,
  })
  const base = (): P2MetricsInput => ({
    flags: { alumni: true, topics: true, institutions: true },
    events: [],
    alumni: { rooms: 10, activeRooms: 6, rsvpResponders: 30, rsvpAudience: 100, directoryConsented: 40, directoryEligible: 80, reports: [] },
    topics: { answers: 50, movedToNotes: 5, impersonationReports: 1, impersonationConfirmed: 0 },
    institutions: {
      verifiedByMethod: { invite_code: 20, cohort_approval: 3, certificate_check: 6 },
      certificateDecisionMs: [1, 2, 3, 4, 5, 6].map((h) => h * 24 * HOUR),
      certificateSlaHours: 72,
      revokedByOperator: 0,
      impersonationReports: 0,
      impersonationConfirmed: 0,
    },
  })

  it('hides a section when its area flag is off', () => {
    const m = computeP2Metrics({ ...base(), flags: { alumni: false, topics: true, institutions: false } })
    expect(m.alumni).toBeNull()
    expect(m.institutions).toBeNull()
    expect(m.topics).not.toBeNull()
  })

  it('counts alumni → senior note supply over keyed people only and suppresses cells under 5', () => {
    const events: AnalyticsEventRow[] = []
    for (let i = 0; i < 8; i++) events.push(event('rsvp_submitted', i, { response: 'going', changed: false }))
    // 키 없는(익명 방) 응답은 사람으로 세지 않습니다.
    for (let i = 0; i < 5; i++) events.push(event('rsvp_submitted', null, { response: 'going', changed: false }))
    for (let i = 0; i < 5; i++) events.push(event('senior_note_published', i, { displayMode: 'name', answers: 2 }))
    events.push(event('completion_retro_published', null, { displayMode: 'anonymous', labelScope: 'none', broadened: true }))
    const m = computeP2Metrics({ ...base(), events })
    expect(m.alumni!.alumniToNotes).toEqual({ numerator: 5, denominator: 8, rate: 0.625 })
    expect(m.alumni!.supply).toBe(6)
    expect(m.alumni!.events.rsvps).toBe(13)
    expect(m.alumni!.events.eventsCreated).toBeNull()
    expect(m.alumni!.activeRooms.rate).toBe(0.6)
    expect(m.topics!.topicToNote).toEqual({ numerator: 5, denominator: 50, rate: 0.1 })
    expect(m.topics!.impersonation.reports).toBeNull()
    expect(m.institutions!.verifiedByMethod).toEqual({ invite_code: 20, cohort_approval: null, certificate_check: 6 })
    expect(m.institutions!.certificate.medianHours).toBe(84)
    expect(m.institutions!.cohortRoomSupply).toBeNull()
  })

  it('topic broadening rate comes from topic_post_created events', () => {
    const events = [
      ...Array.from({ length: 6 }, () => event('topic_post_created', null, { labelScope: 'institution_kind', broadened: true })),
      ...Array.from({ length: 4 }, () => event('topic_post_created', null, { labelScope: 'institution', broadened: false })),
    ]
    const m = computeP2Metrics({ ...base(), events })
    expect(m.topics!.broadened).toEqual({ numerator: 6, denominator: 10, rate: 0.6 })
    expect(m.topics!.postsByScope).toEqual({ institution: null, institutionKind: 6, none: null })
  })
})
