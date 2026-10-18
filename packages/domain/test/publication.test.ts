import { describe, expect, it } from 'vitest'
import {
  PUBLICATION_EVENTS,
  PUBLICATION_STATES,
  allowedEvents,
  transition,
  type PublicationContext,
} from '../src'

const NOW = new Date('2026-12-20T00:00:00Z')

/** 모든 조건을 충족한 게시 컨텍스트. 각 테스트는 한 가지씩만 깨뜨립니다. */
function readyCtx(overrides: Partial<PublicationContext> = {}): PublicationContext {
  return {
    now: NOW,
    embargoUntil: new Date('2026-12-19T00:00:00Z'),
    candidate: {
      manifestHash: 'sha256:candidate-v2',
      files: [{ artifactVersionId: 'av1', scanStatus: 'clean' }],
      requiredConsentSubjectIds: ['owner', 'teammate'],
    },
    consents: [
      { subjectId: 'owner', manifestHash: 'sha256:candidate-v2', status: 'granted' },
      { subjectId: 'teammate', manifestHash: 'sha256:candidate-v2', status: 'granted' },
    ],
    hasOpenHold: false,
    ...overrides,
  }
}

describe('publication transition: publish', () => {
  it('publishes when consents, files, embargo and holds all pass', () => {
    expect(transition('ready', 'publish', readyCtx())).toEqual({ ok: true, state: 'published' })
  })

  it('blocks publish while the embargo is active, even from ready', () => {
    const until = new Date('2026-12-21T00:00:00Z')
    const result = transition('ready', 'publish', readyCtx({ embargoUntil: until }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('PRECONDITION_FAILED')
    expect(result.error).toMatchObject({ blockers: [{ kind: 'embargo_active', until }] })
  })

  it('allows publish exactly at embargo end (now >= embargoUntil)', () => {
    expect(transition('ready', 'publish', readyCtx({ embargoUntil: NOW })).ok).toBe(true)
  })

  it('blocks publish when a required consent is missing', () => {
    const ctx = readyCtx({
      consents: [{ subjectId: 'owner', manifestHash: 'sha256:candidate-v2', status: 'granted' }],
    })
    const result = transition('ready', 'publish', ctx)
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'PRECONDITION_FAILED', blockers: [{ kind: 'consent_missing', subjectId: 'teammate' }] },
    })
  })

  it('treats a revoked or pending consent as missing', () => {
    for (const status of ['revoked', 'pending', 'declined'] as const) {
      const ctx = readyCtx({
        consents: [
          { subjectId: 'owner', manifestHash: 'sha256:candidate-v2', status: 'granted' },
          { subjectId: 'teammate', manifestHash: 'sha256:candidate-v2', status },
        ],
      })
      expect(transition('ready', 'publish', ctx)).toMatchObject({
        ok: false,
        error: { blockers: [{ kind: 'consent_missing', subjectId: 'teammate' }] },
      })
    }
  })

  it('blocks publish when a consent was given to a stale manifest hash', () => {
    const ctx = readyCtx({
      consents: [
        { subjectId: 'owner', manifestHash: 'sha256:candidate-v2', status: 'granted' },
        { subjectId: 'teammate', manifestHash: 'sha256:candidate-v1', status: 'granted' },
      ],
    })
    expect(transition('ready', 'publish', ctx)).toMatchObject({
      ok: false,
      error: {
        code: 'PRECONDITION_FAILED',
        blockers: [
          {
            kind: 'consent_stale',
            subjectId: 'teammate',
            consentedHash: 'sha256:candidate-v1',
            candidateHash: 'sha256:candidate-v2',
          },
        ],
      },
    })
  })

  it('blocks publish when any file is not clean', () => {
    const ctx = readyCtx({
      candidate: {
        manifestHash: 'sha256:candidate-v2',
        files: [
          { artifactVersionId: 'av1', scanStatus: 'clean' },
          { artifactVersionId: 'av2', scanStatus: 'quarantined' },
        ],
        requiredConsentSubjectIds: ['owner', 'teammate'],
      },
    })
    expect(transition('ready', 'publish', ctx)).toMatchObject({
      ok: false,
      error: { blockers: [{ kind: 'file_not_clean', artifactVersionId: 'av2', scanStatus: 'quarantined' }] },
    })
  })

  it('blocks publish while a hold is open', () => {
    expect(transition('ready', 'publish', readyCtx({ hasOpenHold: true }))).toMatchObject({
      ok: false,
      error: { blockers: [{ kind: 'hold_open' }] },
    })
  })

  it('blocks publish without a candidate', () => {
    expect(transition('ready', 'publish', readyCtx({ candidate: null }))).toMatchObject({
      ok: false,
      error: { blockers: [{ kind: 'candidate_missing' }] },
    })
  })

  it('reports every blocker at once', () => {
    const result = transition(
      'ready',
      'publish',
      readyCtx({ embargoUntil: new Date('2027-01-01T00:00:00Z'), consents: [], hasOpenHold: true }),
    )
    expect(result.ok).toBe(false)
    if (result.ok || result.error.code !== 'PRECONDITION_FAILED') throw new Error('expected blockers')
    expect(result.error.blockers.map((b) => b.kind).sort()).toEqual(
      ['consent_missing', 'consent_missing', 'embargo_active', 'hold_open'].sort(),
    )
  })

  it.each(PUBLICATION_STATES.filter((s) => s !== 'ready'))('cannot publish from %s', (state) => {
    expect(transition(state, 'publish', readyCtx())).toEqual({
      ok: false,
      error: { code: 'INVALID_TRANSITION', from: state, event: 'publish' },
    })
  })
})

describe('publication transition: other edges', () => {
  it('enters and leaves embargo only according to the term end', () => {
    const during = { now: NOW, embargoUntil: new Date('2027-01-01T00:00:00Z') }
    const after = { now: NOW, embargoUntil: new Date('2026-12-01T00:00:00Z') }
    expect(transition('draft', 'start_embargo', during)).toEqual({ ok: true, state: 'embargoed' })
    expect(transition('draft', 'start_embargo', after).ok).toBe(false)
    expect(transition('embargoed', 'end_embargo', during).ok).toBe(false)
    expect(transition('embargoed', 'end_embargo', after)).toEqual({ ok: true, state: 'draft' })
  })

  it('never jumps from embargoed straight to published', () => {
    const after = readyCtx({ embargoUntil: new Date('2026-12-01T00:00:00Z') })
    expect(transition('embargoed', 'publish', after).ok).toBe(false)
  })

  it('refuses to create a candidate during embargo', () => {
    const ctx = readyCtx({ embargoUntil: new Date('2027-01-01T00:00:00Z') })
    expect(transition('draft', 'create_candidate', ctx)).toMatchObject({
      ok: false,
      error: { code: 'PRECONDITION_FAILED' },
    })
    expect(transition('draft', 'create_candidate', readyCtx())).toEqual({ ok: true, state: 'awaiting_consent' })
  })

  it('moves to ready only when consents and scans pass', () => {
    expect(transition('awaiting_consent', 'mark_ready', readyCtx())).toEqual({ ok: true, state: 'ready' })
    expect(transition('awaiting_consent', 'mark_ready', readyCtx({ consents: [] })).ok).toBe(false)
    expect(transition('awaiting_consent', 'revise_candidate', readyCtx())).toEqual({ ok: true, state: 'draft' })
  })

  it('withdrawn returns to draft only via a new candidate', () => {
    const ctx = readyCtx()
    expect(allowedEvents('withdrawn')).toEqual(['start_new_candidate'])
    expect(transition('withdrawn', 'start_new_candidate', ctx)).toEqual({ ok: true, state: 'draft' })
    for (const event of PUBLICATION_EVENTS.filter((e) => e !== 'start_new_candidate')) {
      expect(transition('withdrawn', event, ctx)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_TRANSITION', from: 'withdrawn', event },
      })
    }
  })

  it('handles withdraw, restrict and lifting a restriction', () => {
    const ctx = readyCtx()
    expect(transition('published', 'withdraw', ctx)).toEqual({ ok: true, state: 'withdrawn' })
    expect(transition('published', 'restrict', ctx)).toEqual({ ok: true, state: 'restricted' })
    expect(transition('restricted', 'lift_restriction', ctx)).toEqual({ ok: true, state: 'draft' })
    expect(transition('restricted', 'publish', ctx).ok).toBe(false)
  })
})
