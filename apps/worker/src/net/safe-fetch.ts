/**
 * 안전한 HTML 가져오기(S-06 링크 수집기, SYSTEM_DESIGN §10 "허용 스킴·redirect 제한·사설 IP 차단·timeout", ADR 0034).
 *
 * 사용자가 붙인 URL에 서버가 접속하는 유일한 길입니다. 웹 서버는 이 모듈을 쓰지 않고(worker만), 다른 수집(링크 미리보기 등)도 여기에 더합니다.
 *
 * 규칙(`LINK_FETCH_POLICY`):
 * - 스킴은 https만, 포트는 443만. 사용자 정보(아이디·비밀번호)가 있는 URL, IP 주소 host, localhost·`.local`·`.internal` 같은 내부 이름은
 *   접속 전에 거부합니다(@peerchive/domain checkPublicHostname).
 * - **DNS를 직접 해석하고, 돌려받은 주소 전부를 검사**합니다(ip-ranges.ts). 하나라도 사설·loopback·link-local·CGNAT·multicast·예약·
 *   IPv4-mapped·ULA 주소면 거부합니다. 통과하면 첫 주소로 **고정(pin)**해 접속합니다: 소켓의 `lookup`이 그 주소만 돌려주므로 검사와 접속 사이에
 *   이름이 다른 주소로 바뀌어도(DNS rebinding) 검사하지 않은 주소로 가지 않습니다. TLS 인증서·SNI·Host 헤더는 원래 이름 그대로입니다.
 * - redirect는 따라가지 않고 직접 처리합니다: 최대 3번, 매번 위 검사(스킴·포트·이름·DNS·주소)를 처음부터 다시 합니다. https → http는 거부.
 * - 전체 시간 5초(DNS·모든 redirect·본문 포함), 본문 512KB(넘으면 끊음), `text/html`·`application/xhtml+xml`만, 압축 없음(`identity`, 압축 폭탄 방지),
 *   쿠키를 보내지도 저장하지도 않음, 고정 User-Agent, 연결 재사용 없음(`agent: false`), GET만.
 *
 * 테스트(`testHooks`): 로컬 테스트 서버에 붙으려면 resolver·허용 주소·정책을 바꿔야 합니다. 이 값은 **함수 인자로만** 받고 환경 변수로는 켤 수
 * 없으며, `NODE_ENV=test`(vitest)가 아니면 넘기는 것 자체가 예외입니다. 허용 주소 훅도 "추가 허용"일 뿐이라 사설 주소 거부는 테스트에서도 그대로입니다.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { checkPublicHostname } from '@peerchive/domain'
import { classifyAddress } from './ip-ranges'

export interface SafeFetchPolicy {
  schemes: readonly ('https:' | 'http:')[]
  ports: readonly number[]
  maxRedirects: number
  timeoutMs: number
  maxBytes: number
  userAgent: string
}

export const LINK_FETCH_POLICY: SafeFetchPolicy = Object.freeze({
  schemes: ['https:'] as const,
  ports: [443],
  maxRedirects: 3,
  timeoutMs: 5000,
  maxBytes: 512 * 1024,
  userAgent: 'PeerchiveLinkCheck/1.0 (+https://github.com/polynomeer/peerchive)',
})

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

/** 시스템 resolver(getaddrinfo, /etc/hosts 포함). 결과는 어차피 전부 검사합니다. */
export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }))

/** 테스트 전용 훅. NODE_ENV=test가 아니면 넘길 수 없습니다. */
export interface SafeFetchTestHooks {
  resolver?: Resolver
  /** 이 함수가 true인 주소를 **추가로** 허용(로컬 테스트 서버의 127.0.0.1 등). 사설 주소 판정 자체는 바꾸지 않습니다. */
  allowAddress?: (address: string) => boolean
  policy?: Partial<SafeFetchPolicy>
  /** 실제로 접속한 주소(고정된 주소)를 알려 줍니다. */
  onConnect?: (info: { hostname: string; address: string }) => void
}

export type SafeFetchError =
  | 'invalid_url'
  | 'blocked'
  | 'dns'
  | 'too_many_redirects'
  | 'timeout'
  | 'too_large'
  | 'not_html'
  | 'http_status'
  | 'network'

export type SafeFetchResult =
  | { ok: true; url: string; status: number; body: string }
  | { ok: false; error: SafeFetchError; status?: number; detail?: string }

class FetchFailure extends Error {
  constructor(
    readonly code: SafeFetchError,
    readonly detail?: string,
    readonly status?: number,
  ) {
    super(code)
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

function effectivePort(url: URL): number {
  if (url.port) return Number(url.port)
  return url.protocol === 'https:' ? 443 : 80
}

/** URL 하나(처음 또는 redirect 대상)를 정책으로 검사합니다. 실패하면 FetchFailure. */
function vetUrl(raw: string, base: string | undefined, policy: SafeFetchPolicy): URL {
  let url: URL
  try {
    url = base === undefined ? new URL(raw) : new URL(raw, base)
  } catch {
    throw new FetchFailure('invalid_url')
  }
  if (!policy.schemes.includes(url.protocol as 'https:' | 'http:')) throw new FetchFailure('blocked', 'scheme')
  if (url.username || url.password) throw new FetchFailure('blocked', 'credentials')
  if (!policy.ports.includes(effectivePort(url))) throw new FetchFailure('blocked', 'port')
  const host = checkPublicHostname(url.hostname)
  if (host !== 'ok') throw new FetchFailure('blocked', host)
  url.hash = ''
  return url
}

/** 이름을 해석하고 모든 주소를 검사해 접속할 주소 하나를 고릅니다. */
async function resolvePinned(hostname: string, resolver: Resolver, allowExtra: ((a: string) => boolean) | undefined): Promise<ResolvedAddress> {
  let addresses: ResolvedAddress[]
  try {
    addresses = await resolver(hostname)
  } catch {
    throw new FetchFailure('dns')
  }
  if (addresses.length === 0) throw new FetchFailure('dns')
  for (const a of addresses) {
    if (allowExtra?.(a.address)) continue
    const verdict = classifyAddress(a.address)
    if (!verdict.allowed) throw new FetchFailure('blocked', `address_${verdict.reason}`)
  }
  return addresses[0]!
}

/** 고정 주소만 돌려주는 소켓 lookup(rebinding 방지). `all: true`(Happy Eyeballs)와 단일 형식 둘 다 지원합니다. */
function pinnedLookup(pinned: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === 'function' ? (options as typeof callback) : callback
    const all = typeof options === 'object' && options !== null && options.all === true
    if (all) cb(null, [{ address: pinned.address, family: pinned.family }])
    else cb(null, pinned.address, pinned.family)
  }) as unknown as LookupFunction
}

function requestOnce(url: URL, pinned: ResolvedAddress, policy: SafeFetchPolicy, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: effectivePort(url),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        lookup: pinnedLookup(pinned),
        ...(url.protocol === 'https:' && { servername: url.hostname }),
        signal,
        headers: {
          host: url.host,
          'user-agent': policy.userAgent,
          accept: 'text/html,application/xhtml+xml;q=0.9',
          'accept-encoding': 'identity',
          'accept-language': 'ko,en;q=0.8',
          connection: 'close',
        },
      },
      resolve,
    )
    req.on('error', reject)
    req.end()
  })
}

async function readBody(res: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = Number(res.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    res.destroy()
    throw new FetchFailure('too_large')
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > maxBytes) {
      res.destroy()
      throw new FetchFailure('too_large')
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function assertTestHooksAllowed(hooks: SafeFetchTestHooks | undefined) {
  if (hooks && process.env.NODE_ENV !== 'test') throw new Error('safeFetchHtml testHooks are only allowed under NODE_ENV=test')
}

/**
 * URL의 HTML을 정책대로 가져옵니다. 예외를 던지지 않고 결과로 돌려줍니다(2xx가 아니면 `http_status`와 status).
 * `signal`을 주면 그것으로도 멈춥니다.
 */
export async function safeFetchHtml(rawUrl: string, options: { signal?: AbortSignal; testHooks?: SafeFetchTestHooks } = {}): Promise<SafeFetchResult> {
  assertTestHooksAllowed(options.testHooks)
  const hooks = options.testHooks
  const policy: SafeFetchPolicy = { ...LINK_FETCH_POLICY, ...hooks?.policy }
  const resolver = hooks?.resolver ?? systemResolver
  const deadline = AbortSignal.timeout(policy.timeoutMs)
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline
  const timedOut = () => deadline.aborted

  // DNS·본문 읽기처럼 signal을 받지 않는 대기도 마감 시각에 끊습니다.
  const withDeadline = <T>(work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(new FetchFailure('timeout'))
      const onAbort = () => reject(new FetchFailure('timeout'))
      signal.addEventListener('abort', onAbort, { once: true })
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })

  let current: URL
  try {
    current = vetUrl(rawUrl, undefined, policy)
    for (let hop = 0; ; hop++) {
      const pinned = await withDeadline(resolvePinned(current.hostname, resolver, hooks?.allowAddress))
      hooks?.onConnect?.({ hostname: current.hostname, address: pinned.address })
      const res = await withDeadline(requestOnce(current, pinned, policy, signal))
      const status = res.statusCode ?? 0
      if (REDIRECT_STATUSES.has(status)) {
        res.resume()
        res.destroy()
        const location = res.headers.location
        if (!location) throw new FetchFailure('http_status', 'redirect_without_location', status)
        if (hop >= policy.maxRedirects) throw new FetchFailure('too_many_redirects')
        const next = vetUrl(location, current.href, policy)
        if (current.protocol === 'https:' && next.protocol !== 'https:') throw new FetchFailure('blocked', 'downgrade')
        current = next
        continue
      }
      if (status < 200 || status >= 300) {
        res.destroy()
        throw new FetchFailure('http_status', undefined, status)
      }
      const type = String(res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      if (!HTML_TYPES.has(type)) {
        res.destroy()
        throw new FetchFailure('not_html', type || 'missing')
      }
      const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase()
      if (encoding !== 'identity' && encoding !== '') {
        res.destroy()
        throw new FetchFailure('not_html', `encoding_${encoding}`)
      }
      const body = await withDeadline(readBody(res, policy.maxBytes))
      return { ok: true, url: current.href, status, body }
    }
  } catch (error) {
    if (timedOut()) return { ok: false, error: 'timeout' }
    if (error instanceof FetchFailure) {
      return { ok: false, error: error.code, ...(error.status !== undefined && { status: error.status }), ...(error.detail && { detail: error.detail }) }
    }
    if (signal.aborted) return { ok: false, error: 'timeout' }
    return { ok: false, error: 'network', detail: (error as NodeJS.ErrnoException).code ?? 'error' }
  }
}
