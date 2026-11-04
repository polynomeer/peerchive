/**
 * A-03 동문회·OB 방 멤버 명부 동의 (DELIVERY_PLAN §4.3 A-03·§5.3 X, SYSTEM_DESIGN §6.7.2 DirectoryEntry·§8.4, ADR 0040).
 * 동의 없는 행 0건, 항목별 비우기, 철회·나가기·내보내기·익명 전환 즉시 삭제, 멤버만(404)·플래그(404), 이름 규칙(실명·방별 이름),
 * 쪽 크기 상한·“전부 가져오기” 없음, 빠르게 넘기면 rate limit, 내보내기 경로(API·CSV·PDF) 없음. 각 테스트는 rollback 트랜잭션 안에서 돕니다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DIRECTORY_PAGE_SIZE, NAME_MODE_CHANGE_DELAY_MS } from '@peerchive/domain'
import { and, auditEvents, communitySpaces, directoryEntries, eq, type DbExecutor } from '@peerchive/db'
import { applyNameModeChange } from '../../worker/src/ops/name-modes'
import { createSchool } from '../server/modules/catalog/catalog'
import { DIRECTORY_PAGE_VIEW_LIMIT, listDirectory, putMyDirectoryEntry, withdrawMyDirectoryEntry } from '../server/modules/community/member-directory'
import { changeMemberRole, joinSpace, leaveSpace, removeMember } from '../server/modules/community/memberships'
import { scheduleNameModeChange } from '../server/modules/community/name-modes'
import { putMyRoomProfile } from '../server/modules/community/room-profiles'
import { archiveSpaceInTx, createRoom, getSpaceDetail } from '../server/modules/community/spaces'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { updateRealName } from '../server/modules/identity/profiles'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, verifiedAffiliation, withRollback } from './helpers'
import { memberRef } from './helpers-space-member-ref'

const T0 = new Date('2026-11-01T03:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)
const ON = { PEERCHIVE_FEATURE_P2_ALUMNI: 'on' }
const CONSENT = { consent: true } as const

async function world(tx: DbExecutor) {
  const op = await createUser(tx)
  const school = await createSchool(tx, { userId: op.id }, { name: `명부대${crypto.randomUUID().slice(0, 8)}`, confirmNew: true }, T0)
  const person = async (label: string) => {
    const u = await createUser(tx, { displayName: `계정${label}` })
    await verifiedAffiliation(tx, u.id, school.id)
    await updateRealName(tx, { userId: u.id }, { realName: `실명${label}` })
    await insertDisplayPersona(tx, u.id, `페르소나${label}`)
    return { userId: u.id }
  }
  return { owner: await person('방장'), admin: await person('운영진'), member: await person('멤버'), quiet: await person('조용'), outsider: await person('밖') }
}

type World = Awaited<ReturnType<typeof world>>

async function alumniRoom(tx: DbExecutor, w: World, nameMode: 'real' | 'display' | 'anonymous', template: 'alumni' | 'general' = 'alumni') {
  const room = await createRoom(tx, w.owner, { name: `명부 ${nameMode} ${crypto.randomUUID().slice(0, 6)}`, nameMode, joinPolicy: 'open', ...(template === 'alumni' && { template }) }, T0)
  for (const p of [w.admin, w.member, w.quiet]) await joinSpace(tx, p, room.slug, T0)
  await changeMemberRole(tx, w.owner, room.slug, await memberRef(tx, room.slug, w.admin.userId), { role: 'admin' }, T0)
  return room
}

async function spaceIdOf(tx: DbExecutor, slug: string): Promise<string> {
  const [row] = await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.slug, slug))
  return row!.id
}

async function rowsOf(tx: DbExecutor, slug: string) {
  return tx.select().from(directoryEntries).where(eq(directoryEntries.spaceId, await spaceIdOf(tx, slug)))
}

describe.skipIf(!databaseUrl)('A-03 member directory consent (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('no row without consent: joining, viewing or a save without consent: true creates nothing; only consenting members are listed', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'real')
      const empty = await listDirectory(tx, w.member, room.slug, {}, at(1))
      expect(empty).toMatchObject({ nameMode: 'real', writable: true, page: 1, pageSize: DIRECTORY_PAGE_SIZE, hasNext: false, mine: null, entries: [] })
      for (const body of [{}, { consent: false, currentWork: '개발' }, { consent: 'true' }, { currentWork: '개발' }]) {
        const e = await expectServiceError(putMyDirectoryEntry(tx, w.member, room.slug, body, at(1)), 'VALIDATION')
        expect(e.fields).toMatchObject({ consent: 'required' })
      }
      expect(await rowsOf(tx, room.slug)).toHaveLength(0)

      const saved = await putMyDirectoryEntry(tx, w.member, room.slug, { ...CONSENT, cohortLabel: '12기', currentWork: '백엔드 개발', interests: ['AI', '등산'], contactMethod: '방 오픈채팅으로' }, at(2))
      expect(saved.entry).toMatchObject({ name: '실명멤버', cohortLabel: '12기', currentWork: '백엔드 개발', interests: ['AI', '등산'], contactMethod: '방 오픈채팅으로', mine: true })
      const page = await listDirectory(tx, w.quiet, room.slug, {}, at(3))
      expect(page.entries.map((e) => e.name)).toEqual(['실명멤버'])
      expect(page.mine).toBeNull()
      expect(page.entries[0]!.mine).toBe(false)
      // 동의하지 않은 멤버(방장·운영진·조용)는 명부에 없고 행도 없습니다.
      const rows = await rowsOf(tx, room.slug)
      expect(rows.map((r) => r.userId)).toEqual([w.member.userId])
      expect(rows[0]!.consentedAt).toEqual(at(2))
      // 응답에는 사람 id·계정 표시 이름·페르소나 이름이 없습니다.
      const text = JSON.stringify(page)
      for (const leak of [w.member.userId, '계정멤버', '페르소나멤버']) expect(text).not.toContain(leak)
    })
  })

  it('every field can be emptied individually; saving again keeps consented_at and replaces the values', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'real')
      await putMyDirectoryEntry(tx, w.member, room.slug, { ...CONSENT, cohortLabel: '12기', currentWork: '개발', interests: ['AI'], contactMethod: '메일' }, at(1))
      const steps: Array<[Record<string, unknown>, Record<string, unknown>]> = [
        [{ cohortLabel: null, currentWork: '개발', interests: ['AI'], contactMethod: '메일' }, { cohortLabel: null, currentWork: '개발', interests: ['AI'], contactMethod: '메일' }],
        [{ currentWork: '', interests: ['AI'], contactMethod: '메일' }, { cohortLabel: null, currentWork: null, interests: ['AI'], contactMethod: '메일' }],
        [{ interests: [], contactMethod: '메일' }, { cohortLabel: null, currentWork: null, interests: [], contactMethod: '메일' }],
        [{ contactMethod: '  ' }, { cohortLabel: null, currentWork: null, interests: [], contactMethod: null }],
      ]
      for (const [i, [body, expected]] of steps.entries()) {
        const r = await putMyDirectoryEntry(tx, w.member, room.slug, { ...CONSENT, ...body }, at(2 + i))
        expect(r.entry).toMatchObject(expected)
      }
      // 모두 비워도 동의는 유효합니다(이름만 올림).
      const [row] = await rowsOf(tx, room.slug)
      expect(row).toMatchObject({ cohortLabel: null, currentWork: null, interests: [], contactMethod: null, consentedAt: at(1), updatedAt: at(5) })
      expect((await listDirectory(tx, w.owner, room.slug, {}, at(6))).entries).toEqual([expect.objectContaining({ name: '실명멤버', interests: [] })])
      // 길이·개수 상한.
      const e = await expectServiceError(
        putMyDirectoryEntry(tx, w.member, room.slug, { ...CONSENT, currentWork: 'x'.repeat(61), contactMethod: 'y'.repeat(101), interests: ['a', 'b', 'c', 'd', 'e', 'f'] }, at(7)),
        'VALIDATION',
      )
      expect(e.fields).toEqual({ currentWork: 'too_long', contactMethod: 'too_long', interests: 'too_many' })
      // 감사 기록에는 값이 없습니다(채운 항목 수·새 동의 여부만).
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.directory_consent'), eq(auditEvents.actorId, w.member.userId)))
      expect(audits).toHaveLength(5)
      expect(audits.map((a) => a.metadata)).toEqual(expect.arrayContaining([{ created: true, filled: 4 }, { created: false, filled: 0 }]))
      expect(JSON.stringify(audits)).not.toMatch(/12기|개발|메일|AI/)
    })
  })

  it('withdrawal, leaving and being removed delete the row immediately; withdrawal is idempotent and works in archived rooms', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'display')
      for (const p of [w.owner, w.admin, w.member, w.quiet]) await putMyDirectoryEntry(tx, p, room.slug, { ...CONSENT, currentWork: '일' }, at(1))
      expect(await rowsOf(tx, room.slug)).toHaveLength(4)

      expect(await withdrawMyDirectoryEntry(tx, w.quiet, room.slug, at(2))).toEqual({ entry: null, withdrawn: true })
      expect(await withdrawMyDirectoryEntry(tx, w.quiet, room.slug, at(3))).toEqual({ entry: null, withdrawn: false })
      await leaveSpace(tx, w.member, room.slug, at(4))
      await changeMemberRole(tx, w.owner, room.slug, await memberRef(tx, room.slug, w.admin.userId), { role: 'member' }, at(4))
      await removeMember(tx, w.owner, room.slug, await memberRef(tx, room.slug, w.admin.userId), at(5))
      expect((await rowsOf(tx, room.slug)).map((r) => r.userId)).toEqual([w.owner.userId])
      // 철회 기록은 원인만.
      const withdrawals = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'community.directory_withdraw'), eq(auditEvents.actorId, w.quiet.userId)))
      expect(withdrawals.map((a) => a.metadata)).toEqual([{ cause: 'self' }])

      // 보관된 방: 읽기·철회는 되고 동의·바꾸기는 409.
      await archiveSpaceInTx(tx, await spaceIdOf(tx, room.slug), at(6))
      expect((await listDirectory(tx, w.owner, room.slug, {}, at(7))).writable).toBe(false)
      await expectServiceError(putMyDirectoryEntry(tx, w.owner, room.slug, { ...CONSENT }, at(7)), 'CONFLICT', 'space_not_active')
      expect((await withdrawMyDirectoryEntry(tx, w.owner, room.slug, at(8))).withdrawn).toBe(true)
      expect(await rowsOf(tx, room.slug)).toHaveLength(0)
    })
  })

  it('members of alumni rooms only: non-members, unknown rooms, general rooms → 404; flag off → 404 except withdrawal; anonymous rooms → 409 and switching to anonymous deletes rows', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'display')
      await putMyDirectoryEntry(tx, w.member, room.slug, { ...CONSENT }, at(1))
      for (const call of [
        () => listDirectory(tx, w.outsider, room.slug, {}, at(2)),
        () => putMyDirectoryEntry(tx, w.outsider, room.slug, { ...CONSENT }, at(2)),
        () => withdrawMyDirectoryEntry(tx, w.outsider, room.slug, at(2)),
        () => listDirectory(tx, w.member, 'no-such-room', {}, at(2)),
      ]) {
        await expectServiceError(call(), 'NOT_FOUND')
      }
      const general = await alumniRoom(tx, w, 'display', 'general')
      await expectServiceError(listDirectory(tx, w.member, general.slug, {}, at(2)), 'NOT_FOUND')
      await expectServiceError(putMyDirectoryEntry(tx, w.member, general.slug, { ...CONSENT }, at(2)), 'NOT_FOUND')

      // 플래그 꺼짐: 읽기·쓰기 404, 행은 남음(다시 켜면 보임).
      setFeatureEnvForTesting({})
      await expectServiceError(listDirectory(tx, w.member, room.slug, {}, at(3)), 'NOT_FOUND')
      await expectServiceError(putMyDirectoryEntry(tx, w.member, room.slug, { ...CONSENT }, at(3)), 'NOT_FOUND')
      expect(await rowsOf(tx, room.slug)).toHaveLength(1)
      // 동의 철회는 플래그와 무관(ADR 0060 D-02), 멤버 확인은 그대로. 공간 상세가 남은 항목을 알려 주어 화면에서 지울 수 있습니다.
      expect((await getSpaceDetail(tx, w.member, room.slug, at(3))).leftoverAlumniData).toEqual({ directoryEntry: true, roomProfile: false })
      expect((await getSpaceDetail(tx, w.owner, room.slug, at(3))).leftoverAlumniData).toEqual({ directoryEntry: false, roomProfile: false })
      await expectServiceError(withdrawMyDirectoryEntry(tx, w.outsider, room.slug, at(3)), 'NOT_FOUND')
      await expectServiceError(withdrawMyDirectoryEntry(tx, w.member, general.slug, at(3)), 'NOT_FOUND')
      expect(await withdrawMyDirectoryEntry(tx, w.member, room.slug, at(3))).toEqual({ entry: null, withdrawn: true })
      expect(await rowsOf(tx, room.slug)).toHaveLength(0)
      expect((await withdrawMyDirectoryEntry(tx, w.member, room.slug, at(3))).withdrawn).toBe(false)
      expect((await getSpaceDetail(tx, w.member, room.slug, at(3))).leftoverAlumniData).toEqual({ directoryEntry: false, roomProfile: false })
      setFeatureEnvForTesting(ON)
      expect((await getSpaceDetail(tx, w.member, room.slug, at(3))).leftoverAlumniData).toBeUndefined()
      await putMyDirectoryEntry(tx, w.member, room.slug, { ...CONSENT }, at(3))
      // 나가기 삭제는 플래그와 무관.
      setFeatureEnvForTesting({})
      await leaveSpace(tx, w.member, room.slug, at(3))
      expect(await rowsOf(tx, room.slug)).toHaveLength(0)
      setFeatureEnvForTesting(ON)

      // 익명 방에는 명부가 없습니다(이름 없는 명부 금지).
      const anon = await alumniRoom(tx, w, 'anonymous')
      await expectServiceError(listDirectory(tx, w.member, anon.slug, {}, at(4)), 'CONFLICT', 'directory_unavailable')
      await expectServiceError(putMyDirectoryEntry(tx, w.member, anon.slug, { ...CONSENT }, at(4)), 'CONFLICT', 'directory_unavailable')
      expect(await rowsOf(tx, anon.slug)).toHaveLength(0)

      // 표시명 → 익명 예약: 효력 시각이 지나면(worker 적용 전에도) 409, 적용하면 행을 지웁니다.
      const display = await alumniRoom(tx, w, 'display')
      await putMyDirectoryEntry(tx, w.quiet, display.slug, { ...CONSENT, contactMethod: '연락처' }, at(5))
      const state = await scheduleNameModeChange(tx, w.owner, display.slug, { toMode: 'anonymous' }, at(6))
      const after = new Date(at(6).getTime() + NAME_MODE_CHANGE_DELAY_MS + 60_000)
      await expectServiceError(listDirectory(tx, w.quiet, display.slug, {}, after), 'CONFLICT', 'directory_unavailable')
      expect((await withdrawMyDirectoryEntry(tx, w.admin, display.slug, after)).withdrawn).toBe(false) // 철회는 익명 방에서도 됨
      await applyNameModeChange(tx, state.pending!.id, { now: after })
      expect(await rowsOf(tx, display.slug)).toHaveLength(0)
    })
  })

  it('names follow the room profile rules: real room → real name, display room → room profile name (or the missing label)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const display = await alumniRoom(tx, w, 'display')
      await putMyDirectoryEntry(tx, w.member, display.slug, { ...CONSENT }, at(1))
      await putMyDirectoryEntry(tx, w.quiet, display.slug, { ...CONSENT }, at(2))
      await putMyRoomProfile(tx, w.member, display.slug, { displayName: '12기 김지민' }, at(3))
      const page = await listDirectory(tx, w.owner, display.slug, {}, at(4))
      expect(page.nameMode).toBe('display')
      expect(page.entries.map((e) => e.name)).toEqual(['12기 김지민', '방별 이름 없음'])
      expect(JSON.stringify(page)).not.toMatch(/실명|계정|페르소나/)
    })
  })

  it('pages are small (≤ 20), there is no fetch-all, and paging quickly hits the per-user rate limit (scenario X)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const room = await alumniRoom(tx, w, 'real')
      for (const [i, p] of [w.owner, w.admin, w.member, w.quiet].entries()) await putMyDirectoryEntry(tx, p, room.slug, { ...CONSENT, currentWork: `일${i}` }, at(i))
      const p1 = await listDirectory(tx, w.member, room.slug, { page: '1', pageSize: '3' }, at(5))
      const p2 = await listDirectory(tx, w.member, room.slug, { page: '2', pageSize: '3' }, at(5))
      expect(p1.entries.map((e) => e.currentWork)).toEqual(['일0', '일1', '일2'])
      expect(p1.hasNext).toBe(true)
      expect(p2.entries.map((e) => e.currentWork)).toEqual(['일3'])
      expect(p2.hasNext).toBe(false)
      expect(p2.mine).toMatchObject({ name: '실명멤버', mine: true })
      // 쪽 크기 상한·“전부 가져오기”·다른 형식은 422(rate limit을 세지 않음).
      for (const q of [{ pageSize: String(DIRECTORY_PAGE_SIZE + 1) }, { pageSize: '100000' }, { all: 'true' }, { limit: '1000' }, { format: 'csv' }, { export: '1' }, { page: '0' }]) {
        await expectServiceError(listDirectory(tx, w.member, room.slug, q, at(5)), 'VALIDATION')
      }
      // 이미 2쪽을 봤으므로 18쪽 더 보면 한도, 그다음은 429.
      for (let i = 0; i < DIRECTORY_PAGE_VIEW_LIMIT.limit - 2; i++) await listDirectory(tx, w.member, room.slug, { page: String((i % 3) + 1), pageSize: '2' }, at(6))
      await expectServiceError(listDirectory(tx, w.member, room.slug, {}, at(7)), 'RATE_LIMITED', 'rate_limited')
      // 다른 멤버는 따로 셉니다. 창이 지나면 다시 볼 수 있습니다.
      expect((await listDirectory(tx, w.quiet, room.slug, {}, at(7))).entries).toHaveLength(4)
      expect((await listDirectory(tx, w.member, room.slug, {}, at(11))).entries).toHaveLength(4)
    })
  })
})

describe('A-03 no export paths for the member directory', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const webRoot = join(here, '..')
  const apiRoot = join(webRoot, 'server', 'api')
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name)
      return statSync(p).isDirectory() ? walk(p) : [p]
    })

  it('the only directory routes are the paged list and my own entry (no csv/pdf/export/all/bulk route anywhere)', () => {
    const routes = walk(apiRoot).map((p) => relative(apiRoot, p))
    const directoryRoutes = routes.filter((r) => /director/i.test(r)).sort()
    expect(directoryRoutes).toEqual([
      'v1/community/spaces/[slug]/directory/index.get.ts',
      'v1/community/spaces/[slug]/directory/me.delete.ts',
      'v1/community/spaces/[slug]/directory/me.put.ts',
    ])
    for (const r of directoryRoutes) expect(r).not.toMatch(/csv|pdf|export|download|bulk|all/i)
    // 명부 행을 읽는 서버 코드는 명부 모듈뿐(검색·추천·피드·공개 프로필은 읽지 않음). worker는 삭제(탈퇴·익명 전환)만.
    // A-07(ADR 0045): 신고된 명부 항목 하나를 판정·숨기고 운영자 상세에 싣는 방 항목 신고 모듈(항목 id로 한 행씩, 목록·내보내기 없음).
    const readers = walk(join(webRoot, 'server'))
      .filter((p) => p.endsWith('.ts') && readFileSync(p, 'utf8').includes('directoryEntries'))
      .map((p) => relative(webRoot, p))
    expect(readers.sort()).toEqual(['server/modules/community/member-directory.ts', 'server/modules/community/room-item-reports.ts'])
    const workerSrc = join(webRoot, '..', 'worker', 'src')
    const workerUsers = walk(workerSrc)
      .filter((p) => p.endsWith('.ts') && readFileSync(p, 'utf8').includes('directoryEntries'))
      .map((p) => relative(workerSrc, p))
      .sort()
    expect(workerUsers).toEqual(['ops/name-modes.ts', 'ops/purge.ts'])
    for (const file of workerUsers) {
      const uses = readFileSync(join(workerSrc, file), 'utf8').match(/[^\n]*directoryEntries[^\n]*/g) ?? []
      for (const line of uses.filter((l) => !/^\s*directoryEntries,$/.test(l))) expect(line).toMatch(/delete\(directoryEntries\)/)
    }
  })
})
