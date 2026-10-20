/**
 * 공개 게시·철회 outbox 소비(T-12, SYSTEM_DESIGN §1-4·§11, ADR 0012).
 *
 * - `publication.withdrawn`: 등록된 파생 데이터 정리 handler(T-13 검색 색인·유용성 신호, T-14 포트폴리오·케이스 …)를 차례로 실행하고
 *   `publication.derived_cleanup` 감사 이벤트를 (공개, access_epoch)마다 한 번 남깁니다.
 * - `publication.published`: 등록된 handler의 onPublished(T-13 검색 색인, 대체된 release의 신호 정리)를 실행합니다.
 *   T-13 handler는 course-hub-derived.ts, T-14 케이스 스터디 handler는 portfolio-derived.ts에 있고 main.ts가 등록합니다.
 * - 공개 읽기는 이 worker에 기대지 않습니다. 웹의 공개 조회는 요청마다 공개 상태를 DB에서 확인하므로, 이 작업이 늦거나 실패해도
 *   철회된 공개는 이미 보이지 않습니다. 정리 handler는 "보이지 않게"가 아니라 "남은 사본 지우기"를 맡습니다.
 * - handler는 idempotent해야 합니다(재시도·중복 전달). payload의 accessEpoch보다 오래된 파생 행만 지우는 식으로 씁니다.
 */
import type { PgBoss } from 'pg-boss'
import {
  PUBLICATION_PUBLISHED_TOPIC,
  PUBLICATION_WITHDRAWN_TOPIC,
  and,
  auditEvents,
  eq,
  sql,
  type DbExecutor,
  type PublicationOutboxPayload,
} from '@peerchive/db'

export const PUBLICATION_QUEUE_OPTIONS = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 30 * 60,
  expireInSeconds: 5 * 60,
} as const

/** 파생 데이터 정리 handler. 지운(또는 이용 불가로 표시한) 행 수를 돌려줍니다. */
export interface DerivedCleanupHandler {
  /** 감사 기록에 남는 짧은 이름(예: 'search-index'). */
  name: string
  onWithdrawn(db: DbExecutor, event: PublicationOutboxPayload): Promise<number>
  /** 선택: 새 release 게시 때(예: 색인 갱신, 이전 release 행 정리). */
  onPublished?(db: DbExecutor, event: PublicationOutboxPayload): Promise<number>
}

/** 등록된 handler. T-13/T-14가 `registerDerivedCleanup`으로 더합니다. */
const registry: DerivedCleanupHandler[] = []

export function registerDerivedCleanup(handler: DerivedCleanupHandler): void {
  if (registry.some((h) => h.name === handler.name)) throw new Error(`derived cleanup handler already registered: ${handler.name}`)
  registry.push(handler)
}

export function derivedCleanupHandlers(): readonly DerivedCleanupHandler[] {
  return registry
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** payload 검사. 형식이 틀리면 null(재시도해도 같으므로 기록만 하고 끝냄). */
export function parsePublicationPayload(data: unknown): PublicationOutboxPayload | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const ids = ['publicationId', 'projectId', 'releaseId'] as const
  if (!ids.every((k) => typeof d[k] === 'string' && UUID.test(d[k] as string))) return null
  if (!Number.isInteger(d.accessEpoch) || (d.accessEpoch as number) < 0) return null
  if (!Number.isInteger(d.releaseNo) || (d.releaseNo as number) < 0) return null
  if (d.cause !== undefined && d.cause !== 'owner' && d.cause !== 'consent_revoked') return null
  return {
    publicationId: d.publicationId as string,
    projectId: d.projectId as string,
    releaseId: d.releaseId as string,
    releaseNo: d.releaseNo as number,
    accessEpoch: d.accessEpoch as number,
    ...(d.cause !== undefined && { cause: d.cause as 'owner' | 'consent_revoked' }),
  }
}

export interface CleanupOutcome {
  status: 'cleaned' | 'already_recorded' | 'invalid'
  handlers: string[]
  affected: number
}

/**
 * 철회 이벤트 하나 처리(테스트에서도 직접 부름). handler 실행과 감사 기록을 한 트랜잭션에서 하고,
 * 같은 (공개, access_epoch)의 감사 기록이 이미 있으면 handler만 다시 돌리지 않고 끝냅니다(중복 전달).
 */
export async function handlePublicationWithdrawn(
  db: DbExecutor,
  data: unknown,
  handlers: readonly DerivedCleanupHandler[] = registry,
): Promise<CleanupOutcome> {
  const event = parsePublicationPayload(data)
  if (!event) {
    console.error('[worker] publication.withdrawn: invalid payload')
    return { status: 'invalid', handlers: [], affected: 0 }
  }
  return db.transaction(async (tx) => {
    // 같은 공개의 정리를 직렬화합니다(동시에 두 번 전달돼도 감사 기록 하나).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`derived-cleanup:${event.publicationId}`}))`)
    const [done] = await tx
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, 'publication.derived_cleanup'),
          eq(auditEvents.targetId, event.publicationId),
          sql`${auditEvents.metadata}->>'accessEpoch' = ${String(event.accessEpoch)}`,
        ),
      )
      .limit(1)
    if (done) return { status: 'already_recorded' as const, handlers: [], affected: 0 }
    let affected = 0
    for (const handler of handlers) affected += await handler.onWithdrawn(tx, event)
    await tx.insert(auditEvents).values({
      actorId: null,
      action: 'publication.derived_cleanup',
      targetType: 'publication',
      targetId: event.publicationId,
      projectId: event.projectId,
      metadata: {
        accessEpoch: event.accessEpoch,
        releaseNo: event.releaseNo,
        cause: event.cause ?? null,
        handlers: handlers.map((h) => h.name).join(','),
        affected,
      },
    })
    return { status: 'cleaned' as const, handlers: handlers.map((h) => h.name), affected }
  })
}

/** 게시 이벤트 하나 처리. 등록된 onPublished만 실행합니다(지금은 없음). */
export async function handlePublicationPublished(
  db: DbExecutor,
  data: unknown,
  handlers: readonly DerivedCleanupHandler[] = registry,
): Promise<number> {
  const event = parsePublicationPayload(data)
  if (!event) {
    console.error('[worker] publication.published: invalid payload')
    return 0
  }
  let affected = 0
  for (const handler of handlers) if (handler.onPublished) affected += await handler.onPublished(db, event)
  return affected
}

/** 큐 만들기와 작업 등록. outbox 전달기가 이 큐 이름(=topic)으로 보내므로 큐가 있어야 전달됩니다. */
export async function registerPublicationQueues(boss: PgBoss, db: DbExecutor): Promise<void> {
  for (const queue of [PUBLICATION_PUBLISHED_TOPIC, PUBLICATION_WITHDRAWN_TOPIC]) {
    await boss.createQueue(queue, PUBLICATION_QUEUE_OPTIONS)
    await boss.updateQueue(queue, PUBLICATION_QUEUE_OPTIONS)
  }
  await boss.work<Record<string, unknown>>(PUBLICATION_WITHDRAWN_TOPIC, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return
    const outcome = await handlePublicationWithdrawn(db, job.data)
    // 로그에는 id·결과만(제목·이름 없음).
    console.info(`[worker] publication.withdrawn ${job.id}: ${outcome.status} handlers=${outcome.handlers.length} affected=${outcome.affected}`)
  })
  await boss.work<Record<string, unknown>>(PUBLICATION_PUBLISHED_TOPIC, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return
    const affected = await handlePublicationPublished(db, job.data)
    console.info(`[worker] publication.published ${job.id}: handlers=${derivedCleanupHandlers().length} affected=${affected}`)
  })
}
