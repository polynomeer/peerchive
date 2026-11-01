/**
 * 공감 라운지 미디어 (A-04, PROOFU_EVOLUTION_PLAN §8.9.9 "공감 라운지", SYSTEM_DESIGN §6.7.2 "공감 라운지 미디어"·§10, DELIVERY_PLAN §4.3 A-04,
 * ADR 0041·0039·0007).
 *
 * 라운지 = 공식 학교 페이지의 자유 게시판(@peerchive/domain isLoungeBoard). 그 게시판의 게시 중인 글에 글쓴이가 이미지를 붙입니다(영상은 미룸).
 * 모든 경로는 P2 alumni 플래그가 꺼지면 404입니다(requireFeature).
 *
 * 흐름(앨범 사진과 같은 두 단계, ADR 0039)
 * 1. `POST /community/posts/:id/media {declaredType, fileName, byteSize}` → 201 + 미디어(pending) + `uploadUrl`. 글쓴이 본인 + 쓰기 자격
 *    (canWriteBoard, active 공간, 이용 제한 없음) + 게시 중인 라운지 글만. 이미지(PNG·JPEG·WebP) 10MB, 글당 4개, 시간당 20개.
 * 2. `PUT …/media/:mediaId/content`(본문 = 파일, 15분 안에, 올린 본인만) → 격리 키에 쓰고 검사 작업(`post-media-scan`)을 outbox에 남깁니다.
 *    worker가 형식 판별·내장 콘텐츠·악성코드 검사 뒤 **EXIF·GPS 등 메타데이터를 지운 내용**으로 같은 격리 키를 바꿔 쓰고 clean으로 둡니다.
 * 3. 글 응답(`GET /community/posts/:id`)의 `lounge.items` — 그 글을 읽을 수 있는 사람에게 clean 미디어만, 미디어마다 **그 사람에게만 맞는
 *    5분 서명 URL**. 검사 대기·격리·실패는 올린 본인에게만 상태로. 가린·지운 글은 빈 목록.
 *    `GET …/media/:mediaId/file?exp=&sig=` — 로그인 + 같은 사람 서명 + 만료 전 + 지금 그 글을 읽을 수 있음(졸업생 인증 이력 포함) + 글이 게시 중 +
 *    clean·메타데이터 제거 완료가 모두 맞을 때만 내용. 그 밖은 모두 404.
 * 4. `DELETE …/media/:mediaId` — 올린 본인만. 행을 지운 뒤 파일을 지웁니다(실패하면 격리 파일 정리가 24시간 뒤 지움).
 *
 * - 응답에 올린 사람 id·원래 파일 이름·저장 키를 싣지 않습니다(`mine`만). 감사 기록도 남기지 않습니다: 사람 id와 글 id를 한 행에 남기면
 *   익명 글의 작성자를 찾는 길이 생기기 때문입니다(posts.ts와 같은 원칙, ADR 0022).
 * - 미디어는 공개 DTO·소셜(프로필·피드·PersonaActivity)·검색 색인에 가지 않습니다(그 모듈들은 이 테이블을 읽지 않음, 경계 테스트).
 * - 서명은 앨범 사진과 같은 비밀(affiliation pepper)에 다른 접두어(`post-media:v1`)를 붙인 HMAC입니다.
 */
import { createHmac } from 'node:crypto'
import type { Readable } from 'node:stream'
import {
  LOUNGE_MEDIA_MAX_BYTES,
  LOUNGE_MEDIA_PER_POST,
  LOUNGE_MEDIA_TYPES,
  LOUNGE_MEDIA_UPLOAD_RATE_LIMIT,
  LOUNGE_MEDIA_UPLOAD_TTL_MS,
  LOUNGE_MEDIA_URL_TTL_MS,
  type BoardKind,
  canWriteBoard,
  checkLoungeMediaUpload,
  isLoungeBoard,
  isOpenItem,
} from '@peerchive/domain'
import { and, asc, boards, communityPostMedia, communityPosts, eq, isNull, or, sql, type DbExecutor } from '@peerchive/db'
import { ObjectNotFoundError, ObjectTooLargeError, enqueuePostMediaScan, isObjectKey, newQuarantineKey, type ObjectStorage } from '@peerchive/files'
import { affiliationPepper } from '../affiliation/config'
import { type Actor, conflict, forbidden, gone, invalid, notFound, rateLimited, tooLarge } from '../errors'
import { isFeatureOn, requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { constantTimeEqualHex } from '../security/tokens'
import { hitRateLimit } from '../security/rate-limit'
import { type BoardReadContext, type SpaceContext, loadBoardReadableSpace, membershipFacts, writeRestricted } from './access'
import type { LoungeMediaDto, LoungeMediaUploadDto, LoungePostMediaDto } from '../../../shared/types/api'

type MediaRow = typeof communityPostMedia.$inferSelect
type PostRow = typeof communityPosts.$inferSelect
type BoardRow = typeof boards.$inferSelect

/** 검사 대기·통과(한도에 세는 미디어). 격리·실패는 세지 않습니다. */
const COUNTED = sql`${communityPostMedia.scanStatus}::text in ('pending', 'scanning', 'clean')`

const mediaBase = (postId: string, mediaId: string) => `/api/v1/community/posts/${postId}/media/${mediaId}`

/** 서명: HMAC(affiliation pepper, 미디어 id + 보는 사람 id + 만료). 다른 사람·다른 미디어·만료 뒤에는 맞지 않습니다. */
export function postMediaSignature(pepper: string, mediaId: string, userId: string, expiresAtMs: number): string {
  return createHmac('sha256', pepper).update(`post-media:v1:${mediaId.toLowerCase()}:${userId.toLowerCase()}:${expiresAtMs}`).digest('hex')
}

function servable(row: MediaRow): boolean {
  return row.scanStatus === 'clean' && row.metadataStripped && !!row.mediaType && isObjectKey(row.objectKey)
}

function toMediaDto(row: MediaRow, viewerId: string, now: Date): LoungeMediaDto {
  const mine = row.uploaderId === viewerId
  let url: string | null = null
  let urlExpiresAt: string | null = null
  if (servable(row)) {
    const exp = now.getTime() + LOUNGE_MEDIA_URL_TTL_MS
    url = `${mediaBase(row.postId, row.id)}/file?exp=${exp}&sig=${postMediaSignature(affiliationPepper(), row.id, viewerId, exp)}`
    urlExpiresAt = new Date(exp).toISOString()
  }
  return { id: row.id, mine, scanStatus: row.scanStatus, url, urlExpiresAt, mediaType: servable(row) ? row.mediaType : null, canDelete: mine, createdAt: row.createdAt.toISOString() }
}

/** 미디어를 더 붙일 수 있는지(글쓴이 본인 + 게시 중 + 쓰기 자격·active 공간·이용 제한 없음). 한도는 따로 셉니다. */
function canAttachTo(ctx: SpaceContext, post: PostRow, board: BoardRow): boolean {
  return (
    post.authorId === ctx.viewer.userId &&
    isOpenItem(post.status) &&
    ctx.space.row.status === 'active' &&
    !ctx.viewer.writeRestriction &&
    canWriteBoard(ctx.viewer, ctx.facts, membershipFacts(ctx.membership), { kind: board.kind, writeRole: board.writeRole })
  )
}

/**
 * 글 응답에 붙일 라운지 미디어(posts.ts postDetail이 부름). 플래그가 꺼졌거나 라운지 글이 아니면 undefined(필드 없음).
 * 게시 중이 아닌 글(가림·지움)은 빈 목록 — 글쓴이에게도 내려주지 않습니다.
 */
export async function loungeMediaForPost(db: DbExecutor, ctx: SpaceContext, post: PostRow, board: BoardRow, now: Date): Promise<LoungePostMediaDto | undefined> {
  if (!isFeatureOn('alumni') || !isLoungeBoard(ctx.space.row.kind, board.kind)) return undefined
  const limits = { maxBytes: LOUNGE_MEDIA_MAX_BYTES, perPost: LOUNGE_MEDIA_PER_POST, types: [...LOUNGE_MEDIA_TYPES] }
  if (!isOpenItem(post.status)) return { items: [], canAttach: false, limits }
  const viewerId = ctx.viewer.userId
  const rows = await db
    .select()
    .from(communityPostMedia)
    .where(
      and(
        eq(communityPostMedia.postId, post.id),
        or(eq(communityPostMedia.scanStatus, 'clean'), and(eq(communityPostMedia.uploaderId, viewerId), sql`${communityPostMedia.uploadedAt} is not null`)),
      ),
    )
    .orderBy(asc(communityPostMedia.createdAt), asc(communityPostMedia.id))
  let canAttach = canAttachTo(ctx, post, board)
  if (canAttach) {
    // 한도는 내용을 아직 보내지 않은 요청까지 셉니다(올리기 요청과 같은 규칙).
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(communityPostMedia)
      .where(and(eq(communityPostMedia.postId, post.id), COUNTED))
    canAttach = (count?.n ?? 0) < LOUNGE_MEDIA_PER_POST
  }
  return { items: rows.map((r) => toMediaDto(r, viewerId, now)), canAttach, limits }
}

// ── 불러오기 ─────────────────────────────────────────────────────────────

interface LoadedPost {
  post: PostRow
  board: BoardRow
  ctx: BoardReadContext
}

/** 글 + 게시판 + 읽기 문맥(졸업생 인증 이력 포함). 라운지 글이 아니거나 읽을 수 없으면 404. */
async function loadLoungePost(db: DbExecutor, actor: Actor, postId: unknown, lock: boolean, now: Date): Promise<LoadedPost> {
  if (!isUuid(postId)) throw notFound()
  const query = db.select().from(communityPosts).where(eq(communityPosts.id, postId.toLowerCase())).limit(1)
  const [post] = lock ? await query.for('update') : await query
  if (!post) throw notFound()
  const [board] = await db.select().from(boards).where(eq(boards.id, post.boardId)).limit(1)
  if (!board) throw notFound()
  const ctx = await loadBoardReadableSpace(db, actor, post.spaceId, board.kind as BoardKind, false, now)
  if (!isLoungeBoard(ctx.space.row.kind, board.kind)) throw notFound()
  return { post, board, ctx }
}

async function loadMedia(db: DbExecutor, postId: string, mediaId: unknown, lock = false): Promise<MediaRow> {
  if (!isUuid(mediaId)) throw notFound()
  const query = db
    .select()
    .from(communityPostMedia)
    .where(and(eq(communityPostMedia.id, mediaId.toLowerCase()), eq(communityPostMedia.postId, postId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

// ── 붙이기 ───────────────────────────────────────────────────────────────

/**
 * POST /community/posts/:id/media {declaredType, fileName, byteSize} — 201 + 미디어·업로드 주소. 글쓴이 본인만(남의 글 403 `not_author`).
 * 404(플래그 꺼짐·라운지 글 아님·읽을 수 없음), 409 `space_not_active`·`post_not_open`·`media_full`, 403 `write_restricted`·`write_not_allowed`,
 * 422(`declaredType: unsupported_type` — 영상 포함, `fileName`, `byteSize`), 429.
 */
export async function requestLoungeMediaUpload(db: DbExecutor, actor: Actor, postId: unknown, rawInput: unknown, now = new Date()): Promise<LoungeMediaUploadDto> {
  requireFeature('alumni')
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const { post, board, ctx } = await loadLoungePost(tx, actor, postId, true, now)
    if (post.authorId !== actor.userId) throw forbidden('not_author')
    if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
    if (!isOpenItem(post.status)) throw conflict('post_not_open')
    if (ctx.viewer.writeRestriction) throw writeRestricted(ctx.viewer.writeRestriction)
    if (!canAttachTo(ctx, post, board)) throw forbidden('write_not_allowed')
    const file = checkLoungeMediaUpload({ declaredType: raw.declaredType, fileName: raw.fileName, byteSize: raw.byteSize })
    if (!file.ok) throw invalid({ [file.field]: file.reason })
    if (!(await hitRateLimit(tx, 'lounge_media_upload', actor.userId, LOUNGE_MEDIA_UPLOAD_RATE_LIMIT, now))) throw rateLimited()
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(communityPostMedia)
      .where(and(eq(communityPostMedia.postId, post.id), COUNTED))
    if ((count?.n ?? 0) >= LOUNGE_MEDIA_PER_POST) throw conflict('media_full')
    const [row] = await tx
      .insert(communityPostMedia)
      .values({
        postId: post.id,
        uploaderId: actor.userId,
        objectKey: newQuarantineKey(),
        declaredType: file.mediaType,
        fileExtension: file.extension,
        byteSize: file.byteSize,
        createdAt: now,
      })
      .returning()
    return { media: toMediaDto(row!, actor.userId, now), uploadUrl: `${mediaBase(post.id, row!.id)}/content` }
  })
}

/**
 * PUT /community/posts/:id/media/:mediaId/content (본문 = 파일) — 올린 본인만(그 밖 404). 200 + 미디어. 선언 크기 초과 413, 모자람 422
 * `byteSize: size_mismatch`(받던 내용 삭제), 이미 받음 409 `already_uploaded`, 글이 게시 중이 아니면 409 `post_not_open`, 15분이 지나면 410 `upload_expired`.
 */
export async function uploadLoungeMedia(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  postId: unknown,
  mediaId: unknown,
  body: Readable | AsyncIterable<Uint8Array>,
  options: { contentLength?: number | null } = {},
  now = new Date(),
): Promise<LoungeMediaDto> {
  requireFeature('alumni')
  const { post } = await loadLoungePost(db, actor, postId, false, now)
  const media = await loadMedia(db, post.id, mediaId)
  if (media.uploaderId !== actor.userId) throw notFound()
  if (media.uploadedAt) throw conflict('already_uploaded')
  if (!isOpenItem(post.status)) throw conflict('post_not_open')
  if (now.getTime() - media.createdAt.getTime() > LOUNGE_MEDIA_UPLOAD_TTL_MS) throw gone('upload_expired')
  const key = media.objectKey
  if (!isObjectKey(key)) throw new Error('invalid post media key')
  const length = options.contentLength
  if (length != null && Number.isFinite(length)) {
    if (length > media.byteSize) throw tooLarge()
    if (length !== media.byteSize) throw invalid({ byteSize: 'size_mismatch' })
  }
  let result
  try {
    result = await storage.put(key, body, { maxBytes: media.byteSize })
  } catch (error) {
    if (error instanceof ObjectTooLargeError) throw tooLarge()
    if ((await storage.head(key)) !== null) throw conflict('already_uploaded')
    throw error
  }
  if (result.bytes !== media.byteSize) {
    await storage.delete(key)
    throw invalid({ byteSize: 'size_mismatch' })
  }
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(communityPostMedia)
      .set({ sha256: result.sha256, uploadedAt: now })
      .where(and(eq(communityPostMedia.id, media.id), isNull(communityPostMedia.uploadedAt)))
      .returning()
    if (row) await enqueuePostMediaScan(tx, row.id)
    return row
  })
  if (!updated) throw conflict('already_uploaded')
  return toMediaDto(updated, actor.userId, now)
}

// ── 보기·지우기 ──────────────────────────────────────────────────────────

export interface LoungeMediaContent {
  stream: Readable
  mediaType: string
  bytes: number
}

/**
 * GET /community/posts/:id/media/:mediaId/file?exp=&sig= — 로그인 + 그 사람에게 맞는 서명 + 만료 전(5분) + 지금 그 글을 읽을 수 있음 + 글이 게시 중 +
 * clean·메타데이터 제거 완료가 모두 맞을 때만 내용. 그 밖은 모두 404(가린·지운 글, 검사 전·격리 미디어, 다른 사람의 URL, 플래그 꺼짐 포함).
 */
export async function openLoungeMedia(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  postId: unknown,
  mediaId: unknown,
  query: { exp?: unknown; sig?: unknown },
  now = new Date(),
): Promise<LoungeMediaContent> {
  requireFeature('alumni')
  const { post } = await loadLoungePost(db, actor, postId, false, now)
  if (!isOpenItem(post.status)) throw notFound()
  const media = await loadMedia(db, post.id, mediaId)
  const exp = typeof query.exp === 'string' && /^\d{1,16}$/.test(query.exp) ? Number(query.exp) : NaN
  const sig = typeof query.sig === 'string' && /^[0-9a-f]{64}$/.test(query.sig) ? query.sig : null
  if (!Number.isFinite(exp) || !sig || exp <= now.getTime() || exp > now.getTime() + LOUNGE_MEDIA_URL_TTL_MS) throw notFound()
  if (!constantTimeEqualHex(sig, postMediaSignature(affiliationPepper(), media.id, actor.userId, exp))) throw notFound()
  const key = media.objectKey
  if (!servable(media) || !isObjectKey(key)) throw notFound()
  try {
    const stream = await storage.get(key)
    return { stream, mediaType: media.mediaType!, bytes: media.byteSize }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw notFound()
    throw error
  }
}

/**
 * DELETE /community/posts/:id/media/:mediaId — 올린 본인만(남의 미디어는 404 — 검사 전 것은 보이지 않고, 지울 권한도 없음). 200.
 * 글이 가려졌어도 본인은 지울 수 있습니다. 행을 지운 뒤 파일을 지웁니다(실패해도 행은 지워졌고, 격리 파일 정리가 남은 파일을 지움).
 */
export async function deleteLoungeMedia(db: DbExecutor, storage: ObjectStorage, actor: Actor, postId: unknown, mediaId: unknown, now = new Date()): Promise<{ deleted: true }> {
  requireFeature('alumni')
  const key = await db.transaction(async (tx) => {
    const { post } = await loadLoungePost(tx, actor, postId, false, now)
    const media = await loadMedia(tx, post.id, mediaId, true)
    if (media.uploaderId !== actor.userId) throw notFound()
    await tx.delete(communityPostMedia).where(eq(communityPostMedia.id, media.id))
    return media.objectKey
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
