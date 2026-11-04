/**
 * A-01 동문회·OB 방 템플릿·방별 프로필·신분 배지 (DELIVERY_PLAN §4.3 A-01, SYSTEM_DESIGN §6.7.2 RoomProfile, ADR 0038).
 * 플래그(꺼지면 404·템플릿 거부·기존 방은 일반 방처럼), 멤버만 보기, 실명 방 이름 고정·표시명 방 방별 이름·익명 방 없음,
 * 기수 이력·권한, 글·댓글의 방별 이름·배지, 나가기·내보내기·익명 전환 시 삭제. 각 테스트는 rollback 트랜잭션 안에서 돕니다.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NAME_MODE_CHANGE_DELAY_MS } from '@peerchive/domain'
import { and, auditEvents, communitySpaces, eq, operators, roomProfileCohortChanges, roomProfiles, type DbExecutor } from '@peerchive/db'
import { applyNameModeChange } from '../../worker/src/ops/name-modes'
import { createSchool } from '../server/modules/catalog/catalog'
import { changeMemberRole, joinSpace, leaveSpace, removeMember } from '../server/modules/community/memberships'
import { scheduleNameModeChange } from '../server/modules/community/name-modes'
import { createComment, createPost, deletePost, getPost } from '../server/modules/community/posts'
import {
  deleteMyRoomProfile,
  listCohortHistory,
  listRoomProfiles,
  putMyRoomProfile,
  setMemberCohort,
} from '../server/modules/community/room-profiles'
import { createRoom, getSpaceDetail, listMySpaces } from '../server/modules/community/spaces'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { updateRealName } from '../server/modules/identity/profiles'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-01T03:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const ON = { PEERCHIVE_FEATURE_P2_ALUMNI: 'on' }

async function world(tx: DbExecutor) {
  const op = await createUser(tx)
  await tx.insert(operators).values({ userId: op.id })
  const school = await createSchool(tx, { userId: op.id }, { name: `동문대${crypto.randomUUID().slice(0, 8)}`, confirmNew: true }, T0)
  const person = async (label: string, standing: 'student' | 'alumni' = 'student') => {
    const u = await createUser(tx, { displayName: `계정${label}` })
    await verifiedAffiliation(tx, u.id, school.id, { standing })
    await updateRealName(tx, { userId: u.id }, { realName: `실명${label}` })
    await insertDisplayPersona(tx, u.id, `페르소나${label}`)
    return { userId: u.id }
  }
  return { op: { userId: op.id }, schoolId: school.id, owner: await person('방장', 'alumni'), admin: await person('운영진'), member: await person('멤버', 'alumni'), outsider: await person('밖') }
}

type World = Awaited<ReturnType<typeof world>>

async function spaceIdOf(tx: DbExecutor, slug: string): Promise<string> {
  const [row] = await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.slug, slug))
  return row!.id
}

async function alumniRoom(tx: DbExecutor, w: World, nameMode: 'real' | 'display' | 'anonymous', extra: Record<string, unknown> = {}) {
  const room = await createRoom(tx, w.owner, { name: `동문 ${nameMode} ${crypto.randomUUID().slice(0, 6)}`, nameMode, joinPolicy: 'open', template: 'alumni', ...extra }, T0)
  await joinSpace(tx, w.admin, room.slug, T0)
  await joinSpace(tx, w.member, room.slug, T0)
  await changeMemberRole(tx, w.owner, room.slug, w.admin.userId, { role: 'admin' }, T0)
  return room
}

describe.skipIf(!databaseUrl)('A-01 alumni rooms and room profiles (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('flag off: alumni template is rejected (404), room-profile APIs are 404, existing alumni rooms behave like general rooms', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'display')
      expect(room.template).toBe('alumni')
      await putMyRoomProfile(tx, w.member, room.slug, { displayName: '12기 김지민', badges: ['ob'], cohortLabel: '12기' }, at(1))
      const [mine] = await tx.select().from(roomProfiles).where(eq(roomProfiles.userId, w.member.userId))
      const post = await createPost(tx, w.member, room.boards[0]!.id, { title: '제목', body: '본문' }, at(2))
      expect(post.author).toMatchObject({ label: '12기 김지민', roomProfile: { badges: ['ob', 'cohort'], cohortLabel: '12기' } })

      setFeatureEnvForTesting({})
      await expectServiceError(createRoom(tx, w.owner, { name: '새 동문 방', nameMode: 'display', template: 'alumni' }, T0), 'NOT_FOUND')
      await expectServiceError(listRoomProfiles(tx, w.member, room.slug, at(3)), 'NOT_FOUND')
      await expectServiceError(putMyRoomProfile(tx, w.member, room.slug, { displayName: 'x' }, at(3)), 'NOT_FOUND')
      await expectServiceError(setMemberCohort(tx, w.owner, room.slug, mine!.id, { cohortLabel: '1기' }, at(3)), 'NOT_FOUND')
      await expectServiceError(listCohortHistory(tx, w.member, room.slug, mine!.id, at(3)), 'NOT_FOUND')
      // 기존 방은 그대로: 일반 방처럼 보이고 글에도 방별 이름·배지가 없음(고정한 표시명 페르소나 이름).
      expect((await getSpaceDetail(tx, w.member, room.slug, at(3))).template).toBe('general')
      expect((await listMySpaces(tx, w.member)).items.find((s) => s.slug === room.slug)?.template).toBe('general')
      const read = await getPost(tx, w.owner, post.id, at(3))
      expect(read.author.label).toBe('페르소나멤버')
      expect(read.author.roomProfile).toBeUndefined()
      // 내 프로필 삭제는 플래그와 무관(ADR 0060 D-02). 멤버 아님은 404, 멱등.
      await expectServiceError(deleteMyRoomProfile(tx, w.outsider, room.slug, at(3)), 'NOT_FOUND')
      expect((await getSpaceDetail(tx, w.member, room.slug, at(3))).leftoverAlumniData).toEqual({ directoryEntry: false, roomProfile: true })
      expect(await deleteMyRoomProfile(tx, w.member, room.slug, at(3))).toMatchObject({ mine: null, profiles: [], writable: false })
      expect(await tx.select().from(roomProfiles).where(eq(roomProfiles.id, mine!.id))).toHaveLength(0)
      await deleteMyRoomProfile(tx, w.member, room.slug, at(3))
      // 일반 방은 템플릿 없이 그대로 만들어짐.
      expect((await createRoom(tx, w.owner, { name: '일반 방', nameMode: 'display' }, T0)).template).toBe('general')
      await expectServiceError(createRoom(tx, w.owner, { name: '이상한 방', nameMode: 'display', template: 'bogus' }, T0), 'VALIDATION')
    })
  })

  it('room profiles are visible to active members only; general rooms and non-members get 404; anonymous alumni rooms have none (409)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'display')
      await putMyRoomProfile(tx, w.member, room.slug, { displayName: '멤버 방이름', bio: '소개' }, at(1))
      const list = await listRoomProfiles(tx, w.owner, room.slug, at(2))
      expect(list.profiles.map((p) => p.name)).toEqual(['멤버 방이름'])
      expect(JSON.stringify(list)).not.toContain(w.member.userId)
      await expectServiceError(listRoomProfiles(tx, w.outsider, room.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(putMyRoomProfile(tx, w.outsider, room.slug, { displayName: '밖' }, at(2)), 'NOT_FOUND')
      await expectServiceError(listRoomProfiles(tx, w.op, room.slug, at(2)), 'NOT_FOUND') // 운영자도 멤버가 아니면
      const general = await createRoom(tx, w.owner, { name: '일반', nameMode: 'display', joinPolicy: 'open' }, T0)
      await expectServiceError(listRoomProfiles(tx, w.owner, general.slug, at(2)), 'NOT_FOUND')
      await expectServiceError(putMyRoomProfile(tx, w.owner, general.slug, { displayName: 'x' }, at(2)), 'NOT_FOUND')

      const anon = await alumniRoom(tx, w, 'anonymous')
      await expectServiceError(listRoomProfiles(tx, w.member, anon.slug, at(2)), 'CONFLICT', 'room_profiles_unavailable')
      await expectServiceError(putMyRoomProfile(tx, w.member, anon.slug, { badges: ['ob'] }, at(2)), 'CONFLICT', 'room_profiles_unavailable')
      expect(await tx.select().from(roomProfiles).where(eq(roomProfiles.spaceId, await spaceIdOf(tx, anon.slug)))).toHaveLength(0)
    })
  })

  it('real rooms fix the name to the real name (badges/cohort/bio only); display rooms use a per-room name; account display name and handle never appear', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const real = await alumniRoom(tx, w, 'real')
      await expectServiceError(putMyRoomProfile(tx, w.member, real.slug, { displayName: '가짜 이름' }, at(1)), 'VALIDATION')
      const r = await putMyRoomProfile(tx, w.member, real.slug, { badges: ['alumni', 'ob'], cohortLabel: '12기', bio: '반가워요' }, at(1))
      expect(r.nameMode).toBe('real')
      expect(r.mine).toMatchObject({ name: '실명멤버', badges: ['ob', 'alumni', 'cohort'], cohortLabel: '12기', bio: '반가워요', displayName: null })

      const display = await alumniRoom(tx, w, 'display')
      await expectServiceError(putMyRoomProfile(tx, w.member, display.slug, { badges: ['ob'] }, at(1)), 'VALIDATION')
      await expectServiceError(putMyRoomProfile(tx, w.member, display.slug, { displayName: 'x', badges: ['current', 'ob'] }, at(1)), 'VALIDATION')
      await expectServiceError(putMyRoomProfile(tx, w.member, display.slug, { displayName: 'x', badges: ['verified'] }, at(1)), 'VALIDATION')
      const d = await putMyRoomProfile(tx, w.member, display.slug, { displayName: '12기 김지민', badges: ['current'] }, at(1))
      expect(d.mine).toMatchObject({ name: '12기 김지민', badges: ['current'] })
      // 같은 사람이 방마다 다른 이름.
      const display2 = await alumniRoom(tx, w, 'display')
      expect((await putMyRoomProfile(tx, w.member, display2.slug, { displayName: '스터디 지민' }, at(1))).mine!.name).toBe('스터디 지민')
      const text = JSON.stringify([r, d])
      for (const leak of ['계정멤버', '페르소나멤버', w.member.userId]) expect(text).not.toContain(leak)
    })
  })

  it('alumni badge is verified only by an active alumni affiliation at the linked school (never self-claimed)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const linked = await alumniRoom(tx, w, 'display', { schoolId: w.schoolId })
      await putMyRoomProfile(tx, w.member, linked.slug, { displayName: '졸업생', badges: ['alumni'] }, at(1)) // alumni 인증 있음
      await putMyRoomProfile(tx, w.admin, linked.slug, { displayName: '재학생', badges: ['alumni'] }, at(1)) // student 인증뿐
      const byName = new Map((await listRoomProfiles(tx, w.owner, linked.slug, at(2))).profiles.map((p) => [p.name, p]))
      expect(byName.get('졸업생')).toMatchObject({ badges: ['alumni'], alumniVerified: true })
      expect(byName.get('재학생')).toMatchObject({ badges: ['alumni'], alumniVerified: false })
      // 학교 무관 방에서는 인증 표시를 붙이지 않습니다.
      const free = await alumniRoom(tx, w, 'display')
      await putMyRoomProfile(tx, w.member, free.slug, { displayName: '졸업생', badges: ['alumni'], alumniVerified: true }, at(1))
      expect((await listRoomProfiles(tx, w.member, free.slug, at(2))).mine).toMatchObject({ alumniVerified: false })
    })
  })

  it('cohort: self-reported, owner/admin can edit with history (who/when/old→new); plain members and moderators cannot; history is for owner/admin and the subject', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'real')
      const mod = await createUser(tx)
      await verifiedAffiliation(tx, mod.id, w.schoolId)
      await joinSpace(tx, { userId: mod.id }, room.slug, T0)
      await changeMemberRole(tx, w.owner, room.slug, mod.id, { role: 'moderator' }, T0)
      await putMyRoomProfile(tx, w.member, room.slug, { cohortLabel: '11기' }, at(1))
      await putMyRoomProfile(tx, w.member, room.slug, { cohortLabel: '11기', bio: '바꾼 소개' }, at(2)) // 기수 그대로 → 이력 없음
      await putMyRoomProfile(tx, w.owner, room.slug, { badges: ['ob'] }, at(2))
      const target = (await listRoomProfiles(tx, w.owner, room.slug, at(3))).profiles.find((p) => p.name === '실명멤버')!
      const ownerProfile = (await listRoomProfiles(tx, w.owner, room.slug, at(3))).mine!

      const edited = await setMemberCohort(tx, w.admin, room.slug, target.id, { cohortLabel: '12기' }, at(4))
      expect(edited).toMatchObject({ name: '실명멤버', cohortLabel: '12기' })
      await setMemberCohort(tx, w.owner, room.slug, target.id, { cohortLabel: '12기' }, at(5)) // 같은 값 → 이력 없음
      await expectServiceError(setMemberCohort(tx, w.member, room.slug, ownerProfile.id, { cohortLabel: '1기' }, at(5)), 'FORBIDDEN')
      await expectServiceError(setMemberCohort(tx, { userId: mod.id }, room.slug, target.id, { cohortLabel: '1기' }, at(5)), 'FORBIDDEN')
      await expectServiceError(setMemberCohort(tx, w.outsider, room.slug, target.id, { cohortLabel: '1기' }, at(5)), 'NOT_FOUND')
      await expectServiceError(setMemberCohort(tx, w.owner, room.slug, crypto.randomUUID(), { cohortLabel: '1기' }, at(5)), 'NOT_FOUND')
      await expectServiceError(setMemberCohort(tx, w.owner, room.slug, target.id, { cohortLabel: 'x'.repeat(21) }, at(5)), 'VALIDATION')
      // 다른 방의 프로필 id는 404.
      const other = await alumniRoom(tx, w, 'real')
      await expectServiceError(setMemberCohort(tx, w.owner, other.slug, target.id, { cohortLabel: '1기' }, at(5)), 'NOT_FOUND')

      const history = await listCohortHistory(tx, w.member, room.slug, target.id, at(6))
      expect(history.map((h) => [h.fromLabel, h.toLabel, h.changedBy, h.changedByName])).toEqual([
        ['11기', '12기', 'manager', null], // 운영진은 이 방 프로필이 없어 이름 없음
        [null, '11기', 'subject', '실명멤버'],
      ])
      expect((await listCohortHistory(tx, w.owner, room.slug, target.id, at(6))).length).toBe(2)
      await expectServiceError(listCohortHistory(tx, { userId: mod.id }, room.slug, target.id, at(6)), 'FORBIDDEN')
      expect(await listCohortHistory(tx, w.admin, room.slug, ownerProfile.id, at(6))).toEqual([]) // 운영진은 다른 멤버의 이력도 봄
      await expectServiceError(listCohortHistory(tx, w.member, room.slug, ownerProfile.id, at(6)), 'FORBIDDEN')
      expect((await listRoomProfiles(tx, w.member, room.slug, at(6))).canEditCohort).toBe(false)
      expect((await listRoomProfiles(tx, w.admin, room.slug, at(6))).canEditCohort).toBe(true)
      // 감사 기록: id·플래그만(기수 값 없음).
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'community.room_profile_cohort_edit'))
      const mine = audits.filter((a) => (a.metadata as { profileId?: string }).profileId === target.id)
      expect(mine).toHaveLength(1)
      expect(JSON.stringify(mine[0]!.metadata)).not.toMatch(/11기|12기/)
    })
  })

  it('posts/comments in alumni rooms: display posts use the room name + badges, real posts keep the real name + badges, anonymous posts carry nothing; deleted posts drop them', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const display = await alumniRoom(tx, w, 'display')
      await putMyRoomProfile(tx, w.member, display.slug, { displayName: '12기 김지민', badges: ['ob'], cohortLabel: '12기' }, at(1))
      const post = await createPost(tx, w.member, display.boards[0]!.id, { title: '홈커밍', body: '본문' }, at(2))
      const thread = await createComment(tx, w.owner, post.id, { body: '반가워요' }, at(3))
      expect(thread.author).toMatchObject({ kind: 'display', label: '12기 김지민', roomProfile: { badges: ['ob', 'cohort'], cohortLabel: '12기', alumniVerified: false } })
      // 프로필이 없는 작성자는 고정한 표시명 페르소나 이름, 배지 없음.
      expect(thread.comments[0]!.author).toMatchObject({ label: '페르소나방장' })
      expect(thread.comments[0]!.author.roomProfile).toBeUndefined()
      expect(JSON.stringify(thread)).not.toMatch(/계정멤버|실명멤버/)

      const real = await alumniRoom(tx, w, 'real')
      await putMyRoomProfile(tx, w.member, real.slug, { badges: ['current'], cohortLabel: '30기' }, at(1))
      const realPost = await createPost(tx, w.member, real.boards[0]!.id, { title: '실명 글', body: '본문' }, at(2))
      expect(realPost.author).toMatchObject({ kind: 'real', label: '실명멤버', roomProfile: { badges: ['current', 'cohort'], cohortLabel: '30기' } })

      // 표시명 → 익명 전환 뒤 쓴 익명 글에는 아무것도 없고, worker 적용 시 방별 프로필·이력이 지워집니다.
      const state = await scheduleNameModeChange(tx, w.owner, display.slug, { toMode: 'anonymous' }, at(4))
      const after = new Date(at(4).getTime() + NAME_MODE_CHANGE_DELAY_MS + 60_000)
      const anonPost = await createPost(tx, w.member, display.boards[0]!.id, { title: '익명 글', body: '본문' }, after)
      expect(anonPost.author.kind).toBe('anonymous')
      expect(anonPost.author.roomProfile).toBeUndefined()
      // 효력이 생긴 뒤(worker 적용 전에도) 방별 프로필은 쓰지 않습니다.
      expect((await getPost(tx, w.owner, post.id, after)).author.roomProfile).toBeUndefined()
      await expectServiceError(listRoomProfiles(tx, w.member, display.slug, after), 'CONFLICT', 'room_profiles_unavailable')
      await applyNameModeChange(tx, state.pending!.id, { now: after })
      const displaySpaceId = await spaceIdOf(tx, display.slug)
      expect(await tx.select().from(roomProfiles).where(eq(roomProfiles.spaceId, displaySpaceId))).toHaveLength(0)
      expect(await tx.select().from(roomProfileCohortChanges).where(eq(roomProfileCohortChanges.spaceId, displaySpaceId))).toHaveLength(0)
      const remaining = await tx.select().from(roomProfiles).where(eq(roomProfiles.userId, w.member.userId))
      expect(remaining).toHaveLength(1) // 실명 방 것만 남음

      // 글을 지우면 이름·배지 모두 없음.
      const deleted = await deletePost(tx, w.member, realPost.id, at(9))
      expect(deleted.author.label).toBeNull()
      expect(deleted.author.roomProfile).toBeUndefined()
    })
  })

  it('leaving or being removed deletes the room profile and the cohort history about that person; delete is idempotent', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'display')
      await putMyRoomProfile(tx, w.member, room.slug, { displayName: '떠날 사람', cohortLabel: '1기' }, at(1))
      await putMyRoomProfile(tx, w.admin, room.slug, { displayName: '내보낼 사람', cohortLabel: '2기' }, at(1))
      await putMyRoomProfile(tx, w.owner, room.slug, { displayName: '방장 방이름' }, at(1))
      const count = async (userId: string) => ({
        profiles: (await tx.select().from(roomProfiles).where(eq(roomProfiles.userId, userId))).length,
        history: (await tx.select().from(roomProfileCohortChanges).where(eq(roomProfileCohortChanges.subjectUserId, userId))).length,
      })
      expect(await count(w.member.userId)).toEqual({ profiles: 1, history: 1 })
      await leaveSpace(tx, w.member, room.slug, at(2))
      expect(await count(w.member.userId)).toEqual({ profiles: 0, history: 0 })
      await changeMemberRole(tx, w.owner, room.slug, w.admin.userId, { role: 'member' }, at(2))
      await removeMember(tx, w.owner, room.slug, w.admin.userId, at(3))
      expect(await count(w.admin.userId)).toEqual({ profiles: 0, history: 0 })
      // 내 프로필 지우기는 멱등.
      const cleared = await deleteMyRoomProfile(tx, w.owner, room.slug, at(4))
      expect(cleared.mine).toBeNull()
      expect((await deleteMyRoomProfile(tx, w.owner, room.slug, at(5))).mine).toBeNull()
      expect(await tx.select().from(roomProfiles).where(and(eq(roomProfiles.userId, w.owner.userId)))).toHaveLength(0)
    })
  })
})
