/**
 * A-04 공감 라운지 미디어·졸업생 열람 (DELIVERY_PLAN §4.3 A-04, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2·§8.4, ADR 0041).
 * - 라운지(공식 학교 페이지 자유 게시판) 글에만 이미지, 글쓴이만 붙이고, 검사·EXIF/GPS 제거를 통과한 것만 그 글을 읽을 수 있는 사람에게 짧은 서명 URL로.
 *   읽을 수 없는 사람·다른 사람의 URL·가린·지운 글은 404, 한도(형식·크기·글당 개수), 영상은 미룸(422), 플래그가 꺼지면 404.
 * - 졸업생 인증 이력(standing alumni + 인증된 적 있음 + active/expired)으로 졸업생·자유 게시판을 읽음(쓰기 없음), 해제·인증 전·재학생 이력은 404,
 *   플래그가 꺼지면 active 인증만(기존 동작).
 * 각 테스트는 rollback 트랜잭션 안에서 돕니다. 검사기는 clamav 대신 형식 판별만 하는 검사기(createSignatureOnlyScanner)를 씁니다.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { countsAsAlumniHistory } from '@peerchive/domain'
import { and, auditEvents, communityPostMedia, eq, institutionAffiliations, operators, outboxEvents, type DbExecutor } from '@peerchive/db'
import { POST_MEDIA_SCAN_QUEUE, createFilesystemStorage, createSignatureOnlyScanner, readAll, scanPostMedia, type ObjectStorage } from '@peerchive/files'
import { removeAffiliation, stopUsingAlumniEmail } from '../server/modules/affiliation/affiliations'
import { createSchool } from '../server/modules/catalog/catalog'
import { deleteLoungeMedia, openLoungeMedia, requestLoungeMediaUpload, uploadLoungeMedia } from '../server/modules/community/lounge-media'
import { hideCommunityItemInTx } from '../server/modules/community/moderation'
import { createOfficialPage } from '../server/modules/community/official'
import { createComment, createPost, deletePost, getPost, listBoardPosts, setReaction } from '../server/modules/community/posts'
import { resolveReportablePost } from '../server/modules/community/reporting'
import { getSpaceDetail, listMySpaces } from '../server/modules/community/spaces'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { closeTestDb, createUser, databaseUrl, expectServiceError, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-02T03:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const ON = { PEERCHIVE_FEATURE_P2_ALUMNI: 'on' }
const scanner = createSignatureOnlyScanner()
const VERIFIED = new Date('2022-03-02T00:00:00Z')

// GPS·방향이 든 EXIF를 붙인 1×1 JPEG(alumni-events.integration.test.ts와 같은 표본).
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
)
const GPS_MARK = 'GPS37.5665N126.9780E'
function exifApp1(): Buffer {
  const tiff = Buffer.alloc(80)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(2, 8)
  tiff.writeUInt16LE(0x0112, 10)
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(6, 18)
  tiff.writeUInt16LE(0x8825, 22)
  tiff.writeUInt16LE(4, 24)
  tiff.writeUInt32LE(1, 26)
  tiff.writeUInt32LE(40, 30)
  tiff.writeUInt32LE(0, 34)
  tiff.writeUInt16LE(1, 40)
  tiff.writeUInt16LE(0x0002, 42)
  tiff.writeUInt16LE(2, 44)
  tiff.writeUInt32LE(GPS_MARK.length, 46)
  tiff.writeUInt32LE(60, 50)
  tiff.writeUInt32LE(0, 54)
  tiff.write(GPS_MARK, 60, 'latin1')
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const head = Buffer.alloc(4)
  head.writeUInt16BE(0xffe1, 0)
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}
const JPEG_GPS = Buffer.concat([JPEG_1x1.subarray(0, 20), exifApp1(), JPEG_1x1.subarray(20), Buffer.from([0x12, 0xff, 0xd9])])

/** 인증 이력 행(메일 해시 없음 — 메일 확인이 끝났거나 해제된 상태). */
async function historyRow(
  tx: DbExecutor,
  userId: string,
  schoolId: string,
  values: { standing: 'student' | 'alumni'; status: 'expired' | 'revoked' | 'pending'; verifiedAt: Date | null },
) {
  await tx.insert(institutionAffiliations).values({
    userId,
    schoolId,
    emailHash: values.status === 'pending' ? crypto.randomUUID().replace(/-/g, '').repeat(2) : null,
    emailDomain: 'fixture.ac.kr',
    standing: values.standing,
    status: values.status,
    verifiedAt: values.verifiedAt,
    ...(values.status === 'revoked' && { revokedAt: T0, revokedReason: 'user_removed' }),
  })
}

async function world(tx: DbExecutor) {
  const op = await createUser(tx)
  await tx.insert(operators).values({ userId: op.id })
  const tag = crypto.randomUUID().slice(0, 8)
  const school = await createSchool(tx, { userId: op.id }, { name: `라운지대${tag}`, confirmNew: true }, T0)
  const otherSchool = await createSchool(tx, { userId: op.id }, { name: `다른대${tag}`, confirmNew: true }, T0)
  const page = await createOfficialPage(tx, { userId: op.id }, { schoolId: school.id }, T0)
  const board = (kind: string) => page.boards.find((b) => b.kind === kind)!
  const person = async (setup: (userId: string) => Promise<unknown>) => {
    const u = await createUser(tx)
    await setup(u.id)
    return { userId: u.id }
  }
  return {
    op: { userId: op.id },
    schoolId: school.id,
    page,
    lounge: board('free'),
    alumniBoard: board('alumni'),
    question: board('question'),
    author: await person((id) => verifiedAffiliation(tx, id, school.id)),
    reader: await person((id) => verifiedAffiliation(tx, id, school.id, { standing: 'alumni' })),
    outsider: await person((id) => verifiedAffiliation(tx, id, otherSchool.id)),
    // 재학 중 인증 → 졸업 → 학교 메일 확인이 끝남(expired, 메일 해시 없음, 인증 시각 유지).
    graduate: await person((id) => historyRow(tx, id, school.id, { standing: 'alumni', status: 'expired', verifiedAt: VERIFIED })),
    revoked: await person((id) => historyRow(tx, id, school.id, { standing: 'alumni', status: 'revoked', verifiedAt: VERIFIED })),
    neverVerified: await person(async (id) => {
      await historyRow(tx, id, school.id, { standing: 'alumni', status: 'expired', verifiedAt: null })
      await historyRow(tx, id, school.id, { standing: 'alumni', status: 'pending', verifiedAt: null })
    }),
    lapsedStudent: await person((id) => historyRow(tx, id, school.id, { standing: 'student', status: 'expired', verifiedAt: VERIFIED })),
  }
}
type World = Awaited<ReturnType<typeof world>>

describe.skipIf(!databaseUrl)('A-04 lounge media and alumni reading (PostgreSQL)', () => {
  let root: string
  let storage: ObjectStorage
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-lounge-media-'))
    storage = createFilesystemStorage(root)
  })
  afterAll(async () => {
    await closeTestDb()
    await rm(root, { recursive: true, force: true })
  })
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  /** 라운지 글 + 검사를 통과한 이미지 하나. */
  async function loungePostWithImage(tx: DbExecutor, w: World) {
    const post = await createPost(tx, w.author, w.lounge.id, { title: '오늘 학식', body: '사진 봐 주세요' }, at(1))
    const req = await requestLoungeMediaUpload(tx, w.author, post.id, { declaredType: 'image/jpeg', fileName: '김지민_학식.jpg', byteSize: JPEG_GPS.length }, at(1))
    await uploadLoungeMedia(tx, storage, w.author, post.id, req.media.id, Readable.from([JPEG_GPS]), { contentLength: JPEG_GPS.length }, at(2))
    expect(await scanPostMedia(tx, { storage, scanner }, req.media.id)).toEqual({ status: 'clean' })
    return { post, mediaId: req.media.id }
  }
  const query = (url: string) => {
    const u = new URL(url, 'http://x')
    return { exp: u.searchParams.get('exp')!, sig: u.searchParams.get('sig')! }
  }

  it('media: upload → scan → EXIF/GPS strip → only readers of the post get a short viewer-bound URL; others 404', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const post = await createPost(tx, w.author, w.lounge.id, { title: '오늘 학식', body: '사진 봐 주세요' }, at(1))
      expect(post.lounge).toMatchObject({ items: [], canAttach: true, limits: { perPost: 4, maxBytes: 10 * 1024 * 1024 } })
      const req = await requestLoungeMediaUpload(tx, w.author, post.id, { declaredType: 'image/jpeg', fileName: '김지민_학식.jpg', byteSize: JPEG_GPS.length }, at(1))
      expect(req.uploadUrl).toBe(`/api/v1/community/posts/${post.id}/media/${req.media.id}/content`)
      expect(JSON.stringify(req)).not.toContain('김지민')
      await expectServiceError(uploadLoungeMedia(tx, storage, w.reader, post.id, req.media.id, Readable.from([JPEG_GPS]), {}, at(2)), 'NOT_FOUND')
      await uploadLoungeMedia(tx, storage, w.author, post.id, req.media.id, Readable.from([JPEG_GPS]), { contentLength: JPEG_GPS.length }, at(2))
      await expectServiceError(uploadLoungeMedia(tx, storage, w.author, post.id, req.media.id, Readable.from([JPEG_GPS]), {}, at(2)), 'CONFLICT', 'already_uploaded')
      const jobs = await tx.select().from(outboxEvents).where(eq(outboxEvents.topic, POST_MEDIA_SCAN_QUEUE))
      expect(jobs.map((j) => (j.payload as { mediaId: string }).mediaId)).toContain(req.media.id)
      // 검사 전: 다른 사람에게는 없고, 글쓴이에게만 상태.
      expect((await getPost(tx, w.reader, post.id, at(3))).lounge!.items).toEqual([])
      expect((await getPost(tx, w.author, post.id, at(3))).lounge!.items[0]).toMatchObject({ scanStatus: 'pending', url: null, mine: true })

      expect(await scanPostMedia(tx, { storage, scanner }, req.media.id)).toEqual({ status: 'clean' })
      const [row] = await tx.select().from(communityPostMedia).where(eq(communityPostMedia.id, req.media.id))
      expect(row).toMatchObject({ scanStatus: 'clean', metadataStripped: true, mediaType: 'image/jpeg' })
      const stored = await readAll(await storage.get(row!.objectKey as never), row!.byteSize)
      expect(stored.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false)
      expect(row!.byteSize).toBeLessThan(JPEG_GPS.length)

      const seen = await getPost(tx, w.reader, post.id, at(4))
      const media = seen.lounge!.items[0]!
      expect(media).toMatchObject({ id: req.media.id, scanStatus: 'clean', mine: false, canDelete: false, mediaType: 'image/jpeg' })
      expect(Date.parse(media.urlExpiresAt!) - at(4).getTime()).toBe(5 * 60_000)
      expect(JSON.stringify(seen.lounge)).not.toContain(w.author.userId)
      expect(JSON.stringify(seen.lounge)).not.toContain('quarantine/')
      const q = query(media.url!)
      const file = await openLoungeMedia(tx, storage, w.reader, post.id, media.id, q, at(5))
      expect(file.mediaType).toBe('image/jpeg')
      expect((await readAll(file.stream, file.bytes)).includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false)
      // 다른 사람의 URL·만료·틀린 서명·읽을 수 없는 사람·다른 글 경로는 404.
      await expectServiceError(openLoungeMedia(tx, storage, w.author, post.id, media.id, q, at(5)), 'NOT_FOUND')
      await expectServiceError(openLoungeMedia(tx, storage, w.reader, post.id, media.id, q, at(10)), 'NOT_FOUND')
      await expectServiceError(openLoungeMedia(tx, storage, w.reader, post.id, media.id, { exp: q.exp, sig: '0'.repeat(64) }, at(5)), 'NOT_FOUND')
      await expectServiceError(openLoungeMedia(tx, storage, w.outsider, post.id, media.id, q, at(5)), 'NOT_FOUND')
      await expectServiceError(getPost(tx, w.outsider, post.id, at(5)), 'NOT_FOUND')
      const other = await createPost(tx, w.author, w.lounge.id, { title: '다른 글', body: '본문' }, at(5))
      await expectServiceError(openLoungeMedia(tx, storage, w.reader, other.id, media.id, q, at(5)), 'NOT_FOUND')

      // 통과하지 못한 파일(이미지가 아님)은 글쓴이에게만 상태로, 다른 사람에게는 없음.
      const html = Buffer.from('<html><script>alert(1)</script></html>')
      const bad = await requestLoungeMediaUpload(tx, w.author, post.id, { declaredType: 'image/png', fileName: 'x.png', byteSize: html.length }, at(6))
      await uploadLoungeMedia(tx, storage, w.author, post.id, bad.media.id, Readable.from([html]), {}, at(6))
      expect((await scanPostMedia(tx, { storage, scanner }, bad.media.id)).status).toBe('quarantined')
      expect((await getPost(tx, w.reader, post.id, at(7))).lounge!.items.map((m) => m.id)).toEqual([media.id])
      expect((await getPost(tx, w.author, post.id, at(7))).lounge!.items.find((m) => m.id === bad.media.id)).toMatchObject({ scanStatus: 'quarantined', url: null })

      // 지우기는 올린 본인만(그 밖 404).
      await expectServiceError(deleteLoungeMedia(tx, storage, w.reader, post.id, media.id, at(8)), 'NOT_FOUND')
      await deleteLoungeMedia(tx, storage, w.author, post.id, media.id, at(8))
      expect(await storage.head(row!.objectKey as never)).toBeNull()
      expect((await getPost(tx, w.reader, post.id, at(9))).lounge!.items).toEqual([])
      await expectServiceError(openLoungeMedia(tx, storage, w.reader, post.id, media.id, q, at(9)), 'NOT_FOUND')

      const late = await requestLoungeMediaUpload(tx, w.author, post.id, { declaredType: 'image/jpeg', fileName: 'b.jpg', byteSize: JPEG_GPS.length }, at(10))
      await expectServiceError(uploadLoungeMedia(tx, storage, w.author, post.id, late.media.id, Readable.from([JPEG_GPS]), {}, at(26)), 'GONE', 'upload_expired')
    })
  })

  it('media: hidden or deleted posts serve nothing (404), and only lounge posts by their author can attach', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const hidden = await loungePostWithImage(tx, w)
      const deleted = await loungePostWithImage(tx, w)
      const urlOf = async (postId: string) => (await getPost(tx, w.reader, postId, at(3))).lounge!.items[0]!
      const h = await urlOf(hidden.post.id)
      const d = await urlOf(deleted.post.id)
      await hideCommunityItemInTx(tx, 'post', hidden.post.id, at(4))
      await deletePost(tx, w.author, deleted.post.id, at(4))
      for (const [post, m] of [[hidden.post, h], [deleted.post, d]] as const) {
        await expectServiceError(openLoungeMedia(tx, storage, w.reader, post.id, m.id, query(m.url!), at(4)), 'NOT_FOUND')
        await expectServiceError(openLoungeMedia(tx, storage, w.author, post.id, m.id, query(m.url!), at(4)), 'NOT_FOUND')
        await expectServiceError(
          requestLoungeMediaUpload(tx, w.author, post.id, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }, at(4)),
          'CONFLICT',
          'post_not_open',
        )
      }
      // 글쓴이에게도 가린·지운 글의 미디어 목록은 비어 있습니다.
      expect((await getPost(tx, w.author, hidden.post.id, at(5))).lounge).toMatchObject({ items: [], canAttach: false })
      expect((await getPost(tx, w.author, deleted.post.id, at(5))).lounge).toMatchObject({ items: [], canAttach: false })

      // 라운지가 아닌 게시판(졸업생·질문)의 글에는 미디어 경로가 없고(404) 글 응답에 lounge 필드도 없습니다.
      for (const board of [w.alumniBoard, w.question]) {
        const p = await createPost(tx, w.author, board.id, { title: '라운지 아님', body: '본문' }, at(6))
        expect(p.lounge).toBeUndefined()
        await expectServiceError(requestLoungeMediaUpload(tx, w.author, p.id, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }, at(6)), 'NOT_FOUND')
      }
      // 남의 글에는 붙이지 못함, 읽을 수 없는 사람은 404.
      const mine = await createPost(tx, w.author, w.lounge.id, { title: '내 글', body: '본문' }, at(7))
      await expectServiceError(requestLoungeMediaUpload(tx, w.reader, mine.id, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }, at(7)), 'FORBIDDEN', 'not_author')
      await expectServiceError(requestLoungeMediaUpload(tx, w.outsider, mine.id, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }, at(7)), 'NOT_FOUND')
      expect((await getPost(tx, w.reader, mine.id, at(7))).lounge!.canAttach).toBe(false)
    })
  })

  it('media limits: images only (video deferred), 10MB, 4 per post (quarantined ones do not count)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const post = await createPost(tx, w.author, w.lounge.id, { title: '한도', body: '본문' }, at(1))
      const ask = (input: Record<string, unknown>) => requestLoungeMediaUpload(tx, w.author, post.id, input, at(1))
      for (const declaredType of ['video/mp4', 'video/webm', 'video/quicktime', 'image/gif']) {
        expect((await expectServiceError(ask({ declaredType, fileName: 'clip.mp4', byteSize: 1000 }), 'VALIDATION')).fields).toEqual({ declaredType: 'unsupported_type' })
      }
      expect((await expectServiceError(ask({ declaredType: 'image/png', fileName: 'a.png', byteSize: 10 * 1024 * 1024 + 1 }), 'VALIDATION')).fields).toEqual({ byteSize: 'too_large' })
      expect((await expectServiceError(ask({ declaredType: 'image/png', fileName: 'a.jpg', byteSize: 10 }), 'VALIDATION')).fields).toEqual({ fileName: 'extension_mismatch' })
      const made = []
      for (let i = 0; i < 4; i++) made.push(await ask({ declaredType: 'image/png', fileName: `a${i}.png`, byteSize: 10 }))
      await expectServiceError(ask({ declaredType: 'image/png', fileName: 'a5.png', byteSize: 10 }), 'CONFLICT', 'media_full')
      expect((await getPost(tx, w.author, post.id, at(2))).lounge!.canAttach).toBe(false)
      await tx.update(communityPostMedia).set({ scanStatus: 'quarantined', scanReason: 'type_mismatch' }).where(eq(communityPostMedia.id, made[0]!.media.id))
      await ask({ declaredType: 'image/png', fileName: 'a6.png', byteSize: 10 })
    })
  })

  it('alumni reading: a verified-then-graduated user without a working school email reads the alumni board and the lounge (read-only)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const { post: loungePost } = await loungePostWithImage(tx, w)
      const alumniPost = await createPost(tx, w.reader, w.alumniBoard.id, { title: '졸업생 근황', body: '본문' }, at(3))
      const questionPost = await createPost(tx, w.author, w.question.id, { title: '질문', body: '본문' }, at(3))
      const g = w.graduate

      const detail = await getSpaceDetail(tx, g, w.page.slug, at(4))
      expect(detail.access).toBe('alumni_history')
      expect(detail.boards.map((b) => b.kind).sort()).toEqual(['alumni', 'free'])
      expect(detail.boards.every((b) => !b.canWrite)).toBe(true)
      expect(Object.values(detail.permissions).every((v) => v === false)).toBe(true)
      expect((await listMySpaces(tx, g)).items.map((s) => s.slug)).toEqual([w.page.slug])

      expect((await listBoardPosts(tx, g, w.alumniBoard.id, {}, at(4))).items.map((p) => p.id)).toEqual([alumniPost.id])
      const lounge = await listBoardPosts(tx, g, w.lounge.id, {}, at(4))
      expect(lounge.items.map((p) => p.id)).toEqual([loungePost.id])
      expect(lounge.composer.canWrite).toBe(false)
      const seen = await getPost(tx, g, loungePost.id, at(4))
      expect(seen).toMatchObject({ alumniHistoryOnly: true, canReact: false, composer: { canWrite: false } })
      // 이미지도 읽을 수 있음(같은 서명 규칙).
      const m = seen.lounge!.items[0]!
      expect((await openLoungeMedia(tx, storage, g, loungePost.id, m.id, query(m.url!), at(5))).mediaType).toBe('image/jpeg')
      // 신고는 읽을 수 있는 글에 대해 가능.
      expect(await resolveReportablePost(tx, g, { postId: loungePost.id })).toBe(loungePost.id)

      // 다른 게시판은 읽지 못하고, 쓰기·댓글·공감은 그대로 active 인증이 필요(읽을 수 없는 공간으로 404).
      await expectServiceError(listBoardPosts(tx, g, w.question.id, {}, at(5)), 'NOT_FOUND')
      await expectServiceError(getPost(tx, g, questionPost.id, at(5)), 'NOT_FOUND')
      await expectServiceError(createPost(tx, g, w.lounge.id, { title: '쓰기', body: '본문' }, at(5)), 'NOT_FOUND')
      await expectServiceError(createComment(tx, g, loungePost.id, { body: '댓글' }, at(5)), 'NOT_FOUND')
      await expectServiceError(setReaction(tx, g, 'post', loungePost.id, true, at(5)), 'NOT_FOUND')
      // active 졸업생 인증(메일이 아직 유지)은 기존대로 모든 게시판을 읽고 씁니다.
      expect((await getSpaceDetail(tx, w.reader, w.page.slug, at(5))).access).toBe('member')
    })
  })

  it('D-04: stopping school email use keeps reading only, end to end; release (revoked) is unchanged; flag off is 404', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const post = await createPost(tx, w.reader, w.alumniBoard.id, { title: '졸업생 근황', body: '본문' }, at(1))
      const g = { userId: (await createUser(tx)).id }
      const { id } = await verifiedAffiliation(tx, g.userId, w.schoolId, { standing: 'alumni' })
      expect((await getSpaceDetail(tx, g, w.page.slug, at(2))).access).toBe('member')

      // 남의 소속·플래그 꺼짐은 404, 재학생은 409.
      await expectServiceError(stopUsingAlumniEmail(tx, w.reader, id, at(2)), 'NOT_FOUND')
      setFeatureEnvForTesting({})
      await expectServiceError(stopUsingAlumniEmail(tx, g, id, at(2)), 'NOT_FOUND')
      setFeatureEnvForTesting(ON)
      const studentUser = { userId: (await createUser(tx)).id }
      const student = await verifiedAffiliation(tx, studentUser.userId, w.schoolId)
      await expectServiceError(stopUsingAlumniEmail(tx, studentUser, student.id, at(2)), 'CONFLICT', 'not_alumni_active')

      const before = (await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, id)))[0]!
      expect((await stopUsingAlumniEmail(tx, g, id, at(3))).status).toBe('expired')
      const [row] = await tx.select().from(institutionAffiliations).where(eq(institutionAffiliations.id, id))
      expect(row).toMatchObject({ status: 'expired', emailHash: null, verifiedAt: before.verifiedAt })
      expect(countsAsAlumniHistory(row!)).toBe(true)
      // 멱등. 감사에는 id·학교만.
      await stopUsingAlumniEmail(tx, g, id, at(4))
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, 'affiliation.alumni_read_only')))
      expect(audits).toHaveLength(1)
      expect(audits[0]!.metadata).toEqual({ schoolId: w.schoolId })

      // 읽기는 유지, 쓰기는 거부.
      expect((await getSpaceDetail(tx, g, w.page.slug, at(5))).access).toBe('alumni_history')
      expect((await listBoardPosts(tx, g, w.alumniBoard.id, {}, at(5))).items.map((p) => p.id)).toEqual([post.id])
      await expectServiceError(createPost(tx, g, w.alumniBoard.id, { title: '쓰기', body: '본문' }, at(5)), 'NOT_FOUND')
      await expectServiceError(createComment(tx, g, post.id, { body: '댓글' }, at(5)), 'NOT_FOUND')

      // 기존 해제는 그대로 전체 해제(이력으로 세지 않음).
      const r = { userId: (await createUser(tx)).id }
      const released = await verifiedAffiliation(tx, r.userId, w.schoolId, { standing: 'alumni' })
      expect((await removeAffiliation(tx, r, released.id, at(6))).status).toBe('revoked')
      await expectServiceError(listBoardPosts(tx, r, w.alumniBoard.id, {}, at(6)), 'NOT_FOUND')
      await expectServiceError(stopUsingAlumniEmail(tx, r, released.id, at(6)), 'CONFLICT', 'not_alumni_active')
    })
  })

  it('alumni reading: revoked, never-verified and lapsed-student histories do not count', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const post = await createPost(tx, w.reader, w.alumniBoard.id, { title: '졸업생 근황', body: '본문' }, at(1))
      for (const who of [w.revoked, w.neverVerified, w.lapsedStudent, w.outsider]) {
        await expectServiceError(getSpaceDetail(tx, who, w.page.slug, at(2)), 'NOT_FOUND')
        await expectServiceError(listBoardPosts(tx, who, w.alumniBoard.id, {}, at(2)), 'NOT_FOUND')
        await expectServiceError(listBoardPosts(tx, who, w.lounge.id, {}, at(2)), 'NOT_FOUND')
        await expectServiceError(getPost(tx, who, post.id, at(2)), 'NOT_FOUND')
        expect((await listMySpaces(tx, who)).items.map((s) => s.slug)).not.toContain(w.page.slug)
      }
    })
  })

  it('flag off: media routes 404, posts carry no media, and reading falls back to active affiliations only', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const { post, mediaId } = await loungePostWithImage(tx, w)
      const seenOn = (await getPost(tx, w.reader, post.id, at(3))).lounge!.items[0]!
      setFeatureEnvForTesting(null)
      expect((await getPost(tx, w.reader, post.id, at(3))).lounge).toBeUndefined()
      await expectServiceError(requestLoungeMediaUpload(tx, w.author, post.id, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }, at(3)), 'NOT_FOUND')
      await expectServiceError(uploadLoungeMedia(tx, storage, w.author, post.id, mediaId, Readable.from([JPEG_GPS]), {}, at(3)), 'NOT_FOUND')
      await expectServiceError(openLoungeMedia(tx, storage, w.reader, post.id, mediaId, query(seenOn.url!), at(3)), 'NOT_FOUND')
      await expectServiceError(deleteLoungeMedia(tx, storage, w.author, post.id, mediaId, at(3)), 'NOT_FOUND')
      // 졸업생 인증 이력만 있는 사람은 기존처럼 404, active 인증은 그대로.
      await expectServiceError(getSpaceDetail(tx, w.graduate, w.page.slug, at(3)), 'NOT_FOUND')
      await expectServiceError(listBoardPosts(tx, w.graduate, w.alumniBoard.id, {}, at(3)), 'NOT_FOUND')
      await expectServiceError(getPost(tx, w.graduate, post.id, at(3)), 'NOT_FOUND')
      expect((await listMySpaces(tx, w.graduate)).items).toEqual([])
      expect((await getSpaceDetail(tx, w.reader, w.page.slug, at(3))).access).toBe('member')
      // 행·파일은 남아 다시 켜면 보입니다.
      setFeatureEnvForTesting(ON)
      expect((await getPost(tx, w.reader, post.id, at(4))).lounge!.items.map((m) => m.id)).toEqual([mediaId])
    })
  })
})
