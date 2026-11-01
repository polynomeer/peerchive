import { describe, expect, it } from 'vitest'
import {
  ACTIONS_BY_TARGET,
  FEATURES_OFF,
  STUCK_QA_BODY_MAX,
  normalizeStuckQaBody,
  parseFeatureFlags,
  reportTargetKey,
  stuckQaExcerpt,
} from '../src'

describe('stuck Q&A threads (E-04)', () => {
  it('sits behind its own default-off P1 flag (not the P2 bundle switch)', () => {
    expect(parseFeatureFlags({}).stuckQa).toBe(false)
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_STUCK_QA: 'on' })).toEqual({ ...FEATURES_OFF, stuckQa: true })
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_P2: 'on' }).stuckQa).toBe(false)
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_STUCK_QA: 'maybe' }).stuckQa).toBe(false)
  })

  it('reports point at one post and the only action hides it', () => {
    expect(reportTargetKey({ type: 'stuck_qa_post', postId: 'p1' })).toBe('stuck_qa_post:p1')
    expect(ACTIONS_BY_TARGET.stuck_qa_post).toEqual(['none', 'hide_stuck_qa_post'])
  })

  it('normalizes bodies and excerpts', () => {
    expect(STUCK_QA_BODY_MAX).toBe(2000)
    expect(normalizeStuckQaBody('  a\r\nb  ')).toBe('a\nb')
    expect(normalizeStuckQaBody(' \n ')).toBeNull()
    expect(stuckQaExcerpt('a   b', 10)).toBe('a b')
    expect(stuckQaExcerpt('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})
