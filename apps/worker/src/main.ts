/**
 * Peerchive worker 진입점(ADR 0004). outbox 전달, 파일 검사 작업, 공개 게시·철회 이벤트(파생 데이터 정리, ADR 0012)를 처리합니다.
 *
 * 실행: `pnpm worker`(저장소 루트, 개발용) 또는 `pnpm --filter worker start`.
 * 종료 신호(SIGINT/SIGTERM)를 받으면 새 작업을 받지 않고 진행 중인 작업을 기다린 뒤(최대 30초) 연결을 닫습니다.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PgBoss } from 'pg-boss'
import { createDb, pingDb } from '@peerchive/db'
import { loadWorkerConfig } from './config'
import { dispatchOutbox } from './dispatcher'
import { registerPublicationQueues } from './publication-events'
import { registerScanQueue } from './scan-worker'

// 저장소 루트의 .env(로컬 전용)가 있으면 읽습니다. 이미 설정된 환경 변수가 우선합니다.
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const config = loadWorkerConfig(process.env)
const db = createDb(config.databaseUrl, { max: config.scanConcurrency + 2 })
await pingDb(db)
if ('ping' in config.scanner && typeof config.scanner.ping === 'function') await config.scanner.ping()

const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss', application_name: 'peerchive-worker' })
boss.on('error', (error) => console.error('[worker] pg-boss error:', error.message))
await boss.start()
await registerScanQueue(boss, db, { storage: config.storage, scanner: config.scanner }, config.scanConcurrency)
await registerPublicationQueues(boss, db)

let dispatching = false
const timer = setInterval(() => {
  if (dispatching) return
  dispatching = true
  dispatchOutbox(db, (queue, data, options) => boss.send(queue, data, options))
    .catch((error: Error) => console.error('[worker] outbox dispatch error:', error.message))
    .finally(() => {
      dispatching = false
    })
}, config.dispatchIntervalMs)

console.info(
  `[worker] started (storage=${config.storage.driver}, scanner=${config.scanner.engine}, production=${config.production})`,
)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.info(`[worker] ${signal} received, stopping…`)
  clearInterval(timer)
  try {
    await boss.stop({ graceful: true, timeout: 30_000 })
  } finally {
    await db.$client.end({ timeout: 5 })
  }
  console.info('[worker] stopped')
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
