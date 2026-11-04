import { describe, expect, it } from 'vitest'
import { FEATURES_OFF, HUB_OPEN_THRESHOLD_DEFAULT, hubOpeningStatus, parseFeatureFlags, parseHubOpenThreshold } from '../src'

describe('hub staged opening flag (E-02, P1 area)', () => {
  it('is off by default, turns on only with its own variable and ignores the P2 umbrella', () => {
    expect(parseFeatureFlags({}).hubStagedOpening).toBe(false)
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_HUB_STAGED_OPENING: 'on' })).toEqual({ ...FEATURES_OFF, hubStagedOpening: true })
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_P2: 'on' }).hubStagedOpening).toBe(false)
    expect(parseFeatureFlags({ PEERCHIVE_FEATURE_HUB_STAGED_OPENING: 'maybe' }).hubStagedOpening).toBe(false)
  })
})

describe('hub open threshold (E-02)', () => {
  it('defaults to 3 and accepts only integers 1..100', () => {
    expect(HUB_OPEN_THRESHOLD_DEFAULT).toBe(3)
    expect(parseHubOpenThreshold(undefined)).toBe(3)
    expect(parseHubOpenThreshold('')).toBe(3)
    expect(parseHubOpenThreshold(' 5 ')).toBe(5)
    expect(parseHubOpenThreshold('1')).toBe(1)
    expect(parseHubOpenThreshold('100')).toBe(100)
    for (const bad of ['0', '-1', '2.5', 'abc', '101', '1e2']) expect(parseHubOpenThreshold(bad)).toBe(3)
  })

  it('counts public cases + senior notes against the threshold; flag off is always open', () => {
    expect(hubOpeningStatus({ cases: 0, notes: 0 }, 3, false)).toBe('open')
    expect(hubOpeningStatus({ cases: 1, notes: 1 }, 3, true)).toBe('preparing')
    expect(hubOpeningStatus({ cases: 1, notes: 2 }, 3, true)).toBe('open')
    expect(hubOpeningStatus({ cases: 3, notes: 0 }, 3, true)).toBe('open')
    expect(hubOpeningStatus({ cases: 0, notes: 0 }, 1, true)).toBe('preparing')
  })

  it('a hub that opened once stays open when the count drops (ADR 0060 D-07)', () => {
    expect(hubOpeningStatus({ cases: 0, notes: 0 }, 3, true, new Date('2026-11-01T00:00:00Z'))).toBe('open')
    expect(hubOpeningStatus({ cases: 0, notes: 0 }, 3, true, null)).toBe('preparing')
  })
})
