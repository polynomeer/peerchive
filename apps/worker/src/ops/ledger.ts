/**
 * 삭제 장부 내보내기·재적용(T-16, SYSTEM_DESIGN §11 "복구 시 최신 삭제를 재적용하기 전에는 외부 트래픽을 열지 않음", ADR 0016).
 *
 * 오래된 백업을 복구하면 그 뒤에 정리한 탈퇴 계정의 자료가 다시 나타납니다. 재적용은
 * 1. 장부 항목(지금 운영 DB에서 내보낸 파일, 또는 대상 DB 자신의 장부)의 subject_hash 목록을 만들고,
 * 2. 대상 DB의 모든 사용자 id를 같은 삭제 pepper로 HMAC해 맞는 사람을 찾고,
 * 3. 그 사람을 상태와 무관하게 다시 정리합니다(purgeAccount source=reapply). 지울 것이 없으면 아무것도 바꾸지 않습니다(idempotent).
 * 파일에서 읽은 장부 항목 중 대상 DB에 없는 것은 대상 장부에 넣어, 복구된 DB의 장부도 최신이 되게 합니다.
 *
 * 장부 파일 형식: 한 줄에 JSON 하나 `{"subjectHash","entityKind","count","requestedAt","purgedAt","source"}`(ops/backup.sh와 같은 형식).
 *
 * source `retention`(I-01, ADR 0037)은 계정이 아니라 보존 기간이 끝난 개별 자료입니다. 지금은 수료증 파일(entity_kind `certificate_file`,
 * subject_hash = HMAC(삭제 pepper, 수료증 확인 id))뿐이며, 재적용은 같은 HMAC의 확인 행을 찾아 남은 파일만 다시 지웁니다(계정 정리 대상 아님).
 */
import { readFile } from 'node:fs/promises'
import { and, asc, certificateChecks, deletionLedger, eq, gt, hashSubject, isNotNull, sql, users, type DbExecutor } from '@peerchive/db'
import { isObjectKey } from '@peerchive/files'
import { CERTIFICATE_LEDGER_KIND } from './certificates'
import { type PurgeCounts, type PurgeDeps, purgeAccount } from './purge'

export interface LedgerEntry {
  subjectHash: string
  entityKind: string
  count: number
  requestedAt: string | null
  purgedAt: string
  source: 'purge' | 'reapply' | 'retention'
}

const HASH = /^[0-9a-f]{64}$/
const KIND = /^[a-z_]{1,40}$/

/** 장부 한 줄 검사. 형식이 틀리면 null. */
export function parseLedgerEntry(value: unknown): LedgerEntry | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.subjectHash !== 'string' || !HASH.test(v.subjectHash)) return null
  if (typeof v.entityKind !== 'string' || !KIND.test(v.entityKind)) return null
  if (!Number.isInteger(v.count) || (v.count as number) < 0) return null
  const date = (x: unknown) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? new Date(x).toISOString() : null)
  const purgedAt = date(v.purgedAt)
  if (!purgedAt) return null
  if (v.requestedAt !== null && v.requestedAt !== undefined && !date(v.requestedAt)) return null
  if (v.source !== 'purge' && v.source !== 'reapply' && v.source !== 'retention') return null
  return { subjectHash: v.subjectHash, entityKind: v.entityKind, count: v.count as number, requestedAt: date(v.requestedAt), purgedAt, source: v.source }
}

/** JSON lines 파일 읽기. 형식이 틀린 줄이 하나라도 있으면 예외(몇 번째 줄인지만 알림). */
export async function readLedgerFile(path: string): Promise<LedgerEntry[]> {
  const text = await readFile(path, 'utf8')
  const entries: LedgerEntry[] = []
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new Error(`ledger file line ${index + 1}: invalid JSON`)
    }
    const entry = parseLedgerEntry(parsed)
    if (!entry) throw new Error(`ledger file line ${index + 1}: invalid entry`)
    entries.push(entry)
  })
  return entries
}

/** 장부 전체(오래된 순). */
export async function exportLedger(db: DbExecutor): Promise<LedgerEntry[]> {
  const rows = await db.select().from(deletionLedger).orderBy(asc(deletionLedger.purgedAt), asc(deletionLedger.id))
  return rows.map((r) => ({
    subjectHash: r.subjectHash,
    entityKind: r.entityKind,
    count: r.count,
    requestedAt: r.requestedAt?.toISOString() ?? null,
    purgedAt: r.purgedAt.toISOString(),
    source: r.source as LedgerEntry['source'],
  }))
}

export const formatLedgerLines = (entries: readonly LedgerEntry[]) => entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')

export interface ReapplyResult {
  /** 장부의 서로 다른 대상 수. */
  subjects: number
  /** 대상 DB에서 찾은 사람 수. */
  matched: number
  /** 실제로 무엇인가 다시 지운 사람 수. */
  repurged: number
  /** 대상 장부에 새로 넣은 항목 수(파일에서 읽은 것 중). */
  imported: number
  /** 다시 지운 종류별 개수 합. */
  counts: PurgeCounts
  /** 다시 지운 수료증 파일 수(source retention, I-01). */
  retentionRepurged: number
}

/**
 * 재적용. entries를 주면 그 목록(파일)을, 아니면 대상 DB의 장부를 씁니다. dryRun이면 찾기만 하고 바꾸지 않습니다.
 * 사용자는 id 순으로 배치(batchSize)로 읽어 HMAC을 계산합니다(pilot 규모).
 */
export async function reapplyDeletions(
  db: DbExecutor,
  deps: PurgeDeps,
  options: { entries?: readonly LedgerEntry[]; now?: Date; dryRun?: boolean; batchSize?: number } = {},
): Promise<ReapplyResult> {
  const now = options.now ?? new Date()
  const entries = options.entries ?? (await exportLedger(db))
  // 계정 정리 대상은 purge·reapply 항목뿐입니다(retention 항목은 개별 자료).
  const subjects = new Set(entries.filter((e) => e.source !== 'retention').map((e) => e.subjectHash))
  const retentionSubjects = new Set(entries.filter((e) => e.source === 'retention' && e.entityKind === CERTIFICATE_LEDGER_KIND).map((e) => e.subjectHash))
  let imported = 0
  if (options.entries && !options.dryRun) imported = await importLedger(db, options.entries)

  const matchedIds: string[] = []
  let after = '00000000-0000-0000-0000-000000000000'
  const batch = options.batchSize ?? 1000
  for (;;) {
    const rows = await db.select({ id: users.id }).from(users).where(gt(users.id, after)).orderBy(asc(users.id)).limit(batch)
    for (const { id } of rows) if (subjects.has(hashSubject(deps.deletionPepper, id))) matchedIds.push(id)
    if (rows.length < batch) break
    after = rows.at(-1)!.id
  }

  const counts: PurgeCounts = {}
  let repurged = 0
  if (!options.dryRun) {
    for (const id of matchedIds) {
      const result = await purgeAccount(db, deps, id, { now, source: 'reapply' })
      if (!result || Object.keys(result).length === 0) continue
      repurged++
      for (const [kind, n] of Object.entries(result)) counts[kind] = (counts[kind] ?? 0) + n
    }
  }
  const retentionRepurged = retentionSubjects.size ? await reapplyCertificateFiles(db, deps, retentionSubjects, now, options.dryRun ?? false) : 0
  return { subjects: subjects.size, matched: matchedIds.length, repurged, imported, counts, retentionRepurged }
}

/** 장부에 삭제로 기록됐는데 복구된 DB에 파일이 남은 수료증 확인 행의 파일을 다시 지웁니다(새 장부 행은 만들지 않음 — 이미 있음). */
async function reapplyCertificateFiles(db: DbExecutor, deps: PurgeDeps, subjects: ReadonlySet<string>, now: Date, dryRun: boolean): Promise<number> {
  const rows = await db.select({ id: certificateChecks.id, key: certificateChecks.objectKey }).from(certificateChecks).where(isNotNull(certificateChecks.objectKey))
  let n = 0
  for (const row of rows) {
    if (!subjects.has(hashSubject(deps.deletionPepper, row.id))) continue
    n++
    if (dryRun) continue
    if (row.key && isObjectKey(row.key)) await deps.storage.delete(row.key)
    await db
      .update(certificateChecks)
      .set({ objectKey: null, filePurgedAt: now })
      .where(and(eq(certificateChecks.id, row.id), isNotNull(certificateChecks.objectKey)))
  }
  return n
}

/** 대상 장부에 없는 항목만 넣습니다(같은 대상·종류·정리 시각·출처면 같은 항목). */
async function importLedger(db: DbExecutor, entries: readonly LedgerEntry[]): Promise<number> {
  let imported = 0
  for (const e of entries) {
    const inserted = await db.execute(sql`
      insert into deletion_ledger (subject_hash, entity_kind, count, requested_at, purged_at, source)
      select ${e.subjectHash}, ${e.entityKind}, ${e.count}, ${e.requestedAt}::timestamptz, ${e.purgedAt}::timestamptz, ${e.source}
      where not exists (
        select 1 from deletion_ledger
        where subject_hash = ${e.subjectHash} and entity_kind = ${e.entityKind}
          and purged_at = ${e.purgedAt}::timestamptz and source = ${e.source})`)
    imported += Number((inserted as unknown as { count?: number }).count ?? 0)
  }
  return imported
}
