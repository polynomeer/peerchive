/**
 * 신뢰 프록시 기반 요청자 IP 결정 단위 테스트.
 */
import { describe, expect, it } from 'vitest'
import { parseTrustedProxies, resolveClientIp } from '../server/modules/security/client-ip'

const none = parseTrustedProxies('').proxies
const lb = parseTrustedProxies('10.0.0.0/8, 127.0.0.1, fd00::/8').proxies

describe('parseTrustedProxies', () => {
  it('accepts CIDRs and bare addresses, reports invalid entries', () => {
    const { proxies, invalid } = parseTrustedProxies('10.0.0.0/8,192.168.1.1,::1,fd00::/8,bad,10.0.0.0/33,1.2.3.4/x,')
    expect(proxies.size).toBe(4)
    expect(invalid).toEqual(['bad', '10.0.0.0/33', '1.2.3.4/x'])
  })
})

describe('resolveClientIp', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    expect(resolveClientIp({ remoteAddress: '203.0.113.5', forwardedFor: '198.51.100.1', proxies: none })).toBe('203.0.113.5')
  })

  it('ignores X-Forwarded-For from an untrusted remote even if proxies are configured', () => {
    expect(resolveClientIp({ remoteAddress: '203.0.113.5', forwardedFor: '198.51.100.1', proxies: lb })).toBe('203.0.113.5')
  })

  it('takes the first untrusted hop from the right behind trusted proxies', () => {
    // 클라이언트가 앞에 가짜 주소를 붙여도 가장 오른쪽의 비신뢰 hop이 요청자입니다.
    expect(
      resolveClientIp({ remoteAddress: '10.1.2.3', forwardedFor: '6.6.6.6, 198.51.100.7, 10.0.0.9', proxies: lb }),
    ).toBe('198.51.100.7')
  })

  it('normalizes IPv4-mapped IPv6 remote addresses', () => {
    expect(resolveClientIp({ remoteAddress: '::ffff:10.0.0.1', forwardedFor: '198.51.100.8', proxies: lb })).toBe('198.51.100.8')
    expect(resolveClientIp({ remoteAddress: '::ffff:203.0.113.9', forwardedFor: null, proxies: none })).toBe('203.0.113.9')
  })

  it('handles IPv6 proxies and clients', () => {
    expect(resolveClientIp({ remoteAddress: 'fd00::1', forwardedFor: '2001:db8::5', proxies: lb })).toBe('2001:db8::5')
  })

  it('stops at a malformed hop and uses the last verified address', () => {
    expect(resolveClientIp({ remoteAddress: '10.0.0.1', forwardedFor: 'garbage, 10.0.0.2', proxies: lb })).toBe('10.0.0.2')
    expect(resolveClientIp({ remoteAddress: '10.0.0.1', forwardedFor: '1.2.3.4:5555', proxies: lb })).toBe('10.0.0.1')
  })

  it('uses the leftmost hop when every hop is trusted', () => {
    expect(resolveClientIp({ remoteAddress: '127.0.0.1', forwardedFor: '10.0.0.5, 10.0.0.6', proxies: lb })).toBe('10.0.0.5')
  })

  it('returns unknown without a usable remote address', () => {
    expect(resolveClientIp({ remoteAddress: undefined, forwardedFor: '198.51.100.1', proxies: lb })).toBe('unknown')
  })
})
