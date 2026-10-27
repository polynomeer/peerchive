/** S-06 링크 수집기의 주소 판정(ADR 0034). DB·네트워크 없음. */
import { describe, expect, it } from 'vitest'
import { classifyAddress, parseIPv4, parseIPv6 } from '../src/net/ip-ranges'

const allowed = (a: string) => classifyAddress(a).allowed

describe('parseIPv4 / parseIPv6', () => {
  it('accepts only canonical dotted-quad IPv4 (no octal/hex/short/decimal spellings)', () => {
    expect(parseIPv4('192.168.1.1')).toBe(0xc0a80101)
    expect(parseIPv4('0.0.0.0')).toBe(0)
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff)
    for (const bad of ['0177.0.0.1', '0x7f.0.0.1', '127.1', '2130706433', '256.0.0.1', '1.2.3.4.5', '', '01.2.3.4']) expect(parseIPv4(bad), bad).toBeNull()
  })
  it('parses IPv6 including :: and an embedded IPv4 tail; rejects zone ids and junk', () => {
    expect(parseIPv6('::1')).toBe(1n)
    expect(parseIPv6('::')).toBe(0n)
    expect(parseIPv6('::ffff:127.0.0.1')).toBe((0xffffn << 32n) | 0x7f000001n)
    expect(parseIPv6('2001:db8::8a2e:370:7334')).toBe(0x20010db80000000000008a2e03707334n)
    expect(parseIPv6('1:2:3:4:5:6:7:8')).toBe(0x00010002000300040005000600070008n)
    for (const bad of ['fe80::1%eth0', '1:2:3:4:5:6:7:8:9', '1::2::3', 'gggg::', '12345::', '::ffff:999.0.0.1', '1:2:3:4:5:6:7']) expect(parseIPv6(bad), bad).toBeNull()
  })
})

describe('classifyAddress (S-06 SSRF)', () => {
  it('allows public unicast IPv4', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0', '169.253.255.255', '11.0.0.0', '223.255.255.255']) {
      expect(classifyAddress(a), a).toEqual({ allowed: true, family: 4 })
    }
  })
  it('blocks private, loopback, link-local, CGNAT, this-network, documentation, benchmarking, multicast and reserved IPv4', () => {
    for (const a of [
      '0.0.0.0',
      '0.255.255.255',
      '10.0.0.1',
      '10.255.255.255',
      '100.64.0.1', // CGNAT 100.64/10
      '100.127.255.255',
      '127.0.0.1',
      '127.255.255.254',
      '169.254.169.254', // 클라우드 메타데이터
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.0.1',
      '198.18.0.1',
      '198.19.255.255',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '239.255.255.250',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(allowed(a), a).toBe(false)
    }
    expect(classifyAddress('10.1.2.3')).toEqual({ allowed: false, reason: 'private' })
    expect(classifyAddress('240.0.0.1')).toEqual({ allowed: false, reason: 'reserved' })
  })
  it('allows global unicast IPv6 only', () => {
    for (const a of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888', '[2606:4700::1]']) {
      expect(classifyAddress(a), a).toEqual({ allowed: true, family: 6 })
    }
  })
  it('blocks loopback, unspecified, IPv4-mapped/compatible, NAT64, ULA fc00::/7, link-local fe80::/10, site-local, multicast, Teredo, 6to4 and documentation IPv6', () => {
    for (const a of [
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '::ffff:8.8.8.8', // 안의 IPv4가 공개여도 mapped는 거부
      '::ffff:7f00:1',
      '::127.0.0.1',
      '64:ff9b::a00:1',
      '100::1',
      'fc00::1',
      'fd12:3456:789a::1',
      'fe80::1',
      'febf:ffff::1',
      'fec0::1',
      'ff02::1',
      '2001::1', // Teredo
      '2001:db8::1',
      '2002:c0a8:101::1', // 6to4(192.168.1.1)
      '3fff::1',
      '4000::1',
    ]) {
      expect(allowed(a), a).toBe(false)
    }
    expect(classifyAddress('fd00::1')).toEqual({ allowed: false, reason: 'private' })
    expect(classifyAddress('::ffff:127.0.0.1')).toEqual({ allowed: false, reason: 'private' })
  })
  it('rejects malformed text and non-canonical IPv4 spellings', () => {
    for (const a of ['localhost', '2130706433', '0x7f000001', '017700000001', '127.1', 'fe80::1%lo0', '']) expect(classifyAddress(a), a).toEqual({ allowed: false, reason: 'invalid' })
  })
})
