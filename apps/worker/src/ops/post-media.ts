/**
 * 공감 라운지 미디어 파일 정리(A-04, ADR 0041). 커뮤니티 표(`community_post_media`, 글 상태를 보려고 `community_posts`)를 읽으므로 정리 작업
 * 본체(cleanup.ts — 공개·파생 경로와 같은 경계 검사 대상)와 나눠 이 파일에만 둡니다(앨범 사진 album-photos.ts와 같은 C-05 경계 검사의 문서화된 예외).
 * 미디어 내용·글 제목·본문·올린 사람은 읽지 않고 키·상태·시각·글 상태만 봅니다.
 */
import { communityPostMedia, inArray, sql, type DbExecutor } from '@peerchive/db'
import { isObjectKey, type ObjectStorage } from '@peerchive/files'

/** 내용을 받지 못한 올리기·검사를 통과하지 못한 미디어를 지우기까지의 시간(RUNBOOK "데이터 보존", 앨범 사진과 같음). */
export const POST_MEDIA_STALE_MS = 24 * 60 * 60 * 1000
const maxBatches = 50

/** 격리 파일 정리용: 이 키들 중 라운지 미디어 행이 가리키는 것. */
export async function referencedPostMediaKeys(db: DbExecutor, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return []
  return (await db.select({ key: communityPostMedia.objectKey }).from(communityPostMedia).where(inArray(communityPostMedia.objectKey, keys))).map((r) => r.key)
}

/**
 * 라운지 미디어(A-04, ADR 0041) 정리: (1) 글쓴이가 지운 글(`deleted_by_author` — 탈퇴 정리로 지운 글 포함)의 미디어는 바로, (2) 끝나지 않은 올리기
 * (내용을 받지 못한 행)와 검사를 통과하지 못한(격리·실패) 미디어는 하루가 지나면 파일과 행을 지웁니다. 가린 글(hidden·auto_hidden)의 미디어는
 * 이의제기로 되돌릴 수 있게 남깁니다(보이지는 않음). `upload-intents` 작업이 함께 부릅니다(새 일정을 두지 않음). 파일을 먼저 지웁니다.
 */
export async function cleanupPostMedia(db: DbExecutor, deps: { storage: ObjectStorage; batchSize: number }, now: Date): Promise<{ affected: number; batches: number; objects: number }> {
  const cutoff = new Date(now.getTime() - POST_MEDIA_STALE_MS).toISOString()
  let affected = 0
  let objects = 0
  let batches = 0
  while (batches < maxBatches) {
    batches++
    const rows = await db
      .select({ id: communityPostMedia.id, key: communityPostMedia.objectKey })
      .from(communityPostMedia)
      .where(
        sql`(${communityPostMedia.uploadedAt} is null and ${communityPostMedia.createdAt} < ${cutoff}::timestamptz)
          or (${communityPostMedia.scanStatus}::text in ('quarantined', 'failed') and coalesce(${communityPostMedia.scannedAt}, ${communityPostMedia.createdAt}) < ${cutoff}::timestamptz)
          or exists (select 1 from community_posts p where p.id = ${communityPostMedia.postId} and p.status = 'deleted_by_author')`,
      )
      .limit(deps.batchSize)
    if (rows.length === 0) break
    for (const { key } of rows) {
      if (!isObjectKey(key)) continue
      await deps.storage.delete(key)
      objects++
    }
    const deleted = await db
      .delete(communityPostMedia)
      .where(inArray(communityPostMedia.id, rows.map((r) => r.id)))
      .returning({ id: communityPostMedia.id })
    affected += deleted.length
    if (rows.length < deps.batchSize) break
  }
  return { affected, batches, objects }
}
