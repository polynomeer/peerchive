/**
 * E-06 면접 준비 팩 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * - 질문은 케이스가 인용한 결정·회의·막힘 로그에서 만들고(근거 kind·key), 일반 질문(실패·의견 충돌·다시 한다면)을 더합니다.
 * - 답변 메모는 작성자만 봅니다: 다른 사용자(404), 공개 프로필 JSON(HTTP)·README 카드·검색 문서·판 미리보기 어디에도 없음.
 *   인쇄 보기와 공개 HTML은 같은 공개 JSON만 그리므로 브라우저 쪽은 apps/e2e e06-interview-prep.spec.ts가 봅니다.
 * - 공개로 고른 질문은 실명 페르소나의 대표 케이스가 지금 볼 수 있을 때만 보이고, 게시 취소·숨김·철회 뒤 다음 요청부터 사라집니다.
 * - 케이스를 고쳐 질문이 사라지면 메모는 "보관된 메모"로 남고(공개 안 됨), 인용을 되돌리면 같은 키의 메모가 다시 붙습니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import { auditEvents, caseStudies, eq, interviewPrepEntries, searchDocuments, type DbExecutor } from '@peerchive/db'
import { createLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate, decideConsent } from '../server/modules/publication/candidates'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { createCaseStudy, publishCaseStudy, unpublishCaseStudy, updateCaseStudy } from '../server/modules/portfolio/case-studies'
import { createEdition, previewEdition } from '../server/modules/portfolio/editions'
import { getInterviewPrep, saveInterviewPrep } from '../server/modules/portfolio/interview-prep'
import { createPublicProfileHandler, createReadmeCardHandler } from '../server/modules/portfolio/public-http'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { createDisplayPersona } from '../server/modules/social/personas'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'
import type { CaseStudyDto, PublicCaseStudyDto } from '../shared/types/api'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const NOTE = 'ZZPRIVATEANSWERNOTEZZ'
const tag = () => crypto.randomUUID().slice(0, 8)

/** owner(이름 공개) + 팀원(익명) 팀 과제: 결정(선택지·지나고 보니)·막힘(+팀원의 해결)·회의를 공개하고 게시합니다. */
async function publishedTeamCase(db: DbExecutor) {
  const ownerHandle = `ip-${tag()}`
  const owner = await createUser(db, { displayName: '김지민', handle: ownerHandle })
  const member = await createUser(db, { displayName: '박익명', handle: `ip-${tag()}` })
  const outsider = await createUser(db, { displayName: '외부인', handle: `ip-${tag()}` })
  const A = { userId: owner.id }
  const B = { userId: member.id }
  const project = await createProject(db, A, { title: '면접 준비 과제', kind: 'team' }, T0)
  const { token } = await createInvitation(db, A, project.id, { role: 'editor' }, T0)
  await acceptInvitation(db, B, { token }, T0)
  const decision = (
    await createLog(db, A, project.id, {
      tag: 'decision',
      payload: { options: ['실시간 센서', '수동 입력'], criteria: '예산', choice: '수동 입력', hindsight: '센서 시범 운영도 해 볼 걸' },
    }, at(1))
  ).log
  const stuck = (await createLog(db, A, project.id, { tag: 'stuck', payload: { symptom: 'CORS 에러로 API 호출 실패', keywords: ['cors'], attempts: [], timeBucket: 'half_day' } }, at(2))).log
  const solution = (
    await createLog(db, B, project.id, { tag: 'solution', payload: { method: '서버 응답 헤더 추가', notAnswerConfirmed: true }, resolvesEntryId: stuck.id }, at(3))
  ).log
  const meeting = (
    await createLog(db, B, project.id, { tag: 'meeting', payload: { attendees: [owner.id, member.id], decisions: ['수동 입력으로 범위 조정'], followUps: [] } }, at(4))
  ).log
  const slug = `ip-${tag()}`
  const candidate = await createCandidate(
    db,
    A,
    project.id,
    {
      level: 'summary',
      title: '도서관 혼잡도 웹앱',
      summary: '실시간 센서 대신 수동 입력으로 범위를 조정했다.',
      slug,
      logIds: [decision.id, stuck.id, solution.id, meeting.id],
      exposure: { [owner.id]: 'name', [member.id]: 'anonymous' },
      consentSelf: true,
    },
    at(5),
    ORIGINS,
  )
  await decideConsent(db, B, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(6))
  const published = await publishCandidate(db, A, candidate.id, { manifestHash: candidate.manifestHash }, at(7))
  return { owner, member, outsider, ownerHandle, A, B, slug, publication: published.publication }
}

const editable = (dto: CaseStudyDto) =>
  dto.sections.map((s) => ({ key: s.key, sentences: s.sentences.map((x) => ({ text: x.text, kind: x.kind, citations: x.citations.map(({ releaseVersion, kind, key }) => ({ releaseVersion, kind, key })) })) }))

/** 게시한 케이스 + 그것을 대표로 둔 실명 판. 결정·막힘 로그 키도 돌려줍니다. */
async function featuredCase(tx: DbExecutor) {
  const f = await publishedTeamCase(tx)
  const draft = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(20))
  const cs = await publishCaseStudy(tx, f.A, draft.id, { expectedVersion: draft.version, confirmWarnings: true }, at(21))
  await createEdition(tx, f.A, { featuredCaseStudyIds: [cs.id] }, at(22))
  const keyOf = (t: string) => cs.snapshot!.logs.find((l) => l.tag === t)!.key
  return { f, cs, keys: { decision: keyOf('decision'), stuck: keyOf('stuck'), meeting: keyOf('meeting') } }
}

const asked = (c: PublicCaseStudyDto | undefined) => (c && c.available ? c.askQuestions : [])

async function publicBodies(db: DbExecutor, handle: string, now: Date): Promise<string> {
  const deps = { getDb: () => db, now: () => now, getEnv: () => ({}) }
  const app = createApp()
  app.use(
    createRouter()
      .get('/api/v1/public/profiles/:handle', createPublicProfileHandler(deps))
      .get('/api/v1/public/profiles/:handle/readme-card.md', createReadmeCardHandler({ ...deps, getOrigin: () => 'https://peerchive.test' })),
  )
  const web = toWebHandler(app)
  const out: string[] = []
  for (const path of [`/api/v1/public/profiles/${handle}`, `/api/v1/public/profiles/${handle}/readme-card.md`]) {
    const res = await web(new Request(`http://localhost:3000${path}`))
    expect(res.status, path).toBe(200)
    out.push(await res.text())
  }
  return out.join('\n')
}

describe.skipIf(!databaseUrl)('interview prep pack (E-06, PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('generates questions from the cited decision, meeting and stuck logs plus generic ones, owner only', async () => {
    await withRollback(async (tx) => {
      const { f, cs, keys } = await featuredCase(tx)
      const pack = await getInterviewPrep(tx, f.A, cs.id, at(23))
      expect(pack).toMatchObject({ caseStudyId: cs.id, generator: 'template', available: true, publiclyVisible: true, archived: [] })
      expect(pack.questions.map((q) => q.key)).toEqual([
        `decision:${keys.decision}`,
        `hindsight:${keys.decision}`,
        `stuck:${keys.stuck}`,
        `meeting:${keys.meeting}`,
        'generic:failure',
        'generic:conflict',
        'generic:retro',
      ])
      const decision = pack.questions[0]!
      expect(decision).toMatchObject({
        category: 'decision',
        categoryLabel: '결정',
        text: '왜 실시간 센서 대신 수동 입력을 택했나요?',
        source: { kind: 'log', key: keys.decision, path: `/p/${f.slug}#public-${keys.decision}` },
        note: null,
        shown: false,
      })
      expect(decision.source!.label).toContain('수동 입력')
      expect(pack.questions.find((q) => q.key === `stuck:${keys.stuck}`)!.text).toBe(
        '"CORS 에러로 API 호출 실패" 문제의 원인을 어떻게 찾았나요? 다시 겪는다면 무엇부터 확인하겠나요?',
      )
      expect(pack.questions.filter((q) => q.key.startsWith('generic:')).every((q) => q.source === null)).toBe(true)

      // 다른 사람(같은 공개의 팀원 포함)에게는 존재를 드러내지 않습니다.
      for (const actor of [{ userId: f.outsider.id }, f.B]) {
        await expectServiceError(getInterviewPrep(tx, actor, cs.id, at(23)), 'NOT_FOUND')
        await expectServiceError(saveInterviewPrep(tx, actor, cs.id, { questionKey: 'generic:failure', note: 'x' }, at(23)), 'NOT_FOUND')
      }
      await expectServiceError(saveInterviewPrep(tx, f.A, cs.id, { questionKey: 'stuck:l_nope', shown: true }, at(23)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ questionKey: 'not_current' }),
      )
      await expectServiceError(saveInterviewPrep(tx, f.A, cs.id, { questionKey: 'free text', note: 'x' }, at(23)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ questionKey: 'invalid' }),
      )
      await expectServiceError(saveInterviewPrep(tx, f.A, cs.id, { questionKey: 'generic:failure', note: '가'.repeat(2001) }, at(23)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ note: 'too_long' }),
      )
    })
  })

  it('keeps answer notes private and shows only chosen question text while the case is live', async () => {
    await withRollback(async (tx) => {
      const { f, cs, keys } = await featuredCase(tx)
      await saveInterviewPrep(tx, f.A, cs.id, { questionKey: `decision:${keys.decision}`, note: `예산 때문에 ${NOTE}`, shown: true }, at(23))
      await saveInterviewPrep(tx, f.A, cs.id, { questionKey: `stuck:${keys.stuck}`, shown: true }, at(23))
      const pack = await saveInterviewPrep(tx, f.A, cs.id, { questionKey: 'generic:failure', note: `실패 메모 ${NOTE}` }, at(23))
      expect(pack.questions.filter((q) => q.shown).map((q) => q.key)).toEqual([`decision:${keys.decision}`, `stuck:${keys.stuck}`])
      expect(pack.questions.find((q) => q.key === 'generic:failure')).toMatchObject({ note: `실패 메모 ${NOTE}`, shown: false })
      // 공개 선택만 감사 기록(메모 글 없음).
      const audits = (await tx.select().from(auditEvents).where(eq(auditEvents.action, 'interview_prep.shown_toggle'))).filter((a) => a.targetId === cs.id)
      expect(audits).toHaveLength(2)
      expect(JSON.stringify(audits)).not.toContain(NOTE)

      const profile = await getPublicPortfolioProfile(tx, f.ownerHandle, at(24))
      expect(asked(profile.featured[0])).toEqual([
        { text: '왜 실시간 센서 대신 수동 입력을 택했나요?', categoryLabel: '결정', source: { label: expect.stringContaining('수동 입력'), path: `/p/${f.slug}#public-${keys.decision}` } },
        { text: expect.stringContaining('CORS 에러로 API 호출 실패'), categoryLabel: '막힘', source: expect.objectContaining({ path: `/p/${f.slug}#public-${keys.stuck}` }) },
      ])
      const bodies = await publicBodies(tx, f.ownerHandle, at(24))
      expect(bodies).toContain('왜 실시간 센서 대신 수동 입력을 택했나요?')
      expect(bodies).not.toContain(NOTE)
      const preview = await previewEdition(tx, f.A, { featuredCaseStudyIds: [cs.id] }, at(24))
      expect(asked(preview.featured[0])).toHaveLength(2)
      expect(JSON.stringify(preview)).not.toContain(NOTE)
      const search = await tx.select().from(searchDocuments).where(eq(searchDocuments.publicationId, f.publication.id))
      expect(JSON.stringify(search)).not.toContain(NOTE)

      // 게시 취소 → 다음 요청부터 질문 없음, 다시 게시하면 돌아옴.
      const off = await unpublishCaseStudy(tx, f.A, cs.id, at(25))
      expect(JSON.stringify(await getPublicPortfolioProfile(tx, f.ownerHandle, at(25)))).not.toContain('왜 실시간 센서')
      expect((await getInterviewPrep(tx, f.A, cs.id, at(25))).publiclyVisible).toBe(false)
      await publishCaseStudy(tx, f.A, cs.id, { expectedVersion: off.version, confirmWarnings: true }, at(26))
      expect(asked((await getPublicPortfolioProfile(tx, f.ownerHandle, at(26))).featured[0])).toHaveLength(2)

      // 운영 조치로 숨김 → 사라짐.
      await tx.update(caseStudies).set({ hiddenAt: at(27) }).where(eq(caseStudies.id, cs.id))
      expect(JSON.stringify(await getPublicPortfolioProfile(tx, f.ownerHandle, at(27)))).not.toContain('왜 실시간 센서')
      await tx.update(caseStudies).set({ hiddenAt: null }).where(eq(caseStudies.id, cs.id))

      // 원본 공개 철회 → 다음 요청부터 사라지고, 본인 팩은 질문 없이 메모를 보관된 메모로 보여 줌.
      await withdrawPublication(tx, f.A, f.publication.id, {}, at(28))
      const after = await getPublicPortfolioProfile(tx, f.ownerHandle, at(29))
      expect(after.featured[0]!.available).toBe(false)
      expect(JSON.stringify(after)).not.toContain('왜 실시간 센서')
      const closed = await getInterviewPrep(tx, f.A, cs.id, at(29))
      expect(closed).toMatchObject({ available: false, publiclyVisible: false, questions: [] })
      expect(closed.archived.map((a) => a.note ?? '(선택만)').sort()).toEqual(['(선택만)', `실패 메모 ${NOTE}`, `예산 때문에 ${NOTE}`].sort())
    })
  })

  it('never shows questions on a display persona and real-persona preview only', async () => {
    await withRollback(async (tx) => {
      const { f, cs, keys } = await featuredCase(tx)
      await saveInterviewPrep(tx, f.A, cs.id, { questionKey: `decision:${keys.decision}`, shown: true }, at(23))
      const displayHandle = `ipd-${tag()}`
      const display = await createDisplayPersona(tx, f.A, { handle: displayHandle, displayName: `밤개발${tag()}` }, at(23))
      await createEdition(tx, f.A, { personaId: display.id, headline: '표시명 판' }, at(23))
      const shown = await getPublicPortfolioProfile(tx, displayHandle, at(24))
      expect(shown.kind).toBe('display')
      expect(shown.featured).toEqual([])
      expect(await publicBodies(tx, displayHandle, at(24))).not.toContain('왜 실시간 센서')
      const displayPreview = await previewEdition(tx, f.A, { personaId: display.id }, at(24))
      expect(JSON.stringify(displayPreview)).not.toContain('왜 실시간 센서')
    })
  })

  it('keeps notes by stable question key across case edits, archives orphans privately and lets the owner delete them', async () => {
    await withRollback(async (tx) => {
      const { f, cs, keys } = await featuredCase(tx)
      const decisionKey = `decision:${keys.decision}`
      await saveInterviewPrep(tx, f.A, cs.id, { questionKey: decisionKey, note: NOTE, shown: true }, at(23))
      const full = editable(cs)
      // 결정 로그를 인용한 문장을 모두 뺍니다.
      const without = full.map((s) => ({ ...s, sentences: s.sentences.filter((x) => !x.citations.some((c) => c.key === keys.decision)) }))
      const edited = await updateCaseStudy(tx, f.A, cs.id, { expectedVersion: cs.version, sections: without }, at(24))
      const orphaned = await getInterviewPrep(tx, f.A, cs.id, at(24))
      expect(orphaned.questions.map((q) => q.key)).not.toContain(decisionKey)
      expect(orphaned.questions.map((q) => q.key)).not.toContain(`hindsight:${keys.decision}`)
      expect(orphaned.archived).toEqual([{ key: decisionKey, text: '왜 실시간 센서 대신 수동 입력을 택했나요?', note: NOTE, updatedAt: at(23).toISOString() }])
      // 보관된 질문은 공개로 고르거나 새로 쓸 수 없고, 공개 화면에도 나오지 않습니다.
      await expectServiceError(saveInterviewPrep(tx, f.A, cs.id, { questionKey: decisionKey, shown: true }, at(24)), 'VALIDATION')
      await expectServiceError(saveInterviewPrep(tx, f.A, cs.id, { questionKey: decisionKey, note: '새 글' }, at(24)), 'VALIDATION')
      const republished = await publishCaseStudy(tx, f.A, cs.id, { expectedVersion: edited.version, confirmWarnings: true }, at(25))
      expect(JSON.stringify(await getPublicPortfolioProfile(tx, f.ownerHandle, at(25)))).not.toContain('왜 실시간 센서')

      // 인용을 되돌리면 같은 키의 메모와 공개 선택이 다시 붙습니다.
      const restored = await updateCaseStudy(tx, f.A, cs.id, { expectedVersion: republished.version, sections: full }, at(26))
      const back = await getInterviewPrep(tx, f.A, cs.id, at(26))
      expect(back.questions.find((q) => q.key === decisionKey)).toMatchObject({ note: NOTE, shown: true, textChanged: false })
      expect(back.archived).toEqual([])

      // 다시 빼고 보관된 메모를 지우면 행이 없어집니다.
      await updateCaseStudy(tx, f.A, cs.id, { expectedVersion: restored.version, sections: without }, at(27))
      const cleared = await saveInterviewPrep(tx, f.A, cs.id, { questionKey: decisionKey, note: null, shown: false }, at(27))
      expect(cleared.archived).toEqual([])
      expect(await tx.select().from(interviewPrepEntries).where(eq(interviewPrepEntries.userId, f.owner.id))).toEqual([])

      // 메모도 선택도 없으면 행을 남기지 않습니다.
      await saveInterviewPrep(tx, f.A, cs.id, { questionKey: 'generic:retro', note: '회고' }, at(28))
      await saveInterviewPrep(tx, f.A, cs.id, { questionKey: 'generic:retro', note: '  ' }, at(28))
      expect(await tx.select().from(interviewPrepEntries).where(eq(interviewPrepEntries.userId, f.owner.id))).toEqual([])
    })
  })
})
