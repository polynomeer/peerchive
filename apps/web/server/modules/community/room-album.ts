/**
 * 동문회·OB 방의 행사 사진 앨범 (A-02, PROOFU_EVOLUTION_PLAN §8.9.9 "행사 사진 앨범(파일 검사 적용)", SYSTEM_DESIGN §6.7.2 Album·AlbumItem·§10,
 * ADR 0039·0007·0037).
 *
 * 흐름(수료증 확인과 같은 두 단계, ADR 0037)
 * 1. `POST /community/spaces/:slug/album/photos {declaredType, fileName, byteSize, caption?}` → 201 + 사진(pending) + `uploadUrl`.
 *    이미지(PNG·JPEG·WebP)만, 10MB까지, 방 300장·한 사람 60장·시간당 30장. 원래 파일 이름은 확장자만 보고 저장하지 않습니다.
 * 2. `PUT …/album/photos/:id/content`(본문 = 파일, 15분 안에, 올린 본인만) → 격리 키에 쓰고 검사 작업(`album-photo-scan`)을 outbox에 남깁니다.
 *    worker가 형식 판별·내장 콘텐츠·악성코드 검사 뒤 **EXIF·GPS 등 메타데이터를 지운 내용**으로 같은 격리 키를 바꿔 쓰고 clean으로 둡니다.
 * 3. `GET …/album` — 방 active 멤버에게 clean 사진만, 사진마다 **그 사람에게만 맞는 5분 서명 URL**. 검사 대기·격리·실패는 올린 본인에게만 상태로.
 *    `GET …/album/photos/:id/file?exp=&sig=` — 로그인 + 같은 사람 서명 + 만료 전 + 지금 방 active 멤버 + clean + 메타데이터 제거 완료가 모두 맞을
 *    때만 내용, 그 밖은 모두 404. 플래그가 꺼지면 404.
 * 4. `DELETE …/album/photos/:id` — 올린 본인 또는 방장·운영진. 행을 지운 뒤 파일을 지웁니다(실패하면 격리 파일 정리가 24시간 뒤 지움).
 *
 * - 올린 사람 이름은 응답에 싣지 않습니다(`mine`만). 방을 나가도 사진은 방의 기록으로 남고(SYSTEM_DESIGN §6.7.2), 탈퇴하면 worker purge가
 *   사진과 파일을 지웁니다. 끝나지 않은 올리기·통과하지 못한 사진은 worker가 하루 뒤 지웁니다.
 * - 서명은 수료증 파일 URL과 같은 비밀(affiliation pepper)에 다른 접두어(`album-photo:v1`)를 붙인 HMAC입니다.
 * - 감사 기록에는 id·종류만(파일 이름·설명 없음).
 */
import { createHmac } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  ALBUM_CAPTION_MAX,
  ALBUM_MEMBER_PHOTO_LIMIT,
  ALBUM_PHOTO_MAX_BYTES,
  ALBUM_PHOTO_MEDIA_TYPES,
  ALBUM_PHOTO_URL_TTL_MS,
  ALBUM_ROOM_PHOTO_LIMIT,
  ALBUM_UPLOAD_RATE_LIMIT,
  canDeleteAlbumPhoto,
  canManageRoomGatherings,
  checkAlbumPhotoUpload,
  checkOneLine,
} from '@peerchive/domain'
import { and, desc, eq, isNull, or, roomAlbumPhotos, sql, type DbExecutor } from '@peerchive/db'
import { ObjectNotFoundError, ObjectTooLargeError, enqueueAlbumPhotoScan, isObjectKey, newQuarantineKey, type ObjectStorage } from '@peerchive/files'
import { affiliationPepper } from '../affiliation/config'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, gone, invalid, notFound, rateLimited, tooLarge } from '../errors'
import { constantTimeEqualHex } from '../security/tokens'
import { hitRateLimit } from '../security/rate-limit'
import { type AlumniRoom, assertRoomWritable, countAll, loadAlumniRoom, uuidOr404 } from './alumni-room'
import type { AlbumDto, AlbumPhotoDto, AlbumUploadDto } from '../../../shared/types/api'

type PhotoRow = typeof roomAlbumPhotos.$inferSelect

/** 올리기 요청 뒤 내용을 보낼 수 있는 시간. */
export const ALBUM_UPLOAD_TTL_MS = 15 * 60 * 1000
const PHOTO_LIST_LIMIT = ALBUM_ROOM_PHOTO_LIMIT

/** 검사 대기·통과(한도에 세는 사진). 격리·실패는 세지 않습니다. */
const COUNTED = sql`${roomAlbumPhotos.scanStatus}::text in ('pending', 'scanning', 'clean')`

const photoBase = (slug: string, photoId: string) => `/api/v1/community/spaces/${slug}/album/photos/${photoId}`

/** 서명: HMAC(affiliation pepper, 사진 id + 보는 사람 id + 만료). 다른 사람·다른 사진·만료 뒤에는 맞지 않습니다. */
export function albumPhotoSignature(pepper: string, photoId: string, userId: string, expiresAtMs: number): string {
  return createHmac('sha256', pepper).update(`album-photo:v1:${photoId.toLowerCase()}:${userId.toLowerCase()}:${expiresAtMs}`).digest('hex')
}

function servable(row: PhotoRow): boolean {
  return row.scanStatus === 'clean' && row.metadataStripped && !!row.mediaType && isObjectKey(row.objectKey)
}

function toPhotoDto(room: AlumniRoom, row: PhotoRow, viewerId: string, now: Date): AlbumPhotoDto {
  const mine = row.uploaderId === viewerId
  let url: string | null = null
  let urlExpiresAt: string | null = null
  if (servable(row)) {
    const exp = now.getTime() + ALBUM_PHOTO_URL_TTL_MS
    url = `${photoBase(room.ctx.space.row.slug, row.id)}/file?exp=${exp}&sig=${albumPhotoSignature(affiliationPepper(), row.id, viewerId, exp)}`
    urlExpiresAt = new Date(exp).toISOString()
  }
  return {
    id: row.id,
    caption: row.caption,
    mine,
    scanStatus: row.scanStatus,
    url,
    urlExpiresAt,
    canDelete: room.ctx.space.row.status !== 'restricted' && canDeleteAlbumPhoto(room.ctx.membership?.role, mine),
    createdAt: row.createdAt.toISOString(),
  }
}

/** GET /community/spaces/:slug/album — 방 active 멤버만. clean 사진(최신순) + 내가 올린 검사 대기·격리·실패 사진. */
export async function getAlbum(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<AlbumDto> {
  const room = await loadAlumniRoom(db, actor, ref, false, now)
  const rows = await db
    .select()
    .from(roomAlbumPhotos)
    .where(
      and(
        eq(roomAlbumPhotos.spaceId, room.ctx.space.row.id),
        or(eq(roomAlbumPhotos.scanStatus, 'clean'), and(eq(roomAlbumPhotos.uploaderId, actor.userId), sql`${roomAlbumPhotos.uploadedAt} is not null`)),
      ),
    )
    .orderBy(desc(roomAlbumPhotos.createdAt), desc(roomAlbumPhotos.id))
    .limit(PHOTO_LIST_LIMIT)
  return {
    canManage: room.ctx.space.row.status === 'active' && canManageRoomGatherings(room.ctx.membership?.role),
    writable: room.ctx.space.row.status === 'active',
    limits: { maxBytes: ALBUM_PHOTO_MAX_BYTES, roomPhotos: ALBUM_ROOM_PHOTO_LIMIT, memberPhotos: ALBUM_MEMBER_PHOTO_LIMIT, types: [...ALBUM_PHOTO_MEDIA_TYPES] },
    photos: rows.filter((r) => r.scanStatus === 'clean' || r.uploaderId === actor.userId).map((r) => toPhotoDto(room, r, actor.userId, now)),
  }
}

/**
 * POST /community/spaces/:slug/album/photos {declaredType, fileName, byteSize, caption?} — 방 active 멤버. 201 + 사진·업로드 주소.
 * 409 `space_not_active`·`album_full`·`member_album_full`, 403 `write_restricted`, 422(`declaredType: unsupported_type`, `fileName`, `byteSize`, `caption`), 429.
 */
export async function requestAlbumUpload(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<AlbumUploadDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx)
    const file = checkAlbumPhotoUpload({ declaredType: raw.declaredType, fileName: raw.fileName, byteSize: raw.byteSize })
    if (!file.ok) throw invalid({ [file.field]: file.reason })
    const caption = checkOneLine(raw.caption, ALBUM_CAPTION_MAX)
    if (!caption.ok) throw invalid({ caption: caption.reason })
    if (!(await hitRateLimit(tx, 'room_album_upload', actor.userId, ALBUM_UPLOAD_RATE_LIMIT, now))) throw rateLimited()
    const counts = await tx
      .select({ mine: sql<number>`count(*) filter (where ${roomAlbumPhotos.uploaderId} = ${actor.userId})::int`, all: countAll })
      .from(roomAlbumPhotos)
      .where(and(eq(roomAlbumPhotos.spaceId, room.ctx.space.row.id), COUNTED))
    if ((counts[0]?.all ?? 0) >= ALBUM_ROOM_PHOTO_LIMIT) throw conflict('album_full')
    if ((counts[0]?.mine ?? 0) >= ALBUM_MEMBER_PHOTO_LIMIT) throw conflict('member_album_full')
    const [row] = await tx
      .insert(roomAlbumPhotos)
      .values({
        spaceId: room.ctx.space.row.id,
        uploaderId: actor.userId,
        caption: caption.value,
        objectKey: newQuarantineKey(),
        declaredType: file.mediaType,
        fileExtension: file.extension,
        byteSize: file.byteSize,
        createdAt: now,
      })
      .returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.album_photo_request', targetType: 'community_space', targetId: room.ctx.space.row.id, metadata: { photoId: row!.id } })
    return { photo: toPhotoDto(room, row!, actor.userId, now), uploadUrl: `${photoBase(room.ctx.space.row.slug, row!.id)}/content` }
  })
}

async function loadPhoto(db: DbExecutor, spaceId: string, photoId: unknown, lock = false): Promise<PhotoRow> {
  const id = uuidOr404(photoId)
  const query = db
    .select()
    .from(roomAlbumPhotos)
    .where(and(eq(roomAlbumPhotos.id, id), eq(roomAlbumPhotos.spaceId, spaceId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

/**
 * PUT /community/spaces/:slug/album/photos/:id/content (본문 = 파일) — 올린 본인만(그 밖 404). 200 + 사진. 선언 크기 초과 413, 모자람 422
 * `byteSize: size_mismatch`(받던 내용 삭제), 이미 받음 409 `already_uploaded`, 15분이 지나면 410 `upload_expired`. 받은 뒤 검사 작업을 남깁니다.
 */
export async function uploadAlbumPhoto(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  ref: unknown,
  photoId: unknown,
  body: Readable | AsyncIterable<Uint8Array>,
  options: { contentLength?: number | null } = {},
  now = new Date(),
): Promise<AlbumPhotoDto> {
  const room = await loadAlumniRoom(db, actor, ref, false, now)
  assertRoomWritable(room.ctx)
  const photo = await loadPhoto(db, room.ctx.space.row.id, photoId)
  if (photo.uploaderId !== actor.userId) throw notFound()
  if (photo.uploadedAt) throw conflict('already_uploaded')
  if (now.getTime() - photo.createdAt.getTime() > ALBUM_UPLOAD_TTL_MS) throw gone('upload_expired')
  const key = photo.objectKey
  if (!isObjectKey(key)) throw new Error('invalid album photo key')
  const length = options.contentLength
  if (length != null && Number.isFinite(length)) {
    if (length > photo.byteSize) throw tooLarge()
    if (length !== photo.byteSize) throw invalid({ byteSize: 'size_mismatch' })
  }
  let result
  try {
    result = await storage.put(key, body, { maxBytes: photo.byteSize })
  } catch (error) {
    if (error instanceof ObjectTooLargeError) throw tooLarge()
    if ((await storage.head(key)) !== null) throw conflict('already_uploaded')
    throw error
  }
  if (result.bytes !== photo.byteSize) {
    await storage.delete(key)
    throw invalid({ byteSize: 'size_mismatch' })
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(roomAlbumPhotos)
      .set({ sha256: result.sha256, uploadedAt: now })
      .where(and(eq(roomAlbumPhotos.id, photo.id), isNull(roomAlbumPhotos.uploadedAt)))
      .returning()
    if (row) await enqueueAlbumPhotoScan(tx, row.id)
    return row
  })
  if (!updated) throw conflict('already_uploaded')
  return toPhotoDto(room, updated, actor.userId, now)
}

export interface AlbumPhotoContent {
  stream: Readable
  mediaType: string
  bytes: number
}

/**
 * GET /community/spaces/:slug/album/photos/:id/file?exp=&sig= — 로그인 + 그 사람에게 맞는 서명 + 만료 전(5분) + 지금 방 active 멤버 + clean·메타데이터 제거
 * 완료가 모두 맞을 때만 내용. 그 밖은 모두 404(검사 전·격리 사진, 다른 사람의 URL, 나간 멤버, 플래그 꺼짐 포함).
 */
export async function openAlbumPhoto(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  ref: unknown,
  photoId: unknown,
  query: { exp?: unknown; sig?: unknown },
  now = new Date(),
): Promise<AlbumPhotoContent> {
  const room = await loadAlumniRoom(db, actor, ref, false, now)
  const photo = await loadPhoto(db, room.ctx.space.row.id, photoId)
  const exp = typeof query.exp === 'string' && /^\d{1,16}$/.test(query.exp) ? Number(query.exp) : NaN
  const sig = typeof query.sig === 'string' && /^[0-9a-f]{64}$/.test(query.sig) ? query.sig : null
  if (!Number.isFinite(exp) || !sig || exp <= now.getTime() || exp > now.getTime() + ALBUM_PHOTO_URL_TTL_MS) throw notFound()
  if (!constantTimeEqualHex(sig, albumPhotoSignature(affiliationPepper(), photo.id, actor.userId, exp))) throw notFound()
  const key = photo.objectKey
  if (!servable(photo) || !isObjectKey(key)) throw notFound()
  try {
    const stream = await storage.get(key)
    return { stream, mediaType: photo.mediaType!, bytes: photo.byteSize }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw notFound()
    throw error
  }
}

/**
 * DELETE /community/spaces/:slug/album/photos/:id — 올린 본인 또는 방장·운영진(그 밖 403). 200. 보관된 방에서도 지울 수 있습니다(제한된 방은 409).
 * 행을 지운 뒤 파일을 지웁니다(실패해도 행은 지워졌고, 격리 파일 정리가 남은 파일을 지움).
 */
export async function deleteAlbumPhoto(db: DbExecutor, storage: ObjectStorage, actor: Actor, ref: unknown, photoId: unknown, now = new Date()): Promise<{ deleted: true }> {
  const key = await db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    if (room.ctx.space.row.status === 'restricted') throw conflict('space_not_active', { status: room.ctx.space.row.status })
    const photo = await loadPhoto(tx, room.ctx.space.row.id, photoId, true)
    const mine = photo.uploaderId === actor.userId
    // 남이 올린 검사 전 사진은 멤버에게 보이지 않으므로 없는 것으로 봅니다.
    if (!mine && photo.scanStatus !== 'clean') throw notFound()
    if (!canDeleteAlbumPhoto(room.ctx.membership?.role, mine)) throw forbidden()
    await tx.delete(roomAlbumPhotos).where(eq(roomAlbumPhotos.id, photo.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.album_photo_delete',
      targetType: 'community_space',
      targetId: room.ctx.space.row.id,
      metadata: { photoId: photo.id, self: mine },
    })
    return photo.objectKey
  })
  if (isObjectKey(key)) {
    try {
      await storage.delete(key)
    } catch {
      // 격리 파일 정리(orphan-quarantine)가 24시간 뒤 지웁니다.
    }
  }
  return { deleted: true }
}
