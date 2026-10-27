/**
 * 운영자 주간 운영 시간 기록(C-10, DELIVERY_PLAN §4.1 C-10·§6.1 "운영 부담"·§7 GC "신고 검토 담당과 주간 시간", ADR 0027).
 *
 * - `GET /api/v1/operator/ops-time`: 내 기록(이번 주 + 최근 12주). **본인 것만** 돌려주고 다른 운영자의 행을 여는 경로는 없습니다.
 * - `PUT /api/v1/operator/ops-time/:week {minutes: {reports, official_pages, affiliation_support, curation, other}, note?}`: 그 주(서울 ISO 주) 기록을
 *   만들거나 바꿈(멱등). 이번 주 이후 422 `week: future`, 52주보다 오래되면 422 `week: too_old`, 형식 422 `week: invalid`, 분야별 0~10080 정수,
 *   합계 7일(10080분) 초과 422 `minutes: too_many`, 메모 200자(본인만 봄).
 * - `DELETE /api/v1/operator/ops-time/:week`: 내 그 주 기록 삭제(없으면 404).
 * - 모두 운영자만(아니면 403 `operator_only`). 감사는 id·종류만(`ops_time.save`·`ops_time.delete`, 주·분·메모 없음).
 * - 지표(커뮤니티 지표의 opsTime)는 주·분야별 **합계만**(opsTimeFacts) 씁니다. 사람별 순위·비교는 어디에도 없습니다.
 */
import { z } from 'zod'
import {
  OPS_TIME_LIST_WEEKS,
  OPS_TIME_NOTE_MAX,
  OPS_TIME_WEEK_MINUTES_MAX,
  type OpsTimeCategory,
  type OpsTimeFact,
  checkOpsTimeWeek,
  isoWeekOf,
  isoWeekRange,
  opsTimeTotal,
} from '@peerchive/domain'
import { and, desc, eq, inArray, opsTimeEntries, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, invalid, notFound } from '../errors'
import { parseInput } from '../validation'
import type { MyOpsTimeDto, OpsTimeEntryDto } from '../../../shared/types/api'

type Row = typeof opsTimeEntries.$inferSelect

const minutesField = z
  .number({ error: 'invalid' })
  .int({ error: 'invalid' })
  .min(0, { error: 'invalid' })
  .max(OPS_TIME_WEEK_MINUTES_MAX, { error: 'too_many' })
  .default(0)

export const saveOpsTimeSchema = z.object({
  minutes: z
    .object({
      reports: minutesField,
      official_pages: minutesField,
      affiliation_support: minutesField,
      curation: minutesField,
      other: minutesField,
    })
    .strict(),
  note: z
    .string({ error: 'invalid' })
    .trim()
    .max(OPS_TIME_NOTE_MAX, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v : null)),
})

const minutesOf = (r: Row): Record<OpsTimeCategory, number> => ({
  reports: r.reportsMinutes,
  official_pages: r.officialPagesMinutes,
  affiliation_support: r.affiliationSupportMinutes,
  curation: r.curationMinutes,
  other: r.otherMinutes,
})

function toDto(r: Row): OpsTimeEntryDto {
  const range = isoWeekRange(r.week)
  const minutes = minutesOf(r)
  return { week: r.week, from: range?.from ?? '', to: range?.to ?? '', minutes, total: opsTimeTotal(minutes), note: r.note, updatedAt: r.updatedAt.toISOString() }
}

function weekOrThrow(raw: unknown, now: Date): string {
  const week = typeof raw === 'string' ? raw : ''
  const check = checkOpsTimeWeek(week, now)
  if (check !== 'ok') throw invalid({ week: check })
  return week
}

/** GET /operator/ops-time — 내 기록(최근 12주, 새 주부터). */
export async function listMyOpsTime(db: DbExecutor, actor: Actor, now = new Date()): Promise<MyOpsTimeDto> {
  await requireOperator(db, actor)
  const weeks = Array.from({ length: OPS_TIME_LIST_WEEKS }, (_, i) => isoWeekOf(now, i))
  const rows = await db
    .select()
    .from(opsTimeEntries)
    .where(and(eq(opsTimeEntries.operatorId, actor.userId), inArray(opsTimeEntries.week, weeks)))
    .orderBy(desc(opsTimeEntries.week))
  return { currentWeek: weeks[0]!, entries: rows.map(toDto) }
}

/** PUT /operator/ops-time/:week — 내 그 주 기록 저장(만들거나 덮어씀). 200 + 기록. */
export async function saveMyOpsTime(db: DbExecutor, actor: Actor, rawWeek: unknown, rawInput: unknown, now = new Date()): Promise<OpsTimeEntryDto> {
  await requireOperator(db, actor)
  const week = weekOrThrow(rawWeek, now)
  const input = parseInput(saveOpsTimeSchema, rawInput)
  if (opsTimeTotal(input.minutes) > OPS_TIME_WEEK_MINUTES_MAX) throw invalid({ minutes: 'too_many' })
  const values = {
    reportsMinutes: input.minutes.reports,
    officialPagesMinutes: input.minutes.official_pages,
    affiliationSupportMinutes: input.minutes.affiliation_support,
    curationMinutes: input.minutes.curation,
    otherMinutes: input.minutes.other,
    note: input.note,
    updatedAt: now,
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(opsTimeEntries)
      .values({ operatorId: actor.userId, week, ...values, createdAt: now })
      .onConflictDoUpdate({ target: [opsTimeEntries.operatorId, opsTimeEntries.week], set: values })
      .returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'ops_time.save', targetType: 'ops_time_entry', targetId: row!.id })
    return toDto(row!)
  })
}

/** DELETE /operator/ops-time/:week — 내 그 주 기록 삭제. 없으면 404. */
export async function deleteMyOpsTime(db: DbExecutor, actor: Actor, rawWeek: unknown): Promise<void> {
  await requireOperator(db, actor)
  const week = typeof rawWeek === 'string' && isoWeekRange(rawWeek) ? rawWeek : null
  if (!week) throw notFound()
  await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(opsTimeEntries)
      .where(and(eq(opsTimeEntries.operatorId, actor.userId), eq(opsTimeEntries.week, week)))
      .returning({ id: opsTimeEntries.id })
    if (deleted.length === 0) throw notFound()
    await recordAudit(tx, { actorId: actor.userId, action: 'ops_time.delete', targetType: 'ops_time_entry', targetId: deleted[0]!.id })
  })
}

/**
 * 지표용: 그 주들의 기록(분야별 분 + 사람 구분 키). 사람 구분 키는 서로 다른 운영자 수를 세는 데만 쓰고 지표 응답에는 나가지 않습니다.
 * 메모는 읽지 않습니다.
 */
export async function opsTimeFacts(db: DbExecutor, weeks: readonly string[]): Promise<OpsTimeFact[]> {
  if (weeks.length === 0) return []
  const rows = await db
    .select({
      week: opsTimeEntries.week,
      operatorId: opsTimeEntries.operatorId,
      reports: opsTimeEntries.reportsMinutes,
      official_pages: opsTimeEntries.officialPagesMinutes,
      affiliation_support: opsTimeEntries.affiliationSupportMinutes,
      curation: opsTimeEntries.curationMinutes,
      other: opsTimeEntries.otherMinutes,
    })
    .from(opsTimeEntries)
    .where(inArray(opsTimeEntries.week, [...weeks]))
  return rows.map(({ operatorId, ...r }) => ({ ...r, operatorKey: operatorId }))
}
