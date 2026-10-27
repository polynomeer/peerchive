/**
 * 이름 표시 방식 변경 적용을 한 번 실행하는 명령(C-03, ADR 0020). 주기 작업 `name-mode-changes`와 같은 함수입니다.
 *
 *   pnpm --filter worker apply-name-modes
 *
 * 대상은 DATABASE_URL입니다. effective_at이 지난 예약만 적용하며(조건부 update), 이미 적용된 예약은 건드리지 않으므로 몇 번 실행해도 됩니다.
 * 운영에서는 worker가 1분마다 하므로 보통 필요 없습니다(worker를 멈춘 채 밀린 예약을 바로 적용할 때, E2E 시나리오). 출력에는 개수만 남깁니다.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ANALYTICS_PEPPER_ENV, createDb, resolvePepper } from '@peerchive/db'
import { applyDueNameModeChanges } from './ops/name-modes'

const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const url = process.env.DATABASE_URL?.trim() || process.env.NUXT_DATABASE_URL?.trim()
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(2)
}
const db = createDb(url, { max: 2 })
try {
  const result = await applyDueNameModeChanges(db, { now: new Date(), analyticsPepper: resolvePepper(process.env, ANALYTICS_PEPPER_ENV) })
  console.info(`[apply-name-modes] applied=${result.affected} failed=${result.failed ?? 0}`)
  if (result.failed) process.exitCode = 1
} catch (error) {
  console.error(`[apply-name-modes] failed: ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  await db.$client.end({ timeout: 5 })
}
