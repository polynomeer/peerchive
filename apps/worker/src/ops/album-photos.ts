/**
 * 동문회·OB 방 앨범 사진 파일 정리(A-02, ADR 0039). 커뮤니티 표(`room_album_photos`)를 읽으므로 정리 작업 본체(cleanup.ts — 공개·파생 경로와 같은
 * 경계 검사 대상)와 나눠 이 파일에만 둡니다(C-05 경계 검사의 문서화된 예외). 사진 내용·설명·올린 사람은 읽지 않고 키·상태·시각만 봅니다.
 */
import { inArray, roomAlbumPhotos, sql, type DbExecutor } from '@peerchive/db'
import { isObjectKey, type ObjectStorage } from '@peerchive/files'

/** 내용을 받지 못한 올리기·검사를 통과하지 못한 사진을 지우기까지의 시간(RUNBOOK "데이터 보존"). */
export const ALBUM_PHOTO_STALE_MS = 24 * 60 * 60 * 1000
const maxBatches = 50

/** 격리 파일 정리용: 이 키들 중 앨범 사진 행이 가리키는 것. */
export async function referencedAlbumPhotoKeys(db: DbExecutor, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return []
  return (await db.select({ key: roomAlbumPhotos.objectKey }).from(roomAlbumPhotos).where(inArray(roomAlbumPhotos.objectKey, keys))).map((r) => r.key)
}

/**
 * 앨범 사진(A-02, ADR 0039)의 끝나지 않은 올리기(내용을 받지 못한 행)와 검사를 통과하지 못한(격리·실패) 사진: 하루가 지나면 파일과 행을 지웁니다.
 * `upload-intents` 작업이 함께 부릅니다(같은 성격의 정리라 새 일정을 두지 않음). 파일을 먼저 지웁니다.
 */
export async function cleanupStaleAlbumPhotos(db: DbExecutor, deps: { storage: ObjectStorage; batchSize: number }, now: Date): Promise<{ affected: number; batches: number; objects: number }> {
  const cutoff = new Date(now.getTime() - ALBUM_PHOTO_STALE_MS).toISOString()
  let affected = 0
  let objects = 0
  let batches = 0
  while (batches < maxBatches) {
    batches++
    const rows = await db
      .select({ id: roomAlbumPhotos.id, key: roomAlbumPhotos.objectKey })
      .from(roomAlbumPhotos)
      .where(
        sql`(${roomAlbumPhotos.uploadedAt} is null and ${roomAlbumPhotos.createdAt} < ${cutoff}::timestamptz)
          or (${roomAlbumPhotos.scanStatus}::text in ('quarantined', 'failed') and coalesce(${roomAlbumPhotos.scannedAt}, ${roomAlbumPhotos.createdAt}) < ${cutoff}::timestamptz)`,
      )
      .limit(deps.batchSize)
    if (rows.length === 0) break
    for (const { key } of rows) {
      if (!isObjectKey(key)) continue
      await deps.storage.delete(key)
      objects++
    }
    const deleted = await db
      .delete(roomAlbumPhotos)
      .where(inArray(roomAlbumPhotos.id, rows.map((r) => r.id)))
      .returning({ id: roomAlbumPhotos.id })
    affected += deleted.length
    if (rows.length < deps.batchSize) break
  }
  return { affected, batches, objects }
}
