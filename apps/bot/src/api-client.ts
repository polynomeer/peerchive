/**
 * 웹 서버 내부 API 클라이언트. 요청마다 새 nonce·timestamp로 HMAC 서명합니다(ADR 0009).
 *
 * - 네트워크 오류·5xx면 한 번 더 보냅니다(새 nonce로 다시 서명, 본문은 같음). 서버는 interaction·메시지 id로
 *   중복을 막으므로 다시 보내도 로그는 하나입니다.
 * - 401(서명)·422(형식)·그 밖의 4xx는 다시 보내지 않고 ApiUnavailableError로 알립니다(사용자에게는 일반 안내만).
 */
import {
  type AckNoticeRequest,
  type AckNoticeResponse,
  type BindRequest,
  type BindResponse,
  type ClaimNoticesResponse,
  INTERNAL_PATHS,
  type LinkRequest,
  type LinkResponse,
  type LogRequest,
  type LogResponse,
  type PinDecisionRequest,
  type PinDecisionResponse,
  type PinRequest,
  type PinResponse,
  signRequest,
} from '@peerchive/bot-protocol'

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number
  json(): Promise<unknown>
}>

export class ApiUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super(status === null ? 'peerchive api unreachable' : `peerchive api responded ${status}`)
    this.name = 'ApiUnavailableError'
  }
}

export interface PeerchiveApi {
  link(input: LinkRequest): Promise<LinkResponse>
  bind(input: BindRequest): Promise<BindResponse>
  log(input: LogRequest): Promise<LogResponse>
  pin(input: PinRequest): Promise<PinResponse>
  decidePin(input: PinDecisionRequest): Promise<PinDecisionResponse>
  claimNotices(): Promise<ClaimNoticesResponse>
  ackNotice(input: AckNoticeRequest): Promise<AckNoticeResponse>
}

export function createPeerchiveApi(options: {
  baseUrl: string
  secret: string
  fetch?: FetchLike
  now?: () => Date
  /** 재시도 횟수(기본 1). */
  retries?: number
}): PeerchiveApi {
  const doFetch: FetchLike = options.fetch ?? ((url, init) => fetch(url, init))
  const retries = options.retries ?? 1

  async function post<T>(path: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload ?? {})
    let lastStatus: number | null = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      const headers = {
        'content-type': 'application/json',
        ...signRequest(options.secret, { method: 'POST', path, body }, { now: options.now?.() }),
      }
      try {
        const res = await doFetch(`${options.baseUrl}${path}`, { method: 'POST', headers, body })
        if (res.status >= 200 && res.status < 300) return (await res.json()) as T
        lastStatus = res.status
        if (res.status < 500) break
      } catch {
        lastStatus = null
      }
    }
    throw new ApiUnavailableError(lastStatus)
  }

  return {
    link: (input) => post(INTERNAL_PATHS.link, input),
    bind: (input) => post(INTERNAL_PATHS.bind, input),
    log: (input) => post(INTERNAL_PATHS.log, input),
    pin: (input) => post(INTERNAL_PATHS.pin, input),
    decidePin: (input) => post(INTERNAL_PATHS.pinDecision, input),
    claimNotices: () => post(INTERNAL_PATHS.claimNotices, {}),
    ackNotice: (input) => post(INTERNAL_PATHS.ackNotice, input),
  }
}
