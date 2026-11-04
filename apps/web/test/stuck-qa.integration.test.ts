/**
 * E-04 막힘 Q&A 스레드 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 DB 테스트는 건너뜁니다.
 * - 플래그(`PEERCHIVE_FEATURE_STUCK_QA`)가 꺼져 있으면 모든 경로·신고가 404, 포트폴리오 개수 0.
 * - 질문 허용: 막힘 로그 작성자만 켜고 끔, 꺼져 있으면 질문·답변 409, 과목 연결이 없으면 켤 수 없음, 쓰기는 과목 학교 인증(C-01)만.
 * - 공개 철회·엠바고면 카드·스레드·글·도움됐어요·신고가 모두 404(행은 남음).
 * - 익명 번호: 같은 스레드 같은 사람 같은 번호, 스레드마다 따로, 로그 작성자는 항상 `작성자`. 공개 DTO에 사람 id·도움됐어요 개수가 없음.
 * - "도움됐어요"는 정렬에만(카드 안 스레드 순서·스레드 안 답변 순서), 자기 글·질문에는 못 누름.
 * - 후배 기여: 답변자가 답변마다 켬(기본 꺼짐), 지금 보이는 것만 개수로.
 * - 신고·숨김(질문을 숨기면 스레드 전체가 안 보임)·운영자 작성자 확인(신고에 묶임, 감사 id만)·큐레이터 1차 검토 범위.
 * - 경계(소스): 과목 허브 구역 테이블, 커뮤니티 모듈·테이블 없음.
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { and, auditEvents, eq, operators, stuckQaAliases, stuckQaPosts, type DbExecutor } from '@peerchive/db'
import { assignStuckQaAlias, rankStuckQaPosts, rankStuckQaThreads, stuckQaAuthorLabel } from '@peerchive/domain'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import {
  createStuckQaAnswer,
  createStuckQaThread,
  getStuckQaCard,
  getStuckQaThread,
  operatorStuckQaAuthor,
  setQuestionsAllowed,
  setStuckQaContribution,
  setStuckQaHelpful,
  withdrawStuckQaPost,
} from '../server/modules/course-hub/stuck-qa'
import { acceptCuratorProposal, grantCourseCurator, listMyCuratorProposals } from '../server/modules/curators/assignments'
import { listCuratorReports, recommendOnReport } from '../server/modules/curators/report-review'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { setFeatureEnvForTesting } from '../server/modules/features'
import { createLog } from '../server/modules/logs/logs'
import { getReportDetail, resolveReport } from '../server/modules/moderation/operator'
import { listMyModerationNotices } from '../server/modules/moderation/notices'
import { createReport } from '../server/modules/moderation/reports'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { getPublicPublication } from '../server/modules/publication/public-read'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { COMMUNITY_TABLE_SQL } from './community-tables'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const ON = { PEERCHIVE_FEATURE_STUCK_QA: 'on' }
const token = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)

/** 학교·과목(2025년 2학기, 끝난 학기) + 운영자. */
async function fixture(db: DbExecutor) {
  const t = token()
  const op = await createUser(db, { displayName: '운영자' })
  await db.insert(operators).values({ userId: op.id })
  const school = await createSchool(db, { userId: op.id }, { name: `막힘대${t}학교`, confirmNew: true }, T0)
  const course = await createCourse(db, { userId: op.id }, school.id, { title: `운영체제${t}`, code: `OS-${t}`, confirmNew: true }, T0)
  const { term } = await createCourseTerm(db, { userId: op.id }, course.id, { year: 2025, semester: 'fall' }, T0)
  return { O: { userId: op.id }, schoolId: school.id, course, term, t }
}

/** 막힘 로그 하나를 담아 게시한 개인 과제. termId가 null이면 과목 연결 없음. */
async function publishStuck(db: DbExecutor, owner: string, termId: string | null) {
  const actor = { userId: owner }
  const project = await createProject(db, actor, { title: '셸 과제', courseTermId: termId }, T0)
  const stuck = (
    await createLog(db, actor, project.id, { tag: 'stuck', payload: { symptom: '좀비 프로세스가 남음', keywords: ['fork'], timeBucket: 'half_day', answerCheck: true }, links: [] }, at(1))
  ).log
  const candidate = await createCandidate(
    db,
    actor,
    project.id,
    { level: 'summary', title: '셸 구현', summary: '요약', slug: `case-${token()}`, logIds: [stuck.id], milestoneIds: [], exposure: { [owner]: 'name' }, consentSelf: true },
    at(2),
    ORIGINS,
  )
  const { publication } = await publishCandidate(db, actor, candidate.id, { manifestHash: candidate.manifestHash }, at(3))
  const pub = await getPublicPublication(db, publication.slug, at(4))
  const key = pub.snapshot.logs.find((l) => l.tag === 'stuck')!.key
  return { project, publication, slug: publication.slug, key }
}

/** 그 학교 인증이 있는 사용자. */
async function verified(db: DbExecutor, schoolId: string, handle?: string) {
  const u = await createUser(db, { displayName: '인증 학생', handle })
  await verifiedAffiliation(db, u.id, schoolId)
  return u
}

describe('E-04 rules (domain)', () => {
  it('aliases: asker 0, others in first-post order, log author none; same person keeps the number', () => {
    expect(assignStuckQaAlias({ existing: [], userId: 'a', logAuthorId: 'o', opensThread: true })).toEqual({ kind: 'new', aliasNo: 0 })
    const existing = [{ userId: 'a', aliasNo: 0 }]
    expect(assignStuckQaAlias({ existing, userId: 'b', logAuthorId: 'o', opensThread: false })).toEqual({ kind: 'new', aliasNo: 1 })
    expect(assignStuckQaAlias({ existing: [...existing, { userId: 'b', aliasNo: 1 }], userId: 'b', logAuthorId: 'o', opensThread: false })).toEqual({ kind: 'existing', aliasNo: 1 })
    expect(assignStuckQaAlias({ existing, userId: 'o', logAuthorId: 'o', opensThread: false })).toEqual({ kind: 'log_author' })
    expect(stuckQaAuthorLabel({ byLogAuthor: true, aliasNo: null })).toEqual({ role: 'log_author', label: '작성자' })
    expect(stuckQaAuthorLabel({ byLogAuthor: false, aliasNo: 0 })).toEqual({ role: 'asker', label: '질문자' })
    expect(stuckQaAuthorLabel({ byLogAuthor: false, aliasNo: 3 })).toEqual({ role: 'anonymous', label: '익명3' })
  })

  it('orders threads and answers by helpful only (question first), then recency / age', () => {
    const threads = rankStuckQaThreads([
      { id: '1', helped: 0, lastPostAt: '2026-11-02T10:00:00Z' },
      { id: '2', helped: 2, lastPostAt: '2026-11-01T10:00:00Z' },
      { id: '3', helped: 0, lastPostAt: '2026-11-03T10:00:00Z' },
    ])
    expect(threads.map((t) => t.id)).toEqual(['2', '3', '1'])
    const posts = rankStuckQaPosts([
      { id: 'a', kind: 'answer' as const, helped: 0, createdAt: '1' },
      { id: 'q', kind: 'question' as const, helped: 0, createdAt: '0' },
      { id: 'b', kind: 'answer' as const, helped: 1, createdAt: '2' },
    ])
    expect(posts.map((p) => p.id)).toEqual(['q', 'b', 'a'])
  })
})

describe('E-04 boundary (source)', () => {
  const ROOT = resolve(__dirname, '../../..')
  it('stuck Q&A tables live outside the community section and the module never touches community code or tables', () => {
    for (const t of ['stuck_qa_cards', 'stuck_qa_threads', 'stuck_qa_aliases', 'stuck_qa_posts', 'stuck_qa_helpful']) expect(COMMUNITY_TABLE_SQL.has(t), t).toBe(false)
    const source = readFileSync(join(ROOT, 'apps/web/server/modules/course-hub/stuck-qa.ts'), 'utf8')
    expect(source).not.toMatch(/modules\/community|\.\.\/community\//)
    for (const t of COMMUNITY_TABLE_SQL) expect(source, t).not.toMatch(new RegExp(`\\b${t}\\b`))
    // 공개 DTO 타입에는 사람 id·도움됐어요 개수 필드가 없습니다.
    const api = readFileSync(join(ROOT, 'apps/web/shared/types/api.ts'), 'utf8')
    const block = (name: string) => api.slice(api.indexOf(`export interface ${name} {`), api.indexOf('\n}\n', api.indexOf(`export interface ${name} {`)))
    for (const name of ['StuckQaCardDto', 'StuckQaThreadSummaryDto', 'StuckQaThreadDto', 'StuckQaPostDto', 'StuckQaViewerDto']) {
      expect(block(name), name).not.toMatch(/userId|authorId|askerId|helped:|helpedCount|score/)
    }
  })
})

describe.skipIf(!databaseUrl)('E-04 stuck Q&A threads (PostgreSQL)', () => {
  afterAll(closeTestDb)
  beforeEach(() => setFeatureEnvForTesting(ON))
  afterEach(() => setFeatureEnvForTesting(null))

  it('flag off: every route and report is 404 and the portfolio count is 0', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await verified(tx, f.schoolId, `sqo${f.t}`)
      const c = await publishStuck(tx, owner.id, f.term.id)
      const A = await verified(tx, f.schoolId)
      await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(5))
      const thread = await createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '왜 좀비가 남나요?' }, at(6))
      const answer = await createStuckQaAnswer(tx, { userId: owner.id }, thread.id, { body: 'waitpid를 보세요', countAsContribution: true }, at(7))
      const answerId = answer.posts.find((p) => p.kind === 'answer')!.id
      expect((await getPublicPortfolioProfile(tx, `sqo${f.t}`, at(8))).juniorContribution.stuckQaAnswers).toBe(1)

      setFeatureEnvForTesting({})
      await expectServiceError(getStuckQaCard(tx, null, c.slug, c.key, at(8)), 'NOT_FOUND')
      await expectServiceError(setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: false }, at(8)), 'NOT_FOUND')
      await expectServiceError(createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '또 질문' }, at(8)), 'NOT_FOUND')
      await expectServiceError(getStuckQaThread(tx, null, thread.id, at(8)), 'NOT_FOUND')
      await expectServiceError(createStuckQaAnswer(tx, { userId: A.id }, thread.id, { body: '답' }, at(8)), 'NOT_FOUND')
      await expectServiceError(setStuckQaHelpful(tx, { userId: A.id }, answerId, true, at(8)), 'NOT_FOUND')
      await expectServiceError(setStuckQaContribution(tx, { userId: owner.id }, answerId, { countAsContribution: false }, at(8)), 'NOT_FOUND')
      await expectServiceError(withdrawStuckQaPost(tx, { userId: owner.id }, answerId, at(8)), 'NOT_FOUND')
      await expectServiceError(createReport(tx, { userId: A.id }, { targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: answerId }, reason: 'spam' }, at(8)), 'NOT_FOUND')
      expect((await getPublicPortfolioProfile(tx, `sqo${f.t}`, at(8))).juniorContribution.stuckQaAnswers).toBe(0)
    })
  })

  it('opt-in gate: only the log author toggles (audited, flag only); closed card refuses questions and answers; writers need school verification', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await verified(tx, f.schoolId)
      const c = await publishStuck(tx, owner.id, f.term.id)
      const A = await verified(tx, f.schoolId)
      const stranger = await createUser(tx)

      const before = await getStuckQaCard(tx, { userId: A.id }, c.slug, c.key, at(5))
      expect(before).toMatchObject({ questionsAllowed: false, threads: [], viewer: { isLogAuthor: false, canWrite: false } })
      expect((await getStuckQaCard(tx, null, c.slug, c.key, at(5))).viewer).toBeNull()
      await expectServiceError(createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '질문' }, at(5)), 'CONFLICT', 'questions_closed')
      await expectServiceError(setQuestionsAllowed(tx, { userId: A.id }, c.slug, c.key, { questionsAllowed: true }, at(5)), 'FORBIDDEN', 'not_log_author')
      // 없는 키·막힘이 아닌 키·없는 공개는 404.
      await expectServiceError(getStuckQaCard(tx, null, c.slug, 'zz-none', at(5)), 'NOT_FOUND')
      await expectServiceError(getStuckQaCard(tx, null, 'no-such-case', c.key, at(5)), 'NOT_FOUND')

      const card = await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(6))
      expect(card).toMatchObject({ questionsAllowed: true, viewer: { isLogAuthor: true, canWrite: true } })
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'stuck_qa.questions_toggle'), eq(auditEvents.actorId, owner.id)))
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({ targetType: 'stuck_qa_card', metadata: { questionsAllowed: true } })

      // 인증 없는 사람: 403 + 인증 안내. 로그 작성자는 자기 카드에 질문을 열 수 없음.
      const denied = await expectServiceError(createStuckQaThread(tx, { userId: stranger.id }, c.slug, c.key, { body: '질문' }, at(7)), 'FORBIDDEN', 'hub_write_not_allowed')
      expect(denied.details).toMatchObject({ requirement: 'school_affiliation', schoolId: f.schoolId })
      expect((await getStuckQaCard(tx, { userId: stranger.id }, c.slug, c.key, at(7))).viewer).toEqual({ isLogAuthor: false, canWrite: false, requirement: 'school_affiliation' })
      expect((await expectServiceError(createStuckQaThread(tx, { userId: owner.id }, c.slug, c.key, { body: '내 질문' }, at(7)), 'VALIDATION')).fields).toEqual({ card: 'own_card' })
      expect((await expectServiceError(createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '   ' }, at(7)), 'VALIDATION')).fields).toEqual({ body: 'required' })
      expect((await expectServiceError(createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: 'x'.repeat(2001) }, at(7)), 'VALIDATION')).fields).toEqual({ body: 'too_long' })

      const thread = await createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '왜 좀비가 남나요?' }, at(8))
      expect(thread.posts).toEqual([expect.objectContaining({ kind: 'question', label: '질문자', role: 'asker', mine: true, body: '왜 좀비가 남나요?' })])

      // 끄면: 새 질문·답변은 409, 기존 스레드는 읽기만.
      await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: false }, at(9))
      await expectServiceError(createStuckQaAnswer(tx, { userId: owner.id }, thread.id, { body: '답' }, at(10)), 'CONFLICT', 'questions_closed')
      await expectServiceError(createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '또' }, at(10)), 'CONFLICT', 'questions_closed')
      expect(await getStuckQaThread(tx, null, thread.id, at(10))).toMatchObject({ open: false, posts: [expect.objectContaining({ label: '질문자' })] })
      expect((await getStuckQaCard(tx, null, c.slug, c.key, at(10))).threads).toHaveLength(1)

      // 과목 연결이 없는 공개는 켤 수 없습니다.
      const noCourse = await publishStuck(tx, owner.id, null)
      await expectServiceError(setQuestionsAllowed(tx, { userId: owner.id }, noCourse.slug, noCourse.key, { questionsAllowed: true }, at(11)), 'CONFLICT', 'course_not_linked')
    })
  })

  it('withdrawal or embargo closes the card: card, thread, posts, helpful and reports are 404 while rows stay', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await verified(tx, f.schoolId)
      const A = await verified(tx, f.schoolId)
      const B = await verified(tx, f.schoolId)
      for (const close of ['withdraw', 'embargo'] as const) {
        const c = await publishStuck(tx, owner.id, f.term.id)
        await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(5))
        const thread = await createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '질문' }, at(6))
        const answered = await createStuckQaAnswer(tx, { userId: B.id }, thread.id, { body: '원리 설명' }, at(7))
        const answerId = answered.posts.find((p) => p.kind === 'answer')!.id
        if (close === 'withdraw') await withdrawPublication(tx, { userId: owner.id }, c.publication.id, {}, at(8))
        else await addProjectEmbargo(tx, { userId: owner.id }, c.project.id, { until: '2027-06-01T00:00:00Z', reason: '재수강' }, at(8))
        await expectServiceError(getStuckQaCard(tx, null, c.slug, c.key, at(9)), 'NOT_FOUND')
        await expectServiceError(getStuckQaThread(tx, { userId: A.id }, thread.id, at(9)), 'NOT_FOUND')
        await expectServiceError(createStuckQaAnswer(tx, { userId: B.id }, thread.id, { body: '또' }, at(9)), 'NOT_FOUND')
        await expectServiceError(createStuckQaThread(tx, { userId: B.id }, c.slug, c.key, { body: '새 질문' }, at(9)), 'NOT_FOUND')
        await expectServiceError(setStuckQaHelpful(tx, { userId: A.id }, answerId, true, at(9)), 'NOT_FOUND')
        await expectServiceError(createReport(tx, { userId: A.id }, { targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: answerId }, reason: 'spam' }, at(9)), 'NOT_FOUND')
        await expectServiceError(setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(9)), 'NOT_FOUND')
        // 행은 남고, 내 글은 그래도 지울 수 있습니다.
        expect(await tx.select().from(stuckQaPosts).where(eq(stuckQaPosts.threadId, thread.id))).toHaveLength(2)
        await withdrawStuckQaPost(tx, { userId: B.id }, answerId, at(10))
        expect((await tx.select().from(stuckQaPosts).where(eq(stuckQaPosts.id, answerId)))[0]).toMatchObject({ status: 'withdrawn', body: '' })
      }
    })
  })

  it('aliases: same person same number within a thread, independent across threads, log author always 작성자; no ids in DTOs', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await verified(tx, f.schoolId)
      const c = await publishStuck(tx, owner.id, f.term.id)
      const [A, B, C] = [await verified(tx, f.schoolId), await verified(tx, f.schoolId), await verified(tx, f.schoolId)]
      await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(5))

      const t1 = await createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '첫 질문' }, at(6))
      await createStuckQaAnswer(tx, { userId: B.id }, t1.id, { body: 'B 첫 답' }, at(7))
      await createStuckQaAnswer(tx, { userId: C.id }, t1.id, { body: 'C 답' }, at(8))
      await createStuckQaAnswer(tx, { userId: B.id }, t1.id, { body: 'B 두 번째' }, at(9))
      await createStuckQaAnswer(tx, { userId: owner.id }, t1.id, { body: '작성자 답' }, at(10))
      const full = await createStuckQaAnswer(tx, { userId: A.id }, t1.id, { body: '질문자 덧붙임' }, at(11))
      const labelOf = (body: string) => full.posts.find((p) => p.body === body)!.label
      expect(labelOf('첫 질문')).toBe('질문자')
      expect(labelOf('B 첫 답')).toBe('익명1')
      expect(labelOf('B 두 번째')).toBe('익명1')
      expect(labelOf('C 답')).toBe('익명2')
      expect(labelOf('작성자 답')).toBe('작성자')
      expect(labelOf('질문자 덧붙임')).toBe('질문자')
      expect(full.posts.find((p) => p.body === '작성자 답')!.role).toBe('log_author')

      // 다른 스레드: C가 질문자, B는 처음 쓰므로 익명1(번호가 이어지지 않음).
      const t2 = await createStuckQaThread(tx, { userId: C.id }, c.slug, c.key, { body: '둘째 질문' }, at(12))
      const t2b = await createStuckQaAnswer(tx, { userId: B.id }, t2.id, { body: 'B 다른 스레드' }, at(13))
      expect(t2b.posts.map((p) => p.label)).toEqual(['질문자', '익명1'])
      // 로그 작성자는 번호 행이 없습니다.
      expect(await tx.select().from(stuckQaAliases).where(eq(stuckQaAliases.userId, owner.id))).toEqual([])

      // 공개 DTO(비로그인·로그인)에는 사람 id·도움됐어요 개수가 없습니다.
      const ids = [owner.id, A.id, B.id, C.id]
      for (const viewer of [null, { userId: B.id }]) {
        const json = JSON.stringify([await getStuckQaCard(tx, viewer, c.slug, c.key, at(14)), await getStuckQaThread(tx, viewer, t1.id, at(14))])
        for (const id of ids) expect(json).not.toContain(id)
        expect(json).not.toMatch(/"helped"|helpedCount|authorId|userId/)
      }
      const asB = await getStuckQaThread(tx, { userId: B.id }, t1.id, at(14))
      expect(asB.posts.filter((p) => p.mine).map((p) => p.label)).toEqual(['익명1', '익명1'])
      expect(asB.posts.filter((p) => !p.mine).every((p) => p.countAsContribution === null)).toBe(true)
    })
  })

  it('helpful affects ordering only (threads within the card, answers within the thread); own posts and questions refused', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await verified(tx, f.schoolId)
      const c = await publishStuck(tx, owner.id, f.term.id)
      const [A, B, C, D] = [await verified(tx, f.schoolId), await verified(tx, f.schoolId), await verified(tx, f.schoolId), await createUser(tx)]
      await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(5))
      const older = await createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '오래된 질문' }, at(6))
      const first = await createStuckQaAnswer(tx, { userId: B.id }, older.id, { body: '먼저 쓴 답' }, at(7))
      const second = await createStuckQaAnswer(tx, { userId: C.id }, older.id, { body: '나중에 쓴 답' }, at(8))
      const newer = await createStuckQaThread(tx, { userId: B.id }, c.slug, c.key, { body: '최근 질문' }, at(9))
      expect((await getStuckQaCard(tx, null, c.slug, c.key, at(10))).threads.map((t) => t.question)).toEqual(['최근 질문', '오래된 질문'])
      expect((await getStuckQaThread(tx, null, older.id, at(10))).posts.map((p) => p.body)).toEqual(['오래된 질문', '먼저 쓴 답', '나중에 쓴 답'])

      const late = second.posts.find((p) => p.body === '나중에 쓴 답')!.id
      const early = first.posts.find((p) => p.body === '먼저 쓴 답')!.id
      // 도움됐어요는 로그인한 누구나(학교 인증 불필요), 같은 사람은 한 번.
      expect(await setStuckQaHelpful(tx, { userId: D.id }, late, true, at(11))).toEqual({ helpedByMe: true })
      expect(await setStuckQaHelpful(tx, { userId: D.id }, late, true, at(11))).toEqual({ helpedByMe: true })
      expect((await getStuckQaThread(tx, { userId: D.id }, older.id, at(12))).posts.map((p) => [p.body, p.helpedByMe])).toEqual([
        ['오래된 질문', false],
        ['나중에 쓴 답', true],
        ['먼저 쓴 답', false],
      ])
      // 도움됐어요를 받은 답변이 있는 스레드가 먼저.
      expect((await getStuckQaCard(tx, null, c.slug, c.key, at(12))).threads.map((t) => t.question)).toEqual(['오래된 질문', '최근 질문'])
      // 응답 어디에도 개수가 없습니다.
      expect(JSON.stringify(await getStuckQaThread(tx, { userId: D.id }, older.id, at(12)))).not.toMatch(/"helped"|helpedCount/)
      // 거두면 순서가 돌아옵니다.
      expect(await setStuckQaHelpful(tx, { userId: D.id }, late, false, at(13))).toEqual({ helpedByMe: false })
      expect((await getStuckQaThread(tx, null, older.id, at(13))).posts.map((p) => p.body)).toEqual(['오래된 질문', '먼저 쓴 답', '나중에 쓴 답'])
      // 자기 글·질문에는 못 누름.
      expect((await expectServiceError(setStuckQaHelpful(tx, { userId: B.id }, early, true, at(14)), 'VALIDATION')).fields).toEqual({ post: 'own_post' })
      const questionId = newer.posts[0]!.id
      expect((await expectServiceError(setStuckQaHelpful(tx, { userId: A.id }, questionId, true, at(14)), 'VALIDATION')).fields).toEqual({ post: 'not_answer' })
    })
  })

  it('junior contribution is the answerer\'s choice per answer (default off) and counts only visible answers', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await verified(tx, f.schoolId)
      const c = await publishStuck(tx, owner.id, f.term.id)
      const A = await verified(tx, f.schoolId)
      const handle = `sqb${f.t}`
      const B = await verified(tx, f.schoolId, handle)
      await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(5))
      const thread = await createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '질문' }, at(6))
      const answered = await createStuckQaAnswer(tx, { userId: B.id }, thread.id, { body: '원리 설명' }, at(7))
      const mine = answered.posts.find((p) => p.mine)!
      expect(mine.countAsContribution).toBe(false)
      expect((await getPublicPortfolioProfile(tx, handle, at(8))).juniorContribution.stuckQaAnswers).toBe(0)
      // 남이 바꿀 수 없고, 질문은 대상이 아닙니다.
      await expectServiceError(setStuckQaContribution(tx, { userId: A.id }, mine.id, { countAsContribution: true }, at(8)), 'NOT_FOUND')
      await expectServiceError(setStuckQaContribution(tx, { userId: A.id }, thread.posts[0]!.id, { countAsContribution: true }, at(8)), 'NOT_FOUND')
      expect(await setStuckQaContribution(tx, { userId: B.id }, mine.id, { countAsContribution: true }, at(8))).toMatchObject({ countAsContribution: true, mine: true })
      expect((await getPublicPortfolioProfile(tx, handle, at(9))).juniorContribution.stuckQaAnswers).toBe(1)
      // 공개가 철회되면 세지 않습니다(행·선택은 그대로).
      await withdrawPublication(tx, { userId: owner.id }, c.publication.id, {}, at(10))
      expect((await getPublicPortfolioProfile(tx, handle, at(11))).juniorContribution.stuckQaAnswers).toBe(0)
      expect((await tx.select().from(stuckQaPosts).where(eq(stuckQaPosts.id, mine.id)))[0]!.countAsContribution).toBe(true)
    })
  })

  it('reports, hiding and operator author lookup: hiding the question closes the thread; lookup is tied to a report and audited with ids only; curators see it in first-pass review', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const owner = await verified(tx, f.schoolId)
      const c = await publishStuck(tx, owner.id, f.term.id)
      const [A, B, R] = [await verified(tx, f.schoolId), await verified(tx, f.schoolId), await createUser(tx)]
      await setQuestionsAllowed(tx, { userId: owner.id }, c.slug, c.key, { questionsAllowed: true }, at(5))
      const thread = await createStuckQaThread(tx, { userId: A.id }, c.slug, c.key, { body: '숙제 답 알려주세요' }, at(6))
      const answered = await createStuckQaAnswer(tx, { userId: B.id }, thread.id, { body: '정답 코드 판매합니다' }, at(7))
      const answerId = answered.posts.find((p) => p.kind === 'answer')!.id
      const questionId = thread.posts[0]!.id

      // 큐레이터(그 과목을 마치고 인증한 사람)는 1차 검토 범위에서 봅니다.
      const curator = await verified(tx, f.schoolId)
      await createProject(tx, { userId: curator.id }, { title: '지난 학기 과제', courseTermId: f.term.id }, T0)
      await grantCourseCurator(tx, f.O, f.course.id, { userId: curator.id }, at(7))
      for (const p of await listMyCuratorProposals(tx, { userId: curator.id })) await acceptCuratorProposal(tx, { userId: curator.id }, p.id, at(7))

      const report = await createReport(tx, { userId: R.id }, { targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: answerId }, reason: 'answer_sharing', details: '판매' }, at(8))
      expect(report).toMatchObject({ created: true })
      const groups = await listCuratorReports(tx, { userId: curator.id }, f.course.id, at(8))
      expect(groups).toHaveLength(1)
      // ADR 0060 D-08: 큐레이터 본인이 쓴 글의 신고는 목록에서 빠지고 의견도 404입니다.
      const own = await createStuckQaAnswer(tx, { userId: curator.id }, thread.id, { body: '제가 쓴 답입니다' }, at(8))
      const ownId = own.posts.filter((p) => p.kind === 'answer').at(-1)!.id
      const ownReport = await createReport(tx, { userId: R.id }, { targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: ownId }, reason: 'spam' }, at(8))
      expect((await listCuratorReports(tx, { userId: curator.id }, f.course.id, at(8))).map((g) => g.reportId)).toEqual([report.id])
      await expectServiceError(recommendOnReport(tx, { userId: curator.id }, f.course.id, ownReport.id, { recommendation: 'dismiss' }, at(8)), 'NOT_FOUND')
      expect(groups[0]).toMatchObject({ targetType: 'stuck_qa_post', content: { kind: 'stuck_qa_post', post: { label: '익명1', body: '정답 코드 판매합니다' } } })
      expect(JSON.stringify(groups)).not.toContain(B.id)

      // 운영자 상세: 표시·본문만(작성자 없음).
      const detail = await getReportDetail(tx, f.O, report.id, at(9))
      expect(detail.content).toMatchObject({ kind: 'stuck_qa_post', post: { id: answerId, label: '익명1', kind: 'answer', question: '숙제 답 알려주세요' } })
      expect(detail.servedNow).toBe(true)
      expect(JSON.stringify(detail.content)).not.toContain(B.id)

      // 작성자 확인: 운영자만, 그 글을 가리키는 신고에 묶여서만, 감사(id만).
      await expectServiceError(operatorStuckQaAuthor(tx, { userId: A.id }, answerId, { reportId: report.id }), 'FORBIDDEN', 'operator_only')
      await expectServiceError(operatorStuckQaAuthor(tx, f.O, questionId, { reportId: report.id }), 'NOT_FOUND')
      const lookup = await operatorStuckQaAuthor(tx, f.O, answerId, { reportId: report.id })
      expect(lookup).toMatchObject({ postId: answerId, reportId: report.id, byLogAuthor: false, author: { userId: B.id, status: 'active' } })
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'stuck_qa.author_lookup'), eq(auditEvents.targetId, answerId)))
      expect(audit).toMatchObject({ actorId: f.O.userId, targetType: 'stuck_qa_post', metadata: { reportId: report.id } })

      // 숨김: 답변 자리에 상태만 남음.
      await resolveReport(tx, f.O, report.id, { action: 'hide_stuck_qa_post', note: '정답 판매', publicReason: '정답 판매는 허용하지 않습니다', notifyOwner: true }, at(10))
      const after = await getStuckQaThread(tx, null, thread.id, at(11))
      expect(after.posts.find((p) => p.id === answerId)).toMatchObject({ status: 'hidden', body: null })
      await expectServiceError(setStuckQaHelpful(tx, { userId: A.id }, answerId, true, at(11)), 'NOT_FOUND')
      expect((await getReportDetail(tx, f.O, report.id, at(11))).servedNow).toBe(false)
      // 당사자(답변을 쓴 사람)에게만 안내가 가고 이의제기할 수 있습니다. 안내에는 신고자·작성자 id가 없습니다.
      const [notice] = await listMyModerationNotices(tx, { userId: B.id })
      expect(notice).toMatchObject({ kind: 'hide_stuck_qa_post', targetType: 'stuck_qa_post', ownerPath: `/stuck-qa/threads/${thread.id}`, canAppeal: true })
      expect(await listMyModerationNotices(tx, { userId: A.id })).toEqual([])

      // 질문을 숨기면 스레드 전체가 보이지 않습니다.
      const qReport = await createReport(tx, { userId: R.id }, { targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: questionId }, reason: 'answer_sharing' }, at(12))
      await resolveReport(tx, f.O, qReport.id, { action: 'hide_stuck_qa_post', note: '과제 대리 요청' }, at(13))
      await expectServiceError(getStuckQaThread(tx, null, thread.id, at(14)), 'NOT_FOUND')
      expect((await getStuckQaCard(tx, null, c.slug, c.key, at(14))).threads).toEqual([])
      // 숨긴 글은 다시 신고할 수 없습니다(지금 공개가 아님).
      await expectServiceError(createReport(tx, { userId: A.id }, { targetType: 'stuck_qa_post', targetRef: { stuckQaPostId: answerId }, reason: 'spam' }, at(14)), 'NOT_FOUND')
    })
  })
})
