/**
 * A-07 운영·계측 통합 테스트(DELIVERY_PLAN §4.3 A-07·§6.2 P2, ADR 0045).
 *
 * - 방 항목 신고: 명부 항목·일정·투표·앨범 사진·방별 프로필마다 신고 → 운영자 대기열·상세(주인 id·계정 이름 없음) → `hide_room_item` →
 *   다른 멤버 화면에서 빠짐(본인에게는 숨김 표시) → 당사자 안내·이의제기 되돌림으로 다시 보임. 멤버 아님·플래그 꺼짐 404.
 * - 소속·기수 사칭 사유: 명부·방별 프로필·글·댓글·회고에만(일정·투표·사진·페르소나 422), 소속 표시 익명 토픽 글 신고의 운영자 상세에 작성자 없음.
 * - 인증 수단별 처리 큐: 수단별 묶음·나이·기한, 수료증 처리 시간(받은 시각 → 결정) 중앙값·p90 5건 미만 가림, 운영자만·플래그.
 * - §6.2 P2 이벤트: 사용자 키·시 단위 시각, 익명 방·소속 표시 익명은 키 없음, 수집 거부, 페르소나·방·사람 id 없음. P2 지표: 꺼진 영역 null·5 미만 null.
 * 각 테스트는 rollback 트랜잭션 안에서 돕니다.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { institutionNameKey } from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  auditEvents,
  certificateChecks,
  cohortApprovals,
  eq,
  gte,
  hashSubject,
  institutionAffiliations,
  isNull,
  lt,
  operators,
  roomAlbumPhotos,
  schools,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { createFilesystemStorage, readAll, type ObjectStorage } from '@peerchive/files'
import { analyticsPepper, setAnalyticsEnvForTesting, setAnalyticsOptOut } from '../server/modules/analytics/analytics'
import { createSchool } from '../server/modules/catalog/catalog'
import { listDirectory, putMyDirectoryEntry, withdrawMyDirectoryEntry } from '../server/modules/community/member-directory'
import { changeMemberRole, joinSpace } from '../server/modules/community/memberships'
import { getP2Metrics } from '../server/modules/community/ops-metrics'
import { createPost } from '../server/modules/community/posts'
import { getAlbum, openAlbumPhoto } from '../server/modules/community/room-album'
import { createRoomEvent, listRoomEvents, respondToEvent } from '../server/modules/community/room-events'
import { openOperatorAlbumPhoto } from '../server/modules/community/room-item-reports'
import { createRoomPoll, listRoomPolls, voteOnPoll } from '../server/modules/community/room-polls'
import { listRoomProfiles, putMyRoomProfile } from '../server/modules/community/room-profiles'
import { createRoom } from '../server/modules/community/spaces'
import { createTopic } from '../server/modules/community/topics'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { updateRealName } from '../server/modules/identity/profiles'
import { getVerificationQueue, setCertificateSlaHoursForTesting } from '../server/modules/institutions/verification-queue'
import { createAppeal, listMyModerationNotices } from '../server/modules/moderation/notices'
import { decideAppeal, getReportDetail, listReportGroups, resolveReport } from '../server/modules/moderation/operator'
import { createReport } from '../server/modules/moderation/reports'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, verifiedAffiliation, withRollback } from './helpers'
import type { RoomItemKind } from '../shared/types/api'

const T0 = new Date('2026-11-01T03:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const HOUR = 60 * 60 * 1000
const ALL_ON = { PEERCHIVE_FEATURE_P2_ALUMNI: 'on', PEERCHIVE_FEATURE_P2_TOPICS: 'on', PEERCHIVE_FEATURE_P2_INSTITUTIONS: 'on' }
const PEPPER = { NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'a07-p2-analytics-pepper-for-tests-0123456789abcdef' }
const DB_TIMEOUT = 90_000
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64')

let root = ''
let storage: ObjectStorage

async function world(tx: DbExecutor) {
  const op = await createUser(tx, { displayName: '운영자' })
  await tx.insert(operators).values({ userId: op.id })
  const school = await createSchool(tx, { userId: op.id }, { name: `계측대${rand()}`, confirmNew: true }, T0)
  const person = async (label: string) => {
    const displayName = `계정${label}${rand()}`
    const u = await createUser(tx, { displayName })
    await verifiedAffiliation(tx, u.id, school.id, { standing: 'alumni' })
    await updateRealName(tx, { userId: u.id }, { realName: `실명${label}${rand()}` })
    const persona = await insertDisplayPersona(tx, u.id, `페르소나${label}${rand()}`)
    return { userId: u.id, displayName, personaId: persona.personaId }
  }
  return { op: { userId: op.id }, school, owner: await person('방장'), admin: await person('운영진'), member: await person('멤버'), quiet: await person('조용'), outsider: await person('밖') }
}
type World = Awaited<ReturnType<typeof world>>

async function alumniRoom(tx: DbExecutor, w: World, nameMode: 'real' | 'display' | 'anonymous', minute = 0) {
  const room = await createRoom(tx, w.owner, { name: `동문 ${nameMode} ${rand()}`, nameMode, joinPolicy: 'open', template: 'alumni' }, at(minute))
  for (const p of [w.admin, w.member, w.quiet]) await joinSpace(tx, p, room.slug, at(minute))
  await changeMemberRole(tx, w.owner, room.slug, w.admin.userId, { role: 'admin' }, at(minute))
  return room
}

async function insertCleanPhoto(tx: DbExecutor, spaceId: string, uploaderId: string): Promise<string> {
  const key = `quarantine/${crypto.randomUUID()}` as const
  await storage.put(key, Readable.from([JPEG]), { maxBytes: JPEG.length })
  const [row] = await tx
    .insert(roomAlbumPhotos)
    .values({
      spaceId,
      uploaderId,
      caption: '홈커밍 사진',
      objectKey: key,
      declaredType: 'image/jpeg',
      fileExtension: 'jpg',
      byteSize: JPEG.length,
      uploadedAt: at(1),
      scanStatus: 'clean',
      metadataStripped: true,
      mediaType: 'image/jpeg',
      createdAt: at(1),
    })
    .returning({ id: roomAlbumPhotos.id })
  return row!.id
}

describe.skipIf(!databaseUrl)('A-07 P2 operations and metrics (PostgreSQL)', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-a07-'))
    storage = createFilesystemStorage(root)
  })
  afterAll(async () => {
    setAnalyticsEnvForTesting(null)
    setCertificateSlaHoursForTesting(null)
    await rm(root, { recursive: true, force: true })
    await closeTestDb()
  })
  beforeEach(() => setFeatureEnvForTesting(ALL_ON))
  afterEach(() => {
    setFeatureEnvForTesting(null)
    setAnalyticsEnvForTesting(null)
  })

  it(
    'each room item kind: member report → operator queue (no owner identity) → hide → gone for readers → appeal reverse restores',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx)
        const room = await alumniRoom(tx, w, 'display')
        await putMyRoomProfile(tx, w.member, room.slug, { displayName: '방별멤버', cohortLabel: '12기', bio: '안녕하세요' }, at(1))
        await putMyDirectoryEntry(tx, w.member, room.slug, { consent: true, cohortLabel: '12기', currentWork: '백엔드', contactMethod: '오픈채팅' }, at(1))
        const ev = await createRoomEvent(tx, w.admin, room.slug, { title: '홈커밍', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
        const poll = await createRoomPoll(tx, w.admin, room.slug, { question: '장소', options: ['강남', '신촌'], closesAt: at(60 * 24 * 10).toISOString() }, at(1))
        const spaceId = ((await tx.execute(sql`select id from community_spaces where slug = ${room.slug}`)) as unknown as Array<{ id: string }>)[0]!.id
        const photoId = await insertCleanPhoto(tx, spaceId, w.member.userId)
        const profileId = (await listRoomProfiles(tx, w.member, room.slug, at(1))).mine!.id
        const entryId = (await listDirectory(tx, w.member, room.slug, {}, at(1))).mine!.id

        const visible: Record<RoomItemKind, (viewer: { userId: string }) => Promise<boolean>> = {
          directory_entry: async (v) => (await listDirectory(tx, v, room.slug, {}, at(2))).entries.some((e) => e.id === entryId),
          room_profile: async (v) => (await listRoomProfiles(tx, v, room.slug, at(2))).profiles.some((p) => p.id === profileId),
          event: async (v) => (await listRoomEvents(tx, v, room.slug, at(2))).events.some((e) => e.id === ev.id),
          poll: async (v) => (await listRoomPolls(tx, v, room.slug, at(2))).polls.some((p) => p.id === poll.id),
          album_photo: async (v) => (await getAlbum(tx, v, room.slug, at(2))).photos.some((p) => p.id === photoId),
        }
        const items: Array<{ kind: RoomItemKind; id: string; owner: World['member'] }> = [
          { kind: 'directory_entry', id: entryId, owner: w.member },
          { kind: 'room_profile', id: profileId, owner: w.member },
          { kind: 'event', id: ev.id, owner: w.admin },
          { kind: 'poll', id: poll.id, owner: w.admin },
          { kind: 'album_photo', id: photoId, owner: w.member },
        ]
        // 앨범 서명 URL은 숨기기 전에 받아 둡니다(숨긴 뒤에는 같은 URL도 404).
        const photoUrl = (await getAlbum(tx, w.quiet, room.slug, at(2))).photos.find((p) => p.id === photoId)!.url!
        const photoQuery = Object.fromEntries(new URL(photoUrl, 'http://x').searchParams)

        for (const [i, item] of items.entries()) {
          const ref = { spaceSlug: room.slug, kind: item.kind, itemId: item.id }
          expect(await visible[item.kind](w.quiet), item.kind).toBe(true)
          // 멤버가 아니면 404, 플래그가 꺼지면 404, 형식 오류 422.
          await expectServiceError(createReport(tx, w.outsider, { targetType: 'room_item', targetRef: ref, reason: 'spam' }, at(3)), 'NOT_FOUND')
          setFeatureEnvForTesting({})
          await expectServiceError(createReport(tx, w.quiet, { targetType: 'room_item', targetRef: ref, reason: 'spam' }, at(3)), 'NOT_FOUND')
          setFeatureEnvForTesting(ALL_ON)
          await expectServiceError(createReport(tx, w.quiet, { targetType: 'room_item', targetRef: { ...ref, kind: 'notice' }, reason: 'spam' }, at(3)), 'VALIDATION')

          const receipt = await createReport(tx, w.quiet, { targetType: 'room_item', targetRef: ref, reason: 'harassment', details: '불쾌함' }, at(3 + i))
          expect(receipt.created).toBe(true)
          const groups = await listReportGroups(tx, w.op, { status: 'open' }, at(4 + i))
          const group = groups.find((g) => g.reportId === receipt.id)!
          expect(group).toMatchObject({ targetType: 'room_item' })
          expect(group.targetLabel).toContain(room.name)
          const detail = await getReportDetail(tx, w.op, receipt.id, at(4 + i))
          expect(detail.allowedActions).toEqual(['none', 'hide_room_item'])
          expect(detail.content).toMatchObject({ kind: 'room_item', roomItem: { itemKind: item.kind, hidden: false, space: { slug: room.slug, nameMode: 'display' } } })
          // 운영자 상세에 주인 사용자 id·계정 이름·실명·표시명 페르소나가 없습니다(명부·방별 프로필은 방 멤버에게 보이는 방별 이름만).
          const json = JSON.stringify(detail)
          for (const leak of [item.owner.userId, item.owner.displayName, item.owner.personaId, '실명', '페르소나']) expect(json, `${item.kind} ${leak}`).not.toContain(leak)
          if (item.kind === 'directory_entry' || item.kind === 'room_profile') expect(json).toContain('방별멤버')

          await resolveReport(tx, w.op, receipt.id, { action: 'hide_room_item', note: '내부 메모', publicReason: '방 이용 규칙 위반', notifyOwner: true }, at(5 + i))
          expect(await visible[item.kind](w.quiet), `${item.kind} hidden`).toBe(false)
          await expectServiceError(createReport(tx, w.quiet, { targetType: 'room_item', targetRef: ref, reason: 'spam' }, at(6 + i)), 'NOT_FOUND')
          const notice = (await listMyModerationNotices(tx, item.owner)).find((n) => n.kind === 'hide_room_item' && n.reversedAt === null && n.targetType === 'room_item')!
          expect(notice).toMatchObject({ publicReason: '방 이용 규칙 위반', canAppeal: true })
          expect(notice.ownerPath).toContain(room.slug)
          expect((await listMyModerationNotices(tx, w.quiet)).some((n) => n.actionId === notice.actionId)).toBe(false)
          const appeal = await createAppeal(tx, item.owner, { actionId: notice.actionId, message: '고쳤습니다' }, at(6 + i))
          await decideAppeal(tx, w.op, appeal.id, { decision: 'reverse', note: '확인' }, at(7 + i))
          expect(await visible[item.kind](w.quiet), `${item.kind} restored`).toBe(true)
        }

        // 감사 기록은 대상 id·종류·조치 id뿐(주인 사용자 없음).
        const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetType, 'room_item'), gte(auditEvents.at, new Date(Date.now() - HOUR))))
        expect(audits.map((a) => a.action).sort()).toEqual([...Array(5).fill('moderation.apply'), ...Array(5).fill('moderation.reverse')].sort())
        for (const a of audits) expect(JSON.stringify(a.metadata)).not.toMatch(new RegExp(`${w.member.userId}|${w.admin.userId}`))
        // 운영자 사진 URL은 그 운영자에게만 맞고, 멤버의 URL은 운영자 경로에 맞지 않습니다.
        const opDetail = await getReportDetail(tx, w.op, (await createReport(tx, w.quiet, { targetType: 'room_item', targetRef: { spaceSlug: room.slug, kind: 'album_photo', itemId: photoId }, reason: 'spam' }, at(20))).id, at(20))
        const opUrl = (opDetail.content as { roomItem: { photoUrl: string } }).roomItem.photoUrl
        const opQuery = Object.fromEntries(new URL(opUrl, 'http://x').searchParams)
        expect((await readAll((await openOperatorAlbumPhoto(tx, storage, w.op, photoId, opQuery, at(20))).stream)).length).toBe(JPEG.length)
        await expectServiceError(openOperatorAlbumPhoto(tx, storage, w.quiet, photoId, opQuery, at(20)), 'FORBIDDEN')
        await expectServiceError(openOperatorAlbumPhoto(tx, storage, w.op, photoId, photoQuery, at(2)), 'NOT_FOUND')
      })
    },
    DB_TIMEOUT,
  )

  it(
    'hidden owner-facing state: hidden directory entries and room profiles show only to their owner; a hidden profile falls back to the missing-name label',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx)
        const room = await alumniRoom(tx, w, 'display')
        await putMyRoomProfile(tx, w.member, room.slug, { displayName: '숨길이름', cohortLabel: '13기' }, at(1))
        await putMyDirectoryEntry(tx, w.member, room.slug, { consent: true, currentWork: '디자인' }, at(1))
        const profileId = (await listRoomProfiles(tx, w.member, room.slug, at(1))).mine!.id
        const r1 = await createReport(tx, w.quiet, { targetType: 'room_item', targetRef: { spaceSlug: room.slug, kind: 'room_profile', itemId: profileId }, reason: 'affiliation_impersonation' }, at(2))
        await resolveReport(tx, w.op, r1.id, { action: 'hide_room_item', note: '기수 사칭', publicReason: '기수 확인 필요', notifyOwner: true }, at(3))
        const mineView = await listRoomProfiles(tx, w.member, room.slug, at(4))
        expect(mineView.mine).toMatchObject({ id: profileId, hidden: true })
        expect(mineView.profiles.find((p) => p.id === profileId)).toMatchObject({ hidden: true })
        // 다른 멤버의 명부에서 그 사람의 이름은 방별 프로필이 없는 것처럼 보입니다.
        const quietDir = await listDirectory(tx, w.quiet, room.slug, {}, at(4))
        expect(quietDir.entries.map((e) => e.name)).toEqual(['방별 이름 없음'])
        expect(JSON.stringify(quietDir)).not.toContain('숨길이름')

        const entryId = quietDir.entries[0]!.id
        const r2 = await createReport(tx, w.quiet, { targetType: 'room_item', targetRef: { spaceSlug: room.slug, kind: 'directory_entry', itemId: entryId }, reason: 'personal_info' }, at(5))
        await resolveReport(tx, w.op, r2.id, { action: 'hide_room_item', note: '연락처', publicReason: null, notifyOwner: false }, at(6))
        expect((await listDirectory(tx, w.quiet, room.slug, {}, at(7))).entries).toEqual([])
        expect((await listDirectory(tx, w.member, room.slug, {}, at(7))).mine).toMatchObject({ id: entryId, hidden: true })
        // 숨긴 동안에도 철회할 수 있고(철회권 우선) 조치 기록은 남아 "찾을 수 없음"이 됩니다.
        expect(await withdrawMyDirectoryEntry(tx, w.member, room.slug, at(8))).toMatchObject({ withdrawn: true })
        expect((await getReportDetail(tx, w.op, r2.id, at(9))).content).toMatchObject({ kind: 'unavailable' })
      })
    },
    DB_TIMEOUT,
  )

  it(
    'affiliation impersonation reason: only posts, comments, retros, directory entries and room profiles; topic affiliated-anonymous authors stay hidden from the operator detail',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx)
        const room = await alumniRoom(tx, w, 'anonymous')
        const ev = await createRoomEvent(tx, w.admin, room.slug, { title: '익명 모임', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
        const bad = await expectServiceError(
          createReport(tx, w.quiet, { targetType: 'room_item', targetRef: { spaceSlug: room.slug, kind: 'event', itemId: ev.id }, reason: 'affiliation_impersonation' }, at(2)),
          'VALIDATION',
        )
        expect(bad.fields).toEqual({ reason: 'not_applicable' })
        // 익명 방의 일정 신고: 운영자 상세에 만든 사람이 없습니다.
        const r = await createReport(tx, w.quiet, { targetType: 'room_item', targetRef: { spaceSlug: room.slug, kind: 'event', itemId: ev.id }, reason: 'spam' }, at(2))
        const evDetail = JSON.stringify(await getReportDetail(tx, w.op, r.id, at(3)))
        for (const leak of [w.admin.userId, w.admin.displayName, '실명운영진']) expect(evDetail).not.toContain(leak)

        const topic = await createTopic(tx, w.op, { name: `취준 ${rand()}`, category: 'career' }, at(1))
        const post = await createPost(tx, w.member, topic.boards[0]!.id, { title: '소속 표시 글', body: '현직자입니다', affiliationScope: 'institution' }, at(2))
        await expectServiceError(createReport(tx, w.quiet, { targetType: 'persona', targetRef: { handle: 'nobody' }, reason: 'affiliation_impersonation' }, at(3)), 'VALIDATION')
        const report = await createReport(tx, w.quiet, { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'affiliation_impersonation' }, at(3))
        const detail = await getReportDetail(tx, w.op, report.id, at(4))
        expect(detail.reports[0]!.reason).toBe('affiliation_impersonation')
        const json = JSON.stringify(detail)
        for (const leak of [w.member.userId, w.member.displayName, w.member.personaId, '실명멤버']) expect(json).not.toContain(leak)
        // DB check: 사칭 사유를 쓸 수 없는 대상이면 거부합니다(서버 판정을 거치지 않은 쓰기).
        const err = await tx
          .transaction(async (sp) => {
            await sp.execute(
              sql`insert into reports (reporter_id, target_type, target_key, room_item_kind, room_item_id, reason) values (${w.quiet.userId}, 'room_item', ${`room_item:event:${ev.id}`}, 'event', ${ev.id}, 'affiliation_impersonation')`,
            )
          })
          .catch((e: unknown) => e)
        expect(String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code)).toBe('23514')
      })
    },
    DB_TIMEOUT,
  )

  it(
    'verification queue: grouped by method with ages and SLA; certificate processing time (received → decided) median/p90 suppressed under 5',
    async () => {
      await withRollback(async (tx) => {
        setCertificateSlaHoursForTesting(null)
        const op = await createUser(tx, { displayName: '운영자' })
        await tx.insert(operators).values({ userId: op.id })
        const name = `큐캠프${rand()}`
        const [inst] = await tx.insert(schools).values({ name, nameKey: institutionNameKey(name), kind: 'bootcamp' }).returning({ id: schools.id })
        const [cohort] = (await tx.execute(sql`insert into institution_cohorts (school_id, label, label_key) values (${inst!.id}, '7기', '7기') returning id`)) as unknown as Array<{ id: string }>
        const NOW = new Date('2031-03-10T00:00:00Z')
        const ago = (h: number) => new Date(NOW.getTime() - h * HOUR)
        const aff = async (method: 'cohort_approval' | 'certificate_check' | 'invite_code', status: 'pending' | 'active', createdAt: Date) => {
          const u = await createUser(tx)
          const [row] = await tx
            .insert(institutionAffiliations)
            .values({ userId: u.id, schoolId: inst!.id, institutionKind: 'bootcamp', method, cohortId: cohort!.id, standing: 'alumni', status, verifiedAt: status === 'active' ? createdAt : null, createdAt, updatedAt: createdAt })
            .returning({ id: institutionAffiliations.id })
          return { userId: u.id, affiliationId: row!.id }
        }
        // 기수 승인 대기 2건(하나는 승인 1개).
        const older = await aff('cohort_approval', 'pending', ago(200))
        await aff('cohort_approval', 'pending', ago(5))
        const approver = await aff('invite_code', 'active', ago(1000))
        await tx.insert(cohortApprovals).values({ affiliationId: older.affiliationId, approverUserId: approver.userId, approverAffiliationId: approver.affiliationId })
        // 수료증 대기 2건(10시간·80시간 전에 받음)과 결정 4건.
        const cert = async (receivedHoursAgo: number, decidedHoursAgo: number | null) => {
          const a = await aff('certificate_check', decidedHoursAgo === null ? 'pending' : 'active', ago(receivedHoursAgo + 1))
          await tx.insert(certificateChecks).values({
            affiliationId: a.affiliationId,
            userId: a.userId,
            objectKey: decidedHoursAgo === null ? `quarantine/${crypto.randomUUID()}` : null,
            declaredType: 'application/pdf',
            fileExtension: 'pdf',
            byteSize: 100,
            uploadedAt: ago(receivedHoursAgo),
            scanStatus: 'clean',
            result: decidedHoursAgo === null ? null : 'approved',
            decidedAt: decidedHoursAgo === null ? null : ago(decidedHoursAgo),
            filePurgedAt: decidedHoursAgo === null ? null : ago(decidedHoursAgo),
            createdAt: ago(receivedHoursAgo + 1),
          })
        }
        await cert(10, null)
        await cert(80, null)
        for (const [received, decided] of [[100, 76], [100, 52], [200, 152], [50, 48]] as const) await cert(received, decided)

        const mine = <T extends { institutionName: string }>(rows: T[]) => rows.filter((r) => r.institutionName === name)
        const q1 = await getVerificationQueue(tx, { userId: op.id }, NOW)
        expect(q1.inviteCode.instant).toBe(true)
        expect(q1.cohortApproval.slaHours).toBeNull()
        expect(mine(q1.cohortApproval.pending).map((c) => [c.ageHours, c.approvals, c.required, c.cohortLabel])).toEqual([
          [200, 1, 2, '7기'],
          [5, 0, 2, '7기'],
        ])
        expect(q1.certificateCheck.slaHours).toBe(72)
        expect(mine(q1.certificateCheck.pending).map((c) => [c.ageHours, c.sla])).toEqual([
          [80, 'overdue'],
          [10, 'ok'],
        ])
        // 결정 4건: 처리 시간은 가립니다.
        expect(q1.certificateCheck.recent).toMatchObject({ decided: null, medianHours: null, p90Hours: null, medianTargetHours: 72 })
        await cert(30, 6)
        const q2 = await getVerificationQueue(tx, { userId: op.id }, NOW)
        // (24, 48, 48, 2, 24)시간 → 중앙값 24, p90 48.
        expect(q2.certificateCheck.recent).toMatchObject({ decided: 5, medianHours: 24, p90Hours: 48 })
        expect(q2.certificateCheck.recent.withinSla).toMatchObject({ denominator: 5, numerator: 5, rate: 1 })
        expect(JSON.stringify(q2)).not.toContain(older.userId)

        await expectServiceError(getVerificationQueue(tx, { userId: approver.userId }, NOW), 'FORBIDDEN')
        setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2_ALUMNI: 'on' })
        await expectServiceError(getVerificationQueue(tx, { userId: op.id }, NOW), 'NOT_FOUND')
        setFeatureEnvForTesting(ALL_ON)

        // P2 지표의 기관 칸도 같은 처리 시간을 씁니다(기간 안 결정만).
        const metrics = await getP2Metrics(tx, { userId: op.id }, { from: '2031-03-01', to: '2031-03-10' }, NOW)
        expect(metrics.institutions!.certificate).toMatchObject({ decided: 5, medianHours: 24 })
        expect(metrics.institutions!.verifiedByMethod.certificate_check).toBe(5)
        expect(metrics.institutions!.verifiedByMethod.cohort_approval).toBeNull()
      })
    },
    DB_TIMEOUT,
  )

  it(
    '§6.2 P2 events: user key only, hour-truncated, no key for anonymous rooms and affiliated-anonymous topic posts, opt-out respected, no ids',
    async () => {
      setAnalyticsEnvForTesting(PEPPER)
      await withRollback(async (tx) => {
        const w = await world(tx)
        const pepper = analyticsPepper()!
        const keyOf = (userId: string) => hashSubject(pepper, userId)
        const HOUR_T0 = new Date('2026-11-01T03:00:00Z')
        const p2Events = async () =>
          tx
            .select()
            .from(analyticsEvents)
            .where(
              and(
                gte(analyticsEvents.occurredAt, HOUR_T0),
                lt(analyticsEvents.occurredAt, new Date(HOUR_T0.getTime() + HOUR)),
                sql`${analyticsEvents.name}::text in ('alumni_room_created', 'event_created', 'rsvp_submitted', 'directory_consent_changed', 'topic_post_created', 'completion_retro_published')`,
              ),
            )
        const before = (await p2Events()).length
        const display = await alumniRoom(tx, w, 'display', 7)
        const anon = await alumniRoom(tx, w, 'anonymous', 8)
        const ev = await createRoomEvent(tx, w.admin, display.slug, { title: '정기 모임', startsAt: '2026-11-20T19:00:00+09:00' }, at(9))
        const anonEv = await createRoomEvent(tx, w.admin, anon.slug, { title: '익명 모임', startsAt: '2026-11-20T19:00:00+09:00' }, at(10))
        const date = ev.occurrences[0]!.date
        await respondToEvent(tx, w.member, display.slug, ev.id, { date, response: 'going' }, at(11))
        await respondToEvent(tx, w.member, display.slug, ev.id, { date, response: 'going' }, at(12)) // 같은 응답 — 세지 않음
        await respondToEvent(tx, w.member, display.slug, ev.id, { date, response: 'maybe' }, at(13))
        await respondToEvent(tx, w.member, anon.slug, anonEv.id, { date: anonEv.occurrences[0]!.date, response: 'going' }, at(14))
        await putMyDirectoryEntry(tx, w.member, display.slug, { consent: true, currentWork: '개발', interests: ['AI'] }, at(15))
        await putMyDirectoryEntry(tx, w.member, display.slug, { consent: true, currentWork: '개발' }, at(16)) // 바꾸기 — 세지 않음
        await withdrawMyDirectoryEntry(tx, w.member, display.slug, at(17))
        const topic = await createTopic(tx, w.op, { name: `군대 ${rand()}`, category: 'military' }, at(18))
        await createPost(tx, w.member, topic.boards[0]!.id, { title: '소속 표시', body: '질문', affiliationScope: 'institution_kind' }, at(19))
        // 수집 거부한 사람의 응답은 기록되지 않습니다.
        await setAnalyticsOptOut(tx, w.quiet, { analyticsOptOut: true })
        await respondToEvent(tx, w.quiet, display.slug, ev.id, { date, response: 'going' }, at(20))

        const rows = (await p2Events()).slice(0)
        expect(rows.length - before).toBe(10)
        for (const r of rows) expect(r.occurredAt).toEqual(HOUR_T0) // 시 단위
        const canon = (v: unknown): unknown =>
          v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : Array.isArray(v) ? v.map(canon) : v
        const sorted = (list: unknown[][]) => list.map((x) => JSON.stringify(canon(x))).sort()
        const keyed = (userId: string) => sorted(rows.filter((r) => r.actorHash === keyOf(userId)).map((r) => [r.name, r.props]))
        expect(keyed(w.owner.userId)).toEqual(
          sorted([
            ['alumni_room_created', { cohortRoom: false, mode: 'display' }],
            ['alumni_room_created', { cohortRoom: false, mode: 'anonymous' }],
          ]),
        )
        expect(keyed(w.admin.userId)).toEqual(sorted([['event_created', { recurrence: 'none' }]]))
        expect(keyed(w.member.userId)).toEqual(
          sorted([
            ['rsvp_submitted', { changed: false, response: 'going' }],
            ['rsvp_submitted', { changed: true, response: 'maybe' }],
            ['directory_consent_changed', { consented: true, filled: 2 }],
            ['directory_consent_changed', { consented: false }],
          ]),
        )
        expect(keyed(w.quiet.userId)).toEqual([])
        const unlinked = rows.filter((r) => r.actorHash === null).map((r) => [r.name, r.props])
        expect(unlinked).toEqual(
          expect.arrayContaining([
            ['event_created', { recurrence: 'none' }],
            ['rsvp_submitted', { changed: false, response: 'going' }],
            ['topic_post_created', expect.objectContaining({ labelScope: expect.any(String), broadened: expect.any(Boolean) })],
          ]),
        )
        expect(rows.every((r) => r.projectHash === null)).toBe(true)
        const json = JSON.stringify(rows)
        for (const leak of [w.member.userId, w.member.personaId, w.admin.userId, display.slug, ev.id, topic.slug]) expect(json).not.toContain(leak)
      })
    },
    DB_TIMEOUT,
  )

  it(
    'P2 metrics: operator only, sections hidden when the area flag is off, cells under 5 suppressed',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx)
        const room = await alumniRoom(tx, w, 'display')
        await createRoomEvent(tx, w.admin, room.slug, { title: '모임', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
        await expectServiceError(getP2Metrics(tx, w.member, {}, at(2)), 'FORBIDDEN')
        setFeatureEnvForTesting({})
        const off = await getP2Metrics(tx, w.op, { from: '2026-10-25', to: '2026-11-01' }, at(2))
        expect(off).toMatchObject({ flags: { alumni: false, topics: false, institutions: false }, alumni: null, topics: null, institutions: null })
        setFeatureEnvForTesting({ PEERCHIVE_FEATURE_P2_ALUMNI: 'on' })
        const alumniOnly = await getP2Metrics(tx, w.op, { from: '2026-10-25', to: '2026-11-01' }, at(2))
        expect(alumniOnly.topics).toBeNull()
        expect(alumniOnly.institutions).toBeNull()
        expect(alumniOnly.alumni).not.toBeNull()
        // 이 방 하나의 일정·응답은 5 미만이라 가려집니다.
        expect(alumniOnly.alumni!.events.eventsCreated).toBeNull()
        expect(alumniOnly.alumni!.reportsByKind.event).toBeNull()
        expect(JSON.stringify(alumniOnly)).not.toContain(room.slug)
      })
    },
    DB_TIMEOUT,
  )
})

describe.skipIf(!databaseUrl)('A-07 hidden room items stay closed on member detail paths (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeAll(async () => {
    root = root || (await mkdtemp(path.join(tmpdir(), 'peerchive-a07b-')))
    storage = storage ?? createFilesystemStorage(root)
  })
  beforeEach(() => setFeatureEnvForTesting(ALL_ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it(
    'a hidden event, poll or photo 404s on respond, vote and signed URL — also for the room owner',
    async () => {
      await withRollback(async (tx) => {
        const w = await world(tx)
        const room = await alumniRoom(tx, w, 'real')
        const ev = await createRoomEvent(tx, w.admin, room.slug, { title: '모임', startsAt: '2026-11-20T19:00:00+09:00' }, at(1))
        const poll = await createRoomPoll(tx, w.admin, room.slug, { question: '언제', options: ['토', '일'], closesAt: at(60 * 24 * 10).toISOString() }, at(1))
        const [space] = (await tx.execute(sql`select id from community_spaces where slug = ${room.slug}`)) as unknown as Array<{ id: string }>
        const photoId = await insertCleanPhoto(tx, space!.id, w.member.userId)
        const url = (await getAlbum(tx, w.owner, room.slug, at(2))).photos.find((p) => p.id === photoId)!.url!
        const query = Object.fromEntries(new URL(url, 'http://x').searchParams)
        for (const [kind, id] of [['event', ev.id], ['poll', poll.id], ['album_photo', photoId]] as const) {
          const r = await createReport(tx, w.quiet, { targetType: 'room_item', targetRef: { spaceSlug: room.slug, kind, itemId: id }, reason: 'spam' }, at(2))
          await resolveReport(tx, w.op, r.id, { action: 'hide_room_item', note: '숨김', publicReason: null, notifyOwner: false }, at(3))
        }
        await expectServiceError(respondToEvent(tx, w.owner, room.slug, ev.id, { date: ev.occurrences[0]!.date, response: 'going' }, at(4)), 'NOT_FOUND')
        await expectServiceError(voteOnPoll(tx, w.owner, room.slug, poll.id, { optionIndex: 0 }, at(4)), 'NOT_FOUND')
        await expectServiceError(openAlbumPhoto(tx, storage, w.owner, room.slug, photoId, query, at(4)), 'NOT_FOUND')
        expect((await getAlbum(tx, w.member, room.slug, at(4))).photos.some((p) => p.id === photoId)).toBe(false)
        const [row] = await tx.select({ hiddenAt: roomAlbumPhotos.hiddenAt }).from(roomAlbumPhotos).where(and(eq(roomAlbumPhotos.id, photoId), isNull(roomAlbumPhotos.hiddenAt)))
        expect(row).toBeUndefined()
      })
    },
    DB_TIMEOUT,
  )
})
