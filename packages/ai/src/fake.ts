/**
 * 테스트 전용 가짜 AI 공급자 (E-12, ADR 0057). 네트워크를 쓰지 않습니다.
 *
 * - `NODE_ENV=test`가 아니면 만들 수 없습니다(실서비스에서 가짜 답을 내지 않게).
 * - 받은 요청(system·messages·feature·effort·maxTokens)을 `calls`에 기록합니다. 테스트가 "다른 과제·다른 팀원의 글을 보내지 않았다"를
 *   표지 문자열로 확인합니다.
 * - 답은 `respond`(요청을 받아 값을 돌려주는 함수) 또는 `queue`(차례로 꺼내 쓰는 값·오류)로 정합니다. 값은 요청 스키마로 검증하므로
 *   실제 어댑터처럼 스키마에 맞지 않으면 `invalid_output`입니다.
 */
import { AiError, type AiProvider, type AiStructuredRequest, type AiUsage, checkMessages } from './provider'

export const FAKE_AI_MODEL = 'fake-claude'

export type FakeAiReply = { data: unknown; usage?: Partial<AiUsage>; fallback?: boolean } | { error: AiError | Error }

export interface FakeAiCall {
  feature: string
  system: string
  messages: Array<{ role: 'user' | 'assistant'; text: string }>
  effort: string
  maxTokens: number
}

export interface FakeAiProvider extends AiProvider {
  readonly calls: FakeAiCall[]
  /** 다음 응답들(차례로). 비면 `respond`를 부릅니다. */
  queue(...replies: FakeAiReply[]): void
  /** 큐가 비었을 때 쓸 응답 함수. */
  respond: ((call: FakeAiCall) => FakeAiReply) | null
  /** 지금까지 보낸 모든 글(system + messages)을 한 문자열로(표지 검사용). */
  sentText(): string
}

const DEFAULT_USAGE: AiUsage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

export function createFakeAiProvider(options: { env?: Readonly<Record<string, string | undefined>> } = {}): FakeAiProvider {
  const env = options.env ?? (globalThis.process?.env as Record<string, string | undefined> | undefined) ?? {}
  if (env.NODE_ENV !== 'test') throw new Error('fake AI provider is only available when NODE_ENV=test')
  const calls: FakeAiCall[] = []
  const pending: FakeAiReply[] = []
  const provider: FakeAiProvider = {
    name: 'fake',
    model: FAKE_AI_MODEL,
    calls,
    respond: null,
    queue(...replies) {
      pending.push(...replies)
    },
    sentText() {
      return calls.map((c) => [c.system, ...c.messages.map((m) => m.text)].join('\n')).join('\n')
    },
    async generateStructured<T>(request: AiStructuredRequest<T>) {
      checkMessages(request.messages)
      const call: FakeAiCall = {
        feature: request.feature,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, text: m.text })),
        effort: request.effort,
        maxTokens: request.maxTokens,
      }
      calls.push(call)
      const reply = pending.shift() ?? provider.respond?.(call)
      if (!reply) throw new AiError('unavailable', null)
      if ('error' in reply) throw reply.error
      const usage = { ...DEFAULT_USAGE, ...reply.usage }
      const checked = request.schema.safeParse(reply.data)
      if (!checked.success) throw new AiError('invalid_output', null, usage)
      return { data: checked.data, usage, model: FAKE_AI_MODEL, fallback: reply.fallback ?? false }
    },
  }
  return provider
}
