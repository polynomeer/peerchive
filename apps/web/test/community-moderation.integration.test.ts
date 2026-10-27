/**
 * C-06 신고 누적 임시 숨김·방 운영진 도구·제재 요청·작성자 확인·이용 제한 통합 테스트(DELIVERY_PLAN §4.1 C-06·§5.1 M, SYSTEM_DESIGN §6.7·§8.1, ADR 0023).
 * 실제 PostgreSQL(rollback). DATABASE_URL이 없으면 건너뜁니다. 각 테스트는 자기가 만든 학교(무작위 이름)·사용자·방만 봅니다(시각은 고정 T0 기준).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  analyticsEvents,
  auditEvents,
  communityAuthorLookups,
  communityNotices,
  communityPosts,
  communitySanctions,
  eq,
  inArray,
  moderationActions,
  operators,
  reports,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { removeAffiliation } from '../server/modules/affiliation/affiliations'
import { setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { changeMemberRole, joinSpace } from '../server/modules/community/memberships'
import {
  createSanctionRequest,
  dismissSanctionRequest,
  getSpaceModeration,
  issueSanction,
  listAuthorLookups,
  listSanctionRequests,
  listSanctions,
  lookupAuthor,
  revokeSanction,
  setAutoHideThresholdsForTesting,
  spaceHideItem,
  spaceUnhideItem,
} from '../server/modules/community/moderation'
import { listMyCommunityNotices } from '../server/modules/community/notices'
import { assignModerator, createOfficialPage } from '../server/modules/community/official'
import { createComment, createPost, getPost, listBoardPosts, setReaction } from '../server/modules/community/posts'
import { createRoom } from '../server/modules/community/spaces'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { createLog } from '../server/modules/logs/logs'
import { createAppeal, listMyModerationNotices } from '../server/modules/moderation/notices'
import { decideAppeal, dismissReport, getReportDetail, listAudit, listReportGroups, resolveReport } from '../server/modules/moderation/operator'
import { createReport } from '../server/modules/moderation/reports'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createProject } from '../server/modules/projects/projects'
import { hitRateLimit } from '../server/modules/security/rate-limit'
import type { CommunityPostDto } from '../shared/types/api'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-05T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const DB_TIMEOUT = 90_000
const PEPPER = { NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'moderation-c06-analytics-pepper-0123456789abcdef' }

type Person = { userId: string; email: string; handle: string; displayName: string; affiliationId: string | null }

async function person(tx: DbExecutor, schoolId: string | null, displayName = '학생'): Promise<Person> {
  const handle = `m${rand()}`
  const name = `${displayName}${rand().slice(0, 4)}`
  const u = await createUser(tx, { handle, displayName: name })
  const aff = schoolId ? await verifiedAffiliation(tx, u.id, schoolId) : null
  return { userId: u.id, email: u.email, handle, displayName: name, affiliationId: aff?.id ?? null }
}

async function school(tx: DbExecutor) {
  const op = await person(tx, null, '운영자')
  await tx.insert(operators).values({ userId: op.userId })
  const s = await createSchool(tx, op, { name: `제재대${rand()}학교`, confirmNew: true }, T0)
  return { op, schoolId: s.id }
}

/** 익명 방 하나(owner O + 멤버들). 학교 무관 방이 기본. */
async function room(tx: DbExecutor, schoolId: string, members: number, opts: { linkSchool?: boolean; nameMode?: 'anonymous' | 'display' } = {}) {
  const O = await person(tx, schoolId, '방장')
  const created = await createRoom(tx, O, { name: `방 ${rand()}`, nameMode: opts.nameMode ?? 'anonymous', joinPolicy: 'open', ...(opts.linkSchool && { schoolId }) }, T0)
  const people: Person[] = []
  for (let i = 0; i < members; i++) {
    const p = await person(tx, schoolId, `멤버${i + 1}`)
    await joinSpace(tx, p, created.slug, at(1))
    people.push(p)
  }
  return { O, people, slug: created.slug, boardId: created.boards[0]!.id }
}

const report = (tx: DbExecutor, who: { userId: string }, postId: string, n: number, reason: 'spam' | 'harassment' = 'harassment') =>
  createReport(tx, who, { targetType: 'community_post', targetRef: { postId }, reason }, at(n))
const statusOf = async (tx: DbExecutor, postId: string) => (await tx.select({ s: communityPosts.status }).from(communityPosts).where(eq(communityPosts.id, postId)))[0]!.s

/** 응답 JSON에 이 사람들의 식별자(id·이메일·핸들·표시 이름)가 없는지. */
function expectNoIdentity(json: unknown, people: Person[], label: string) {
  const text = JSON.stringify(json)
  for (const p of people) {
    expect(text, `${label}: id`).not.toContain(p.userId)
    expect(text, `${label}: email`).not.toContain(p.email)
    expect(text, `${label}: handle`).not.toContain(p.handle)
    expect(text, `${label}: name`).not.toContain(p.displayName)
  }
}

describe.skipIf(!databaseUrl)('C-06 community moderation (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => {
    setAnalyticsEnvForTesting(null)
    setAutoHideThresholdsForTesting(null)
  })

  it('room: auto-hides exactly at 3 distinct verified reporters (self, duplicate and de-verified reporters do not count), notifies the author, prioritizes the queue', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 6)
      const [A, B, C, D, E, F] = r.people as [Person, Person, Person, Person, Person, Person]
      const post = await createPost(tx, A, r.boardId, { title: '문제 글', body: '본문' }, at(2))

      expect((await report(tx, A, post.id, 3)).created).toBe(true) // 작성자 본인: 세지 않음
      expect((await report(tx, B, post.id, 4)).created).toBe(true)
      expect((await report(tx, B, post.id, 5, 'spam')).created).toBe(false) // 같은 사람: 한 번만
      expect((await report(tx, C, post.id, 6)).created).toBe(true)
      await removeAffiliation(tx, C, C.affiliationId!, at(7)) // 인증 해제: 남은 신고도 세지 않음
      expect((await report(tx, D, post.id, 8)).created).toBe(true)
      // 지금 셀 수 있는 사람은 B·D 둘(< 3)
      expect(await statusOf(tx, post.id)).toBe('published')
      expect((await getPost(tx, F, post.id, at(8))).status).toBe('published')

      const third = await report(tx, E, post.id, 9)
      expect(third.created).toBe(true)
      expect(await statusOf(tx, post.id)).toBe('auto_hidden')

      // 다른 멤버·방장: "운영 검토 중" 자리 표시(본문·제목 없음, 신고·공감 불가), 목록에도 자리 표시
      const asF = await getPost(tx, F, post.id, at(10))
      expect(asF).toMatchObject({ status: 'auto_hidden', title: null, body: null, placeholder: '신고가 모여 운영 검토 중인 글입니다', canReport: false, canReact: false })
      const list = await listBoardPosts(tx, F, r.boardId, {}, at(10))
      expect(list.items.find((p) => p.id === post.id)).toMatchObject({ status: 'auto_hidden', title: null })
      // 작성자: 자기 글임을 알고(mine) 알림을 받음(신고자·신고 수 없음)
      const asA = await getPost(tx, A, post.id, at(10))
      expect(asA).toMatchObject({ status: 'auto_hidden', body: null, author: { mine: true } })
      const notices = await listMyCommunityNotices(tx, A)
      expect(notices.items.find((n) => n.kind === 'item_auto_hidden')).toMatchObject({ postId: post.id, target: 'post' })
      expectNoIdentity(notices, [B, C, D, E], 'author notice')
      // 숨긴 뒤에는 새 신고를 받지 않음(게시 중이 아님)
      await expectServiceError(report(tx, F, post.id, 11), 'NOT_FOUND')

      // 운영자 대기열: 임시 숨김이 맨 앞(우선 검토)
      const other = await createPost(tx, F, r.boardId, { title: '다른 글', body: '본문' }, at(1))
      await report(tx, B, other.id, 1, 'spam') // 더 오래된 일반 신고
      const groups = await listReportGroups(tx, op, {})
      const mine = groups.filter((g) => g.targetLabel.includes('커뮤니티 글'))
      expect(mine[0]).toMatchObject({ autoHidden: true, count: 5 })
      expect(groups.findIndex((g) => g.autoHidden)).toBe(0)
      expect(groups.find((g) => !g.autoHidden && g.count === 1 && g.targetType === 'community_post')).toBeTruthy()

      // 감사(report.create)에 autoHidden 참거짓만, 분석은 대상 종류만(사용자 키 없음)
      const created = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, (await tx.select({ id: reports.id }).from(reports).where(eq(reports.reporterId, E.userId)))[0]!.id))
      expect(created[0]!.metadata).toMatchObject({ autoHidden: true, targetType: 'community_post' })
      const events = await tx.select().from(analyticsEvents).where(inArray(analyticsEvents.name, ['community_auto_hidden', 'community_report_filed']))
      const recent = events.filter((e) => e.occurredAt >= T0)
      expect(recent.filter((e) => e.name === 'community_auto_hidden')).toHaveLength(1)
      expect(recent.filter((e) => e.name === 'community_report_filed').length).toBeGreaterThanOrEqual(5)
      for (const e of recent) {
        expect(Object.keys(e.props as object)).toEqual(['targetKind'])
        expect(e.projectHash).toBeNull()
      }
    })
  }, DB_TIMEOUT)

  it('official page: 5 distinct verified reporters (an operator from another school and the author do not count); comments too; thresholds are configurable', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const page = await createOfficialPage(tx, op, { schoolId }, T0)
      const author = await person(tx, schoolId, '글쓴이')
      const students = [] as Person[]
      for (let i = 0; i < 5; i++) students.push(await person(tx, schoolId, `학생${i}`))
      const post = await createPost(tx, author, page.boards[0]!.id, { title: '공식 글', body: '본문' }, at(1))
      // 다른 학교 운영자(운영자라 읽을 수 있음)와 작성자 본인은 세지 않음
      await report(tx, op, post.id, 2)
      await report(tx, author, post.id, 2)
      for (const s of students.slice(0, 4)) await report(tx, s, post.id, 3)
      expect(await statusOf(tx, post.id)).toBe('published')
      await report(tx, students[4]!, post.id, 4)
      expect(await statusOf(tx, post.id)).toBe('auto_hidden')

      // 댓글: 방 기준 3(학교 연결 방)
      const r = await room(tx, schoolId, 4, { linkSchool: true })
      const p2 = await createPost(tx, r.people[0]!, r.boardId, { title: '글', body: '본문' }, at(5))
      const thread = await createComment(tx, r.people[1]!, p2.id, { body: '문제 댓글' }, at(6))
      const commentId = thread.comments[0]!.id
      for (const who of [r.people[0]!, r.people[2]!, r.people[3]!]) {
        await createReport(tx, who, { targetType: 'community_comment', targetRef: { commentId }, reason: 'spam' }, at(7))
      }
      const after = await getPost(tx, r.O, p2.id, at(8))
      expect(after.comments[0]).toMatchObject({ status: 'auto_hidden', body: null, placeholder: '신고가 모여 운영 검토 중인 댓글입니다' })
      expect(after.status).toBe('published')

      // 환경 설정으로 바꾼 기준(방 2)
      setAutoHideThresholdsForTesting({ official: 5, room: 2 })
      const p3 = await createPost(tx, r.people[0]!, r.boardId, { title: '두 번째', body: '본문' }, at(9))
      await report(tx, r.people[1]!, p3.id, 10)
      expect(await statusOf(tx, p3.id)).toBe('published')
      await report(tx, r.people[2]!, p3.id, 10)
      expect(await statusOf(tx, p3.id)).toBe('auto_hidden')
    })
  }, DB_TIMEOUT)

  it('operator restore (dismiss → published, note recorded, author told) and confirm (hide_post → hidden); one report per reporter per target even after closing', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 5)
      const [A, B, C, D, E] = r.people as [Person, Person, Person, Person, Person]
      const restoreMe = await createPost(tx, A, r.boardId, { title: '오해 글', body: '본문' }, at(1))
      const confirmMe = await createPost(tx, A, r.boardId, { title: '진짜 문제', body: '본문' }, at(1))
      for (const who of [B, C, D]) await report(tx, who, restoreMe.id, 2)
      for (const who of [B, C, D]) await report(tx, who, confirmMe.id, 2)
      expect(await statusOf(tx, restoreMe.id)).toBe('auto_hidden')
      expect(await statusOf(tx, confirmMe.id)).toBe('auto_hidden')
      const groups = await listReportGroups(tx, op, {})
      const restoreGroup = groups.find((g) => g.autoHidden && g.reportId)!
      const restoreDetail = await getReportDetail(tx, op, restoreGroup.reportId, at(3))
      const restoreReportId = restoreDetail.content.kind === 'community_post' && restoreDetail.content.item.postId === restoreMe.id ? restoreGroup.reportId : groups.filter((g) => g.autoHidden)[1]!.reportId

      await dismissReport(tx, op, restoreReportId, { note: '정상 글로 판단' }, at(4))
      expect(await statusOf(tx, restoreMe.id)).toBe('published')
      expect((await getPost(tx, E, restoreMe.id, at(4))).body).toBe('본문')
      const actions = await tx.select().from(moderationActions).where(eq(moderationActions.communityPostId, restoreMe.id))
      expect(actions).toMatchObject([{ kind: 'none', outcome: 'dismissed', internalNote: '정상 글로 판단' }])
      expect((await listMyCommunityNotices(tx, A)).items.find((n) => n.kind === 'item_restored')).toMatchObject({ postId: restoreMe.id })
      // 같은 사람은 같은 글을 다시 신고해도 새 신고가 아님(닫힌 신고를 돌려줌) → 다시 숨기지 못함
      const again = await report(tx, B, restoreMe.id, 5)
      expect(again).toMatchObject({ created: false, status: 'dismissed' })
      expect(await statusOf(tx, restoreMe.id)).toBe('published')
      // 새 사람 셋이 다시 모이면 다시 숨김(처리 전 신고만 셈)
      await report(tx, E, restoreMe.id, 6)
      expect(await statusOf(tx, restoreMe.id)).toBe('published')

      // 확정: hide_post
      const confirmGroup = (await listReportGroups(tx, op, {})).find((g) => g.autoHidden)!
      await resolveReport(tx, op, confirmGroup.reportId, { action: 'hide_post', note: '비방 확인', publicReason: '비방', notifyOwner: true }, at(7))
      expect(await statusOf(tx, confirmMe.id)).toBe('hidden')
      expect((await getPost(tx, E, confirmMe.id, at(7))).placeholder).toBe('운영 조치로 가려진 글입니다')
      expect((await listMyModerationNotices(tx, A)).find((n) => n.kind === 'hide_post')).toMatchObject({ publicReason: '비방', canAppeal: true })
    })
  }, DB_TIMEOUT)

  it('owner/moderator tools: space hide with a public reason, reversible by any moderator or via appeal; responses, panel and notices carry no author identity', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 3)
      const [A, M, N] = r.people as [Person, Person, Person]
      await changeMemberRole(tx, r.O, r.slug, M.userId, { role: 'moderator' }, at(2))
      const post = await createPost(tx, A, r.boardId, { title: '익명 글', body: '본문' }, at(3))
      const thread = await createComment(tx, A, post.id, { body: '익명 댓글' }, at(3))
      const commentId = thread.comments[0]!.id

      // 일반 멤버는 가릴 수 없음(403), 운영진이 아니면 운영 화면도 403
      await expectServiceError(spaceHideItem(tx, N, 'post', post.id, { publicReason: '스팸' }, at(4)), 'FORBIDDEN', 'moderate_not_allowed')
      await expectServiceError(getSpaceModeration(tx, N, r.slug, at(4)), 'FORBIDDEN', 'moderate_not_allowed')
      await expectServiceError(spaceHideItem(tx, r.O, 'post', post.id, { publicReason: ' ' }, at(4)), 'VALIDATION')

      const hidden = await spaceHideItem(tx, r.O, 'post', post.id, { publicReason: '방 규칙 위반', note: '두 번째 경고' }, at(5))
      expect(hidden).toMatchObject({ status: 'hidden', title: null, body: null, placeholder: '운영 조치로 가려진 글입니다' })
      const hiddenComment = await spaceHideItem(tx, M, 'comment', commentId, { publicReason: '도배' }, at(5))
      expect(hiddenComment.comments[0]).toMatchObject({ status: 'hidden', body: null })
      // 방장 응답과 일반 멤버 응답이 같고(작성자 표시 동일), 작성자 식별자가 없음
      expect(await getPost(tx, r.O, post.id, at(6))).toEqual(await getPost(tx, N, post.id, at(6)))
      expectNoIdentity([hidden, hiddenComment], [A], 'space hide response')
      await expectServiceError(spaceHideItem(tx, r.O, 'post', post.id, { publicReason: '또' }, at(6)), 'CONFLICT', 'target_not_open')

      const panel = await getSpaceModeration(tx, M, r.slug, at(6))
      expect(panel.hides.map((h) => h.targetType).sort()).toEqual(['comment', 'post'])
      expectNoIdentity(panel, [A], 'moderation panel')
      // 감사: 운영진이 행위자, 대상은 글 id, metadata는 id만
      const audit = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, post.id))
      expect(audit.find((a) => a.action === 'community.space_hide')).toMatchObject({ actorId: r.O.userId, targetType: 'community_post' })
      expectNoIdentity(audit, [A], 'audit')

      // 작성자에게: 공개 사유·이의제기(누가 가렸는지 없음). 방장은 당사자가 아님.
      const notices = await listMyModerationNotices(tx, A)
      const postNotice = notices.find((n) => n.kind === 'space_hide' && n.targetType === 'community_post')!
      expect(postNotice).toMatchObject({ publicReason: '방 규칙 위반', canAppeal: true, sanction: null })
      expect(JSON.stringify(notices)).not.toContain(r.O.userId)
      expect(JSON.stringify(notices)).not.toContain('두 번째 경고')
      expect(await listMyModerationNotices(tx, r.O)).toEqual([])

      // 다른 운영진이 되돌림(누가 가렸든) → 다시 보임
      const restored = await spaceUnhideItem(tx, M, 'post', post.id, {}, at(7))
      expect(restored).toMatchObject({ status: 'published', body: '본문' })
      await expectServiceError(spaceUnhideItem(tx, M, 'post', post.id, {}, at(7)), 'CONFLICT', 'not_space_hidden')
      // 댓글은 작성자의 이의제기 → 운영자 되돌림
      const commentNotice = (await listMyModerationNotices(tx, A)).find((n) => n.kind === 'space_hide' && n.targetType === 'community_comment')!
      const appeal = await createAppeal(tx, A, { actionId: commentNotice.actionId, message: '도배 아님' }, at(8))
      await decideAppeal(tx, op, appeal.id, { decision: 'reverse', note: '되돌림' }, at(9))
      expect((await getPost(tx, N, post.id, at(9))).comments[0]).toMatchObject({ status: 'published', body: '익명 댓글' })

      // 운영자가 가린 것(hide_post)과 겹치면 방 운영진 되돌림으로는 풀리지 않음
      for (const who of [M, N, r.O]) await report(tx, who, post.id, 10)
      expect(await statusOf(tx, post.id)).toBe('auto_hidden')
      const g = (await listReportGroups(tx, op, {})).find((x) => x.autoHidden)!
      await resolveReport(tx, op, g.reportId, { action: 'hide_post', note: '확정', publicReason: '비방', notifyOwner: true }, at(11))
      await expectServiceError(spaceUnhideItem(tx, r.O, 'post', post.id, {}, at(12)), 'CONFLICT', 'not_space_hidden')
      expect(await statusOf(tx, post.id)).toBe('hidden')

      // 공식 페이지 모더레이터도 자기 페이지에서 가릴 수 있음
      const page = await createOfficialPage(tx, op, { schoolId }, T0)
      const mod = await person(tx, schoolId, '모더')
      await assignModerator(tx, op, page.slug, { userId: mod.userId }, at(12))
      const official = await createPost(tx, A, page.boards[0]!.id, { title: '공식 글', body: '본문' }, at(13))
      expect((await spaceHideItem(tx, mod, 'post', official.id, { publicReason: '도배' }, at(14))).status).toBe('hidden')
      await expectServiceError(spaceHideItem(tx, mod, 'post', post.id, { publicReason: '남의 방' }, at(14)), 'NOT_FOUND')
    })
  }, DB_TIMEOUT)

  it('sanction request → operator lookup (reason required, audit ids only, lookup log without author) → space write suspension blocks only that room; owner never learns who', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 2)
      const [A, B] = r.people as [Person, Person]
      const r2 = await room(tx, schoolId, 0)
      await joinSpace(tx, A, r2.slug, at(1))
      const post = await createPost(tx, A, r.boardId, { title: '익명 비방', body: '본문' }, at(2))

      // 방장이 작성자를 모른 채 요청(같은 대상 다시 → 기존 요청)
      await expectServiceError(createSanctionRequest(tx, B, { targetType: 'post', targetId: post.id, reason: 'harassment', details: '비방' }, at(3)), 'FORBIDDEN')
      await expectServiceError(createSanctionRequest(tx, r.O, { targetType: 'post', targetId: post.id, reason: 'harassment' }, at(3)), 'VALIDATION')
      const req = await createSanctionRequest(tx, r.O, { targetType: 'post', targetId: post.id, reason: 'harassment', details: '반복 비방' }, at(3))
      expect(req).toMatchObject({ created: true, status: 'received' })
      expect((await createSanctionRequest(tx, r.O, { targetType: 'post', targetId: post.id, reason: 'spam', details: '또' }, at(4))).created).toBe(false)
      expectNoIdentity(req, [A], 'request receipt')
      const opRequests = await listSanctionRequests(tx, op, {})
      const opRequest = opRequests.find((x) => x.id === req.id)!
      expect(opRequest).toMatchObject({ targetType: 'post', targetId: post.id, details: '반복 비방', item: { authorLabel: '익명' } })
      expectNoIdentity(opRequests, [A], 'operator request list')

      // 작성자 확인: 운영자만, 사유 필수, 근거가 다른 대상이면 422
      await expectServiceError(lookupAuthor(tx, r.O, { targetType: 'post', targetId: post.id, reason: '확인' }, at(5)), 'FORBIDDEN', 'operator_only')
      const noReason = await expectServiceError(lookupAuthor(tx, op, { targetType: 'post', targetId: post.id }, at(5)), 'VALIDATION')
      expect(noReason.fields).toMatchObject({ reason: 'required' })
      const other = await createPost(tx, B, r.boardId, { title: '다른 글', body: '본문' }, at(5))
      const mismatch = await expectServiceError(lookupAuthor(tx, op, { targetType: 'post', targetId: other.id, reason: '확인', requestId: req.id }, at(5)), 'VALIDATION')
      expect(mismatch.fields).toMatchObject({ requestId: 'mismatch' })
      const lookup = await lookupAuthor(tx, op, { targetType: 'post', targetId: post.id, reason: '방장 요청: 반복 비방 확인', requestId: req.id }, at(6))
      expect(lookup.author).toMatchObject({ userId: A.userId, handle: A.handle, status: 'active', purged: false })
      expect(JSON.stringify(lookup)).not.toContain(A.email)
      // 감사: 행위자 운영자·대상 글·metadata는 id뿐(작성자 id·사유 없음)
      const lookupAudit = (await tx.select().from(auditEvents).where(eq(auditEvents.action, 'community.author_lookup'))).filter((e) => e.targetId === post.id)
      expect(lookupAudit).toHaveLength(1)
      expect(lookupAudit[0]).toMatchObject({ actorId: op.userId, targetType: 'community_post', metadata: { lookupId: lookup.lookupId, requestId: req.id, reportId: null } })
      expect(JSON.stringify(lookupAudit)).not.toContain(A.userId)
      expect(JSON.stringify(lookupAudit)).not.toContain('반복 비방')
      // 조회 기록: 사유는 기록 테이블에, 목록에는 작성자 없음
      expect((await tx.select().from(communityAuthorLookups).where(eq(communityAuthorLookups.id, lookup.lookupId)))[0]).toMatchObject({ reason: '방장 요청: 반복 비방 확인', authorId: A.userId })
      const log = await listAuthorLookups(tx, op, { target: post.id })
      expect(log).toMatchObject([{ id: lookup.lookupId, targetId: post.id, reason: '방장 요청: 반복 비방 확인', requestId: req.id, sanctioned: false }])
      expectNoIdentity(log, [A], 'lookup log')
      // 운영자 감사 조회(대상 글 id)도 작성자를 주지 않음
      expectNoIdentity(await listAudit(tx, op, { target: post.id }), [A], 'operator audit by post')

      // 제재 발급: 이 방 범위 7일 쓰기 제한
      await expectServiceError(issueSanction(tx, op, { lookupId: lookup.lookupId, level: 'permanent', scope: 'space', note: 'n', publicReason: 'p' }, at(7)), 'VALIDATION')
      await expectServiceError(issueSanction(tx, op, { lookupId: lookup.lookupId, level: 'write_suspended', scope: 'space', note: 'n', publicReason: 'p' }, at(7)), 'VALIDATION')
      const sanction = await issueSanction(
        tx,
        op,
        { lookupId: lookup.lookupId, level: 'write_suspended', scope: 'space', days: 7, note: '반복 비방, 1차 제한', publicReason: '반복된 비방' },
        at(7),
      )
      expect(sanction).toMatchObject({ level: 'write_suspended', scope: 'space', active: true, requestId: req.id })
      expectNoIdentity([sanction, await listSanctions(tx, op, {}, at(8))], [A], 'operator sanctions')
      const issueAudit = (await tx.select().from(auditEvents).where(eq(auditEvents.targetId, sanction.id)))[0]!
      expect(issueAudit).toMatchObject({ action: 'community.sanction_issue', targetType: 'community_sanction' })
      expect(JSON.stringify(issueAudit)).not.toContain(A.userId)
      expect(JSON.stringify(issueAudit)).not.toContain('반복 비방')
      const sEvents = (await tx.select().from(analyticsEvents).where(eq(analyticsEvents.name, 'community_sanction_issued'))).filter((e) => e.occurredAt >= T0)
      expect(sEvents.map((e) => e.props)).toEqual([{ level: 'write_suspended', scope: 'space' }])

      // 이 방: 글·댓글·공감 막힘(403 write_restricted + 수준·범위·기한), 글쓰기 안내에 제한(본인만)
      const blocked = await expectServiceError(createPost(tx, A, r.boardId, { title: '또', body: '본문' }, at(8)), 'FORBIDDEN', 'write_restricted')
      expect(blocked.details).toMatchObject({ level: 'write_suspended', scope: 'space', until: new Date(at(7).getTime() + days(7)).toISOString() })
      await expectServiceError(createComment(tx, A, other.id, { body: '댓글' }, at(8)), 'FORBIDDEN', 'write_restricted')
      await expectServiceError(setReaction(tx, A, 'post', other.id, true, at(8)), 'FORBIDDEN', 'write_restricted')
      expect((await listBoardPosts(tx, A, r.boardId, {}, at(8))).composer).toMatchObject({ canWrite: false, restriction: { scope: 'space', level: 'write_suspended' } })
      expect((await listBoardPosts(tx, B, r.boardId, {}, at(8))).composer).toMatchObject({ canWrite: true, restriction: null })
      // 읽기는 그대로
      expect((await getPost(tx, A, other.id, at(8))).body).toBe('본문')
      // 다른 방: 자유롭게 씀
      expect((await createPost(tx, A, r2.boardId, { title: '다른 방 글', body: '본문' }, at(8))).status).toBe('published')

      // 방장: 요청 결과는 "제재가 내려짐"과 이 방 제한 개수뿐, 누구인지는 없음
      const panel = await getSpaceModeration(tx, r.O, r.slug, at(8))
      expect(panel.activeSpaceRestrictions).toBe(1)
      expect(panel.requests.find((x) => x.id === req.id)).toMatchObject({ status: 'resolved', outcome: 'sanctioned', mine: true })
      expectNoIdentity(panel, [A], 'owner panel after sanction')

      // 당사자 안내: 수준·범위·공간·기한·사유(요청자·확인자 없음), 이의제기는 한 번
      const notice = (await listMyModerationNotices(tx, A)).find((n) => n.kind === 'sanction')!
      expect(notice).toMatchObject({ publicReason: '반복된 비방', canAppeal: true, ownerPath: '/community', sanction: { level: 'write_suspended', scope: 'space', active: true } })
      expect(JSON.stringify(notice)).not.toContain(r.O.userId)
      expect(JSON.stringify(notice)).not.toContain(op.userId)
      expect(JSON.stringify(notice)).not.toContain('1차 제한')

      // 기한이 지나면 다시 씀(되돌리지 않아도)
      expect((await createPost(tx, A, r.boardId, { title: '기한 뒤', body: '본문' }, new Date(at(7).getTime() + days(7) + minutes(1)))).status).toBe('published')
      expect(await getSpaceModeration(tx, r.O, r.slug, new Date(at(7).getTime() + days(8)))).toMatchObject({ activeSpaceRestrictions: 0 })
    })
  }, DB_TIMEOUT)

  it('community scope, warning and permanent levels; appeal once; operator revoke; lookups are per-operator, expire after 24h and are rate limited', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const op2 = await person(tx, null, '운영자2')
      await tx.insert(operators).values({ userId: op2.userId })
      const r = await room(tx, schoolId, 1)
      const r2 = await room(tx, schoolId, 0)
      const [A] = r.people as [Person]
      await joinSpace(tx, A, r2.slug, at(1))
      const post = await createPost(tx, A, r.boardId, { title: '글', body: '본문' }, at(2))
      const lk = (n: number) => lookupAuthor(tx, op, { targetType: 'post', targetId: post.id, reason: '신고 검토' }, at(n))

      // 경고: 알림만, 쓰기 그대로
      const warn = await issueSanction(tx, op, { lookupId: (await lk(3)).lookupId, level: 'warning', scope: 'space', note: '경고', publicReason: '주의 바랍니다' }, at(3))
      expect(warn).toMatchObject({ level: 'warning', until: null, active: true })
      expect((await createPost(tx, A, r.boardId, { title: '경고 뒤', body: '본문' }, at(4))).status).toBe('published')
      expect((await listMyModerationNotices(tx, A)).find((n) => n.actionId === warn.actionId)).toMatchObject({ sanction: { level: 'warning' } })
      await expectServiceError(
        issueSanction(tx, op, { lookupId: (await lk(4)).lookupId, level: 'warning', scope: 'space', days: 3, note: 'n', publicReason: 'p' }, at(4)),
        'VALIDATION',
      )

      // 다른 운영자의 확인, 24시간 지난 확인으로는 발급 불가
      const mine = await lk(5)
      await expectServiceError(issueSanction(tx, op2, { lookupId: mine.lookupId, level: 'warning', scope: 'space', note: 'n', publicReason: 'p' }, at(5)), 'CONFLICT', 'lookup_not_yours')
      await expectServiceError(
        issueSanction(tx, op, { lookupId: mine.lookupId, level: 'warning', scope: 'space', note: 'n', publicReason: 'p' }, new Date(at(5).getTime() + days(1) + minutes(1))),
        'CONFLICT',
        'lookup_expired',
      )

      // 커뮤니티 전체 기간 제한: 모든 방 + 방 만들기 막힘
      const community = await issueSanction(tx, op, { lookupId: mine.lookupId, level: 'write_suspended', scope: 'community', days: 3, note: 'n', publicReason: '전체 제한' }, at(6))
      await expectServiceError(createPost(tx, A, r2.boardId, { title: 'x', body: 'y' }, at(7)), 'FORBIDDEN', 'write_restricted')
      await expectServiceError(createRoom(tx, A, { name: `새 방 ${rand()}`, nameMode: 'anonymous', joinPolicy: 'open' }, at(7)), 'FORBIDDEN', 'write_restricted')
      // 이의제기는 한 번 → 운영자가 되돌리면 풀림
      const appeal = await createAppeal(tx, A, { actionId: community.actionId, message: '과합니다' }, at(8))
      await expectServiceError(createAppeal(tx, A, { actionId: community.actionId, message: '다시' }, at(8)), 'CONFLICT', 'already_appealed')
      await decideAppeal(tx, op, appeal.id, { decision: 'reverse', note: '감경' }, at(9))
      expect((await tx.select().from(communitySanctions).where(eq(communitySanctions.id, community.id)))[0]!.revokedAt).not.toBeNull()
      expect((await createPost(tx, A, r2.boardId, { title: '풀린 뒤', body: '본문' }, at(10))).status).toBe('published')

      // 영구 제한(커뮤니티 전체만) → 운영자 해제
      const perm = await issueSanction(tx, op, { lookupId: (await lk(11)).lookupId, level: 'permanent', scope: 'community', note: 'n', publicReason: '영구' }, at(11))
      await expectServiceError(setReaction(tx, A, 'post', (await createPost(tx, r.O, r.boardId, { title: '방장 글', body: 'b' }, at(11))).id, true, at(400 * 24 * 60)), 'FORBIDDEN', 'write_restricted')
      const revoked = await revokeSanction(tx, op, perm.id, { note: '해제' }, at(12))
      expect(revoked).toMatchObject({ active: false })
      await expectServiceError(revokeSanction(tx, op, perm.id, { note: '또' }, at(12)), 'CONFLICT', 'already_revoked')
      expect((await createPost(tx, A, r.boardId, { title: '해제 뒤', body: '본문' }, at(13))).status).toBe('published')
      expect(await listSanctions(tx, op, { status: 'active' }, at(13))).toEqual(expect.not.arrayContaining([expect.objectContaining({ id: perm.id })]))

      // 확인 한도: 시간당 20(같은 창에서 이미 쓴 것 포함) → 429
      const used = (await tx.select().from(communityAuthorLookups).where(eq(communityAuthorLookups.operatorId, op.userId))).filter((l) => l.createdAt.getTime() < at(60).getTime()).length
      for (let i = used; i < 20; i++) await lk(14)
      await expectServiceError(lk(14), 'RATE_LIMITED')
      // 다른 운영자의 한도는 따로
      expect((await lookupAuthor(tx, op2, { targetType: 'post', targetId: post.id, reason: '확인' }, at(14))).author.userId).toBe(A.userId)
      // 제재 요청 기각
      const req = await createSanctionRequest(tx, r.O, { targetType: 'post', targetId: post.id, reason: 'spam', details: '도배' }, at(15))
      expect((await dismissSanctionRequest(tx, op, req.id, { note: '근거 부족' }, at(16))).status).toBe('dismissed')
      expect((await getSpaceModeration(tx, r.O, r.slug, at(16))).requests.find((x) => x.id === req.id)).toMatchObject({ status: 'dismissed', outcome: 'no_action' })
    })
  }, DB_TIMEOUT)

  it('sanctions never touch project workspaces, portfolio, public profile or course-hub reading', async () => {
    await withRollback(async (tx) => {
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 1)
      const [A] = r.people as [Person]
      const post = await createPost(tx, A, r.boardId, { title: '글', body: '본문' }, at(1))
      const lookup = await lookupAuthor(tx, op, { targetType: 'post', targetId: post.id, reason: '확인' }, at(2))
      await issueSanction(tx, op, { lookupId: lookup.lookupId, level: 'permanent', scope: 'community', note: 'n', publicReason: '영구' }, at(2))
      await expectServiceError(createPost(tx, A, r.boardId, { title: 'x', body: 'y' }, at(3)), 'FORBIDDEN', 'write_restricted')

      const course = await createCourse(tx, A, schoolId, { title: `과목${rand()}`, code: `C6-${rand().slice(0, 4)}`, confirmNew: true }, at(3))
      const { term } = await createCourseTerm(tx, A, course.id, { year: 2025, semester: 'fall' }, at(3))
      const project = await createProject(tx, A, { title: '내 과제', courseTermId: term.id }, at(4))
      const log = await createLog(tx, A, project.id, { tag: 'progress', body: '진행', links: [] }, at(5))
      expect(log.created).toBe(true)
      expect((await getPublicPortfolioProfile(tx, A.handle, at(6))).handle).toBe(A.handle)
      expect((await getPublicCourseHub(tx, course.id, at(6))).course.id).toBe(course.id)
      // 쓰기 한도 표(rate limit)에 제재 흔적 없음: 과제 쪽 한도와 무관
      expect(await hitRateLimit(tx, `c06-probe-${rand()}`, A.userId, { limit: 1, windowMs: 60_000 }, at(6))).toBe(true)
    })
  }, DB_TIMEOUT)

  it('no other path reveals anonymous authors: thread DTOs, notices, operator report detail, lookup log, sanction list, audit and analytics', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const { op, schoolId } = await school(tx)
      const r = await room(tx, schoolId, 4)
      const [A, B, C, D] = r.people as [Person, Person, Person, Person]
      const post = await createPost(tx, A, r.boardId, { title: '익명', body: '본문' }, at(1))
      for (const who of [B, C, D]) await report(tx, who, post.id, 2)
      const req = await createSanctionRequest(tx, r.O, { targetType: 'post', targetId: post.id, reason: 'harassment', details: '요청' }, at(3))
      const lookup = await lookupAuthor(tx, op, { targetType: 'post', targetId: post.id, reason: '확인', requestId: req.id }, at(4))
      await issueSanction(tx, op, { lookupId: lookup.lookupId, level: 'write_suspended', scope: 'space', days: 3, note: 'n', publicReason: 'p' }, at(5))

      const g = (await listReportGroups(tx, op, {})).find((x) => x.autoHidden)!
      const surfaces = {
        ownerThread: await getPost(tx, r.O, post.id, at(6)),
        memberThread: await getPost(tx, B, post.id, at(6)),
        ownerPanel: await getSpaceModeration(tx, r.O, r.slug, at(6)),
        ownerNotices: [await listMyCommunityNotices(tx, r.O), await listMyModerationNotices(tx, r.O)],
        reporterNotices: [await listMyCommunityNotices(tx, B), await listMyModerationNotices(tx, B)],
        reportDetail: await getReportDetail(tx, op, g.reportId, at(6)),
        groups: await listReportGroups(tx, op, {}),
        lookupLog: await listAuthorLookups(tx, op, {}),
        sanctions: await listSanctions(tx, op, { status: 'all' }, at(6)),
        requests: await listSanctionRequests(tx, op, { status: 'resolved' }),
        auditByPost: await listAudit(tx, op, { target: post.id }),
        auditByRequest: await listAudit(tx, op, { target: req.id }),
      }
      for (const [label, value] of Object.entries(surfaces)) expectNoIdentity(value, [A], label)
      // 운영자가 행위자인 C-06 감사 행 모두: 작성자 id 없음
      const c06 = await tx
        .select()
        .from(auditEvents)
        .where(sql`${auditEvents.action} in ('community.author_lookup', 'community.sanction_issue', 'community.sanction_request', 'community.space_hide') and ${auditEvents.at} >= now()`)
      expect(c06.length).toBeGreaterThanOrEqual(3)
      expectNoIdentity(c06, [A], 'c06 audit')
      // 분석: C-06 이벤트와 작성자 확인(C-10)은 사용자 키 없이(actor_hash null, ADR 0027)
      const ev = (
        await tx.select().from(analyticsEvents).where(inArray(analyticsEvents.name, ['community_report_filed', 'community_auto_hidden', 'community_sanction_issued', 'community_author_lookup']))
      ).filter((e) => e.occurredAt >= T0)
      expect(ev.length).toBeGreaterThan(0)
      expect(ev.every((e) => e.actorHash === null && e.projectHash === null)).toBe(true)
      // 알림 행: 작성자에게만(신고자에게 auto-hide 알림 없음)
      const rows = await tx.select().from(communityNotices).where(eq(communityNotices.postId, post.id))
      expect(rows.every((n) => n.userId === A.userId)).toBe(true)
      expect((surfaces.ownerThread as CommunityPostDto).author).toEqual((surfaces.memberThread as CommunityPostDto).author)
    })
  }, DB_TIMEOUT)
})
