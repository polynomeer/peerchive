/**
 * 수료증 파일 삭제(I-01, SYSTEM_DESIGN §6.7.2 CertificateCheck "결정 즉시(최대 7일) 삭제해 DeletionLedger에 기록", ADR 0037·0016).
 *
 * 주기 작업 `certificate-files`(기본 10분마다): 파일이 남은 수료증 확인 중 지울 때가 된 것(@peerchive/domain certificateFileDue —
 * 결정함·요청이 끝남·검사에서 격리/실패·하루 안에 올리지 않음·30일 동안 결정 없음)의 저장소 파일을 지우고, 행의 object_key를 비우고
 * file_purged_at을 남깁니다. 30일 동안 결정되지 않은 pending 요청은 expired로 바꿉니다.
 *
 * 삭제 장부: 올린 파일을 지울 때마다 한 행(subject_hash = HMAC(삭제 pepper, 수료증 확인 id), entity_kind `certificate_file`, count 1,
 * requested_at = 결정 시각(분), source `retention`). 사용자 id·파일 이름·기관은 넣지 않습니다. 오래된 백업을 복구하면 재적용(ledger.ts)이
 * 같은 HMAC으로 확인 행을 찾아 파일을 다시 지웁니다(계정은 건드리지 않음).
 *
 * idempotent: 파일 삭제는 없어도 성공이고, 행 갱신은 아직 지우지 않은 행에만 합니다. 파일을 먼저 지우고 행을 바꿉니다(중간에 죽으면 다음 주기에
 * 같은 행을 다시 골라 마저 끝냄 — 파일이 남는 쪽보다 행이 남는 쪽을 택함).
 */
import { CERTIFICATE_UPLOAD_TTL_MS, certificateFileDue } from '@peerchive/domain'
import {
  and,
  asc,
  certificateChecks,
  deletionLedger,
  eq,
  hashSubject,
  inArray,
  institutionAffiliations,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  type DbExecutor,
} from '@peerchive/db'
import { isObjectKey, type ObjectStorage } from '@peerchive/files'
import type { TaskOutcome } from './cleanup'

export const CERTIFICATE_LEDGER_KIND = 'certificate_file'

export interface CertificateFileDeps {
  storage: ObjectStorage
  deletionPepper: string
  batchSize: number
}

const truncateToMinute = (d: Date) => new Date(Math.floor(d.getTime() / 60_000) * 60_000)

export async function purgeCertificateFiles(db: DbExecutor, deps: CertificateFileDeps, now: Date): Promise<TaskOutcome> {
  const rows = await db
    .select({ check: certificateChecks, affiliationStatus: institutionAffiliations.status, affiliationId: institutionAffiliations.id })
    .from(certificateChecks)
    .innerJoin(institutionAffiliations, eq(institutionAffiliations.id, certificateChecks.affiliationId))
    // 후보만 고릅니다(아직 기다리는 pending이 배치를 채우지 않게). 최종 판정은 certificateFileDue.
    .where(
      and(
        isNull(certificateChecks.filePurgedAt),
        or(
          isNotNull(certificateChecks.decidedAt),
          ne(institutionAffiliations.status, 'pending'),
          inArray(certificateChecks.scanStatus, ['quarantined', 'failed']),
          lt(certificateChecks.createdAt, new Date(now.getTime() - CERTIFICATE_UPLOAD_TTL_MS)),
        ),
      ),
    )
    .orderBy(asc(certificateChecks.createdAt))
    .limit(deps.batchSize)
  let affected = 0
  let objects = 0
  for (const { check, affiliationStatus, affiliationId } of rows) {
    const due = certificateFileDue(
      {
        decidedAt: check.decidedAt,
        affiliationStatus,
        scanStatus: check.scanStatus,
        uploadedAt: check.uploadedAt,
        createdAt: check.createdAt,
        filePurgedAt: check.filePurgedAt,
      },
      now,
    )
    if (!due.due) continue
    if (check.objectKey && isObjectKey(check.objectKey)) {
      await deps.storage.delete(check.objectKey)
      if (check.uploadedAt) objects++
    }
    const done = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(certificateChecks)
        .set({ objectKey: null, filePurgedAt: now })
        .where(and(eq(certificateChecks.id, check.id), isNull(certificateChecks.filePurgedAt)))
        .returning({ id: certificateChecks.id })
      if (!updated) return false
      // 오래 결정되지 않았거나 올리지 않은 요청은 끝냅니다(사용자는 다시 요청할 수 있음).
      if (affiliationStatus === 'pending' && (due.reason === 'stale' || due.reason === 'not_uploaded' || due.reason === 'rejected_scan')) {
        await tx
          .update(institutionAffiliations)
          .set({ status: 'expired', updatedAt: now })
          .where(and(eq(institutionAffiliations.id, affiliationId), eq(institutionAffiliations.status, 'pending')))
      }
      if (check.uploadedAt) {
        await tx.insert(deletionLedger).values({
          subjectHash: hashSubject(deps.deletionPepper, check.id),
          entityKind: CERTIFICATE_LEDGER_KIND,
          count: 1,
          requestedAt: truncateToMinute(check.decidedAt ?? now),
          purgedAt: now,
          source: 'retention',
        })
      }
      return true
    })
    if (done) affected++
  }
  return { affected, batches: 1, objects }
}
