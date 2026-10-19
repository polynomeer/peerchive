/**
 * outbox 전달기(ADR 0004). 웹앱이 상태 변경과 같은 트랜잭션에 남긴 outbox_events 행을 pg-boss 작업으로 옮깁니다.
 *
 * - 행을 FOR UPDATE SKIP LOCKED로 잡아 worker가 여럿이어도 한 행을 한 번에 하나만 처리합니다.
 * - outbox 행 id를 작업 id로 보내므로(pg-boss는 같은 id를 다시 넣지 않음) 전달 뒤 표시 전에 죽어도 작업이 중복되지 않습니다.
 * - 전달에 실패한 행은 그대로 두고 다음 주기에 다시 시도합니다.
 */
import { asc, inArray, isNull, outboxEvents, sql, type DbExecutor } from '@peerchive/db'

export type SendJob = (queue: string, data: Record<string, unknown>, options: { id: string }) => Promise<unknown>

export async function dispatchOutbox(db: DbExecutor, send: SendJob, limit = 50): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outboxEvents)
      .where(isNull(outboxEvents.dispatchedAt))
      .orderBy(asc(outboxEvents.createdAt))
      .limit(limit)
      .for('update', { skipLocked: true })
    if (rows.length === 0) return 0
    const sent: string[] = []
    for (const row of rows) {
      try {
        await send(row.topic, row.payload, { id: row.id })
        sent.push(row.id)
      } catch (error) {
        console.error(`[worker] outbox dispatch failed (topic=${row.topic}):`, (error as Error).message)
      }
    }
    if (sent.length > 0) {
      await tx.update(outboxEvents).set({ dispatchedAt: sql`now()` }).where(inArray(outboxEvents.id, sent))
    }
    return sent.length
  })
}
