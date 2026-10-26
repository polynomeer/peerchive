/**
 * 학교 메일 인증 설정(C-01, ADR 0018).
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_AFFILIATION_PEPPER | (개발·테스트: 고정 개발용 값) | 학교 메일 주소·인증 코드 HMAC 비밀. production에서 없거나 약하면(32자 미만·자리표시) web이 시작하지 않음. 바꾸지 않음 |
 * | PEERCHIVE_HUB_REQUIRE_AFFILIATION | `1` | `1`: 과목 허브 작성(선배 노트 만들기·게시)에 그 과목 학교의 active 학교 메일 인증 필요. `0`: 로컬·개발 전용(인증 없이 작성). production에서 `0`이거나 형식이 틀리면 web이 시작하지 않음 |
 */
import { AFFILIATION_PEPPER_ENV, isProductionMode, resolvePepper } from '@peerchive/db'
import type { HubWritePolicy } from '@peerchive/domain'

export const HUB_REQUIRE_AFFILIATION_ENV = 'PEERCHIVE_HUB_REQUIRE_AFFILIATION'

type Env = Readonly<Record<string, string | undefined>>

let envOverride: Env | null = null
/** 테스트용: 환경 변수 대신 쓸 값(null이면 process.env). */
export function setAffiliationEnvForTesting(env: Env | null): void {
  envOverride = env
}

/** 실행 시 환경(빌드 도구가 process.env.NODE_ENV를 상수로 바꾸므로 대괄호 접근). */
function currentEnv(): Env {
  if (envOverride) return envOverride
  const env = (globalThis.process?.env ?? {}) as Env
  return { NODE_ENV: env['NODE_ENV'], [AFFILIATION_PEPPER_ENV]: env[AFFILIATION_PEPPER_ENV], [HUB_REQUIRE_AFFILIATION_ENV]: env[HUB_REQUIRE_AFFILIATION_ENV] }
}

export interface AffiliationConfig {
  /** production에서 없거나 약하면 null. */
  pepper: string | null
  policy: HubWritePolicy
  /** 시작을 막을 문제(production에서만 채움). */
  problems: string[]
}

/** 설정 해석. 시작 확인(server/plugins/affiliation.ts)과 요청 처리가 같은 규칙을 씁니다. */
export function resolveAffiliationConfig(env: Env): AffiliationConfig {
  const production = isProductionMode(env)
  const problems: string[] = []
  const pepper = resolvePepper(env, AFFILIATION_PEPPER_ENV)
  if (!pepper) problems.push(`${AFFILIATION_PEPPER_ENV} is missing or weak (production requires a random secret of 32+ characters, e.g. openssl rand -hex 32)`)
  const raw = env[HUB_REQUIRE_AFFILIATION_ENV]?.trim() ?? ''
  let requireAffiliation = true
  if (raw === '0') {
    if (production) problems.push(`${HUB_REQUIRE_AFFILIATION_ENV}=0 is for local development only`)
    else requireAffiliation = false
  } else if (raw !== '' && raw !== '1') {
    if (production) problems.push(`${HUB_REQUIRE_AFFILIATION_ENV} must be 1 or 0`)
    else console.warn(`[affiliation] ${HUB_REQUIRE_AFFILIATION_ENV} must be 1 or 0; using 1`)
  }
  return { pepper, policy: { requireAffiliation }, problems: production ? problems : [] }
}

export function affiliationConfig(): AffiliationConfig {
  return resolveAffiliationConfig(currentEnv())
}

/** 과목 허브 작성 정책(요청마다 환경을 읽음 — 바꾸려면 재시작). */
export function hubWritePolicy(): HubWritePolicy {
  return affiliationConfig().policy
}

/** HMAC pepper. production에서 없으면 예외(시작 확인이 먼저 막으므로 정상 배포에서는 일어나지 않음). */
export function affiliationPepper(): string {
  const pepper = affiliationConfig().pepper
  if (!pepper) throw new Error(`${AFFILIATION_PEPPER_ENV} is not configured`)
  return pepper
}
