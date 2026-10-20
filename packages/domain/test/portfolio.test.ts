import { describe, expect, it } from 'vitest'
import {
  CASE_SECTIONS,
  CASE_TEMPLATE_FRAMES,
  type CaseSelf,
  type CaseSnapshot,
  JOB_TARGET_PRESETS,
  COMPETENCY_PRESETS,
  caseSectionOrder,
  caseStudyCheckItems,
  citationAnchor,
  citationLabel,
  clipText,
  computeCompetencyMatrix,
  countEvidence,
  findUncitedSentences,
  formatEvidenceCounts,
  generateCaseStudyDraft,
  normalizeCaseSections,
  runPublicationChecks,
  suggestCompetencyEvidence,
} from '../src/index'

/** 모든 사용자 글은 `⟦…⟧` 표식이라, 결과 글에서 표식을 빼면 문장 틀 글자만 남아야 합니다. */
const snapshot: CaseSnapshot = {
  title: '⟦title⟧',
  summary: '⟦summary⟧',
  kind: 'team',
  members: [
    { key: 'm_me', label: '팀원 A', anonymous: true },
    { key: 'm_other', label: '김다른', anonymous: false },
  ],
  milestones: [
    { key: 'ms_2', position: 2, title: '⟦ms2⟧' },
    { key: 'ms_1', position: 1, title: '⟦ms1⟧' },
  ],
  logs: [
    { key: 'l_dec', tag: 'decision', author: null, body: '', payload: { options: ['⟦optA⟧', '⟦optB⟧'], criteria: '⟦criteria⟧', choice: '⟦choice⟧', hindsight: '⟦hindsight⟧' }, recordedAt: '2025-10-01T00:00:00Z', resolves: null },
    { key: 'l_dec_other', tag: 'decision', author: 'm_other', body: '', payload: { options: ['x', 'y'], criteria: 'OTHER', choice: 'OTHERCHOICE' }, recordedAt: '2025-10-01T01:00:00Z', resolves: null },
    { key: 'l_stuck', tag: 'stuck', author: null, body: '', payload: { symptom: '⟦symptom⟧', keywords: [], attempts: ['⟦attempt⟧'], timeBucket: 'half_day' }, recordedAt: '2025-10-02T00:00:00Z', resolves: null },
    { key: 'l_sol', tag: 'solution', author: 'm_other', body: '', payload: { method: '⟦method⟧' }, recordedAt: '2025-10-03T00:00:00Z', resolves: 'l_stuck' },
    { key: 'l_stuck_open', tag: 'stuck', author: null, body: '', payload: { symptom: '⟦open⟧', timeBucket: 'lt2h' }, recordedAt: '2025-10-03T01:00:00Z', resolves: null },
    { key: 'l_val', tag: 'validation', author: null, body: '', payload: { target: '⟦target⟧', conditions: '⟦cond⟧', result: '⟦result⟧', openQuestions: '⟦openq⟧' }, recordedAt: '2025-10-04T00:00:00Z', resolves: null },
    { key: 'l_meet', tag: 'meeting', author: 'm_other', body: '', payload: { attendees: ['m_me', 'm_other'], decisions: ['⟦meetdec⟧'], followUps: [] }, recordedAt: '2025-10-05T00:00:00Z', resolves: null },
    { key: 'l_retro', tag: 'retro', author: null, body: '⟦retro⟧', payload: {}, recordedAt: '2025-10-06T00:00:00Z', resolves: null },
  ],
  claims: [
    { key: 'c_unconf', member: 'm_me', text: '⟦claim2⟧', status: 'unconfirmed', confirmedCount: 0, disputedCount: 0 },
    { key: 'c_conf', member: 'm_me', text: '⟦claim1⟧', status: 'confirmed', confirmedCount: 2, disputedCount: 0 },
    { key: 'c_other', member: 'm_other', text: 'OTHERCLAIM', status: 'confirmed', confirmedCount: 1, disputedCount: 0 },
  ],
  artifacts: [
    { artifactVersionId: '00000000-0000-4000-8000-000000000001', displayName: '⟦file⟧' },
    { artifactVersionId: '00000000-0000-4000-8000-000000000002', displayName: 'OTHERFILE' },
  ],
}

const self: CaseSelf = {
  memberKey: 'm_me',
  ownLogKeys: new Set(['l_dec', 'l_stuck', 'l_stuck_open', 'l_val', 'l_retro']),
  ownArtifactIds: new Set(['00000000-0000-4000-8000-000000000001']),
}

const allText = (sections: ReturnType<typeof generateCaseStudyDraft>) => sections.flatMap((s) => s.sentences.map((x) => x.text))

describe('generateCaseStudyDraft', () => {
  it('is deterministic and orders sections by job target', () => {
    const a = generateCaseStudyDraft(snapshot, 2, self, 'backend')
    const b = generateCaseStudyDraft(structuredClone(snapshot), 2, { ...self, ownLogKeys: new Set([...self.ownLogKeys].reverse()) }, 'backend')
    expect(a).toEqual(b)
    expect(a.map((s) => s.key)).toEqual(caseSectionOrder('backend'))
    expect(generateCaseStudyDraft(snapshot, 2, self, 'frontend').map((s) => s.key)).toEqual([
      'problem_result',
      'my_role',
      'validation',
      'decisions',
      'stuck_solved',
      'limits',
      'sources',
    ])
    expect(new Set(a.map((s) => s.key))).toEqual(new Set(CASE_SECTIONS))
  })

  it('fills fixed frames only with snapshot text (no invented words) and cites every generated sentence', () => {
    const sections = generateCaseStudyDraft(snapshot, 2, self, 'general')
    const markers = new Set(JSON.stringify(snapshot).match(/⟦[^⟧]+⟧/g))
    const frameChars = new Set([...CASE_TEMPLATE_FRAMES.join('')])
    for (const text of allText(sections)) {
      for (const marker of text.match(/⟦[^⟧]+⟧/g) ?? []) expect(markers.has(marker)).toBe(true)
      const rest = text.replace(/⟦[^⟧]+⟧/g, '').replace(/[\d\s]/g, '')
      for (const ch of rest) expect(frameChars.has(ch), `unexpected "${ch}" in "${text}"`).toBe(true)
      // 다른 팀원의 결정·선언·파일 글은 내 초안에 들어가지 않음.
      expect(text).not.toMatch(/OTHER/)
    }
    for (const s of sections) for (const sentence of s.sentences) {
      expect(sentence.citations.length).toBeGreaterThan(0)
      for (const c of sentence.citations) expect(c.releaseVersion).toBe(2)
    }
    expect(findUncitedSentences(sections)).toEqual([])
  })

  it('chooses my items: confirmed claims first, stuck+solution pair, my decisions/validation, attended meeting, retro and limits', () => {
    const sections = Object.fromEntries(generateCaseStudyDraft(snapshot, 1, self, 'backend').map((s) => [s.key, s.sentences]))
    expect(sections.problem_result!.map((s) => s.text)).toEqual(['⟦title⟧ — ⟦summary⟧', '확인한 결과: ⟦result⟧'])
    expect(sections.problem_result![0]!.citations).toEqual([{ releaseVersion: 1, kind: 'summary', key: 'summary' }])
    expect(sections.my_role!.map((s) => s.text)).toEqual([
      '역할: ⟦claim1⟧ (팀원 확인 2명)',
      '역할: ⟦claim2⟧ (본인 설명 · 미확인)',
      '직접 남긴 기록: 막힘 2 · 결정 1 · 검증 1 · 회고 1 · 회의 참석 1',
    ])
    expect(sections.decisions!.map((s) => s.text)).toEqual(['선택: ⟦choice⟧ (선택지: ⟦optA⟧ / ⟦optB⟧) · 기준: ⟦criteria⟧', '회의에서 정한 것: ⟦meetdec⟧'])
    expect(sections.stuck_solved!).toEqual([
      {
        text: '막힘: ⟦symptom⟧ → 해결: ⟦method⟧ (걸린 시간: 반나절)',
        kind: 'evidence',
        citations: [
          { releaseVersion: 1, kind: 'log', key: 'l_stuck' },
          { releaseVersion: 1, kind: 'log', key: 'l_sol' },
        ],
      },
    ])
    expect(sections.validation!.map((s) => s.text)).toEqual(['검증: ⟦target⟧ · 조건: ⟦cond⟧ · 결과: ⟦result⟧'])
    expect(sections.limits!.map((s) => s.text)).toEqual(['지나고 보니: ⟦hindsight⟧', '남은 질문: ⟦openq⟧', '해결하지 못한 막힘: ⟦open⟧', '회고: ⟦retro⟧'])
    expect(sections.sources!.map((s) => s.text)).toEqual(['진행 단계: ⟦ms1⟧ → ⟦ms2⟧', '산출물: ⟦file⟧'])
    // 시도(attempts)는 초안에 넣지 않음.
    expect(JSON.stringify(sections)).not.toContain('⟦attempt⟧')
  })

  it('uses the team result frame when I wrote no validation, and truncates long text safely', () => {
    const long = '가'.repeat(400)
    const snap: CaseSnapshot = { ...snapshot, summary: long }
    const sections = generateCaseStudyDraft(snap, 1, { ...self, ownLogKeys: new Set() }, 'general')
    const first = sections[0]!.sentences
    expect(first[0]!.text.endsWith('…')).toBe(true)
    expect([...first[0]!.text].length).toBeLessThanOrEqual(80 + 3 + 200)
    expect(first[1]!.text).toBe('팀이 확인한 결과: ⟦result⟧')
    expect(clipText('  a\n\n b  ', 10)).toBe('a b')
    expect(clipText('abcdef', 4)).toBe('abc…')
  })
})

describe('normalizeCaseSections', () => {
  const v = 3
  it('accepts edits, fills missing sections, dedupes citations and keeps job-target order', () => {
    const result = normalizeCaseSections(
      [
        { key: 'limits', sentences: [{ text: '  내 생각  ', kind: 'reflection' }] },
        { key: 'decisions', sentences: [{ text: '고친 문장', citations: [{ releaseVersion: v, kind: 'log', key: 'l_dec' }, { releaseVersion: v, kind: 'log', key: 'l_dec' }] }] },
      ],
      snapshot,
      v,
      'backend',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sections.map((s) => s.key)).toEqual(caseSectionOrder('backend'))
    const decisions = result.sections.find((s) => s.key === 'decisions')!
    expect(decisions.sentences).toEqual([{ text: '고친 문장', kind: 'evidence', citations: [{ releaseVersion: v, kind: 'log', key: 'l_dec' }] }])
    expect(result.sections.find((s) => s.key === 'limits')!.sentences[0]).toEqual({ text: '내 생각', kind: 'reflection', citations: [] })
    expect(findUncitedSentences(result.sections)).toEqual([])
  })

  it('rejects citations not in the pinned snapshot, other release versions, reflection outside limits and bad shapes', () => {
    const bad = normalizeCaseSections(
      [
        {
          key: 'decisions',
          sentences: [
            { text: 'a', citations: [{ releaseVersion: v, kind: 'log', key: 'l_missing' }] },
            { text: 'b', citations: [{ releaseVersion: v + 1, kind: 'log', key: 'l_dec' }] },
            { text: 'c', kind: 'reflection' },
            { text: '' },
            { text: 'd', citations: [{ releaseVersion: v, kind: 'email', key: 'x' }] },
            { text: 'e', extra: 1 },
          ],
        },
        { key: 'decisions', sentences: [] },
        { key: 'nope', sentences: [] },
      ],
      snapshot,
      v,
      'backend',
    )
    expect(bad).toEqual({
      ok: false,
      fields: {
        'sections.0.sentences.0.citations.0': 'not_found',
        'sections.0.sentences.1.citations.0': 'stale_release',
        'sections.0.sentences.2.kind': 'not_allowed',
        'sections.0.sentences.3.text': 'required',
        'sections.0.sentences.4.citations.0': 'invalid',
        'sections.0.sentences.5': 'unknown_key',
        'sections.1.key': 'duplicate',
        'sections.2.key': 'invalid',
      },
    })
    expect(normalizeCaseSections('x', snapshot, v, 'backend')).toEqual({ ok: false, fields: { sections: 'invalid' } })
    expect(normalizeCaseSections([{ key: 'decisions', sentences: [{ text: 'x'.repeat(501) }] }], snapshot, v, 'backend')).toEqual({
      ok: false,
      fields: { 'sections.0.sentences.0.text': 'too_long' },
    })
    const summaryOk = normalizeCaseSections([{ key: 'problem_result', sentences: [{ text: 'x', citations: [{ releaseVersion: v, kind: 'summary', key: 'summary' }] }] }], snapshot, v, 'pm')
    expect(summaryOk.ok).toBe(true)
  })

  it('reports uncited sentences except evidence-free reflections in 한계·회고', () => {
    const r = normalizeCaseSections(
      [
        { key: 'my_role', sentences: [{ text: '출처 없음' }, { text: '출처 있음', citations: [{ releaseVersion: v, kind: 'claim', key: 'c_conf' }] }] },
        { key: 'limits', sentences: [{ text: '회고지만 표시 안 함' }, { text: '본인 회고', kind: 'reflection' }] },
      ],
      snapshot,
      v,
      'backend',
    )
    if (!r.ok) throw new Error('expected ok')
    expect(findUncitedSentences(r.sections)).toEqual([
      { section: 'my_role', index: 0 },
      { section: 'limits', index: 0 },
    ])
  })
})

describe('citations display and checks', () => {
  it('labels and anchors citations from the snapshot only', () => {
    expect(citationLabel(snapshot, { kind: 'log', key: 'l_dec' })).toBe('⚖️ 결정 · ⟦choice⟧')
    expect(citationLabel(snapshot, { kind: 'claim', key: 'c_conf' })).toBe('🙋 역할 선언 · ⟦claim1⟧')
    expect(citationLabel(snapshot, { kind: 'summary', key: 'summary' })).toBe('📝 사례 요약')
    expect(citationLabel(snapshot, { kind: 'log', key: 'l_none' })).toBeNull()
    expect(citationAnchor({ kind: 'log', key: 'l_dec' })).toBe('public-l_dec')
    expect(citationAnchor({ kind: 'summary', key: 'summary' })).toBe('public-title')
    expect(citationAnchor({ kind: 'artifact', key: 'abc' })).toBe('public-f-abc')
  })

  it('runs publication checks on case study text', () => {
    const warnings = runPublicationChecks(
      caseStudyCheckItems({ title: '제목', sections: [{ key: 'limits', sentences: [{ text: '연락 010-1234-5678', kind: 'reflection', citations: [] }] }] }),
    )
    expect(warnings).toEqual([{ rule: 'phone', location: { kind: 'case_study', key: 'limits', field: 'sections.limits.0' }, sample: '010-****-**78' }])
  })
})

describe('competency × evidence matrix', () => {
  const cited = [
    { kind: 'log' as const, key: 'l_dec' },
    { kind: 'log' as const, key: 'l_stuck' },
    { kind: 'log' as const, key: 'l_sol' },
    { kind: 'claim' as const, key: 'c_conf' },
    { kind: 'claim' as const, key: 'c_unconf' },
    { kind: 'summary' as const, key: 'summary' },
  ]

  it('counts kinds only (a solution with its stuck counts once as 막힘 해결; summary is not evidence)', () => {
    const counts = countEvidence(snapshot, cited)
    expect(counts).toEqual([
      { category: 'decision', label: '결정', count: 1 },
      { category: 'stuck_resolved', label: '막힘 해결', count: 1 },
      { category: 'claim_confirmed', label: '팀원 확인', count: 1 },
      { category: 'claim', label: '역할 선언', count: 1 },
    ])
    expect(formatEvidenceCounts(counts)).toBe('결정 1 · 막힘 해결 1 · 팀원 확인 1 · 역할 선언 1')
    // 막힘 없이 해결만 인용하면 해결 1.
    expect(countEvidence(snapshot, [{ kind: 'log', key: 'l_sol' }])).toEqual([{ category: 'solution', label: '해결', count: 1 }])
  })

  it('computes cells per case study, hides unavailable columns and has no score fields', () => {
    const rows = computeCompetencyMatrix(
      [
        { ref: 'case-1', available: true, snapshot },
        { ref: 'case-2', available: false, snapshot: null },
      ],
      [
        { label: '디버깅', preset: 'debugging', evidence: [{ column: 'case-1', citations: suggestCompetencyEvidence(snapshot, cited, 'debugging') }, { column: 'case-2', citations: [{ kind: 'log', key: 'l_x' }] }] },
        { label: '직접 입력', preset: null, evidence: [] },
      ],
    )
    expect(rows[0]!.cells[0]).toEqual({
      column: 'case-1',
      available: true,
      counts: [{ category: 'stuck_resolved', label: '막힘 해결', count: 1 }],
      text: '막힘 해결 1',
      citations: [
        { kind: 'log', key: 'l_stuck' },
        { kind: 'log', key: 'l_sol' },
      ],
    })
    expect(rows[0]!.cells[1]).toEqual({ column: 'case-2', available: false, counts: [], text: '볼 수 없음', citations: [] })
    expect(rows[0]!.evidenceBacked).toBe(true)
    expect(rows[1]!.evidenceBacked).toBe(false)
    expect(rows[1]!.cells[0]!.text).toBe('–')
    expect(JSON.stringify(rows)).not.toMatch(/score|level|intensity|weight|percent/i)
  })

  it('has presets per job target', () => {
    for (const ids of Object.values(JOB_TARGET_PRESETS)) for (const id of ids) expect(COMPETENCY_PRESETS[id]).toBeDefined()
    expect(suggestCompetencyEvidence(snapshot, cited, 'api_design')).toEqual([{ kind: 'log', key: 'l_dec' }])
    expect(suggestCompetencyEvidence(snapshot, cited, 'unknown')).toEqual([])
  })
})
