/**
 * @peerchive/ai 단위 테스트(E-12, ADR 0057). 네트워크 없이: Claude 어댑터는 가짜 fetch로 요청 모양·응답 처리만 봅니다.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AiError,
  DEFAULT_AI_LIMITS,
  SERVER_SIDE_FALLBACK_BETA,
  aiProviderKind,
  createAnthropicProvider,
  createFakeAiProvider,
  parseAiLimits,
  resolveAiProvider,
} from '../src'

const schema = z.object({ question: z.string().nullable(), done: z.boolean() })

interface Captured {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

function fakeFetch(responses: Array<{ status: number; body: unknown }>, captured: Captured[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const next = responses.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'x' } } }
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

const message = (overrides: Record<string, unknown>) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text: JSON.stringify({ question: '그걸 어떻게 풀었어요?', done: false }) }],
  stop_reason: 'end_turn',
  stop_details: null,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
  ...overrides,
})

function provider(responses: Array<{ status: number; body: unknown }>, captured: Captured[], fallbacks = true) {
  return createAnthropicProvider({ apiKey: 'sk-test', model: 'claude-opus-5-5', timeoutMs: 5000, maxRetries: 0, fallbacks, fetch: fakeFetch(responses, captured) })
}

const request = {
  feature: 'test.turn',
  system: 'STABLE SYSTEM',
  messages: [{ role: 'user' as const, text: 'VOLATILE <answer>' }],
  schema,
  maxTokens: 4096,
  effort: 'medium' as const,
}

describe('config', () => {
  it('needs PEERCHIVE_AI_ENABLED=on and a key; fake only under NODE_ENV=test', () => {
    expect(aiProviderKind({})).toBeNull()
    expect(aiProviderKind({ ANTHROPIC_API_KEY: 'k' })).toBeNull()
    expect(aiProviderKind({ PEERCHIVE_AI_ENABLED: 'on' })).toBeNull()
    expect(aiProviderKind({ PEERCHIVE_AI_ENABLED: 'off', ANTHROPIC_API_KEY: 'k' })).toBeNull()
    expect(aiProviderKind({ PEERCHIVE_AI_ENABLED: 'ON', ANTHROPIC_API_KEY: 'k' })).toBe('anthropic')
    expect(aiProviderKind({ PEERCHIVE_AI_ENABLED: 'on', PEERCHIVE_AI_PROVIDER: 'openai', ANTHROPIC_API_KEY: 'k' })).toBeNull()
    expect(aiProviderKind({ PEERCHIVE_AI_ENABLED: 'on', PEERCHIVE_AI_PROVIDER: 'fake', NODE_ENV: 'production' })).toBeNull()
    expect(aiProviderKind({ PEERCHIVE_AI_ENABLED: 'on', PEERCHIVE_AI_PROVIDER: 'fake', NODE_ENV: 'test' })).toBe('fake')
    expect(resolveAiProvider({})).toBeNull()
    const p = resolveAiProvider({ PEERCHIVE_AI_ENABLED: 'on', ANTHROPIC_API_KEY: 'k' })
    expect(p?.name).toBe('anthropic')
    expect(p?.model).toBe('claude-opus-5-5')
    expect(resolveAiProvider({ PEERCHIVE_AI_ENABLED: 'on', ANTHROPIC_API_KEY: 'k', PEERCHIVE_AI_MODEL: 'claude-sonnet-5-5' })?.model).toBe('claude-sonnet-5-5')
  })

  it('parses limits with bounds and defaults', () => {
    expect(parseAiLimits({})).toEqual(DEFAULT_AI_LIMITS)
    expect(parseAiLimits({ PEERCHIVE_AI_USER_DAILY_REQUESTS: '5', PEERCHIVE_AI_GLOBAL_DAILY_REQUESTS: 'x', PEERCHIVE_AI_GLOBAL_DAILY_TOKENS: '0' })).toEqual({
      userDailyRequests: 5,
      globalDailyRequests: DEFAULT_AI_LIMITS.globalDailyRequests,
      globalDailyTokens: 0,
    })
    expect(parseAiLimits({ PEERCHIVE_AI_USER_DAILY_REQUESTS: '0' }).userDailyRequests).toBe(DEFAULT_AI_LIMITS.userDailyRequests)
  })

  it('fake provider refuses to exist outside tests', () => {
    expect(() => createFakeAiProvider({ env: { NODE_ENV: 'production' } })).toThrow(/NODE_ENV=test/)
  })
})

describe('anthropic adapter (fake fetch, no network)', () => {
  it('sends the documented request shape and parses structured output', async () => {
    const captured: Captured[] = []
    const result = await provider([{ status: 200, body: message({}) }], captured).generateStructured(request)
    expect(result).toEqual({
      data: { question: '그걸 어떻게 풀었어요?', done: false },
      usage: { inputTokens: 120, outputTokens: 40, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
      model: 'claude-opus-5-5',
      fallback: false,
    })
    const [call] = captured
    expect(call!.url).toMatch(/\/v1\/messages\?beta=true$/)
    expect(call!.headers.get('anthropic-beta')).toBe(SERVER_SIDE_FALLBACK_BETA)
    expect(call!.headers.get('authorization')).toBe('Bearer sk-test')
    expect(call!.headers.get('x-api-key')).toBeNull()
    expect(call!.headers.get('anthropic-version')).toBe('2026-10-21')
    const body = call!.body
    expect(body.model).toBe('claude-opus-5-5')
    expect(body.max_tokens).toBe(4096)
    expect(body.fallbacks).toBe('default')
    expect(body.system).toEqual([{ type: 'text', text: 'STABLE SYSTEM', cache_control: { type: 'ephemeral' } }])
    expect(body.messages).toEqual([{ role: 'user', content: 'VOLATILE <answer>' }])
    const outputConfig = body.output_config as { effort: string; format: { type: string; schema: { properties: object } } }
    expect(outputConfig.effort).toBe('medium')
    expect(outputConfig.format.type).toBe('json_schema')
    expect(Object.keys(outputConfig.format.schema.properties).sort()).toEqual(['done', 'question'])
    // Opus 5.5에서 400인 매개변수는 보내지 않습니다.
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k', 'betas']) expect(body).not.toHaveProperty(key)
  })

  it('omits the fallback beta when disabled and reports a fallback that served the turn', async () => {
    const captured: Captured[] = []
    await provider([{ status: 200, body: message({}) }], captured, false).generateStructured(request)
    expect(captured[0]!.headers.get('anthropic-beta')).toBeNull()
    expect(captured[0]!.body).not.toHaveProperty('fallbacks')

    const served = await provider(
      [
        {
          status: 200,
          body: message({
            model: 'claude-opus-5',
            content: [
              { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
              { type: 'text', text: '{"question":null,"done":true}' },
            ],
            usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'message' }, { type: 'fallback_message' }] },
          }),
        },
      ],
      [],
    ).generateStructured(request)
    expect(served).toMatchObject({ data: { question: null, done: true }, model: 'claude-opus-5', fallback: true })
  })

  it('checks stop_reason before reading content: refusal, max_tokens, invalid JSON, schema mismatch', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'SECRET-PARTIAL' }, content: [{ type: 'text', text: '{"question":"SECRET-PARTIAL"' }] }, 'refusal'],
      [{ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"question":"SECRET-PARTIAL' }] }, 'max_tokens'],
      [{ content: [{ type: 'text', text: 'not json SECRET-PARTIAL' }] }, 'invalid_output'],
      [{ content: [{ type: 'text', text: '{"question":3,"done":"SECRET-PARTIAL"}' }] }, 'invalid_output'],
    ]
    for (const [overrides, kind] of cases) {
      const error = await provider([{ status: 200, body: message(overrides) }], []).generateStructured(request).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(AiError)
      expect((error as AiError).kind).toBe(kind)
      expect((error as AiError).usage?.inputTokens).toBe(120)
      expect(String((error as AiError).message)).not.toContain('SECRET')
    }
    const refusal = (await provider([{ status: 200, body: message(cases[0]![0]) }], []).generateStructured(request).catch((e: unknown) => e)) as AiError
    expect(refusal.refusalCategory).toBe('cyber')
  })

  it('maps SDK typed errors without leaking response bodies', async () => {
    const errorBody = (type: string) => ({ type: 'error', error: { type, message: 'SECRET-BODY' } })
    const cases: Array<[number, string]> = [
      [429, 'rate_limited'],
      [529, 'unavailable'],
      [500, 'unavailable'],
      [401, 'unavailable'],
      [400, 'unavailable'],
    ]
    for (const [status, kind] of cases) {
      const error = (await provider([{ status, body: errorBody('x') }], []).generateStructured(request).catch((e: unknown) => e)) as AiError
      expect(error).toBeInstanceOf(AiError)
      expect(error.kind).toBe(kind)
      expect(error.message).not.toContain('SECRET')
    }
    const offline = createAnthropicProvider({
      apiKey: 'k',
      model: 'm',
      timeoutMs: 5000,
      maxRetries: 0,
      fallbacks: true,
      fetch: (async () => {
        throw new TypeError('network down')
      }) as typeof fetch,
    })
    const error = (await offline.generateStructured(request).catch((e: unknown) => e)) as AiError
    expect(error.kind).toBe('unavailable')
    expect(error.status).toBeNull()
  })

  it('rejects assistant prefill (conversation must end with a user turn)', async () => {
    await expect(
      provider([], []).generateStructured({ ...request, messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: '{' }] }),
    ).rejects.toThrow(/user turn/)
  })
})

describe('fake provider', () => {
  it('records calls, validates replies with the schema and plays queued errors', async () => {
    const fake = createFakeAiProvider({ env: { NODE_ENV: 'test' } })
    fake.queue({ data: { question: 'Q', done: false } }, { data: { question: 1 } }, { error: new AiError('refusal') })
    expect((await fake.generateStructured(request)).data).toEqual({ question: 'Q', done: false })
    await expect(fake.generateStructured(request)).rejects.toMatchObject({ kind: 'invalid_output' })
    await expect(fake.generateStructured(request)).rejects.toMatchObject({ kind: 'refusal' })
    await expect(fake.generateStructured(request)).rejects.toMatchObject({ kind: 'unavailable' })
    expect(fake.calls).toHaveLength(4)
    expect(fake.sentText()).toContain('VOLATILE <answer>')
  })
})
