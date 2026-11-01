/**
 * 공감 라운지 미디어 검사(A-04, ADR 0041). 앨범 사진 검사(album-photo-scan.ts, ADR 0039)와 같은 판정·메타데이터 제거(checkAndStripImage)를 쓰고,
 * 파일은 격리 키에서 옮기지 않습니다.
 *
 * 흐름: pending → scanning → clean | quarantined | failed (community_post_media.scan_status)
 * 1. 행을 잠그고 scanning으로 바꿉니다(시도 +1). 올리지 않았거나·이미 끝났거나·행이 없으면(지운 미디어) 아무것도 하지 않습니다.
 * 2. 크기·SHA-256 확인 → 판별·형식·확장자 대조·내장 콘텐츠·악성코드 검사. 이미지가 아니면(선언과 다르면) 격리.
 * 3. 통과하면 메타데이터(EXIF·GPS·XMP·주석 등)를 지운 내용을 **같은 격리 키**에 바꿔 쓰고 clean + metadata_stripped. 지우지 못하면 failed.
 * 4. 격리·실패한 미디어는 내려주지 않습니다. 남은 행·파일은 worker 정리가 하루 뒤 지웁니다.
 */
import { type ScanStatus, nextScanStatus } from '@peerchive/domain'
import { and, communityPostMedia, eq, outboxEvents, type DbExecutor } from '@peerchive/db'
import { checkAndStripImage } from './album-photo-scan'
import { type ScanDeps, type ScanFailureReason, type ScanOutcome, ScanFailure } from './scan-job'

/** pg-boss 큐 이름(outbox_events.topic). */
export const POST_MEDIA_SCAN_QUEUE = 'post-media-scan'

export interface PostMediaScanJobData {
  mediaId: string
}

/** 검사 작업을 outbox에 남깁니다. 호출자의 트랜잭션 안에서 부르세요. */
export async function enqueuePostMediaScan(db: DbExecutor, mediaId: string): Promise<void> {
  await db.insert(outboxEvents).values({ topic: POST_MEDIA_SCAN_QUEUE, payload: { mediaId } satisfies PostMediaScanJobData })
}

export async function scanPostMedia(db: DbExecutor, deps: ScanDeps, mediaId: string, options: { finalAttempt?: boolean } = {}): Promise<ScanOutcome> {
  const now = deps.now ?? (() => new Date())
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(communityPostMedia).where(eq(communityPostMedia.id, mediaId)).for('update')
    if (!row) return { skipped: 'missing' as const, row: null }
    if (!row.uploadedAt) return { skipped: row.scanStatus, row: null }
    const next = nextScanStatus(row.scanStatus, 'start')
    if (!next) return { skipped: row.scanStatus, row: null }
    await tx.update(communityPostMedia).set({ scanStatus: next, scanAttempts: row.scanAttempts + 1, scanReason: null }).where(eq(communityPostMedia.id, mediaId))
    return { skipped: null, row }
  })
  if (!claimed.row) return { status: 'skipped', current: (claimed.skipped ?? 'missing') as ScanStatus | 'missing' }
  const row = claimed.row

  const finish = (values: Partial<typeof communityPostMedia.$inferInsert>) =>
    db
      .update(communityPostMedia)
      .set(values)
      .where(and(eq(communityPostMedia.id, mediaId), eq(communityPostMedia.scanStatus, 'scanning')))

  try {
    const result = await checkAndStripImage(deps, row)
    if (result.kind === 'reject') {
      await finish({ scanStatus: nextScanStatus('scanning', 'reject')!, scanReason: result.reason, scanEngine: deps.scanner.engine, scannedAt: now() })
      return { status: 'quarantined', reason: result.reason, ...(result.signature && { signature: result.signature }) }
    }
    await finish({
      scanStatus: nextScanStatus('scanning', 'pass')!,
      mediaType: result.mediaType,
      metadataStripped: true,
      scanEngine: deps.scanner.engine,
      scannedAt: now(),
      // 내려줄(메타데이터를 지운) 내용의 해시·크기. 원래 내용은 남기지 않습니다.
      sha256: result.sha256,
      byteSize: result.bytes,
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
