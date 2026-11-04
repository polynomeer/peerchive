/**
 * A-02 동문회·OB 방의 일정·참석·공지 읽음·투표·앨범 (DELIVERY_PLAN §4.3 A-02·§5.3 W, SYSTEM_DESIGN §6.7.2·§8.4, ADR 0039).
 * 플래그·alumni 방·멤버만(404), 회차별 응답 유일, 응답자 목록은 멤버만(익명 방은 수만), 공지 읽음은 수만(누가 읽었는지 0건 — 방장 포함),
 * 투표는 집계만·한 번만·마감 뒤 거부, 앨범은 검사·EXIF 제거·짧은 서명 URL·멤버만, 나가기·내보내기 시 응답·읽음·표 삭제.
 * 각 테스트는 rollback 트랜잭션 안에서 돕니다. 검사기는 clamav 대신 형식 판별만 하는 검사기(createSignatureOnlyScanner)를 씁니다.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { auditEvents, eq, noticeReads, operators, outboxEvents, roomAlbumPhotos, roomEventRsvps, roomPollVotes, roomPolls, type DbExecutor } from '@peerchive/db'
import { ALBUM_PHOTO_SCAN_QUEUE, createFilesystemStorage, createSignatureOnlyScanner, readAll, scanAlbumPhoto, type ObjectStorage } from '@peerchive/files'
import { createSchool } from '../server/modules/catalog/catalog'
import { changeMemberRole, joinSpace, leaveSpace, removeMember } from '../server/modules/community/memberships'
import { markNoticeRead } from '../server/modules/community/notice-reads'
import { createPost, getPost } from '../server/modules/community/posts'
import { deleteAlbumPhoto, getAlbum, openAlbumPhoto, requestAlbumUpload, uploadAlbumPhoto } from '../server/modules/community/room-album'
import { cancelRoomEvent, createRoomEvent, listEventRespondents, listRoomEvents, respondToEvent, updateRoomEvent } from '../server/modules/community/room-events'
import { closeRoomPoll, createRoomPoll, listRoomPolls, voteOnPoll } from '../server/modules/community/room-polls'
import { putMyRoomProfile } from '../server/modules/community/room-profiles'
import { createRoom } from '../server/modules/community/spaces'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { updateRealName } from '../server/modules/identity/profiles'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-01T03:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const ON = { PEERCHIVE_FEATURE_P2_ALUMNI: 'on' }
const scanner = createSignatureOnlyScanner()

// GPS·방향이 든 EXIF를 붙인 1×1 JPEG(metadata.integration.test.ts와 같은 표본).
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

async function world(tx: DbExecutor) {
  const op = await createUser(tx)
  await tx.insert(operators).values({ userId: op.id })
  const school = await createSchool(tx, { userId: op.id }, { name: `모임대${crypto.randomUUID().slice(0, 8)}`, confirmNew: true }, T0)
  const person = async (label: string) => {
    const u = await createUser(tx, { displayName: `계정${label}` })
    await verifiedAffiliation(tx, u.id, school.id, { standing: 'alumni' })
    await updateRealName(tx, { userId: u.id }, { realName: `실명${label}` })
    await insertDisplayPersona(tx, u.id, `페르소나${label}`)
    return { userId: u.id }
  }
  return {
    op: { userId: op.id },
    owner: await person('방장'),
    admin: await person('운영진'),
    moderator: await person('모더'),
    member: await person('멤버'),
    member2: await person('멤버둘'),
    outsider: await person('밖'),
  }
}
type World = Awaited<ReturnType<typeof world>>

async function room(tx: DbExecutor, w: World, nameMode: 'real' | 'display' | 'anonymous', template: 'alumni' | 'general' = 'alumni') {
  const r = await createRoom(tx, w.owner, { name: `모임 ${nameMode} ${crypto.randomUUID().slice(0, 6)}`, nameMode, joinPolicy: 'open', template }, T0)
  for (const p of [w.admin, w.moderator, w.member, w.member2]) await joinSpace(tx, p, r.slug, T0)
  await changeMemberRole(tx, w.owner, r.slug, w.admin.userId, { role: 'admin' }, T0)
  await changeMemberRole(tx, w.owner, r.slug, w.moderator.userId, { role: 'moderator' }, T0)
  return r
}

/** 사람을 가리킬 수 있는 값(사람 id·계정 표시 이름·실명·페르소나 이름). */
function identities(w: World, labels = ['방장', '운영진', '모더', '멤버', '멤버둘']) {
  return [
    ...[w.owner, w.admin, w.moderator, w.member, w.member2].map((p) => p.userId),
    ...labels.flatMap((l) => [`계정${l}`, `실명${l}`, `페르소나${l}`]),
  ]
}

describe.skipIf(!databaseUrl)('A-02 alumni room events, notice reads, polls and album (PostgreSQL)', () => {
  let root: string
  let storage: ObjectStorage
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-alumni-album-'))
    storage = createFilesystemStorage(root)
  })
  afterAll(async () => {
    await closeTestDb()
    await rm(root, { recursive: true, force: true })
  })
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('flag off → every A-02 service is 404; general rooms and non-members (operators too) get 404; alumni rooms get a notice board', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const r = await room(tx, w, 'display')
      expect(r.boards.map((b) => b.kind)).toEqual(['general', 'notice'])
      const ev = await createRoomEvent(tx, w.owner, r.slug, { title: '홈커밍', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
      const poll = await createRoomPoll(tx, w.owner, r.slug, { question: '장소', options: ['강남', '신촌'], closesAt: at(60 * 24).toISOString() }, at(1))
      const notice = await createPost(tx, w.owner, r.boards[1]!.id, { title: '공지', body: '본문' }, at(1))

      setFeatureEnvForTesting({})
      await expectServiceError(listRoomEvents(tx, w.member, r.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(createRoomEvent(tx, w.owner, r.slug, { title: 'x', startsAt: '2026-11-20T19:00:00+09:00' }, at(2)), 'NOT_FOUND')
      await expectServiceError(respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-20', response: 'going' }, at(2)), 'NOT_FOUND')
      await expectServiceError(listEventRespondents(tx, w.member, r.slug, ev.id, { date: '2026-11-20' }, at(2)), 'NOT_FOUND')
      await expectServiceError(listRoomPolls(tx, w.member, r.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(voteOnPoll(tx, w.member, r.slug, poll.id, { optionIndex: 0 }, at(2)), 'NOT_FOUND')
      await expectServiceError(getAlbum(tx, w.member, r.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(requestAlbumUpload(tx, w.member, r.slug, { declaredType: 'image/png', fileName: 'a.png', byteSize: 10 }, at(2)), 'NOT_FOUND')
      await expectServiceError(markNoticeRead(tx, w.member, notice.id, at(2)), 'NOT_FOUND')
      expect((await getPost(tx, w.member, notice.id, at(2))).noticeReads).toBeUndefined()

      setFeatureEnvForTesting(ON)
      const general = await room(tx, w, 'display', 'general')
      expect(general.boards.map((b) => b.kind)).toEqual(['general'])
      await expectServiceError(listRoomEvents(tx, w.owner, general.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(listRoomPolls(tx, w.owner, general.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(getAlbum(tx, w.owner, general.slug, at(2)), 'NOT_FOUND')
      for (const who of [w.outsider, w.op]) {
        await expectServiceError(listRoomEvents(tx, who, r.slug, at(2)), 'NOT_FOUND')
        await expectServiceError(listEventRespondents(tx, who, r.slug, ev.id, { date: '2026-11-20' }, at(2)), 'NOT_FOUND')
        await expectServiceError(listRoomPolls(tx, who, r.slug, at(2)), 'NOT_FOUND')
        await expectServiceError(getAlbum(tx, who, r.slug, at(2)), 'NOT_FOUND')
        await expectServiceError(markNoticeRead(tx, who, notice.id, at(2)), 'NOT_FOUND')
      }
    })
  })

  it('events: only owner/admin create; RSVP is unique per (occurrence, member) and per-occurrence; respondent names are member-only room names', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const r = await room(tx, w, 'display')
      await putMyRoomProfile(tx, w.member, r.slug, { displayName: '12기 김지민', badges: ['ob'] }, at(1))
      await expectServiceError(createRoomEvent(tx, w.member, r.slug, { title: 'x', startsAt: '2026-11-06T19:00:00+09:00' }, at(1)), 'FORBIDDEN')
      await expectServiceError(createRoomEvent(tx, w.moderator, r.slug, { title: 'x', startsAt: '2026-11-06T19:00:00+09:00' }, at(1)), 'FORBIDDEN')
      expect(
        (await expectServiceError(createRoomEvent(tx, w.owner, r.slug, { title: '정기 모임', startsAt: '2026-11-06T19:00:00+09:00', recurrence: 'weekly' }, at(1)), 'VALIDATION')).fields,
      ).toMatchObject({ repeatUntil: 'required' })
      const ev = await createRoomEvent(
        tx,
        w.admin,
        r.slug,
        { title: '정기 모임', locationText: '학생회관', startsAt: '2026-11-06T19:00:00+09:00', endsAt: '2026-11-06T21:00:00+09:00', recurrence: 'weekly', repeatUntil: '2026-11-27' },
        at(1),
      )
      expect(ev.occurrences.map((o) => o.date)).toEqual(['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27'])

      await respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-06', response: 'going' }, at(2))
      const changed = await respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-06', response: 'maybe' }, at(3))
      expect(changed.occurrences[0]).toMatchObject({ date: '2026-11-06', myResponse: 'maybe', counts: { going: 0, not_going: 0, maybe: 1 } })
      await respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-13', response: 'not_going' }, at(3))
      await respondToEvent(tx, w.member2, r.slug, ev.id, { date: '2026-11-06', response: 'going' }, at(3))
      const rows = await tx.select().from(roomEventRsvps).where(eq(roomEventRsvps.eventId, ev.id))
      expect(rows.filter((x) => x.userId === w.member.userId).map((x) => [x.occurrenceDate, x.response]).sort()).toEqual([
        ['2026-11-06', 'maybe'],
        ['2026-11-13', 'not_going'],
      ])
      // 같은 (일정, 회차, 사람) 두 번째 행은 DB가 거부합니다.
      await expect(tx.transaction((inner) => inner.insert(roomEventRsvps).values({ eventId: ev.id, occurrenceDate: '2026-11-06', userId: w.member.userId, response: 'going' }))).rejects.toThrow()
      // 규칙에 없는 날짜·형식은 404, 응답 값 422.
      await expectServiceError(respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-07', response: 'going' }, at(3)), 'NOT_FOUND')
      await expectServiceError(respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-13', response: 'yes' }, at(3)), 'VALIDATION')
      // 응답 지우기.
      const cleared = await respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-13', response: null }, at(4))
      expect(cleared.occurrences[1]).toMatchObject({ myResponse: null, counts: { not_going: 0 } })

      const respondents = await listEventRespondents(tx, w.member2, r.slug, ev.id, { date: '2026-11-06' }, at(4))
      expect(respondents).toMatchObject({ namesHidden: false, groups: { going: { count: 1, names: ['방별 이름 없음'] }, maybe: { count: 1, names: ['12기 김지민'] } } })
      const json = JSON.stringify([respondents, await listRoomEvents(tx, w.member2, r.slug, at(4))])
      for (const v of identities(w)) expect(json).not.toContain(v)
      await expectServiceError(listEventRespondents(tx, w.outsider, r.slug, ev.id, { date: '2026-11-06' }, at(4)), 'NOT_FOUND')
      await expectServiceError(listEventRespondents(tx, w.member, r.slug, ev.id, { date: '2026-11-08' }, at(4)), 'NOT_FOUND')

      // 시작한 회차·취소한 일정에는 응답 409.
      await expectServiceError(respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-06', response: 'going' }, new Date('2026-11-06T10:00:00Z')), 'CONFLICT', 'occurrence_started')
      // 시각·반복은 바꾸지 않음, 제목은 방장·운영진이 바꿈.
      expect((await expectServiceError(updateRoomEvent(tx, w.owner, r.slug, ev.id, { startsAt: '2026-11-07T19:00:00+09:00' }, at(5)), 'VALIDATION')).fields).toEqual({ startsAt: 'schedule_fixed' })
      await expectServiceError(updateRoomEvent(tx, w.member, r.slug, ev.id, { title: '바꿈' }, at(5)), 'FORBIDDEN')
      expect((await updateRoomEvent(tx, w.owner, r.slug, ev.id, { title: '정기 모임(장소 변경)' }, at(5))).title).toBe('정기 모임(장소 변경)')
      await expectServiceError(cancelRoomEvent(tx, w.member, r.slug, ev.id, at(5)), 'FORBIDDEN')
      expect((await cancelRoomEvent(tx, w.owner, r.slug, ev.id, at(5))).status).toBe('cancelled')
      await expectServiceError(respondToEvent(tx, w.member, r.slug, ev.id, { date: '2026-11-20', response: 'going' }, at(6)), 'CONFLICT', 'event_cancelled')
      // 감사 기록은 id·종류만(제목 값 없음).
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'community.room_event_create'))
      expect(JSON.stringify(audits)).not.toContain('정기 모임')
    })
  })

  it('respondent lists: real rooms show the real name; anonymous rooms show counts only', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const real = await room(tx, w, 'real')
      const ev = await createRoomEvent(tx, w.owner, real.slug, { title: '홈커밍', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
      await respondToEvent(tx, w.member, real.slug, ev.id, { date: '2026-11-20', response: 'going' }, at(2))
      expect((await listEventRespondents(tx, w.admin, real.slug, ev.id, { date: '2026-11-20' }, at(2))).groups.going).toEqual({ count: 1, names: ['실명멤버'] })

      const anon = await room(tx, w, 'anonymous')
      const ev2 = await createRoomEvent(tx, w.owner, anon.slug, { title: '익명 모임', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
      await respondToEvent(tx, w.member, anon.slug, ev2.id, { date: '2026-11-20', response: 'going' }, at(2))
      await respondToEvent(tx, w.member2, anon.slug, ev2.id, { date: '2026-11-20', response: 'maybe' }, at(2))
      const list = await listEventRespondents(tx, w.owner, anon.slug, ev2.id, { date: '2026-11-20' }, at(2))
      expect(list).toEqual({ eventId: ev2.id, date: '2026-11-20', namesHidden: true, groups: { going: { count: 1, names: [] }, not_going: { count: 0, names: [] }, maybe: { count: 1, names: [] } } })
      expect((await listRoomEvents(tx, w.owner, anon.slug, at(2))).namesHidden).toBe(true)
    })
  })

  it('notice reads: idempotent per member, only the count (and my own flag) is returned — never who read, not even to staff', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const r = await room(tx, w, 'real')
      const noticeBoard = r.boards.find((b) => b.kind === 'notice')!
      const general = r.boards.find((b) => b.kind === 'general')!
      await expectServiceError(createPost(tx, w.member, noticeBoard.id, { title: '멤버 공지', body: 'x' }, at(1)), 'FORBIDDEN')
      const notice = await createPost(tx, w.admin, noticeBoard.id, { title: '홈커밍 안내', body: '본문' }, at(1))
      expect(notice.noticeReads).toEqual({ count: 0, readByMe: false })

      const outputs: unknown[] = []
      outputs.push(await markNoticeRead(tx, w.member, notice.id, at(2)))
      outputs.push(await markNoticeRead(tx, w.member, notice.id, at(3)))
      expect(outputs[1]).toEqual({ count: 1, readByMe: true })
      outputs.push(await markNoticeRead(tx, w.member2, notice.id, at(3)))
      expect(await tx.select().from(noticeReads).where(eq(noticeReads.postId, notice.id))).toHaveLength(2)
      for (const viewer of [w.owner, w.admin, w.moderator, w.member, w.member2]) {
        const p = await getPost(tx, viewer, notice.id, at(4))
        expect(p.noticeReads).toEqual({ count: 2, readByMe: viewer === w.member || viewer === w.member2 })
        outputs.push(p)
      }
      // 응답 어디에도 읽은 사람의 id·이름이 없습니다(글쓴이인 운영진의 이름은 글 작성자로 보이므로 제외).
      const json = JSON.stringify(outputs)
      for (const v of identities(w, ['방장', '모더', '멤버', '멤버둘'])) expect(json).not.toContain(v)
      expect(json).not.toContain(w.admin.userId)

      // 공지 게시판이 아닌 글·일반 방의 공지는 읽음 표시 대상이 아님(404), 상세에 읽음 수 없음.
      const post = await createPost(tx, w.member, general.id, { title: '일반 글', body: 'x' }, at(4))
      await expectServiceError(markNoticeRead(tx, w.member2, post.id, at(5)), 'NOT_FOUND')
      expect((await getPost(tx, w.member2, post.id, at(5))).noticeReads).toBeUndefined()
      const plain = await room(tx, w, 'real', 'general')
      expect(plain.boards.some((b) => b.kind === 'notice')).toBe(false)
    })
  })

  it('polls: aggregates only (no per-voter data for anyone), one vote per member, closed polls reject votes', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const r = await room(tx, w, 'display')
      await expectServiceError(createRoomPoll(tx, w.member, r.slug, { question: '장소', options: ['a', 'b'], closesAt: at(120).toISOString() }, at(1)), 'FORBIDDEN')
      const poll = await createRoomPoll(tx, w.owner, r.slug, { question: '홈커밍 장소', options: ['강남', '신촌', '학교'], closesAt: at(120).toISOString() }, at(1))
      const outputs: unknown[] = [poll]
      outputs.push(await voteOnPoll(tx, w.member, r.slug, poll.id, { optionIndex: 1 }, at(2)))
      await expectServiceError(voteOnPoll(tx, w.member, r.slug, poll.id, { optionIndex: 0 }, at(3)), 'CONFLICT', 'already_voted')
      await expectServiceError(voteOnPoll(tx, w.member2, r.slug, poll.id, { optionIndex: 3 }, at(3)), 'VALIDATION')
      outputs.push(await voteOnPoll(tx, w.member2, r.slug, poll.id, { optionIndex: 1 }, at(3)))
      outputs.push(await voteOnPoll(tx, w.admin, r.slug, poll.id, { optionIndex: 2 }, at(3)))
      expect(await tx.select().from(roomPollVotes).where(eq(roomPollVotes.pollId, poll.id))).toHaveLength(3)
      const ownerView = await listRoomPolls(tx, w.owner, r.slug, at(4))
      outputs.push(ownerView)
      expect(ownerView.polls[0]).toMatchObject({
        totalVotes: 3,
        options: [
          { index: 0, label: '강남', count: 0 },
          { index: 1, label: '신촌', count: 2 },
          { index: 2, label: '학교', count: 1 },
        ],
        myVote: null,
        canVote: true,
        canClose: true,
      })
      expect((await listRoomPolls(tx, w.member, r.slug, at(4))).polls[0]).toMatchObject({ myVote: 1, canVote: false, canClose: false })
      const json = JSON.stringify(outputs)
      for (const v of identities(w)) expect(json).not.toContain(v)

      // 마감: 시각이 지나거나 방장·운영진이 일찍 마감하면 거부.
      await expectServiceError(voteOnPoll(tx, w.moderator, r.slug, poll.id, { optionIndex: 0 }, at(121)), 'CONFLICT', 'poll_closed')
      await expectServiceError(closeRoomPoll(tx, w.member, r.slug, poll.id, at(5)), 'FORBIDDEN')
      const closed = await closeRoomPoll(tx, w.admin, r.slug, poll.id, at(5))
      expect(closed).toMatchObject({ open: false, canVote: false, totalVotes: 3 })
      await expectServiceError(voteOnPoll(tx, w.moderator, r.slug, poll.id, { optionIndex: 0 }, at(6)), 'CONFLICT', 'poll_closed')
      // 감사 기록에는 투표 id·개수만(질문·선택지·투표한 사람 없음), 투표 자체는 남기지 않음.
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.actorId, w.member.userId))
      expect(audits.filter((a) => a.action.startsWith('community.room_poll'))).toHaveLength(0)
      expect(JSON.stringify(await tx.select().from(auditEvents).where(eq(auditEvents.action, 'community.room_poll_create')))).not.toContain('신촌')
    })
  })

  it('album: upload goes through the scan pipeline, EXIF/GPS is stripped, signed URLs are short-lived and only for that member', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const r = await room(tx, w, 'display')
      expect(
        (await expectServiceError(requestAlbumUpload(tx, w.member, r.slug, { declaredType: 'application/pdf', fileName: 'a.pdf', byteSize: 10 }, at(1)), 'VALIDATION')).fields,
      ).toEqual({ declaredType: 'unsupported_type' })
      const req = await requestAlbumUpload(tx, w.member, r.slug, { declaredType: 'image/jpeg', fileName: '김지민_홈커밍.jpg', byteSize: JPEG_GPS.length, caption: '홈커밍' }, at(1))
      expect(req.photo).toMatchObject({ scanStatus: 'pending', url: null, mine: true })
      expect(JSON.stringify(req)).not.toContain('김지민')
      await expectServiceError(uploadAlbumPhoto(tx, storage, w.member2, r.slug, req.photo.id, Readable.from([JPEG_GPS]), {}, at(2)), 'NOT_FOUND')
      await uploadAlbumPhoto(tx, storage, w.member, r.slug, req.photo.id, Readable.from([JPEG_GPS]), { contentLength: JPEG_GPS.length }, at(2))
      await expectServiceError(uploadAlbumPhoto(tx, storage, w.member, r.slug, req.photo.id, Readable.from([JPEG_GPS]), {}, at(2)), 'CONFLICT', 'already_uploaded')
      const [outbox] = await tx.select().from(outboxEvents).where(eq(outboxEvents.topic, ALBUM_PHOTO_SCAN_QUEUE)).orderBy(outboxEvents.createdAt)
      expect(outbox?.payload).toMatchObject({ photoId: req.photo.id })
      // 검사 전: 다른 멤버에게 보이지 않고, 올린 사람에게도 URL이 없음.
      expect((await getAlbum(tx, w.member2, r.slug, at(3))).photos).toHaveLength(0)
      expect((await getAlbum(tx, w.member, r.slug, at(3))).photos[0]).toMatchObject({ scanStatus: 'pending', url: null })

      expect(await scanAlbumPhoto(tx, { storage, scanner }, req.photo.id)).toEqual({ status: 'clean' })
      const [row] = await tx.select().from(roomAlbumPhotos).where(eq(roomAlbumPhotos.id, req.photo.id))
      expect(row).toMatchObject({ scanStatus: 'clean', metadataStripped: true, mediaType: 'image/jpeg' })
      const stored = await readAll(await storage.get(row!.objectKey as `quarantine/${string}`))
      expect(stored.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false)
      expect(stored.length).toBeLessThan(JPEG_GPS.length) // GPS IFD를 뺀 내용(방향만 남김)

      const album = await getAlbum(tx, w.member2, r.slug, at(4))
      const photo = album.photos[0]!
      expect(photo).toMatchObject({ mine: false, caption: '홈커밍', canDelete: false })
      expect(Date.parse(photo.urlExpiresAt!) - at(4).getTime()).toBe(5 * 60 * 1000)
      const q = Object.fromEntries(new URL(photo.url!, 'http://x').searchParams)
      const file = await openAlbumPhoto(tx, storage, w.member2, r.slug, photo.id, q, at(5))
      expect(file.mediaType).toBe('image/jpeg')
      expect((await readAll(file.stream)).includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false)
      // 다른 멤버가 같은 URL을 쓰거나, 만료됐거나, 서명이 틀리거나, 멤버가 아니면 404.
      await expectServiceError(openAlbumPhoto(tx, storage, w.member, r.slug, photo.id, q, at(5)), 'NOT_FOUND')
      await expectServiceError(openAlbumPhoto(tx, storage, w.member2, r.slug, photo.id, q, at(10)), 'NOT_FOUND')
      await expectServiceError(openAlbumPhoto(tx, storage, w.member2, r.slug, photo.id, { exp: q.exp, sig: '0'.repeat(64) }, at(5)), 'NOT_FOUND')
      await expectServiceError(openAlbumPhoto(tx, storage, w.outsider, r.slug, photo.id, q, at(5)), 'NOT_FOUND')
      await expectServiceError(getAlbum(tx, w.outsider, r.slug, at(5)), 'NOT_FOUND')
      expect(JSON.stringify(album)).not.toContain(w.member.userId)

      // 이미지가 아닌 내용은 격리되고 다른 멤버에게 보이지 않음.
      const html = Buffer.from('<html><script>alert(1)</script></html>')
      const bad = await requestAlbumUpload(tx, w.member2, r.slug, { declaredType: 'image/png', fileName: 'x.png', byteSize: html.length }, at(6))
      await uploadAlbumPhoto(tx, storage, w.member2, r.slug, bad.photo.id, Readable.from([html]), {}, at(6))
      expect((await scanAlbumPhoto(tx, { storage, scanner }, bad.photo.id)).status).toBe('quarantined')
      expect((await getAlbum(tx, w.member, r.slug, at(7))).photos.map((p) => p.id)).toEqual([photo.id])
      expect((await getAlbum(tx, w.member2, r.slug, at(7))).photos.find((p) => p.id === bad.photo.id)).toMatchObject({ scanStatus: 'quarantined', url: null })

      // 지우기: 다른 멤버 403, 방장·운영진은 지울 수 있고 파일도 지움.
      await expectServiceError(deleteAlbumPhoto(tx, storage, w.member2, r.slug, photo.id, at(8)), 'FORBIDDEN')
      await deleteAlbumPhoto(tx, storage, w.admin, r.slug, photo.id, at(8))
      expect(await storage.head(row!.objectKey as `quarantine/${string}`)).toBeNull()
      expect((await getAlbum(tx, w.member, r.slug, at(9))).photos).toHaveLength(0)
      // 15분이 지나면 내용을 받지 않음.
      const late = await requestAlbumUpload(tx, w.member, r.slug, { declaredType: 'image/jpeg', fileName: 'b.jpg', byteSize: JPEG_GPS.length }, at(10))
      await expectServiceError(uploadAlbumPhoto(tx, storage, w.member, r.slug, late.photo.id, Readable.from([JPEG_GPS]), {}, at(26)), 'GONE', 'upload_expired')
    })
  })

  // ADR 0060 D-03: 마감한 투표의 결과는 고정됩니다.
  it('closed polls keep their frozen tally when votes are removed; open polls stay live', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const r = await room(tx, w, 'display')
      const poll = (question: string, closesAt: Date) => createRoomPoll(tx, w.owner, r.slug, { question, options: ['a', 'b', 'c'], closesAt: closesAt.toISOString() }, at(1))
      const early = await poll('일찍 마감', at(100))
      const timed = await poll('시간 마감', at(10))
      const open = await poll('열림', at(1000))
      for (const p of [early, timed, open]) {
        await voteOnPoll(tx, w.member, r.slug, p.id, { optionIndex: 1 }, at(2))
        await voteOnPoll(tx, w.member2, r.slug, p.id, { optionIndex: 1 }, at(2))
        await voteOnPoll(tx, w.admin, r.slug, p.id, { optionIndex: 2 }, at(2))
      }
      const tally = async (id: string) => (await tx.select({ t: roomPolls.finalTally }).from(roomPolls).where(eq(roomPolls.id, id)))[0]!.t
      const counts = async (id: string, now: Date, viewer = w.owner) => (await listRoomPolls(tx, viewer, r.slug, now)).polls.find((p) => p.id === id)!.options.map((o) => o.count)

      // 일찍 마감: 바로 고정. 시간 마감: 아직 읽거나 지운 적이 없어 비어 있음.
      await closeRoomPoll(tx, w.owner, r.slug, early.id, at(3))
      expect(await tally(early.id)).toEqual([0, 2, 1])
      expect(await tally(timed.id)).toBeNull()
      expect(await tally(open.id)).toBeNull()

      // 시간 마감 뒤 아무도 읽기 전에 나가도 나가기가 먼저 고정합니다. 열린 투표만 줄어듭니다.
      await leaveSpace(tx, w.member, r.slug, at(20))
      expect(await tally(timed.id)).toEqual([0, 2, 1])
      expect(await counts(early.id, at(21))).toEqual([0, 2, 1])
      expect(await counts(timed.id, at(21))).toEqual([0, 2, 1])
      expect(await counts(open.id, at(21))).toEqual([0, 1, 1])
      await removeMember(tx, w.owner, r.slug, w.member2.userId, at(22))
      expect(await tally(open.id)).toBeNull()
      expect(await counts(open.id, at(23))).toEqual([0, 0, 1])
      expect(await counts(early.id, at(23))).toEqual([0, 2, 1])
      expect(await tx.select().from(roomPollVotes).where(eq(roomPollVotes.pollId, timed.id))).toHaveLength(1)

      // 마감 시각이 지난 투표를 처음 읽을 때도 고정합니다. 그 뒤에는 값이 바뀌지 않고, 고정한 투표는 표를 받지 않습니다.
      expect(await counts(open.id, at(2000))).toEqual([0, 0, 1])
      expect(await tally(open.id)).toEqual([0, 0, 1])
      await tx.delete(roomPollVotes).where(eq(roomPollVotes.pollId, open.id))
      expect(await counts(open.id, at(2001))).toEqual([0, 0, 1])
      await expectServiceError(voteOnPoll(tx, w.moderator, r.slug, open.id, { optionIndex: 0 }, at(30)), 'CONFLICT', 'poll_closed')
      // 응답에는 수만 있고 사람 키가 없습니다.
      const json = JSON.stringify(await listRoomPolls(tx, w.owner, r.slug, at(2002)))
      expect(json).not.toContain(w.admin.userId)
      expect(json).not.toContain('userId')
    })
  })

  it('leaving or being removed deletes that member\'s RSVPs, notice read markers and poll votes (counts adjust); their album photos stay', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const r = await room(tx, w, 'display')
      const ev = await createRoomEvent(tx, w.owner, r.slug, { title: '홈커밍', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
      const notice = await createPost(tx, w.owner, r.boards[1]!.id, { title: '공지', body: '본문' }, at(1))
      const poll = await createRoomPoll(tx, w.owner, r.slug, { question: '장소', options: ['a', 'b'], closesAt: at(120).toISOString() }, at(1))
      const photo = await requestAlbumUpload(tx, w.member, r.slug, { declaredType: 'image/jpeg', fileName: 'a.jpg', byteSize: JPEG_GPS.length }, at(1))
      await uploadAlbumPhoto(tx, storage, w.member, r.slug, photo.photo.id, Readable.from([JPEG_GPS]), {}, at(1))
      await scanAlbumPhoto(tx, { storage, scanner }, photo.photo.id)
      for (const p of [w.member, w.member2]) {
        await respondToEvent(tx, p, r.slug, ev.id, { date: '2026-11-20', response: 'going' }, at(2))
        await markNoticeRead(tx, p, notice.id, at(2))
        await voteOnPoll(tx, p, r.slug, poll.id, { optionIndex: 0 }, at(2))
      }
      expect((await getPost(tx, w.owner, notice.id, at(3))).noticeReads?.count).toBe(2)

      await leaveSpace(tx, w.member, r.slug, at(3))
      await removeMember(tx, w.owner, r.slug, w.member2.userId, at(3))
      for (const p of [w.member, w.member2]) {
        expect(await tx.select().from(roomEventRsvps).where(eq(roomEventRsvps.userId, p.userId))).toHaveLength(0)
        expect(await tx.select().from(noticeReads).where(eq(noticeReads.userId, p.userId))).toHaveLength(0)
        expect(await tx.select().from(roomPollVotes).where(eq(roomPollVotes.userId, p.userId))).toHaveLength(0)
      }
      expect((await getPost(tx, w.owner, notice.id, at(4))).noticeReads?.count).toBe(0)
      expect((await listRoomPolls(tx, w.owner, r.slug, at(4))).polls[0]!.totalVotes).toBe(0)
      expect((await listRoomEvents(tx, w.owner, r.slug, at(4))).events[0]!.occurrences[0]!.counts.going).toBe(0)
      // 앨범 사진은 방의 기록으로 남고, 나간 사람은 더 볼 수 없음.
      expect((await getAlbum(tx, w.owner, r.slug, at(4))).photos.map((p) => p.id)).toEqual([photo.photo.id])
      await expectServiceError(getAlbum(tx, w.member, r.slug, at(4)), 'NOT_FOUND')
    })
  })
})
