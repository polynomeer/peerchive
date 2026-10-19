/**
 * 빌드 로그 입력 검증(태그별 payload, 링크, 수행일) 단위 테스트. DB가 필요 없습니다.
 */
import { describe, expect, it } from 'vitest'
import { ServiceError } from '../server/modules/errors'
import {
  createLogSchema,
  isAllowedLinkUrl,
  latestAllowedClaimedDate,
  listLogsQuerySchema,
  validateLogContent,
} from '../server/modules/logs/payloads'
import { decodeCursor, encodeCursor } from '../server/modules/logs/logs'
import { parseInput } from '../server/modules/validation'

const NOW = new Date('2026-10-19T03:00:00Z')
const ID = '5b0c8f1e-2f7a-4d55-9d37-0f3d4b7a9c11'

type Tag = Parameters<typeof validateLogContent>[0]

function check(tag: Tag, payload: unknown, extra: Partial<Parameters<typeof validateLogContent>[1]> = {}) {
  return validateLogContent(
    tag,
    { body: '', payload, links: [], claimedDate: null, resolvesEntryId: null, ...extra },
    NOW,
  )
}
const fieldsOf = (result: ReturnType<typeof check>) => result.fields ?? {}

function parseError(input: unknown): Record<string, string> {
  try {
    parseInput(createLogSchema, input)
  } catch (error) {
    if (error instanceof ServiceError) return error.fields ?? {}
    throw error
  }
  throw new Error('expected validation error')
}

describe('progress / retro', () => {
  it.each(['progress', 'retro'] as const)('%s needs a body and takes an empty payload', (tag) => {
    expect(check(tag, undefined, { body: '로그인 API 완성' }).content?.payload).toEqual({})
    expect(check(tag, {}, { body: 'x' }).content).not.toBeNull()
    expect(fieldsOf(check(tag, {}))).toEqual({ body: 'required' })
    expect(fieldsOf(check(tag, { note: 'x' }, { body: 'x' }))).toEqual({ payload: 'unknown_key' })
  })
})

describe('stuck', () => {
  const valid = { symptom: 'CORS 에러', keywords: ['cors', 'proxy'], attempts: ['프록시 설정'], timeBucket: 'lt2h' }

  it('accepts a minimal stuck payload; body is optional and answerCheck defaults to false', () => {
    const result = check('stuck', { symptom: '  빌드 실패 ', timeBucket: 'lt30m' })
    expect(result.content?.payload).toEqual({
      symptom: '빌드 실패',
      keywords: [],
      attempts: [],
      timeBucket: 'lt30m',
      answerCheck: false,
    })
    expect(check('stuck', { ...valid, errorText: 'Access-Control-Allow-Origin', answerCheck: true }).content).not.toBeNull()
  })

  it('drops an empty optional errorText instead of storing it', () => {
    expect(check('stuck', { ...valid, errorText: '  ' }).content?.payload).not.toHaveProperty('errorText')
  })

  it('reports field-specific codes', () => {
    expect(fieldsOf(check('stuck', undefined))).toEqual({ payload: 'required' })
    expect(fieldsOf(check('stuck', { ...valid, symptom: '' }))).toEqual({ 'payload.symptom': 'required' })
    expect(fieldsOf(check('stuck', { ...valid, symptom: 'x'.repeat(201) }))).toEqual({ 'payload.symptom': 'too_long' })
    expect(fieldsOf(check('stuck', { ...valid, keywords: Array(11).fill('k') }))).toEqual({ 'payload.keywords': 'too_many' })
    expect(fieldsOf(check('stuck', { ...valid, keywords: ['x'.repeat(41)] }))).toEqual({ 'payload.keywords.0': 'too_long' })
    expect(fieldsOf(check('stuck', { ...valid, attempts: ['x'.repeat(501)] }))).toEqual({ 'payload.attempts.0': 'too_long' })
    expect(fieldsOf(check('stuck', { ...valid, errorText: 'x'.repeat(2001) }))).toEqual({ 'payload.errorText': 'too_long' })
    expect(fieldsOf(check('stuck', { ...valid, timeBucket: 'week' }))).toEqual({ 'payload.timeBucket': 'invalid' })
    expect(fieldsOf(check('stuck', { symptom: 'x' }))).toEqual({ 'payload.timeBucket': 'required' })
    expect(fieldsOf(check('stuck', { ...valid, answerCheck: 'yes' }))).toEqual({ 'payload.answerCheck': 'invalid' })
    expect(fieldsOf(check('stuck', { ...valid, solution: '정답 코드' }))).toEqual({ payload: 'unknown_key' })
    expect(fieldsOf(check('stuck', 'CORS'))).toEqual({ payload: 'invalid' })
  })

  it('does not accept resolvesEntryId', () => {
    expect(fieldsOf(check('stuck', valid, { resolvesEntryId: ID }))).toEqual({ resolvesEntryId: 'not_allowed' })
  })
})

describe('solution', () => {
  const valid = { method: '서버에 CORS 헤더 추가', notAnswerConfirmed: true }

  it('requires a method, the answer confirmation and a stuck log to resolve', () => {
    expect(check('solution', valid, { resolvesEntryId: ID }).content?.payload).toEqual(valid)
    expect(check('solution', { ...valid, timeBucket: 'half_day' }, { resolvesEntryId: ID }).content).not.toBeNull()
    expect(fieldsOf(check('solution', valid))).toEqual({ resolvesEntryId: 'required' })
    expect(fieldsOf(check('solution', { method: 'x' }, { resolvesEntryId: ID }))).toEqual({
      'payload.notAnswerConfirmed': 'confirm_required',
    })
    expect(fieldsOf(check('solution', { ...valid, notAnswerConfirmed: false }, { resolvesEntryId: ID }))).toEqual({
      'payload.notAnswerConfirmed': 'confirm_required',
    })
    expect(fieldsOf(check('solution', { ...valid, method: 'x'.repeat(2001) }, { resolvesEntryId: ID }))).toEqual({
      'payload.method': 'too_long',
    })
    expect(fieldsOf(check('solution', { ...valid, code: '...' }, { resolvesEntryId: ID }))).toEqual({
      payload: 'unknown_key',
    })
  })
})

describe('decision', () => {
  const valid = { options: ['실시간 센서', '수동 입력'], criteria: '한 학기 안의 구현 가능성', choice: '수동 입력' }

  it('accepts 2–6 options and a free-text choice', () => {
    expect(check('decision', valid).content).not.toBeNull()
    expect(check('decision', { ...valid, choice: '둘 다 버리고 제3안', hindsight: '센서가 나았다' }).content).not.toBeNull()
  })

  it('rejects too few/many options and over-long fields', () => {
    expect(fieldsOf(check('decision', { ...valid, options: ['하나'] }))).toEqual({ 'payload.options': 'too_few' })
    expect(fieldsOf(check('decision', { ...valid, options: Array(7).fill('o') }))).toEqual({ 'payload.options': 'too_many' })
    expect(fieldsOf(check('decision', { ...valid, options: ['a', 'x'.repeat(201)] }))).toEqual({ 'payload.options.1': 'too_long' })
    expect(fieldsOf(check('decision', { ...valid, criteria: 'x'.repeat(1001) }))).toEqual({ 'payload.criteria': 'too_long' })
    expect(fieldsOf(check('decision', { ...valid, choice: 'x'.repeat(201) }))).toEqual({ 'payload.choice': 'too_long' })
    expect(fieldsOf(check('decision', { ...valid, hindsight: 'x'.repeat(2001) }))).toEqual({ 'payload.hindsight': 'too_long' })
    expect(fieldsOf(check('decision', { options: ['a', 'b'] }))).toEqual({
      'payload.criteria': 'required',
      'payload.choice': 'required',
    })
  })
})

describe('validation', () => {
  const valid = { target: '지도 화면', conditions: '사용자 5명, 모바일', result: '2명이 버튼을 못 찾음' }

  it('requires target/conditions/result, openQuestions is optional', () => {
    expect(check('validation', valid).content).not.toBeNull()
    expect(check('validation', { ...valid, openQuestions: '아이콘 크기?' }).content).not.toBeNull()
    expect(fieldsOf(check('validation', { ...valid, result: '' }))).toEqual({ 'payload.result': 'required' })
    expect(fieldsOf(check('validation', { ...valid, target: 'x'.repeat(1001) }))).toEqual({ 'payload.target': 'too_long' })
    expect(fieldsOf(check('validation', { ...valid, open_questions: 'x' }))).toEqual({ payload: 'unknown_key' })
  })
})

describe('meeting', () => {
  it('accepts attendee ids, decisions and follow-ups (duplicates merged)', () => {
    const result = check('meeting', { attendees: [ID, ID.toUpperCase()], decisions: ['MySQL로 결정'], followUps: [] })
    expect(result.content?.payload).toEqual({ attendees: [ID], decisions: ['MySQL로 결정'], followUps: [] })
    expect(check('meeting', {}).content?.payload).toEqual({ attendees: [], decisions: [], followUps: [] })
  })

  it('rejects non-uuid attendees and too many items', () => {
    expect(fieldsOf(check('meeting', { attendees: ['alice'] }))).toEqual({ 'payload.attendees.0': 'invalid' })
    expect(fieldsOf(check('meeting', { decisions: Array(21).fill('d') }))).toEqual({ 'payload.decisions': 'too_many' })
    expect(fieldsOf(check('meeting', { followUps: Array(21).fill('f') }))).toEqual({ 'payload.followUps': 'too_many' })
  })
})

describe('body, links and claimedDate', () => {
  it('limits the body to 5000 characters', () => {
    expect(parseError({ tag: 'progress', body: 'x'.repeat(5001) })).toEqual({ body: 'too_long' })
  })

  it('accepts only http/https links without credentials and normalizes them', () => {
    const input = parseInput(createLogSchema, {
      tag: 'progress',
      body: 'x',
      links: [{ url: ' https://Example.com/a b ', title: ' 설계 문서 ' }, { url: 'http://localhost:3000/x' }],
    })
    expect(input.links).toEqual([
      { url: 'https://example.com/a%20b', title: '설계 문서' },
      { url: 'http://localhost:3000/x', title: null },
    ])
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://x.test/a', 'https://u:p@x.test/', 'not a url']) {
      expect(isAllowedLinkUrl(url)).toBe(false)
    }
    expect(parseError({ tag: 'progress', body: 'x', links: [{ url: 'javascript:alert(1)' }] })).toEqual({
      'links.0.url': 'invalid_url',
    })
    expect(parseError({ tag: 'progress', body: 'x', links: Array(11).fill({ url: 'https://x.test' }) })).toEqual({
      links: 'too_many',
    })
    expect(parseError({ tag: 'progress', body: 'x', links: [{ url: 'https://x.test', title: 'x'.repeat(201) }] })).toEqual({
      'links.0.title': 'too_long',
    })
    expect(parseError({ tag: 'progress', body: 'x', links: [{ url: 'https://x.test', fetch: true }] })).toEqual({
      'links.0': 'unknown_key',
    })
  })

  it('accepts real calendar dates up to one day ahead (UTC)', () => {
    expect(latestAllowedClaimedDate(NOW)).toBe('2026-10-20')
    expect(check('progress', {}, { body: 'x', claimedDate: '2026-10-20' }).content).not.toBeNull()
    expect(fieldsOf(check('progress', {}, { body: 'x', claimedDate: '2026-10-21' }))).toEqual({ claimedDate: 'too_far_future' })
    // 이전 revision에서 이어받은 값은 시간이 지나도 다시 거부하지 않습니다.
    const carried = validateLogContent(
      'progress',
      { body: 'x', payload: {}, links: [], claimedDate: '2026-10-25', resolvesEntryId: null },
      NOW,
      '2026-10-25',
    )
    expect(carried.content).not.toBeNull()
    expect(parseError({ tag: 'progress', body: 'x', claimedDate: '2026-02-30' })).toEqual({ claimedDate: 'invalid_format' })
    expect(parseError({ tag: 'progress', body: 'x', claimedDate: '2026/10/19' })).toEqual({ claimedDate: 'invalid_format' })
  })

  it('rejects unknown tags and malformed clientId', () => {
    expect(parseError({ tag: 'todo' })).toEqual({ tag: 'invalid' })
    expect(parseError({})).toEqual({ tag: 'required' })
    expect(parseError({ tag: 'progress', body: 'x', clientId: 'abc' })).toEqual({ clientId: 'invalid' })
  })
})

describe('list query and cursor', () => {
  it('defaults limit to 20 and caps it at 50', () => {
    expect(parseInput(listLogsQuerySchema, {}).limit).toBe(20)
    expect(parseInput(listLogsQuerySchema, { limit: '50' }).limit).toBe(50)
    expect(() => parseInput(listLogsQuerySchema, { limit: '51' })).toThrow(ServiceError)
    expect(() => parseInput(listLogsQuerySchema, { tag: 'todo' })).toThrow(ServiceError)
  })

  it('round-trips the cursor and rejects tampered values', () => {
    const at = new Date('2026-10-19T03:00:00.123Z')
    expect(decodeCursor(encodeCursor(at, ID))).toEqual({ createdAt: at.toISOString(), id: ID })
    expect(decodeCursor('not-a-cursor')).toBeNull()
    expect(decodeCursor(Buffer.from(`yesterday|${ID}`).toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from(`${at.toISOString()}|1 or 1=1`).toString('base64url'))).toBeNull()
  })
})
