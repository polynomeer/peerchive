import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_TARGET,
  REPORT_TARGET_TYPES,
  appealTransition,
  canAppeal,
  citesHiddenItem,
  hiddenItemSet,
  isActionApplicable,
  isReportOpen,
  redactHiddenItems,
  reportCreatesHold,
  reportTargetKey,
  reportTransition,
  reporterVisibleStatus,
  transition,
} from '../src'

describe('moderation: report state', () => {
  it('open → in_review → resolved/dismissed; closed reports never reopen', () => {
    expect(reportTransition('open', 'assign')).toBe('in_review')
    expect(reportTransition('in_review', 'assign')).toBe('in_review')
    expect(reportTransition('open', 'resolve')).toBe('resolved')
    expect(reportTransition('in_review', 'dismiss')).toBe('dismissed')
    for (const closed of ['resolved', 'dismissed'] as const) {
      expect(isReportOpen(closed)).toBe(false)
      for (const event of ['assign', 'resolve', 'dismiss'] as const) expect(reportTransition(closed, event)).toBeNull()
    }
    expect(isReportOpen('open')).toBe(true)
    expect(isReportOpen('in_review')).toBe(true)
  })

  it('reporters only see coarse status', () => {
    expect(reporterVisibleStatus('open')).toBe('received')
    expect(reporterVisibleStatus('in_review')).toBe('in_review')
    expect(reporterVisibleStatus('resolved')).toBe('resolved')
    expect(reporterVisibleStatus('dismissed')).toBe('dismissed')
  })

  it('holds only for personal_info/copyright reports on publications', () => {
    expect(reportCreatesHold('publication', 'personal_info')).toBe(true)
    expect(reportCreatesHold('publication_item', 'copyright')).toBe(true)
    expect(reportCreatesHold('publication', 'spam')).toBe(false)
    expect(reportCreatesHold('senior_note', 'personal_info')).toBe(false)
    expect(reportCreatesHold('profile', 'copyright')).toBe(false)
  })

  it('actions are limited per target; none is always allowed; nothing deletes', () => {
    for (const t of REPORT_TARGET_TYPES) expect(isActionApplicable(t, 'none')).toBe(true)
    expect(isActionApplicable('publication', 'restrict')).toBe(true)
    expect(isActionApplicable('publication', 'hide_item')).toBe(false)
    expect(isActionApplicable('publication_item', 'hide_item')).toBe(true)
    expect(isActionApplicable('senior_note', 'restrict')).toBe(false)
    expect(isActionApplicable('case_study', 'hide_case_study')).toBe(true)
    expect(isActionApplicable('profile', 'hide_note')).toBe(false)
    expect(Object.values(ACTIONS_BY_TARGET).flat().some((a) => a.includes('delete'))).toBe(false)
  })

  it('target keys group reports on the same thing', () => {
    expect(reportTargetKey({ type: 'publication', publicationId: 'p1' })).toBe('publication:p1')
    expect(reportTargetKey({ type: 'publication_item', publicationId: 'p1', itemKind: 'log', itemKey: 'l_a' })).toBe('publication_item:p1:log:l_a')
    expect(reportTargetKey({ type: 'senior_note', seniorNoteId: 'n1' })).toBe('senior_note:n1')
    expect(reportTargetKey({ type: 'case_study', caseStudyId: 'c1' })).toBe('case_study:c1')
    expect(reportTargetKey({ type: 'profile', userId: 'u1' })).toBe('profile:u1')
  })
})

describe('moderation: appeals', () => {
  it('once per action, never for none, not after reversal', () => {
    expect(canAppeal({ kind: 'restrict', reversed: false }, false)).toBe('ok')
    expect(canAppeal({ kind: 'restrict', reversed: false }, true)).toBe('already_appealed')
    expect(canAppeal({ kind: 'hide_item', reversed: true }, false)).toBe('already_reversed')
    expect(canAppeal({ kind: 'none', reversed: false }, false)).toBe('not_appealable')
  })

  it('decisions only on open appeals', () => {
    expect(appealTransition('open', 'uphold')).toBe('upheld')
    expect(appealTransition('open', 'reverse')).toBe('reversed')
    expect(appealTransition('upheld', 'reverse')).toBeNull()
    expect(appealTransition('reversed', 'uphold')).toBeNull()
  })

  it('restriction lift goes to draft (owner must prepare a new candidate)', () => {
    expect(transition('published', 'restrict', { now: new Date() })).toEqual({ ok: true, state: 'restricted' })
    expect(transition('restricted', 'lift_restriction', { now: new Date() })).toEqual({ ok: true, state: 'draft' })
    expect(transition('restricted', 'publish', { now: new Date() }).ok).toBe(false)
    expect(transition('ready', 'publish', { now: new Date(), hasOpenHold: true, candidate: { manifestHash: 'h', files: [], requiredConsentSubjectIds: [] }, consents: [] })).toMatchObject({
      ok: false,
      error: { blockers: [{ kind: 'hold_open' }] },
    })
  })
})

describe('moderation: hidden items', () => {
  const snapshot = {
    title: 't',
    logs: [
      { key: 'l_a', tag: 'stuck', resolves: null, evidence: ['f1'] },
      { key: 'l_b', tag: 'solution', resolves: 'l_a', evidence: ['f1', 'f2'] },
      { key: 'l_c', tag: 'progress', resolves: null, evidence: [] },
    ],
    claims: [
      { key: 'c_a', evidence: [{ kind: 'log' as const, log: 'l_a' }, { kind: 'artifact' as const, artifactVersionId: 'f2' }] },
      { key: 'c_b', evidence: [] },
    ],
    artifacts: [{ artifactVersionId: 'f1' }, { artifactVersionId: 'f2' }],
    milestones: [{ key: 'm_a', snapshots: [{ artifactVersionId: 'f2' }] }],
  }

  it('returns the same object when nothing is hidden', () => {
    const result = redactHiddenItems(snapshot, [])
    expect(result.snapshot).toBe(snapshot)
    expect(result.placeholders).toEqual([])
    expect(redactHiddenItems(snapshot, [{ kind: 'log', key: 'not-in-snapshot' }]).snapshot).toBe(snapshot)
  })

  it('removes hidden logs, claims and files plus every reference to them, and reports placeholders at original positions', () => {
    const { snapshot: out, placeholders } = redactHiddenItems(snapshot, [
      { kind: 'log', key: 'l_a' },
      { kind: 'artifact', key: 'f2' },
      { kind: 'claim', key: 'c_b' },
    ])
    expect(out.logs.map((l) => l.key)).toEqual(['l_b', 'l_c'])
    expect(out.logs[0]).toMatchObject({ resolves: null, evidence: ['f1'] })
    expect(out.claims).toEqual([{ key: 'c_a', evidence: [] }])
    expect(out.artifacts).toEqual([{ artifactVersionId: 'f1' }])
    expect(out.milestones[0]!.snapshots).toEqual([])
    expect(out.title).toBe('t')
    expect(placeholders).toEqual([
      { kind: 'log', key: 'l_a', index: 0 },
      { kind: 'claim', key: 'c_b', index: 1 },
      { kind: 'artifact', key: 'f2', index: 1 },
    ])
    // 저장된 스냅샷은 바뀌지 않습니다.
    expect(snapshot.logs).toHaveLength(3)
    expect(snapshot.milestones[0]!.snapshots).toHaveLength(1)
  })

  it('flags case study sentences citing hidden items', () => {
    const hidden = hiddenItemSet([{ kind: 'log', key: 'l_a' }])
    expect(citesHiddenItem([{ kind: 'summary', key: 'summary' }, { kind: 'log', key: 'l_a' }], hidden)).toBe(true)
    expect(citesHiddenItem([{ kind: 'log', key: 'l_b' }], hidden)).toBe(false)
    expect(citesHiddenItem([{ kind: 'claim', key: 'l_a' }], hidden)).toBe(false)
  })
})
