import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_SENIOR_LABEL,
  type HubSnapshot,
  canWriteToCourseHub,
  hubWriteDecision,
  extractStuckItems,
  forkPlanFromSnapshot,
  forkProjectTitle,
  formatForkReferences,
  isAllowedSignal,
  normalizeSearchText,
  normalizeSeniorNoteAnswers,
  rankStuckItems,
  runPublicationChecks,
  searchDocFromSeniorNote,
  searchDocsFromSnapshot,
  seniorNoteAuthorLabel,
  seniorNoteCheckItems,
} from '../src/index'

const SECRET = 'SECRET-SOLUTION-TEXT'

const snapshot: HubSnapshot = {
  title: '셸 구현 과제',
  summary: '파이프와 리다이렉션을 구현했다.',
  kind: 'team',
  retrospective: false,
  members: [{ key: 'm_1', label: '김소유' }, { key: 'm_2', label: '팀원 A' }],
  milestones: [
    { key: 'ms_b', position: 2, title: '중간발표', dueAt: '2025-10-15' },
    { key: 'ms_a', position: 1, title: '기획', dueAt: '2025-10-01' },
    { key: 'ms_c', position: 3, title: '최종 제출', dueAt: null },
  ],
  logs: [
    {
      key: 'l_stuck',
      tag: 'stuck',
      body: '',
      payload: { symptom: '좀비 프로세스가 남음', keywords: ['fork', 'waitpid'], attempts: [SECRET], errorText: SECRET, timeBucket: 'half_day' },
      links: [{ url: 'https://man7.org/linux/man-pages/man2/wait.2.html', title: 'wait(2)' }],
      recordedAt: '2025-10-05T00:00:00.000Z',
      resolves: null,
    },
    {
      key: 'l_solution',
      tag: 'solution',
      body: SECRET,
      payload: { method: SECRET },
      links: [{ url: 'https://example.com/answer', title: SECRET }],
      recordedAt: '2025-10-06T00:00:00.000Z',
      resolves: 'l_stuck',
    },
    {
      key: 'l_stuck2',
      tag: 'stuck',
      body: '',
      payload: { symptom: '파이프 fd 누수', keywords: [], timeBucket: 'lt2h' },
      links: [],
      recordedAt: '2025-10-08T00:00:00.000Z',
      resolves: null,
    },
    {
      key: 'l_progress',
      tag: 'progress',
      body: `파서 완성 ${SECRET}`,
      payload: {},
      links: [
        { url: 'https://man7.org/linux/man-pages/man2/wait.2.html', title: '중복' },
        { url: 'https://docs.python.org/3/', title: null },
      ],
      recordedAt: '2025-10-09T00:00:00.000Z',
      resolves: null,
    },
  ],
}

describe('canWriteToCourseHub (policy seam)', () => {
  const course = { id: 'c', mergedInto: null, schoolId: 's1' }
  const verified = { status: 'active' as const, activeSchoolIds: ['s1'] }

  it('requires an active user, a canonical course and an active school-mail affiliation with the course school', () => {
    expect(canWriteToCourseHub(verified, course)).toBe(true)
    expect(hubWriteDecision(verified, course)).toEqual({ ok: true })
    expect(hubWriteDecision({ status: 'active' }, course)).toEqual({ ok: false, reason: 'affiliation_required' })
    expect(hubWriteDecision({ status: 'active', activeSchoolIds: ['s2'] }, course)).toEqual({ ok: false, reason: 'affiliation_required' })
    expect(hubWriteDecision(verified, { id: 'c', mergedInto: null })).toEqual({ ok: false, reason: 'affiliation_required' })
    expect(hubWriteDecision({ ...verified, status: 'suspended' }, course)).toEqual({ ok: false, reason: 'inactive_user' })
    expect(canWriteToCourseHub({ ...verified, status: 'deleted' }, course)).toBe(false)
    expect(canWriteToCourseHub(null, course)).toBe(false)
    expect(hubWriteDecision(verified, { ...course, mergedInto: 'd' })).toEqual({ ok: false, reason: 'not_canonical' })
    expect(canWriteToCourseHub(verified, null)).toBe(false)
  })

  it('can drop the affiliation requirement (local/dev policy flag) but never the user/course checks', () => {
    const open = { requireAffiliation: false }
    expect(canWriteToCourseHub({ status: 'active' }, course, open)).toBe(true)
    expect(canWriteToCourseHub({ status: 'suspended' }, course, open)).toBe(false)
    expect(canWriteToCourseHub({ status: 'active' }, { ...course, mergedInto: 'd' }, open)).toBe(false)
  })
})

describe('senior note answers', () => {
  it('requires at least two non-empty known answers, each ≤1000 chars, and orders them by question', () => {
    expect(normalizeSeniorNoteAnswers({ wishKnew: '  시그널 개념 ', firstWeek: '\r\n과제 명세 정독\r\n' })).toEqual({
      ok: true,
      answers: { firstWeek: '과제 명세 정독', wishKnew: '시그널 개념' },
    })
    expect(normalizeSeniorNoteAnswers({ firstWeek: '하나', timeSink: '   ' })).toEqual({ ok: false, fields: { answers: 'too_few' } })
    expect(normalizeSeniorNoteAnswers({ firstWeek: 'a'.repeat(1001), timeSink: 'b' })).toEqual({ ok: false, fields: { 'answers.firstWeek': 'too_long' } })
    expect(normalizeSeniorNoteAnswers({ firstWeek: 'a', timeSink: 'b', professor: '평가' })).toEqual({ ok: false, fields: { 'answers.professor': 'unknown_key' } })
    expect(normalizeSeniorNoteAnswers({ firstWeek: 1, timeSink: 'b' })).toEqual({ ok: false, fields: { 'answers.firstWeek': 'invalid' } })
    expect(normalizeSeniorNoteAnswers(['a', 'b'])).toEqual({ ok: false, fields: { answers: 'invalid' } })
    expect(normalizeSeniorNoteAnswers({ firstWeek: '가'.repeat(1000), timeSink: 'b' }).ok).toBe(true)
  })

  it('labels anonymous notes "익명 선배" and runs publication checks on answers and typed names', () => {
    expect(seniorNoteAuthorLabel('anonymous', '김선배')).toBe(ANONYMOUS_SENIOR_LABEL)
    expect(seniorNoteAuthorLabel('display', '운체 졸업생')).toBe('운체 졸업생')
    expect(seniorNoteAuthorLabel('name', null)).toBe(ANONYMOUS_SENIOR_LABEL)
    const warnings = runPublicationChecks(
      seniorNoteCheckItems({ answers: { firstWeek: '조교 연락처 010-1234-5678', timeSink: '없음' }, displayName: 'me@school.ac.kr', termLabel: null }),
    )
    expect(warnings.map((w) => [w.rule, w.location.kind, w.location.field])).toEqual([
      ['phone', 'senior_note', 'answers.firstWeek'],
      ['email', 'senior_note', 'displayName'],
    ])
    expect(JSON.stringify(warnings)).not.toContain('1234-5678')
  })
})

describe('stuck cards from the public snapshot', () => {
  it('extracts symptom, keywords, time bucket and resolved flag only', () => {
    const items = extractStuckItems(snapshot)
    expect(items).toEqual([
      { key: 'l_stuck', symptom: '좀비 프로세스가 남음', keywords: ['fork', 'waitpid'], timeBucket: 'half_day', resolved: true, recordedAt: '2025-10-05T00:00:00.000Z' },
      { key: 'l_stuck2', symptom: '파이프 fd 누수', keywords: [], timeBucket: 'lt2h', resolved: false, recordedAt: '2025-10-08T00:00:00.000Z' },
    ])
    expect(JSON.stringify(items)).not.toContain(SECRET)
  })

  it('ranks by usefulness signals then recency (no per-author totals involved)', () => {
    const ranked = rankStuckItems([
      { id: 'old-popular', meToo: 2, helped: 1, recordedAt: '2025-01-01' },
      { id: 'new', meToo: 0, helped: 0, recordedAt: '2025-03-01' },
      { id: 'older', meToo: 0, helped: 0, recordedAt: '2025-02-01' },
      { id: 'tie-new', meToo: 3, helped: 0, recordedAt: '2025-04-01' },
    ])
    expect(ranked.map((r) => r.id)).toEqual(['tie-new', 'old-popular', 'new', 'older'])
  })
})

describe('plan fork whitelist', () => {
  it('copies milestone titles in order with relative day offsets and non-solution reference links, nothing else', () => {
    const plan = forkPlanFromSnapshot(snapshot)
    expect(plan.milestones).toEqual([
      { title: '기획', note: '원래 계획의 첫 예정일(기준)' },
      { title: '중간발표', note: '원래 계획에서 첫 예정일 기준 +14일' },
      { title: '최종 제출', note: null },
    ])
    expect(plan.references).toEqual([
      { url: 'https://man7.org/linux/man-pages/man2/wait.2.html', title: 'wait(2)' },
      { url: 'https://docs.python.org/3/', title: null },
    ])
    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).not.toContain('example.com/answer')
    expect(serialized).not.toContain('2025-10')
    expect(serialized).not.toContain('김소유')
    expect(Object.keys(plan).sort()).toEqual(['milestones', 'references'])
  })

  it('does not invent offsets from a single date and caps references at 10', () => {
    const one = forkPlanFromSnapshot({ ...snapshot, milestones: [{ key: 'a', position: 1, title: '기획', dueAt: '2025-10-01' }], logs: [] })
    expect(one).toEqual({ milestones: [{ title: '기획', note: null }], references: [] })
    const many = forkPlanFromSnapshot({
      ...snapshot,
      logs: [{ ...snapshot.logs[3]!, links: Array.from({ length: 15 }, (_, i) => ({ url: `https://ref.test/${i}`, title: null })) }],
    })
    expect(many.references).toHaveLength(10)
  })

  it('formats the overview note and the fork title within limits', () => {
    expect(formatForkReferences([])).toBeNull()
    expect(formatForkReferences([{ url: 'https://a.test', title: 'A' }, { url: 'https://b.test', title: null }])).toBe(
      '참고 자료(포크한 계획에서 가져옴):\n- A https://a.test\n- https://b.test',
    )
    expect(forkProjectTitle('셸 구현 과제')).toBe('셸 구현 과제 계획 포크')
    const long = forkProjectTitle('가'.repeat(200))
    expect([...long].length).toBe(120)
    expect(long.endsWith('… 계획 포크')).toBe(true)
  })
})

describe('signals and search documents', () => {
  it('allows me_too only on stuck cards', () => {
    expect(isAllowedSignal('stuck_item', 'me_too')).toBe(true)
    expect(isAllowedSignal('stuck_item', 'helped')).toBe(true)
    expect(isAllowedSignal('senior_note', 'helped')).toBe(true)
    expect(isAllowedSignal('senior_note', 'me_too')).toBe(false)
    // C-09: 막힘 Q&A는 막힘 카드처럼 두 신호 모두
    expect(isAllowedSignal('course_qa', 'me_too')).toBe(true)
    expect(isAllowedSignal('course_qa', 'helped')).toBe(true)
  })

  it('indexes the case and each stuck card from the snapshot only', () => {
    const docs = searchDocsFromSnapshot(snapshot)
    expect(docs.map((d) => [d.kind, d.itemKey])).toEqual([
      ['case', null],
      ['stuck', 'l_stuck'],
      ['stuck', 'l_stuck2'],
    ])
    expect(docs[1]!.searchText).toBe('좀비 프로세스가 남음 fork waitpid')
    expect(JSON.stringify(docs)).not.toContain(SECRET)
    expect(normalizeSearchText('  ＦＯＲＫ\n 에러 ')).toBe('fork 에러')
    expect(searchDocFromSeniorNote({ answers: { timeSink: '파이프', wishKnew: '시그널' }, termLabel: '2025년 2학기' })).toEqual({
      title: '선배 노트 · 2025년 2학기',
      snippet: '파이프',
      searchText: '2025년 2학기 파이프 시그널',
    })
  })
})
