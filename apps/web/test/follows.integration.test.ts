/**
 * S-04 팔로우·비공개 계정·차단·뮤트 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * DELIVERY_PLAN §5.2 시나리오 T(비공개 계정과 팔로우)·U(차단)와 R의 "표시명으로 팔로우해도 상대의 팔로워 목록에는 표시명만" 줄,
 * SYSTEM_DESIGN §8.3 권한 표(팔로우 요청·팔로워 승인·삭제·차단·뮤트·팔로우 목록 줄), ADR 0033.
 */
import { createApp, createRouter, toWebHandler } from 'h3'
import { afterAll, describe, expect, it } from 'vitest'
import { FOLLOW_RATE_LIMIT } from '@peerchive/domain'
import { and, auditEvents, blocks, eq, follows, mutes, schools, sql, type DbExecutor } from '@peerchive/db'
import { joinSpace } from '../server/modules/community/memberships'
import { createPost, getPost, listBoardPosts } from '../server/modules/community/posts'
import { createRoom } from '../server/modules/community/spaces'
import { updateRealName, upsertProfile } from '../server/modules/identity/profiles'
import { createPublicProfileHandler } from '../server/modules/portfolio/public-http'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createProject } from '../server/modules/projects/projects'
import { hitRateLimit } from '../server/modules/security/rate-limit'
import { createBlock, createMute, listMyBlocks, listMyMutes, removeBlock, removeMute } from '../server/modules/social/blocks'
import {
  approveFollowRequest,
  followProfile,
  getFollowList,
  getMyFollows,
  getProfileSocial,
  rejectFollowRequest,
  removeFollower,
  resolvePendingRequests,
  unfollowProfile,
} from '../server/modules/social/follows'
import { createDisplayPersona, listMyPersonas, setIdentityLink, updatePersona } from '../server/modules/social/personas'
import { getProfileProjects, setProjectListing, setVisibility } from '../server/modules/social/visibility'
import { closeTestDb, createUser, databaseUrl, expectServiceError, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-20T09:00:00Z')
const tag = () => crypto.randomUUID().slice(0, 8)

interface Person {
  user: { id: string }
  actor: { userId: string }
  name: string
  realHandle: string
  realId: string
  display: { id: string; handle: string; name: string } | null
}

/** 실명 프로필(온보딩) + 선택으로 표시명 프로필(연결은 기본 비공개). */
async function person(db: DbExecutor, label: string, opts: { display?: boolean } = {}): Promise<Person> {
  const t = tag()
  const name = `${label}${t}`
  const user = await createUser(db, { displayName: '임시' })
  const actor = { userId: user.id }
  const realHandle = `f-${t}`
  await upsertProfile(db, actor, { handle: realHandle, displayName: name, headline: `${name} 소개` })
  const realId = (await listMyPersonas(db, actor)).personas.find((p) => p.kind === 'real')!.id
  let display: Person['display'] = null
  if (opts.display) {
    const handle = `fd-${t}`
    const dName = `밤의별명${t}`
    const created = await createDisplayPersona(db, actor, { handle, displayName: dName }, T0)
    display = { id: created.id, handle, name: dName }
  }
  return { user, actor, name, realHandle, realId, display }
}

const follow = (db: DbExecutor, who: Person, handle: string, as = who.realId, now = T0) => followProfile(db, who.actor, handle, { as }, now)

/** 공개 프로필 JSON(쿠키 없는 HTTP 경로)의 원문. */
async function publicJson(db: DbExecutor, handle: string): Promise<string> {
  const deps = { getDb: () => db, now: () => T0, getEnv: () => ({}) }
  const web = toWebHandler(createApp().use(createRouter().get('/api/v1/public/profiles/:handle', createPublicProfileHandler(deps))))
  const res = await web(new Request(`http://localhost:3000/api/v1/public/profiles/${handle}`))
  expect(res.status).toBe(200)
  return res.text()
}

/** public 스키마의 모든 표 행 수. 알림·outbox·공지 등 "다른 어떤 표에도 행이 생기지 않음"을 보려고 씁니다. */
async function tableCounts(db: DbExecutor): Promise<Map<string, number>> {
  const tables = (await db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  )) as unknown as Array<{ table_name: string }>
  const query = tables.map((t) => `select '${t.table_name}' as t, count(*)::int as n from public."${t.table_name}"`).join(' union all ')
  const rows = (await db.execute(sql.raw(query))) as unknown as Array<{ t: string; n: number }>
  return new Map(rows.map((r) => [r.t, r.n]))
}

/** 두 스냅숏 사이에 행 수가 바뀐 표와 변화량. */
function changed(before: Map<string, number>, after: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [t, n] of after) if (n !== (before.get(t) ?? 0)) out[t] = n - (before.get(t) ?? 0)
  return out
}

describe.skipIf(!databaseUrl)('S-04 시나리오 T: 비공개 계정과 팔로우', () => {
  afterAll(closeTestDb)

  it('비공개 계정: 요청은 pending, 승인 전에는 기본 정보만, 승인 뒤 approved_followers 범위의 과제 목록·팔로우 목록이 보임', async () => {
    await withRollback(async (tx) => {
      const B = await person(tx, '김비공개')
      const A = await person(tx, '박요청')
      const stranger = await person(tx, '최남')
      await updatePersona(tx, B.actor, B.realId, { accountPrivacy: 'private' }, T0)
      await setVisibility(tx, B.actor, B.realId, { items: { project_list: 'public', follow_lists: 'public' } }, T0)
      const project = await createProject(tx, B.actor, { title: `비공개 계정 과제 ${tag()}`, kind: 'individual' }, T0)
      await setProjectListing(tx, B.actor, B.realId, { projectId: project.id, shown: true }, T0)

      expect(await follow(tx, A, B.realHandle)).toEqual({ status: 'pending' })
      // 같은 요청은 그대로(두 번째 행 없음).
      expect(await follow(tx, A, B.realHandle)).toEqual({ status: 'pending' })
      expect(await tx.select().from(follows).where(eq(follows.followeePersonaId, B.realId))).toHaveLength(1)

      // 승인 전: 기본 정보(관계 정보)는 보이고, 과제 목록·팔로우 목록은 없음.
      const before = await getProfileSocial(tx, A.actor, B.realHandle)
      expect(before).toMatchObject({ accountPrivacy: 'private', followListsVisible: false, isOwner: false })
      expect(before.viewer!.personas.find((p) => p.personaId === A.realId)!.follow).toBe('pending')
      expect((await getProfileProjects(tx, A.actor, B.realHandle, T0)).projects).toBeNull()
      expect(await getFollowList(tx, A.actor, B.realHandle, 'followers')).toEqual({ entries: null })

      // 주인이 받은 요청을 보고 승인.
      const mine = await getMyFollows(tx, B.actor, B.realId)
      expect(mine.incoming.map((e) => e.handle)).toEqual([A.realHandle])
      expect(mine.followers).toEqual([])
      expect((await listMyPersonas(tx, B.actor)).personas.find((p) => p.id === B.realId)!.pendingFollowRequests).toBe(1)
      expect(await approveFollowRequest(tx, B.actor, mine.incoming[0]!.id, T0)).toEqual({ status: 'active' })

      // 승인 뒤: approved_followers 범위가 열림. 다른 로그인 사용자·비로그인 공개 경로는 그대로.
      expect((await getProfileProjects(tx, A.actor, B.realHandle, T0)).projects).toEqual([{ courseTitle: null, termLabel: null, title: project.title }])
      expect(await getFollowList(tx, A.actor, B.realHandle, 'followers')).toEqual({ entries: [{ kind: 'real', handle: A.realHandle, displayName: A.name }] })
      expect((await getProfileSocial(tx, A.actor, B.realHandle)).followListsVisible).toBe(true)
      expect((await getProfileProjects(tx, stranger.actor, B.realHandle, T0)).projects).toBeNull()
      expect(await getFollowList(tx, stranger.actor, B.realHandle, 'followers')).toEqual({ entries: null })
      expect(await getFollowList(tx, null, B.realHandle, 'followers')).toEqual({ entries: null })
      expect((await getPublicPortfolioProfile(tx, B.realHandle, T0)).projects).toBeNull()
      // 본인은 늘.
      expect((await getFollowList(tx, B.actor, B.realHandle, 'followers')).entries).toHaveLength(1)

      // 팔로워를 삭제하면 다음 요청부터 다시 기본 정보만.
      await removeFollower(tx, B.actor, mine.incoming[0]!.id)
      expect((await getProfileProjects(tx, A.actor, B.realHandle, T0)).projects).toBeNull()
    })
  })

  it('공개 계정은 바로 active이고, 거절은 행 삭제', async () => {
    await withRollback(async (tx) => {
      const B = await person(tx, '김공개')
      const A = await person(tx, '박팔로')
      const C = await person(tx, '이거절')
      expect(await follow(tx, A, B.realHandle)).toEqual({ status: 'active' })
      const [row] = await tx.select().from(follows).where(eq(follows.followerPersonaId, A.realId))
      expect(row).toMatchObject({ status: 'active', followerUserId: A.user.id, followeeUserId: B.user.id })
      expect(row!.approvedAt).toEqual(T0)
      // 언팔로우(행 삭제)
      expect(await unfollowProfile(tx, A.actor, B.realHandle, A.realId)).toEqual({ status: 'none' })
      expect(await tx.select().from(follows).where(eq(follows.followerPersonaId, A.realId))).toHaveLength(0)

      await updatePersona(tx, B.actor, B.realId, { accountPrivacy: 'private' }, T0)
      await follow(tx, C, B.realHandle)
      const [req] = (await getMyFollows(tx, B.actor, B.realId)).incoming
      expect(await rejectFollowRequest(tx, B.actor, req!.id)).toEqual({ status: 'none' })
      expect(await tx.select().from(follows).where(eq(follows.followeePersonaId, B.realId))).toHaveLength(0)
      // 이미 처리된 요청·active 행에 approve/reject는 404.
      await expectServiceError(rejectFollowRequest(tx, B.actor, req!.id), 'NOT_FOUND')
      await expectServiceError(approveFollowRequest(tx, B.actor, req!.id), 'NOT_FOUND')
    })
  })

  it('비공개 → 공개로 바꿔도 대기 요청은 자동 승인되지 않고, 주인이 모두 승인·모두 거절을 고름', async () => {
    await withRollback(async (tx) => {
      const B = await person(tx, '김전환')
      const [A, C, D] = [await person(tx, '박하나'), await person(tx, '이둘'), await person(tx, '최셋')]
      await updatePersona(tx, B.actor, B.realId, { accountPrivacy: 'private' }, T0)
      await follow(tx, A, B.realHandle)
      await follow(tx, C, B.realHandle)

      const switched = await updatePersona(tx, B.actor, B.realId, { accountPrivacy: 'public' }, T0)
      expect(switched).toMatchObject({ accountPrivacy: 'public', pendingFollowRequests: 2 })
      const statuses = async () => (await tx.select({ s: follows.status }).from(follows).where(eq(follows.followeePersonaId, B.realId))).map((r) => r.s).sort()
      expect(await statuses()).toEqual(['pending', 'pending'])
      // 공개 계정이 된 뒤의 새 팔로우는 바로 active. 남은 요청은 그대로(아무것도 고르지 않으면 "그대로 두기").
      expect(await follow(tx, D, B.realHandle)).toEqual({ status: 'active' })
      expect((await getProfileProjects(tx, A.actor, B.realHandle, T0)).projects).toBeNull()

      await expectServiceError(resolvePendingRequests(tx, B.actor, B.realId, { action: 'everything' }), 'VALIDATION')
      await expectServiceError(resolvePendingRequests(tx, A.actor, B.realId, { action: 'approve_all' }), 'NOT_FOUND')
      const approved = await resolvePendingRequests(tx, B.actor, B.realId, { action: 'approve_all' }, T0)
      expect(approved.incoming).toEqual([])
      expect(approved.followers.map((f) => f.handle).sort()).toEqual([A.realHandle, C.realHandle, D.realHandle].sort())
      expect(await statuses()).toEqual(['active', 'active', 'active'])

      // 모두 거절: 행 삭제.
      await updatePersona(tx, B.actor, B.realId, { accountPrivacy: 'private' }, T0)
      const E = await person(tx, '정넷')
      await follow(tx, E, B.realHandle)
      const rejected = await resolvePendingRequests(tx, B.actor, B.realId, { action: 'reject_all' }, T0)
      expect(rejected.incoming).toEqual([])
      expect(await tx.select().from(follows).where(eq(follows.followerPersonaId, E.realId))).toHaveLength(0)
    })
  })

  it('팔로워 삭제·요청 거절·언팔로우·차단·뮤트는 follows·blocks·mutes·감사(차단만) 말고 어떤 표에도 행을 만들지 않음(알림·outbox·공지 0건)', async () => {
    await withRollback(async (tx) => {
      const B = await person(tx, '김주인')
      const A = await person(tx, '박팔로워')
      const C = await person(tx, '이요청')
      await follow(tx, A, B.realHandle)
      const followerId = (await getMyFollows(tx, B.actor, B.realId)).followers[0]!.id

      let snap = await tableCounts(tx)
      await removeFollower(tx, B.actor, followerId)
      expect(changed(snap, await tableCounts(tx))).toEqual({ follows: -1 })

      await updatePersona(tx, B.actor, B.realId, { accountPrivacy: 'private' }, T0)
      await follow(tx, C, B.realHandle)
      const requestId = (await getMyFollows(tx, B.actor, B.realId)).incoming[0]!.id
      snap = await tableCounts(tx)
      await rejectFollowRequest(tx, B.actor, requestId)
      expect(changed(snap, await tableCounts(tx))).toEqual({ follows: -1 })

      await follow(tx, C, B.realHandle)
      snap = await tableCounts(tx)
      await approveFollowRequest(tx, B.actor, (await getMyFollows(tx, B.actor, B.realId)).incoming[0]!.id, T0)
      await unfollowProfile(tx, C.actor, B.realHandle, C.realId)
      expect(changed(snap, await tableCounts(tx))).toEqual({ follows: -1 })

      await follow(tx, A, C.realHandle)
      snap = await tableCounts(tx)
      await createBlock(tx, C.actor, { handle: A.realHandle, as: C.realId }, T0)
      expect(changed(snap, await tableCounts(tx))).toEqual({ blocks: 1, follows: -1, audit_events: 1 })
      snap = await tableCounts(tx)
      await createMute(tx, B.actor, { handle: A.realHandle }, T0)
      expect(changed(snap, await tableCounts(tx))).toEqual({ mutes: 1 })
    })
  })

  it('show_follower_count를 끄면 공개 응답에 팔로워 수 키 자체가 없고, 본인에게만 보임', async () => {
    await withRollback(async (tx) => {
      const B = await person(tx, '김숫자')
      const A = await person(tx, '박하나')
      const C = await person(tx, '이둘')
      await follow(tx, A, B.realHandle)
      await follow(tx, B, C.realHandle)

      const on = await getPublicPortfolioProfile(tx, B.realHandle, T0)
      expect(on.followCounts).toEqual({ followers: 1, following: 1 })
      expect(JSON.parse(await publicJson(tx, B.realHandle)).followCounts).toEqual({ followers: 1, following: 1 })
      expect((await getProfileSocial(tx, A.actor, B.realHandle)).followCounts).toEqual({ followers: 1, following: 1 })

      await updatePersona(tx, B.actor, B.realId, { showFollowerCount: false }, T0)
      const off = await getPublicPortfolioProfile(tx, B.realHandle, T0)
      expect('followCounts' in off).toBe(false)
      const raw = await publicJson(tx, B.realHandle)
      expect(raw).not.toContain('followCounts')
      expect(raw).not.toContain('"followers"')
      for (const viewer of [null, A.actor, C.actor]) {
        const social = await getProfileSocial(tx, viewer, B.realHandle)
        expect('followCounts' in social, String(viewer?.userId)).toBe(false)
        expect(JSON.stringify(social)).not.toContain('followers')
      }
      expect((await getProfileSocial(tx, B.actor, B.realHandle)).followCounts).toEqual({ followers: 1, following: 1 })
    })
  })

  it('자기 페르소나(같은 사용자의 다른 페르소나 포함)는 API 409·DB check로 팔로우 불가, 주체 페르소나는 내 것만', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김자기', { display: true })
      const B = await person(tx, '박남')
      await expectServiceError(follow(tx, A, A.realHandle), 'CONFLICT', 'own_persona')
      await expectServiceError(follow(tx, A, A.display!.handle), 'CONFLICT', 'own_persona')
      await expectServiceError(follow(tx, A, A.realHandle, A.display!.id), 'CONFLICT', 'own_persona')
      // DB: 같은 사용자 두 페르소나 사이 행은 check 위반.
      await expect(
        tx.transaction((inner) =>
          inner.insert(follows).values({ followerPersonaId: A.display!.id, followerUserId: A.user.id, followeePersonaId: A.realId, followeeUserId: A.user.id }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } })
      // DB: 사용자 사본 열을 속이면 복합 외래 키 위반.
      await expect(
        tx.transaction((inner) =>
          inner.insert(follows).values({ followerPersonaId: A.display!.id, followerUserId: B.user.id, followeePersonaId: A.realId, followeeUserId: A.user.id }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23503' } })
      // 주체 페르소나가 남의 것·형식 아님·없음이면 422 as.
      for (const body of [{ as: B.realId }, { as: 'nope' }, {}, null, { as: crypto.randomUUID() }])
        expect((await expectServiceError(followProfile(tx, A.actor, B.realHandle, body, T0), 'VALIDATION')).fields).toEqual({ as: 'invalid' })
      // 없는 handle 404.
      await expectServiceError(follow(tx, A, 'no-such-handle-x'), 'NOT_FOUND')
    })
  })

  it('팔로우 요청 생성 한도(사용자당)를 넘으면 429, 이미 있는 팔로우는 세지 않음', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김한도')
      const B = await person(tx, '박하나')
      const C = await person(tx, '이둘')
      await follow(tx, A, B.realHandle)
      for (let i = 1; i < FOLLOW_RATE_LIMIT.limit; i++) await hitRateLimit(tx, 'follow_create', A.user.id, FOLLOW_RATE_LIMIT, T0)
      expect(await follow(tx, A, B.realHandle)).toEqual({ status: 'active' })
      await expectServiceError(follow(tx, A, C.realHandle), 'RATE_LIMITED')
    })
  })

  it('follow_lists가 private이면 목록은 본인만, public이면 비로그인도(handle·이름·종류만)', async () => {
    await withRollback(async (tx) => {
      const B = await person(tx, '김목록')
      const A = await person(tx, '박하나')
      await follow(tx, A, B.realHandle)
      // 기본값 private
      for (const dir of ['followers', 'following'] as const) {
        expect(await getFollowList(tx, null, B.realHandle, dir)).toEqual({ entries: null })
        expect(await getFollowList(tx, A.actor, B.realHandle, dir)).toEqual({ entries: null })
      }
      expect((await getFollowList(tx, B.actor, B.realHandle, 'followers')).entries).toHaveLength(1)
      expect((await getProfileSocial(tx, A.actor, B.realHandle)).followListsVisible).toBe(false)
      await setVisibility(tx, B.actor, B.realId, { items: { follow_lists: 'public' } }, T0)
      const list = await getFollowList(tx, null, B.realHandle, 'followers')
      expect(list).toEqual({ entries: [{ kind: 'real', handle: A.realHandle, displayName: A.name }] })
      expect(await getFollowList(tx, null, A.realHandle, 'following')).toEqual({ entries: null })
    })
  })

  it('남의 관리 API는 모두 404', async () => {
    await withRollback(async (tx) => {
      const B = await person(tx, '김주인')
      const A = await person(tx, '박하나')
      const X = await person(tx, '최남')
      await updatePersona(tx, B.actor, B.realId, { accountPrivacy: 'private' }, T0)
      await follow(tx, A, B.realHandle)
      const reqId = (await getMyFollows(tx, B.actor, B.realId)).incoming[0]!.id
      await expectServiceError(getMyFollows(tx, X.actor, B.realId), 'NOT_FOUND')
      await expectServiceError(getMyFollows(tx, B.actor, 'x'), 'NOT_FOUND')
      await expectServiceError(approveFollowRequest(tx, X.actor, reqId), 'NOT_FOUND')
      // 요청을 보낸 사람도 승인할 수 없음(받은 사람만).
      await expectServiceError(approveFollowRequest(tx, A.actor, reqId), 'NOT_FOUND')
      await expectServiceError(rejectFollowRequest(tx, X.actor, reqId), 'NOT_FOUND')
      await expectServiceError(removeFollower(tx, X.actor, reqId), 'NOT_FOUND')
      await expectServiceError(removeFollower(tx, A.actor, reqId), 'NOT_FOUND')
      await expectServiceError(resolvePendingRequests(tx, X.actor, B.realId, { action: 'reject_all' }), 'NOT_FOUND')
      const block = await createBlock(tx, B.actor, { handle: X.realHandle, as: B.realId }, T0)
      await expectServiceError(removeBlock(tx, X.actor, block.id), 'NOT_FOUND')
      await expectServiceError(removeBlock(tx, A.actor, 'nope'), 'NOT_FOUND')
      const mute = await createMute(tx, B.actor, { handle: A.realHandle }, T0)
      await expectServiceError(removeMute(tx, A.actor, mute.id), 'NOT_FOUND')
      expect(await tx.select().from(follows).where(eq(follows.id, reqId))).toHaveLength(1)
    })
  })
})

describe.skipIf(!databaseUrl)('S-04 시나리오 R·U: 표시명 팔로우와 차단', () => {
  afterAll(closeTestDb)

  it('표시명으로 팔로우하면 상대의 팔로워 목록·관계 정보에 표시명만 보이고 실명 페르소나·이름·id는 없음', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김실명', { display: true })
      const B = await person(tx, '박상대', { display: true })
      await setVisibility(tx, B.actor, B.realId, { items: { follow_lists: 'public' } }, T0)
      await setVisibility(tx, A.actor, A.display!.id, { items: { follow_lists: 'public' } }, T0)
      expect(await follow(tx, A, B.realHandle, A.display!.id)).toEqual({ status: 'active' })

      const followers = await getFollowList(tx, null, B.realHandle, 'followers')
      expect(followers).toEqual({ entries: [{ kind: 'display', handle: A.display!.handle, displayName: A.display!.name }] })
      const following = await getFollowList(tx, null, A.display!.handle, 'following')
      expect(following).toEqual({ entries: [{ kind: 'real', handle: B.realHandle, displayName: B.name }] })
      const asB = await getMyFollows(tx, B.actor, B.realId)
      const blob = JSON.stringify([followers, following, asB, await getFollowList(tx, B.actor, B.realHandle, 'followers'), await getProfileSocial(tx, B.actor, B.realHandle)])
      for (const secret of [A.realHandle, A.name, A.realId, A.user.id, A.display!.id, B.display!.handle, B.display!.id, B.user.id])
        expect(blob, secret.slice(0, 12)).not.toContain(secret)
      // 연결을 켜도 팔로우 목록은 연결을 읽지 않음(목록 줄에는 그 페르소나만).
      await setIdentityLink(tx, A.actor, { visible: true }, T0)
      expect(JSON.stringify(await getFollowList(tx, null, B.realHandle, 'followers'))).not.toContain(A.realHandle)
    })
  })

  it('시나리오 U: 표시명 프로필에서 차단 → 그 프로필만 404, 그 대상과의 양방향 팔로우 삭제, 실명 프로필은 all_personas를 고를 때만(연결 비공개면 확인 필요)', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김차단', { display: true })
      const B = await person(tx, '박당함', { display: true })
      for (const id of [A.realId, A.display!.id]) await setVisibility(tx, A.actor, id, { items: { follow_lists: 'public' } }, T0)
      // A 표시명 ↔ B 표시명(양방향), A 실명 ← B 실명, A 표시명 ← B 실명.
      await follow(tx, A, B.display!.handle, A.display!.id)
      await follow(tx, B, A.display!.handle, B.display!.id)
      await follow(tx, B, A.realHandle, B.realId)
      await follow(tx, B, A.display!.handle, B.realId)
      // 차단 전: B는 A의 두 프로필을 봄.
      for (const h of [A.realHandle, A.display!.handle]) await getProfileSocial(tx, B.actor, h)

      // 다른 페르소나가 있고 연결이 비공개: all_personas는 확인 없이 422.
      const e = await expectServiceError(createBlock(tx, A.actor, { handle: B.display!.handle, as: A.display!.id, scope: 'all_personas' }, T0), 'VALIDATION')
      expect(e.fields).toEqual({ confirmLinkInference: 'required' })
      expect(await tx.select().from(blocks).where(eq(blocks.blockerUserId, A.user.id))).toHaveLength(0)

      const snap = await tableCounts(tx)
      const block = await createBlock(tx, A.actor, { handle: B.display!.handle, as: A.display!.id }, T0)
      expect(block).toMatchObject({ target: { kind: 'display', handle: B.display!.handle }, origin: { kind: 'display', handle: A.display!.handle }, scope: 'origin_persona' })
      // 응답·내 차단 목록에는 차단한 그 페르소나뿐: 상대의 실명 페르소나·사용자 id 없음.
      const myBlocks = await listMyBlocks(tx, A.actor)
      for (const secret of [B.realHandle, B.name, B.realId, B.user.id]) {
        expect(JSON.stringify(block), secret.slice(0, 12)).not.toContain(secret)
        expect(JSON.stringify(myBlocks), secret.slice(0, 12)).not.toContain(secret)
      }
      // 팔로우: A 표시명 ↔ B 표시명만 삭제(2행). B 실명과의 팔로우는 남김(지우면 A가 B 실명 = B 표시명임을 알게 됨).
      expect(changed(snap, await tableCounts(tx))).toEqual({ blocks: 1, follows: -2, audit_events: 1 })
      const remaining = await tx.select({ f: follows.followerPersonaId, e: follows.followeePersonaId }).from(follows).where(eq(follows.followerUserId, B.user.id))
      expect(remaining).toEqual(expect.arrayContaining([{ f: B.realId, e: A.realId }, { f: B.realId, e: A.display!.id }]))
      expect(remaining).toHaveLength(2)

      // B(어느 페르소나로 로그인하든 같은 사용자): A 표시명은 프로필·목록·과제 목록·관계 정보·팔로우·뮤트·차단 모두 404.
      await expectServiceError(getProfileSocial(tx, B.actor, A.display!.handle), 'NOT_FOUND')
      await expectServiceError(getProfileProjects(tx, B.actor, A.display!.handle, T0), 'NOT_FOUND')
      for (const dir of ['followers', 'following'] as const) await expectServiceError(getFollowList(tx, B.actor, A.display!.handle, dir), 'NOT_FOUND')
      await expectServiceError(follow(tx, B, A.display!.handle, B.display!.id), 'NOT_FOUND')
      await expectServiceError(follow(tx, B, A.display!.handle, B.realId), 'NOT_FOUND')
      await expectServiceError(unfollowProfile(tx, B.actor, A.display!.handle, B.realId), 'NOT_FOUND')
      await expectServiceError(createMute(tx, B.actor, { handle: A.display!.handle }), 'NOT_FOUND')
      await expectServiceError(createBlock(tx, B.actor, { handle: A.display!.handle, as: B.realId }), 'NOT_FOUND')
      // 비로그인·다른 사람은 그대로 봄.
      await getProfileSocial(tx, null, A.display!.handle)
      // A의 실명 프로필은 B에게 그대로(origin_persona). 목록에서 B는 숨겨진 A 표시명을 보지 않음.
      expect((await getProfileSocial(tx, B.actor, A.realHandle)).isOwner).toBe(false)
      expect((await getFollowList(tx, B.actor, A.realHandle, 'followers')).entries!.map((x) => x.handle)).toEqual([B.realHandle])
      expect((await getMyFollows(tx, B.actor, B.realId)).following.map((x) => x.handle)).toEqual([A.realHandle])

      // 차단한 사람은 바로 그 페르소나를 팔로우할 수 없음(409). 같은 상대의 다른 페르소나는 막지 않음(막으면 연결이 드러남).
      await expectServiceError(follow(tx, A, B.display!.handle, A.realId), 'CONFLICT', 'blocked_by_you')
      expect(await follow(tx, A, B.realHandle, A.realId)).toEqual({ status: 'active' })
      await unfollowProfile(tx, A.actor, B.realHandle, A.realId)

      // 모든 프로필에서: 확인하면 A 실명도 B에게 404. 범위만 바뀌고(같은 행) 숨겨지는 모든 A 페르소나 ↔ B 표시명 팔로우가 지워짐.
      // B 표시명은 아직 A 실명을 팔로우할 수 있음(origin_persona라 A 실명은 숨겨지지 않음).
      expect(await follow(tx, B, A.realHandle, B.display!.id)).toEqual({ status: 'active' })
      const all = await createBlock(tx, A.actor, { handle: B.display!.handle, as: A.display!.id, scope: 'all_personas', confirmLinkInference: true }, T0)
      expect(all.id).toBe(block.id)
      expect(all.scope).toBe('all_personas')
      await expectServiceError(getProfileSocial(tx, B.actor, A.realHandle), 'NOT_FOUND')
      await expectServiceError(getProfileProjects(tx, B.actor, A.realHandle, T0), 'NOT_FOUND')
      await expectServiceError(follow(tx, B, A.realHandle, B.display!.id), 'NOT_FOUND')
      // B 표시명 → A 실명 팔로우는 지워짐, B 실명 → A 실명·A 표시명(차단한 대상 페르소나가 아님)은 남음.
      expect(await tx.select().from(follows).where(eq(follows.followerPersonaId, B.display!.id))).toHaveLength(0)
      expect(await tx.select().from(follows).where(eq(follows.followerPersonaId, B.realId))).toHaveLength(2)

      // 감사: id·종류·범위·확인 플래그만(handle·이름 없음).
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'social.block'), eq(auditEvents.actorId, A.user.id)))
      expect(audits.map((a) => a.metadata)).toEqual([
        { originPersonaId: A.display!.id, originKind: 'display', targetKind: 'display', scope: 'origin_persona', linkConfirmed: false },
        { originPersonaId: A.display!.id, originKind: 'display', targetKind: 'display', scope: 'all_personas', linkConfirmed: true },
      ])
      expect(audits.every((a) => a.targetId === B.display!.id)).toBe(true)
      expect(JSON.stringify(audits)).not.toMatch(new RegExp(`${A.display!.handle}|${B.display!.handle}|${A.name}|${B.name}`))

      // 해제하면 다음 요청부터 다시 보임(지운 팔로우는 되살리지 않음).
      await removeBlock(tx, A.actor, block.id)
      await getProfileSocial(tx, B.actor, A.realHandle)
      await getProfileSocial(tx, B.actor, A.display!.handle)
      expect(await tx.select().from(follows).where(and(eq(follows.followerPersonaId, B.display!.id), eq(follows.followeePersonaId, A.display!.id)))).toHaveLength(0)
      expect((await listMyBlocks(tx, A.actor)).blocks).toEqual([])
    })
  })

  it('연결을 공개했거나 페르소나가 하나면 all_personas에 확인이 필요 없음, 자기 차단·뮤트는 409', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김하나')
      const B = await person(tx, '박둘', { display: true })
      const C = await person(tx, '이셋')
      expect((await createBlock(tx, A.actor, { handle: C.realHandle, as: A.realId, scope: 'all_personas' }, T0)).scope).toBe('all_personas')
      await setIdentityLink(tx, B.actor, { visible: true }, T0)
      expect((await createBlock(tx, B.actor, { handle: C.realHandle, as: B.display!.id, scope: 'all_personas' }, T0)).scope).toBe('all_personas')
      await expectServiceError(createBlock(tx, B.actor, { handle: B.realHandle, as: B.display!.id }), 'CONFLICT', 'own_persona')
      await expectServiceError(createMute(tx, B.actor, { handle: B.display!.handle }), 'CONFLICT', 'own_persona')
      expect((await expectServiceError(createBlock(tx, B.actor, { handle: C.realHandle, as: C.realId }), 'VALIDATION')).fields).toEqual({ as: 'invalid' })
      expect((await expectServiceError(createBlock(tx, B.actor, { handle: C.realHandle, as: B.realId, scope: 'everywhere' }), 'VALIDATION')).fields).toEqual({ scope: 'invalid' })
      // DB: 자기 차단 check.
      await expect(
        tx.transaction((inner) =>
          inner.insert(blocks).values({ blockerUserId: B.user.id, blockedUserId: B.user.id, originPersonaId: B.realId, blockedPersonaId: B.display!.id }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } })
    })
  })

  it('뮤트는 저장과 내 뮤트 목록뿐이고 상대의 보기·팔로우에는 영향이 없음', async () => {
    await withRollback(async (tx) => {
      const A = await person(tx, '김뮤트')
      const B = await person(tx, '박대상', { display: true })
      const mute = await createMute(tx, A.actor, { handle: B.display!.handle }, T0)
      expect(await createMute(tx, A.actor, { handle: B.display!.handle }, T0)).toEqual(mute)
      expect((await listMyMutes(tx, A.actor)).mutes).toEqual([{ id: mute.id, target: { kind: 'display', handle: B.display!.handle, displayName: B.display!.name }, createdAt: T0.toISOString() }])
      expect(JSON.stringify(await listMyMutes(tx, A.actor))).not.toContain(B.realHandle)
      expect((await getProfileSocial(tx, A.actor, B.display!.handle)).viewer!.muteId).toBe(mute.id)
      // 상대는 그대로 A를 보고 팔로우할 수 있고, A도 그대로 팔로우할 수 있음.
      await getProfileSocial(tx, B.actor, A.realHandle)
      expect(await follow(tx, B, A.realHandle, B.display!.id)).toEqual({ status: 'active' })
      expect(await follow(tx, A, B.display!.handle)).toEqual({ status: 'active' })
      await removeMute(tx, A.actor, mute.id)
      expect(await tx.select().from(mutes).where(eq(mutes.muterUserId, A.user.id))).toHaveLength(0)
    })
  })

  it('차단은 0~1단계(익명) 커뮤니티 글에 적용되지 않음: 차단당한 사용자도 익명 글을 그대로 봄', async () => {
    await withRollback(async (tx) => {
      const [school] = await tx.insert(schools).values({ name: `차단대학교${tag()}`, nameKey: `차단대학교${tag()}` }).returning({ id: schools.id })
      const A = await person(tx, '김익명', { display: true })
      const B = await person(tx, '박독자')
      for (const p of [A, B]) {
        await verifiedAffiliation(tx, p.user.id, school!.id)
        await updateRealName(tx, p.actor, { realName: `실명${p.name}` })
      }
      const room = await createRoom(tx, A.actor, { name: `익명 방 ${tag()}`, nameMode: 'anonymous', joinPolicy: 'open' }, T0)
      await joinSpace(tx, B.actor, room.slug, T0)
      const boardId = room.boards[0]!.id
      const post = await createPost(tx, A.actor, boardId, { title: '익명 글', body: `익명 본문 ${tag()}` }, T0)
      const later = new Date(T0.getTime() + 60_000)
      const beforeList = await listBoardPosts(tx, B.actor, boardId, {}, later)
      const beforePost = await getPost(tx, B.actor, post.id, later)
      expect(beforeList.items.map((p) => p.id)).toContain(post.id)

      await createBlock(tx, A.actor, { handle: B.realHandle, as: A.display!.id, scope: 'all_personas', confirmLinkInference: true }, T0)
      await expectServiceError(getProfileSocial(tx, B.actor, A.realHandle), 'NOT_FOUND')
      expect(await listBoardPosts(tx, B.actor, boardId, {}, later)).toEqual(beforeList)
      expect(await getPost(tx, B.actor, post.id, later)).toEqual(beforePost)
    })
  })
})
