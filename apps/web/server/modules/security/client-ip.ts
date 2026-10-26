/**
 * 요청자 IP 결정(신뢰 프록시).
 *
 * - 기본(신뢰 프록시 없음): 소켓의 원격 주소만 씁니다. `X-Forwarded-For`는 누구나 꾸밀 수 있으므로 무시합니다.
 * - `PEERCHIVE_TRUSTED_PROXIES`(쉼표 구분 CIDR, 예: `10.0.0.0/8,fd00::/8`)를 설정하면,
 *   원격 주소가 신뢰 범위일 때만 `X-Forwarded-For`를 오른쪽(가까운 hop)부터 읽어
 *   신뢰 범위가 아닌 첫 주소를 요청자로 봅니다. 모든 hop이 신뢰 범위면 가장 왼쪽 주소를 씁니다.
 * - 형식이 틀린 주소·CIDR은 버립니다. 설정 오류로 모든 요청이 같은 IP로 묶이지 않도록 잘못된 hop을 만나면
 *   그 직전까지 확인한 주소(신뢰 범위의 프록시 주소)를 씁니다.
 * - IPv4-mapped IPv6(`::ffff:1.2.3.4`)는 IPv4로 바꿔 비교합니다.
 *
 * 이 값은 요청 한도(rate limit) 키로만 씁니다. 저장·로그에 남기지 않습니다.
 */
import { BlockList, isIP } from 'node:net'

export interface TrustedProxies {
  list: BlockList
  /** 설정된 CIDR 수(0이면 X-Forwarded-For를 전혀 보지 않음). */
  size: number
}

function normalize(address: string | undefined | null): string | null {
  if (!address) return null
  let value = address.trim()
  // [IPv6]:port, IPv4:port 형태는 받지 않습니다(X-Forwarded-For 값은 주소만이어야 함).
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7)
  return isIP(value) ? value : null
}

/** `PEERCHIVE_TRUSTED_PROXIES` 값을 해석합니다. 잘못된 항목은 버리고 이유를 돌려줍니다. */
export function parseTrustedProxies(value: string | undefined | null): { proxies: TrustedProxies; invalid: string[] } {
  const list = new BlockList()
  const invalid: string[] = []
  let size = 0
  for (const raw of (value ?? '').split(',')) {
    const item = raw.trim()
    if (!item) continue
    const [addr, prefixText] = item.split('/')
    const address = normalize(addr)
    if (!address) {
      invalid.push(item)
      continue
    }
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4'
    const max = family === 'ipv6' ? 128 : 32
    const prefix = prefixText === undefined ? max : Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (prefixText !== undefined && !/^\d+$/.test(prefixText))) {
      invalid.push(item)
      continue
    }
    list.addSubnet(address, prefix, family)
    size += 1
  }
  return { proxies: { list, size }, invalid }
}

function isTrusted(proxies: TrustedProxies, address: string): boolean {
  return proxies.list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4')
}

export function resolveClientIp(input: {
  remoteAddress: string | undefined | null
  forwardedFor: string | undefined | null
  proxies: TrustedProxies
}): string {
  const remote = normalize(input.remoteAddress)
  if (!remote) return 'unknown'
  if (input.proxies.size === 0 || !isTrusted(input.proxies, remote) || !input.forwardedFor) return remote

  const hops = input.forwardedFor.split(',').map((hop) => hop.trim())
  let candidate = remote
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = normalize(hops[i])
    if (!hop) return candidate
    candidate = hop
    if (!isTrusted(input.proxies, hop)) return hop
  }
  return candidate
}
