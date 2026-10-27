import { describe, expect, it } from 'vitest'
import {
  SOCIAL_LINK_MAX_FAILURES,
  SOCIAL_LINK_VERIFIED_NOTE,
  checkPublicHostname,
  nextSocialLinkState,
  pageLinksTo,
  parseSocialLinkUrl,
  personaProfileUrl,
} from '../src'

const reason = (raw: unknown, provider?: Parameters<typeof parseSocialLinkUrl>[1]) => {
  const r = parseSocialLinkUrl(raw, provider)
  return r.ok ? 'ok' : r.reason
}

describe('parseSocialLinkUrl (S-06, ADR 0034)', () => {
  it('accepts public https URLs and normalizes them (no fragment, lowercase host)', () => {
    expect(parseSocialLinkUrl('https://GitHub.com/someone#readme', 'github')).toEqual({ ok: true, url: 'https://github.com/someone', hostname: 'github.com' })
    expect(parseSocialLinkUrl('  https://blog.example.co.kr/about?x=1  ', 'blog')).toEqual({
      ok: true,
      url: 'https://blog.example.co.kr/about?x=1',
      hostname: 'blog.example.co.kr',
    })
    expect(reason('https://kr.linkedin.com/in/someone', 'linkedin')).toBe('ok')
    expect(reason('https://youtu.be/abc', 'youtube')).toBe('ok')
    expect(reason('https://www.youtube.com/@someone', 'youtube')).toBe('ok')
    expect(reason('https://xn--3e0b707e.xn--3e0b707e/', 'other')).toBe('ok')
  })

  it('https only, default port only, no credentials, length cap', () => {
    expect(reason('http://github.com/a')).toBe('scheme')
    expect(reason('javascript:alert(1)')).toBe('scheme')
    expect(reason('ftp://example.com/')).toBe('scheme')
    expect(reason('github.com/a')).toBe('invalid')
    expect(reason('//github.com/a')).toBe('invalid')
    expect(reason('https://github.com:8443/a')).toBe('port')
    expect(reason('https://github.com:443/a')).toBe('ok') // 기본 포트는 URL이 지움
    expect(reason('https://user:pw@github.com/a')).toBe('credentials')
    expect(reason('https://user@github.com/a')).toBe('credentials')
    expect(reason('https://@github.com/a')).toBe('credentials')
    expect(reason(`https://example.com/${'a'.repeat(300)}`)).toBe('too_long')
    expect(reason('https://exa mple.com/')).toBe('invalid')
    expect(reason('https://example.com/\tpath')).toBe('invalid')
    expect(reason('https://example.com\\@evil.com/')).toBe('invalid')
    expect(reason(42)).toBe('invalid')
    expect(reason('')).toBe('invalid')
  })

  it('rejects IP-literal hosts in every spelling (decimal, octal, hex, short, IPv6, mapped)', () => {
    for (const raw of [
      'https://127.0.0.1/',
      'https://8.8.8.8/',
      'https://2130706433/', // 10진 = 127.0.0.1
      'https://0177.0.0.1/', // 8진
      'https://0x7f.0.0.1/', // 16진
      'https://0x7f000001/',
      'https://127.1/', // 짧은 표기
      'https://1.2.3/',
      'https://[::1]/',
      'https://[::ffff:127.0.0.1]/',
      'https://[fe80::1]/',
      'https://[2606:4700::1111]/',
    ]) {
      expect(reason(raw), raw).toBe('ip_literal')
    }
  })

  it('rejects local and internal names', () => {
    for (const raw of [
      'https://localhost/',
      'https://localhost./',
      'https://api.localhost/',
      'https://printer.local/',
      'https://db.internal/',
      'https://router.lan/',
      'https://nas.home.arpa/',
      'https://service.test/',
      'https://example/',
      'https://github.com./a',
      'https://-bad.com/',
      'https://hidden.onion/',
    ]) {
      expect(reason(raw), raw).toBe('host')
    }
  })

  it('known providers must point at their own service', () => {
    expect(reason('https://evil.example.com/github.com', 'github')).toBe('provider_mismatch')
    expect(reason('https://github.com.evil.com/a', 'github')).toBe('provider_mismatch')
    expect(reason('https://notgithub.com/a', 'github')).toBe('provider_mismatch')
    expect(reason('https://instagram.com/a', 'youtube')).toBe('provider_mismatch')
    expect(reason('https://github.com/a', 'blog')).toBe('ok')
  })
})

describe('checkPublicHostname', () => {
  it('names only, never IPs', () => {
    expect(checkPublicHostname('github.com')).toBe('ok')
    expect(checkPublicHostname('0.0.0.0')).toBe('ip_literal')
    expect(checkPublicHostname('[::]')).toBe('ip_literal')
    expect(checkPublicHostname('a.123')).toBe('ip_literal')
    expect(checkPublicHostname('com')).toBe('host')
    expect(checkPublicHostname('')).toBe('host')
  })
})

describe('pageLinksTo (되돌림 링크)', () => {
  const profile = personaProfileUrl('https://peerchive.example/', 'kim-dev')
  it('profile URL is <origin>/u/<handle>', () => {
    expect(profile).toBe('https://peerchive.example/u/kim-dev')
  })
  it('finds an href to the profile (quotes, entities, relative-to-page ignored, trailing slash, scheme and case)', () => {
    const page = 'https://github.com/kim'
    expect(pageLinksTo('<a rel="nofollow me" href="https://peerchive.example/u/kim-dev">site</a>', page, profile)).toBe(true)
    expect(pageLinksTo("<a href='http://PEERCHIVE.example/u/kim-dev/'>x</a>", page, profile)).toBe(true)
    expect(pageLinksTo('<a href=https://peerchive.example/u/kim-dev?ref=gh>x</a>', page, profile)).toBe(true)
    expect(pageLinksTo('<a href="https&#58;//peerchive.example&#x2F;u/kim-dev">x</a>', page, profile)).toBe(true)
  })
  it('does not count plain text, other handles, other hosts or look-alikes', () => {
    const page = 'https://github.com/kim'
    expect(pageLinksTo('<p>https://peerchive.example/u/kim-dev</p>', page, profile)).toBe(false)
    expect(pageLinksTo('<a href="https://peerchive.example/u/kim-dev2">x</a>', page, profile)).toBe(false)
    expect(pageLinksTo('<a href="https://peerchive.example.evil.com/u/kim-dev">x</a>', page, profile)).toBe(false)
    expect(pageLinksTo('<a href="https://evil.com/?u=https://peerchive.example/u/kim-dev">x</a>', page, profile)).toBe(false)
    expect(pageLinksTo('<a href="/u/kim-dev">x</a>', page, profile)).toBe(false) // 그 페이지 사이트의 경로
    expect(pageLinksTo('<a href="javascript:void(0)">x</a>', page, profile)).toBe(false)
  })
})

describe('nextSocialLinkState', () => {
  it('found → verified; missing → lost only if it was verified; errors count and turn verified into lost after the limit', () => {
    expect(nextSocialLinkState({ verification: 'unverified', failures: 2 }, 'found')).toEqual({ verification: 'verified', failures: 0, verifiedNow: true })
    expect(nextSocialLinkState({ verification: 'lost', failures: 0 }, 'found')).toEqual({ verification: 'verified', failures: 0, verifiedNow: true })
    expect(nextSocialLinkState({ verification: 'verified', failures: 1 }, 'found')).toEqual({ verification: 'verified', failures: 0, verifiedNow: false })
    expect(nextSocialLinkState({ verification: 'verified', failures: 1 }, 'missing')).toEqual({ verification: 'lost', failures: 0, verifiedNow: false })
    expect(nextSocialLinkState({ verification: 'unverified', failures: 0 }, 'missing').verification).toBe('unverified')
    expect(nextSocialLinkState({ verification: 'lost', failures: 0 }, 'missing').verification).toBe('lost')
    let s = { verification: 'verified' as const, failures: 0 }
    const seen: string[] = []
    for (let i = 0; i < SOCIAL_LINK_MAX_FAILURES; i++) {
      const next = nextSocialLinkState(s, 'error')
      seen.push(next.verification)
      s = next as typeof s
    }
    expect(seen).toEqual([...Array(SOCIAL_LINK_MAX_FAILURES - 1).fill('verified'), 'lost'])
    expect(nextSocialLinkState({ verification: 'unverified', failures: 9 }, 'error')).toEqual({ verification: 'unverified', failures: 10, verifiedNow: false })
  })
  it('the badge note says what was not checked', () => {
    expect(SOCIAL_LINK_VERIFIED_NOTE).toContain('검증하지 않습니다')
  })
})
