/**
 * 주간 기여 요약 문장(pilot-kit-e0 §4.1) 단위 테스트. DB 없이 실행합니다.
 */
import { describe, expect, it } from 'vitest'
import { claimStatusText, formatWeeklySummary, memberActivityLine } from '../server/modules/contribution/weekly-summary'
import type { ClaimDto, ContributionDto, LedgerMemberDto, LogTag } from '../shared/types/api'

const counts = (partial: Partial<Record<LogTag, number>>): Record<LogTag, number> => ({
  progress: 0,
  stuck: 0,
  solution: 0,
  decision: 0,
  meeting: 0,
  validation: 0,
  retro: 0,
  ...partial,
})

const person = (userId: string, displayName: string) => ({ userId, displayName, handle: null })

const claim = (text: string, status: ClaimDto['status'], confirmedCount = 0): ClaimDto => ({
  id: crypto.randomUUID(),
  projectId: 'p',
  author: person('a', '가람'),
  authorActive: true,
  revisionId: 'r',
  revisionNo: 1,
  revisionCount: 1,
  text,
  createdAt: '2026-10-19T00:00:00.000Z',
  recordedAt: '2026-10-19T00:00:00.000Z',
  evidence: [],
  endorsements: [],
  status,
  confirmedCount,
  disputedCount: status === 'disputed' ? 1 : 0,
  canRevise: false,
  canEndorse: false,
  myEndorsement: null,
})

const member = (overrides: Partial<LedgerMemberDto> & Pick<LedgerMemberDto, 'member'>): LedgerMemberDto => ({
  active: true,
  logCounts: counts({}),
  stuckResolved: 0,
  tasksCompleted: 0,
  artifactsUploaded: 0,
  meetingsAttended: 0,
  claims: [],
  ...overrides,
})

const data: ContributionDto = {
  project: { id: 'p', title: '캡스톤 A팀' },
  period: { from: '2026-10-19', to: '2026-10-25', timeZone: 'Asia/Seoul', weekNo: 3 },
  generatedAt: '2026-10-20T03:00:00.000Z',
  members: [
    member({
      member: person('a', '가람'),
      logCounts: counts({ progress: 2, stuck: 1, decision: 1 }),
      stuckResolved: 1,
      claims: [claim('API 입력 검증', 'confirmed', 1)],
    }),
    member({
      member: person('b', '나래'),
      logCounts: counts({ progress: 1, meeting: 1 }),
      tasksCompleted: 2,
      meetingsAttended: 1,
    }),
    member({ member: person('c', '다온'), active: false, artifactsUploaded: 1, claims: [claim('발표  자료\n정리', 'disputed')] }),
    member({ member: person('d', '라온'), claims: [claim('테스트 계획', 'unconfirmed')] }),
  ],
  unresolvedStuck: [
    { id: 's', summary: '지도 API 쿼터 초과', author: person('b', '나래'), createdAt: '2026-10-19T01:00:00.000Z', openDays: 2 },
  ],
  milestone: { title: '중간발표', dueAt: '2026-10-28', snapshotsInPeriod: 1 },
  disclaimer: '※ 개수는 참고용이며 기여의 크기를 뜻하지 않습니다.',
}

describe('formatWeeklySummary', () => {
  it('follows the pilot-kit §4.1 layout with kinds and counts only', () => {
    expect(formatWeeklySummary(data)).toBe(
      [
        '[캡스톤 A팀] 주간 기여 요약 — 3주차 (10-19 ~ 10-25)',
        '마일스톤: 중간발표 (예정 10-28) — 스냅샷 1개 등록',
        '',
        '가람  🔨진행 2 · 🧱막힘 1(해결 1) · ⚖️결정 1',
        '     역할 선언 “API 입력 검증” — 팀원 확인 1명',
        '나래  🔨진행 1 · 🗣️회의 정리 1 · ☑️할 일 완료 2 · 👥회의 참석 1',
        '     역할 선언 없음',
        '다온(나간 멤버)  📎파일 1',
        '     역할 선언 “발표 자료 정리” — 이의 있음',
        '라온  기록 없음',
        '     역할 선언 “테스트 계획” — 본인 설명 · 미확인',
        '미해결 막힘: “지도 API 쿼터 초과” (나래, 2일째)',
        '',
        '※ 개수는 참고용이며 기여의 크기를 뜻하지 않습니다.',
      ].join('\n'),
    )
  })

  it('keeps the member order it was given (name order), never re-sorting by activity', () => {
    const text = formatWeeklySummary(data)
    const order = ['가람', '나래', '다온', '라온'].map((name) => text.indexOf(`\n${name}`))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text).not.toMatch(/%|순위|점수/)
  })

  it('handles custom ranges, no milestone, many unresolved items and the disclaimer', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...data.unresolvedStuck[0]!, id: `s${i}`, summary: `막힘 ${i}` }))
    const text = formatWeeklySummary({
      ...data,
      period: { ...data.period, from: '2026-09-01', to: '2026-10-31', weekNo: null },
      milestone: { title: '최종제출', dueAt: null, snapshotsInPeriod: 0 },
      members: [],
      unresolvedStuck: many,
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe('[캡스톤 A팀] 기여 요약 (09-01 ~ 10-31)')
    expect(lines[1]).toBe('마일스톤: 최종제출 (예정일 없음)')
    expect(lines).toContain('멤버 없음')
    expect(lines.filter((l) => l.startsWith('미해결 막힘: '))).toHaveLength(5)
    expect(lines).toContain('미해결 막힘 외 2건')
    expect(lines.at(-1)).toBe('※ 개수는 참고용이며 기여의 크기를 뜻하지 않습니다.')
  })

  it('describes claim status in words', () => {
    expect(claimStatusText({ status: 'confirmed', confirmedCount: 3 })).toBe('팀원 확인 3명')
    expect(claimStatusText({ status: 'disputed', confirmedCount: 3 })).toBe('이의 있음')
    expect(claimStatusText({ status: 'unconfirmed', confirmedCount: 0 })).toBe('본인 설명 · 미확인')
    expect(memberActivityLine({ logCounts: counts({ stuck: 2 }), stuckResolved: 0, tasksCompleted: 0, artifactsUploaded: 0, meetingsAttended: 0 })).toBe(
      '🧱막힘 2',
    )
  })
})
