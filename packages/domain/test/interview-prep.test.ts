import { describe, expect, it } from 'vitest'
import {
  type CaseSectionDraft,
  type CaseSnapshot,
  INTERVIEW_NOTE_MAX,
  INTERVIEW_SOURCED_QUESTION_LIMIT,
  generateInterviewQuestions,
  isInterviewQuestionKey,
  josa,
  normalizeInterviewNote,
} from '../src'

const log = (key: string, tag: string, payload: Record<string, unknown>, resolves: string | null = null) => ({
  key,
  tag,
  author: '김지민',
  body: '',
  payload,
  recordedAt: '2026-10-01T00:00:00Z',
  resolves,
})

const snapshot: CaseSnapshot = {
  title: '도서관 혼잡도 웹앱',
  summary: '요약',
  kind: 'team',
  members: [{ key: 'm_a', label: '김지민', anonymous: false }],
  milestones: [],
  claims: [],
  artifacts: [],
  logs: [
    log('l_dec', 'decision', { options: ['실시간 센서', '수동 입력'], choice: '수동 입력', criteria: '비용', hindsight: '센서도 시험해 볼 걸' }),
    log('l_dec2', 'decision', { options: [], choice: '카카오 지도' }),
    log('l_meet', 'meeting', { decisions: ['범위 축소'], attendees: [] }),
    log('l_stuck', 'stuck', { symptom: 'CORS 에러' }),
    log('l_sol', 'solution', { method: '헤더 추가' }, 'l_stuck'),
    log('l_open', 'stuck', { symptom: '메모리 누수' }),
    log('l_uncited', 'decision', { options: ['A', 'B'], choice: 'B' }),
    log('l_prog', 'progress', {}),
  ],
}

const cite = (...keys: string[]): CaseSectionDraft[] => [
  { key: 'decisions', sentences: keys.map((key) => ({ text: '문장', kind: 'evidence' as const, citations: [{ releaseVersion: 1, kind: 'log' as const, key }] })) },
]

describe('interview prep pack (E-06)', () => {
  it('makes grounded questions only from cited decision, meeting and stuck logs, then generic ones', () => {
    const qs = generateInterviewQuestions({ snapshot, sections: cite('l_dec', 'l_dec2', 'l_meet', 'l_stuck', 'l_open', 'l_prog', 'l_dec') })
    expect(qs.map((q) => q.key)).toEqual([
      'decision:l_dec',
      'hindsight:l_dec',
      'decision:l_dec2',
      'meeting:l_meet',
      'stuck:l_stuck',
      'stuck:l_open',
      'generic:failure',
      'generic:conflict',
      'generic:retro',
    ])
    expect(qs[0]).toEqual({ key: 'decision:l_dec', category: 'decision', text: '왜 실시간 센서 대신 수동 입력을 택했나요?', source: { kind: 'log', key: 'l_dec' } })
    expect(qs[2]!.text).toBe('카카오 지도를 정할 때 무엇을 가장 중요하게 봤나요?')
    expect(qs[3]).toMatchObject({ category: 'conflict', source: { kind: 'log', key: 'l_meet' } })
    expect(qs[4]!.text).toContain('원인을 어떻게 찾았나요')
    expect(qs[5]!.text).toContain('해결되지 않았습니다')
    // 인용하지 않은 결정은 질문이 되지 않고, 일반 질문은 출처가 없습니다.
    expect(qs.some((q) => q.source?.key === 'l_uncited')).toBe(false)
    expect(qs.filter((q) => q.key.startsWith('generic:')).every((q) => q.source === null)).toBe(true)
    for (const q of qs) expect(isInterviewQuestionKey(q.key)).toBe(true)
  })

  it('is deterministic, skips hidden items, drops the team-only generic for solo work and caps sourced questions', () => {
    const sections = cite('l_dec', 'l_stuck')
    expect(generateInterviewQuestions({ snapshot, sections })).toEqual(generateInterviewQuestions({ snapshot, sections }))
    const hidden = generateInterviewQuestions({ snapshot, sections, isHidden: (kind, key) => kind === 'log' && key === 'l_stuck' })
    expect(hidden.map((q) => q.key)).not.toContain('stuck:l_stuck')
    const solo = generateInterviewQuestions({ snapshot: { ...snapshot, kind: 'individual' }, sections: [] })
    expect(solo.map((q) => q.key)).toEqual(['generic:failure', 'generic:retro'])
    const many: CaseSnapshot = { ...snapshot, logs: Array.from({ length: 15 }, (_, i) => log(`l_s${i}`, 'stuck', { symptom: `증상 ${i}` })) }
    const capped = generateInterviewQuestions({ snapshot: many, sections: cite(...many.logs.map((l) => l.key)) })
    expect(capped.filter((q) => q.source).length).toBe(INTERVIEW_SOURCED_QUESTION_LIMIT)
  })

  it('validates question keys, josa and notes', () => {
    expect(isInterviewQuestionKey('decision:l_abc')).toBe(true)
    expect(isInterviewQuestionKey('generic:failure')).toBe(true)
    expect(isInterviewQuestionKey('generic:other')).toBe(false)
    expect(isInterviewQuestionKey('decision:../x')).toBe(false)
    expect(isInterviewQuestionKey(3)).toBe(false)
    expect(josa('입력', '을', '를')).toBe('을')
    expect(josa('지도', '을', '를')).toBe('를')
    expect(josa('Redis', '을', '를')).toBe('을(를)')
    expect(normalizeInterviewNote('  답변\r\n둘째 줄 ')).toEqual({ ok: true, note: '답변\n둘째 줄' })
    expect(normalizeInterviewNote('   ')).toEqual({ ok: true, note: null })
    expect(normalizeInterviewNote(null)).toEqual({ ok: true, note: null })
    expect(normalizeInterviewNote(5)).toEqual({ ok: false, code: 'invalid' })
    expect(normalizeInterviewNote('가'.repeat(INTERVIEW_NOTE_MAX + 1))).toEqual({ ok: false, code: 'too_long' })
  })
})
