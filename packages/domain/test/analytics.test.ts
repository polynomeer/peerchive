import { describe, expect, it } from 'vitest'
import {
  ANALYTICS_EVENT_NAMES,
  ANALYTICS_PROP_SPECS,
  type AnalyticsEventName,
  type AnalyticsEventRow,
  computePilotMetrics,
  isAnalyticsEventName,
  sanitizeAnalyticsProps,
  suppressSmall,
} from '../src'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2027-03-02T00:00:00Z')
const at = (days: number) => new Date(T0.getTime() + days * DAY)
const hex = (n: number) => n.toString(16).padStart(64, '0')

describe('analytics allowlist', () => {
  it('covers the DELIVERY_PLAN §6 events plus login_succeeded, affiliation_verified the C-02·C-03 space events, the C-04 post events, the C-06 moderation events and the C-07 recruitment events', () => {
    expect(ANALYTICS_EVENT_NAMES).toHaveLength(33)
    expect(Object.keys(ANALYTICS_PROP_SPECS).sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort())
    expect(isAnalyticsEventName('log_saved')).toBe(true)
    expect(isAnalyticsEventName('page_view')).toBe(false)
  })

  it('has no free-text props: every string prop is a closed enum', () => {
    for (const specs of Object.values(ANALYTICS_PROP_SPECS)) {
      for (const spec of Object.values(specs)) expect(['enum', 'bool', 'int']).toContain(spec.kind)
    }
  })

  it('accepts allowlisted keys and values, sorted', () => {
    expect(sanitizeAnalyticsProps('log_saved', { tag: 'stuck', source: 'discord', revision: false, ignored: undefined })).toEqual({
      ok: true,
      props: { revision: false, source: 'discord', tag: 'stuck' },
    })
    expect(sanitizeAnalyticsProps('checkin_submitted', { difficulty: 5, timeBucket: 'lt2h' }).ok).toBe(true)
  })

  it('rejects unknown keys, out-of-range numbers, wrong types and free text (sentinel strings never pass)', () => {
    const SENTINEL = 'SENTINEL-과제본문-secret@example.com'
    expect(sanitizeAnalyticsProps('log_saved', { tag: 'stuck', body: SENTINEL })).toEqual({ ok: false, violations: ['body'] })
    expect(sanitizeAnalyticsProps('log_saved', { tag: SENTINEL })).toEqual({ ok: false, violations: ['tag'] })
    expect(sanitizeAnalyticsProps('checkin_submitted', { difficulty: 6 })).toEqual({ ok: false, violations: ['difficulty'] })
    expect(sanitizeAnalyticsProps('checkin_submitted', { difficulty: 2.5 })).toEqual({ ok: false, violations: ['difficulty'] })
    expect(sanitizeAnalyticsProps('login_succeeded', { newUser: 'yes' })).toEqual({ ok: false, violations: ['newUser'] })
    // 학교 메일 인증: 재학/졸업생만, 학교 id·도메인 같은 키는 거부.
    expect(sanitizeAnalyticsProps('affiliation_verified', { standing: 'alumni' })).toEqual({ ok: true, props: { standing: 'alumni' } })
    expect(sanitizeAnalyticsProps('affiliation_verified', { standing: 'professor' })).toEqual({ ok: false, violations: ['standing'] })
    expect(sanitizeAnalyticsProps('affiliation_verified', { schoolId: 'x', domain: 'yu.ac.kr' })).toEqual({ ok: false, violations: ['domain', 'schoolId'] })
    // 커뮤니티 공간(C-02): 종류·가입 방식만. 공간 id·이름·학교는 거부.
    expect(sanitizeAnalyticsProps('space_created', { kind: 'user_room' })).toEqual({ ok: true, props: { kind: 'user_room' } })
    expect(sanitizeAnalyticsProps('space_joined', { kind: 'user_room', policy: 'invite' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('space_joined', { kind: 'official_school', policy: 'open' })).toEqual({ ok: false, violations: ['kind'] })
    expect(sanitizeAnalyticsProps('space_created', { kind: 'user_room', spaceId: 'x', name: '방' })).toEqual({ ok: false, violations: ['name', 'spaceId'] })
    expect(sanitizeAnalyticsProps('name_mode_scheduled', { from: 'anonymous', to: 'real' })).toEqual({ ok: true, props: { from: 'anonymous', to: 'real' } })
    expect(sanitizeAnalyticsProps('name_mode_applied', { from: 'real', to: 'secret' })).toEqual({ ok: false, violations: ['to'] })
    expect(sanitizeAnalyticsProps('name_mode_applied', { from: 'real', to: 'display', spaceId: 'x' })).toEqual({ ok: false, violations: ['spaceId'] })
    expect(sanitizeAnalyticsProps('project_created', { title: SENTINEL, url: 'https://x.test', email: 'a@b.c' })).toEqual({
      ok: false,
      violations: ['email', 'title', 'url'],
    })
    // 프로토타입 키도 목록 밖입니다.
    expect(sanitizeAnalyticsProps('log_saved', { constructor: 'x' } as Record<string, unknown>).ok).toBe(false)
    for (const name of ANALYTICS_EVENT_NAMES) {
      expect(sanitizeAnalyticsProps(name, { q: SENTINEL }).ok).toBe(false)
      for (const key of Object.keys(ANALYTICS_PROP_SPECS[name])) expect(sanitizeAnalyticsProps(name, { [key]: SENTINEL }).ok).toBe(false)
    }
  })
})

describe('pilot metrics', () => {
  const ev = (name: AnalyticsEventName, actor: number, day: number, props: Record<string, unknown> = {}, project?: number): AnalyticsEventRow => ({
    name,
    actorHash: hex(actor),
    occurredAt: at(day),
    projectHash: project === undefined ? null : hex(1000 + project),
    props,
  })

  it('suppresses small numbers', () => {
    expect(suppressSmall(4)).toBeNull()
    expect(suppressSmall(5)).toBe(5)
    expect(suppressSmall(0)).toBeNull()
  })

  it('computes activation within 7 days of signup, excluding people whose window has not ended', () => {
    const events: AnalyticsEventRow[] = []
    for (let a = 1; a <= 8; a++) {
      events.push(ev('login_succeeded', a, 0, { newUser: true }))
      if (a <= 6) {
        events.push(ev('project_created', a, 1, {}, a))
        for (let i = 0; i < 3; i++) events.push(ev('log_saved', a, 2, { tag: 'progress', revision: false }, a))
        events.push(ev('evidence_attached', a, 3, { target: 'log', files: 1 }, a))
      }
    }
    // 7일 뒤의 활동은 세지 않습니다.
    events.push(ev('project_created', 7, 9, {}, 7))
    // 아직 7일이 안 지난 가입자(분모 제외).
    events.push(ev('login_succeeded', 9, 10, { newUser: true }))
    const m = computePilotMetrics(events, { from: at(0), to: at(14), now: at(15) })
    expect(m.activation).toEqual({ denominator: 8, numerator: 6, rate: 0.75 })
    // 수정 revision은 로그 3개에 넣지 않습니다.
    const revisions = events.map((e) => (e.name === 'log_saved' && e.actorHash === hex(1) ? { ...e, props: { revision: true } } : e))
    expect(computePilotMetrics(revisions, { from: at(0), to: at(14), now: at(15) }).activation.numerator).toBe(5)
  })

  it('computes 3-of-4-week retention, case conversion, north star and suppresses the rest', () => {
    const events: AnalyticsEventRow[] = []
    for (let a = 1; a <= 6; a++) {
      const weeks = a <= 5 ? [0, 1, 2] : [0]
      for (const w of weeks) events.push(ev('log_saved', a, w * 7 + 1, { tag: 'progress' }, a))
      events.push(ev('candidate_prepared', a, 3, { level: 'summary' }, a))
      if (a <= 5) events.push(ev('publication_published', a, 4, { level: 'summary' }, a))
      events.push(ev('plan_forked', 100 + a, 5))
      events.push(ev('usefulness_marked', 200 + a, 5, { kind: a % 2 ? 'helped' : 'me_too' }))
    }
    const m = computePilotMetrics(events, { from: at(0), to: at(28), now: at(30) })
    expect(m.retention).toEqual({ denominator: 6, numerator: 5, rate: 0.833 })
    expect(m.caseConversion).toEqual({ denominator: 6, numerator: 5, rate: 0.833 })
    expect(m.northStar).toEqual({ planForks: 6, helpedMarks: null, total: 9 })
    expect(m.activation).toEqual({ denominator: null, numerator: null, rate: null })
    expect(m.reportExports).toEqual({ exports: null, projects: null })
    expect(m.writeTimeMedianMinutes).toBeNull()
    expect(m.eventCounts.log_saved).toBe(16)
    expect(m.eventCounts.login_succeeded).toBeNull()
  })
})
