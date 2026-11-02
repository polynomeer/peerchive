/**
 * AI 설정 해석 (E-12, ADR 0057). 웹이 읽고, E-13(봇·worker)·E-14도 같은 값을 씁니다.
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_AI_ENABLED | (없음 = 꺼짐) | `on`이어야 켜짐. 키만 있다고 켜지지 않습니다(다른 용도로 둔 키가 학생 글을 보내기 시작하지 않게). 사고 때 `off`로 즉시 끔 |
 * | PEERCHIVE_AI_PROVIDER | anthropic | `anthropic`(아래 키 필요). `fake`는 NODE_ENV=test에서만. 그 밖의 값은 꺼짐 |
 * | ANTHROPIC_API_KEY | — | Claude API 키(서버 전용). 없으면 꺼짐. 응답·로그·화면에 싣지 않습니다 |
 * | PEERCHIVE_AI_MODEL | claude-opus-5-5 | 모델 id |
 * | PEERCHIVE_AI_TIMEOUT_MS | 60000 | 요청 제한 시간(ms, 5000~600000). SDK 재시도마다 적용 |
 * | PEERCHIVE_AI_MAX_RETRIES | 2 | SDK 재시도 횟수(0~5, 429·5xx·연결 오류) |
 * | PEERCHIVE_AI_FALLBACKS | default | `default`면 서버 쪽 거절 대체(`fallbacks: "default"`), `off`면 끔 |
 * | PEERCHIVE_AI_USER_DAILY_REQUESTS | 40 | 사용자마다 하루(UTC) AI 호출 수 상한(1~10000) |
 * | PEERCHIVE_AI_GLOBAL_DAILY_REQUESTS | 2000 | 서버 전체 하루(UTC) AI 호출 수 상한(1~1000000) |
 * | PEERCHIVE_AI_GLOBAL_DAILY_TOKENS | 5000000 | 서버 전체 하루(UTC) 토큰(입력 + 출력 + 캐시) 상한(0이면 상한 없음) |
 *
 * 공급자가 없으면 AI 기능(E-12~E-14) 전체가 꺼지고(API 404, 화면 진입점 숨김) AI 없는 기능은 그대로입니다.
 */
import { createAnthropicProvider } from './anthropic'
import { createFakeAiProvider } from './fake'
import type { AiProvider } from './provider'

export type AiEnv = Readonly<Record<string, string | undefined>>

export const AI_ENV_NAMES = [
  'NODE_ENV',
  'PEERCHIVE_AI_ENABLED',
  'PEERCHIVE_AI_PROVIDER',
  'ANTHROPIC_API_KEY',
  'PEERCHIVE_AI_MODEL',
  'PEERCHIVE_AI_TIMEOUT_MS',
  'PEERCHIVE_AI_MAX_RETRIES',
  'PEERCHIVE_AI_FALLBACKS',
  'PEERCHIVE_AI_USER_DAILY_REQUESTS',
  'PEERCHIVE_AI_GLOBAL_DAILY_REQUESTS',
  'PEERCHIVE_AI_GLOBAL_DAILY_TOKENS',
] as const

/** 기본 모델(claude-api 지침의 권장 id). */
export const DEFAULT_AI_MODEL = 'claude-opus-5-5'

export interface AiLimits {
  userDailyRequests: number
  globalDailyRequests: number
  /** 0이면 상한 없음. */
  globalDailyTokens: number
}

export const DEFAULT_AI_LIMITS: AiLimits = { userDailyRequests: 40, globalDailyRequests: 2000, globalDailyTokens: 5_000_000 }

function intIn(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim()
  if (!value) return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

export function parseAiLimits(env: AiEnv): AiLimits {
  const d = DEFAULT_AI_LIMITS
  return {
    userDailyRequests: intIn(env.PEERCHIVE_AI_USER_DAILY_REQUESTS, d.userDailyRequests, 1, 10_000),
    globalDailyRequests: intIn(env.PEERCHIVE_AI_GLOBAL_DAILY_REQUESTS, d.globalDailyRequests, 1, 1_000_000),
    globalDailyTokens: intIn(env.PEERCHIVE_AI_GLOBAL_DAILY_TOKENS, d.globalDailyTokens, 0, 1_000_000_000),
  }
}

/** 켤 수 있는 설정이면 공급자 종류, 아니면 null(꺼짐 스위치·키 없음·알 수 없는 값·test 밖의 fake). */
export function aiProviderKind(env: AiEnv): 'anthropic' | 'fake' | null {
  if (env.PEERCHIVE_AI_ENABLED?.trim().toLowerCase() !== 'on') return null
  const kind = env.PEERCHIVE_AI_PROVIDER?.trim().toLowerCase() || 'anthropic'
  if (kind === 'anthropic') return env.ANTHROPIC_API_KEY?.trim() ? 'anthropic' : null
  if (kind === 'fake') return env.NODE_ENV === 'test' ? 'fake' : null
  return null
}

/** 환경 변수로 공급자를 만듭니다. 꺼져 있으면 null. */
export function resolveAiProvider(env: AiEnv, options: { fetch?: typeof fetch } = {}): AiProvider | null {
  const kind = aiProviderKind(env)
  if (!kind) return null
  if (kind === 'fake') return createFakeAiProvider({ env })
  return createAnthropicProvider({
    apiKey: env.ANTHROPIC_API_KEY!,
    model: env.PEERCHIVE_AI_MODEL?.trim() || DEFAULT_AI_MODEL,
    timeoutMs: intIn(env.PEERCHIVE_AI_TIMEOUT_MS, 60_000, 5_000, 600_000),
    maxRetries: intIn(env.PEERCHIVE_AI_MAX_RETRIES, 2, 0, 5),
    fallbacks: env.PEERCHIVE_AI_FALLBACKS?.trim().toLowerCase() !== 'off',
    ...(options.fetch && { fetch: options.fetch }),
  })
}
