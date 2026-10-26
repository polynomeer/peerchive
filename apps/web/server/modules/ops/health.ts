/**
 * 운영자용 상세 상태 확인(T-16, SYSTEM_DESIGN §14 관측, ADR 0016). `GET /api/v1/health?deep=1`(운영자만)이 씁니다.
 *
 * DB 왕복, 저장소 쓰기·읽기·지우기 시험(격리 접두어의 일회용 키), worker 상태 기록(1분마다)의 나이, 주기 작업의 마지막 결과,
 * outbox 미전달 수·가장 오래된 나이, pg-boss 실패·dead-letter 작업 수, 유예가 지났는데 정리되지 않은 탈퇴 계정 수를 돌려줍니다.
 * 개수·시각·상태 코드만 싣고 내용·id·접속 정보는 싣지 않습니다.
 */
import { Readable } from 'node:stream'
import {
  WORKER_HEARTBEAT_NAME,
  and,
  eq,
  isNotNull,
  isNull,
  lte,
  outboxEvents,
  pingDb,
  sql,
  users,
  workerHeartbeats,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { newQuarantineKey, readAll, type ObjectStorage } from '@peerchive/files'
import type { DeepHealthDto, HealthCheckStatus } from '../../../shared/types/api'
import { isOperator } from '../catalog/operators'

/** worker가 이 시간(초) 넘게 기록하지 않으면 stale입니다(기록 주기 60초의 세 배). */
export const WORKER_STALE_SECONDS = 180

export type { DeepHealthDto }
type CheckStatus = HealthCheckStatus

export interface DeepHealthDeps {
  db: Database | DbExecutor
  storage: ObjectStorage
  now: Date
  graceDays: number
  flags: DeepHealthDto['flags']
}

const PROBE = Buffer.from('peerchive-health-probe')

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T; ms: number } | { ok: false; ms: number }> {
  const started = performance.now()
  try {
    const value = await fn()
    return { ok: true, value, ms: Math.round(performance.now() - started) }
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) }
  }
}

export async function deepHealth(deps: DeepHealthDeps): Promise<DeepHealthDto> {
  const { db, storage, now } = deps
  const ping = await timed(() => pingDb(db as Database))
  const probe = await timed(async () => {
    const key = newQuarantineKey()
    try {
      await storage.put(key, Readable.from([PROBE]), { maxBytes: PROBE.length })
      const back = await readAll(await storage.get(key), PROBE.length)
      if (!back.equals(PROBE)) throw new Error('probe mismatch')
    } finally {
      await storage.delete(key).catch(() => {})
    }
  })

  const empty = { worker: null as null | typeof workerHeartbeats.$inferSelect, tasks: [] as Array<typeof workerHeartbeats.$inferSelect> }
  const beats = ping.ok
    ? await db
        .select()
        .from(workerHeartbeats)
        .then((rows) => ({ worker: rows.find((r) => r.name === WORKER_HEARTBEAT_NAME) ?? null, tasks: rows.filter((r) => r.name.startsWith('task:')) }))
        .catch(() => empty)
    : empty
  const age = beats.worker ? Math.max(0, Math.round((now.getTime() - beats.worker.beatAt.getTime()) / 1000)) : null
  const workerStatus: CheckStatus = !beats.worker ? 'missing' : age! > WORKER_STALE_SECONDS ? 'stale' : 'ok'

  let outbox: DeepHealthDto['outbox'] = { backlog: 0, oldestAgeSeconds: null }
  let jobs: DeepHealthDto['jobs'] = { failed: {}, deadLetter: {}, available: false }
  let overdue = 0
  if (ping.ok) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${outboxEvents.createdAt})::text` })
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt))
    outbox = {
      backlog: row?.n ?? 0,
      oldestAgeSeconds: row?.oldest ? Math.max(0, Math.round((now.getTime() - new Date(row.oldest).getTime()) / 1000)) : null,
    }
    try {
      const result = await db.execute(sql`
        select name, state, count(*)::int as n from pgboss.job
        where state = 'failed' or (name like '%-dead' and state <> 'completed')
        group by name, state`)
      const rows = result as unknown as Array<{ name: string; state: string; n: number }>
      jobs = { failed: {}, deadLetter: {}, available: true }
      for (const r of rows) {
        if (r.name.endsWith('-dead')) jobs.deadLetter[r.name] = (jobs.deadLetter[r.name] ?? 0) + Number(r.n)
        else jobs.failed[r.name] = Number(r.n)
      }
    } catch {
      jobs = { failed: {}, deadLetter: {}, available: false }
    }
    // 유예 + 하루가 지났는데 정리되지 않은 탈퇴 계정(삭제 실패·worker 정지 신호).
    const cutoff = new Date(now.getTime() - (deps.graceDays + 1) * 86_400_000)
    const [due] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.status, 'deleted'), isNull(users.purgedAt), isNotNull(users.deletionRequestedAt), lte(users.deletionRequestedAt, cutoff)))
    overdue = due?.n ?? 0
  }

  const tasks = beats.tasks
    .map((t) => ({
      name: t.name.slice('task:'.length),
      lastRunAt: t.beatAt.toISOString(),
      status: typeof t.details.status === 'string' ? t.details.status : 'unknown',
      affected: typeof t.details.affected === 'number' ? t.details.affected : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const degraded =
    !ping.ok || !probe.ok || workerStatus !== 'ok' || overdue > 0 || Object.keys(jobs.deadLetter).length > 0 || tasks.some((t) => t.status === 'error')
  return {
    status: degraded ? 'degraded' : 'ok',
    checkedAt: now.toISOString(),
    flags: deps.flags,
    db: { status: ping.ok ? 'ok' : 'error', latencyMs: ping.ok ? ping.ms : null },
    storage: { status: probe.ok ? 'ok' : 'error', driver: storage.driver, latencyMs: probe.ok ? probe.ms : null },
    worker: { status: workerStatus, lastBeatAt: beats.worker?.beatAt.toISOString() ?? null, ageSeconds: age, startedAt: beats.worker?.startedAt?.toISOString() ?? null },
    tasks,
    outbox,
    jobs,
    deletion: { overdue, graceDays: deps.graceDays },
  }
}

/** 상세 확인 권한: 로그인하지 않았으면 401, 운영자가 아니면 403. */
export async function deepHealthAccess(db: DbExecutor, userId: string | null): Promise<'ok' | 401 | 403> {
  if (!userId) return 401
  return (await isOperator(db, userId)) ? 'ok' : 403
}

/** PEERCHIVE_DELETION_GRACE_DAYS(worker와 같은 값, 기본 7). */
export function deletionGraceDays(env: Readonly<Record<string, string | undefined>>): number {
  const value = Number(env.PEERCHIVE_DELETION_GRACE_DAYS?.trim() || '7')
  return Number.isInteger(value) && value >= 0 && value <= 90 ? value : 7
}
