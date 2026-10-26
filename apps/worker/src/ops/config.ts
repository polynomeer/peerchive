/**
 * 운영 작업 설정(T-16, ADR 0016): 주기 정리 일정·배치 크기, 탈퇴 정리 유예 기간, pepper.
 *
 * | 변수 | 기본값 | 내용 |
 * |---|---|---|
 * | PEERCHIVE_DELETION_PEPPER | (개발용 고정 값) | 삭제 장부 HMAC 비밀. production에서 없거나 약하면 worker·재적용 명령이 시작하지 않음. 바꾸지 않음 |
 * | PEERCHIVE_ANALYTICS_PEPPER | (개발용 고정 값) | 분석 이벤트 HMAC 비밀(웹과 같은 값). 탈퇴 정리 때 그 사람의 이벤트를 찾는 데만 씀. 없으면 이벤트 삭제를 건너뜀 |
 * | PEERCHIVE_DELETION_GRACE_DAYS | 7 | 탈퇴 요청 뒤 정리까지 유예 일수(0–90). 0이면 다음 정리 주기에 바로 |
 * | PEERCHIVE_OPS_BATCH_SIZE | 500 | 정리 작업 한 번의 삭제 행 수(10–10000) |
 * | PEERCHIVE_CRON_<작업> | 작업별 기본값 | 5필드 cron(Asia/Seoul) 또는 `off`. 예: PEERCHIVE_CRON_ACCOUNT_PURGE='* * * * *' |
 */
import { DELETION_PEPPER_ENV, ANALYTICS_PEPPER_ENV, isProductionMode, resolvePepper } from '@peerchive/db'

export const OPS_TASK_NAMES = [
  'upload-intents',
  'orphan-quarantine',
  'rate-limit-buckets',
  'internal-nonces',
  'magic-link-tokens',
  'sessions',
  'discord-codes',
  'pin-requests',
  'outbox',
  'affiliation-codes',
  'account-purge',
] as const
export type OpsTaskName = (typeof OPS_TASK_NAMES)[number]

/** 기본 일정(Asia/Seoul). 서로 겹치지 않게 분을 흩어 둡니다. */
export const DEFAULT_CRONS: Record<OpsTaskName, string> = {
  'upload-intents': '*/15 * * * *',
  'orphan-quarantine': '23 * * * *',
  'rate-limit-buckets': '7 * * * *',
  'internal-nonces': '*/10 * * * *',
  'magic-link-tokens': '11 3 * * *',
  sessions: '13 * * * *',
  'discord-codes': '17 * * * *',
  'pin-requests': '*/10 * * * *',
  outbox: '41 4 * * *',
  'affiliation-codes': '27 * * * *',
  'account-purge': '*/30 * * * *',
}

export const OPS_TIMEZONE = 'Asia/Seoul'

export interface OpsConfig {
  production: boolean
  deletionPepper: string
  analyticsPepper: string | null
  graceDays: number
  batchSize: number
  /** null이면 그 작업을 예약하지 않음(off). */
  crons: Record<OpsTaskName, string | null>
}

type Env = Readonly<Record<string, string | undefined>>

export const cronEnvName = (task: OpsTaskName) => `PEERCHIVE_CRON_${task.toUpperCase().replace(/-/g, '_')}`

const CRON_FIELD = /^[0-9*/,-]+$/

/** 5필드 cron 형식만 받습니다(값의 범위는 pg-boss가 검사). */
export function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/)
  return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f))
}

function intEnv(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer ${min}–${max}`)
  return value
}

export function loadOpsConfig(env: Env): OpsConfig {
  const production = isProductionMode(env)
  const deletionPepper = resolvePepper(env, DELETION_PEPPER_ENV)
  if (!deletionPepper) {
    throw new Error(`${DELETION_PEPPER_ENV} is missing or weak (production requires a random secret of 32+ characters, e.g. openssl rand -hex 32)`)
  }
  const crons = {} as Record<OpsTaskName, string | null>
  for (const task of OPS_TASK_NAMES) {
    const name = cronEnvName(task)
    const raw = env[name]?.trim()
    if (!raw) crons[task] = DEFAULT_CRONS[task]
    else if (raw === 'off') crons[task] = null
    else if (isCronExpression(raw)) crons[task] = raw
    else throw new Error(`${name} must be a 5-field cron expression or "off"`)
  }
  return {
    production,
    deletionPepper,
    analyticsPepper: resolvePepper(env, ANALYTICS_PEPPER_ENV),
    graceDays: intEnv(env, 'PEERCHIVE_DELETION_GRACE_DAYS', 7, 0, 90),
    batchSize: intEnv(env, 'PEERCHIVE_OPS_BATCH_SIZE', 500, 10, 10_000),
    crons,
  }
}
