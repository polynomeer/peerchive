import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_LABEL,
  followUpLine,
  meetingConsentState,
  meetingDraftToLogInput,
  memberLabel,
  mentionedUserIds,
  normalizeDiscordContent,
  parseMeetingLabel,
  replaceMeetingLabels,
  validDueDate,
} from '../src/ai-meeting'

describe('AI meeting summary rules (E-13, ADR 0058)', () => {
  it('consent: every current active member must agree; a newcomer or a revocation blocks', () => {
    expect(meetingConsentState(['a', 'b'], ['a', 'b'])).toEqual({ allAgreed: true, missing: [] })
    expect(meetingConsentState(['a', 'b'], ['a'])).toEqual({ allAgreed: false, missing: ['b'] })
    // 나간 멤버의 예전 동의는 세지 않고 새 멤버는 미동의.
    expect(meetingConsentState(['a', 'c'], ['a', 'b'])).toEqual({ allAgreed: false, missing: ['c'] })
    expect(meetingConsentState([], ['a'])).toEqual({ allAgreed: false, missing: [] })
  })

  it('normalizes Discord content: mentions → labels, roles/channels/emoji/timestamps, control characters, length', () => {
    const labelFor = (id: string) => (id === '222222' ? memberLabel(2) : EXTERNAL_LABEL)
    expect(normalizeDiscordContent('<@222222> 그리고 <@!333333> <@&444444> <#555555> <:party:666666> <t:1700000000:R>\u0007 ', labelFor)).toBe(
      '[M2] 그리고 [외부] @역할 #채널 :party: (시각)',
    )
    expect(normalizeDiscordContent('줄1\n줄2', labelFor)).toBe('줄1\n줄2')
    expect(normalizeDiscordContent('가'.repeat(30), labelFor, 10)).toBe(`${'가'.repeat(9)}…`)
    expect(mentionedUserIds('<@222222> <@!333333> <@222222> <@&444444>')).toEqual(['222222', '333333'])
  })

  it('maps model labels back to names and parses owner labels', () => {
    const name = (n: number) => (n === 1 ? '김주인' : null)
    expect(replaceMeetingLabels('[M1]이 [외부]에게 묻고 [M9]가 답함, [외부2]도', name)).toBe('김주인이 외부 참여자에게 묻고 팀원가 답함, 외부 참여자도')
    expect(parseMeetingLabel('[M3]')).toEqual({ kind: 'member', n: 3 })
    expect(parseMeetingLabel('M3')).toEqual({ kind: 'member', n: 3 })
    expect(parseMeetingLabel('[외부]')).toEqual({ kind: 'external' })
    expect(parseMeetingLabel('[외부1]')).toEqual({ kind: 'external' })
    expect(parseMeetingLabel('김주인')).toBeNull()
    expect(parseMeetingLabel(null)).toBeNull()
  })

  it('builds the meeting-log input: summary, open questions, external/attachment notes, follow-up lines within limits', () => {
    const nameOf = (id: string) => ({ u1: '김주인', u2: '이편집' })[id] ?? null
    const input = meetingDraftToLogInput(
      {
        summary: '로그인 API 일정 논의',
        decisions: ['세션 쿠키 사용'],
        followUps: [
          { text: '로그인 API 구현', ownerId: 'u2', due: '2026-10-23' },
          { text: '배포 문서', ownerId: null, due: null },
        ],
        openQuestions: ['CORS 설정은 누가?'],
        attendees: ['u1', 'u2', 'u1'],
        excludedMessages: 2,
        attachmentsOmitted: 3,
      },
      nameOf,
    )
    expect(input.body).toBe('로그인 API 일정 논의\n\n열린 질문\n- CORS 설정은 누가?\n\n팀 밖 참여자 메시지 2개 제외 · 첨부 3개 생략')
    expect(input.payload).toEqual({
      attendees: ['u1', 'u2'],
      decisions: ['세션 쿠키 사용'],
      followUps: ['로그인 API 구현 — 담당 이편집, 기한 2026-10-23', '배포 문서'],
    })
    expect(followUpLine({ text: 'x'.repeat(600), ownerId: null, due: null }, nameOf)).toHaveLength(500)
  })

  it('accepts only real calendar due dates', () => {
    expect(validDueDate('2026-10-23')).toBe('2026-10-23')
    expect(validDueDate('2026-02-30')).toBeNull()
    expect(validDueDate('금요일')).toBeNull()
    expect(validDueDate(null)).toBeNull()
  })
})
