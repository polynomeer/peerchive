import { describe, expect, it } from 'vitest'
import { CanonicalJsonError, canonicalJson } from '../src'

describe('canonicalJson', () => {
  it('sorts object keys recursively so insertion order does not matter', () => {
    const a = { b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } }
    const b = { a: { c: 'x', d: [3, { y: null, z: true }] }, b: 1 }
    expect(canonicalJson(a)).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}')
    expect(canonicalJson(b)).toBe(canonicalJson(a))
  })

  it('keeps array order (callers sort unordered lists themselves)', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]))
  })

  it('is stable across JSON round trips (what the database jsonb gives back)', () => {
    const value = { title: '도서관 혼잡도 "웹앱"\n', n: 0.1 + 0.2, list: ['가', 'a', 'A'], nested: { 'ㄱ': 1, a: 2, Z: 3 } }
    const roundTripped = JSON.parse(JSON.stringify(value)) as unknown
    expect(canonicalJson(roundTripped)).toBe(canonicalJson(value))
    // 반복 호출도 같은 문자열.
    expect(canonicalJson(value)).toBe(canonicalJson(value))
  })

  it('drops undefined object values, normalizes -0, keeps unicode as written', () => {
    expect(canonicalJson({ a: undefined, b: -0 })).toBe('{"b":0}')
    // NFC/NFD는 서로 다른 내용으로 봅니다(보이는 그대로 해시).
    expect(canonicalJson('é')).not.toBe(canonicalJson('é'))
  })

  it('rejects values that have no single JSON form', () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError)
    expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(BigInt(1))).toThrow(CanonicalJsonError)
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError)
  })

  it('allows the same object twice when it is not a cycle', () => {
    const shared = { a: 1 }
    expect(canonicalJson({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}')
  })
})
