/**
 * E-12 AI 회고 인터뷰 통합 테스트(실제 PostgreSQL, ADR 0057). DATABASE_URL이 없으면 건너뜁니다.
 * AI는 테스트 전용 가짜 공급자(@peerchive/ai createFakeAiProvider)만 씁니다 — 네트워크 호출 없음.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FakeAiProvider, AiError, createFakeAiProvider } from '@peerchive/ai'
import {
  aiRetroDrafts,
  aiRetroOptIns,
  aiRetroSessions,
  aiUsageDaily,
  analyticsEvents,
  and,
  auditEvents,
  eq,
  hashSubject,
  logEntries,
  logRevisions,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { AI_RETRO_FIRST_QUESTION } from '@peerchive/domain'
import { aiConfigured, setAiEnvForTesting, setAiProviderForTesting } from '../server/modules/ai/ai'
import {
  DRAFT_SYSTEM_PROMPT,
  TURN_SYSTEM_PROMPT,
  answerAiRetro,
  approveAiRetroDraft,
  discardAiRetroDraft,
  discardAiRetroSession,
  getAiRetroState,
  setAiRetroOptIn,
  startAiRetroSession,
} from '../server/modules/ai/retro-interview'
import { analyticsPepper } from '../server/modules/analytics/analytics'
import { ServiceError } from '../server/modules/errors'
import { saveMyCheckin } from '../server/modules/checkins/checkins'
import { createLog, getLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { leaveProject, removeMember } from '../server/modules/projects/members'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate, previewCandidate } from '../server/modules/publication/candidates'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, withRollback } from './helpers'

/** 2026-10-20(화) 12:00 KST → 2026-W43. */
const T0 = new Date('2026-10-20T03:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))

const STUCK_DRAFT = {
  tag: 'stuck',
  body: '',
  stuck: { symptom: 'CORS 오류로 로그인 요청이 막힘', keywords: ['CORS', 'preflight'], attempts: ['프록시 설정'], time_bucket: 'half_day' },
  decision: null,
  validation: null,
}
const DECISION_DRAFT = {
  tag: 'decision',
  body: '',
  stuck: null,
  decision: { options: ['세션 쿠키', 'JWT'], criteria: '배포 환경 단순함', choice: '세션 쿠키', hindsight: null },
  validation: null,
}
/** 선택지가 하나뿐이라 로그 검증을 못 넘는 초안(버려져야 함). */
const BAD_DECISION_DRAFT = { ...DECISION_DRAFT, decision: { options: ['혼자'], criteria: 'x', choice: '혼자', hindsight: null } }

async function team(db: DbExecutor) {
  const owner = await createUser(db, { displayName: '김주인' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인 AI팀', kind: 'team' })
  const members: Record<string, { id: string }> = {}
  for (const [role, name] of [
    ['editor', '이편집'],
    ['viewer', '최열람'],
  ] as const) {
    const user = await createUser(db, { displayName: name })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members[role] = user
  }
  return { owner, project, editor: members.editor!, viewer: members.viewer! }
}

const sessionRow = (db: DbExecutor, projectId: string, userId: string) =>
  db
    .select()
    .from(aiRetroSessions)
    .where(and(eq(aiRetroSessions.projectId, projectId), eq(aiRetroSessions.userId, userId)))
    .then((rows) => rows[0] ?? null)

const logCount = async (db: DbExecutor, projectId: string) => (await db.select().from(logEntries).where(eq(logEntries.projectId, projectId))).length

/** 켠 뒤 시작해서 질문 3개에 답하고 초안 두 개(+버려질 하나)를 받습니다. */
async function interviewToDrafts(tx: DbExecutor, fake: FakeAiProvider, actor: { userId: string }, projectId: string) {
  await setAiRetroOptIn(tx, actor, projectId, { enabled: true }, at(0))
  await startAiRetroSession(tx, actor, projectId, at(0))
  fake.queue(
    { data: { finish: false, next_question: '그걸 어떻게 풀었어요?' } },
    { data: { finish: false, next_question: '어떤 방식을 골랐고 왜였나요?' } },
    { data: { finish: true, next_question: '' } },
    { data: { drafts: [STUCK_DRAFT, DECISION_DRAFT, BAD_DECISION_DRAFT] } },
  )
  await answerAiRetro(tx, actor, projectId, { questionNo: 1, answer: 'CORS 오류로 반나절 막혔어요' }, at(1))
  await answerAiRetro(tx, actor, projectId, { questionNo: 2, answer: '프록시를 설정해서 풀었어요' }, at(2))
  return answerAiRetro(tx, actor, projectId, { questionNo: 3, answer: '세션 쿠키를 골랐어요. 배포가 단순해서요' }, at(3))
}

describe.skipIf(!databaseUrl)('AI retro interview (PostgreSQL, fake AI provider)', () => {
  let fake: FakeAiProvider
  beforeEach(() => {
    fake = createFakeAiProvider()
    setAiProviderForTesting(fake)
    setAiEnvForTesting({ NODE_ENV: 'test' })
  })
  afterEach(() => {
    setAiProviderForTesting(undefined)
    setAiEnvForTesting(null)
  })
  afterAll(closeTestDb)

  it('AI off: every route is 404 and the form check-in works unchanged', async () => {
    setAiProviderForTesting(null)
    expect(aiConfigured()).toBe(false)
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx)
      const actor = { userId: owner.id }
      await expectServiceError(getAiRetroState(tx, actor, project.id, at(0)), 'NOT_FOUND')
      await expectServiceError(setAiRetroOptIn(tx, actor, project.id, { enabled: true }, at(0)), 'NOT_FOUND')
      await expectServiceError(startAiRetroSession(tx, actor, project.id, at(0)), 'NOT_FOUND')
      await expectServiceError(answerAiRetro(tx, actor, project.id, { questionNo: 1, answer: 'x' }, at(0)), 'NOT_FOUND')
      await expectServiceError(discardAiRetroSession(tx, actor, project.id, at(0)), 'NOT_FOUND')
      await expectServiceError(approveAiRetroDraft(tx, actor, project.id, crypto.randomUUID(), {}, at(0)), 'NOT_FOUND')
      await expectServiceError(discardAiRetroDraft(tx, actor, project.id, crypto.randomUUID(), at(0)), 'NOT_FOUND')

      const saved = await saveMyCheckin(tx, actor, project.id, { timeBucket: 'lt5h', difficulty: 3, note: '로그인 API', promote: { tag: 'stuck' } }, at(0))
      expect(saved.checkin).toMatchObject({ timeBucket: 'lt5h', difficulty: 3, note: '로그인 API' })
      expect(saved.log).toMatchObject({ tag: 'stuck', source: 'web' })
      expect(fake.calls).toHaveLength(0)
    })
  })

  it('opt-in is per student and per project, off by default; only owner/editor; non-members 404', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, viewer, project } = await team(tx)
      const other = await createProject(tx, { userId: owner.id }, { title: '다른 과제', kind: 'individual' })
      const stranger = await createUser(tx)
      expect(await getAiRetroState(tx, { userId: owner.id }, project.id, at(0))).toEqual({ optedIn: false, canUse: true, session: null, drafts: [] })
      await expectServiceError(startAiRetroSession(tx, { userId: owner.id }, project.id, at(0)), 'FORBIDDEN', 'ai_opt_in_required')
      await expectServiceError(answerAiRetro(tx, { userId: owner.id }, project.id, { questionNo: 1, answer: 'x' }, at(0)), 'FORBIDDEN', 'ai_opt_in_required')

      expect((await setAiRetroOptIn(tx, { userId: owner.id }, project.id, { enabled: true }, at(0))).optedIn).toBe(true)
      // 다른 과제·다른 팀원에게는 번지지 않습니다.
      expect((await getAiRetroState(tx, { userId: owner.id }, other.id, at(0))).optedIn).toBe(false)
      expect((await getAiRetroState(tx, { userId: editor.id }, project.id, at(0))).optedIn).toBe(false)

      expect(await getAiRetroState(tx, { userId: viewer.id }, project.id, at(0))).toMatchObject({ canUse: false })
      await expectServiceError(setAiRetroOptIn(tx, { userId: viewer.id }, project.id, { enabled: true }, at(0)), 'FORBIDDEN')
      await expectServiceError(startAiRetroSession(tx, { userId: viewer.id }, project.id, at(0)), 'FORBIDDEN')
      await expectServiceError(getAiRetroState(tx, { userId: stranger.id }, project.id, at(0)), 'NOT_FOUND')
      await expectServiceError(setAiRetroOptIn(tx, { userId: stranger.id }, project.id, { enabled: true }, at(0)), 'NOT_FOUND')

      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.projectId, project.id), eq(auditEvents.action, 'ai_retro.opt_in')))
      expect(audits.map((a) => [a.actorId, a.metadata])).toEqual([[owner.id, {}]])
    })
  })

  it('interview turns: fixed first question, adaptive follow-ups, at least three questions, then structured drafts; transcript is cleared', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx)
      const actor = { userId: owner.id }
      await setAiRetroOptIn(tx, actor, project.id, { enabled: true }, at(0))
      const started = await startAiRetroSession(tx, actor, project.id, at(0))
      expect(started.session).toMatchObject({ status: 'active', questionCount: 1, turns: [{ q: AI_RETRO_FIRST_QUESTION, a: null }] })
      expect(fake.calls).toHaveLength(0)
      // 다시 시작해도 같은 세션입니다.
      expect((await startAiRetroSession(tx, actor, project.id, at(0))).session!.id).toBe(started.session!.id)

      fake.queue({ data: { finish: false, next_question: '  그걸 어떻게 풀었어요?  ' } })
      const second = await answerAiRetro(tx, actor, project.id, { questionNo: 1, answer: ' CORS 오류로 반나절 ' }, at(1))
      expect(second.session).toMatchObject({ questionCount: 2, turns: [{ q: AI_RETRO_FIRST_QUESTION, a: 'CORS 오류로 반나절' }, { q: '그걸 어떻게 풀었어요?', a: null }] })
      expect(fake.calls[0]).toMatchObject({ feature: 'retro_interview.turn', system: TURN_SYSTEM_PROMPT, effort: 'medium', maxTokens: 4096 })

      // 질문 2개에서 AI가 끝내자고 해도 3개까지는 묻습니다(빈 질문이면 고정 꼬리 질문).
      fake.queue({ data: { finish: true, next_question: '' } })
      const third = await answerAiRetro(tx, actor, project.id, { questionNo: 2, answer: '프록시를 설정했어요' }, at(2))
      expect(third.session!.questionCount).toBe(3)
      expect(third.session!.turns.at(-1)!.q).toMatch(/결정/)

      // 낡은 질문 번호는 409(AI 호출 없음).
      const before = fake.calls.length
      await expectServiceError(answerAiRetro(tx, actor, project.id, { questionNo: 2, answer: '다시' }, at(3)), 'CONFLICT', 'stale_question')
      expect(fake.calls).toHaveLength(before)

      fake.queue({ data: { finish: true, next_question: '' } }, { data: { drafts: [STUCK_DRAFT, DECISION_DRAFT, BAD_DECISION_DRAFT] } })
      const drafted = await answerAiRetro(tx, actor, project.id, { questionNo: 3, answer: '세션 쿠키를 골랐어요' }, at(3))
      expect(fake.calls.at(-1)).toMatchObject({ feature: 'retro_interview.drafts', system: DRAFT_SYSTEM_PROMPT, maxTokens: 16000 })
      expect(drafted.session).toMatchObject({ status: 'drafted', turns: [], questionCount: 3 })
      // 로그 검증을 못 넘는 초안(선택지 1개)은 버리고, 막힘의 "답 아님" 확인은 학생이 직접 하도록 false.
      expect(drafted.drafts.map((d) => d.tag)).toEqual(['stuck', 'decision'])
      expect(drafted.drafts[0]!.payload).toEqual({ symptom: 'CORS 오류로 로그인 요청이 막힘', keywords: ['CORS', 'preflight'], attempts: ['프록시 설정'], timeBucket: 'half_day', answerCheck: false })
      const row = await sessionRow(tx, project.id, owner.id)
      expect(row!.transcript).toEqual([])
      expect(await logCount(tx, project.id)).toBe(0)
      // 초안이 남아 있으면 새 인터뷰는 409.
      await expectServiceError(startAiRetroSession(tx, actor, project.id, at(4)), 'CONFLICT', 'drafts_pending')
    })
  })

  it('caps the interview at five questions and lets the student finish early', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project } = await team(tx)
      const actor = { userId: owner.id }
      await setAiRetroOptIn(tx, actor, project.id, { enabled: true }, at(0))
      await startAiRetroSession(tx, actor, project.id, at(0))
      fake.respond = (call) => (call.feature === 'retro_interview.turn' ? { data: { finish: false, next_question: '더 말해 주세요?' } } : { data: { drafts: [] } })
      for (let n = 1; n <= 4; n++) await answerAiRetro(tx, actor, project.id, { questionNo: n, answer: `답 ${n}` }, at(n))
      expect((await getAiRetroState(tx, actor, project.id, at(5))).session!.questionCount).toBe(5)
      const turnsBefore = fake.calls.filter((c) => c.feature === 'retro_interview.turn').length
      // 5번째 답 뒤에는 질문 없이 바로 초안. 초안이 없으면 세션을 지우고 noDrafts.
      const done = await answerAiRetro(tx, actor, project.id, { questionNo: 5, answer: '답 5' }, at(6))
      expect(fake.calls.filter((c) => c.feature === 'retro_interview.turn')).toHaveLength(turnsBefore)
      expect(done).toMatchObject({ noDrafts: true, session: null, drafts: [] })
      expect(await sessionRow(tx, project.id, owner.id)).toBeNull()

      // 일찍 끝내기: 답 없이 "여기까지 정리"(답하지 않은 마지막 질문은 버림).
      const ed = { userId: editor.id }
      await setAiRetroOptIn(tx, ed, project.id, { enabled: true }, at(0))
      await startAiRetroSession(tx, ed, project.id, at(0))
      await expectServiceError(answerAiRetro(tx, ed, project.id, { questionNo: 1, finish: true }, at(1)), 'VALIDATION')
      await expectServiceError(answerAiRetro(tx, ed, project.id, { questionNo: 1 }, at(1)), 'VALIDATION')
      fake.respond = null
      fake.queue({ data: { drafts: [STUCK_DRAFT] } })
      const early = await answerAiRetro(tx, ed, project.id, { questionNo: 1, answer: 'CORS 때문에 막혔어요', finish: true }, at(2))
      expect(early.drafts.map((d) => d.tag)).toEqual(['stuck'])
      const last = fake.calls.at(-1)!
      expect(last.feature).toBe('retro_interview.drafts')
      expect(last.messages[0]!.text).toContain('CORS 때문에 막혔어요')

      const [event] = await tx.select().from(analyticsEvents).where(and(eq(analyticsEvents.name, 'ai_retro_drafts_proposed'), eq(analyticsEvents.actorHash, hashSubject(analyticsPepper()!, editor.id))))
      expect(event!.props).toEqual({ drafts: 1, questions: 1, endedEarly: true })
    })
  })

  it('sends only this student’s data from this project (planted markers from teammates and other projects never reach the provider)', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project } = await team(tx)
      const actor = { userId: owner.id }
      // 내 것(보내도 됨)
      await createLog(tx, actor, project.id, { tag: 'progress', body: 'OWN-LOG-SUMMARY 로그인 화면' }, at(0))
      await saveMyCheckin(tx, actor, project.id, { timeBucket: 'lt5h', difficulty: 4, note: 'OWN-CHECKIN-NOTE' }, at(0))
      // 팀원 것(보내면 안 됨)
      await createLog(tx, { userId: editor.id }, project.id, { tag: 'stuck', payload: { symptom: 'MARKER-TEAMMATE-LOG', timeBucket: 'lt2h' } }, at(0))
      await saveMyCheckin(tx, { userId: editor.id }, project.id, { timeBucket: 'lt2h', difficulty: 2, note: 'MARKER-TEAMMATE-CHECKIN' }, at(0))
      // 내 다른 과제(보내면 안 됨)
      const mine2 = await createProject(tx, actor, { title: 'MARKER-OTHER-PROJECT-TITLE', kind: 'individual' })
      await createLog(tx, actor, mine2.id, { tag: 'progress', body: 'MARKER-OTHER-PROJECT-LOG' }, at(0))
      await saveMyCheckin(tx, actor, mine2.id, { timeBucket: 'lt2h', difficulty: 1, note: 'MARKER-OTHER-PROJECT-CHECKIN' }, at(0))
      // 다른 팀 과제(보내면 안 됨)
      const outsider = await createUser(tx, { displayName: 'MARKER-OUTSIDER-NAME' })
      const foreign = await createProject(tx, { userId: outsider.id }, { title: 'MARKER-OTHER-TEAM', kind: 'team' })
      await createLog(tx, { userId: outsider.id }, foreign.id, { tag: 'progress', body: 'MARKER-OTHER-TEAM-LOG' }, at(0))
      // 다른 팀원의 진행 중 인터뷰(보내면 안 됨)
      await setAiRetroOptIn(tx, { userId: editor.id }, project.id, { enabled: true }, at(0))
      await startAiRetroSession(tx, { userId: editor.id }, project.id, at(0))
      fake.queue({ data: { finish: false, next_question: 'Q2?' } })
      await answerAiRetro(tx, { userId: editor.id }, project.id, { questionNo: 1, answer: 'MARKER-TEAMMATE-ANSWER' }, at(1))
      const editorCalls = fake.calls.length

      await interviewToDrafts(tx, fake, actor, project.id)
      const mineSent = fake.calls
        .slice(editorCalls)
        .map((c) => [c.system, ...c.messages.map((m) => m.text)].join('\n'))
        .join('\n')
      expect(mineSent).toContain('캡스톤 디자인 AI팀')
      expect(mineSent).toContain('OWN-LOG-SUMMARY')
      expect(mineSent).toContain('OWN-CHECKIN-NOTE')
      expect(mineSent).toContain('CORS 오류로 반나절 막혔어요')
      for (const marker of [
        'MARKER-TEAMMATE-LOG',
        'MARKER-TEAMMATE-CHECKIN',
        'MARKER-TEAMMATE-ANSWER',
        'MARKER-OTHER-PROJECT',
        'MARKER-OTHER-TEAM',
        'MARKER-OUTSIDER-NAME',
        '이편집',
        owner.id,
        owner.email,
        project.id,
      ]) {
        expect(mineSent).not.toContain(marker)
      }
      // 사용자 id·날짜 같은 요청마다 바뀌는 값은 고정 system 프롬프트에 없습니다(캐시 유지).
      for (const call of fake.calls) expect([TURN_SYSTEM_PROMPT, DRAFT_SYSTEM_PROMPT]).toContain(call.system)
    })
  })

  it('drafts are invisible to teammates; approval writes a log with the AI 초안 marker that reaches the publication snapshot', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project } = await team(tx)
      const actor = { userId: owner.id }
      const state = await interviewToDrafts(tx, fake, actor, project.id)
      const [stuck, decision] = state.drafts

      // 팀원: 상태에 초안이 없고, 초안 id로 승인·버리기도 404.
      expect((await getAiRetroState(tx, { userId: editor.id }, project.id, at(4))).drafts).toEqual([])
      await expectServiceError(approveAiRetroDraft(tx, { userId: editor.id }, project.id, stuck!.id, {}, at(4)), 'NOT_FOUND')
      await expectServiceError(discardAiRetroDraft(tx, { userId: editor.id }, project.id, stuck!.id, at(4)), 'NOT_FOUND')
      // 다른 과제 경로로도 404.
      const other = await createProject(tx, actor, { title: '다른 과제', kind: 'individual' })
      await expectServiceError(approveAiRetroDraft(tx, actor, other.id, stuck!.id, {}, at(4)), 'NOT_FOUND')

      // 검증 실패(422)면 아무것도 쓰지 않고 초안은 남습니다.
      await expectServiceError(approveAiRetroDraft(tx, actor, project.id, stuck!.id, { payload: { symptom: '' } }, at(4)), 'VALIDATION')
      expect(await logCount(tx, project.id)).toBe(0)

      // 고쳐서 승인(태그는 초안 것으로 고정).
      const approved = await approveAiRetroDraft(
        tx,
        actor,
        project.id,
        stuck!.id,
        { tag: 'progress', body: '프록시로 해결 전까지의 기록', payload: { ...stuck!.payload, answerCheck: true } },
        at(5),
      )
      expect(approved.log).toMatchObject({ tag: 'stuck', source: 'ai', body: '프록시로 해결 전까지의 기록', payload: { answerCheck: true } })
      expect(approved.state.drafts.map((d) => d.id)).toEqual([decision!.id])
      const [revision] = await tx.select().from(logRevisions).where(eq(logRevisions.logEntryId, approved.log.id))
      expect(revision).toMatchObject({ aiGenerated: true, approvedAt: at(5), revisionNo: 1 })
      // 팀원도 로그(작성자·AI 초안 출처)를 봅니다.
      expect(await getLog(tx, { userId: editor.id }, approved.log.id)).toMatchObject({ source: 'ai', author: { userId: owner.id } })
      // 같은 초안을 다시 승인할 수 없습니다(행이 지워짐).
      await expectServiceError(approveAiRetroDraft(tx, actor, project.id, stuck!.id, {}, at(6)), 'NOT_FOUND')

      // 버리기: 로그를 쓰지 않고, 마지막 초안이면 세션도 지웁니다.
      const after = await discardAiRetroDraft(tx, actor, project.id, decision!.id, at(6))
      expect(after).toMatchObject({ session: null, drafts: [] })
      expect(await logCount(tx, project.id)).toBe(1)
      expect(await sessionRow(tx, project.id, owner.id)).toBeNull()

      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.projectId, project.id))
      const ai = audits.filter((a) => a.action.startsWith('ai_retro.'))
      expect(ai.map((a) => [a.action, a.metadata])).toEqual(
        expect.arrayContaining([
          ['ai_retro.draft_approve', { tag: 'stuck', edited: true }],
          ['ai_retro.draft_discard', { tag: 'decision' }],
        ]),
      )
      expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain('CORS')
      const events = await tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(analyticsPepper()!, owner.id)))
      expect(events.filter((e) => e.name === 'ai_retro_draft_resolved').map((e) => e.props)).toEqual(
        expect.arrayContaining([
          { decision: 'approved', tag: 'stuck', edited: true },
          { decision: 'discarded', tag: 'decision', edited: false },
        ]),
      )
      expect(events.find((e) => e.name === 'log_saved')!.props).toMatchObject({ tag: 'stuck', source: 'ai' })

      // 공개 스냅샷에도 출처 `ai`(화면 라벨 `AI 초안`)가 그대로 옮겨집니다.
      const candidate = await createCandidate(
        tx,
        actor,
        project.id,
        { level: 'full', title: '제목', summary: '요약', slug: `ai-${crypto.randomUUID().slice(0, 8)}`, logIds: [approved.log.id], exposure: { [owner.id]: 'name' }, consentSelf: true },
        at(7),
        { privateOrigins: ['http://localhost:3000'] },
      )
      const preview = await previewCandidate(tx, actor, candidate.id)
      expect(preview.snapshot.logs.map((l) => l.source)).toEqual(['ai'])
    })
  })

  it('analytics respect opt-out', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx)
      await tx.update(users).set({ analyticsOptOut: true }).where(eq(users.id, owner.id))
      const state = await interviewToDrafts(tx, fake, { userId: owner.id }, project.id)
      await approveAiRetroDraft(tx, { userId: owner.id }, project.id, state.drafts[0]!.id, {}, at(5))
      // 거부하기 전에 남은 과제 만들기 이벤트만 있고, 인터뷰·초안·로그 이벤트는 없습니다.
      const events = await tx.select().from(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(analyticsPepper()!, owner.id)))
      expect(events.map((e) => e.name)).toEqual(['project_created'])
    })
  })

  it('refusal, max_tokens and provider errors become 503 without content and persist nothing; usage counts tokens only', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx)
      const actor = { userId: owner.id }
      await setAiRetroOptIn(tx, actor, project.id, { enabled: true }, at(0))
      await startAiRetroSession(tx, actor, project.id, at(0))
      const usage = { inputTokens: 300, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
      const cases: Array<[AiError, string]> = [
        [new AiError('refusal', null, usage, 'cyber'), 'ai_declined'],
        [new AiError('max_tokens', null, usage), 'ai_unavailable'],
        [new AiError('invalid_output', null, usage), 'ai_unavailable'],
        [new AiError('rate_limited', 429), 'ai_unavailable'],
        [new AiError('unavailable', 529), 'ai_unavailable'],
      ]
      for (const [error, reason] of cases) {
        fake.queue({ error })
        const thrown = await expectServiceError(answerAiRetro(tx, actor, project.id, { questionNo: 1, answer: 'SECRET-ANSWER' }, at(1)), 'UNAVAILABLE', reason)
        expect(JSON.stringify({ ...thrown, message: thrown.message })).not.toContain('SECRET')
      }
      // 스키마에 맞지 않는 초안(태그 solution)도 503.
      fake.queue({ data: { drafts: [{ ...STUCK_DRAFT, tag: 'solution' }] } })
      await expectServiceError(answerAiRetro(tx, actor, project.id, { questionNo: 1, answer: 'x', finish: true }, at(1)), 'UNAVAILABLE', 'ai_unavailable')

      const row = await sessionRow(tx, project.id, owner.id)
      expect(row).toMatchObject({ status: 'active', questionCount: 1, transcript: [{ q: AI_RETRO_FIRST_QUESTION, a: null }] })
      const [turn] = await tx.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.day, '2026-10-20'), eq(aiUsageDaily.feature, 'retro_interview.turn')))
      expect(turn).toMatchObject({ model: 'fake-claude', requests: 5, refusals: 1, failures: 4, inputTokens: 900, outputTokens: 60 })
      // 사용량 행에는 사람·과제·내용이 없습니다.
      expect(Object.keys(turn!).sort()).toEqual(['cacheCreationTokens', 'cacheReadTokens', 'day', 'failures', 'fallbacks', 'feature', 'inputTokens', 'model', 'outputTokens', 'refusals', 'requests'])

      // 실패 뒤에도 같은 답으로 다시 시도할 수 있습니다.
      fake.queue({ data: { finish: false, next_question: 'Q2?' }, usage: { inputTokens: 10, outputTokens: 5 }, fallback: true })
      expect((await answerAiRetro(tx, actor, project.id, { questionNo: 1, answer: '다시' }, at(2))).session!.questionCount).toBe(2)
      const [after] = await tx.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.day, '2026-10-20'), eq(aiUsageDaily.feature, 'retro_interview.turn')))
      expect(after).toMatchObject({ requests: 6, fallbacks: 1, inputTokens: 910 })
    })
  })

  it('cost guard: per-user daily requests, global daily requests and global daily tokens (429 before calling the provider)', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project } = await team(tx)
      setAiEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_AI_USER_DAILY_REQUESTS: '2', PEERCHIVE_AI_GLOBAL_DAILY_REQUESTS: '3', PEERCHIVE_AI_GLOBAL_DAILY_TOKENS: '0' })
      fake.respond = () => ({ data: { finish: false, next_question: '다음?' } })
      for (const user of [owner, editor]) {
        await setAiRetroOptIn(tx, { userId: user.id }, project.id, { enabled: true }, at(0))
        await startAiRetroSession(tx, { userId: user.id }, project.id, at(0))
      }
      const o = { userId: owner.id }
      await answerAiRetro(tx, o, project.id, { questionNo: 1, answer: 'a' }, at(1))
      await answerAiRetro(tx, o, project.id, { questionNo: 2, answer: 'b' }, at(2))
      await expectServiceError(answerAiRetro(tx, o, project.id, { questionNo: 3, answer: 'c' }, at(3)), 'RATE_LIMITED')
      expect(fake.calls).toHaveLength(2)
      // 서버 전체 3회: 팀원은 한 번 더 되고 그다음은 막힘.
      const e = { userId: editor.id }
      await answerAiRetro(tx, e, project.id, { questionNo: 1, answer: 'a' }, at(4))
      await expectServiceError(answerAiRetro(tx, e, project.id, { questionNo: 2, answer: 'b' }, at(5)), 'RATE_LIMITED')
      expect(fake.calls).toHaveLength(3)
      // 다음 날(UTC)은 다시 됩니다.
      expect((await answerAiRetro(tx, o, project.id, { questionNo: 3, answer: 'c' }, new Date(T0.getTime() + days(1)))).session!.questionCount).toBe(4)

      // 하루 토큰 상한: 오늘 합계가 상한 이상이면 막힘.
      setAiEnvForTesting({ NODE_ENV: 'test', PEERCHIVE_AI_GLOBAL_DAILY_TOKENS: '1000' })
      const nextDay = new Date(T0.getTime() + days(2))
      await tx.insert(aiUsageDaily).values({ day: nextDay.toISOString().slice(0, 10), feature: 'other', model: 'm', requests: 1, inputTokens: 900, outputTokens: 100 })
      await expectServiceError(answerAiRetro(tx, e, project.id, { questionNo: 2, answer: 'b' }, nextDay), 'RATE_LIMITED')
      expect(fake.calls).toHaveLength(4)
    })
  })

  it('transcripts and drafts expire after seven days; turning AI off deletes the session and drafts', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project } = await team(tx)
      const actor = { userId: owner.id }
      await interviewToDrafts(tx, fake, actor, project.id)
      expect((await getAiRetroState(tx, actor, project.id, new Date(T0.getTime() + days(6)))).drafts).toHaveLength(2)
      const expired = await getAiRetroState(tx, actor, project.id, new Date(T0.getTime() + days(7) + minutes(1)))
      expect(expired).toMatchObject({ session: null, drafts: [] })
      expect(await sessionRow(tx, project.id, owner.id)).toBeNull()
      expect(await tx.select().from(aiRetroDrafts).where(eq(aiRetroDrafts.userId, owner.id))).toEqual([])

      // 끄기: 진행 중 세션·초안 삭제, 켜기 행 삭제.
      const ed = { userId: editor.id }
      await interviewToDrafts(tx, fake, ed, project.id)
      const off = await setAiRetroOptIn(tx, ed, project.id, { enabled: false }, at(10))
      expect(off).toMatchObject({ optedIn: false, session: null, drafts: [] })
      expect(await sessionRow(tx, project.id, editor.id)).toBeNull()
      expect(await tx.select().from(aiRetroOptIns).where(eq(aiRetroOptIns.userId, editor.id))).toEqual([])
      expect(await logCount(tx, project.id)).toBe(0)
      const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'ai_retro.opt_out'), eq(auditEvents.actorId, editor.id)))
      expect(audit!.metadata).toEqual({ session: true, drafts: 2 })
    })
  })

  it('discarding the whole session writes nothing', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx)
      const actor = { userId: owner.id }
      await interviewToDrafts(tx, fake, actor, project.id)
      expect(await discardAiRetroSession(tx, actor, project.id, at(5))).toMatchObject({ optedIn: true, session: null, drafts: [] })
      expect(await logCount(tx, project.id)).toBe(0)
      await expectServiceError(discardAiRetroSession(tx, actor, project.id, at(6)), 'NOT_FOUND')
      // 새 인터뷰를 다시 시작할 수 있습니다.
      expect((await startAiRetroSession(tx, actor, project.id, at(7))).session!.questionCount).toBe(1)
    })
  })

  // ADR 0060 D-10: 팀을 나가거나 내보내지면 그 사람의 그 과제 AI 회고 자료는 같은 트랜잭션에서 지웁니다.
  it('leaving or being removed deletes that member’s retro session, drafts and opt-in for that project only', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project } = await team(tx)
      const other = await createProject(tx, { userId: editor.id }, { title: '다른 과제', kind: 'individual' })
      const rows = async (table: typeof aiRetroOptIns | typeof aiRetroSessions | typeof aiRetroDrafts, userId: string, projectId: string) =>
        (await tx.select().from(table).where(and(eq(table.userId, userId), eq(table.projectId, projectId)))).length
      // 나가는 사람: 초안까지 있는 세션. 남는 사람·다른 과제의 행은 그대로.
      await interviewToDrafts(tx, fake, { userId: editor.id }, project.id)
      await setAiRetroOptIn(tx, { userId: owner.id }, project.id, { enabled: true }, at(0))
      await startAiRetroSession(tx, { userId: owner.id }, project.id, at(0))
      await setAiRetroOptIn(tx, { userId: editor.id }, other.id, { enabled: true }, at(0))
      for (const table of [aiRetroOptIns, aiRetroSessions, aiRetroDrafts]) expect(await rows(table, editor.id, project.id)).toBeGreaterThan(0)

      await leaveProject(tx, { userId: editor.id }, project.id)
      for (const table of [aiRetroOptIns, aiRetroSessions, aiRetroDrafts]) expect(await rows(table, editor.id, project.id)).toBe(0)
      expect(await rows(aiRetroOptIns, editor.id, other.id)).toBe(1)
      expect(await rows(aiRetroOptIns, owner.id, project.id)).toBe(1)
      expect(await rows(aiRetroSessions, owner.id, project.id)).toBe(1)

      // 내보내기도 같습니다.
      const removed = await createUser(tx, { displayName: '내보낼사람' })
      const { token } = await createInvitation(tx, { userId: owner.id }, project.id, { role: 'editor' }, at(0))
      await acceptInvitation(tx, { userId: removed.id }, { token }, at(0))
      await setAiRetroOptIn(tx, { userId: removed.id }, project.id, { enabled: true }, at(0))
      await startAiRetroSession(tx, { userId: removed.id }, project.id, at(0))
      await removeMember(tx, { userId: owner.id }, project.id, removed.id)
      expect(await rows(aiRetroOptIns, removed.id, project.id)).toBe(0)
      expect(await rows(aiRetroSessions, removed.id, project.id)).toBe(0)
    })
  })

  it('service errors carry only short codes', () => {
    const error = new ServiceError('UNAVAILABLE', 'ai_unavailable')
    expect(error.message).toBe('UNAVAILABLE: ai_unavailable')
  })
})
