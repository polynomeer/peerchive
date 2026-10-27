/**
 * C-04 커뮤니티 글·댓글·공감·스레드 익명 번호 통합 테스트(DELIVERY_PLAN §4.1 C-04·§5.1 K, SYSTEM_DESIGN §6.7·§8.1, ADR 0020·0022).
 * 실제 PostgreSQL(rollback). DATABASE_URL이 없으면 DB 테스트는 건너뛰고 HTTP 본문 상한 테스트만 돕니다.
 * 각 테스트는 자기가 만든 학교(무작위 이름)·사용자·방만 봅니다(시각은 고정 T0 기준).
 */
import { createApp, createRouter, defineEventHandler, toWebHandler } from 'h3'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { COMMENT_RATE_LIMIT, NAME_MODE_CHANGE_DELAY_MS, POST_RATE_LIMIT } from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  auditEvents,
  communityComments,
  communityNotices,
  communityPosts,
  communityReactions,
  communitySpaces,
  eq,
  hashSubject,
  inArray,
  operators,
  personas,
  profiles,
  sql,
  threadAliases,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { applyNameModeChange } from '../../worker/src/ops/name-modes'
import { removeAffiliation } from '../server/modules/affiliation/affiliations'
import { analyticsPepper, setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { createSchool } from '../server/modules/catalog/catalog'
import { readCommunityWriteBody } from '../server/modules/community/http'
import { changeMemberRole, joinSpace, leaveSpace } from '../server/modules/community/memberships'
import { scheduleNameModeChange } from '../server/modules/community/name-modes'
import { listMyCommunityNotices, markCommunityNoticesRead } from '../server/modules/community/notices'
import { operatorCommunityItem } from '../server/modules/community/moderation'
import { assignModerator, createOfficialPage } from '../server/modules/community/official'
import {
  createComment,
  createPost,
  deleteComment,
  deletePost,
  editComment,
  editPost,
  getPost,
  listBoardPosts,
  setReaction,
} from '../server/modules/community/posts'
import { archiveSpace, createBoard, createRoom, getSpaceDetail } from '../server/modules/community/spaces'
import { searchPublic } from '../server/modules/course-hub/search'
import { ServiceError } from '../server/modules/errors'
import { updateRealName } from '../server/modules/identity/profiles'
import { createAppeal, listMyModerationNotices } from '../server/modules/moderation/notices'
import { decideAppeal, getReportDetail, listReportGroups, resolveReport } from '../server/modules/moderation/operator'
import { createReport, listMyReports } from '../server/modules/moderation/reports'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { hitRateLimit } from '../server/modules/security/rate-limit'
import type { CommunityCommentDto, CommunityPostDto } from '../shared/types/api'
import { closeTestDb, createUser, databaseUrl, expectServiceError, insertDisplayPersona, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-05T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const DB_TIMEOUT = 60_000
const PEPPER = { NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'posts-analytics-pepper-for-tests-0123456789abcdef' }

type Person = { userId: string; email: string; handle: string; accountName: string; displayHandle: string | null }

/**
 * 사용자(실명 프로필 + 학교 인증). 표시명 방식으로 쓰려면 표시명 페르소나가 있어야 하므로(ADR 0030) 기본으로 `displayName` 이름의
 * 표시명 페르소나를 만들고, 계정 표시 이름은 일부러 다른 값(`계정 …`)으로 둡니다 — 표시명 글이 계정 이름으로 보이면 테스트가 깨집니다.
 */
async function person(tx: DbExecutor, schoolId: string | null, displayName = '학생', opts: { displayPersona?: boolean } = {}): Promise<Person> {
  const handle = `p${rand()}`
  const accountName = `계정 ${displayName} ${rand()}`
  const u = await createUser(tx, { handle, displayName: accountName })
  const persona = opts.displayPersona === false ? null : await insertDisplayPersona(tx, u.id, displayName)
  if (schoolId) await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id, email: u.email, handle, accountName, displayHandle: persona?.handle ?? null }
}

async function school(tx: DbExecutor) {
  const op = await person(tx, null, '운영자')
  await tx.insert(operators).values({ userId: op.userId })
  const s = await createSchool(tx, op, { name: `글대${rand()}학교`, confirmNew: true }, T0)
  return { op, schoolId: s.id }
}

/** 방 하나(owner O + 멤버들). 기본 게시판 id. */
async function room(tx: DbExecutor, schoolId: string, nameMode: 'anonymous' | 'display' | 'real', members: number, opts: { linkSchool?: boolean } = {}) {
  const O = await person(tx, schoolId, '방장')
  const created = await createRoom(tx, O, { name: `방 ${rand()}`, nameMode, joinPolicy: 'open', ...(opts.linkSchool && { schoolId }) }, T0)
  const people: Person[] = []
  for (let i = 0; i < members; i++) {
    const p = await person(tx, schoolId, `멤버${i + 1}`)
    await joinSpace(tx, p, created.slug, at(1))
    people.push(p)
  }
  return { O, people, slug: created.slug, boardId: created.boards[0]!.id }
}

const labelsOf = (post: CommunityPostDto) => {
  const out: string[] = []
  const walk = (cs: CommunityCommentDto[]) => {
    for (const c of cs) {
      out.push(c.author.label ?? '∅')
      walk(c.replies)
    }
  }
  walk(post.comments)
  return out
}

const flat = (post: CommunityPostDto) => post.comments.flatMap((c) => [c, ...c.replies])

describe('C-04 write body cap (HTTP, no DB)', () => {
  it('rejects bodies over 64KB with 413 before parsing; small JSON passes through', async () => {
    const app = createApp().use(
      createRouter().post(
        '/w',
        defineEventHandler(async (event) => {
          try {
            return { ok: true, body: await readCommunityWriteBody(event) }
          } catch (e) {
            return { ok: false, code: e instanceof ServiceError ? e.code : 'other' }
          }
        }),
      ),
    )
    const handler = toWebHandler(app)
    const big = JSON.stringify({ body: 'a'.repeat(70 * 1024) })
    expect(await (await handler(new Request('http://localhost/w', { method: 'POST', body: big, headers: { 'content-type': 'application/json' } }))).json()).toEqual({
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
    })
    expect(await (await handler(new Request('http://localhost/w', { method: 'POST', body: '{"title":"t"}', headers: { 'content-type': 'application/json' } }))).json()).toEqual({
      ok: true,
      body: { title: 't' },
    })
    expect(await (await handler(new Request('http://localhost/w', { method: 'POST', body: 'not json' }))).json()).toEqual({ ok: true, body: {} })
  })
})

describe.skipIf(!databaseUrl)('C-04 community posts (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => setAnalyticsEnvForTesting(null))

  it('write permissions: members of rooms, same-school on official pages, notice boards for moderators only (members comment), non-readers 404, archived 409', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'display', 2)
      const [M, N] = r.people as [Person, Person]
      const notice = await createBoard(tx, r.O, r.slug, { kind: 'notice', title: '공지' }, at(2))
      // 멤버는 일반 게시판에 쓰고, 공지에는 403(읽을 수는 있음)
      const post = await createPost(tx, M, r.boardId, { title: '첫 글', body: '안녕하세요' }, at(3))
      expect(post).toMatchObject({ title: '첫 글', body: '안녕하세요', nameMode: 'display', author: { kind: 'display', label: '멤버1', mine: true } })
      await expectServiceError(createPost(tx, M, notice.id, { title: '공지', body: '멤버 공지' }, at(3)), 'FORBIDDEN', 'write_not_allowed')
      await changeMemberRole(tx, r.O, r.slug, N.userId, { role: 'moderator' }, at(3))
      const noticePost = await createPost(tx, N, notice.id, { title: '공지', body: '모더레이터 공지' }, at(4))
      // 공지 글에도 멤버가 댓글을 씀
      expect(flat(await createComment(tx, M, noticePost.id, { body: '확인했습니다' }, at(5)))).toHaveLength(1)

      // 비멤버·다른 학교·미인증·나간 사람: 읽기·쓰기 모두 404
      const outsider = await person(tx, schoolId)
      const { schoolId: otherSchoolId } = await school(tx)
      const other = await person(tx, otherSchoolId)
      const unverified = await person(tx, null)
      await leaveSpace(tx, M, r.slug, at(6))
      for (const who of [outsider, other, unverified, M]) {
        await expectServiceError(listBoardPosts(tx, who, r.boardId, {}, at(7)), 'NOT_FOUND')
        await expectServiceError(getPost(tx, who, post.id, at(7)), 'NOT_FOUND')
        await expectServiceError(createPost(tx, who, r.boardId, { title: 't', body: 'b' }, at(7)), 'NOT_FOUND')
        await expectServiceError(createComment(tx, who, post.id, { body: 'b' }, at(7)), 'NOT_FOUND')
        await expectServiceError(setReaction(tx, who, 'post', post.id, true, at(7)), 'NOT_FOUND')
        await expectServiceError(createReport(tx, who, { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'spam' }, at(7)), 'NOT_FOUND')
      }
      // 운영자도 사용자 방 글을 읽지 못함(ADR 0019)
      await expectServiceError(getPost(tx, op, post.id, at(7)), 'NOT_FOUND')
      // 없는 글·형식이 틀린 id도 같은 404
      await expectServiceError(getPost(tx, N, crypto.randomUUID(), at(7)), 'NOT_FOUND')
      await expectServiceError(getPost(tx, N, 'not-a-uuid', at(7)), 'NOT_FOUND')

      // 보관된 방: 읽기만(409)
      await archiveSpace(tx, r.O, r.slug, at(8))
      expect((await getPost(tx, N, post.id, at(9))).composer.canWrite).toBe(false)
      await expectServiceError(createPost(tx, N, r.boardId, { title: 't', body: 'b' }, at(9)), 'CONFLICT', 'space_not_active')
      await expectServiceError(createComment(tx, N, post.id, { body: 'b' }, at(9)), 'CONFLICT', 'space_not_active')
      await expectServiceError(setReaction(tx, N, 'post', post.id, true, at(9)), 'CONFLICT', 'space_not_active')

      // 학교 인증이 해제되면 다음 요청부터 404(공식·학교 연결 방)
      const linked = await room(tx, schoolId, 'display', 1, { linkSchool: true })
      const L = linked.people[0]!
      const [aff] = (await tx.execute(sql`select id from institution_affiliations where user_id = ${L.userId}`)) as unknown as Array<{ id: string }>
      const linkedPost = await createPost(tx, L, linked.boardId, { title: 't', body: 'b' }, at(10))
      await removeAffiliation(tx, L, aff!.id, at(11))
      await expectServiceError(getPost(tx, L, linkedPost.id, at(12)), 'NOT_FOUND')
    })
  }, DB_TIMEOUT)

  it('official pages: same-school verified write anonymously by default, may pick display per post, real is rejected; departments need the department; rooms reject a different mode', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const page = await createOfficialPage(tx, op, { schoolId }, T0)
      const dept = await createOfficialPage(tx, op, { schoolId, departmentLabel: '컴퓨터공학과' }, T0)
      const free = page.boards.find((b) => b.kind === 'free')!
      const deptFree = dept.boards.find((b) => b.kind === 'free')!
      const S = await person(tx, schoolId, '학생')
      const anon = await createPost(tx, S, free.id, { title: '익명 글', body: '본문' }, at(1))
      expect(anon).toMatchObject({ nameMode: 'anonymous', author: { kind: 'anonymous', label: '글쓴이', mine: true } })
      const named = await createPost(tx, S, free.id, { title: '표시명 글', body: '본문', nameMode: 'display' }, at(2))
      expect(named).toMatchObject({ nameMode: 'display', author: { kind: 'display', label: '학생' } })
      const real = await expectServiceError(createPost(tx, S, free.id, { title: '실명', body: '본문', nameMode: 'real' }, at(3)), 'VALIDATION')
      expect(real.fields).toEqual({ nameMode: 'real_not_allowed' })
      await expectServiceError(createComment(tx, S, anon.id, { body: '실명 댓글', nameMode: 'real' }, at(3)), 'VALIDATION')
      // 공지 게시판: 지정된 모더레이터만
      const noticeBoard = page.boards.find((b) => b.kind === 'notice')!
      await expectServiceError(createPost(tx, S, noticeBoard.id, { title: '공지', body: 'x' }, at(4)), 'FORBIDDEN', 'write_not_allowed')
      await assignModerator(tx, op, page.slug, { userId: S.userId }, at(4))
      expect(await createPost(tx, S, noticeBoard.id, { title: '공지', body: '모더레이터 공지' }, at(5))).toMatchObject({ nameMode: 'anonymous' })
      // 학과 페이지: 같은 학과 키만 씀(다른 학과는 읽기만 → 403)
      await expectServiceError(createPost(tx, S, deptFree.id, { title: 't', body: 'b' }, at(6)), 'FORBIDDEN', 'write_not_allowed')
      const D = await person(tx, null, '컴공')
      await verifiedAffiliation(tx, D.userId, schoolId, { departmentLabel: '컴퓨터 공학과' })
      expect(await createPost(tx, D, deptFree.id, { title: 't', body: 'b' }, at(6))).toMatchObject({ nameMode: 'anonymous' })
      // 사용자 방: 공간 방식과 다른 방식을 고르면 422 mode_fixed
      const r = await room(tx, schoolId, 'anonymous', 0)
      const fixed = await expectServiceError(createPost(tx, r.O, r.boardId, { title: 't', body: 'b', nameMode: 'display' }, at(7)), 'VALIDATION')
      expect(fixed.fields).toEqual({ nameMode: 'mode_fixed' })
      expect(await createPost(tx, r.O, r.boardId, { title: 't', body: 'b', nameMode: 'anonymous' }, at(7))).toMatchObject({ nameMode: 'anonymous' })
    })
  }, DB_TIMEOUT)

  it('real-name rooms require the author’s real name before writing and show it with the school-verified flag', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'real', 1, { linkSchool: true })
      const M = r.people[0]!
      const blocked = await expectServiceError(createPost(tx, M, r.boardId, { title: '실명', body: '본문' }, at(2)), 'FORBIDDEN', 'real_name_required')
      expect(blocked.details).toEqual({ requirement: 'real_name' })
      expect((await listBoardPosts(tx, M, r.boardId, {}, at(2))).composer).toMatchObject({ nameMode: 'real', realNameRequired: true, note: '이 방은 실명으로 표시됩니다.' })
      await updateRealName(tx, M, { realName: '김멤버' })
      const post = await createPost(tx, M, r.boardId, { title: '실명', body: '본문' }, at(3))
      expect(post.author).toEqual({ kind: 'real', label: '김멤버', schoolVerified: true, mine: true })
      await expectServiceError(createComment(tx, r.O, post.id, { body: '방장' }, at(4)), 'FORBIDDEN', 'real_name_required')
    })
  }, DB_TIMEOUT)

  it('freeze at write: a later mode change (schedule → effective → worker apply) never changes earlier items; edits keep the mode; the DB trigger blocks updates', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'real', 1)
      const M = r.people[0]!
      await updateRealName(tx, M, { realName: '김실명' })
      const before = await createPost(tx, M, r.boardId, { title: '실명 글', body: '본문' }, at(1))
      const state = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'anonymous' }, at(2))
      const effective = new Date(at(2).getTime() + NAME_MODE_CHANGE_DELAY_MS)
      // 예약 뒤·적용 전: 여전히 실명
      const stillReal = await createComment(tx, M, before.id, { body: '적용 전 댓글' }, new Date(effective.getTime() - 1000))
      expect(flat(stillReal)[0]).toMatchObject({ nameMode: 'real', author: { label: '김실명' } })
      // effective_at부터는 worker 전이라도 익명
      const anonComment = await createComment(tx, M, before.id, { body: '적용 뒤 댓글' }, effective)
      expect(flat(anonComment)[1]).toMatchObject({ nameMode: 'anonymous', author: { kind: 'anonymous', label: '익명1' } })
      // worker 적용(같은 함수)
      expect(await applyNameModeChange(tx, state.pending!.id, { now: new Date(effective.getTime() + 60_000) })).toMatchObject({ changeId: state.pending!.id })
      const [space] = await tx.select().from(communitySpaces).where(eq(communitySpaces.slug, r.slug))
      expect(space!.currentNameMode).toBe('anonymous')
      const after = await getPost(tx, r.O, before.id, new Date(effective.getTime() + 120_000))
      expect(after).toMatchObject({ nameMode: 'real', author: { kind: 'real', label: '김실명' } })
      expect(flat(after).map((c) => c.nameMode)).toEqual(['real', 'anonymous'])
      // 고쳐도 방식은 그대로
      const edited = await editPost(tx, M, before.id, { body: '고친 본문', expectedVersion: before.version }, new Date(effective.getTime() + 180_000))
      expect(edited).toMatchObject({ nameMode: 'real', body: '고친 본문', edited: true, version: 2 })
      await expectServiceError(editPost(tx, M, before.id, { body: '또', expectedVersion: 1 }, new Date(effective.getTime() + 200_000)), 'CONFLICT', 'version_conflict')
      const [row] = await tx.select().from(communityPosts).where(eq(communityPosts.id, before.id))
      expect(row!.nameMode).toBe('real')

      // DB 트리거: name_mode·author_id를 바꾸는 UPDATE를 거부(savepoint 안에서 시도해 바깥 트랜잭션을 살림)
      const attempt = async (q: ReturnType<typeof sql>) =>
        tx.transaction(async (sp) => {
          await sp.execute(q)
        }).then(
          () => 'ok',
          (e: unknown) => String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message),
        )
      expect(await attempt(sql`update community_posts set name_mode = 'anonymous' where id = ${before.id}`)).toMatch(/frozen/)
      expect(await attempt(sql`update community_posts set author_id = ${r.O.userId} where id = ${before.id}`)).toMatch(/frozen/)
      expect(await attempt(sql`update community_comments set name_mode = 'real' where post_id = ${before.id} and name_mode = 'anonymous'`)).toMatch(/frozen/)
      expect(await attempt(sql`update thread_aliases set alias_no = 7 where post_id = ${before.id}`)).toMatch(/immutable/)
      // 다른 열은 고칠 수 있음(트리거가 막지 않음)
      expect(await attempt(sql`update community_posts set updated_at = now() where id = ${before.id}`)).toBe('ok')
    })
  }, DB_TIMEOUT)

  it('thread aliases: 글쓴이 + 익명N stable within a thread, independent across threads; moderators see identical JSON with no ids, emails or handles', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'anonymous', 4)
      const [A, B, C, D] = r.people as [Person, Person, Person, Person]
      const one = await createPost(tx, A, r.boardId, { title: '첫 스레드', body: '질문' }, at(1))
      expect(one.author).toEqual({ kind: 'anonymous', label: '글쓴이', schoolVerified: false, mine: true })
      await createComment(tx, B, one.id, { body: 'B1' }, at(2))
      await createComment(tx, A, one.id, { body: 'A 답' }, at(3))
      await createComment(tx, C, one.id, { body: 'C1' }, at(4))
      const firstB = flat(await getPost(tx, B, one.id, at(4)))[0]!
      await createComment(tx, B, one.id, { body: 'B 답글', parentCommentId: firstB.id }, at(5))
      const t1 = await getPost(tx, D, one.id, at(6))
      expect(t1.comments.map((c) => c.author.label)).toEqual(['익명1', '글쓴이', '익명2'])
      expect(t1.comments[0]!.replies.map((c) => c.author.label)).toEqual(['익명1'])
      expect(labelsOf(t1)).toEqual(['익명1', '익명1', '글쓴이', '익명2'])

      // 두 번째 스레드: 같은 사람들이지만 번호는 이 스레드의 참여 순서
      const two = await createPost(tx, C, r.boardId, { title: '둘째 스레드', body: '다른 질문' }, at(7))
      await createComment(tx, A, two.id, { body: 'A' }, at(8))
      await createComment(tx, B, two.id, { body: 'B' }, at(9))
      await createComment(tx, C, two.id, { body: 'C 답' }, at(10))
      const t2 = await getPost(tx, D, two.id, at(11))
      expect(labelsOf(t2)).toEqual(['익명1', '익명2', '글쓴이'])
      // B: 첫 스레드 익명1, 둘째 스레드 익명2 / C: 첫 스레드 익명2, 둘째 스레드 글쓴이
      expect(labelsOf(t1)[0]).toBe('익명1')
      expect(labelsOf(t2)[1]).toBe('익명2')

      // 방장(운영진)·다른 멤버 D가 보는 JSON이 같음(둘 다 참여자가 아님)
      const asOwner = await getPost(tx, r.O, one.id, at(12))
      const asMember = await getPost(tx, D, one.id, at(12))
      expect(asOwner).toEqual(asMember)
      const list = { owner: await listBoardPosts(tx, r.O, r.boardId, {}, at(12)), member: await listBoardPosts(tx, D, r.boardId, {}, at(12)) }
      expect(list.owner.items).toEqual(list.member.items)
      // 응답에 사람 id·이메일·핸들·별칭 행 id가 없음
      const aliasIds = (await tx.select({ id: threadAliases.id }).from(threadAliases).where(inArray(threadAliases.postId, [one.id, two.id]))).map((a) => a.id)
      const json = JSON.stringify([asOwner, list.owner, await getPost(tx, r.O, two.id, at(12))])
      for (const p of [A, B, C, D, r.O]) {
        expect(json).not.toContain(p.userId)
        expect(json).not.toContain(p.email)
        expect(json).not.toContain(p.handle)
      }
      for (const id of aliasIds) expect(json).not.toContain(id)
      // 표시 이름(멤버1~4)도 없음(익명 스레드)
      expect(json).not.toMatch(/멤버[1-4]/)
      // 작성자 본인만 mine
      expect((await getPost(tx, B, one.id, at(12))).comments[0]!.author.mine).toBe(true)
      expect(asOwner.comments[0]!.author.mine).toBe(false)
      // 저장: 스레드마다 따로, 글쓴이 0
      const rows = await tx.select().from(threadAliases).where(eq(threadAliases.postId, one.id))
      expect(rows.map((x) => [x.userId, x.aliasNo]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
        [A.userId, 0],
        [B.userId, 1],
        [C.userId, 2],
      ])
      // 소규모 익명 방(멤버 5명): 시각은 버킷만
      expect(asOwner).toMatchObject({ createdAt: null, createdBucket: 'today', editedAt: null })
      expect(asOwner.comments[0]).toMatchObject({ createdAt: null, createdBucket: 'today' })
    })
  }, DB_TIMEOUT)

  it('named posts: the author is not 글쓴이 when commenting anonymously after a mode change; display rooms with ≥10 members show exact times', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'display', 10)
      const [A, B] = r.people as [Person, Person]
      const post = await createPost(tx, A, r.boardId, { title: '표시명 글', body: '본문' }, at(1))
      expect(post).toMatchObject({ createdAt: at(1).toISOString(), createdBucket: null })
      const state = await scheduleNameModeChange(tx, r.O, r.slug, { toMode: 'anonymous' }, at(2))
      const due = new Date(new Date(state.pending!.effectiveAt).getTime() + 1000)
      await createComment(tx, B, post.id, { body: 'B 익명' }, due)
      const thread = await createComment(tx, A, post.id, { body: '글쓴이 익명 댓글' }, new Date(due.getTime() + 1000))
      // 이름이 보이는 글의 글쓴이를 `글쓴이`로 묶지 않음(익명 댓글이 이름과 이어지지 않게)
      expect(labelsOf(thread)).toEqual(['익명1', '익명2'])
      expect(thread.author).toMatchObject({ kind: 'display', label: '멤버1' })
      // 멤버 11명 방의 익명 댓글은 정확한 시각
      expect(flat(thread)[0]!.createdAt).toBe(due.toISOString())
    })
  }, DB_TIMEOUT)

  it('soft delete keeps the row and numbering: placeholders, list excludes deleted posts, new participants get max + 1; hidden placeholder in lists', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'anonymous', 4)
      const [A, B, C, E] = r.people as [Person, Person, Person, Person]
      const post = await createPost(tx, A, r.boardId, { title: '지울 스레드', body: '본문' }, at(1))
      await createComment(tx, B, post.id, { body: 'B' }, at(2))
      await createComment(tx, C, post.id, { body: 'C' }, at(3))
      const bComment = flat(await getPost(tx, B, post.id, at(3)))[0]!
      await expectServiceError(deleteComment(tx, C, bComment.id, at(4)), 'FORBIDDEN', 'not_author')
      await expectServiceError(editComment(tx, C, bComment.id, { body: 'x', expectedVersion: 1 }, at(4)), 'FORBIDDEN', 'not_author')
      const afterDelete = await deleteComment(tx, B, bComment.id, at(4))
      expect(flat(afterDelete)[0]).toMatchObject({ status: 'deleted_by_author', body: null, placeholder: '작성자가 삭제한 댓글입니다', author: { label: '익명1' } })
      await expectServiceError(deleteComment(tx, B, bComment.id, at(5)), 'CONFLICT', 'not_open')
      await createComment(tx, E, post.id, { body: 'E' }, at(5))
      // B가 다시 와도 익명1(행이 남아 있음)
      await createComment(tx, B, post.id, { body: 'B 다시' }, at(6))
      expect(labelsOf(await getPost(tx, A, post.id, at(7)))).toEqual(['익명1', '익명2', '익명3', '익명1'])
      const [stored] = await tx.select().from(communityComments).where(eq(communityComments.id, bComment.id))
      expect(stored).toMatchObject({ body: '', status: 'deleted_by_author' })

      // 글 지우기: 목록에서 빠지고, 직접 열면 자리 표시 + 남은 댓글. 댓글은 더 달 수 없음
      const other = await createPost(tx, B, r.boardId, { title: '남는 글', body: '본문' }, at(8))
      const gone = await deletePost(tx, A, post.id, at(9))
      expect(gone).toMatchObject({ status: 'deleted_by_author', title: null, body: null, placeholder: '작성자가 삭제한 글입니다', author: { label: '글쓴이' } })
      expect(flat(gone)).toHaveLength(4)
      expect((await listBoardPosts(tx, C, r.boardId, {}, at(10))).items.map((p) => p.id)).toEqual([other.id])
      await expectServiceError(createComment(tx, C, post.id, { body: '늦은 댓글' }, at(10)), 'CONFLICT', 'post_not_open')
      const [postRow] = await tx.select().from(communityPosts).where(eq(communityPosts.id, post.id))
      expect(postRow).toMatchObject({ title: '', body: '' })
    })
  }, DB_TIMEOUT)

  it('reactions: empathy only, one per person, counts only (no list of who), not on own items or tombstones', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'anonymous', 3)
      const [A, B, C] = r.people as [Person, Person, Person]
      const post = await createPost(tx, A, r.boardId, { title: '공감', body: '본문' }, at(1))
      expect(await setReaction(tx, B, 'post', post.id, true, at(2))).toEqual({ count: 1, reacted: true })
      expect(await setReaction(tx, B, 'post', post.id, true, at(3))).toEqual({ count: 1, reacted: true })
      expect(await setReaction(tx, C, 'post', post.id, true, at(3))).toEqual({ count: 2, reacted: true })
      await expectServiceError(setReaction(tx, A, 'post', post.id, true, at(3)), 'CONFLICT', 'own_item')
      expect(await setReaction(tx, B, 'post', post.id, false, at(4))).toEqual({ count: 1, reacted: false })
      const view = await getPost(tx, A, post.id, at(5))
      expect(view).toMatchObject({ reactionCount: 1, reacted: false, canReact: false })
      expect(JSON.stringify(view)).not.toContain(C.userId)
      expect(Object.keys(view)).not.toEqual(expect.arrayContaining(['reactions', 'reactors', 'downvotes']))
      const thread = await createComment(tx, B, post.id, { body: '댓글' }, at(6))
      const comment = flat(thread)[0]!
      expect(await setReaction(tx, A, 'comment', comment.id, true, at(7))).toEqual({ count: 1, reacted: true })
      // DB도 사람마다 하나
      const dup = await tx
        .transaction(async (sp) => {
          await sp.insert(communityReactions).values({ postId: post.id, userId: C.userId, kind: 'empathy' })
        })
        .then(
          () => 'ok',
          () => 'unique',
        )
      expect(dup).toBe('unique')
      await deleteComment(tx, B, comment.id, at(8))
      await expectServiceError(setReaction(tx, C, 'comment', comment.id, true, at(9)), 'CONFLICT', 'target_not_open')
      expect(await tx.select().from(communityReactions).where(eq(communityReactions.commentId, comment.id))).toEqual([])
    })
  }, DB_TIMEOUT)

  it('report → operator hide_post / hide_comment: placeholders for everyone, operator sees the item without author ids, the author is notified and can appeal (reverse restores)', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'anonymous', 3)
      const [A, B, C] = r.people as [Person, Person, Person]
      const post = await createPost(tx, A, r.boardId, { title: '신고될 글', body: '문제 본문' }, at(1))
      const thread = await createComment(tx, B, post.id, { body: '문제 댓글' }, at(2))
      const comment = flat(thread)[0]!
      const outsider = await person(tx, schoolId)
      await expectServiceError(createReport(tx, outsider, { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'harassment' }, at(3)), 'NOT_FOUND')
      const badRef = await expectServiceError(createReport(tx, C, { targetType: 'community_post', targetRef: { postId: 'x' }, reason: 'spam' }, at(3)), 'VALIDATION')
      expect(badRef.fields).toEqual({ 'targetRef.postId': 'invalid' })
      const report = await createReport(tx, C, { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'harassment', details: '신고 설명' }, at(3))
      expect(report).toMatchObject({ created: true, status: 'received' })
      expect((await createReport(tx, C, { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'spam' }, at(4))).created).toBe(false)
      const commentReport = await createReport(tx, C, { targetType: 'community_comment', targetRef: { commentId: comment.id }, reason: 'spam' }, at(4))

      const groups = await listReportGroups(tx, op, {})
      const mine = groups.filter((g) => g.reportId === report.id || g.reportId === commentReport.id)
      expect(mine.map((g) => g.targetLabel).sort()).toEqual([expect.stringMatching(/^커뮤니티 글 · 방 /), expect.stringMatching(/^커뮤니티 댓글 · 방 /)].sort())
      const detail = await getReportDetail(tx, op, report.id, at(5))
      expect(detail.allowedActions).toEqual(['none', 'hide_post'])
      expect(detail.content).toMatchObject({ kind: 'community_post', item: { title: '신고될 글', body: '문제 본문', authorLabel: '익명', status: 'published' } })
      const detailJson = JSON.stringify(detail)
      for (const p of [A, B]) {
        expect(detailJson).not.toContain(p.userId)
        expect(detailJson).not.toContain(p.email)
        expect(detailJson).not.toContain(p.handle)
      }
      await resolveReport(tx, op, report.id, { action: 'hide_post', note: '내부 메모', publicReason: '괴롭힘', notifyOwner: true }, at(6))
      await resolveReport(tx, op, commentReport.id, { action: 'hide_comment', note: '내부 메모', publicReason: '스팸', notifyOwner: true }, at(6))

      const hidden = await getPost(tx, C, post.id, at(7))
      expect(hidden).toMatchObject({ status: 'hidden', title: null, body: null, placeholder: '운영 조치로 가려진 글입니다', canReport: false, canReact: false })
      expect(flat(hidden)[0]).toMatchObject({ status: 'hidden', body: null, placeholder: '운영 조치로 가려진 댓글입니다', author: { label: '익명1' } })
      expect((await listBoardPosts(tx, C, r.boardId, {}, at(7))).items[0]).toMatchObject({ id: post.id, title: null, placeholder: '운영 조치로 가려진 글입니다' })
      expect(JSON.stringify(hidden)).not.toContain('문제 본문')
      // 본인도 본문을 보지 않음(안내는 운영 조치 안내), 고치기 불가, 지우기는 가능
      expect(await getPost(tx, A, post.id, at(7))).toMatchObject({ body: null, canEdit: false, canDelete: true })
      await expectServiceError(editPost(tx, A, post.id, { body: 'x', expectedVersion: hidden.version }, at(7)), 'CONFLICT', 'not_open')
      await expectServiceError(createComment(tx, C, post.id, { body: 'x' }, at(7)), 'CONFLICT', 'post_not_open')
      // 다시 가리기 409
      const again = await createReport(tx, B, { targetType: 'community_post', targetRef: { postId: post.id }, reason: 'spam' }, at(7)).then(
        () => 'ok',
        (e: ServiceError) => e.code,
      )
      expect(again).toBe('NOT_FOUND')

      // 당사자(작성자) 안내·이의제기: 익명 글이어도 본인에게만
      const notices = await listMyModerationNotices(tx, A)
      expect(notices).toMatchObject([{ kind: 'hide_post', targetType: 'community_post', ownerPath: `/community/p/${post.id}`, publicReason: '괴롭힘', canAppeal: true }])
      expect(await listMyModerationNotices(tx, r.O)).toEqual([])
      expect((await listMyModerationNotices(tx, B))[0]).toMatchObject({ kind: 'hide_comment', ownerPath: `/community/p/${post.id}` })
      await expectServiceError(createAppeal(tx, C, { actionId: notices[0]!.actionId, message: '남의 이의' }, at(8)), 'NOT_FOUND')
      const appeal = await createAppeal(tx, A, { actionId: notices[0]!.actionId, message: '오해입니다' }, at(8))
      await decideAppeal(tx, op, appeal.id, { decision: 'reverse', note: '되돌림' }, at(9))
      expect(await getPost(tx, C, post.id, at(10))).toMatchObject({ status: 'published', title: '신고될 글', body: '문제 본문' })
      // 신고자에게는 상태만
      expect((await listMyReports(tx, C)).find((x) => x.id === report.id)).toMatchObject({ targetType: 'community_post', status: 'resolved' })
      // 운영 감사: id·종류만, 글 본문 없음
      const audit = await tx.select().from(auditEvents).where(sql`${auditEvents.targetId} = ${post.id}`)
      expect(audit.map((a) => a.action).sort()).toEqual(['moderation.apply', 'moderation.reverse'])
      expect(JSON.stringify(audit)).not.toContain('문제 본문')
      expect(JSON.stringify(audit)).not.toContain(A.userId)
    })
  }, DB_TIMEOUT)

  it('notices: the post author gets one unread "new comments" notice with a count (no commenter identity); own comments do not notify', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'anonymous', 2)
      const [A, B] = r.people as [Person, Person]
      const post = await createPost(tx, A, r.boardId, { title: '알림', body: '본문' }, at(1))
      await createComment(tx, A, post.id, { body: '내 댓글' }, at(2))
      expect((await listMyCommunityNotices(tx, A)).items).toEqual([])
      await createComment(tx, B, post.id, { body: 'B 1' }, at(3))
      await createComment(tx, B, post.id, { body: 'B 2' }, at(4))
      const list = await listMyCommunityNotices(tx, A)
      expect(list).toMatchObject({ unread: 1, items: [{ kind: 'post_commented', postId: post.id, count: 2, space: { slug: r.slug } }] })
      const rows = await tx.select().from(communityNotices).where(eq(communityNotices.postId, post.id))
      expect(rows.map((x) => x.payload)).toEqual([{ count: 2 }])
      expect(JSON.stringify(list)).not.toContain(B.userId)
      await markCommunityNoticesRead(tx, A, { all: true }, at(5))
      await createComment(tx, B, post.id, { body: 'B 3' }, at(6))
      expect((await listMyCommunityNotices(tx, A)).items.map((n) => (n.kind === 'post_commented' ? n.count : 0))).toEqual([1, 2])
      // 나간 뒤에는 글 주소·공간 이름이 없음
      await leaveSpace(tx, A, r.slug, at(7))
      expect((await listMyCommunityNotices(tx, A)).items[0]).toMatchObject({ space: null, postId: null })
    })
  }, DB_TIMEOUT)

  it('rate limits: 10 posts per hour, 60 comments per hour; validation caps', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'display', 1)
      const M = r.people[0]!
      for (let i = 0; i < POST_RATE_LIMIT.limit; i++) await createPost(tx, M, r.boardId, { title: `글 ${i}`, body: '본문' }, at(2))
      await expectServiceError(createPost(tx, M, r.boardId, { title: '넘침', body: '본문' }, at(3)), 'RATE_LIMITED')
      // 다음 시간 창에는 다시 됨
      const later = await createPost(tx, M, r.boardId, { title: '다음 시간', body: '본문' }, at(70))
      // 댓글: 한도까지 카운터를 채운 뒤 한 번 더
      for (let i = 0; i < COMMENT_RATE_LIMIT.limit; i++) await hitRateLimit(tx, 'community_comment_create', M.userId, COMMENT_RATE_LIMIT, at(71))
      await expectServiceError(createComment(tx, M, later.id, { body: '넘침' }, at(71)), 'RATE_LIMITED')
      // 길이·빈 값
      const long = await expectServiceError(createPost(tx, r.O, r.boardId, { title: '가'.repeat(121), body: '나'.repeat(10_001) }, at(72)), 'VALIDATION')
      expect(long.fields).toEqual({ title: 'too_long' })
      expect((await expectServiceError(createPost(tx, r.O, r.boardId, { title: '제목', body: '나'.repeat(10_001) }, at(72)), 'VALIDATION')).fields).toEqual({ body: 'too_long' })
      expect((await expectServiceError(createComment(tx, r.O, later.id, { body: '다'.repeat(3001) }, at(72)), 'VALIDATION')).fields).toEqual({ body: 'too_long' })
      expect((await expectServiceError(createComment(tx, r.O, later.id, { body: '  ' }, at(72)), 'VALIDATION')).fields).toEqual({ body: 'required' })
      // 답글의 답글은 거부
      const t = await createComment(tx, r.O, later.id, { body: '댓글' }, at(73))
      const reply = await createComment(tx, r.O, later.id, { body: '답글', parentCommentId: flat(t)[0]!.id }, at(74))
      const nested = await expectServiceError(createComment(tx, r.O, later.id, { body: '답글의 답글', parentCommentId: flat(reply)[1]!.id }, at(75)), 'VALIDATION')
      expect(nested.fields).toEqual({ parentCommentId: 'not_top_level' })
    })
  }, DB_TIMEOUT)

  it('pagination: newest first, 20 per page, cursor is an opaque post id', async () => {
    await withRollback(async (tx) => {
      const { schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'display', 3)
      const ids: string[] = []
      for (let i = 0; i < 25; i++) {
        const author = r.people[i % 3]!
        // 한도(시간당 10개)를 넘지 않게 시간 창을 나눔
        ids.push((await createPost(tx, author, r.boardId, { title: `글 ${i}`, body: '본문' }, at(i * 61))).id)
      }
      const first = await listBoardPosts(tx, r.O, r.boardId, {}, at(2000))
      expect(first.items.map((p) => p.id)).toEqual(ids.slice(5).reverse())
      expect(first.nextCursor).toBe(ids[5])
      const second = await listBoardPosts(tx, r.O, r.boardId, { cursor: first.nextCursor }, at(2000))
      expect(second.items.map((p) => p.id)).toEqual(ids.slice(0, 5).reverse())
      expect(second.nextCursor).toBeNull()
      await expectServiceError(listBoardPosts(tx, r.O, r.boardId, { cursor: crypto.randomUUID() }, at(2000)), 'VALIDATION')
    })
  }, DB_TIMEOUT)

  it('analytics: allowlisted props only; anonymous items carry no user key', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const { schoolId } = await school(tx)
      const anon = await room(tx, schoolId, 'anonymous', 1)
      const named = await room(tx, schoolId, 'display', 1)
      const A = anon.people[0]!
      const N = named.people[0]!
      const p1 = await createPost(tx, A, anon.boardId, { title: '익명', body: '본문' }, at(1))
      await createComment(tx, anon.O, p1.id, { body: '댓글' }, at(2))
      await setReaction(tx, anon.O, 'post', p1.id, true, at(3))
      await createPost(tx, N, named.boardId, { title: '표시명', body: '본문' }, at(4))
      const pepper = analyticsPepper()!
      const events = await tx.select().from(analyticsEvents).where(inArray(analyticsEvents.name, ['post_created', 'comment_created', 'reaction_added']))
      const recent = events.filter((e) => e.occurredAt >= T0)
      const hashes = new Map([A, anon.O, N].map((p) => [hashSubject(pepper, p.userId), p]))
      const byName = (name: string, mode: string) => recent.filter((e) => e.name === name && (e.props as Record<string, unknown>).mode === mode)
      expect(byName('post_created', 'anonymous').map((e) => e.props)).toEqual([{ area: 'room', kind: 'general', mode: 'anonymous' }])
      // C-10(ADR 0027): 익명 글·댓글·익명 대상 공감은 사용자 키 없음(actor_hash null)
      expect(byName('post_created', 'anonymous')[0]!.actorHash).toBeNull()
      expect(byName('comment_created', 'anonymous')[0]!.actorHash).toBeNull()
      expect(recent.find((e) => e.name === 'reaction_added')!.actorHash).toBeNull()
      expect(hashes.get(byName('post_created', 'display')[0]!.actorHash ?? '')?.userId).toBe(N.userId)
      for (const e of recent) {
        expect(e.projectHash).toBeNull()
        expect(JSON.stringify(e.props)).not.toMatch(/본문|익명 |표시명/)
      }
    })
  }, DB_TIMEOUT)

  it('sentinel post/comment text appears in no non-community table and in no public read', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const sentinel = `POSTSENT${rand()}`
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'anonymous', 2)
      const [A, B] = r.people as [Person, Person]
      const page = await createOfficialPage(tx, op, { schoolId }, T0)
      const post = await createPost(tx, A, r.boardId, { title: `${sentinel} 제목`, body: `${sentinel} 본문` }, at(1))
      const thread = await createComment(tx, B, post.id, { body: `${sentinel} 댓글` }, at(2))
      await createComment(tx, A, post.id, { body: `${sentinel} 답`, parentCommentId: flat(thread)[0]!.id }, at(3))
      await setReaction(tx, B, 'post', post.id, true, at(4))
      await editPost(tx, A, post.id, { body: `${sentinel} 고친 본문`, expectedVersion: 1 }, at(5))
      const officialPost = await createPost(tx, B, page.boards[0]!.id, { title: `${sentinel} 공식`, body: `${sentinel} 공식 본문`, nameMode: 'display' }, at(6))
      const report = await createReport(tx, A, { targetType: 'community_post', targetRef: { postId: officialPost.id }, reason: 'spam' }, at(7))
      await resolveReport(tx, op, report.id, { action: 'hide_post', note: '메모', publicReason: '스팸', notifyOwner: true }, at(8))
      await listMyCommunityNotices(tx, A)

      const COMMUNITY = new Set(['community_spaces', 'space_memberships', 'boards', 'space_invitations', 'official_page_requests', 'name_mode_changes', 'community_notices', 'community_posts', 'community_comments', 'thread_aliases', 'community_reactions'])
      const tables = (await tx.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)) as unknown as Array<{ table_name: string }>
      const leaks: string[] = []
      for (const t of tables.map((x) => x.table_name).filter((x) => !COMMUNITY.has(x))) {
        const [row] = (await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)} x where x::text like ${`%${sentinel}%`}`)) as unknown as Array<{ n: number }>
        if (row!.n > 0) leaks.push(`${t}: ${row!.n}`)
      }
      expect(leaks).toEqual([])
      const [inside] = (await tx.execute(sql`select count(*)::int as n from community_posts x where x::text like ${`%${sentinel}%`}`)) as unknown as Array<{ n: number }>
      expect(inside!.n).toBe(2)
      for (const type of [undefined, 'case', 'stuck', 'note']) expect((await searchPublic(tx, { q: sentinel, ...(type && { type }) }, at(20))).results).toEqual([])
      for (const p of [A, B]) {
        const [prof] = await tx.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, p.userId))
        const text = JSON.stringify(await getPublicPortfolioProfile(tx, prof!.handle, at(20)))
        expect(text).not.toContain(sentinel)
        expect(text).not.toContain(post.id)
      }
      // 커뮤니티 감사 기록(이 트랜잭션): 글 쓰기·고치기는 감사가 없고, 운영 조치 감사에는 id·코드만
      const mine = await tx.select().from(auditEvents).where(sql`${auditEvents.at} >= now()`)
      expect(mine.some((a) => a.targetId === post.id)).toBe(false)
      expect(JSON.stringify(mine)).not.toContain(sentinel)
      // 스페이스 상세에도 글 본문은 없음
      expect(JSON.stringify(await getSpaceDetail(tx, B, r.slug, at(20)))).not.toContain(sentinel)
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, A.userId))
      expect(u).toBeTruthy()
    })
  }, DB_TIMEOUT)

  it('display mode = display persona (ADR 0030): no persona → 403 display_persona; with one → its name only, never the account name or a handle; legacy null → 표시명 없음; anonymous·real unchanged', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 'display', 0)
      const N = await person(tx, schoolId, '페르소나없음', { displayPersona: false })
      const P = await person(tx, schoolId, '밤의개발자')
      await joinSpace(tx, N, r.slug, at(1))
      await joinSpace(tx, P, r.slug, at(1))

      // (a) 표시명 방: 표시명 페르소나가 없으면 글·댓글 모두 403 + requirement, 글쓰기 화면이 미리 알려 줌. 아무것도 쓰이지 않음.
      expect((await listBoardPosts(tx, N, r.boardId, {}, at(2))).composer).toMatchObject({ nameMode: 'display', displayPersonaRequired: true, realNameRequired: false })
      const blocked = await expectServiceError(createPost(tx, N, r.boardId, { title: '표시명', body: '본문' }, at(2)), 'FORBIDDEN', 'display_persona_required')
      expect(blocked.details).toEqual({ requirement: 'display_persona' })
      const first = await createPost(tx, P, r.boardId, { title: '표시명 글', body: '본문' }, at(3))
      await expectServiceError(createComment(tx, N, first.id, { body: '댓글' }, at(4)), 'FORBIDDEN', 'display_persona_required')
      const written = await tx.select({ id: communityPosts.id }).from(communityPosts).where(eq(communityPosts.authorId, N.userId))
      expect(written).toEqual([])
      expect(first.composer.displayPersonaRequired).toBe(false)

      // (b) 페르소나가 있으면 그 이름. 응답 JSON 어디에도 계정 이름·실명 handle·표시명 handle·사람 id가 없음(보는 사람이 누구든).
      expect(first).toMatchObject({ nameMode: 'display', author: { kind: 'display', label: '밤의개발자', mine: true } })
      const [row] = await tx.select({ personaId: communityPosts.personaId }).from(communityPosts).where(eq(communityPosts.id, first.id))
      const [displayPersona] = await tx.select().from(personas).where(and(eq(personas.userId, P.userId), eq(personas.kind, 'display')))
      expect(row!.personaId).toBe(displayPersona!.id)
      const withComment = await createComment(tx, P, first.id, { body: '내 댓글' }, at(5))
      expect(flat(withComment)[0]!.author).toMatchObject({ kind: 'display', label: '밤의개발자' })
      for (const viewer of [r.O, P]) {
        const json = JSON.stringify([await getPost(tx, viewer, first.id, at(6)), await listBoardPosts(tx, viewer, r.boardId, {}, at(6))])
        for (const secret of [P.accountName, P.handle, P.displayHandle!, P.userId, displayPersona!.id]) expect(json).not.toContain(secret)
        expect(json).toContain('밤의개발자')
      }
      // 운영자 신고 화면의 작성자 표시도 같은 이름(계정 이름 아님)
      const opItem = await operatorCommunityItem(tx, { postId: first.id })
      expect(opItem).toMatchObject({ nameMode: 'display', authorLabel: '밤의개발자' })
      expect(JSON.stringify(opItem)).not.toContain(P.accountName)

      // 표시명을 바꾸면 지금 이름(같은 정체성), 페르소나를 비활성화해도 이름은 그대로(링크는 원래 없음). 비활성 페르소나로는 새로 쓰지 못함.
      await tx.update(personas).set({ displayName: '새벽의개발자' }).where(eq(personas.id, displayPersona!.id))
      expect((await getPost(tx, r.O, first.id, at(7))).author.label).toBe('새벽의개발자')
      await tx.update(personas).set({ status: 'deactivated' }).where(eq(personas.id, displayPersona!.id))
      expect((await getPost(tx, r.O, first.id, at(8))).author.label).toBe('새벽의개발자')
      await expectServiceError(createPost(tx, P, r.boardId, { title: '비활성', body: '본문' }, at(8)), 'FORBIDDEN', 'display_persona_required')
      expect((await listBoardPosts(tx, P, r.boardId, {}, at(8))).composer.displayPersonaRequired).toBe(true)

      // (c) persona_id가 없는 예전 표시명 글(S-01 이전): 중립 표시 `표시명 없음` — 계정 이름으로 돌아가지 않고 실명 페르소나로 대신하지 않음.
      const [space] = await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.slug, r.slug))
      const [legacy] = await tx
        .insert(communityPosts)
        .values({ boardId: r.boardId, spaceId: space!.id, authorId: N.userId, nameMode: 'display', personaId: null, title: '예전 글', body: '본문', createdAt: at(0), updatedAt: at(0) })
        .returning({ id: communityPosts.id })
      const legacyView = await getPost(tx, r.O, legacy!.id, at(9))
      expect(legacyView.author).toEqual({ kind: 'display', label: '표시명 없음', schoolVerified: false, mine: false })
      expect((await getPost(tx, N, legacy!.id, at(9))).author).toMatchObject({ label: '표시명 없음', mine: true })
      expect(JSON.stringify(legacyView)).not.toContain(N.accountName)
      expect((await operatorCommunityItem(tx, { postId: legacy!.id }))!.authorLabel).toBe('표시명 없음')

      // (d) 공식 페이지: 페르소나가 없어도 익명은 그대로, 표시명을 고를 때만 403(글쓰기 화면은 익명 기본 + 안내 플래그).
      const page = await createOfficialPage(tx, op, { schoolId }, T0)
      const free = page.boards.find((b) => b.kind === 'free')!
      expect((await listBoardPosts(tx, N, free.id, {}, at(10))).composer).toMatchObject({ nameMode: 'anonymous', choices: ['anonymous', 'display'], displayPersonaRequired: true })
      const anon = await createPost(tx, N, free.id, { title: '익명', body: '본문' }, at(10))
      expect(anon).toMatchObject({ nameMode: 'anonymous', author: { kind: 'anonymous', label: '글쓴이' } })
      await expectServiceError(createPost(tx, N, free.id, { title: '표시명', body: '본문', nameMode: 'display' }, at(11)), 'FORBIDDEN', 'display_persona_required')
      await expectServiceError(createComment(tx, N, anon.id, { body: '표시명 댓글', nameMode: 'display' }, at(11)), 'FORBIDDEN', 'display_persona_required')
      expect((await createComment(tx, N, anon.id, { body: '익명 댓글' }, at(12))).comments[0]!.author).toMatchObject({ kind: 'anonymous', label: '글쓴이' })
      // 실명 방: 표시명 페르소나와 무관(실명 요구만), 실명 페르소나·실명으로 보임
      const realRoom = await room(tx, schoolId, 'real', 0)
      await joinSpace(tx, N, realRoom.slug, at(13))
      expect((await listBoardPosts(tx, N, realRoom.boardId, {}, at(13))).composer).toMatchObject({ realNameRequired: true, displayPersonaRequired: false })
      await updateRealName(tx, N, { realName: '김없음' })
      expect((await createPost(tx, N, realRoom.boardId, { title: '실명', body: '본문' }, at(14))).author).toEqual({ kind: 'real', label: '김없음', schoolVerified: false, mine: true })
    })
  }, DB_TIMEOUT)
})
