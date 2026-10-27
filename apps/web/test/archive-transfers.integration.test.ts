/**
 * C-09 아카이브로 옮기기 통합 테스트(DELIVERY_PLAN §4.1 C-09, PROOFU_EVOLUTION_PLAN §8.3·§8.5·§8.9.8, SYSTEM_DESIGN §6.7 ArchiveTransfer·§8.2, ADR 0025).
 *
 * - 채택된 답변(질문 게시판·글쓴이만·최상위 댓글·바꾸기·풀기).
 * - 막힘 Q&A: 동의 전 복사 없음, 답한 사람 익명(요청한 사람 응답에 답한 사람 식별자 없음), 해시 묶기(stale_content), 요청 뒤 고친 글은 옮겨지지 않음(얼린 스냅샷),
 *   공개 DTO는 복사한 글과 고른 이름뿐, 어느 쪽이든 즉시 철회(검색 문서가 남아도 안 보임), 거절·만료·취소, 허브 작성 자격(요청한 사람), 다른 학교 과목.
 * - 막힘 로그(내 과제만), 선배 노트 초안(게시 절차 그대로), 운영 조치(가린 원 글·답변 → 시작 불가·진행 중 취소, 막힘 Q&A 신고·숨기기·되돌리기),
 *   탈퇴 정리, 경계(아카이브 테이블에 커뮤니티 외래 키 없음), 센티넬(옮기지 않은 글은 어디에도 복사되지 않음).
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 학교·사용자만 봅니다.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createFilesystemStorage } from '@peerchive/files'
import {
  analyticsEvents,
  and,
  archiveTransferConsents,
  archiveTransfers,
  courseQaItems,
  eq,
  hashSubject,
  logEntries,
  logRevisions,
  operators,
  outboxEvents,
  personas,
  searchDocuments,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { handleCourseQaPublished, handleCourseQaWithdrawn } from '../../worker/src/course-hub-derived'
import { purgeAccount } from '../../worker/src/ops/purge'
import { setAnalyticsEnvForTesting } from '../server/modules/analytics/analytics'
import { createCourse, createSchool } from '../server/modules/catalog/catalog'
import {
  cancelArchiveTransfer,
  createArchiveTransfer,
  decideArchiveConsent,
  getArchiveOptions,
  getArchiveTransfer,
} from '../server/modules/community/archive-transfers'
import { hideCommunityItemInTx } from '../server/modules/community/moderation'
import { listMyCommunityNotices } from '../server/modules/community/notices'
import { createOfficialPage } from '../server/modules/community/official'
import { createComment, createPost, deleteComment, editComment, editPost, getPost, setAcceptedAnswer } from '../server/modules/community/posts'
import { createRoom, getSpaceDetail } from '../server/modules/community/spaces'
import { listMyCourseQa, withdrawCourseQa } from '../server/modules/course-hub/course-qa'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { searchPublic } from '../server/modules/course-hub/search'
import { publishSeniorNote, updateSeniorNote } from '../server/modules/course-hub/senior-notes'
import { putSignal } from '../server/modules/course-hub/signals'
import { updateRealName } from '../server/modules/identity/profiles'
import { createAppeal, listMyModerationNotices } from '../server/modules/moderation/notices'
import { decideAppeal, resolveReport } from '../server/modules/moderation/operator'
import { createReport } from '../server/modules/moderation/reports'
import { createProject } from '../server/modules/projects/projects'
import { COMMUNITY_TABLE_SQL } from './community-tables'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, insertDisplayPersona, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-10T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const DB_TIMEOUT = 60_000
const PEPPER = { NODE_ENV: 'test', PEERCHIVE_ANALYTICS_PEPPER: 'archive-analytics-pepper-for-tests-0123456789abcdef' }

type Person = { userId: string; email: string; handle: string; name: string; accountName: string }

/** `name`은 표시명 페르소나의 이름(표시명 방식 글·복사본 이름, ADR 0030), 계정 표시 이름은 일부러 다른 값입니다. */
async function person(tx: DbExecutor, schoolId: string | null, label: string): Promise<Person> {
  const handle = `a${rand()}`
  const name = `${label}${rand().slice(0, 6)}`
  const accountName = `계정${name}`
  const u = await createUser(tx, { handle, displayName: accountName })
  await insertDisplayPersona(tx, u.id, name)
  if (schoolId) await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id, email: u.email, handle, name, accountName }
}

async function world(tx: DbExecutor) {
  const op = await person(tx, null, '운영자')
  await tx.insert(operators).values({ userId: op.userId })
  const school = await createSchool(tx, op, { name: `옮김대${rand()}학교`, confirmNew: true }, T0)
  const otherSchool = await createSchool(tx, op, { name: `남의대${rand()}학교`, confirmNew: true }, T0)
  const asker = await person(tx, school.id, '질문자')
  const answerer = await person(tx, school.id, '답변자')
  const reader = await person(tx, school.id, '읽는이')
  const course = await createCourse(tx, asker, school.id, { title: `운영체제${rand()}`, code: `OS-${rand().slice(0, 4)}`, confirmNew: true }, T0)
  const otherCourse = await createCourse(tx, op, otherSchool.id, { title: `남의과목${rand()}`, confirmNew: true }, T0)
  const official = await createOfficialPage(tx, op, { schoolId: school.id, name: `옮김 공식 ${rand()}` }, T0)
  const detail = await getSpaceDetail(tx, asker, official.slug, T0)
  const board = (kind: string) => detail.boards.find((b) => b.kind === kind)!.id
  return { op, asker, answerer, reader, schoolId: school.id, otherSchoolId: otherSchool.id, courseId: course.id, otherCourseId: otherCourse.id, slug: official.slug, questionBoard: board('question'), freeBoard: board('free') }
}

type World = Awaited<ReturnType<typeof world>>

/** 질문 글(익명 공식 페이지) + 답한 사람의 댓글 + 채택. */
async function question(tx: DbExecutor, w: World, body = '자식 프로세스가 좀비로 남아요. 어디를 봐야 하나요?', answer = 'waitpid로 회수하는지 먼저 확인해 보세요.') {
  const post = await createPost(tx, w.asker, w.questionBoard, { title: `fork 질문 ${rand().slice(0, 4)}`, body }, at(1))
  const thread = await createComment(tx, w.answerer, post.id, { body: answer }, at(2))
  const commentId = thread.comments[0]!.id
  await setAcceptedAnswer(tx, w.asker, post.id, { commentId }, at(3))
  return { postId: post.id, commentId }
}

const qaInput = (w: World, over: Record<string, unknown> = {}) => ({ target: 'course_qa', courseId: w.courseId, displayMode: 'anonymous', ...over })

/** 요청한 사람 응답에 답한 사람을 가리킬 수 있는 값이 없는지. */
function expectNoAnswererIdentity(json: unknown, w: World) {
  const text = JSON.stringify(json)
  for (const v of [w.answerer.userId, w.answerer.email, w.answerer.handle, w.answerer.name, w.answerer.accountName]) expect(text).not.toContain(v)
}

describe.skipIf(!databaseUrl)('C-09 archive transfers (PostgreSQL)', () => {
  afterAll(closeTestDb)
  afterEach(() => setAnalyticsEnvForTesting(null))

  it('accepted answers: question boards only, post author only, top-level open comments, change and unmark', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const post = await createPost(tx, w.asker, w.questionBoard, { title: '질문', body: '본문' }, at(1))
      const a = (await createComment(tx, w.answerer, post.id, { body: '답 하나' }, at(2))).comments[0]!
      const b = (await createComment(tx, w.reader, post.id, { body: '답 둘' }, at(3))).comments[1]!
      const reply = await createComment(tx, w.reader, post.id, { body: '답글', parentCommentId: a.id }, at(4))
      const replyId = reply.comments[0]!.replies[0]!.id

      await expectServiceError(setAcceptedAnswer(tx, w.answerer, post.id, { commentId: a.id }, at(5)), 'FORBIDDEN', 'not_author')
      await expectServiceError(setAcceptedAnswer(tx, w.asker, post.id, { commentId: replyId }, at(5)), 'VALIDATION')
      const accepted = await setAcceptedAnswer(tx, w.asker, post.id, { commentId: a.id }, at(5))
      expect(accepted.acceptedCommentId).toBe(a.id)
      expect(accepted.comments.find((c) => c.id === a.id)!.accepted).toBe(true)
      // 채택 표시는 작성자 표시를 바꾸지 않음(익명 번호 그대로, 사람 id 없음)
      expect(accepted.comments.find((c) => c.id === a.id)!.author.label).toBe('익명1')
      expectNoAnswererIdentity(await getPost(tx, w.reader, post.id, at(5)), w)
      // 다른 사람에게는 채택 버튼이 없음
      expect((await getPost(tx, w.reader, post.id, at(5))).canAccept).toBe(false)
      const changed = await setAcceptedAnswer(tx, w.asker, post.id, { commentId: b.id }, at(6))
      expect(changed.comments.filter((c) => c.accepted).map((c) => c.id)).toEqual([b.id])
      const cleared = await setAcceptedAnswer(tx, w.asker, post.id, null, at(7))
      expect(cleared.acceptedCommentId).toBeNull()
      // 질문 게시판이 아니면 채택 없음
      const free = await createPost(tx, w.asker, w.freeBoard, { title: '자유', body: '본문' }, at(8))
      const fc = (await createComment(tx, w.answerer, free.id, { body: '댓글' }, at(9))).comments[0]!
      await expectServiceError(setAcceptedAnswer(tx, w.asker, free.id, { commentId: fc.id }, at(10)), 'CONFLICT', 'not_question_board')
      // version은 오르지 않음(내용 변경이 아님)
      expect(cleared.version).toBe(post.version)
    })
  }, DB_TIMEOUT)

  it('course Q&A: no copy before consent, answerer stays anonymous to the asker, consent copies with chosen names, public DTO has copies only', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const w = await world(tx)
      const q = await question(tx, w)
      await updateRealName(tx, w.answerer, { realName: '답변실명' })

      const options = await getArchiveOptions(tx, w.asker, q.postId, at(4))
      expect(options.targets).toEqual({ course_qa: null, stuck_log: null, senior_note: null })
      expect(options.school?.id).toBe(w.schoolId)
      expectNoAnswererIdentity(options, w)
      await expectServiceError(getArchiveOptions(tx, w.answerer, q.postId, at(4)), 'FORBIDDEN', 'not_author')
      await expectServiceError(createArchiveTransfer(tx, w.answerer, q.postId, qaInput(w), at(4)), 'FORBIDDEN', 'not_author')

      const created = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(5))
      expect(created).toMatchObject({ status: 'awaiting_consent', myRole: 'initiator', counterpart: { status: 'pending', text: '답변자 동의 대기 중' } })
      expectNoAnswererIdentity(created, w)
      // 동의 전에는 아카이브에 아무것도 없음
      expect(await tx.select().from(courseQaItems).where(eq(courseQaItems.transferId, created.id))).toEqual([])
      expect((await getPublicCourseHub(tx, w.courseId, at(5))).qaItems).toEqual([])
      await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(5)), 'CONFLICT', 'transfer_pending')

      // 답한 사람은 커뮤니티 알림으로 요청을 받음(누가 요청했는지·글 제목 없음)
      const notices = await listMyCommunityNotices(tx, w.answerer)
      const req = notices.items.find((n) => n.kind === 'archive_consent_requested')!
      expect(req).toMatchObject({ transferId: created.id, target: 'course_qa' })
      expect(JSON.stringify(req)).not.toContain(w.asker.userId)
      // 요청한 사람의 글 화면: 상태만(답한 사람 식별자 없음)
      const askerPost = await getPost(tx, w.asker, q.postId, at(5))
      expect(askerPost.archive.transfers).toEqual([expect.objectContaining({ id: created.id, myRole: 'initiator', status: 'awaiting_consent' })])
      expectNoAnswererIdentity(askerPost.archive, w)
      // 다른 사람은 요청을 볼 수 없음
      await expectServiceError(getArchiveTransfer(tx, w.reader, created.id, at(5)), 'NOT_FOUND')
      expect((await getPost(tx, w.reader, q.postId, at(5))).archive.transfers).toEqual([])

      const view = await getArchiveTransfer(tx, w.answerer, created.id, at(6))
      expect(view).toMatchObject({ myRole: 'party', canDecide: true, preview: { askerLabel: '질문한 학생' }, project: null })
      expect(view.displayOptions).toMatchObject({ anonymousLabel: '답한 학생', displayName: w.answerer.name, realName: '답변실명' })
      expect(JSON.stringify(view)).not.toContain(w.answerer.accountName)
      // 동의는 해시가 맞아야 함
      await expectServiceError(decideArchiveConsent(tx, w.answerer, created.id, { decision: 'grant', contentHash: 'f'.repeat(64), displayMode: 'display' }, at(6)), 'CONFLICT', 'stale_content')
      await expectServiceError(decideArchiveConsent(tx, w.answerer, created.id, { decision: 'grant', displayMode: 'display' }, at(6)), 'VALIDATION')
      const done = await decideArchiveConsent(tx, w.answerer, created.id, { decision: 'grant', contentHash: view.contentHash, displayMode: 'real' }, at(7))
      expect(done.status).toBe('done')
      expect(done.result.courseQa).toMatchObject({ role: 'answerer', myLabel: '답변실명', status: 'published' })

      const [item] = await tx.select().from(courseQaItems).where(eq(courseQaItems.transferId, created.id))
      expect(item).toMatchObject({ askerLabel: '질문한 학생', askerAnonymous: true, answererLabel: '답변실명', answererAnonymous: false, status: 'published' })
      // 스냅샷은 끝나면 지움(해시만 남김)
      const [row] = await tx.select().from(archiveTransfers).where(eq(archiveTransfers.id, created.id))
      expect(row!.snapshot).toBeNull()

      const hub = await getPublicCourseHub(tx, w.courseId, at(8))
      expect(hub.qaItems).toHaveLength(1)
      expect(hub.qaItems[0]).toMatchObject({ asker: '질문한 학생', answerer: '답변실명', answerBody: 'waitpid로 회수하는지 먼저 확인해 보세요.' })
      expect(Object.keys(hub.qaItems[0]!).sort()).toEqual(['answerBody', 'answerer', 'answererAnonymous', 'asker', 'askerAnonymous', 'id', 'publishedAt', 'questionBody', 'questionTitle', 'signals'])
      const hubText = JSON.stringify(hub)
      for (const v of [w.asker.userId, w.answerer.userId, created.id, q.postId, q.commentId, w.slug]) expect(hubText).not.toContain(v)

      // 원 글: 읽을 수 있는 사람에게 "아카이브로 옮겨짐"만(링크·동의한 사람 없음)
      const marked = await getPost(tx, w.reader, q.postId, at(8))
      expect(marked.archive.archived).toBe(true)
      expect(JSON.stringify(marked.archive)).not.toContain(item!.id)
      // 요청한 사람에게 완료 후에도 답한 사람 식별자 없음(공개 이름만은 허브에서 보임)
      expectNoAnswererIdentity(await getArchiveTransfer(tx, w.asker, created.id, at(8)), w)
      // 같은 글은 공개 중인 Q&A가 있으면 다시 옮기지 않음
      await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(9)), 'CONFLICT', 'already_transferred')

      // 분석: 옮길 곳 종류만, 사용자 키 없이
      const events = await tx.select().from(analyticsEvents).where(sql`${analyticsEvents.name} in ('archive_transfer_requested', 'archive_transfer_completed', 'course_qa_published')`)
      expect(events.map((e) => e.name).sort()).toEqual(['archive_transfer_completed', 'archive_transfer_requested', 'course_qa_published'])
      const linked = new Set([w.asker.userId, w.answerer.userId].map((id) => hashSubject(PEPPER.PEERCHIVE_ANALYTICS_PEPPER, id)))
      for (const e of events) {
        // C-10(ADR 0027): 사용자 키 없음 = actor_hash null
        expect(e.actorHash).toBeNull()
        expect(linked.has(e.actorHash ?? '')).toBe(false)
        expect(e.projectHash).toBeNull()
      }
    })
  }, DB_TIMEOUT)

  it('freezes the copied text at request time: later edits are not copied; the answerer consents to exactly what they saw', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const q = await question(tx, w, '처음 질문 본문', '처음 답변 본문')
      const created = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(5))
      const post = await getPost(tx, w.asker, q.postId, at(5))
      await editPost(tx, w.asker, q.postId, { body: '나중에 고친 질문', expectedVersion: post.version }, at(6))
      await editComment(tx, w.answerer, q.commentId, { body: '나중에 고친 답변', expectedVersion: 1 }, at(6))
      const view = await getArchiveTransfer(tx, w.answerer, created.id, at(7))
      expect(view.preview).toMatchObject({ questionBody: '처음 질문 본문', answerBody: '처음 답변 본문' })
      await decideArchiveConsent(tx, w.answerer, created.id, { decision: 'grant', contentHash: view.contentHash, displayMode: 'anonymous' }, at(8))
      const [item] = await tx.select().from(courseQaItems).where(eq(courseQaItems.transferId, created.id))
      expect(item).toMatchObject({ questionBody: '처음 질문 본문', answerBody: '처음 답변 본문', answererLabel: '답한 학생' })
    })
  }, DB_TIMEOUT)

  it('decline, initiator cancel and 14-day expiry close requests without copying; changing the accepted answer cancels', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const q = await question(tx, w)
      const t1 = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(5))
      const declined = await decideArchiveConsent(tx, w.answerer, t1.id, { decision: 'decline' }, at(6))
      expect(declined).toMatchObject({ status: 'cancelled', cancelReason: 'declined', preview: null, contentHash: null })
      expect(await getArchiveTransfer(tx, w.asker, t1.id, at(6))).toMatchObject({ status: 'cancelled', counterpart: { status: 'declined', text: '답변자 거절함' } })
      expect((await listMyCommunityNotices(tx, w.asker)).items.some((n) => n.kind === 'archive_transfer_cancelled')).toBe(true)

      const t2 = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(7))
      await expectServiceError(cancelArchiveTransfer(tx, w.answerer, t2.id, at(8)), 'NOT_FOUND')
      expect(await cancelArchiveTransfer(tx, w.asker, t2.id, at(8))).toMatchObject({ status: 'cancelled', cancelReason: 'cancelled_by_initiator' })
      await expectServiceError(cancelArchiveTransfer(tx, w.asker, t2.id, at(9)), 'CONFLICT', 'not_pending')

      const t3 = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(10))
      const later = new Date(at(10).getTime() + days(14) + 1000)
      const view = await getArchiveTransfer(tx, w.answerer, t3.id, later)
      expect(view).toMatchObject({ status: 'cancelled', cancelReason: 'expired', canDecide: false })
      await expectServiceError(decideArchiveConsent(tx, w.answerer, t3.id, { decision: 'grant', contentHash: 'a'.repeat(64), displayMode: 'anonymous' }, later), 'CONFLICT', 'not_pending')

      const t4 = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), later)
      const other = (await createComment(tx, w.reader, q.postId, { body: '다른 답' }, later)).comments.find((c) => c.body === '다른 답')!
      await setAcceptedAnswer(tx, w.asker, q.postId, { commentId: other.id }, later)
      expect(await getArchiveTransfer(tx, w.asker, t4.id, later)).toMatchObject({ status: 'cancelled', cancelReason: 'answer_changed' })
      expect(await tx.select().from(courseQaItems).where(sql`${courseQaItems.transferId} in (${t1.id}, ${t2.id}, ${t3.id}, ${t4.id})`)).toEqual([])
      // 닫힌 요청의 스냅샷 글은 남지 않음
      const rows = await tx.select({ snapshot: archiveTransfers.snapshot }).from(archiveTransfers).where(eq(archiveTransfers.sourcePostId, q.postId))
      expect(rows.every((r) => r.snapshot === null)).toBe(true)
    })
  }, DB_TIMEOUT)

  it('course Q&A needs a course of the space school and hub-write eligibility (school affiliation) for the initiator', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const q = await question(tx, w)
      await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, { target: 'course_qa', displayMode: 'anonymous' }, at(5)), 'VALIDATION')
      const other = await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, qaInput(w, { courseId: w.otherCourseId }), at(5)), 'VALIDATION')
      expect(other.fields).toEqual({ courseId: 'other_school' })
      const real = await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, qaInput(w, { displayMode: 'real' }), at(5)), 'VALIDATION')
      expect(real.fields).toEqual({ displayMode: 'real_name_required' })
      // 표시명 = 표시명 페르소나(ADR 0030): 페르소나가 비활성이면 표시명을 고를 수 없고(422), 선택지에도 계정 이름이 나오지 않음
      await tx.update(personas).set({ status: 'deactivated' }).where(and(eq(personas.userId, w.asker.userId), eq(personas.kind, 'display')))
      const noPersona = await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, qaInput(w, { displayMode: 'display' }), at(5)), 'VALIDATION')
      expect(noPersona.fields).toEqual({ displayMode: 'display_persona_required' })
      const options = await getArchiveOptions(tx, w.asker, q.postId, at(5))
      expect(options.displayName).toBeNull()
      expect(JSON.stringify(options)).not.toContain(w.asker.accountName)
      await tx.update(personas).set({ status: 'active' }).where(and(eq(personas.userId, w.asker.userId), eq(personas.kind, 'display')))
      expect((await getArchiveOptions(tx, w.asker, q.postId, at(5))).displayName).toBe(w.asker.name)

      // 학교 연결 없는 방: 과목 학교 제한은 없지만 요청한 사람은 그 과목 학교 인증이 있어야 함
      const room = await createRoom(tx, w.asker, { name: `질문방 ${rand()}`, nameMode: 'display', joinPolicy: 'open' }, T0)
      const { createBoard } = await import('../server/modules/community/spaces')
      const qb = await createBoard(tx, w.asker, room.slug, { kind: 'question', title: '질문' }, T0)
      const { joinSpace } = await import('../server/modules/community/memberships')
      await joinSpace(tx, w.answerer, room.slug, at(1))
      const post = await createPost(tx, w.asker, qb.id, { title: '방 질문', body: '방 본문' }, at(2))
      const c = (await createComment(tx, w.answerer, post.id, { body: '방 답' }, at(3))).comments[0]!
      await setAcceptedAnswer(tx, w.asker, post.id, { commentId: c.id }, at(4))
      const denied = await expectServiceError(createArchiveTransfer(tx, w.asker, post.id, qaInput(w, { courseId: w.otherCourseId }), at(5)), 'FORBIDDEN', 'hub_write_not_allowed')
      expect(denied.details).toMatchObject({ requirement: 'school_affiliation', schoolId: w.otherSchoolId })
      expect((await createArchiveTransfer(tx, w.asker, post.id, qaInput(w), at(6))).status).toBe('awaiting_consent')
    })
  }, DB_TIMEOUT)

  it('either party withdraws immediately; search shows the Q&A only while published even with stale documents; signals count only', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const q = await question(tx, w, '세마포어 데드락 질문입니다', '락 순서를 고정해 보세요')
      const created = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(5))
      const view = await getArchiveTransfer(tx, w.answerer, created.id, at(6))
      await decideArchiveConsent(tx, w.answerer, created.id, { decision: 'grant', contentHash: view.contentHash, displayMode: 'anonymous' }, at(7))
      const [item] = await tx.select().from(courseQaItems).where(eq(courseQaItems.transferId, created.id))
      // worker 색인
      expect(await handleCourseQaPublished(tx, { courseQaItemId: item!.id, courseId: item!.courseId })).toBe(1)
      const found = await searchPublic(tx, { q: '데드락' }, at(8))
      expect(found.results).toEqual([expect.objectContaining({ kind: 'qa', path: `/c/${w.courseId}#qa-${item!.id}` })])
      expect((await searchPublic(tx, { q: '데드락', type: 'qa', course: w.courseId }, at(8))).results).toHaveLength(1)
      expect(await putSignal(tx, w.reader, { target: { kind: 'course_qa', qaId: item!.id }, kind: 'me_too' }, at(8))).toMatchObject({ signals: { meToo: 1, helped: 0 } })

      // 상대가 아닌 사람은 철회 못 함(404), 답한 사람이 철회하면 즉시
      await expectServiceError(withdrawCourseQa(tx, w.reader, item!.id, at(9)), 'NOT_FOUND')
      expect(await withdrawCourseQa(tx, w.answerer, item!.id, at(9))).toMatchObject({ status: 'withdrawn', role: 'answerer' })
      expect((await getPublicCourseHub(tx, w.courseId, at(9))).qaItems).toEqual([])
      // 정리 handler가 아직 돌지 않아 문서가 남아 있어도 검색되지 않음
      expect(await tx.select().from(searchDocuments).where(eq(searchDocuments.courseQaItemId, item!.id))).toHaveLength(1)
      expect((await searchPublic(tx, { q: '데드락' }, at(9))).results).toEqual([])
      await expectServiceError(putSignal(tx, w.reader, { target: { kind: 'course_qa', qaId: item!.id }, kind: 'helped' }, at(9)), 'NOT_FOUND')
      expect((await getPost(tx, w.reader, q.postId, at(9))).archive.archived).toBe(false)
      // 철회 이벤트 → worker 정리
      const [evt] = await tx.select().from(outboxEvents).where(sql`${outboxEvents.topic} = 'course_qa.withdrawn' and ${outboxEvents.payload}->>'courseQaItemId' = ${item!.id}`)
      expect(evt).toBeTruthy()
      expect(await handleCourseQaWithdrawn(tx, evt!.payload)).toBe(2)
      // 질문한 사람의 목록에도 철회됨(상대 정보 없음), 다시 철회해도 200
      const mine = await listMyCourseQa(tx, w.asker)
      expect(mine).toEqual([expect.objectContaining({ id: item!.id, role: 'asker', status: 'withdrawn' })])
      expectNoAnswererIdentity(mine, w)
      expect((await withdrawCourseQa(tx, w.asker, item!.id, at(10))).status).toBe('withdrawn')
      // 공개 중인 복사본이 없으면 다시 옮길 수 있음
      expect((await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(11))).status).toBe('awaiting_consent')
    })
  }, DB_TIMEOUT)

  it('stuck_log copies into the asker’s own project only (answer only with the answerer’s consent)', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const q = await question(tx, w, '빌드가 실패합니다', 'Makefile 탭을 확인하세요')
      const mineProject = await createProject(tx, w.asker, { title: '내 과제' }, T0)
      const theirs = await createProject(tx, w.reader, { title: '남의 과제' }, T0)
      const bad = await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, { target: 'stuck_log', projectId: theirs.id, timeBucket: 'lt2h' }, at(5)), 'VALIDATION')
      expect(bad.fields).toEqual({ projectId: 'not_found' })
      await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, { target: 'stuck_log', projectId: mineProject.id }, at(5)), 'VALIDATION')

      // 답변 없이: 내 글만이라 바로 끝남
      const solo = await createArchiveTransfer(tx, w.asker, q.postId, { target: 'stuck_log', projectId: mineProject.id, timeBucket: 'lt2h' }, at(5))
      expect(solo).toMatchObject({ status: 'done', result: { projectId: mineProject.id }, project: { id: mineProject.id } })
      const [stuckRow] = await tx.select().from(archiveTransfers).where(eq(archiveTransfers.id, solo.id))
      const [stuck] = await tx.select().from(logRevisions).where(eq(logRevisions.logEntryId, stuckRow!.stuckLogId!))
      expect(stuck).toMatchObject({ tag: 'stuck', body: '빌드가 실패합니다' })
      expect((stuck!.payload as { symptom: string }).symptom).toMatch(/^fork 질문/)

      // 답변 포함: 답한 사람의 동의가 있어야 해결 로그가 생김
      await expectServiceError(
        createArchiveTransfer(tx, w.asker, q.postId, { target: 'stuck_log', projectId: mineProject.id, timeBucket: 'lt2h', includeAnswer: true }, at(6)),
        'VALIDATION',
      )
      const withAnswer = await createArchiveTransfer(
        tx,
        w.asker,
        q.postId,
        { target: 'stuck_log', projectId: mineProject.id, timeBucket: 'half_day', includeAnswer: true, notAnswerConfirmed: true },
        at(6),
      )
      expect(withAnswer.status).toBe('awaiting_consent')
      const before = await tx.select().from(logEntries).where(eq(logEntries.projectId, mineProject.id))
      const party = await getArchiveTransfer(tx, w.answerer, withAnswer.id, at(7))
      // 답한 사람에게 질문한 사람의 과제 이름은 보이지 않음
      expect(party.project).toBeNull()
      expect(JSON.stringify(party)).not.toContain('내 과제')
      await decideArchiveConsent(tx, w.answerer, withAnswer.id, { decision: 'grant', contentHash: party.contentHash }, at(8))
      const after = await tx.select().from(logEntries).where(eq(logEntries.projectId, mineProject.id))
      expect(after.length - before.length).toBe(2)
      const [done] = await tx.select().from(archiveTransfers).where(eq(archiveTransfers.id, withAnswer.id))
      const [solution] = await tx.select().from(logRevisions).where(eq(logRevisions.logEntryId, done!.solutionLogId!))
      expect(solution).toMatchObject({ tag: 'solution', resolvesEntryId: done!.stuckLogId })
      expect((solution!.payload as { method: string }).method).toBe('Makefile 탭을 확인하세요')
      // 로그 작성자는 질문한 사람(답한 사람은 과제 멤버가 아님)
      expect(new Set(after.map((l) => l.authorId))).toEqual(new Set([w.asker.userId]))
    })
  }, DB_TIMEOUT)

  it('senior_note: own post → draft (re-chosen display), then the normal publish flow with checks', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const advice = await createPost(tx, w.asker, w.freeBoard, { title: '운영체제 조언', body: '첫 주에 과제 명세를 끝까지 읽으세요.' }, at(1))
      await expectServiceError(
        createArchiveTransfer(tx, w.answerer, advice.id, { target: 'senior_note', courseId: w.courseId, answerKey: 'firstWeek', displayMode: 'anonymous', noAnswersConfirmed: true }, at(2)),
        'FORBIDDEN',
        'not_author',
      )
      await expectServiceError(
        createArchiveTransfer(tx, w.asker, advice.id, { target: 'senior_note', courseId: w.courseId, answerKey: 'firstWeek', displayMode: 'anonymous' }, at(2)),
        'VALIDATION',
      )
      const t = await createArchiveTransfer(
        tx,
        w.asker,
        advice.id,
        { target: 'senior_note', courseId: w.courseId, answerKey: 'firstWeek', displayMode: 'display', displayName: '조언하는 선배', noAnswersConfirmed: true },
        at(2),
      )
      expect(t).toMatchObject({ status: 'done', target: 'senior_note' })
      const noteId = t.result.seniorNoteId!
      // 답 하나뿐인 초안은 게시 전에 막힘(답 2개 이상)
      const tooFew = await expectServiceError(publishSeniorNote(tx, w.asker, noteId, { expectedVersion: 1 }, at(3)), 'VALIDATION')
      expect(tooFew.fields).toEqual({ answers: 'too_few' })
      const updated = await updateSeniorNote(tx, w.asker, noteId, { expectedVersion: 1, answers: { firstWeek: '첫 주에 과제 명세를 끝까지 읽으세요.', wishKnew: '페이지 테이블' } }, at(4))
      const published = await publishSeniorNote(tx, w.asker, noteId, { expectedVersion: updated.version }, at(5))
      expect(published).toMatchObject({ status: 'published', publicLabel: '조언하는 선배' })
      expect((await getPublicCourseHub(tx, w.courseId, at(6))).seniorNotes.map((n) => n.id)).toContain(noteId)
      expect((await getPost(tx, w.reader, advice.id, at(6))).archive.archived).toBe(true)
    })
  }, DB_TIMEOUT)

  it('moderation: hidden or deleted sources block and cancel transfers; course Q&A can be reported, hidden and restored', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const q = await question(tx, w)
      const pending = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(5))
      // 답변이 운영 조치로 가려지면 진행 중 요청 취소
      await hideCommunityItemInTx(tx, 'comment', q.commentId, at(6))
      expect(await getArchiveTransfer(tx, w.asker, pending.id, at(6))).toMatchObject({ status: 'cancelled', cancelReason: 'source_unavailable' })
      await expectServiceError(createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(7)), 'CONFLICT', 'no_accepted_answer')

      // 원 글이 가려지면 시작 불가
      const q2 = await question(tx, w)
      await hideCommunityItemInTx(tx, 'post', q2.postId, at(8))
      await expectServiceError(createArchiveTransfer(tx, w.asker, q2.postId, qaInput(w), at(8)), 'CONFLICT', 'source_not_open')

      // 답한 사람이 답을 지우면 취소
      const q3 = await question(tx, w)
      const t3 = await createArchiveTransfer(tx, w.asker, q3.postId, qaInput(w), at(9))
      await deleteComment(tx, w.answerer, q3.commentId, at(10))
      expect(await getArchiveTransfer(tx, w.asker, t3.id, at(10))).toMatchObject({ status: 'cancelled', cancelReason: 'source_unavailable' })

      // 게시된 막힘 Q&A 신고 → 숨기기 → 이의제기 되돌림
      const q4 = await question(tx, w)
      const t4 = await createArchiveTransfer(tx, w.asker, q4.postId, qaInput(w), at(11))
      const view = await getArchiveTransfer(tx, w.answerer, t4.id, at(11))
      await decideArchiveConsent(tx, w.answerer, t4.id, { decision: 'grant', contentHash: view.contentHash, displayMode: 'anonymous' }, at(12))
      const [item] = await tx.select().from(courseQaItems).where(eq(courseQaItems.transferId, t4.id))
      const receipt = await createReport(tx, w.reader, { targetType: 'course_qa', targetRef: { qaId: item!.id }, reason: 'answer_sharing' }, at(13))
      const resolved = await resolveReport(tx, w.op, receipt.id, { action: 'hide_qa', note: '정답 공유', publicReason: '과제 정답에 가까움', notifyOwner: true }, at(14))
      expect(resolved.content).toMatchObject({ kind: 'course_qa', status: 'hidden' })
      expect(JSON.stringify(resolved.content)).not.toContain(w.answerer.userId)
      expect((await getPublicCourseHub(tx, w.courseId, at(14))).qaItems.map((i) => i.id)).not.toContain(item!.id)
      await expectServiceError(createReport(tx, w.reader, { targetType: 'course_qa', targetRef: { qaId: item!.id }, reason: 'spam' }, at(15)), 'NOT_FOUND')
      // 두 당사자 모두 운영 조치 안내를 받음
      const askerNotices = await listMyModerationNotices(tx, w.asker)
      const answererNotices = await listMyModerationNotices(tx, w.answerer)
      expect(askerNotices.map((n) => n.kind)).toContain('hide_qa')
      expect(answererNotices.map((n) => n.kind)).toContain('hide_qa')
      const appeal = await createAppeal(tx, w.answerer, { actionId: askerNotices.find((n) => n.kind === 'hide_qa')!.actionId, message: '원리 설명입니다' }, at(16))
      await decideAppeal(tx, w.op, appeal.id, { decision: 'reverse', note: '원리 설명 확인' }, at(17))
      expect((await getPublicCourseHub(tx, w.courseId, at(17))).qaItems.map((i) => i.id)).toContain(item!.id)
    })
  }, DB_TIMEOUT)

  it('account purge cancels pending transfers and withdraws course Q&A where the user was a party', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'peerchive-c09-purge-'))
    try {
      await withRollback(async (tx) => {
        const w = await world(tx)
        const q = await question(tx, w, '퍼지 질문 본문', '퍼지 답변 본문')
        const t = await createArchiveTransfer(tx, w.asker, q.postId, qaInput(w), at(5))
        const view = await getArchiveTransfer(tx, w.answerer, t.id, at(6))
        await decideArchiveConsent(tx, w.answerer, t.id, { decision: 'grant', contentHash: view.contentHash, displayMode: 'display' }, at(7))
        const [item] = await tx.select().from(courseQaItems).where(eq(courseQaItems.transferId, t.id))
        await handleCourseQaPublished(tx, { courseQaItemId: item!.id, courseId: item!.courseId })
        const q2 = await question(tx, w)
        const pending = await createArchiveTransfer(tx, w.asker, q2.postId, qaInput(w), at(8))

        await tx.update(users).set({ status: 'deleted' }).where(eq(users.id, w.answerer.userId))
        const counts = await purgeAccount(
          tx,
          { storage: createFilesystemStorage(root), deletionPepper: 'c09-deletion-pepper-for-tests-0123456789abcdef', analyticsPepper: null },
          w.answerer.userId,
          { now: at(9), source: 'purge' },
        )
        expect(counts).toMatchObject({ archive_transfers_cancelled: 1, course_qa_items: 1, archive_transfer_consent_labels: 1 })
        const [after] = await tx.select().from(courseQaItems).where(eq(courseQaItems.id, item!.id))
        expect(after).toMatchObject({ status: 'withdrawn', withdrawnBy: 'account_deleted', questionBody: '', answerBody: '', answererId: null, answererLabel: '탈퇴한 사용자' })
        expect(after!.askerId).toBe(w.asker.userId)
        expect(await tx.select().from(searchDocuments).where(eq(searchDocuments.courseQaItemId, item!.id))).toEqual([])
        expect((await getPublicCourseHub(tx, w.courseId, at(10))).qaItems).toEqual([])
        expect(await getArchiveTransfer(tx, w.asker, pending.id, at(10))).toMatchObject({ status: 'cancelled', cancelReason: 'account_deleted' })
        const labels = await tx.select({ label: archiveTransferConsents.displayLabel }).from(archiveTransferConsents).where(eq(archiveTransferConsents.userId, w.answerer.userId))
        expect(labels.every((l) => l.label === null)).toBe(true)

        // 요청한 사람이 탈퇴하면 그 사람의 옮기기 기록은 지워짐(복사본은 transfer_id만 남김)
        await tx.update(users).set({ status: 'deleted' }).where(eq(users.id, w.asker.userId))
        const askerCounts = await purgeAccount(
          tx,
          { storage: createFilesystemStorage(root), deletionPepper: 'c09-deletion-pepper-for-tests-0123456789abcdef', analyticsPepper: null },
          w.asker.userId,
          { now: at(11), source: 'purge' },
        )
        expect(askerCounts?.archive_transfers).toBeGreaterThanOrEqual(2)
        expect(await tx.select().from(archiveTransfers).where(eq(archiveTransfers.initiatorId, w.asker.userId))).toEqual([])
        const [kept] = await tx.select().from(courseQaItems).where(eq(courseQaItems.id, item!.id))
        expect(kept).toMatchObject({ askerId: null, askerLabel: '탈퇴한 사용자', transferId: t.id })
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, DB_TIMEOUT)

  it('boundary: course_qa_items and other archive tables have no foreign key to community tables; untransferred community text is copied nowhere', async () => {
    await withRollback(async (tx) => {
      setAnalyticsEnvForTesting(PEPPER)
      const fks = (await tx.execute(sql`
        select tc.table_name as from_table, ccu.table_name as to_table
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
        where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`)) as unknown as Array<{ from_table: string; to_table: string }>
      expect(COMMUNITY_TABLE_SQL.has('archive_transfers')).toBe(true)
      expect(COMMUNITY_TABLE_SQL.has('course_qa_items')).toBe(false)
      for (const archiveTable of ['course_qa_items', 'search_documents', 'usefulness_signals', 'senior_notes', 'log_entries', 'log_revisions']) {
        const toCommunity = fks.filter((f) => f.from_table === archiveTable && COMMUNITY_TABLE_SQL.has(f.to_table))
        expect(toCommunity, archiveTable).toEqual([])
      }
      // 방향은 커뮤니티 → 아카이브: archive_transfers가 course_qa_items를 가리킴
      expect(fks).toEqual(expect.arrayContaining([{ from_table: 'archive_transfers', to_table: 'course_qa_items' }]))

      const w = await world(tx)
      const SENTINEL = `옮기지않음${rand()}`
      const MOVED = `옮겨짐${rand()}`
      // 옮기지 않은 질문(채택된 답변까지 있음)과 거절된 요청, 옮긴 질문
      const untouched = await question(tx, w, `${SENTINEL} 질문`, `${SENTINEL} 답변`)
      const declined = await question(tx, w, `${SENTINEL} 거절 질문`, `${SENTINEL} 거절 답변`)
      const td = await createArchiveTransfer(tx, w.asker, declined.postId, qaInput(w), at(5))
      await decideArchiveConsent(tx, w.answerer, td.id, { decision: 'decline' }, at(6))
      const moved = await question(tx, w, `${MOVED} 질문`, `${MOVED} 답변`)
      const tm = await createArchiveTransfer(tx, w.asker, moved.postId, qaInput(w), at(7))
      const view = await getArchiveTransfer(tx, w.answerer, tm.id, at(7))
      await decideArchiveConsent(tx, w.answerer, tm.id, { decision: 'grant', contentHash: view.contentHash, displayMode: 'anonymous' }, at(8))
      const [item] = await tx.select().from(courseQaItems).where(eq(courseQaItems.transferId, tm.id))
      await handleCourseQaPublished(tx, { courseQaItemId: item!.id, courseId: item!.courseId })
      expect(untouched.postId).toBeTruthy()

      const tables = (await tx.execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)) as unknown as Array<{
        table_name: string
      }>
      const nonCommunity = tables.map((t) => t.table_name).filter((t) => !COMMUNITY_TABLE_SQL.has(t))
      const leaks: string[] = []
      const movedIn: string[] = []
      for (const t of nonCommunity) {
        const [row] = (await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)} x where x::text like ${`%${SENTINEL}%`}`)) as unknown as Array<{ n: number }>
        if (row!.n > 0) leaks.push(`${t}: ${row!.n}`)
        const [m] = (await tx.execute(sql`select count(*)::int as n from ${sql.identifier(t)} x where x::text like ${`%${MOVED}%`}`)) as unknown as Array<{ n: number }>
        if (m!.n > 0) movedIn.push(t)
      }
      expect(leaks).toEqual([])
      // 옮긴 글은 동의를 받은 복사본(과 그 파생 검색 문서)에만
      expect(movedIn.sort()).toEqual(['course_qa_items', 'search_documents'])
      for (const type of [undefined, 'qa']) expect((await searchPublic(tx, { q: SENTINEL, ...(type && { type }) }, at(9))).results).toEqual([])
      expect(JSON.stringify(await getPublicCourseHub(tx, w.courseId, at(9)))).not.toContain(SENTINEL)
    })
  }, DB_TIMEOUT)
})
