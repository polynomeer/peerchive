/**
 * E-14 AI 케이스 다듬기 통합 테스트(실제 PostgreSQL, ADR 0059). DATABASE_URL이 없으면 건너뜁니다.
 * AI는 테스트 전용 가짜 공급자(@peerchive/ai createFakeAiProvider)만 씁니다 — 네트워크 호출 없음.
 * - 보내는 근거는 케이스가 고정한 release 스냅샷(가린 항목 제외) 안의 범위뿐: 비공개 로그·다른 과제·스냅샷 속 범위 밖 팀원 기록·가린 항목·이름·id의
 *   표지 문자열이 공급자 입력에 0건.
 * - 보낸 근거에 없는 인용은 버리고 남은 인용이 없으면 uncited, 받아들여도 게시·대표 지정이 막힘.
 * - 문장마다 받아들이기/버리기, generator ai가 케이스·공개 프로필·PDF용 DTO에 남음. AI 꺼짐 404·템플릿 흐름 그대로. 거절·상한 503이면 저장 없음.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FakeAiCall, type FakeAiProvider, AiError, createFakeAiProvider } from '@peerchive/ai'
import {
  aiUsageDaily,
  and,
  auditEvents,
  caseAiPolishProposals,
  caseSentences,
  caseStudies,
  eq,
  moderationActions,
  operators,
  publications,
  releaseHiddenItems,
  type DbExecutor,
} from '@peerchive/db'
import { AI_CASE_POLISH_DAILY_LIMIT } from '@peerchive/domain'
import { setAiProviderForTesting, setAiEnvForTesting } from '../server/modules/ai/ai'
import { POLISH_SYSTEM_PROMPT, applyCasePolish, discardCasePolish, getCasePolishState, polishCaseStudy } from '../server/modules/ai/case-polish'
import { createLog } from '../server/modules/logs/logs'
import { createCaseStudy, getCaseStudy, publishCaseStudy, updateCaseStudy } from '../server/modules/portfolio/case-studies'
import { createEdition } from '../server/modules/portfolio/editions'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate, decideConsent } from '../server/modules/publication/candidates'
import { publishCandidate } from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, days, expectServiceError, minutes, withRollback } from './helpers'
import type { CaseStudyDto } from '../shared/types/api'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const tag = () => crypto.randomUUID().slice(0, 8)

/** 범위 밖 표지(공급자 입력에 나오면 안 됨). */
const MARK = {
  privateLog: 'ZZPRIVATEWORKSPACELOGZZ',
  otherTeam: 'ZZOTHERTEAMLOGZZ',
  otherMember: 'ZZOTHERMEMBERPROGRESSZZ',
  hidden: 'ZZHIDDENBYMODERATIONZZ',
}

/**
 * owner(이름 공개) + 팀원(익명) 팀 과제를 공개하고 케이스를 만듭니다. 공개에는 범위 밖 팀원 진행 로그와 나중에 가릴 owner 진행 로그가 들어가고,
 * 공개하지 않은 비공개 로그·다른 과제 로그도 있습니다.
 */
async function fixture(db: DbExecutor) {
  const handle = `cp-${tag()}`
  const owner = await createUser(db, { displayName: '김다듬', handle })
  const member = await createUser(db, { displayName: '박팀원비밀', handle: `cp-${tag()}` })
  const A = { userId: owner.id }
  const B = { userId: member.id }
  const project = await createProject(db, A, { title: '다듬기 과제 내부명', kind: 'team' }, T0)
  const { token } = await createInvitation(db, A, project.id, { role: 'editor' }, T0)
  await acceptInvitation(db, B, { token }, T0)
  const decision = (
    await createLog(db, A, project.id, { tag: 'decision', payload: { options: ['실시간 센서', '수동 입력'], criteria: '예산', choice: '수동 입력', hindsight: '센서 시범 운영도 해 볼 걸' } }, at(1))
  ).log
  const stuck = (await createLog(db, A, project.id, { tag: 'stuck', payload: { symptom: 'CORS 에러로 API 호출 실패', keywords: ['cors'], attempts: [], timeBucket: 'half_day' } }, at(2))).log
  const solution = (await createLog(db, B, project.id, { tag: 'solution', payload: { method: '서버 응답 헤더 추가', notAnswerConfirmed: true }, resolvesEntryId: stuck.id }, at(3))).log
  const meeting = (await createLog(db, B, project.id, { tag: 'meeting', payload: { attendees: [owner.id, member.id], decisions: ['수동 입력으로 범위 조정'], followUps: [] } }, at(4))).log
  const otherMember = (await createLog(db, B, project.id, { tag: 'progress', body: `${MARK.otherMember} 팀원의 진행` }, at(5))).log
  const toHide = (await createLog(db, A, project.id, { tag: 'progress', body: `${MARK.hidden} 가릴 진행` }, at(6))).log
  await createLog(db, A, project.id, { tag: 'progress', body: `${MARK.privateLog} 공개하지 않은 기록` }, at(7))
  const other = await createProject(db, A, { title: '다른 과제', kind: 'individual' }, T0)
  await createLog(db, A, other.id, { tag: 'progress', body: `${MARK.otherTeam} 다른 과제 기록` }, at(7))

  const slug = `cp-${tag()}`
  const candidate = await createCandidate(
    db,
    A,
    project.id,
    {
      level: 'summary',
      title: '도서관 혼잡도 웹앱',
      summary: '실시간 센서 대신 수동 입력으로 범위를 조정했다.',
      slug,
      logIds: [decision.id, stuck.id, solution.id, meeting.id, otherMember.id, toHide.id],
      exposure: { [owner.id]: 'name', [member.id]: 'anonymous' },
      consentSelf: true,
    },
    at(8),
    ORIGINS,
  )
  await decideConsent(db, B, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(9))
  const published = await publishCandidate(db, A, candidate.id, { manifestHash: candidate.manifestHash }, at(10))
  const cs = await createCaseStudy(db, A, { releaseSlug: slug, jobTarget: 'backend' }, at(11))
  const keyOf = (body: string) => cs.snapshot!.logs.find((l) => l.body.includes(body))!.key
  const keys = {
    decision: cs.snapshot!.logs.find((l) => l.tag === 'decision')!.key,
    meeting: cs.snapshot!.logs.find((l) => l.tag === 'meeting')!.key,
    otherMember: keyOf(MARK.otherMember),
    hidden: keyOf(MARK.hidden),
  }
  return { owner, member, A, B, handle, project, other, slug, publication: published.publication, cs, keys }
}

/** 운영 조치로 owner 진행 로그를 가립니다(T-15 테이블 직접). */
async function hideLog(db: DbExecutor, publicationId: string, key: string) {
  const op = await createUser(db, { displayName: '운영자' })
  await db.insert(operators).values({ userId: op.id })
  const [pub] = await db.select({ releaseId: publications.currentReleaseId }).from(publications).where(eq(publications.id, publicationId))
  const [action] = await db
    .insert(moderationActions)
    .values({
      kind: 'hide_item',
      outcome: 'resolved',
      targetType: 'publication_item',
      targetKey: `publication_item:${publicationId}:log:${key}`,
      publicationId,
      releaseId: pub!.releaseId!,
      itemKind: 'log',
      itemKey: key,
      internalNote: 'n',
      createdBy: op.id,
    })
    .returning()
  await db.insert(releaseHiddenItems).values({ publicationId, releaseId: pub!.releaseId!, itemKind: 'log', itemKey: key, actionId: action!.id })
}

/** 가짜 공급자 입력에서 문장 id·구역을 읽습니다. */
function sentenceIds(call: FakeAiCall): Array<{ id: string; section: string; text: string }> {
  const text = call.messages.map((m) => m.text).join('\n')
  return [...text.matchAll(/<s id="(S\d+)" section="([^"]+)" cites="[^"]*">([^<]*)<\/s>/g)].map((m) => ({ id: m[1]!, section: m[2]!, text: m[3]! }))
}

const editable = (dto: CaseStudyDto) =>
  dto.sections.map((s) => ({ key: s.key, sentences: s.sentences.map((x) => ({ text: x.text, kind: x.kind, citations: x.citations.map(({ releaseVersion, kind, key }) => ({ releaseVersion, kind, key })) })) }))

const proposals = (db: DbExecutor, caseStudyId: string) => db.select().from(caseAiPolishProposals).where(eq(caseAiPolishProposals.caseStudyId, caseStudyId))

describe.skipIf(!databaseUrl)('AI case polish (E-14, PostgreSQL, fake AI provider)', () => {
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

  it('AI off: every route is 404 and the template flow (edit, publish, feature) is unchanged', async () => {
    setAiProviderForTesting(null)
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      await expectServiceError(getCasePolishState(tx, f.A, f.cs.id, at(12)), 'NOT_FOUND')
      await expectServiceError(polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(12)), 'NOT_FOUND')
      await expectServiceError(applyCasePolish(tx, f.A, f.cs.id, { expectedVersion: 1, accept: [] }, at(12)), 'NOT_FOUND')
      await expectServiceError(discardCasePolish(tx, f.A, f.cs.id, at(12)), 'NOT_FOUND')

      expect(f.cs.generator).toBe('template')
      expect(f.cs.sections.flatMap((s) => s.sentences).every((s) => s.ai === false)).toBe(true)
      const edited = await updateCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1, title: '고친 제목', sections: editable(f.cs) }, at(12))
      const published = await publishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: edited.version, confirmWarnings: true }, at(13))
      expect(published).toMatchObject({ status: 'published', generator: 'template' })
      await createEdition(tx, f.A, { featuredCaseStudyIds: [f.cs.id] }, at(14))
      const profile = await getPublicPortfolioProfile(tx, f.handle, at(15))
      expect(profile.featured[0]).toMatchObject({ available: true, generator: 'template' })
      expect(fake.calls).toHaveLength(0)
    })
  })

  it('sends only in-scope snapshot evidence; drops invented and out-of-scope citations as uncited; owner only', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      await hideLog(tx, f.publication.id, f.keys.hidden)
      const stranger = await createUser(tx)
      for (const actor of [f.B, { userId: stranger.id }]) {
        await expectServiceError(getCasePolishState(tx, actor, f.cs.id, at(12)), 'NOT_FOUND')
        await expectServiceError(polishCaseStudy(tx, actor, f.cs.id, { expectedVersion: 1 }, at(12)), 'NOT_FOUND')
      }
      expect(await getCasePolishState(tx, f.A, f.cs.id, at(12))).toEqual({ proposal: null, remainingToday: AI_CASE_POLISH_DAILY_LIMIT, polishable: true })
      await expectServiceError(polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 9 }, at(12)), 'CONFLICT', 'version_conflict')
      expect(fake.calls).toHaveLength(0)

      fake.respond = (call) => {
        const ids = sentenceIds(call)
        const id = (section: string, nth = 0) => ids.filter((s) => s.section === section)[nth]!.id
        return {
          data: {
            sentences: [
              { id: id('문제와 결과'), text: '도서관 혼잡도를 보여 주는 웹앱을, 센서 대신 수동 입력으로 범위를 좁혀 완성했습니다.', citations: [{ kind: 'summary', key: 'summary' }] },
              { id: id('핵심 결정'), text: '예산을 기준으로 실시간 센서 대신 수동 입력을 골랐습니다.', citations: [{ kind: 'log', key: f.keys.decision }, { kind: 'log', key: 'l_invented' }] },
              // 지어낸 수치 + 없는 키만 → uncited.
              { id: id('핵심 결정', 1), text: '회의에서 사용자 1만 명 규모로 범위를 정했습니다.', citations: [{ kind: 'log', key: 'l_invented' }] },
              // 스냅샷에는 있지만 보내지 않은(범위 밖) 팀원 로그·가린 로그 인용 → 버림 → uncited.
              { id: id('막힘과 해결'), text: 'CORS 문제를 혼자 해결했습니다.', citations: [{ kind: 'log', key: f.keys.otherMember }, { kind: 'log', key: f.keys.hidden }] },
              { id: 'S99', text: '모르는 문장', citations: [] },
            ],
          },
        }
      }
      const state = await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(12))
      expect(fake.calls).toHaveLength(1)
      const call = fake.calls[0]!
      expect(call).toMatchObject({ feature: 'case_polish.suggest', system: POLISH_SYSTEM_PROMPT, effort: 'medium', maxTokens: 16000 })
      expect(call.messages).toHaveLength(1)
      const sent = fake.sentText()
      // 범위 안: 공개 요약·내 결정·인용한 팀원 해결·참석한 회의.
      for (const inScope of ['도서관 혼잡도 웹앱', '선택: 수동 입력', '서버 응답 헤더 추가', '수동 입력으로 범위 조정', `key="${f.keys.decision}"`]) expect(sent).toContain(inScope)
      // 범위 밖: 비공개 작업 로그·다른 과제·스냅샷 속 팀원 진행(인용 안 함)·가린 항목·이름·id·이메일·과제 내부 이름.
      for (const outOfScope of [
        MARK.privateLog,
        MARK.otherTeam,
        MARK.otherMember,
        MARK.hidden,
        f.keys.otherMember,
        f.keys.hidden,
        '박팀원비밀',
        '김다듬',
        '다듬기 과제 내부명',
        f.owner.id,
        f.member.id,
        f.owner.email,
        f.project.id,
        f.cs.id,
      ]) {
        expect(sent, outOfScope).not.toContain(outOfScope)
      }
      // 가린 항목을 인용한 "직접 남긴 기록" 문장은 다듬기 대상이 아닙니다.
      expect(sentenceIds(call).some((s) => s.section === '내 역할')).toBe(false)

      const suggestions = state.proposal!.suggestions
      expect(suggestions.map((s) => [s.section, s.index, s.uncited, s.after.citations.map((c) => c.key)])).toEqual([
        ['problem_result', 0, false, ['summary']],
        ['decisions', 0, false, [f.keys.decision]],
        ['decisions', 1, true, []],
        ['stuck_solved', 0, true, []],
      ])
      expect(suggestions[1]!.before.text).toContain('선택: 수동 입력')
      expect(suggestions[1]!.after.citations[0]!.path).toBe(`/p/${f.slug}#public-${f.keys.decision}`)
      expect(state.remainingToday).toBe(AI_CASE_POLISH_DAILY_LIMIT - 1)
      // 제안은 케이스를 바꾸지 않습니다.
      expect((await getCaseStudy(tx, f.A, f.cs.id, at(12))).version).toBe(1)
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, f.cs.id), eq(auditEvents.action, 'case_study.ai_polish')))
      // 다듬을 문장 5개(요약·결정 2·막힘·지나고 보니), 가린 항목을 인용한 "직접 남긴 기록"은 제외.
      expect(audits.map((a) => a.metadata)).toEqual([{ version: 1, sentences: 5, evidence: expect.any(Number), suggestions: 4, uncited: 2, droppedCitations: 4 }])
    })
  })

  it('accept/reject per sentence: generator ai, uncited blocks publishing and featuring until fixed, then shown publicly', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      fake.respond = (call) => ({
        data: {
          sentences: sentenceIds(call).map((s) =>
            s.section === '핵심 결정'
              ? { id: s.id, text: `다듬음: ${s.text}`, citations: [] }
              : { id: s.id, text: `다듬음: ${s.text}`, citations: [{ kind: 'summary', key: 'summary' }] },
          ),
        },
      })
      const state = await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(12))
      const all = state.proposal!.suggestions
      expect(all.filter((s) => s.uncited).map((s) => s.section)).toEqual(['decisions', 'decisions'])

      await expectServiceError(applyCasePolish(tx, f.A, f.cs.id, { expectedVersion: 1, accept: [{ section: 'validation', index: 0 }] }, at(13)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ 'accept.0': 'not_found' }),
      )
      await expectServiceError(
        applyCasePolish(tx, f.A, f.cs.id, { expectedVersion: 1, accept: [{ section: 'problem_result', index: 0, text: '  ' }] }, at(13)),
        'VALIDATION',
      ).then((e) => expect(e.fields).toEqual({ 'accept.0.text': 'required' }))

      // 요약 문장은 고쳐서, 첫 결정(uncited)은 그대로 받아들이고 나머지는 버립니다.
      const applied = await applyCasePolish(
        tx,
        f.A,
        f.cs.id,
        { expectedVersion: 1, accept: [{ section: 'problem_result', index: 0, text: '학생이 고친 요약 문장' }, { section: 'decisions', index: 0 }] },
        at(13),
      )
      expect(applied).toMatchObject({ accepted: 2, rejected: all.length - 2 })
      const cs = applied.caseStudy
      expect(cs).toMatchObject({ version: 2, generator: 'ai', status: 'draft' })
      const sentence = (section: string, i: number) => cs.sections.find((s) => s.key === section)!.sentences[i]!
      expect(sentence('problem_result', 0)).toMatchObject({ text: '학생이 고친 요약 문장', ai: true, kind: 'evidence' })
      expect(sentence('decisions', 0)).toMatchObject({ ai: true, citations: [] })
      expect(sentence('decisions', 1)).toMatchObject({ ai: false })
      expect(sentence('decisions', 1).text).not.toContain('다듬음')
      expect(cs.uncited).toEqual([{ section: 'decisions', index: 0 }])
      expect(await proposals(tx, f.cs.id)).toHaveLength(0)
      const rows = await tx.select().from(caseSentences).where(eq(caseSentences.caseStudyId, f.cs.id))
      expect(rows.filter((r) => r.aiGenerated)).toHaveLength(2)

      // 게시 막힘(기존 T-14 409 uncited_sentences + 위치).
      const blocked = await expectServiceError(publishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 2, confirmWarnings: true }, at(14)), 'CONFLICT', 'uncited_sentences')
      expect(blocked.details).toEqual({ sentences: [{ section: 'decisions', index: 0 }] })
      // AI 문장을 한계·회고에 "본인 회고"로 옮겨도 출처 없이는 게시할 수 없습니다.
      const moved = editable(cs).map((s) =>
        s.key === 'decisions'
          ? { ...s, sentences: s.sentences.slice(1) }
          : s.key === 'limits'
            ? { ...s, sentences: [...s.sentences, { text: sentence('decisions', 0).text, kind: 'reflection' as const, citations: [] }] }
            : s,
      )
      const asReflection = await updateCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 2, sections: moved }, at(14))
      expect(asReflection.uncited).toEqual([{ section: 'limits', index: asReflection.sections.find((s) => s.key === 'limits')!.sentences.length - 1 }])
      await expectServiceError(publishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 3, confirmWarnings: true }, at(14)), 'CONFLICT', 'uncited_sentences')

      // 대표 케이스 지정도 서버에서 막습니다(게시 상태를 직접 만들어 방어 규칙 확인).
      await tx.update(caseStudies).set({ status: 'published', publishedAt: at(15) }).where(eq(caseStudies.id, f.cs.id))
      const featured = await expectServiceError(createEdition(tx, f.A, { featuredCaseStudyIds: [f.cs.id] }, at(15)), 'VALIDATION', 'uncited_sentences')
      expect(featured.fields).toEqual({ 'featuredCaseStudyIds.0': 'uncited_sentences' })
      expect(featured.details).toEqual({ sentences: [{ caseIndex: 0, section: 'limits', index: expect.any(Number) }] })
      await tx.update(caseStudies).set({ status: 'draft', publishedAt: null }).where(eq(caseStudies.id, f.cs.id))

      // 지우면(고치면) 게시 가능. 고치지 않은 AI 문장 표시는 편집 뒤에도 남고 generator는 ai 그대로.
      const fixed = await updateCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 3, sections: editable(asReflection).map((s) => (s.key === 'limits' ? { ...s, sentences: s.sentences.slice(0, -1) } : s)) }, at(16))
      expect(fixed).toMatchObject({ uncited: [], generator: 'ai' })
      expect(fixed.sections.find((s) => s.key === 'problem_result')!.sentences[0]).toMatchObject({ text: '학생이 고친 요약 문장', ai: true })
      const published = await publishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: fixed.version, confirmWarnings: true }, at(17))
      expect(published.status).toBe('published')
      await createEdition(tx, f.A, { featuredCaseStudyIds: [f.cs.id] }, at(18))
      const profile = await getPublicPortfolioProfile(tx, f.handle, at(19))
      expect(profile.featured[0]).toMatchObject({ available: true, generator: 'ai' })

      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, f.cs.id), eq(auditEvents.action, 'case_study.ai_polish_apply')))
      expect(audits.map((a) => a.metadata)).toEqual([{ version: 2, accepted: 2, rejected: all.length - 2, edited: 1, uncited: 1, unpublished: false }])
      expect(JSON.stringify(await tx.select().from(auditEvents).where(eq(auditEvents.targetId, f.cs.id)))).not.toContain('다듬음')
    })
  })

  it('a stale or discarded proposal cannot be applied; rejecting everything leaves the case untouched; applying to a published case unpublishes it', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      fake.respond = (call) => ({ data: { sentences: sentenceIds(call).map((s) => ({ id: s.id, text: `새 글 ${s.id}`, citations: [{ kind: 'summary', key: 'summary' }] })) } })

      await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(12))
      const none = await applyCasePolish(tx, f.A, f.cs.id, { expectedVersion: 1, accept: [] }, at(13))
      expect(none).toMatchObject({ accepted: 0, caseStudy: { version: 1, generator: 'template' } })
      await expectServiceError(applyCasePolish(tx, f.A, f.cs.id, { expectedVersion: 1, accept: [] }, at(13)), 'CONFLICT', 'no_proposal')

      await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(14))
      expect((await discardCasePolish(tx, f.A, f.cs.id, at(14))).proposal).toBeNull()
      await expectServiceError(discardCasePolish(tx, f.A, f.cs.id, at(14)), 'CONFLICT', 'no_proposal')

      // 편집 저장은 제안을 지웁니다(version이 바뀜).
      await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(15))
      const edited = await updateCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1, title: '새 제목' }, at(15))
      expect((await getCasePolishState(tx, f.A, f.cs.id, at(15))).proposal).toBeNull()
      await expectServiceError(applyCasePolish(tx, f.A, f.cs.id, { expectedVersion: edited.version, accept: [] }, at(15)), 'CONFLICT', 'no_proposal')

      // 7일이 지난 제안은 없는 것으로 봅니다.
      await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: edited.version }, at(16))
      expect((await getCasePolishState(tx, f.A, f.cs.id, new Date(at(16).getTime() + days(7)))).proposal).toBeNull()
      await discardCasePolish(tx, f.A, f.cs.id, at(16))

      // 게시 중인 케이스에 받아들이면 초안으로 돌아갑니다.
      const published = await publishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: edited.version, confirmWarnings: true }, at(17))
      const state = await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: published.version }, at(18))
      const first = state.proposal!.suggestions[0]!
      const applied = await applyCasePolish(tx, f.A, f.cs.id, { expectedVersion: published.version, accept: [{ section: first.section, index: first.index }] }, at(19))
      expect(applied.caseStudy).toMatchObject({ status: 'draft', publishedAt: null, generator: 'ai', version: published.version + 1 })
    })
  })

  it('refusal, max_tokens and invalid output become 503 and change nothing; the per-case daily limit is 429 before calling the provider', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const usage = { inputTokens: 200, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
      const cases: Array<[AiError, string]> = [
        [new AiError('refusal', null, usage, 'cyber'), 'ai_declined'],
        [new AiError('max_tokens', null, usage), 'ai_unavailable'],
        [new AiError('invalid_output', null, usage), 'ai_unavailable'],
      ]
      for (const [error, reason] of cases) {
        fake.queue({ error })
        await expectServiceError(polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(12)), 'UNAVAILABLE', reason)
      }
      // 스키마에 맞지 않는 출력도 503.
      fake.queue({ data: { sentences: [{ id: 'S1', text: 1 }] } })
      await expectServiceError(polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(12)), 'UNAVAILABLE', 'ai_unavailable')
      expect(await proposals(tx, f.cs.id)).toHaveLength(0)
      const after = await getCaseStudy(tx, f.A, f.cs.id, at(12))
      expect(after).toMatchObject({ version: 1, generator: 'template' })
      expect(JSON.stringify(after.sections)).toBe(JSON.stringify(f.cs.sections))
      const [row] = await tx.select().from(aiUsageDaily).where(and(eq(aiUsageDaily.day, '2026-11-02'), eq(aiUsageDaily.feature, 'case_polish.suggest')))
      expect(row).toMatchObject({ requests: 4, refusals: 1, failures: 3, inputTokens: 600 + 100 })

      // 실패도 하루 횟수에 셉니다: 5번째까지 부르고, 6번째는 공급자를 부르지 않고 429.
      fake.respond = () => ({ data: { sentences: [] } })
      const ok = await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(13))
      expect(ok).toMatchObject({ proposal: { suggestions: [] }, remainingToday: 0 })
      const calls = fake.calls.length
      await expectServiceError(polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, at(14)), 'RATE_LIMITED')
      expect(fake.calls).toHaveLength(calls)
      // 다음 날(UTC)에는 다시 됩니다.
      await polishCaseStudy(tx, f.A, f.cs.id, { expectedVersion: 1 }, new Date(at(14).getTime() + days(1)))
      expect(fake.calls).toHaveLength(calls + 1)
    })
  })
})
