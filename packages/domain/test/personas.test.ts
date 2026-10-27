import { describe, expect, it } from 'vitest'
import {
  HANDLE_MAX,
  PERSONA_KINDS,
  RESERVED_HANDLES,
  canSeeIdentityLink,
  checkHandle,
  isLookupHandle,
  otherPersonaKind,
} from '../src'

describe('checkHandle (S-01: 두 종류 페르소나 공통 handle 규칙)', () => {
  it('정규화(공백·대문자)한 값을 돌려준다', () => {
    expect(checkHandle('  DevJimin ')).toEqual({ ok: true, value: 'devjimin' })
    expect(checkHandle('dev-jimin-2')).toEqual({ ok: true, value: 'dev-jimin-2' })
  })

  it('길이·형식·예약어를 거부한다', () => {
    expect(checkHandle('ab')).toEqual({ ok: false, reason: 'too_short' })
    expect(checkHandle('a'.repeat(HANDLE_MAX + 1))).toEqual({ ok: false, reason: 'too_long' })
    expect(checkHandle('a'.repeat(HANDLE_MAX))).toEqual({ ok: true, value: 'a'.repeat(HANDLE_MAX) })
    for (const bad of ['-abc', 'abc-', 'a--b', 'a_b', 'a.b', '지민이', 'a b c']) {
      expect(checkHandle(bad), bad).toEqual({ ok: false, reason: 'invalid_format' })
    }
    for (const word of ['settings', 'admin', 'login', 'api', 'Search']) expect(checkHandle(word), word).toEqual({ ok: false, reason: 'reserved' })
    expect(checkHandle(42)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkHandle(null)).toEqual({ ok: false, reason: 'invalid' })
  })

  it('예약어 목록은 모두 소문자다(정규화한 값과 비교하므로)', () => {
    for (const word of RESERVED_HANDLES) expect(word).toBe(word.toLowerCase())
  })

  it('조회용 모양 검사는 길이·형식만 본다', () => {
    expect(isLookupHandle('dev-jimin')).toBe(true)
    expect(isLookupHandle('Dev')).toBe(false)
    expect(isLookupHandle('a'.repeat(31))).toBe(false)
    expect(isLookupHandle(undefined)).toBe(false)
  })
})

describe('canSeeIdentityLink (§8.3 표시명 ↔ 실명 연결 보기)', () => {
  const anyone = { isOwner: false }
  const owner = { isOwner: true }

  it('연결이 꺼져 있거나 없으면 본인 말고는 아무도 못 본다', () => {
    expect(canSeeIdentityLink({ visible: false }, anyone)).toBe(false)
    expect(canSeeIdentityLink(null, anyone)).toBe(false)
  })

  it('연결을 켜면 누구나 본다', () => {
    expect(canSeeIdentityLink({ visible: true }, anyone)).toBe(true)
  })

  it('본인은 늘 본다', () => {
    expect(canSeeIdentityLink({ visible: false }, owner)).toBe(true)
    expect(canSeeIdentityLink(null, owner)).toBe(true)
  })
})

describe('페르소나 종류', () => {
  it('real과 display 두 가지이고 서로가 상대 종류다', () => {
    expect(PERSONA_KINDS).toEqual(['real', 'display'])
    expect(otherPersonaKind('real')).toBe('display')
    expect(otherPersonaKind('display')).toBe('real')
  })
})
