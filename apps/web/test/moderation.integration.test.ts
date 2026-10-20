/**
 * T-15 신고·보류·운영 조치·이의제기·감사 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 DB 테스트는 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 사용자·프로젝트·공개·신고 행만 봅니다(slug·handle·과목 이름 무작위, 개발 DB에 남은 행과 무관).
 * 공개 읽기는 같은 트랜잭션(tx)으로 읽어 "조치 커밋 즉시(worker 없이) 공개 경로에서 사라짐"을 확인합니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { HIDDEN_ITEM_PLACEHOLDER } from '@peerchive/domain'
import {
  MODERATION_ACTION_TOPIC,
  PUBLICATION_WITHDRAWN_TOPIC,
  and,
  auditEvents,
  eq,
  holds,
  inArray,
  operators,
  outboxEvents,
  publications,
  reports,
  searchDocuments,
  seniorNotes,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { createClaim } from '../server/modules/contribution/claims'
import { forkPublication } from '../server/modules/course-hub/fork'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { searchPublic } from '../server/modules/course-hub/search'
import { publishSeniorNote } from '../server/modules/course-hub/senior-notes'
import { putSignal } from '../server/modules/course-hub/signals'
import { getPublicProfile } from '../server/modules/identity/profiles'
import { getMe } from '../server/modules/identity/profiles'
import { createLog, listLogs } from '../server/modules/logs/logs'
import { createMilestone } from '../server/modules/milestones/milestones'
import { createAppeal, listMyModerationNotices } from '../server/modules/moderation/notices'
import {
  assignReport,
  decideAppeal,
  dismissReport,
  getReportDetail,
  liftRestriction,
  listAppeals,
  listAudit,
  listReportGroups,
  resolveReport,
} from '../server/modules/moderation/operator'
import { REPORT_RATE_LIMIT, createReport, listMyReports } from '../server/modules/moderation/reports'
import { createCaseStudy, getCaseStudy, publishCaseStudy } from '../server/modules/portfolio/case-studies'
import { createEdition } from '../server/modules/portfolio/editions'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { CASE_HIDDEN_MESSAGE } from '../server/modules/portfolio/view'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject, getProject } from '../server/modules/projects/projects'
import { createCandidate, decideConsent, getCandidate, getPublicationState } from '../server/modules/publication/candidates'
import { getPublicPublication } from '../server/modules/publication/public-read'
import { publishCandidate } from '../server/modules/publication/releases'
import { hitRateLimit } from '../server/modules/security/rate-limit'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const SENTINEL = 'ZZWORKSPACESENTINELZZ'
const DETAILS = 'ZZREPORTDETAILSZZ 전화번호가 보입니다'
const NOTE = 'ZZINTERNALNOTEZZ'
const APPEAL = 'ZZAPPEALMESSAGEZZ'
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

/**
 * 지난 학기 과목에 연결된 팀 과제: owner A(이름 공개) + 팀원 B(editor, 익명). 막힘 둘·해결·진행·선언을 담아 요약 공개로 게시합니다.
 * 신고자 C, 운영자 O, 아무 관계 없는 사람 X.
 */
async function fixture(db: DbExecutor) {
  const t = rand()
  const ownerHandle = `mo-${t}`
  const owner = await createUser(db, { displayName: '김지민', handle: ownerHandle })
  const member = await createUser(db, { displayName: '박익명', handle: `mm-${t}` })
  const reporter = await createUser(db, { displayName: '신고자', handle: `mr-${t}` })
  const reporter2 = await createUser(db, { displayName: '신고자2' })
  const operator = await createUser(db, { displayName: '운영자', handle: `mx-${t}` })
  await db.insert(operators).values({ userId: operator.id })
  const A = { userId: owner.id }
  const B = { userId: member.id }
  const C = { userId: reporter.id }
  const C2 = { userId: reporter2.id }
  const O = { userId: operator.id }

  const school = await createSchool(db, A, { name: `운영대${t}학교`, confirmNew: true }, T0)
  const course = await createCourse(db, A, school.id, { title: `자료구조${t}`, confirmNew: true }, T0)
  const { term } = await createCourseTerm(db, A, course.id, { year: 2025, semester: 'fall' }, T0)

  const project = await createProject(db, A, { title: `비공개 작업 ${SENTINEL}`, kind: 'team', courseTermId: term.id }, T0)
  const { token } = await createInvitation(db, A, project.id, { role: 'editor' }, T0)
  await acceptInvitation(db, B, { token }, T0)
  const m1 = await createMilestone(db, A, project.id, { title: '기획', note: `${SENTINEL} 메모` }, at(1))
  const stuck1 = (
    await createLog(db, A, project.id, { tag: 'stuck', payload: { symptom: '연결 리스트 순환 010-1234-5678', keywords: ['list'], timeBucket: 'half_day' } }, at(2))
  ).log
  const solution = (
    await createLog(db, B, project.id, { tag: 'solution', payload: { method: '두 포인터로 순환 감지', notAnswerConfirmed: true }, resolvesEntryId: stuck1.id }, at(3))
  ).log
  const stuck2 = (await createLog(db, A, project.id, { tag: 'stuck', payload: { symptom: '해시 충돌이 잦음', keywords: ['hash'], timeBucket: 'lt2h' } }, at(4))).log
  const decision = (
    await createLog(db, A, project.id, { tag: 'decision', payload: { options: ['배열', '리스트'], criteria: '삽입 속도', choice: '리스트' } }, at(4))
  ).log
  await createLog(db, A, project.id, { tag: 'progress', body: `비공개 진행 ${SENTINEL}` }, at(5))
  const claim = await createClaim(db, A, project.id, { text: '자료구조 구현을 맡았다' }, at(5))

  const slug = `mod-${t}`
  const candidate = await createCandidate(
    db,
    A,
    project.id,
    {
      level: 'summary',
      title: '자료구조 과제',
      summary: '연결 리스트와 해시 테이블을 구현했다.',
      slug,
      logIds: [stuck1.id, solution.id, stuck2.id, decision.id],
      milestoneIds: [m1.id],
      claimIds: [claim.id],
      exposure: { [owner.id]: 'name', [member.id]: 'anonymous' },
      consentSelf: true,
    },
    at(6),
    ORIGINS,
  )
  await decideConsent(db, B, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(7))
  const published = await publishCandidate(db, A, candidate.id, { manifestHash: candidate.manifestHash }, at(8))
  const pub = await getPublicPublication(db, slug, at(9))
  const keyOf = (symptom: string) => pub.snapshot.logs.find((l) => (l.payload as { symptom?: string }).symptom?.startsWith(symptom))!.key
  return {
    owner,
    member,
    reporter,
    reporter2,
    operator,
    A,
    B,
    C,
    C2,
    O,
    ownerHandle,
    course,
    project,
    slug,
    publication: published.publication,
    ids: { m1, stuck1, solution, stuck2, decision, claim },
    keys: { stuck1: keyOf('연결 리스트'), stuck2: keyOf('해시 충돌'), claim: pub.snapshot.claims[0]!.key },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** 다음 버전 후보(같은 선택)를 만들고 B가 동의합니다. */
async function nextCandidate(db: DbExecutor, f: Fixture, now: Date) {
  const c = await createCandidate(
    db,
    f.A,
    f.project.id,
    {
      level: 'summary',
      title: '자료구조 과제',
      summary: '연결 리스트와 해시 테이블을 구현했다(개정).',
      slug: f.slug,
      logIds: [f.ids.stuck1.id, f.ids.solution.id, f.ids.stuck2.id, f.ids.decision.id],
      milestoneIds: [f.ids.m1.id],
      claimIds: [f.ids.claim.id],
      exposure: { [f.owner.id]: 'name', [f.member.id]: 'anonymous' },
      consentSelf: true,
    },
    now,
    ORIGINS,
  )
  return c
}

async function publishedNote(db: DbExecutor, f: Fixture) {
  const [note] = await db
    .insert(seniorNotes)
    .values({
      courseId: f.course.id,
      authorId: f.owner.id,
      displayMode: 'anonymous',
      answers: { firstWeek: '명세부터 읽기', timeSink: '디버깅' },
      noAnswersConfirmed: true,
      status: 'published',
      publishedAt: T0,
    })
    .returning()
  return note!
}

describe.skipIf(!databaseUrl)('reports, holds, moderation, appeals and audit (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('reports need a logged-in reporter and a currently public target; dedupe returns the open report; rate limited', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      // 지금 공개가 아닌 대상은 404, 형식 오류는 422.
      await expectServiceError(createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: 'no-such-case-zz' }, reason: 'spam' }, at(10)), 'NOT_FOUND')
      await expectServiceError(
        createReport(tx, f.C, { targetType: 'publication_item', targetRef: { slug: f.slug, kind: 'log', key: 'l_missing' }, reason: 'spam' }, at(10)),
        'NOT_FOUND',
      )
      const invalidRef = await expectServiceError(createReport(tx, f.C, { targetType: 'publication', targetRef: {}, reason: 'spam' }, at(10)), 'VALIDATION')
      expect(invalidRef.fields).toMatchObject({ 'targetRef.slug': 'invalid' })
      await expectServiceError(createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'nope' }, at(10)), 'VALIDATION')
      await expectServiceError(
        createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'spam', details: 'x'.repeat(1001) }, at(10)),
        'VALIDATION',
      )
      const draftNote = (await tx.insert(seniorNotes).values({ courseId: f.course.id, authorId: f.owner.id, displayMode: 'anonymous', answers: { firstWeek: 'a', timeSink: 'b' }, noAnswersConfirmed: true }).returning())[0]!
      await expectServiceError(createReport(tx, f.C, { targetType: 'senior_note', targetRef: { noteId: draftNote.id }, reason: 'spam' }, at(10)), 'NOT_FOUND')
      await expectServiceError(createReport(tx, f.C, { targetType: 'case_study', targetRef: { handle: f.ownerHandle, anchor: 'case-1' }, reason: 'spam' }, at(10)), 'NOT_FOUND')

      const first = await createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'spam', details: DETAILS }, at(10))
      expect(first).toMatchObject({ created: true, status: 'received' })
      const again = await createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug.toUpperCase() }, reason: 'other' }, at(11))
      expect(again).toMatchObject({ id: first.id, created: false })
      // 다른 신고자는 새 신고. 같은 대상의 항목 신고는 다른 대상.
      const other = await createReport(tx, f.C2, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'spam' }, at(11))
      expect(other.created).toBe(true)
      const item = await createReport(tx, f.C, { targetType: 'publication_item', targetRef: { slug: f.slug, kind: 'log', key: f.keys.stuck2 }, reason: 'spam' }, at(11))
      expect(item.created).toBe(true)
      // 저장된 신고는 대상 내용을 복사하지 않고 release 포인터만 가집니다.
      const [row] = await tx.select().from(reports).where(eq(reports.id, first.id))
      expect(row).toMatchObject({ targetType: 'publication', publicationId: f.publication.id, details: DETAILS, status: 'open' })
      expect(row!.releaseId).toBeTruthy()
      expect(JSON.stringify(row)).not.toContain('자료구조 과제')

      // 시간당 10회 한도(이번 창에서 이미 쓴 만큼 채움). 중복 신고는 한도를 쓰지 않고 그대로 200.
      for (let i = 0; i < REPORT_RATE_LIMIT.limit; i++) await hitRateLimit(tx, 'report_create', f.reporter2.id, REPORT_RATE_LIMIT, at(12))
      await expectServiceError(
        createReport(tx, f.C2, { targetType: 'publication_item', targetRef: { slug: f.slug, kind: 'claim', key: f.keys.claim }, reason: 'spam' }, at(12)),
        'RATE_LIMITED',
      )
      expect((await createReport(tx, f.C2, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'spam' }, at(12))).created).toBe(false)
    })
  })

  it('operator routes are 403 operator_only for everyone else, and operators still cannot read the private workspace', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const r = await createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'harassment' }, at(10))
      const appealId = crypto.randomUUID()
      for (const who of [f.A, f.B, f.C]) {
        await expectServiceError(listReportGroups(tx, who, {}), 'FORBIDDEN', 'operator_only')
        await expectServiceError(getReportDetail(tx, who, r.id), 'FORBIDDEN', 'operator_only')
        await expectServiceError(assignReport(tx, who, r.id), 'FORBIDDEN', 'operator_only')
        await expectServiceError(resolveReport(tx, who, r.id, { action: 'none', note: 'x' }), 'FORBIDDEN', 'operator_only')
        await expectServiceError(dismissReport(tx, who, r.id, { note: 'x' }), 'FORBIDDEN', 'operator_only')
        await expectServiceError(liftRestriction(tx, who, f.publication.id, { note: 'x' }), 'FORBIDDEN', 'operator_only')
        await expectServiceError(listAppeals(tx, who, {}), 'FORBIDDEN', 'operator_only')
        await expectServiceError(decideAppeal(tx, who, appealId, { decision: 'uphold', note: 'x' }), 'FORBIDDEN', 'operator_only')
        await expectServiceError(listAudit(tx, who, { target: f.publication.id }), 'FORBIDDEN', 'operator_only')
      }
      // 운영자: 신고가 열려 있어도 비공개 과제 공간은 404(존재를 드러내지 않음).
      await expectServiceError(getProject(tx, f.O, f.project.id), 'NOT_FOUND')
      await expectServiceError(listLogs(tx, f.O, f.project.id, {}), 'NOT_FOUND')
      await expectServiceError(getPublicationState(tx, f.O, f.project.id, at(11)), 'NOT_FOUND')
      // 운영자가 보는 내용은 신고 때 release 스냅샷뿐(비공개 표식·이메일 없음).
      const detail = await getReportDetail(tx, f.O, r.id, at(11))
      expect(detail.content.kind).toBe('release')
      const text = JSON.stringify(detail)
      for (const secret of [SENTINEL, f.owner.email, f.member.email, f.reporter.email, f.reporter.id, '박익명']) expect(text).not.toContain(secret)
      expect(detail).toMatchObject({ servedNow: true, publicPath: `/p/${f.slug}`, allowedActions: ['none', 'restrict'] })
      const groups = await listReportGroups(tx, f.O, { status: 'open' })
      expect(groups.find((g) => g.reportId === r.id)).toMatchObject({ count: 1, reasons: { harassment: 1 }, hold: false, targetLabel: `공개 사례 /p/${f.slug}` })
      expect((await getMe(tx, f.O)).operator).toBe(true)
      expect((await getMe(tx, f.A)).operator).toBe(false)
    })
  })

  it('restrict: public 404 immediately (no worker), owner notice with the public reason only; lift → draft and republish needs fresh consents', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const r = await createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'answer_sharing', details: DETAILS }, at(10))
      const assigned = await assignReport(tx, f.O, r.id, at(11))
      expect(assigned.report.status).toBe('in_review')
      expect(assigned.assignee?.userId).toBe(f.operator.id)
      // 내부 메모는 필수, 조치 + 알림이면 당사자용 사유도 필수.
      await expectServiceError(resolveReport(tx, f.O, r.id, { action: 'restrict', note: '' }, at(12)), 'VALIDATION')
      const missingReason = await expectServiceError(resolveReport(tx, f.O, r.id, { action: 'restrict', note: NOTE, notifyOwner: true }, at(12)), 'VALIDATION')
      expect(missingReason.fields).toMatchObject({ publicReason: 'required' })
      await expectServiceError(resolveReport(tx, f.O, r.id, { action: 'hide_note', note: NOTE }, at(12)), 'VALIDATION')

      const resolved = await resolveReport(tx, f.O, r.id, { action: 'restrict', note: NOTE, publicReason: '과제 답안으로 보이는 내용', notifyOwner: true }, at(12))
      expect(resolved.report.status).toBe('resolved')
      expect(resolved.publication?.status).toBe('restricted')
      expect(resolved.servedNow).toBe(false)
      // 같은 트랜잭션에서 바로 404(worker 없음): 사례·과목 허브·포크·케이스 만들기.
      await expectServiceError(getPublicPublication(tx, f.slug, at(13)), 'NOT_FOUND')
      expect((await getPublicCourseHub(tx, f.course.id, at(13))).cases).toEqual([])
      await expectServiceError(forkPublication(tx, f.C, f.slug, at(13)), 'NOT_FOUND')
      await expectServiceError(createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(13)), 'NOT_FOUND')
      await expectServiceError(createReport(tx, f.C2, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'spam' }, at(13)), 'NOT_FOUND')
      // 제한 중에는 후보를 만들 수 없음.
      await expectServiceError(nextCandidate(tx, f, at(13)), 'CONFLICT', 'publication_locked')
      // outbox: 파생 정리(publication.withdrawn, restricted) + 운영 조치 이벤트.
      const events = await tx.select().from(outboxEvents).where(inArray(outboxEvents.topic, [PUBLICATION_WITHDRAWN_TOPIC, MODERATION_ACTION_TOPIC]))
      const mine = events.filter((e) => e.payload.publicationId === f.publication.id || e.payload.actionId === resolved.actions[0]!.id)
      expect(mine.map((e) => [e.topic, e.payload.cause ?? e.payload.phase]).sort()).toEqual([
        [MODERATION_ACTION_TOPIC, 'applied'],
        [PUBLICATION_WITHDRAWN_TOPIC, 'restricted'],
      ])

      // owner 안내: 당사자용 사유만, 내부 메모·신고 설명 없음. 이의제기는 owner만(editor B는 버튼 없음).
      const ownerState = await getPublicationState(tx, f.A, f.project.id, at(14))
      expect(ownerState.publication?.status).toBe('restricted')
      expect(ownerState.moderation).toHaveLength(1)
      expect(ownerState.moderation[0]).toMatchObject({ kind: 'restrict', publicReason: '과제 답안으로 보이는 내용', canAppeal: true, appeal: null })
      expect(JSON.stringify(ownerState)).not.toContain(NOTE)
      expect(JSON.stringify(ownerState)).not.toContain(DETAILS)
      expect((await getPublicationState(tx, f.B, f.project.id, at(14))).moderation[0]!.canAppeal).toBe(false)
      expect((await listMyModerationNotices(tx, f.A)).map((n) => n.kind)).toEqual(['restrict'])
      expect(await listMyModerationNotices(tx, f.C)).toEqual([])

      // 제한 해제 → draft. release는 되살리지 않으므로 공개는 여전히 404.
      await expectServiceError(liftRestriction(tx, f.O, f.publication.id, { note: '' }), 'VALIDATION')
      const lifted = await liftRestriction(tx, f.O, f.publication.id, { note: '답안 부분이 없음을 확인' }, at(15))
      expect(lifted.status).toBe('draft')
      await expectServiceError(liftRestriction(tx, f.O, f.publication.id, { note: '다시' }, at(15)), 'CONFLICT', 'not_restricted')
      await expectServiceError(getPublicPublication(tx, f.slug, at(16)), 'NOT_FOUND')
      expect((await getPublicationState(tx, f.A, f.project.id, at(16))).moderation).toEqual([])
      // 다시 게시: 새 후보 → 팀원 동의를 새로 받아야 함(이전 동의는 이어지지 않음).
      const c = await nextCandidate(tx, f, at(17))
      expect(c.status).toBe('awaiting_consent')
      expect(c.blockers).toContainEqual({ kind: 'consent_missing', userId: f.member.id, status: 'pending' })
      const blocked = await expectServiceError(publishCandidate(tx, f.A, c.id, { manifestHash: c.manifestHash }, at(18)), 'CONFLICT', 'publish_blocked')
      expect(JSON.stringify(blocked.details?.blockers)).toContain('consent_missing')
      await decideConsent(tx, f.B, c.id, { decision: 'granted', manifestHash: c.manifestHash }, at(19))
      const republished = await publishCandidate(tx, f.A, c.id, { manifestHash: c.manifestHash }, at(20))
      expect(republished.release.version).toBe(2)
      expect((await getPublicPublication(tx, f.slug, at(21))).version).toBe(2)
    })
  })

  it('hide_item: the item disappears from /p, its file-free placeholder stays; hub, search, signals and case study citations filter it synchronously', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      // 검색 문서(worker가 만드는 것과 같은 모양)를 직접 넣습니다.
      const [pubRow] = await tx.select().from(publications).where(eq(publications.id, f.publication.id))
      for (const [key, symptom] of [[f.keys.stuck1, '연결 리스트 순환'], [f.keys.stuck2, '해시 충돌이 잦음']] as const) {
        await tx.insert(searchDocuments).values({ kind: 'stuck', publicationId: f.publication.id, releaseId: pubRow!.currentReleaseId!, itemKey: key, title: symptom, snippet: symptom, searchText: `${symptom} 자료구조` })
      }
      // A의 케이스 스터디(막힘 1을 인용하는 문장이 있음) + 판.
      const cs = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(10))
      expect(JSON.stringify(cs.sections)).toContain(f.keys.stuck1)
      await publishCaseStudy(tx, f.A, cs.id, { expectedVersion: 1, confirmWarnings: true }, at(11))
      await createEdition(tx, f.A, { featuredCaseStudyIds: [cs.id], competencies: [{ label: '디버깅', preset: 'debugging' }] }, at(11))
      expect(JSON.stringify(await getPublicPortfolioProfile(tx, f.ownerHandle, at(12)))).toContain('연결 리스트 순환')

      const r = await createReport(tx, f.C, { targetType: 'publication_item', targetRef: { slug: f.slug, kind: 'log', key: f.keys.stuck1 }, reason: 'personal_info', details: DETAILS }, at(12))
      const before = (await tx.select({ accessEpoch: publications.accessEpoch }).from(publications).where(eq(publications.id, f.publication.id)))[0]!.accessEpoch
      const resolved = await resolveReport(tx, f.O, r.id, { action: 'hide_item', note: NOTE, publicReason: '전화번호가 보입니다', notifyOwner: true }, at(13))
      expect(resolved.content).toMatchObject({ kind: 'release', hiddenKeys: [`log:${f.keys.stuck1}`] })
      expect((await tx.select({ accessEpoch: publications.accessEpoch }).from(publications).where(eq(publications.id, f.publication.id)))[0]!.accessEpoch).toBe(before + 1)

      // /p: 사례는 그대로, 그 기록만 빠지고 자리 표시. 해결 로그의 "해결한 막힘" 참조도 지워짐.
      const pub = await getPublicPublication(tx, f.slug, at(14))
      expect(pub.snapshot.logs.map((l) => l.key)).not.toContain(f.keys.stuck1)
      expect(pub.hiddenItems).toEqual([{ kind: 'log', key: f.keys.stuck1, index: expect.any(Number) }])
      expect(pub.snapshot.logs.every((l) => l.resolves !== f.keys.stuck1)).toBe(true)
      expect(JSON.stringify(pub)).not.toContain('010-1234-5678')
      // 과목 허브: 막힘 카드에서 빠짐(다른 막힘은 남음).
      const hub = await getPublicCourseHub(tx, f.course.id, at(14))
      expect(hub.stuckItems.map((s) => s.key)).toEqual([f.keys.stuck2])
      expect(hub.cases).toHaveLength(1)
      // 검색: 문서가 남아 있어도 같은 쿼리에서 빠짐.
      const search = await searchPublic(tx, { q: '자료구조', type: 'stuck' }, at(14))
      expect(search.results.map((x) => x.path)).toEqual([`/p/${f.slug}#public-${f.keys.stuck2}`])
      // 신호·신고: 가린 항목은 지금 공개가 아님(404).
      await expectServiceError(putSignal(tx, f.C, { target: { kind: 'stuck_item', slug: f.slug, itemKey: f.keys.stuck1 }, kind: 'me_too' }, at(14)), 'NOT_FOUND')
      await expectServiceError(
        createReport(tx, f.C2, { targetType: 'publication_item', targetRef: { slug: f.slug, kind: 'log', key: f.keys.stuck1 }, reason: 'spam' }, at(14)),
        'NOT_FOUND',
      )
      // 케이스 스터디: 그 막힘을 인용한 문장은 글 대신 자리 표시, 인용 칩 없음.
      const profile = await getPublicPortfolioProfile(tx, f.ownerHandle, at(14))
      const sentences = profile.featured.flatMap((c) => (c.available ? c.sections.flatMap((s) => s.sentences) : []))
      expect(sentences.some((s) => s.moderated && s.text === HIDDEN_ITEM_PLACEHOLDER && s.citations.length === 0)).toBe(true)
      expect(JSON.stringify(profile)).not.toContain('연결 리스트 순환')
      expect(JSON.stringify(profile)).not.toContain(`#public-${f.keys.stuck1}`)
      // 새 버전을 게시해도 같은 키는 계속 가려짐(공개 전체에 적용).
      const c = await nextCandidate(tx, f, at(15))
      await decideConsent(tx, f.B, c.id, { decision: 'granted', manifestHash: c.manifestHash }, at(16))
      await publishCandidate(tx, f.A, c.id, { manifestHash: c.manifestHash }, at(17))
      const v2 = await getPublicPublication(tx, f.slug, at(18))
      expect(v2.version).toBe(2)
      expect(v2.snapshot.logs.map((l) => l.key)).not.toContain(f.keys.stuck1)

      // owner 안내에 가린 항목 표시(당사자 화면용), 이의제기 → 되돌리면 다시 보임.
      const [notice] = (await getPublicationState(tx, f.A, f.project.id, at(19))).moderation
      expect(notice).toMatchObject({ kind: 'hide_item', item: { kind: 'log', key: f.keys.stuck1 }, publicReason: '전화번호가 보입니다', canAppeal: true })
      await expectServiceError(createAppeal(tx, f.B, { actionId: notice!.actionId, message: '다시 봐 주세요' }, at(19)), 'NOT_FOUND')
      await expectServiceError(createAppeal(tx, f.C, { reportId: r.id, message: '다시 봐 주세요' }, at(19)), 'NOT_FOUND')
      const appeal = await createAppeal(tx, f.A, { reportId: r.id, message: APPEAL }, at(19))
      expect(appeal).toMatchObject({ actionId: notice!.actionId, status: 'open' })
      await expectServiceError(createAppeal(tx, f.A, { actionId: notice!.actionId, message: '한 번 더' }, at(19)), 'CONFLICT', 'already_appealed')
      const open = await listAppeals(tx, f.O, {})
      expect(open.find((a) => a.id === appeal.id)).toMatchObject({ message: APPEAL, reportId: r.id, action: { kind: 'hide_item' } })
      const decided = await decideAppeal(tx, f.O, appeal.id, { decision: 'reverse', note: '번호가 가짜임을 확인' }, at(20))
      expect(decided).toMatchObject({ status: 'reversed', action: { reversedAt: at(20).toISOString() } })
      await expectServiceError(decideAppeal(tx, f.O, appeal.id, { decision: 'uphold', note: 'x' }, at(20)), 'CONFLICT', 'already_decided')
      expect((await getPublicPublication(tx, f.slug, at(21))).snapshot.logs.map((l) => l.key)).toContain(f.keys.stuck1)
      expect((await getPublicCourseHub(tx, f.course.id, at(21))).stuckItems.map((s) => s.key).sort()).toEqual([f.keys.stuck1, f.keys.stuck2].sort())
      expect((await getPublicationState(tx, f.A, f.project.id, at(21))).moderation).toEqual([])
      expect((await listMyModerationNotices(tx, f.A))[0]).toMatchObject({ reversedAt: at(20).toISOString(), appeal: { status: 'reversed' }, canAppeal: false })
    })
  })

  it('personal_info report holds the publication: next version cannot publish until the report is resolved', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const r = await createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'personal_info' }, at(10))
      expect(await tx.select().from(holds).where(eq(holds.createdByReportId, r.id))).toHaveLength(1)
      // 보류는 이미 제공 중인 release를 내리지 않습니다.
      expect((await getPublicPublication(tx, f.slug, at(11))).version).toBe(1)
      const c = await nextCandidate(tx, f, at(11))
      const decided = await decideConsent(tx, f.B, c.id, { decision: 'granted', manifestHash: c.manifestHash }, at(12))
      expect(decided.status).toBe('awaiting_consent')
      expect(decided.blockers).toContainEqual({ kind: 'hold_open' })
      const state = await getPublicationState(tx, f.A, f.project.id, at(12))
      expect(state.holds).toEqual([{ reason: 'personal_info', createdAt: at(10).toISOString() }])
      const blocked = await expectServiceError(publishCandidate(tx, f.A, c.id, { manifestHash: c.manifestHash }, at(13)), 'CONFLICT', 'publish_blocked')
      expect(blocked.details?.blockers).toEqual([{ kind: 'hold_open' }])
      // 운영자 대기열에 보류 표시. 처리(조치 없음) → 보류 해제 → 게시.
      expect((await listReportGroups(tx, f.O, {})).find((g) => g.reportId === r.id)?.hold).toBe(true)
      await resolveReport(tx, f.O, r.id, { action: 'none', note: '개인정보 아님' }, at(14))
      expect((await tx.select().from(holds).where(eq(holds.createdByReportId, r.id)))[0]!.releasedAt).toEqual(at(14))
      expect((await getCandidate(tx, f.A, c.id, at(15))).status).toBe('ready')
      expect((await publishCandidate(tx, f.A, c.id, { manifestHash: c.manifestHash }, at(16))).release.version).toBe(2)
      // 닫힌 신고는 다시 처리할 수 없음. 신고자는 상태만 봅니다.
      await expectServiceError(resolveReport(tx, f.O, r.id, { action: 'restrict', note: 'x' }, at(17)), 'CONFLICT', 'already_closed')
      const mine = await listMyReports(tx, f.C)
      expect(mine).toHaveLength(1)
      expect(Object.keys(mine[0]!).sort()).toEqual(['closedAt', 'createdAt', 'id', 'reason', 'status', 'targetLabel', 'targetType'])
      expect(mine[0]).toMatchObject({ status: 'resolved', targetType: 'publication' })
      // 처리 뒤에는 같은 사람이 다시 신고할 수 있습니다(새 신고).
      expect((await createReport(tx, f.C, { targetType: 'publication', targetRef: { slug: f.slug }, reason: 'spam' }, at(18))).created).toBe(true)
    })
  })

  it('hide_note / hide_case_study / hide_profile remove the target from public reads; appeals reverse them; dismiss closes the group', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const note = await publishedNote(tx, f)
      expect((await getPublicCourseHub(tx, f.course.id, at(10))).seniorNotes.map((n) => n.id)).toContain(note.id)
      const rn = await createReport(tx, f.C, { targetType: 'senior_note', targetRef: { noteId: note.id }, reason: 'answer_sharing' }, at(10))
      const rn2 = await createReport(tx, f.C2, { targetType: 'senior_note', targetRef: { noteId: note.id }, reason: 'spam' }, at(10))
      expect((await listReportGroups(tx, f.O, {})).find((g) => [rn.id, rn2.id].includes(g.reportId))).toMatchObject({ count: 2, reasons: { answer_sharing: 1, spam: 1 } })
      const detail = await resolveReport(tx, f.O, rn.id, { action: 'hide_note', note: NOTE }, at(11))
      // 같은 대상의 신고 둘 다 닫힘.
      expect(detail.reports.map((x) => x.status)).toEqual(['resolved', 'resolved'])
      expect((await tx.select().from(reports).where(eq(reports.id, rn2.id)))[0]!.status).toBe('resolved')
      expect((await getPublicCourseHub(tx, f.course.id, at(12))).seniorNotes.map((n) => n.id)).not.toContain(note.id)
      await expectServiceError(publishSeniorNote(tx, f.A, note.id, { expectedVersion: 1 }, at(12)), 'CONFLICT', 'hidden')
      // 알림을 끈 조치는 목록에 없지만, 노트 화면 안내로는 보입니다.
      expect(await listMyModerationNotices(tx, f.A)).toEqual([])
      const noteAction = detail.actions[0]!
      const noteAppeal = await createAppeal(tx, f.A, { actionId: noteAction.id, message: APPEAL }, at(12))
      await decideAppeal(tx, f.O, noteAppeal.id, { decision: 'reverse', note: '정답 아님' }, at(13))
      expect((await tx.select().from(seniorNotes).where(eq(seniorNotes.id, note.id)))[0]!.status).toBe('published')

      // 케이스 스터디(대표 케이스 앵커로 신고) → 숨김.
      const cs = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'pm' }, at(14))
      await publishCaseStudy(tx, f.A, cs.id, { expectedVersion: 1, confirmWarnings: true }, at(14))
      await createEdition(tx, f.A, { featuredCaseStudyIds: [cs.id] }, at(14))
      const rc = await createReport(tx, f.C, { targetType: 'case_study', targetRef: { handle: f.ownerHandle, anchor: 'case-1' }, reason: 'false_claim' }, at(15))
      await expectServiceError(createReport(tx, f.C, { targetType: 'case_study', targetRef: { handle: f.ownerHandle, anchor: 'case-2' }, reason: 'spam' }, at(15)), 'NOT_FOUND')
      const csDetail = await getReportDetail(tx, f.O, rc.id, at(15))
      expect(csDetail.content.kind).toBe('case_study')
      await resolveReport(tx, f.O, rc.id, { action: 'hide_case_study', note: NOTE, publicReason: '근거 없는 기여 주장', notifyOwner: true }, at(16))
      const hiddenProfile = await getPublicPortfolioProfile(tx, f.ownerHandle, at(17))
      expect(hiddenProfile.featured).toEqual([{ anchor: 'case-1', available: false, message: CASE_HIDDEN_MESSAGE }])
      const csDto = await getCaseStudy(tx, f.A, cs.id, at(17))
      expect(csDto).toMatchObject({ hidden: true, moderation: { kind: 'hide_case_study', publicReason: '근거 없는 기여 주장', canAppeal: true } })
      await expectServiceError(publishCaseStudy(tx, f.A, cs.id, { expectedVersion: 1 }, at(17)), 'CONFLICT', 'hidden')
      await expectServiceError(createEdition(tx, f.A, { featuredCaseStudyIds: [cs.id] }, at(17)), 'VALIDATION')

      // 프로필 숨김 → /u·이전 공개 프로필 API 404. 계정·과제 공간은 그대로.
      const rp = await createReport(tx, f.C, { targetType: 'profile', targetRef: { handle: f.ownerHandle }, reason: 'harassment' }, at(18))
      await resolveReport(tx, f.O, rp.id, { action: 'hide_profile', note: NOTE }, at(19))
      await expectServiceError(getPublicPortfolioProfile(tx, f.ownerHandle, at(20)), 'NOT_FOUND')
      await expectServiceError(getPublicProfile(tx, f.ownerHandle), 'NOT_FOUND')
      await expectServiceError(createReport(tx, f.C2, { targetType: 'profile', targetRef: { handle: f.ownerHandle }, reason: 'spam' }, at(20)), 'NOT_FOUND')
      expect((await getMe(tx, f.A)).profileHidden).toBe(true)
      expect((await getProject(tx, f.A, f.project.id, at(20))).id).toBe(f.project.id)
      const profileAction = (await getReportDetail(tx, f.O, rp.id, at(20))).actions[0]!
      const pa = await createAppeal(tx, f.A, { actionId: profileAction.id, message: APPEAL }, at(20))
      await decideAppeal(tx, f.O, pa.id, { decision: 'uphold', note: '유지' }, at(21))
      await expectServiceError(getPublicProfile(tx, f.ownerHandle), 'NOT_FOUND')
      await expectServiceError(createAppeal(tx, f.A, { actionId: profileAction.id, message: '다시' }, at(21)), 'CONFLICT', 'already_appealed')

      // 기각: 조치 없음으로 닫히고 이의제기 대상이 아님.
      const rd = await createReport(tx, f.C, { targetType: 'publication_item', targetRef: { slug: f.slug, kind: 'claim', key: f.keys.claim }, reason: 'other', details: DETAILS }, at(22))
      const dismissed = await dismissReport(tx, f.O, rd.id, { note: NOTE }, at(23))
      expect(dismissed.report.status).toBe('dismissed')
      await expectServiceError(createAppeal(tx, f.A, { reportId: rd.id, message: APPEAL }, at(23)), 'CONFLICT', 'not_appealable')
      expect((await listMyReports(tx, f.C)).find((x) => x.id === rd.id)?.status).toBe('dismissed')
    })
  })

  it('audit rows reference ids and kinds only — no report details, internal notes or appeal messages', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const r = await createReport(tx, f.C, { targetType: 'publication_item', targetRef: { slug: f.slug, kind: 'log', key: f.keys.stuck2 }, reason: 'copyright', details: DETAILS }, at(10))
      await assignReport(tx, f.O, r.id, at(11))
      const resolved = await resolveReport(tx, f.O, r.id, { action: 'restrict', note: NOTE, publicReason: '권리 확인 필요', notifyOwner: true }, at(12))
      const appeal = await createAppeal(tx, f.A, { reportId: r.id, message: APPEAL }, at(13))
      await decideAppeal(tx, f.O, appeal.id, { decision: 'reverse', note: `${NOTE} 되돌림` }, at(14))
      expect((await tx.select({ status: publications.status }).from(publications).where(eq(publications.id, f.publication.id)))[0]!.status).toBe('draft')

      const rows = await tx
        .select()
        .from(auditEvents)
        .where(
          and(
            sql`${auditEvents.action} similar to '(report|moderation|appeal)\\.%'`,
            sql`(${auditEvents.targetId} in (${r.id}::uuid, ${appeal.id}::uuid, ${f.publication.id}::uuid) or ${auditEvents.metadata}->>'actionId' = ${resolved.actions[0]!.id})`,
          ),
        )
      const ours = rows.filter((e) => [r.id, appeal.id, f.publication.id].includes(e.targetId ?? '') || e.metadata.actionId === resolved.actions[0]!.id)
      expect(ours.map((e) => e.action).sort()).toEqual(['appeal.create', 'appeal.decide', 'moderation.apply', 'moderation.reverse', 'report.assign', 'report.create', 'report.resolve'])
      const text = JSON.stringify(ours)
      for (const secret of [DETAILS, NOTE, APPEAL, '권리 확인 필요']) expect(text).not.toContain(secret)
      // 운영자 감사 조회(대상 = 공개 id): 조치·되돌림이 나옵니다.
      const audit = await listAudit(tx, f.O, { target: f.publication.id })
      expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(['moderation.apply', 'moderation.reverse', 'report.create']))
      await expectServiceError(listAudit(tx, f.O, {}), 'VALIDATION')
    })
  })
})
