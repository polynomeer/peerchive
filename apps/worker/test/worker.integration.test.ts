/**
 * worker 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * - outbox 전달기: 트랜잭션 rollback으로 데이터를 남기지 않습니다.
 * - pg-boss: 테스트 전용 스키마를 만들고 끝나면 지웁니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { PgBoss } from 'pg-boss'
import { createDb, eq, outboxEvents, sql, type Database } from '@peerchive/db'
import { ARTIFACT_SCAN_QUEUE } from '@peerchive/files'
import { dispatchOutbox } from '../src/dispatcher'
import { SCAN_DEAD_LETTER_QUEUE, SCAN_QUEUE_OPTIONS } from '../src/scan-worker'

const url = process.env.DATABASE_URL
class Rollback extends Error {}

describe.skipIf(!url)('worker (PostgreSQL)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined
  afterAll(async () => {
    await db?.$client.end()
  })

  it('dispatches undispatched outbox rows once, using the row id as the job id; failures stay queued', async () => {
    await expect(
      db!.transaction(async (tx) => {
        // 개발 DB에 남아 있는 미전달 행이 있어도 이 테스트의 결과만 보도록 기준값을 잽니다.
        const [before] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(outboxEvents)
          .where(sql`${outboxEvents.dispatchedAt} is null and ${outboxEvents.topic} <> 'broken-queue'`)
        const rows = await tx
          .insert(outboxEvents)
          .values([
            { topic: ARTIFACT_SCAN_QUEUE, payload: { versionId: crypto.randomUUID() } },
            { topic: 'broken-queue', payload: { versionId: crypto.randomUUID() } },
          ])
          .returning()
        const sent: Array<[string, unknown, { id: string }]> = []
        const count = await dispatchOutbox(tx, async (queue, data, options) => {
          if (queue === 'broken-queue') throw new Error('queue missing')
          sent.push([queue, data, options])
        })
        expect(count).toBe(1 + (before?.n ?? 0))
        expect(sent.filter(([, , o]) => rows.some((r) => r.id === o.id))).toEqual([
          [ARTIFACT_SCAN_QUEUE, rows[0]!.payload, { id: rows[0]!.id }],
        ])
        const [done] = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, rows[0]!.id))
        const [left] = await tx.select().from(outboxEvents).where(eq(outboxEvents.id, rows[1]!.id))
        expect(done!.dispatchedAt).not.toBeNull()
        expect(left!.dispatchedAt).toBeNull()
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  })

  it('pg-boss: queues with retry/dead-letter and the same job id is only inserted once', async () => {
    const schema = `pgboss_test_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
    const boss = new PgBoss({ connectionString: url!, schema, max: 2 })
    boss.on('error', () => {})
    try {
      await boss.start()
      await boss.createQueue(SCAN_DEAD_LETTER_QUEUE)
      await boss.createQueue(ARTIFACT_SCAN_QUEUE, SCAN_QUEUE_OPTIONS)
      const queue = await boss.getQueue(ARTIFACT_SCAN_QUEUE)
      expect(queue).toMatchObject({ retryLimit: 5, retryBackoff: true, deadLetter: SCAN_DEAD_LETTER_QUEUE })

      const id = crypto.randomUUID()
      expect(await boss.send(ARTIFACT_SCAN_QUEUE, { versionId: id }, { id })).toBe(id)
      expect(await boss.send(ARTIFACT_SCAN_QUEUE, { versionId: id }, { id })).toBeNull()
      const [job] = await boss.fetch<{ versionId: string }>(ARTIFACT_SCAN_QUEUE)
      expect(job).toMatchObject({ id, data: { versionId: id }, retryCount: 0 })
      expect(await boss.fetch(ARTIFACT_SCAN_QUEUE)).toEqual([])
    } finally {
      await boss.stop({ graceful: false, close: true })
      await db!.execute(sql.raw(`drop schema if exists "${schema}" cascade`))
    }
  })
})
