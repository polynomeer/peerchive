/**
 * A-06 수료 회고·현직자 답변 이동 규칙(ADR 0043): 평가 필드 낱말 판정, 답 정규화(모르는 키 거부), 작성자 표시, 선배 노트 소속 표시 방식의 표시·투영 규칙.
 */
import { describe, expect, it } from 'vitest'
import {
  ANONYMOUS_RETRO_LABEL,
  ANONYMOUS_SENIOR_LABEL,
  COMPLETION_RETRO_QUESTIONS,
  COMPLETION_RETRO_QUESTION_LABELS,
  SENIOR_NOTE_ALL_DISPLAY_MODES,
  SENIOR_NOTE_DISPLAY_MODES,
  completionRetroAuthorLabel,
  decidePersonaActivityProjection,
  isEvaluationFieldName,
  isPersonaSeniorNoteMode,
  normalizeCompletionRetroAnswers,
  seniorNoteAuthorLabel,
} from '../src/index'

describe('completion retro: no evaluation fields', () => {
  it('detects rating/salary/score words in snake_case and camelCase, not lookalikes', () => {
    for (const name of ['rating', 'star_rating', 'stars', 'salaryRange', 'expected_salary', 'nps', 'recommendScore', 'recommendation', 'pay', 'wage', 'income', 'grade', 'compensation'])
      expect(isEvaluationFieldName(name), name).toBe(true)
    for (const name of ['beforeStart', 'status', 'started_at', 'display_mode', 'institution_label', 'learned', 'curriculum', 'advice', 'payload'])
      expect(isEvaluationFieldName(name), name).toBe(false)
  })

  it('question keys and labels carry no evaluation field', () => {
    expect(COMPLETION_RETRO_QUESTIONS).toEqual(['learned', 'curriculum', 'beforeStart', 'advice'])
    for (const q of COMPLETION_RETRO_QUESTIONS) {
      expect(isEvaluationFieldName(q)).toBe(false)
      expect(COMPLETION_RETRO_QUESTION_LABELS[q]).not.toMatch(/별점|연봉|추천 점수|평점/)
    }
  })

  it('normalizes answers: known keys only, trimmed, ≤1000, at least two', () => {
    expect(normalizeCompletionRetroAnswers({ advice: '  조언 ', learned: '배움\r\n둘째 줄' })).toEqual({ ok: true, answers: { learned: '배움\n둘째 줄', advice: '조언' } })
    expect(normalizeCompletionRetroAnswers({ learned: '하나', stars: 5 })).toEqual({ ok: false, fields: { 'answers.stars': 'unknown' } })
    expect(normalizeCompletionRetroAnswers({ learned: '하나', curriculum: '  ' })).toEqual({ ok: false, fields: { answers: 'too_few' } })
    expect(normalizeCompletionRetroAnswers({ learned: 'a'.repeat(1001), curriculum: 'b' })).toEqual({ ok: false, fields: { 'answers.learned': 'too_long' } })
    expect(normalizeCompletionRetroAnswers({ learned: 3, curriculum: 'b' })).toEqual({ ok: false, fields: { 'answers.learned': 'invalid' } })
    expect(normalizeCompletionRetroAnswers(['learned'])).toEqual({ ok: false, fields: { answers: 'invalid' } })
  })

  it('author label: anonymous is always the fixed label', () => {
    expect(completionRetroAuthorLabel('anonymous', '이름')).toBe(ANONYMOUS_RETRO_LABEL)
    expect(completionRetroAuthorLabel('display', '밤의수료생')).toBe('밤의수료생')
    expect(completionRetroAuthorLabel('name', null)).toBe(ANONYMOUS_RETRO_LABEL)
  })
})

describe('senior note affiliation mode (topic answer kept at level 1)', () => {
  it('is not a direct-write mode and never maps to a persona', () => {
    expect(SENIOR_NOTE_DISPLAY_MODES).not.toContain('affiliation')
    expect(SENIOR_NOTE_ALL_DISPLAY_MODES).toContain('affiliation')
    expect(SENIOR_NOTE_ALL_DISPLAY_MODES.filter(isPersonaSeniorNoteMode)).toEqual(['name', 'display'])
  })

  it('shows only the copied label (or the anonymous label when the original had none)', () => {
    expect(seniorNoteAuthorLabel('affiliation', null, '○○대학교 · 졸업생')).toBe('○○대학교 · 졸업생')
    expect(seniorNoteAuthorLabel('affiliation', '이름', null)).toBe(ANONYMOUS_SENIOR_LABEL)
    expect(seniorNoteAuthorLabel('name', '이름', '○○대학교 · 졸업생')).toBe('이름')
  })

  it('is refused by the projection rule for both persona kinds', () => {
    for (const kind of ['real', 'display'] as const) {
      expect(decidePersonaActivityProjection({ type: 'senior_note', displayMode: 'affiliation', published: true }, { id: 'p', kind })).toEqual({ project: false, reason: 'anonymous' })
    }
    expect(decidePersonaActivityProjection({ type: 'senior_note', displayMode: 'name', published: true }, { id: 'p', kind: 'real' }).project).toBe(true)
  })
})
