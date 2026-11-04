/**
 * C-03 이름 표시 방식 변경 예약·취소·이력·알림·실명 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 DB 테스트는 건너뜁니다.
 * 각 테스트는 자기가 만든 학교(무작위 이름)·사용자·방만 봅니다. 적용(worker)은 apps/worker/test/ops-name-modes.test.ts가 보고,
 * 여기서는 effective_at이 지난 뒤 웹이 보여 주는 방식(effectiveNameMode)과 작성 시점 고정 계약을 봅니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { NAME_MODE_CHANGE_DELAY_MS, nameModeAtWrite, resolveAuthorDisplay } from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  auditEvents,
  communityNotices,
  communitySpaces,
  eq,
  hashSubject,
  inArray,
  nameModeChanges,
  operators,
  profiles,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { analyticsPepper } from '../server/modules/analytics/analytics'
import { createSchool } from '../server/modules/catalog/catalog'
import { approveMember, changeMemberRole, joinSpace, leaveSpace, listMembers, rejectMember, removeMember } from '../server/modules/community/memberships'
import { cancelNameModeChange, getNameModeState, loadScheduledChange, nameModeNow, scheduleNameModeChange } from '../server/modules/community/name-modes'
import { listMyCommunityNotices, markCommunityNoticesRead } from '../server/modules/community/notices'
import { createOfficialPage, restrictSpace } from '../server/modules/community/official'
import { archiveSpace, createRoom, getSpaceDetail, listMySpaces, updateSpace } from '../server/modules/community/spaces'
import { getMe, getPublicProfile, updateRealName } from '../server/modules/identity/profiles'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, minutes, verifiedAffiliation, withRollback } from './helpers'
import { memberRef } from './helpers-space-member-ref'
import { spaceMemberRefKey } from '../server/modules/community/space-member-refs'

const T0 = new Date('2026-11-03T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const EFFECTIVE = new Date(T0.getTime() + NAME_MODE_CHANGE_DELAY_MS)
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

async function school(tx: DbExecutor) {
  const op = { userId: (await createUser(tx)).id }
  await tx.insert(operators).values({ userId: op.userId })
  const s = await createSchool(tx, op, { name: `이름대${token()}학교`, confirmNew: true }, T0)
  return { op, schoolId: s.id }
}

async function student(tx: DbExecutor, schoolId: string, displayName = '학생') {
  const u = await createUser(tx, { handle: `n${token()}`, displayName })
  await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id }
}

/**
 * 자유 가입 실명 방: 방장 O, 운영진 A, 멤버 M, 나간 L, 내보낸 R, 거절된 X, 승인 대기 P(가입 방식을 승인으로 바꾼 뒤), 비멤버 N.
 * 실명 방은 기본이 승인이라 joinPolicy open을 직접 고릅니다.
 */
async function room(tx: DbExecutor, nameMode: 'real' | 'display' | 'anonymous' = 'real', joinPolicy: 'open' | 'approval' | 'invite' = 'open') {
  const f = await school(tx)
  const [O, A, M, L, R, X, P, N] = await Promise.all(['방장', '운영진', '멤버', '나간', '내보낸', '거절', '대기', '비멤버'].map((n) => student(tx, f.schoolId, n)))
  const created = await createRoom(tx, O!, { name: `동기방 ${token()}`, nameMode, joinPolicy: 'open' }, T0)
  const slug = created.slug
  for (const u of [A!, M!, L!, R!]) await joinSpace(tx, u, slug, at(1))
  await changeMemberRole(tx, O!, slug, await memberRef(tx, slug, A!.userId), { role: 'admin' }, at(2))
  await leaveSpace(tx, L!, slug, at(2))
  await removeMember(tx, O!, slug, await memberRef(tx, slug, R!.userId), at(2))
  await updateSpace(tx, O!, slug, { joinPolicy: 'approval' })
  await joinSpace(tx, X!, slug, at(3))
  await rejectMember(tx, O!, slug, await memberRef(tx, slug, X!.userId), at(3))
  await joinSpace(tx, P!, slug, at(3))
  if (joinPolicy !== 'approval') await updateSpace(tx, O!, slug, { joinPolicy })
  const [row] = await tx.select().from(communitySpaces).where(eq(communitySpaces.slug, slug))
  return { ...f, O: O!, A: A!, M: M!, L: L!, R: R!, X: X!, P: P!, N: N!, slug, spaceId: row!.id }
}

const noticesOf = (tx: DbExecutor, changeId: string, kind: 'name_mode_scheduled' | 'name_mode_cancelled' | 'name_mode_applied') =>
  tx.select().from(communityNotices).where(and(eq(communityNotices.nameModeChangeId, changeId), eq(communityNotices.kind, kind)))

describe.skipIf(!databaseUrl)('name mode changes (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('only the owner schedules; effective_at is exactly +7 days; active members (only) are notified at once', async () => {
    await withRollback(async (tx) => {
      const r = await room(tx, 'real', 'open')
      await expectServiceError(scheduleNameModeChange(tx, r.A, r.slug, { toMode: 'anonymous' }, T0), 'FORBIDDEN')
      await expectServiceError(scheduleNameModeChange(tx, r.M, r.slug, { toMode: 'anonymous' }, T0), 'FORBIDDEN')
      // 비멤버·나간·내보낸·대기는 공간을 읽을 수 없으므로 404
      for (const who of [r.N, r.L, r.R, r.P]) await expectServiceError(scheduleNameModeChange(tx, who, r.slug, { toMode: 'anonymous' }, T0), 'NOT_FOUND')
      await expectServiceError(scheduleNameModeChange(tx, r.O, r.slug, {}, T0), 'VALIDATION')
      const bad = await expectServiceError(scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'affiliated_anonymous' }, T0), 'VALIDATION')
      expect(bad.fields).toEqual({ toMode: 'invalid' })
      const same = await expectServiceError(scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'real' }, T0), 'VALIDATION')
      expect(same.fields).toEqual({ toMode: 'same_mode' })

      const state = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'anonymous' }, T0)
      expect(state).toMatchObject({ currentMode: 'real', fixed: false, canChange: true, pending: { fromMode: 'real', toMode: 'anonymous', requestedAt: T0.toISOString(), effectiveAt: EFFECTIVE.toISOString() } })
      expect(new Date(state.pending!.effectiveAt).getTime() - new Date(state.pending!.requestedAt).getTime()).toBe(7 * 24 * 60 * 60 * 1000)
      expect(state.history).toHaveLength(1)
      expect(JSON.stringify(state)).not.toContain(r.O.userId)
      const [row] = await tx.select().from(nameModeChanges).where(eq(nameModeChanges.spaceId, r.spaceId))
      expect(row).toMatchObject({ status: 'scheduled', requestedBy: r.O.userId, requestedAt: T0, effectiveAt: EFFECTIVE, joinPolicyAdjusted: false })
      // 지금 방식은 그대로(적용 전): 공간 행·상세 모두 real
      expect((await tx.select().from(communitySpaces).where(eq(communitySpaces.id, r.spaceId)))[0]!.currentNameMode).toBe('real')

      const notices = await noticesOf(tx, row!.id, 'name_mode_scheduled')
      expect(notices.map((n) => n.userId).sort()).toEqual([r.O.userId, r.A.userId, r.M.userId].sort())
      expect(notices[0]!.payload).toEqual({ fromMode: 'real', toMode: 'anonymous', effectiveAt: EFFECTIVE.toISOString(), joinPolicyAdjusted: false })
      const others = await tx.select().from(communityNotices).where(inArray(communityNotices.userId, [r.L.userId, r.R.userId, r.X.userId, r.P.userId, r.N.userId]))
      expect(others).toEqual([])

      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.name_mode_schedule'), eq(auditEvents.targetId, r.spaceId)))
      expect(audit.map((a) => a.metadata)).toEqual([{ changeId: row!.id, from: 'real', to: 'anonymous', joinPolicyAdjusted: false, notified: 3 }])
      const pepper = analyticsPepper()!
      const events = await tx.select().from(analyticsEvents).where(and(eq(analyticsEvents.name, 'name_mode_scheduled'), eq(analyticsEvents.actorHash, hashSubject(pepper, r.O.userId))))
      expect(events.map((e) => e.props)).toEqual([{ from: 'real', to: 'anonymous' }])
    })
  })

  it('one scheduled change per space (409); official pages are fixed (409); archived/restricted rooms 409', async () => {
    await withRollback(async (tx) => {
      const r = await room(tx, 'display', 'open')
      const first = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'anonymous' }, T0)
      const dup = await expectServiceError(scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'real' }, at(1)), 'CONFLICT', 'change_already_scheduled')
      expect(dup.details).toMatchObject({ changeId: first.pending!.id, effectiveAt: EFFECTIVE.toISOString() })
      // DB도 막음(부분 unique)
      await expect(
        tx.transaction((sp) =>
          sp.insert(nameModeChanges).values({ spaceId: r.spaceId, fromMode: 'display', toMode: 'real', requestedBy: r.O.userId, requestedAt: T0, effectiveAt: EFFECTIVE }),
        ),
      ).rejects.toThrow()

      const official = await createOfficialPage(tx, r.op, { schoolId: r.schoolId }, T0)
      await expectServiceError(scheduleNameModeChange(tx, r.op, official.slug, { toMode: 'display' }, T0), 'CONFLICT', 'name_mode_fixed')
      await expectServiceError(scheduleNameModeChange(tx, r.M, official.slug, { toMode: 'real' }, T0), 'CONFLICT', 'name_mode_fixed')
      expect(await getNameModeState(tx, r.M, official.slug, T0)).toEqual({ currentMode: 'anonymous', fixed: true, canChange: false, pending: null, history: [] })
      expect((await getSpaceDetail(tx, r.M, official.slug, T0)).pendingNameModeChange).toBeNull()
      // 기존 PATCH 경로는 여전히 422
      await expectServiceError(updateSpace(tx, r.O, r.slug, { nameMode: 'real' }), 'VALIDATION')

      const other = await createRoom(tx, r.O, { name: `보관방 ${token()}`, nameMode: 'display' }, T0)
      await archiveSpace(tx, r.O, other.slug, T0)
      await expectServiceError(scheduleNameModeChange(tx, r.O, other.slug, { toMode: 'real' }, T0), 'CONFLICT', 'space_not_active')
      const third = await createRoom(tx, r.O, { name: `제한방 ${token()}`, nameMode: 'display' }, T0)
      const [thirdRow] = await tx.select().from(communitySpaces).where(eq(communitySpaces.slug, third.slug))
      await restrictSpace(tx, r.op, thirdRow!.id, { note: '확인' }, T0)
      await expectServiceError(scheduleNameModeChange(tx, r.O, third.slug, { toMode: 'real' }, T0), 'CONFLICT', 'space_not_active')
    })
  })

  it('cancel: owner only, before effective_at only, notifies active members; a new change can then be scheduled', async () => {
    await withRollback(async (tx) => {
      const r = await room(tx, 'anonymous', 'open')
      const scheduled = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'display' }, T0)
      const changeId = scheduled.pending!.id
      await expectServiceError(cancelNameModeChange(tx, r.A, r.slug, changeId, at(5)), 'FORBIDDEN')
      await expectServiceError(cancelNameModeChange(tx, r.N, r.slug, changeId, at(5)), 'NOT_FOUND')
      await expectServiceError(cancelNameModeChange(tx, r.O, r.slug, crypto.randomUUID(), at(5)), 'NOT_FOUND')
      await expectServiceError(cancelNameModeChange(tx, r.O, r.slug, 'nope', at(5)), 'NOT_FOUND')
      // 기한이 지나면 취소할 수 없음(worker 적용 전이어도)
      await expectServiceError(cancelNameModeChange(tx, r.O, r.slug, changeId, EFFECTIVE), 'CONFLICT', 'already_effective')

      const cancelled = await cancelNameModeChange(tx, r.O, r.slug, changeId, at(60))
      expect(cancelled).toMatchObject({ currentMode: 'anonymous', pending: null })
      expect(cancelled.history[0]).toMatchObject({ id: changeId, status: 'cancelled', cancelledAt: at(60).toISOString(), appliedAt: null })
      const [row] = await tx.select().from(nameModeChanges).where(eq(nameModeChanges.id, changeId))
      expect(row).toMatchObject({ status: 'cancelled', cancelledBy: r.O.userId })
      expect((await noticesOf(tx, changeId, 'name_mode_cancelled')).map((n) => n.userId).sort()).toEqual([r.O.userId, r.A.userId, r.M.userId].sort())
      await expectServiceError(cancelNameModeChange(tx, r.O, r.slug, changeId, at(61)), 'CONFLICT', 'not_scheduled')
      // 기한이 지나도 취소된 예약은 효력이 없음
      expect((await getSpaceDetail(tx, r.M, r.slug, new Date(EFFECTIVE.getTime() + 1))).nameMode).toBe('anonymous')

      const again = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'real' }, at(90))
      expect(again.history.map((h) => h.status)).toEqual(['scheduled', 'cancelled'])
      expect(await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.name_mode_cancel'), eq(auditEvents.targetId, r.spaceId)))).toHaveLength(1)
    })
  })

  it('switching to real turns open rooms into approval (and says so); invite-only stays; later joiners go to pending', async () => {
    await withRollback(async (tx) => {
      const r = await room(tx, 'anonymous', 'open')
      const state = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'real' }, T0)
      expect(state.history[0]).toMatchObject({ joinPolicyAdjusted: true })
      expect((await tx.select().from(communitySpaces).where(eq(communitySpaces.id, r.spaceId)))[0]!.joinPolicy).toBe('approval')
      const [notice] = await noticesOf(tx, state.pending!.id, 'name_mode_scheduled')
      expect(notice!.payload).toMatchObject({ joinPolicyAdjusted: true })
      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.name_mode_schedule'), eq(auditEvents.targetId, r.spaceId)))
      expect(audit[0]!.metadata).toMatchObject({ joinPolicyAdjusted: true })
      // 7일 사이에 들어오는 사람은 승인 대기(실명 방 기본)
      expect((await joinSpace(tx, r.N, r.slug, at(10))).status).toBe('pending')
      // 취소해도 가입 방식은 되돌리지 않음(방장이 설정에서 바꿀 수 있음)
      await cancelNameModeChange(tx, r.O, r.slug, state.pending!.id, at(20))
      expect((await tx.select().from(communitySpaces).where(eq(communitySpaces.id, r.spaceId)))[0]!.joinPolicy).toBe('approval')

      const inviteOnly = await room(tx, 'display', 'invite')
      const s2 = await scheduleNameModeChange(tx, inviteOnly.O, inviteOnly.slug, { toMode: 'real' }, T0)
      expect(s2.history[0]!.joinPolicyAdjusted).toBe(false)
      expect((await tx.select().from(communitySpaces).where(eq(communitySpaces.id, inviteOnly.spaceId)))[0]!.joinPolicy).toBe('invite')
    })
  })

  it('banner data: members, new members and preview visitors see the pending change; after effective_at the new mode shows without the worker', async () => {
    await withRollback(async (tx) => {
      const r = await room(tx, 'real', 'approval')
      await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'anonymous' }, T0)
      const member = await getSpaceDetail(tx, r.M, r.slug, at(1))
      expect(member).toMatchObject({ access: 'member', nameMode: 'real', pendingNameModeChange: { toMode: 'anonymous', effectiveAt: EFFECTIVE.toISOString() } })
      expect(member.permissions.changeNameMode).toBe(false)
      expect((await getSpaceDetail(tx, r.O, r.slug, at(1))).permissions.changeNameMode).toBe(true)
      expect((await getSpaceDetail(tx, r.A, r.slug, at(1))).permissions.changeNameMode).toBe(false)
      // 승인 대기 중인 사람(소개)도 예약을 봄
      expect(await getSpaceDetail(tx, r.P, r.slug, at(1))).toMatchObject({ access: 'preview', pendingNameModeChange: { toMode: 'anonymous' } })
      // 예약 뒤 승인된 새 멤버: 알림은 없고 배너(상세)로 봄
      await approveMember(tx, r.O, r.slug, await memberRef(tx, r.slug, r.P.userId), at(2))
      expect(await getSpaceDetail(tx, r.P, r.slug, at(3))).toMatchObject({ access: 'member', pendingNameModeChange: { toMode: 'anonymous' } })
      expect(await tx.select().from(communityNotices).where(eq(communityNotices.userId, r.P.userId))).toEqual([])
      // 멤버는 이력을 봄, 비멤버는 404
      expect((await getNameModeState(tx, r.M, r.slug, at(3))).history).toHaveLength(1)
      await expectServiceError(getNameModeState(tx, r.N, r.slug, at(3)), 'NOT_FOUND')

      // effective_at부터는 worker 전이라도 새 방식, 예약 배너는 사라짐
      const after = await getSpaceDetail(tx, r.M, r.slug, EFFECTIVE)
      expect(after).toMatchObject({ nameMode: 'anonymous', pendingNameModeChange: null })
      const state = await getNameModeState(tx, r.M, r.slug, EFFECTIVE)
      expect(state).toMatchObject({ currentMode: 'anonymous', pending: null })
    })
  })

  it('write-time freeze contract: posts take the mode in force at write time, scheduled changes never touch earlier posts', async () => {
    await withRollback(async (tx) => {
      const r = await room(tx, 'real', 'open')
      await updateRealName(tx, r.M, { realName: '김멤버' })
      await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'anonymous' }, T0)
      // C-04가 할 일: 같은 트랜잭션에서 공간 행 + 예약을 읽고 nameModeAtWrite로 정한 값을 글 행에 복사
      const writeAt = async (now: Date) => {
        const [space] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, r.spaceId)).for('share')
        const scheduled = await loadScheduledChange(tx, r.spaceId)
        const decided = nameModeAtWrite(
          { kind: space!.kind, currentNameMode: space!.currentNameMode, scheduledChange: scheduled && { status: scheduled.status, toMode: scheduled.toMode, effectiveAt: scheduled.effectiveAt } },
          now,
        )
        if (!decided.ok) throw new Error(decided.reason)
        return decided.mode
      }
      const before = [await writeAt(at(1)), await writeAt(new Date(EFFECTIVE.getTime() - 1))]
      const afterDue = await writeAt(EFFECTIVE)
      expect(before).toEqual(['real', 'real'])
      expect(afterDue).toBe('anonymous')
      expect(nameModeNow('real', await loadScheduledChange(tx, r.spaceId), EFFECTIVE).mode).toBe('anonymous')
      // 표시: 실명 글은 실명, 익명 글은 익명(보는 사람이 방장이어도 같음)
      const [u] = await tx.select().from(users).where(eq(users.id, r.M.userId))
      const bits = { userId: u!.id, status: u!.status, purged: u!.purgedAt !== null, displayPersonaName: null, realName: u!.realName }
      expect(resolveAuthorDisplay(before[0]!, bits, r.O).label).toBe('김멤버')
      expect(resolveAuthorDisplay(afterDue, bits, r.O)).toEqual({ kind: 'anonymous', label: null, threadAlias: 'computed_by_thread', mine: false })
    })
  })

  it('notices: my list with unread count, mark read (mine only), space name hidden after leaving', async () => {
    await withRollback(async (tx) => {
      const r = await room(tx, 'display', 'open')
      const s = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'anonymous' }, T0)
      await cancelNameModeChange(tx, r.O, r.slug, s.pending!.id, at(5))
      const mine = await listMyCommunityNotices(tx, r.M)
      expect(mine.unread).toBe(2)
      expect(mine.items.map((n) => n.kind)).toEqual(['name_mode_cancelled', 'name_mode_scheduled'])
      expect(mine.items[0]).toMatchObject({ space: { slug: r.slug }, fromMode: 'display', toMode: 'anonymous', effectiveAt: EFFECTIVE.toISOString(), readAt: null })
      expect((await listMySpaces(tx, r.M)).unreadNotices).toBe(2)
      expect(await listMyCommunityNotices(tx, r.N)).toEqual({ items: [], unread: 0 })

      // 남의 알림 id는 무시
      const othersId = (await listMyCommunityNotices(tx, r.A)).items[0]!.id
      expect(await markCommunityNoticesRead(tx, r.M, { ids: [othersId] }, at(6))).toEqual({ updated: 0, unread: 2 })
      await expectServiceError(markCommunityNoticesRead(tx, r.M, {}, at(6)), 'VALIDATION')
      await expectServiceError(markCommunityNoticesRead(tx, r.M, { ids: [othersId], all: true }, at(6)), 'VALIDATION')
      expect(await markCommunityNoticesRead(tx, r.M, { ids: [mine.items[1]!.id] }, at(6))).toEqual({ updated: 1, unread: 1 })
      expect(await markCommunityNoticesRead(tx, r.M, { all: true }, at(7))).toEqual({ updated: 1, unread: 0 })
      expect((await listMyCommunityNotices(tx, r.A)).unread).toBe(2)

      // 나간 뒤에는 공간 이름·주소를 싣지 않음
      await leaveSpace(tx, r.M, r.slug, at(8))
      expect((await listMyCommunityNotices(tx, r.M)).items.every((n) => n.space === null)).toBe(true)
    })
  })

  it('real name is optional, private to /me, never on the public profile', async () => {
    await withRollback(async (tx) => {
      const u = await createUser(tx, { handle: `rn${token()}`, displayName: '표시이름' })
      const me = { userId: u.id }
      expect((await getMe(tx, me)).realName).toBeNull()
      expect((await updateRealName(tx, me, { realName: '  홍   길동 ' })).realName).toBe('홍 길동')
      const tooLong = await expectServiceError(updateRealName(tx, me, { realName: '가'.repeat(31) }), 'VALIDATION')
      expect(tooLong.fields).toEqual({ realName: 'too_long' })
      await expectServiceError(updateRealName(tx, me, { realName: 7 }), 'VALIDATION')
      const [profile] = await tx.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, u.id))
      expect(JSON.stringify(await getPublicProfile(tx, profile!.handle))).not.toContain('홍 길동')
      const audit = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'account.real_name_update'), eq(auditEvents.actorId, u.id)))
      expect(audit.map((a) => a.metadata)).toEqual([{ set: true }])
      expect(JSON.stringify(audit)).not.toContain('홍')
      expect((await updateRealName(tx, me, { realName: '' })).realName).toBeNull()
    })
  })

  // ADR 0060 D-01: 멤버 목록의 이름은 지금 효력이 있는 방식을 따릅니다.
  describe('member list names (D-01)', () => {
    const roster = async (tx: DbExecutor, slug: string, viewer: { userId: string }, now?: Date) => {
      const list = await listMembers(tx, viewer, slug, now)
      const [space] = await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.slug, slug))
      const all = [...list.members, ...list.pending]
      // 실제 사용자 id로 찾되, 표시명·익명 방에서는 방별 키로 나옵니다.
      const byId = { get: (userId: string) => all.find((m) => m.userId === userId || m.userId === spaceMemberRefKey(space!.id, userId)) }
      return { list, byId, json: JSON.stringify(list) }
    }

    it('display room: persona name or the missing label; no account name or real handle in the JSON', async () => {
      await withRollback(async (tx) => {
        const r = await room(tx, 'display')
        await insertDisplayPersona(tx, r.M.userId, '페르소나이름')
        const { byId, json } = await roster(tx, r.slug, r.O)
        expect(byId.get(r.M.userId)).toMatchObject({ displayName: '페르소나이름', handle: null })
        expect(byId.get(r.A.userId)).toMatchObject({ displayName: '표시명 없음', handle: null })
        expect(byId.get(r.P.userId)).toMatchObject({ displayName: '표시명 없음', handle: null, status: 'pending' })
        for (const name of ['방장', '운영진', '멤버', '대기']) expect(json).not.toContain(`"displayName":"${name}"`)
        const handles = await tx.select({ handle: profiles.handle }).from(profiles).where(inArray(profiles.userId, [r.O.userId, r.A.userId, r.M.userId, r.P.userId]))
        expect(handles).toHaveLength(4)
        for (const { handle } of handles) expect(json).not.toContain(handle)
        // 운영진(admin) 시야도 같고, 승인·역할 변경·방장 이전은 이름과 무관하게 그대로 동작합니다.
        expect((await roster(tx, r.slug, r.A)).byId.get(r.M.userId)?.displayName).toBe('페르소나이름')
        await approveMember(tx, r.O, r.slug, await memberRef(tx, r.slug, r.P.userId), at(4))
        const mRef = await memberRef(tx, r.slug, r.M.userId)
        const transferred = await changeMemberRole(tx, r.O, r.slug, mRef, { role: 'owner' }, at(5))
        expect(transferred.members.find((m) => m.userId === mRef)).toMatchObject({ role: 'owner', displayName: '페르소나이름' })
      })
    })

    it('real room stays unchanged: account name and real handle', async () => {
      await withRollback(async (tx) => {
        const r = await room(tx, 'real')
        const { byId } = await roster(tx, r.slug, r.O)
        const [own] = await tx.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, r.M.userId))
        expect(byId.get(r.M.userId)).toMatchObject({ displayName: '멤버', handle: own!.handle })
      })
    })

    it('anonymous room: every row is the neutral label, even a member with a display persona', async () => {
      await withRollback(async (tx) => {
        const r = await room(tx, 'anonymous')
        await insertDisplayPersona(tx, r.M.userId, '페르소나이름')
        const { list, json } = await roster(tx, r.slug, r.O)
        expect(new Set([...list.members, ...list.pending].map((m) => m.displayName))).toEqual(new Set(['익명 멤버']))
        expect(list.members.every((m) => m.handle === null)).toBe(true)
        expect(json).not.toContain('페르소나이름')
        expect(json).not.toContain('방장')
      })
    })

    // ADR 0060 D-01 보완: 사용자 id는 과제·실명 방 응답과 같은 값이라, 그대로 두면 표시명을 실명과 맞춰 볼 수 있습니다.
    for (const mode of ['display', 'anonymous'] as const) {
      it(`${mode} room: other members' account ids never leave the list, and management takes only the room key`, async () => {
        await withRollback(async (tx) => {
          const r = await room(tx, mode)
          const { list, json } = await roster(tx, r.slug, r.O)
          for (const u of [r.A, r.M, r.P]) expect(json).not.toContain(u.userId)
          expect(json).toContain(r.O.userId) // 본인은 그대로(화면의 "나" 판정)
          expect(new Set(list.members.map((m) => m.userId)).size).toBe(list.members.length)
          // 다른 사람의 실제 id로는 그 사람이 멤버인지 떠볼 수 없습니다(멤버·비멤버 모두 404).
          await expectServiceError(removeMember(tx, r.O, r.slug, r.M.userId, at(4)), 'NOT_FOUND')
          await expectServiceError(removeMember(tx, r.O, r.slug, r.N.userId, at(4)), 'NOT_FOUND')
          await expectServiceError(approveMember(tx, r.O, r.slug, r.P.userId, at(4)), 'NOT_FOUND')
          await expectServiceError(changeMemberRole(tx, r.O, r.slug, r.M.userId, { role: 'moderator' }, at(4)), 'NOT_FOUND')
          // 모르는 키도 404. 다른 방의 키는 이 방에서 통하지 않습니다.
          await expectServiceError(removeMember(tx, r.O, r.slug, 'rm_0000000000000000', at(4)), 'NOT_FOUND')
          const other = await createRoom(tx, r.M, { name: `다른방 ${token()}`, nameMode: mode, joinPolicy: 'open' }, at(4))
          await joinSpace(tx, r.A, other.slug, at(4))
          const otherRef = await memberRef(tx, other.slug, r.A.userId, at(5))
          expect(otherRef).not.toBe(await memberRef(tx, r.slug, r.A.userId, at(5)))
          await expectServiceError(removeMember(tx, r.O, r.slug, otherRef, at(5)), 'NOT_FOUND')
          // 목록의 값 그대로 관리합니다. 본인 id의 기존 오류도 그대로입니다.
          const row = list.members.find((m) => m.role === 'member')!
          const after = await removeMember(tx, r.O, r.slug, row.userId, at(6))
          expect(after.members.map((m) => m.userId)).not.toContain(row.userId)
          await expectServiceError(removeMember(tx, r.O, r.slug, r.O.userId, at(6)), 'CONFLICT', 'use_leave')
        })
      })
    }

    it('real room keeps account ids, and a due change to display switches to room keys', async () => {
      await withRollback(async (tx) => {
        const r = await room(tx, 'real')
        expect((await roster(tx, r.slug, r.O)).json).toContain(r.M.userId)
        await expectServiceError(removeMember(tx, r.O, r.slug, 'rm_0000000000000000', at(4)), 'NOT_FOUND')
        await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'display' }, at(10))
        const effective = new Date(at(10).getTime() + NAME_MODE_CHANGE_DELAY_MS)
        expect((await roster(tx, r.slug, r.O, effective)).json).not.toContain(r.M.userId)
        await expectServiceError(removeMember(tx, r.O, r.slug, r.M.userId, effective), 'NOT_FOUND')
      })
    })

    it('uses the effective mode: a due scheduled change applies before the worker runs', async () => {
      await withRollback(async (tx) => {
        const r = await room(tx, 'real')
        await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'display' }, at(10))
        const effective = new Date(at(10).getTime() + NAME_MODE_CHANGE_DELAY_MS)
        expect((await roster(tx, r.slug, r.O, new Date(effective.getTime() - 1000))).byId.get(r.M.userId)?.displayName).toBe('멤버')
        expect((await roster(tx, r.slug, r.O, effective)).byId.get(r.M.userId)).toMatchObject({ displayName: '표시명 없음', handle: null })
      })
    })
  })
})
