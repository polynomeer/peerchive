/**
 * 공급자 호출의 재시도·속도 제한 (E-05, ADR 0055).
 *
 * - `withRetry`: `retryable` 오류(429·5xx·네트워크)만 지수 백오프로 다시 시도합니다(Retry-After가 있으면 그 값 이상).
 * - `RateGate`: 요청 사이 최소 간격(분당 요청 수 → ms). 한 프로세스 안에서만 셉니다(worker는 작업 하나가 순서대로 부름).
 */
import { EmbeddingProviderError } from './provider'

export interface RetryOptions {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
  sleep?: (ms: number) => Promise<void>
}

export const DEFAULT_RETRY: RetryOptions = { attempts: 4, baseDelayMs: 1000, maxDelayMs: 60_000 }

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = DEFAULT_RETRY): Promise<T> {
  const sleep = options.sleep ?? realSleep
  let lastError: unknown
  for (let attempt = 0; attempt < Math.max(1, options.attempts); attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      const retryable = error instanceof EmbeddingProviderError ? error.retryable : false
      if (!retryable || attempt === options.attempts - 1) break
      const backoff = Math.min(options.baseDelayMs * 2 ** attempt, options.maxDelayMs)
      const hinted = error instanceof EmbeddingProviderError && error.retryAfterMs !== null ? error.retryAfterMs : 0
      await sleep(Math.max(backoff, hinted))
    }
  }
  throw lastError
}

export class RateGate {
  private next = 0
  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
    private readonly clock: () => number = Date.now,
  ) {}

  static perMinute(requestsPerMinute: number, sleep?: (ms: number) => Promise<void>, clock?: () => number): RateGate {
    return new RateGate(requestsPerMinute > 0 ? Math.ceil(60_000 / requestsPerMinute) : 0, sleep, clock)
  }

  /** 다음 요청을 보내도 될 때까지 기다립니다. */
  async wait(): Promise<void> {
    const now = this.clock()
    const delay = this.next - now
    this.next = Math.max(now, this.next) + this.minIntervalMs
    if (delay > 0) await this.sleep(delay)
  }
}
