/**
 * 운영 주기 작업 등록(T-16, ADR 0004·0016). 작업마다 pg-boss 큐 `ops.<이름>`과 cron 일정(Asia/Seoul)을 두고,
 * 놓친 실행은 한 번만 보냅니다(missed: once). 작업은 idempotent하므로 여러 worker가 있어도 됩니다.
 * 일정 끄기: `PEERCHIVE_CRON_<이름>=off`(config.ts). 끈 작업은 기존 일정도 지웁니다.
 */
import type { PgBoss } from 'pg-boss'
import { WORKER_HEARTBEAT_NAME, type DbExecutor } from '@peerchive/db'
import type { ObjectStorage } from '@peerchive/files'
import { CLEANUP_TASKS, beat, runRecordedTask } from './cleanup'
import { OPS_TASK_NAMES, OPS_TIMEZONE, type OpsConfig, type OpsTaskName } from './config'
import { purgeCertificateFiles } from './certificates'
import { createPostTermPrompts } from './course-term-prompts'
import { applyDueNameModeChanges } from './name-modes'
import { purgeDueAccounts } from './purge'
import { recheckSocialLinks } from '../social-links'

export const opsQueueName = (task: OpsTaskName) => `ops.${task}`

/** 실패하면 몇 번 다시(다음 일정까지 기다리지 않음). 한 번에 10분 넘으면 만료. */
export const OPS_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  expireInSeconds: 10 * 60,
} as const

/** 작업 이름 → 실행 함수. 테스트·수동 실행(`runOpsTask`)에도 씁니다. */
export function opsTaskRunner(db: DbExecutor, storage: ObjectStorage, config: OpsConfig, task: OpsTaskName, now: Date) {
  if (task === 'account-purge') {
    return purgeDueAccounts(
      db,
      { storage, deletionPepper: config.deletionPepper, analyticsPepper: config.analyticsPepper },
      { now, graceDays: config.graceDays, limit: 50 },
    )
  }
  if (task === 'name-mode-changes') return applyDueNameModeChanges(db, { now, analyticsPepper: config.analyticsPepper, limit: 100 })
  // 소셜 링크 재확인(S-06): 링크 수집기(SSRF 방어)로만 접속합니다.
  if (task === 'social-link-recheck') return recheckSocialLinks(db, { siteOrigin: config.siteOrigin, analyticsPepper: config.analyticsPepper }, { now })
  // 수료증 파일 삭제(I-01): 삭제 장부 pepper가 필요해 일반 정리 작업과 따로 둡니다. P2 플래그와 무관하게 돕니다.
  if (task === 'certificate-files') return purgeCertificateFiles(db, { storage, deletionPepper: config.deletionPepper, batchSize: config.batchSize }, now)
  // 학기 종료 알림(E-01): 과목 등록마다 한 번(조건부 갱신이라 겹쳐 돌아도 같음).
  if (task === 'course-term-prompts') return createPostTermPrompts(db, now, config.batchSize)
  return CLEANUP_TASKS[task](db, { storage, batchSize: config.batchSize }, now)
}

export async function runOpsTask(db: DbExecutor, storage: ObjectStorage, config: OpsConfig, task: OpsTaskName, now = new Date()) {
  return runRecordedTask(db, task, () => opsTaskRunner(db, storage, config, task, now))
}

export async function registerOpsSchedules(boss: PgBoss, db: DbExecutor, storage: ObjectStorage, config: OpsConfig): Promise<void> {
  for (const task of OPS_TASK_NAMES) {
    const queue = opsQueueName(task)
    await boss.createQueue(queue, OPS_QUEUE_OPTIONS)
    await boss.updateQueue(queue, OPS_QUEUE_OPTIONS)
    const cron = config.crons[task]
    if (!cron) {
      await boss.unschedule(queue).catch(() => {})
      continue
    }
    await boss.schedule(queue, cron, {}, { tz: OPS_TIMEZONE, missed: 'once' })
    await boss.work(queue, { batchSize: 1, pollingIntervalSeconds: 10 }, async ([job]) => {
      if (!job) return
      await runOpsTask(db, storage, config, task)
    })
  }
}

/** worker 상태 기록(1분마다). 실패해도 worker를 멈추지 않습니다. */
export function startHeartbeat(db: DbExecutor, details: Record<string, string | number | boolean | null>, intervalMs = 60_000): () => void {
  const startedAt = new Date()
  const tick = () => beat(db, WORKER_HEARTBEAT_NAME, details, startedAt).catch((error: Error) => console.error('[worker] heartbeat failed:', error.name))
  void tick()
  const timer = setInterval(tick, intervalMs)
  return () => clearInterval(timer)
}
