/**
 * 운영 조치의 파생 데이터 맞추기 (T-15, SYSTEM_DESIGN §1-4·§11, ADR 0015).
 *
 * outbox `moderation.action {actionId, phase}`를 받아 남은 사본을 맞춥니다. 웹의 공개 읽기는 요청마다 조치 상태(가린 항목·숨김 상태)를 확인하므로
 * 이 작업이 늦거나 실패해도 가린 내용은 이미 보이지 않습니다.
 * - 적용(applied): 가린 막힘 카드(hide_item, log)의 검색 문서 삭제, 숨긴 선배 노트(hide_note)의 검색 문서 삭제. 신호는 지우지 않습니다
 *   (읽기에서 이미 빠지고, 되돌리면 그대로 다시 셈).
 * - 되돌림(reversed): 그 공개의 지금 release를 다시 색인(빠진 문서만 다시 만듦), 노트는 지금 published·version이면 다시 색인.
 * - 공개 제한(restrict)은 웹이 `publication.withdrawn`(cause restricted)도 남기므로 여기서는 할 일이 없습니다. 케이스·프로필 숨김도 파생 데이터가 없습니다.
 * - 막힘 Q&A 숨기기(hide_qa, C-09): 숨겨져 있으면 검색 문서 삭제, 되돌려 published면 다시 색인.
 * 판정은 이벤트가 아니라 지금 행 상태로 하므로 늦거나 중복돼도 결과가 같습니다(idempotent).
 */
import type { PgBoss } from 'pg-boss'
import {
  MODERATION_ACTION_TOPIC,
  and,
  courseQaItems,
  eq,
  moderationActions,
  publicationCandidates,
  publications,
  searchDocuments,
  seniorNotes,
  type DbExecutor,
  type ModerationActionOutboxPayload,
} from '@peerchive/db'
import { handleCourseQaPublished, handleSeniorNotePublished, searchIndexHandler } from './course-hub-derived'
import { PUBLICATION_QUEUE_OPTIONS } from './publication-events'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseModerationPayload(data: unknown): ModerationActionOutboxPayload | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.actionId !== 'string' || !UUID.test(d.actionId)) return null
  if (d.phase !== 'applied' && d.phase !== 'reversed') return null
  return { actionId: d.actionId, phase: d.phase }
}

/** 이벤트 하나 처리. 바꾼(지우거나 만든) 행 수. */
export async function handleModerationAction(db: DbExecutor, data: unknown): Promise<number> {
  const event = parseModerationPayload(data)
  if (!event) {
    console.error('[worker] moderation.action: invalid payload')
    return 0
  }
  const [action] = await db.select().from(moderationActions).where(eq(moderationActions.id, event.actionId)).limit(1)
  if (!action) return 0
  // 지금 상태 기준: 되돌려졌으면 reversed로 처리합니다(applied 이벤트가 늦게 와도 지우지 않음).
  const reversed = action.reversedAt !== null
  if (action.kind === 'hide_item' && action.publicationId && action.itemKind === 'log' && action.itemKey) {
    if (!reversed) {
      const deleted = await db
        .delete(searchDocuments)
        .where(and(eq(searchDocuments.publicationId, action.publicationId), eq(searchDocuments.kind, 'stuck'), eq(searchDocuments.itemKey, action.itemKey)))
        .returning({ id: searchDocuments.id })
      return deleted.length
    }
    return reindexPublication(db, action.publicationId)
  }
  if (action.kind === 'hide_note' && action.seniorNoteId) {
    const [note] = await db.select().from(seniorNotes).where(eq(seniorNotes.id, action.seniorNoteId)).limit(1)
    if (!note) return 0
    if (note.status === 'hidden') {
      const deleted = await db.delete(searchDocuments).where(eq(searchDocuments.seniorNoteId, note.id)).returning({ id: searchDocuments.id })
      return deleted.length
    }
    if (note.status === 'published') return handleSeniorNotePublished(db, { seniorNoteId: note.id, courseId: note.courseId, version: note.version })
  }
  if (action.kind === 'hide_qa' && action.courseQaItemId) {
    const [qa] = await db.select().from(courseQaItems).where(eq(courseQaItems.id, action.courseQaItemId)).limit(1)
    if (!qa) return 0
    if (qa.status === 'published') return handleCourseQaPublished(db, { courseQaItemId: qa.id, courseId: qa.courseId })
    const deleted = await db.delete(searchDocuments).where(eq(searchDocuments.courseQaItemId, qa.id)).returning({ id: searchDocuments.id })
    return deleted.length
  }
  return 0
}

/** 지금 게시 중인 release를 다시 색인합니다(빠진 문서만 만듦, 게시 handler와 같은 판정). */
async function reindexPublication(db: DbExecutor, publicationId: string): Promise<number> {
  const [row] = await db
    .select({ publication: publications, release: publicationCandidates })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .where(eq(publications.id, publicationId))
    .limit(1)
  if (!row || row.publication.status !== 'published' || row.release.status !== 'published') return 0
  return searchIndexHandler.onPublished!(db, {
    publicationId,
    projectId: row.publication.projectId,
    releaseId: row.release.id,
    releaseNo: row.release.releaseNo ?? 0,
    accessEpoch: row.publication.accessEpoch,
  })
}

export async function registerModerationQueue(boss: PgBoss, db: DbExecutor): Promise<void> {
  await boss.createQueue(MODERATION_ACTION_TOPIC, PUBLICATION_QUEUE_OPTIONS)
  await boss.updateQueue(MODERATION_ACTION_TOPIC, PUBLICATION_QUEUE_OPTIONS)
  await boss.work<Record<string, unknown>>(MODERATION_ACTION_TOPIC, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return
    const affected = await handleModerationAction(db, job.data)
    console.info(`[worker] moderation.action ${job.id}: affected=${affected}`)
  })
}
