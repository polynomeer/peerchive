import { describe, expect, it } from 'vitest'
import { type HubSnapshot, STUCK_EMBEDDING_TEXT_MAX, parseSimilarLimit, stuckEmbeddingSources } from '../src'

const log = (key: string, tag: string, payload: Record<string, unknown>, extra: Partial<{ body: string; resolves: string | null }> = {}) => ({
  key,
  tag,
  body: extra.body ?? '',
  payload,
  links: [],
  recordedAt: '2025-10-01T00:00:00.000Z',
  resolves: extra.resolves ?? null,
})

const snapshot = (logs: HubSnapshot['logs']): HubSnapshot => ({ title: 't', summary: 's', kind: 'individual', retrospective: false, members: [], milestones: [], logs })

describe('E-05 stuck embedding sources', () => {
  it('uses symptom, keywords and resolving solution methods only (no attempts / error text / other logs)', () => {
    const s = snapshot([
      log('s1', 'stuck', { symptom: '좀비 프로세스가 남음', keywords: ['fork', 'wait'], attempts: ['시도 원문'], errorText: '오류 원문' }),
      log('v1', 'solution', { method: 'waitpid로 거둠' }, { resolves: 's1' }),
      log('p1', 'progress', {}, { body: '진행 기록 본문' }),
      log('s2', 'stuck', { symptom: '' }, { body: '' }),
    ])
    const out = stuckEmbeddingSources(s)
    expect(out).toEqual([{ itemKey: 's1', text: '막힘: 좀비 프로세스가 남음\n키워드: fork, wait\n해결: waitpid로 거둠' }])
    expect(JSON.stringify(out)).not.toMatch(/시도 원문|오류 원문|진행 기록/)
  })

  it('skips hidden stuck logs and hidden solutions, and clips long text', () => {
    const s = snapshot([
      log('s1', 'stuck', { symptom: '가'.repeat(3000) }),
      log('s2', 'stuck', { symptom: '둘째' }),
      log('v2', 'solution', { method: '가린 해결' }, { resolves: 's2' }),
    ])
    const out = stuckEmbeddingSources(s, new Set(['s1', 'v2']))
    expect(out).toEqual([{ itemKey: 's2', text: '막힘: 둘째' }])
    expect([...stuckEmbeddingSources(s)[0]!.text].length).toBe(STUCK_EMBEDDING_TEXT_MAX)
  })

  it('parses limit', () => {
    expect(parseSimilarLimit(undefined)).toBe(5)
    expect(parseSimilarLimit('3')).toBe(3)
    expect(parseSimilarLimit('11')).toBeNull()
    expect(parseSimilarLimit('x')).toBeNull()
  })
})
