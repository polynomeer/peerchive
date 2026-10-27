/**
 * 접속해도 되는 IP 주소 판정(S-06 링크 수집기의 SSRF 방어, SYSTEM_DESIGN §10, ADR 0034).
 *
 * DNS가 돌려준 주소 **하나하나**를 이 함수로 봅니다. 하나라도 막힌 주소가 있으면 그 이름 전체를 거부합니다(섞인 응답으로 내부 주소를 고르게
 * 하는 수법 차단). 허용 목록 방식입니다:
 * - IPv4: 공개 unicast만. 0/8·10/8·100.64/10(CGNAT)·127/8·169.254/16(link-local, 클라우드 메타데이터)·172.16/12·192.0.0/24·192.0.2/24·
 *   192.88.99/24·192.168/16·198.18/15·198.51.100/24·203.0.113/24·224/4(multicast)·240/4(예약, 255.255.255.255 포함) 거부.
 * - IPv6: 전역 unicast(2000::/3)만, 그 안에서도 2001::/23(Teredo 등 프로토콜 할당)·2001:db8::/32·2002::/16(6to4)·3fff::/20(문서) 거부.
 *   그 밖(::·::1·IPv4-mapped ::ffff:0:0/96·IPv4-compatible ::/96·64:ff9b::/96 NAT64·100::/64·fc00::/7 ULA·fe80::/10 link-local·
 *   fec0::/10·ff00::/8 multicast)은 2000::/3 밖이라 모두 거부됩니다. IPv4-mapped 주소는 안의 IPv4가 공개여도 거부합니다(DNS가 정상적으로
 *   돌려줄 일이 없고, 스택에 따라 IPv4로 접속되므로).
 * - zone id(`%eth0`)가 붙은 주소, 형식이 이상한 주소는 거부합니다.
 *
 * 런타임 의존성 없음(BigInt만).
 */

export type AddressVerdict = { allowed: true; family: 4 | 6 } | { allowed: false; reason: 'invalid' | 'private' | 'reserved' }

/** 점 네 개의 10진 IPv4만(앞자리 0 없음). DNS 결과 형식입니다. 아니면 null. */
export function parseIPv4(text: string): number | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    value = value * 256 + n
  }
  return value
}

/** IPv6 텍스트 → 128비트 값. 마지막에 IPv4 점 표기를 허용합니다. zone id·형식 오류는 null. */
export function parseIPv6(text: string): bigint | null {
  if (!text || text.includes('%') || !/^[0-9a-fA-F:.]+$/.test(text)) return null
  let head = text
  let tailV4: number | null = null
  const lastColon = text.lastIndexOf(':')
  if (text.includes('.')) {
    tailV4 = parseIPv4(text.slice(lastColon + 1))
    if (tailV4 === null) return null
    head = `${text.slice(0, lastColon + 1)}0:0`
  }
  const halves = head.split('::')
  if (halves.length > 2) return null
  const parse = (s: string) => (s === '' ? [] : s.split(':'))
  const left = parse(halves[0]!)
  const right = halves.length === 2 ? parse(halves[1]!) : []
  if ([...left, ...right].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null
  const missing = 8 - left.length - right.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right]
  let value = 0n
  for (const g of groups) value = (value << 16n) | BigInt(Number.parseInt(g, 16))
  if (tailV4 !== null) value = (value & ~0xffffffffn) | BigInt(tailV4)
  return value
}

type V4Range = readonly [base: string, bits: number]
const BLOCKED_V4: readonly V4Range[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]
const PRIVATE_V4 = new Set(['10.0.0.0', '100.64.0.0', '127.0.0.0', '169.254.0.0', '172.16.0.0', '192.168.0.0'])

const inV4 = (value: number, [base, bits]: V4Range) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((value & mask) >>> 0) === ((parseIPv4(base)! & mask) >>> 0)
}

type V6Range = readonly [base: string, bits: number]
const inV6 = (value: bigint, [base, bits]: V6Range) => {
  const shift = BigInt(128 - bits)
  return value >> shift === parseIPv6(base)! >> shift
}
const GLOBAL_UNICAST_V6: V6Range = ['2000::', 3]
const BLOCKED_GLOBAL_V6: readonly V6Range[] = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
]

export function classifyIPv4(value: number): AddressVerdict {
  const hit = BLOCKED_V4.find((r) => inV4(value, r))
  if (!hit) return { allowed: true, family: 4 }
  return { allowed: false, reason: PRIVATE_V4.has(hit[0]) ? 'private' : 'reserved' }
}

export function classifyIPv6(value: bigint): AddressVerdict {
  if (!inV6(value, GLOBAL_UNICAST_V6)) {
    // fc00::/7(ULA)·fe80::/10·::1·IPv4-mapped는 "사설", 나머지는 예약으로 부릅니다(둘 다 거부).
    const isPrivate = inV6(value, ['fc00::', 7]) || inV6(value, ['fe80::', 10]) || value === 1n || inV6(value, ['::ffff:0:0', 96])
    return { allowed: false, reason: isPrivate ? 'private' : 'reserved' }
  }
  if (BLOCKED_GLOBAL_V6.some((r) => inV6(value, r))) return { allowed: false, reason: 'reserved' }
  return { allowed: true, family: 6 }
}

/** 주소 텍스트(DNS 결과·IP literal) 판정. 대괄호 표기도 받습니다. */
export function classifyAddress(text: string): AddressVerdict {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text
  const v4 = parseIPv4(bare)
  if (v4 !== null) return classifyIPv4(v4)
  if (!bare.includes(':')) return { allowed: false, reason: 'invalid' }
  const v6 = parseIPv6(bare)
  return v6 === null ? { allowed: false, reason: 'invalid' } : classifyIPv6(v6)
}
