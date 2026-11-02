/**
 * 웹의 AI 호출 공통부 (E-12, ADR 0057). E-13·E-14도 이 함수(`callAi`)로 부릅니다.
 *
 * - 켜짐: 서버에 AI 공급자가 설정되어 있을 때만(`PEERCHIVE_AI_ENABLED=on` + `ANTHROPIC_API_KEY`, @peerchive/ai). 꺼져 있으면
 *   AI 경로는 모두 404(`requireAiConfigured`)이고 `GET /api/v1/features`의 `ai`가 false라 화면 진입점이 없습니다.
 * - 비용 상한(부르기 전에): 서버 전체 하루 토큰(ai_usage_daily 합계, 0이면 없음) → 사용자마다 하루 호출 수 → 서버 전체 하루 호출 수.
 *   넘으면 429 `rate_limited`(공급자를 부르지 않음). 하루는 UTC 기준이며 호출 수는 rate_limit_buckets(사용자 id는 해시)로 셉니다.
 * - 사용량: 부른 뒤 성공·실패 모두 ai_usage_daily(날짜·기능·모델)에 토큰 수·횟수만 더합니다. 사람·과제·프롬프트·출력은 저장하거나 로그로 남기지 않습니다.
 * - 오류: 공급자 오류는 503 — 거절(`stop_reason: refusal`)은 `ai_declined`, 그 밖(시간 초과·429·5xx·출력 상한·형식 오류)은 `ai_unavailable`.
 *   응답에는 이 코드만 싣고, 서버 로그에도 종류·상태 코드만 남깁니다.
 * - AI 호출은 DB 트랜잭션 밖에서 합니다(외부 지연 동안 행 잠금을 잡지 않음). 부르는 쪽은 결과를 받은 뒤 짧은 트랜잭션으로 저장합니다.
 */
import {
  AI_ENV_NAMES,
  AiError,
  type AiEnv,
  type AiProvider,
  type AiStructuredRequest,
  type AiStructuredResult,
  type AiUsage,
  aiProviderKind,
  parseAiLimits,
  resolveAiProvider,
} from '@peerchive/ai'
import { aiUsageDaily, and, eq, sql, type DbExecutor } from '@peerchive/db'
import { type Actor, notFound, rateLimited, unavailable } from '../errors'
import { hitRateLimit } from '../security/rate-limit'

const DAY_MS = 24 * 60 * 60 * 1000

// ── 공급자 ───────────────────────────────────────────────────────────────

let providerOverride: AiProvider | null | undefined
let envOverride: AiEnv | null = null
/** 테스트용: 쓸 공급자(null이면 꺼짐, undefined면 환경 변수). 가짜 공급자는 NODE_ENV=test에서만 만들 수 있습니다. */
export function setAiProviderForTesting(provider: AiProvider | null | undefined): void {
  providerOverride = provider
}
/** 테스트용: 한도 등 환경 변수 대신 쓸 값(null이면 process.env). */
export function setAiEnvForTesting(env: AiEnv | null): void {
  envOverride = env
}

/** 실행 시 환경(빌드 도구가 process.env를 상수로 바꾸지 않도록 이름으로 골라 읽음). */
function currentEnv(): AiEnv {
  if (envOverride) return envOverride
  const env = (globalThis.process?.env ?? {}) as AiEnv
  const out: Record<string, string | undefined> = {}
  for (const name of AI_ENV_NAMES) out[name] = env[name]
  return out
}

let cached: { key: string; provider: AiProvider | null } | null = null
/** 지금 공급자(없으면 null). 환경이 같으면 같은 객체를 씁니다. 캐시 키는 메모리에만 둡니다(키 원문을 로그·응답에 싣지 않음). */
export function aiProvider(): AiProvider | null {
  if (providerOverride !== undefined) return providerOverride
  const env = currentEnv()
  const key = AI_ENV_NAMES.map((n) => `${n}=${env[n] ?? ''}`).join('\n')
  if (cached?.key !== key) cached = { key, provider: aiProviderKind(env) ? resolveAiProvider(env) : null }
  return cached.provider
}

/** AI 기능이 설정되어 있는지(`GET /features`의 ai). */
export function aiConfigured(): boolean {
  return aiProvider() !== null
}

/** 설정되어 있지 않으면 404(그런 기능이 있는지도 드러내지 않음). */
export function requireAiConfigured(): AiProvider {
  const provider = aiProvider()
  if (!provider) throw notFound()
  return provider
}

// ── 비용 상한·사용량 ─────────────────────────────────────────────────────

const utcDay = (now: Date) => now.toISOString().slice(0, 10)

/** 오늘(UTC) 서버 전체 토큰 합계. */
async function tokensToday(db: DbExecutor, now: Date): Promise<number> {
  const [row] = await db
    .select({
      n: sql<string>`coalesce(sum(${aiUsageDaily.inputTokens} + ${aiUsageDaily.outputTokens} + ${aiUsageDaily.cacheReadTokens} + ${aiUsageDaily.cacheCreationTokens}), 0)`,
    })
    .from(aiUsageDaily)
    .where(eq(aiUsageDaily.day, utcDay(now)))
  return Number(row?.n ?? 0)
}

/** 부르기 전 비용 상한 확인. 넘으면 429(공급자를 부르지 않음). */
export async function guardAiCall(db: DbExecutor, actor: Actor, now: Date): Promise<void> {
  const limits = parseAiLimits(currentEnv())
  if (limits.globalDailyTokens > 0 && (await tokensToday(db, now)) >= limits.globalDailyTokens) throw rateLimited()
  if (!(await hitRateLimit(db, 'ai:user-day', actor.userId, { limit: limits.userDailyRequests, windowMs: DAY_MS }, now))) throw rateLimited()
  if (!(await hitRateLimit(db, 'ai:global-day', 'all', { limit: limits.globalDailyRequests, windowMs: DAY_MS }, now))) throw rateLimited()
}

type Outcome = 'ok' | 'fallback' | 'refusal' | 'failure'

/** 날짜·기능·모델별 토큰 수·횟수를 더합니다(사람·내용 없음). */
export async function recordAiUsage(db: DbExecutor, feature: string, model: string, usage: AiUsage | null, outcome: Outcome, now: Date): Promise<void> {
  const u = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  const values = {
    requests: 1,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadInputTokens,
    cacheCreationTokens: u.cacheCreationInputTokens,
    refusals: outcome === 'refusal' ? 1 : 0,
    fallbacks: outcome === 'fallback' ? 1 : 0,
    failures: outcome === 'failure' ? 1 : 0,
  }
  await db
    .insert(aiUsageDaily)
    .values({ day: utcDay(now), feature, model, ...values })
    .onConflictDoUpdate({
      target: [aiUsageDaily.day, aiUsageDaily.feature, aiUsageDaily.model],
      set: {
        requests: sql`${aiUsageDaily.requests} + 1`,
        inputTokens: sql`${aiUsageDaily.inputTokens} + ${values.inputTokens}`,
        outputTokens: sql`${aiUsageDaily.outputTokens} + ${values.outputTokens}`,
        cacheReadTokens: sql`${aiUsageDaily.cacheReadTokens} + ${values.cacheReadTokens}`,
        cacheCreationTokens: sql`${aiUsageDaily.cacheCreationTokens} + ${values.cacheCreationTokens}`,
        refusals: sql`${aiUsageDaily.refusals} + ${values.refusals}`,
        fallbacks: sql`${aiUsageDaily.fallbacks} + ${values.fallbacks}`,
        failures: sql`${aiUsageDaily.failures} + ${values.failures}`,
      },
    })
}

/** 오늘(UTC) 기능별 사용량(운영·테스트용). */
export async function aiUsageOn(db: DbExecutor, day: string, feature: string) {
  return db
    .select()
    .from(aiUsageDaily)
    .where(and(eq(aiUsageDaily.day, day), eq(aiUsageDaily.feature, feature)))
}

/**
 * 상한 확인 → 공급자 호출 → 사용량 기록. 트랜잭션 밖에서 부르세요. 실패는 ServiceError(429·503)로 바꿉니다.
 * 서버 로그에는 기능 이름·오류 종류·상태 코드만 남깁니다.
 */
export async function callAi<T>(db: DbExecutor, actor: Actor, request: AiStructuredRequest<T>, now: Date): Promise<AiStructuredResult<T>> {
  const provider = requireAiConfigured()
  await guardAiCall(db, actor, now)
  try {
    const result = await provider.generateStructured(request)
    await recordAiUsage(db, request.feature, result.model, result.usage, result.fallback ? 'fallback' : 'ok', now)
    return result
  } catch (error) {
    if (!(error instanceof AiError)) throw error
    await recordAiUsage(db, request.feature, provider.model, error.usage, error.kind === 'refusal' ? 'refusal' : 'failure', now)
    console.warn(`[ai] ${request.feature}: ${error.kind}${error.status === null ? '' : ` (${error.status})`}`)
    throw unavailable(error.kind === 'refusal' ? 'ai_declined' : 'ai_unavailable')
  }
}
