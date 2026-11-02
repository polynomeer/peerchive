/**
 * Peerchive worker 진입점(ADR 0004). outbox 전달, 파일 검사 작업, 공개 게시·철회 이벤트(파생 데이터 정리, ADR 0012),
 * 과목 허브 파생 데이터(검색 색인·유용성 신호·선배 노트 색인, ADR 0013), 케이스 스터디 이용 불가 표시(ADR 0014),
 * 운영 조치의 검색 문서 맞추기(ADR 0015), 공개 막힘 임베딩 색인(공급자 설정 시, ADR 0055), 페르소나 활동 투영(ADR 0035), 운영 주기 작업(만료 행·격리 파일 정리, 탈퇴 계정 정리, ADR 0016), 소셜 링크 되돌림 확인·재확인(ADR 0034)과
 * 상태 기록(1분마다)을 처리합니다.
 *
 * 실행: `pnpm worker`(저장소 루트, 개발용) 또는 `pnpm --filter worker start`.
 * 종료 신호(SIGINT/SIGTERM)를 받으면 새 작업을 받지 않고 진행 중인 작업을 기다린 뒤(최대 30초) 연결을 닫습니다.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PgBoss } from 'pg-boss'
import { createDb, pingDb } from '@peerchive/db'
import { parseEmbeddingLimits, resolveEmbeddingProvider } from '@peerchive/embeddings'
import { loadWorkerConfig } from './config'
import { registerCourseHubDerived, registerCourseQaQueues, registerSeniorNoteQueues } from './course-hub-derived'
import { dispatchOutbox } from './dispatcher'
import { registerModerationQueue } from './moderation-derived'
import { registerPersonaActivityQueue } from './persona-activities'
import { registerPortfolioDerived } from './portfolio-derived'
import { registerDerivedCleanup, registerPublicationQueues } from './publication-events'
import { registerAlbumPhotoScanQueue, registerCertificateScanQueue, registerPostMediaScanQueue, registerScanQueue } from './scan-worker'
import { registerSocialLinkQueue } from './social-links'
import { parseStuckEmbeddingCron, registerStuckEmbeddingQueue, stuckEmbeddingsCleanupHandler } from './stuck-embeddings'
import { OPS_TIMEZONE, loadOpsConfig } from './ops/config'
import { registerOpsSchedules, startHeartbeat } from './ops/schedules'

// 저장소 루트의 .env(로컬 전용)가 있으면 읽습니다. 이미 설정된 환경 변수가 우선합니다.
const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv)

const config = loadWorkerConfig(process.env)
// production에서 삭제 장부 pepper가 없거나 약하면 여기서 멈춥니다(탈퇴 정리·재적용이 같은 값을 써야 함).
const opsConfig = loadOpsConfig(process.env)
if (process.env.PEERCHIVE_MAINTENANCE && /^(1|true|yes|on)$/i.test(process.env.PEERCHIVE_MAINTENANCE.trim())) {
  console.warn('[worker] PEERCHIVE_MAINTENANCE is set: run `pnpm ops:reapply-deletions` before starting the worker after a restore (RUNBOOK).')
}
const db = createDb(config.databaseUrl, { max: config.scanConcurrency + 2 })
await pingDb(db)
if ('ping' in config.scanner && typeof config.scanner.ping === 'function') await config.scanner.ping()

const boss = new PgBoss({ connectionString: config.databaseUrl, schema: 'pgboss', application_name: 'peerchive-worker' })
boss.on('error', (error) => console.error('[worker] pg-boss error:', error.message))
await boss.start()
await registerScanQueue(boss, db, { storage: config.storage, scanner: config.scanner }, config.scanConcurrency)
// 수료증 파일 검사(I-01): 같은 판정, 파일은 격리 키에 그대로 둡니다.
await registerCertificateScanQueue(boss, db, { storage: config.storage, scanner: config.scanner })
await registerAlbumPhotoScanQueue(boss, db, { storage: config.storage, scanner: config.scanner })
// 공감 라운지 미디어 검사(A-04): 앨범 사진과 같은 판정·메타데이터 제거.
await registerPostMediaScanQueue(boss, db, { storage: config.storage, scanner: config.scanner })
// 과목 허브 파생 데이터(검색 색인·유용성 신호, T-13)를 게시·철회 이벤트에 등록한 뒤 큐를 엽니다.
registerCourseHubDerived()
// 철회·대체된 release에 고정된 케이스 스터디를 이용 불가로 표시(T-14).
registerPortfolioDerived()
// 유사 막힘 임베딩(E-05): 철회·새 release 때 남은 벡터 정리는 공급자 설정과 무관하게 늘 등록합니다.
registerDerivedCleanup(stuckEmbeddingsCleanupHandler)
await registerPublicationQueues(boss, db)
await registerSeniorNoteQueues(boss, db)
// 막힘 Q&A 검색 색인·철회 정리(C-09).
await registerCourseQaQueues(boss, db)
await registerModerationQueue(boss, db)
// 페르소나 활동 투영(S-05): 원본 모듈의 outbox 요청을 받아 지금 원본 행으로 판정한 뒤 넣습니다(거두기는 DB 트리거).
await registerPersonaActivityQueue(boss, db)
// 소셜 링크 되돌림 확인(S-06): 링크 수집기(net/safe-fetch.ts)만 사용자가 붙인 URL에 접속합니다.
if (!opsConfig.siteOrigin) console.warn('[worker] NUXT_SITE_ORIGIN is not set: social link verification is skipped.')
await registerSocialLinkQueue(boss, db, { siteOrigin: opsConfig.siteOrigin, analyticsPepper: opsConfig.analyticsPepper })
// 운영 주기 작업(T-16): 만료 행·주인 없는 격리 파일 정리, 유예 기간이 지난 탈퇴 계정 정리.
await registerOpsSchedules(boss, db, config.storage, opsConfig)
// 공개 막힘 임베딩 색인(E-05): PEERCHIVE_EMBEDDINGS_PROVIDER=voyage + VOYAGE_API_KEY일 때만 일정을 둡니다(공개 스냅샷의 막힘·해결 글만 보냄).
const embeddingProvider = resolveEmbeddingProvider(process.env)
await registerStuckEmbeddingQueue(boss, db, embeddingProvider, parseEmbeddingLimits(process.env), parseStuckEmbeddingCron(process.env.PEERCHIVE_EMBEDDINGS_CRON), OPS_TIMEZONE)
const stopHeartbeat = startHeartbeat(db, { production: config.production, storage: config.storage.driver, scanner: config.scanner.engine })

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
  `[worker] started (storage=${config.storage.driver}, scanner=${config.scanner.engine}, production=${config.production}, purgeGraceDays=${opsConfig.graceDays}, embeddings=${embeddingProvider ? `${embeddingProvider.name}:${embeddingProvider.model}` : 'off'})`,
)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.info(`[worker] ${signal} received, stopping…`)
  clearInterval(timer)
  stopHeartbeat()
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
