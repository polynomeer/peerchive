/**
 * 과목 허브 파생 데이터 handler (T-13, SYSTEM_DESIGN §1-4·§11, ADR 0012·0013).
 *
 * - 검색 문서(search_documents)와 유용성 신호(usefulness_signals)는 편의용 파생 데이터입니다. 웹의 공개 읽기는 항상 공개·release·노트 행과
 *   조인해 지금 게시 상태를 같은 쿼리에서 확인하므로, 이 handler가 늦거나 실패해도 철회된 내용은 보이지 않습니다.
 *   handler의 일은 "남은 사본 지우기"와 "새 게시 색인"입니다.
 * - 게시 handler는 이벤트가 낡았으면(그 사이 철회·새 버전·노트 수정) 아무것도 만들지 않습니다: 지금 상태가 이벤트와 같을 때만 색인합니다.
 *   철회가 먼저 처리되고 게시가 나중에 처리돼도 철회된 내용을 다시 색인하지 않습니다.
 * - 모두 idempotent합니다(재시도·중복 전달).
 */
import type { PgBoss } from 'pg-boss'
import {
  type HubSnapshot,
  extractStuckItems,
  searchDocFromSeniorNote,
  searchDocsFromSnapshot,
  type SeniorNoteAnswers,
} from '@peerchive/domain'
import {
  SENIOR_NOTE_PUBLISHED_TOPIC,
  SENIOR_NOTE_WITHDRAWN_TOPIC,
  and,
  eq,
  ne,
  notInArray,
  publicationCandidates,
  publications,
  searchDocuments,
  seniorNotes,
  sql,
  usefulnessSignals,
  type DbExecutor,
  type PublicationOutboxPayload,
  type SeniorNoteOutboxPayload,
} from '@peerchive/db'
import { PUBLICATION_QUEUE_OPTIONS, type DerivedCleanupHandler, registerDerivedCleanup } from './publication-events'

/** 이벤트의 release가 지금도 그 공개의 게시 중인 release인지(같은 access_epoch). 아니면 null. */
async function currentRelease(db: DbExecutor, event: PublicationOutboxPayload) {
  const [row] = await db
    .select({ publication: publications, release: publicationCandidates })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .where(eq(publications.id, event.publicationId))
    .limit(1)
  if (!row) return null
  const { publication, release } = row
  if (publication.status !== 'published' || release.status !== 'published') return null
  if (release.id !== event.releaseId || publication.accessEpoch !== event.accessEpoch) return null
  return row
}

/** 검색 색인: 게시 때 지금 release의 사례·막힘 문서를 만들고(이전 release 문서는 지움), 철회 때 그 공개의 문서를 모두 지웁니다. */
export const searchIndexHandler: DerivedCleanupHandler = {
  name: 'search-index',
  async onWithdrawn(db, event) {
    const deleted = await db
      .delete(searchDocuments)
      .where(eq(searchDocuments.publicationId, event.publicationId))
      .returning({ id: searchDocuments.id })
    return deleted.length
  },
  async onPublished(db, event) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`search-index:${event.publicationId}`}))`)
      const current = await currentRelease(tx, event)
      if (!current) return 0
      // 대체된 release의 문서를 지웁니다(읽기는 이미 지금 release와만 조인하므로 보이지 않음).
      const stale = await tx
        .delete(searchDocuments)
        .where(and(eq(searchDocuments.publicationId, event.publicationId), ne(searchDocuments.releaseId, current.release.id)))
        .returning({ id: searchDocuments.id })
      const docs = searchDocsFromSnapshot(current.release.snapshot as unknown as HubSnapshot)
      let written = 0
      for (const doc of docs) {
        const inserted = await tx
          .insert(searchDocuments)
          .values({
            kind: doc.kind,
            publicationId: event.publicationId,
            releaseId: current.release.id,
            itemKey: doc.itemKey,
            title: doc.title,
            snippet: doc.snippet,
            searchText: doc.searchText,
          })
          .onConflictDoNothing()
          .returning({ id: searchDocuments.id })
        written += inserted.length
      }
      return stale.length + written
    })
  },
}

/**
 * 유용성 신호 정리: 철회되면 그 공개의 막힘 카드 신호를 지우고, 새 버전이 게시되면 지금 스냅샷에 없는 막힘 카드의 신호를 지웁니다
 * (로그 키는 공개마다 안정되므로 같은 막힘이 남아 있으면 신호도 유지).
 */
export const signalsCleanupHandler: DerivedCleanupHandler = {
  name: 'usefulness-signals',
  async onWithdrawn(db, event) {
    const deleted = await db
      .delete(usefulnessSignals)
      .where(and(eq(usefulnessSignals.targetKind, 'stuck_item'), eq(usefulnessSignals.publicationId, event.publicationId)))
      .returning({ id: usefulnessSignals.id })
    return deleted.length
  },
  async onPublished(db, event) {
    const current = await currentRelease(db, event)
    if (!current) return 0
    const keys = extractStuckItems(current.release.snapshot as unknown as HubSnapshot).map((i) => i.key)
    const deleted = await db
      .delete(usefulnessSignals)
      .where(
        and(
          eq(usefulnessSignals.targetKind, 'stuck_item'),
          eq(usefulnessSignals.publicationId, event.publicationId),
          keys.length > 0 ? notInArray(usefulnessSignals.itemKey, keys) : undefined,
        ),
      )
      .returning({ id: usefulnessSignals.id })
    return deleted.length
  },
}

let registered = false
/** T-13 파생 데이터 handler를 등록합니다(worker 시작 때 한 번). */
export function registerCourseHubDerived(): void {
  if (registered) return
  registered = true
  registerDerivedCleanup(searchIndexHandler)
  registerDerivedCleanup(signalsCleanupHandler)
}

// ── 선배 노트 ────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSeniorNotePayload(data: unknown): SeniorNoteOutboxPayload | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.seniorNoteId !== 'string' || !UUID.test(d.seniorNoteId)) return null
  if (typeof d.courseId !== 'string' || !UUID.test(d.courseId)) return null
  if (!Number.isInteger(d.version) || (d.version as number) < 1) return null
  return { seniorNoteId: d.seniorNoteId, courseId: d.courseId, version: d.version as number }
}

/** 노트 게시: 지금 published이고 version이 같을 때만 검색 문서를 만들거나 바꿉니다. 바꾼 행 수. */
export async function handleSeniorNotePublished(db: DbExecutor, data: unknown): Promise<number> {
  const event = parseSeniorNotePayload(data)
  if (!event) return 0
  return db.transaction(async (tx) => {
    const [note] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, event.seniorNoteId)).limit(1).for('update')
    if (!note || note.status !== 'published' || note.version !== event.version) return 0
    const doc = searchDocFromSeniorNote({ answers: note.answers as SeniorNoteAnswers, termLabel: note.termLabel })
    await tx.delete(searchDocuments).where(eq(searchDocuments.seniorNoteId, note.id))
    await tx.insert(searchDocuments).values({ kind: 'note', seniorNoteId: note.id, noteVersion: note.version, ...doc })
    return 1
  })
}

/** 노트 철회·게시 취소: 검색 문서와 신호를 지웁니다(지금 다시 게시되어 있으면 그 문서는 다음 게시 이벤트가 만듦). 지운 행 수. */
export async function handleSeniorNoteWithdrawn(db: DbExecutor, data: unknown): Promise<number> {
  const event = parseSeniorNotePayload(data)
  if (!event) return 0
  return db.transaction(async (tx) => {
    const [note] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, event.seniorNoteId)).limit(1).for('update')
    if (note?.status === 'published') {
      // 그 사이 다시 게시되었으면 지금 version의 문서와 신호는 지금 공개인 노트의 것이므로 남기고, 다른 version 문서만 지웁니다.
      const stale = await tx
        .delete(searchDocuments)
        .where(and(eq(searchDocuments.seniorNoteId, note.id), ne(searchDocuments.noteVersion, note.version)))
        .returning({ id: searchDocuments.id })
      return stale.length
    }
    const docs = await tx.delete(searchDocuments).where(eq(searchDocuments.seniorNoteId, event.seniorNoteId)).returning({ id: searchDocuments.id })
    const signals = await tx
      .delete(usefulnessSignals)
      .where(and(eq(usefulnessSignals.targetKind, 'senior_note'), eq(usefulnessSignals.seniorNoteId, event.seniorNoteId)))
      .returning({ id: usefulnessSignals.id })
    return docs.length + signals.length
  })
}

/** 노트 큐 등록. */
export async function registerSeniorNoteQueues(boss: PgBoss, db: DbExecutor): Promise<void> {
  for (const queue of [SENIOR_NOTE_PUBLISHED_TOPIC, SENIOR_NOTE_WITHDRAWN_TOPIC]) {
    await boss.createQueue(queue, PUBLICATION_QUEUE_OPTIONS)
    await boss.updateQueue(queue, PUBLICATION_QUEUE_OPTIONS)
  }
  await boss.work<Record<string, unknown>>(SENIOR_NOTE_PUBLISHED_TOPIC, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return
    const affected = await handleSeniorNotePublished(db, job.data)
    console.info(`[worker] senior_note.published ${job.id}: affected=${affected}`)
  })
  await boss.work<Record<string, unknown>>(SENIOR_NOTE_WITHDRAWN_TOPIC, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return
    const affected = await handleSeniorNoteWithdrawn(db, job.data)
    console.info(`[worker] senior_note.withdrawn ${job.id}: affected=${affected}`)
  })
}
