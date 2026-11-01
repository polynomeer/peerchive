/**
 * 수료증 파일 검사(I-01, ADR 0037). 산출물 검사(scan-job.ts, ADR 0007)와 같은 판정을 쓰되, 파일은 격리 키에서 옮기지 않습니다.
 *
 * 흐름: pending → scanning → clean | quarantined | failed (certificate_checks.scan_status)
 * 1. 행을 잠그고 scanning으로 바꿉니다(시도 +1). 올리지 않았거나(uploaded_at 없음)·이미 끝났거나·파일을 지웠으면 아무것도 하지 않습니다.
 * 2. 격리 키 내용을 읽어 크기·SHA-256 확인 → 판별·형식·확장자 대조·내장 콘텐츠·악성코드 검사(judgeContent).
 * 3. 통과하면 메타데이터를 지운 내용(이미지: EXIF/GPS 등 제거, PDF: 그대로)을 **같은 격리 키**에 원자적으로 바꿔 쓰고(writeObject) clean으로.
 *    clean 키로 옮기지 않으므로 산출물 경로로는 어떤 경우에도 내려가지 않습니다. 운영자 열람은 서명 URL 경로 하나뿐입니다.
 * 4. 격리·실패한 파일은 내려주지 않으며 worker `certificate-files`가 지웁니다.
 */
import { createHash } from 'node:crypto'
import { nextScanStatus, type ScanStatus } from '@peerchive/domain'
import { and, certificateChecks, eq, outboxEvents, type DbExecutor } from '@peerchive/db'
import { type ScanDeps, type ScanFailureReason, type ScanOutcome, ScanFailure, judgeContent } from './scan-job'
import { MetadataStripError, processMetadata } from './strip-metadata'
import { ObjectNotFoundError, isObjectKey, readAll, writeObject } from './storage'

/** pg-boss 큐 이름(outbox_events.topic). */
export const CERTIFICATE_SCAN_QUEUE = 'certificate-scan'

export interface CertificateScanJobData {
  checkId: string
}

/** 검사 작업을 outbox에 남깁니다. 호출자의 트랜잭션 안에서 부르세요. */
export async function enqueueCertificateScan(db: DbExecutor, checkId: string): Promise<void> {
  await db.insert(outboxEvents).values({ topic: CERTIFICATE_SCAN_QUEUE, payload: { checkId } satisfies CertificateScanJobData })
}

export async function scanCertificateCheck(
  db: DbExecutor,
  deps: ScanDeps,
  checkId: string,
  options: { finalAttempt?: boolean } = {},
): Promise<ScanOutcome> {
  const now = deps.now ?? (() => new Date())
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(certificateChecks).where(eq(certificateChecks.id, checkId)).for('update')
    if (!row) return { skipped: 'missing' as const, row: null }
    if (!row.uploadedAt || !row.objectKey || row.filePurgedAt || row.decidedAt) return { skipped: row.scanStatus, row: null }
    const next = nextScanStatus(row.scanStatus, 'start')
    if (!next) return { skipped: row.scanStatus, row: null }
    await tx.update(certificateChecks).set({ scanStatus: next, scanAttempts: row.scanAttempts + 1, scanReason: null }).where(eq(certificateChecks.id, checkId))
    return { skipped: null, row }
  })
  if (!claimed.row) return { status: 'skipped', current: (claimed.skipped ?? 'missing') as ScanStatus | 'missing' }
  const row = claimed.row

  const finish = (values: Partial<typeof certificateChecks.$inferInsert>) =>
    db
      .update(certificateChecks)
      .set(values)
      .where(and(eq(certificateChecks.id, checkId), eq(certificateChecks.scanStatus, 'scanning')))

  try {
    const key = row.objectKey
    if (!isObjectKey(key)) throw new ScanFailure('object_missing')
    let content: Buffer
    try {
      content = await readAll(await deps.storage.get(key), row.byteSize)
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw new ScanFailure('object_missing')
      throw new ScanFailure('scan_error', error)
    }
    if (content.length !== row.byteSize || createHash('sha256').update(content).digest('hex') !== row.sha256) {
      throw new ScanFailure('integrity_mismatch')
    }
    // 원래 파일 이름은 저장하지 않으므로 확장자로 만든 이름으로 대조합니다.
    const verdict = await judgeContent(content, { declaredType: row.declaredType, fileName: `certificate.${row.fileExtension}` }, deps.scanner)
    if (!verdict.pass) {
      await finish({ scanStatus: nextScanStatus('scanning', 'reject')!, scanReason: verdict.reason, scanEngine: deps.scanner.engine, scannedAt: now() })
      return { status: 'quarantined', reason: verdict.reason, ...(verdict.signature && { signature: verdict.signature }) }
    }
    let processed
    try {
      processed = processMetadata(content, verdict.mediaType)
    } catch (error) {
      if (!(error instanceof MetadataStripError)) throw error
      throw new ScanFailure('metadata_strip_failed', error)
    }
    const written = await writeObject(deps.storage, key, processed.content)
    await finish({
      scanStatus: nextScanStatus('scanning', 'pass')!,
      mediaType: verdict.mediaType,
      scanEngine: deps.scanner.engine,
      scannedAt: now(),
      // 내려줄(메타데이터를 지운) 내용의 해시·크기로 바꿉니다. 원래 내용은 남기지 않습니다.
      sha256: written.sha256,
      byteSize: written.bytes,
    })
    return { status: 'clean' }
  } catch (error) {
    const reason: ScanFailureReason = error instanceof ScanFailure ? error.reason : 'scan_error'
    if (options.finalAttempt || reason !== 'scan_error') {
      await finish({ scanStatus: nextScanStatus('scanning', 'error')!, scanReason: reason, scanEngine: deps.scanner.engine })
      if (reason !== 'scan_error') return { status: 'failed', reason }
    }
    throw error
  }
}
