/**
 * 동문회·OB 방 앨범 사진 검사(A-02, ADR 0039). 산출물 검사(scan-job.ts, ADR 0007)와 같은 판정을 쓰고, 수료증(certificate-scan.ts, ADR 0037)처럼
 * 파일은 격리 키에서 옮기지 않습니다.
 *
 * 흐름: pending → scanning → clean | quarantined | failed (room_album_photos.scan_status)
 * 1. 행을 잠그고 scanning으로 바꿉니다(시도 +1). 올리지 않았거나(uploaded_at 없음)·이미 끝났거나·행이 없으면(지운 사진) 아무것도 하지 않습니다.
 * 2. 격리 키 내용을 읽어 크기·SHA-256 확인 → 판별·형식·확장자 대조·내장 콘텐츠·악성코드 검사(judgeContent). 이미지가 아니면(선언과 다르면) 격리.
 * 3. 통과하면 메타데이터(EXIF·GPS·XMP·주석 등)를 지운 내용을 **같은 격리 키**에 원자적으로 바꿔 쓰고 clean + metadata_stripped.
 *    지우지 못하면(구조가 깨진 파일) failed — 원본을 내주지 않습니다.
 * 4. 격리·실패한 사진은 내려주지 않습니다. 파일은 올린 사람이나 방장·운영진이 사진을 지우면 함께 지우고, 남은 것은 격리 파일 정리가 지웁니다.
 */
import { createHash } from 'node:crypto'
import { type QuarantineReason, type ScanStatus, nextScanStatus } from '@peerchive/domain'
import { and, eq, outboxEvents, roomAlbumPhotos, type DbExecutor } from '@peerchive/db'
import { type ScanDeps, type ScanFailureReason, type ScanOutcome, ScanFailure, judgeContent } from './scan-job'
import { MetadataStripError, processMetadata } from './strip-metadata'
import { ObjectNotFoundError, isObjectKey, readAll, writeObject } from './storage'

/** pg-boss 큐 이름(outbox_events.topic). */
export const ALBUM_PHOTO_SCAN_QUEUE = 'album-photo-scan'

export interface AlbumPhotoScanJobData {
  photoId: string
}

/** 검사 작업을 outbox에 남깁니다. 호출자의 트랜잭션 안에서 부르세요. */
export async function enqueueAlbumPhotoScan(db: DbExecutor, photoId: string): Promise<void> {
  await db.insert(outboxEvents).values({ topic: ALBUM_PHOTO_SCAN_QUEUE, payload: { photoId } satisfies AlbumPhotoScanJobData })
}

/** 격리 키에 둔 이미지 한 장(앨범 사진·라운지 미디어 행의 공통 열). */
export interface QuarantinedImage {
  objectKey: string
  byteSize: number
  sha256: string | null
  declaredType: string
  fileExtension: string
}

export type ImageCheckResult =
  | { kind: 'reject'; reason: QuarantineReason; signature?: string }
  | { kind: 'clean'; mediaType: string; sha256: string; bytes: number }

/**
 * 격리 키의 이미지를 검사하고 메타데이터를 지운 내용으로 같은 키를 바꿔 씁니다(앨범 사진 A-02·라운지 미디어 A-04 공통, ADR 0039·0041).
 * 크기·SHA-256 확인 → 판별·형식·확장자 대조·내장 콘텐츠·악성코드 검사(judgeContent) → 메타데이터 제거(지우지 못하면 ScanFailure
 * `metadata_strip_failed` — 원본을 내주지 않음). 읽지 못하면 ScanFailure(`object_missing`·`scan_error`), 내용이 다르면 `integrity_mismatch`.
 */
export async function checkAndStripImage(deps: ScanDeps, row: QuarantinedImage): Promise<ImageCheckResult> {
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
  const verdict = await judgeContent(content, { declaredType: row.declaredType, fileName: `photo.${row.fileExtension}` }, deps.scanner)
  if (!verdict.pass) return { kind: 'reject', reason: verdict.reason, ...(verdict.signature && { signature: verdict.signature }) }
  let processed
  try {
    processed = processMetadata(content, verdict.mediaType)
  } catch (error) {
    if (!(error instanceof MetadataStripError)) throw error
    throw new ScanFailure('metadata_strip_failed', error)
  }
  // 이미지만 받으므로 지운 내용이어야 합니다(PDF처럼 그대로 두는 형식은 여기 오지 않음 — 판별이 선언과 같아야 통과).
  if (!processed.stripped) throw new ScanFailure('metadata_strip_failed')
  const written = await writeObject(deps.storage, key, processed.content)
  return { kind: 'clean', mediaType: verdict.mediaType, sha256: written.sha256, bytes: written.bytes }
}

export async function scanAlbumPhoto(db: DbExecutor, deps: ScanDeps, photoId: string, options: { finalAttempt?: boolean } = {}): Promise<ScanOutcome> {
  const now = deps.now ?? (() => new Date())
  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(roomAlbumPhotos).where(eq(roomAlbumPhotos.id, photoId)).for('update')
    if (!row) return { skipped: 'missing' as const, row: null }
    if (!row.uploadedAt) return { skipped: row.scanStatus, row: null }
    const next = nextScanStatus(row.scanStatus, 'start')
    if (!next) return { skipped: row.scanStatus, row: null }
    await tx.update(roomAlbumPhotos).set({ scanStatus: next, scanAttempts: row.scanAttempts + 1, scanReason: null }).where(eq(roomAlbumPhotos.id, photoId))
    return { skipped: null, row }
  })
  if (!claimed.row) return { status: 'skipped', current: (claimed.skipped ?? 'missing') as ScanStatus | 'missing' }
  const row = claimed.row

  const finish = (values: Partial<typeof roomAlbumPhotos.$inferInsert>) =>
    db
      .update(roomAlbumPhotos)
      .set(values)
      .where(and(eq(roomAlbumPhotos.id, photoId), eq(roomAlbumPhotos.scanStatus, 'scanning')))

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
      // 내려줄(메타데이터를 지운) 내용의 해시·크기로 바꿉니다. 원래 내용은 남기지 않습니다.
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
