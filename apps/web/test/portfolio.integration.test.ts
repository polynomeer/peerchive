/**
 * T-14 케이스 스터디·포트폴리오 판·공개 프로필·README 카드 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 DB 테스트는 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 사용자·프로젝트·공개의 행만 봅니다(slug·handle 무작위, 개발 DB에 남은 행과 무관).
 * 공개 읽기는 같은 트랜잭션(tx)으로 읽어 "철회·대체 커밋 즉시(worker 없이) 케이스 글이 사라짐"을 확인합니다. worker의 이용 불가 표시는
 * apps/worker 테스트가 봅니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import {
  auditEvents,
  caseSentences,
  caseStudies,
  eq,
  planForks,
  portfolioEditions,
  portfolioItems,
  seniorNotes,
  type DbExecutor,
} from '@peerchive/db'
import { createCourse, createSchool } from '../server/modules/catalog/catalog'
import { createClaim, setEndorsement } from '../server/modules/contribution/claims'
import { saveMyCheckin } from '../server/modules/checkins/checkins'
import { forkPublication } from '../server/modules/course-hub/fork'
import { createLog } from '../server/modules/logs/logs'
import { createMilestone } from '../server/modules/milestones/milestones'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate, decideConsent } from '../server/modules/publication/candidates'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { isAnonymousPublicRequest, isPublicPagePath } from '../server/modules/publication/public-http'
import {
  createCaseStudy,
  getCaseStudy,
  listCaseStudySources,
  listMyCaseStudies,
  publishCaseStudy,
  unpublishCaseStudy,
  updateCaseStudy,
} from '../server/modules/portfolio/case-studies'
import { createEdition, listMyEditions, previewEdition } from '../server/modules/portfolio/editions'
import { createPublicProfileHandler, createReadmeCardHandler } from '../server/modules/portfolio/public-http'
import { escapeMarkdown, formatReadmeCard, getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { CASE_UNAVAILABLE_MESSAGE } from '../server/modules/portfolio/view'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'
import type { CaseStudyDto } from '../shared/types/api'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const SENTINEL = 'ZZPRIVATESENTINELZZ'
const slug = () => `case-${crypto.randomUUID().slice(0, 8)}`
const handle = () => `pf-${crypto.randomUUID().slice(0, 8)}`

/**
 * owner(이름 공개) + 팀원(익명) 팀 과제. 공개되는 기록 + 비공개 표식(SENTINEL)이 든 작업 공간 기록(고르지 않은 로그, 프로젝트 제목,
 * 마일스톤 메모, 확인 메모, 체크인 메모)을 만들고, 둘 다 동의해 요약 공개로 게시합니다.
 */
async function publishedTeamCase(db: DbExecutor) {
  const ownerHandle = handle()
  const owner = await createUser(db, { displayName: '김지민', handle: ownerHandle })
  const memberHandle = handle()
  const member = await createUser(db, { displayName: '박익명', handle: memberHandle })
  const outsider = await createUser(db, { displayName: '외부인', handle: handle() })
  const A = { userId: owner.id }
  const B = { userId: member.id }
  const project = await createProject(db, A, { title: `비공개 작업 ${SENTINEL}`, kind: 'team' }, T0)
  const { token } = await createInvitation(db, A, project.id, { role: 'editor' }, T0)
  await acceptInvitation(db, B, { token }, T0)

  const m1 = await createMilestone(db, A, project.id, { title: '기획', note: `${SENTINEL} 메모` }, at(1))
  const m2 = await createMilestone(db, A, project.id, { title: '최종 제출' }, at(1))
  const decision = (
    await createLog(db, A, project.id, {
      tag: 'decision',
      payload: { options: ['카카오 지도', '네이버 지도'], criteria: '무료 쿼터', choice: '카카오 지도', hindsight: '쿼터 알림을 미리 걸었어야 했다' },
    }, at(2))
  ).log
  const stuck = (
    await createLog(db, A, project.id, {
      tag: 'stuck',
      payload: { symptom: 'CORS 에러로 API 호출 실패', keywords: ['cors'], attempts: ['프록시 설정 시도(공개되는 시도)'], timeBucket: 'half_day' },
    }, at(3))
  ).log
  const solution = (
    await createLog(db, B, project.id, { tag: 'solution', payload: { method: '서버 응답 헤더 추가', notAnswerConfirmed: true }, resolvesEntryId: stuck.id }, at(4))
  ).log
  const validation = (
    await createLog(db, A, project.id, {
      tag: 'validation',
      payload: { target: '입력 검증', conditions: '사용자 5명 테스트', result: '오류 입력 0건', openQuestions: '대량 입력 성능' },
    }, at(5))
  ).log
  const meeting = (
    await createLog(db, B, project.id, { tag: 'meeting', payload: { attendees: [owner.id, member.id], decisions: ['수동 입력으로 범위 조정'], followUps: [] } }, at(6))
  ).log
  const retro = (await createLog(db, A, project.id, { tag: 'retro', body: '범위를 일찍 줄인 것이 좋았다' }, at(7))).log
  // 고르지 않는 비공개 로그.
  await createLog(db, A, project.id, { tag: 'progress', body: `비공개 진행 ${SENTINEL}` }, at(7))
  const claim = await createClaim(db, A, project.id, { text: 'API와 입력 검증을 맡았다', evidence: [{ kind: 'log', id: validation.id }] }, at(8))
  await setEndorsement(db, B, claim.revisionId, { status: 'confirmed', note: `확인 메모 ${SENTINEL}` }, at(9))
  await saveMyCheckin(db, A, project.id, { timeBucket: 'lt5h', difficulty: 3, note: `체크인 ${SENTINEL}` }, at(9))

  const s = slug()
  const candidate = await createCandidate(
    db,
    A,
    project.id,
    {
      level: 'summary',
      title: '도서관 혼잡도 웹앱',
      summary: '실시간 센서 대신 수동 입력으로 범위를 조정했다.',
      slug: s,
      logIds: [decision.id, stuck.id, solution.id, validation.id, meeting.id, retro.id],
      milestoneIds: [m1.id, m2.id],
      claimIds: [claim.id],
      exposure: { [owner.id]: 'name', [member.id]: 'anonymous' },
      consentSelf: true,
    },
    at(10),
    ORIGINS,
  )
  const ready = await decideConsent(db, B, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(11))
  expect(ready.status).toBe('ready')
  const published = await publishCandidate(db, A, candidate.id, { manifestHash: candidate.manifestHash }, at(12))
  return { owner, member, outsider, ownerHandle, memberHandle, A, B, project, slug: s, publication: published.publication, ids: { decision, stuck, solution, validation, meeting, retro, claim } }
}

const allSentences = (dto: CaseStudyDto) => dto.sections.flatMap((s) => s.sentences)
const editable = (dto: CaseStudyDto) =>
  dto.sections.map((s) => ({ key: s.key, sentences: s.sentences.map((x) => ({ text: x.text, kind: x.kind, citations: x.citations.map(({ releaseVersion, kind, key }) => ({ releaseVersion, kind, key })) })) }))

describe('portfolio public paths', () => {
  it('treats /u/** as public pages and profile reads as anonymous', () => {
    expect(isPublicPagePath('/u/jimin')).toBe(true)
    expect(isPublicPagePath('/u/jimin/print')).toBe(true)
    expect(isPublicPagePath('/uploads')).toBe(false)
    expect(isAnonymousPublicRequest('GET', '/api/v1/public/profiles/jimin')).toBe(true)
    expect(isAnonymousPublicRequest('GET', '/api/v1/public/profiles/jimin/readme-card.md')).toBe(true)
    expect(escapeMarkdown('[a](b) *c*')).toBe('\\[a\\]\\(b\\) \\*c\\*')
  })
})

describe.skipIf(!databaseUrl)('case studies, editions and public profile (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('eligibility: only members of a currently published release; anonymous members must confirm revealSelf', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      await expectServiceError(createCaseStudy(tx, { userId: f.outsider.id }, { releaseSlug: f.slug, jobTarget: 'backend' }, at(20)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ releaseSlug: 'not_member' }),
      )
      await expectServiceError(createCaseStudy(tx, f.A, { releaseSlug: 'no-such-case-zz', jobTarget: 'backend' }, at(20)), 'NOT_FOUND')
      await expectServiceError(createCaseStudy(tx, f.B, { releaseSlug: f.slug, jobTarget: 'frontend' }, at(20)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ revealSelf: 'confirm_required' }),
      )
      const sources = await listCaseStudySources(tx, f.B, at(20))
      expect(sources).toEqual([expect.objectContaining({ slug: f.slug, selfAnonymous: true, selfLabel: '팀원 A', caseStudies: [] })])
      expect(await listCaseStudySources(tx, { userId: f.outsider.id }, at(20))).toEqual([])

      const mine = await createCaseStudy(tx, f.B, { releaseSlug: f.slug, jobTarget: 'frontend', revealSelf: true }, at(21))
      expect(mine).toMatchObject({ status: 'draft', source: { selfAnonymous: true, revealSelf: true, selfLabel: '팀원 A', releaseVersion: 1 } })
      // B는 해결 로그를 썼으므로 막힘과 해결이 들어 있고, 다른 팀원(김지민)의 표시는 스냅샷 그대로입니다.
      const stuckSection = mine.sections.find((s) => s.key === 'stuck_solved')!
      expect(stuckSection.sentences[0]!.text).toBe('막힘: CORS 에러로 API 호출 실패 → 해결: 서버 응답 헤더 추가 (걸린 시간: 반나절)')
      expect(mine.snapshot!.members.map((m) => m.label).sort()).toEqual(['김지민', '팀원 A'])

      // 공개가 철회되면 새 케이스를 만들 수 없음(404).
      await withdrawPublication(tx, f.A, f.publication.id, {}, at(22))
      await expectServiceError(createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(23)), 'NOT_FOUND')
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.action, 'case_study.create'))
      expect(audits.filter((a) => a.targetId === mine.id)).toHaveLength(1)
    })
  })

  it('generates a template draft whose every sentence cites the pinned snapshot', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      const dto = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(20))
      expect(dto.title).toBe('도서관 혼잡도 웹앱')
      expect(dto.sections.map((s) => s.key)).toEqual(['problem_result', 'my_role', 'decisions', 'stuck_solved', 'validation', 'limits', 'sources'])
      const texts = allSentences(dto).map((s) => s.text)
      expect(texts).toEqual(
        expect.arrayContaining([
          '도서관 혼잡도 웹앱 — 실시간 센서 대신 수동 입력으로 범위를 조정했다.',
          '확인한 결과: 오류 입력 0건',
          '역할: API와 입력 검증을 맡았다 (팀원 확인 1명)',
          '선택: 카카오 지도 (선택지: 카카오 지도 / 네이버 지도) · 기준: 무료 쿼터',
          '회의에서 정한 것: 수동 입력으로 범위 조정',
          '막힘: CORS 에러로 API 호출 실패 → 해결: 서버 응답 헤더 추가 (걸린 시간: 반나절)',
          '검증: 입력 검증 · 조건: 사용자 5명 테스트 · 결과: 오류 입력 0건',
          '지나고 보니: 쿼터 알림을 미리 걸었어야 했다',
          '남은 질문: 대량 입력 성능',
          '회고: 범위를 일찍 줄인 것이 좋았다',
          '진행 단계: 기획 → 최종 제출',
        ]),
      )
      expect(dto.uncited).toEqual([])
      const keys = new Set([...dto.snapshot!.logs.map((l) => l.key), ...dto.snapshot!.claims.map((c) => c.key), ...dto.snapshot!.milestones.map((m) => m.key), 'summary'])
      for (const sentence of allSentences(dto)) {
        expect(sentence.citations.length).toBeGreaterThan(0)
        for (const c of sentence.citations) {
          expect(keys.has(c.key)).toBe(true)
          expect(c.path).toMatch(new RegExp(`^/p/${f.slug}#public-`))
          expect(c.label).toBeTruthy()
        }
      }
      expect(JSON.stringify(dto)).not.toContain(SENTINEL)
      expect((await getCaseStudy(tx, f.A, dto.id, at(21))).id).toBe(dto.id)
      await expectServiceError(getCaseStudy(tx, f.B, dto.id, at(21)), 'NOT_FOUND')
    })
  })

  it('edits: citations must exist in the pinned snapshot; uncited sentences block publishing except reflections in 한계·회고', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      const dto = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(20))
      const sections = editable(dto)
      const decisions = sections.find((s) => s.key === 'decisions')!
      decisions.sentences.push({ text: '출처 없는 주장', kind: 'evidence', citations: [] })

      const bad = structuredClone(sections)
      bad.find((s) => s.key === 'decisions')!.sentences[0]!.citations = [{ releaseVersion: 1, kind: 'log', key: 'l_notinsnapshot' }]
      await expectServiceError(updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 1, sections: bad }, at(21)), 'VALIDATION').then((e) =>
        expect(Object.values(e.fields ?? {})).toEqual(['not_found']),
      )
      const reflectionElsewhere = structuredClone(sections)
      reflectionElsewhere.find((s) => s.key === 'decisions')!.sentences[0]!.kind = 'reflection'
      await expectServiceError(updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 1, sections: reflectionElsewhere }, at(21)), 'VALIDATION')

      const edited = await updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 1, title: '도서관 앱 — 범위 조정 사례', sections }, at(21))
      expect(edited).toMatchObject({ version: 2, title: '도서관 앱 — 범위 조정 사례' })
      const index = decisions.sentences.length - 1
      expect(edited.uncited).toEqual([{ section: 'decisions', index }])
      await expectServiceError(updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 1, title: 'x' }, at(22)), 'CONFLICT', 'version_conflict')
      const blocked = await expectServiceError(publishCaseStudy(tx, f.A, dto.id, { expectedVersion: 2 }, at(22)), 'CONFLICT', 'uncited_sentences')
      expect(blocked.details).toEqual({ sentences: [{ section: 'decisions', index }] })

      // 출처 없는 문장을 지우고, 한계·회고에 본인 회고(출처 없음)를 더하면 게시됩니다. 전화번호는 경고 확인을 요구합니다.
      decisions.sentences.pop()
      sections.find((s) => s.key === 'limits')!.sentences.push({ text: '다시 한다면 사용자 인터뷰를 먼저 하겠다. 010-1234-5678', kind: 'reflection', citations: [] })
      const v3 = await updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 2, sections }, at(23))
      expect(v3.uncited).toEqual([])
      expect(v3.warnings).toEqual([expect.objectContaining({ rule: 'phone', location: expect.objectContaining({ kind: 'case_study', key: 'limits' }) })])
      await expectServiceError(publishCaseStudy(tx, f.A, dto.id, { expectedVersion: 3 }, at(24)), 'CONFLICT', 'checks_unconfirmed')
      const published = await publishCaseStudy(tx, f.A, dto.id, { expectedVersion: 3, confirmWarnings: true }, at(24))
      expect(published).toMatchObject({ status: 'published', publishedAt: at(24).toISOString() })
      expect((await publishCaseStudy(tx, f.A, dto.id, { expectedVersion: 3 }, at(25))).status).toBe('published')

      // 게시된 케이스를 고치면 draft로 돌아가고, 게시 취소는 게시 중일 때만.
      const back = await updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 3, title: '다시 고침' }, at(26))
      expect(back.status).toBe('draft')
      await expectServiceError(unpublishCaseStudy(tx, f.A, dto.id, at(27)), 'CONFLICT', 'not_published')
      await expectServiceError(updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 4 }, at(27)), 'VALIDATION')
      const empty = await updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 4, sections: [] }, at(27))
      await expectServiceError(publishCaseStudy(tx, f.A, empty.id, { expectedVersion: 5 }, at(28)), 'CONFLICT', 'empty')
    })
  })

  it('withdrawn release: case study and profile item become unavailable immediately (no worker), with no case text', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      const dto = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(20))
      await publishCaseStudy(tx, f.A, dto.id, { expectedVersion: 1 }, at(21))
      await createEdition(tx, f.A, { headline: '범위를 조정하고 검증하는 개발자', featuredCaseStudyIds: [dto.id], competencies: [{ label: '디버깅', preset: 'debugging' }] }, at(22))
      const before = await getPublicPortfolioProfile(tx, f.ownerHandle, at(23))
      expect(before.featured[0]).toMatchObject({ available: true, title: dto.title, path: `/p/${f.slug}` })
      expect(before.timeline).toEqual([expect.objectContaining({ title: '도서관 혼잡도 웹앱', path: `/p/${f.slug}` })])

      await withdrawPublication(tx, f.A, f.publication.id, {}, at(24))
      const after = await getPublicPortfolioProfile(tx, f.ownerHandle, at(25))
      expect(after.featured).toEqual([{ anchor: 'case-1', available: false, message: CASE_UNAVAILABLE_MESSAGE }])
      expect(after.matrix.columns).toEqual([{ ref: 'case-1', title: '볼 수 없는 사례', available: false }])
      expect(after.matrix.rows[0]!.cells[0]).toMatchObject({ available: false, evidence: [], counts: [] })
      expect(after.timeline).toEqual([])
      const text = JSON.stringify(after)
      for (const phrase of ['도서관', 'CORS', '카카오', f.slug]) expect(text).not.toContain(phrase)
      expect(formatReadmeCard(after, 'http://localhost:3000')).not.toContain('/p/')

      // 작성자 화면: 저장 상태는 아직 published여도(worker 전) 읽는 즉시 unavailable, 스냅샷 없음, 편집·게시 409.
      const [stored] = await tx.select().from(caseStudies).where(eq(caseStudies.id, dto.id))
      expect(stored!.status).toBe('published')
      const owner = await getCaseStudy(tx, f.A, dto.id, at(25))
      expect(owner).toMatchObject({ status: 'unavailable', unavailableReason: 'withdrawn', snapshot: null, recreateSlug: null })
      await expectServiceError(updateCaseStudy(tx, f.A, dto.id, { expectedVersion: 1, title: 'x' }, at(26)), 'CONFLICT', 'unavailable')
      expect((await listMyCaseStudies(tx, f.A, at(26)))[0]).toMatchObject({ id: dto.id, status: 'unavailable', unavailableReason: 'withdrawn' })
    })
  })

  it('replaced release: pinned case study is unavailable and can be recreated from the new version', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      const dto = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'general' }, at(20))
      await publishCaseStudy(tx, f.A, dto.id, { expectedVersion: 1 }, at(21))
      await createEdition(tx, f.A, { featuredCaseStudyIds: [dto.id] }, at(21))
      const next = await createCandidate(
        tx,
        f.A,
        f.project.id,
        {
          level: 'summary',
          title: '도서관 혼잡도 웹앱 v2',
          summary: '두 번째 공개 버전',
          slug: f.slug,
          logIds: [f.ids.decision.id],
          exposure: { [f.owner.id]: 'name' },
          consentSelf: true,
        },
        at(22),
        ORIGINS,
      )
      const ready = next.status === 'ready' ? next : await decideConsent(tx, f.B, next.id, { decision: 'granted', manifestHash: next.manifestHash }, at(23))
      expect(ready.status).toBe('ready')
      await publishCandidate(tx, f.A, ready.id, { manifestHash: ready.manifestHash }, at(24))

      const owner = await getCaseStudy(tx, f.A, dto.id, at(25))
      expect(owner).toMatchObject({ status: 'unavailable', unavailableReason: 'replaced', recreateSlug: f.slug })
      const profile = await getPublicPortfolioProfile(tx, f.ownerHandle, at(25))
      expect(profile.featured[0]).toMatchObject({ available: false, message: CASE_UNAVAILABLE_MESSAGE })
      const again = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'general' }, at(26))
      expect(again).toMatchObject({ status: 'draft', source: { releaseVersion: 2 } })
    })
  })

  it('editions are immutable versions; the public profile shows only the current one, with no email or internal ids, and sets no cookies', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      const first = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(20))
      const second = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'pm' }, at(20))
      // 게시하지 않은 케이스는 대표로 고를 수 없음.
      await expectServiceError(createEdition(tx, f.A, { featuredCaseStudyIds: [first.id] }, at(21)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ 'featuredCaseStudyIds.0': 'not_published' }),
      )
      await publishCaseStudy(tx, f.A, first.id, { expectedVersion: 1 }, at(21))
      await publishCaseStudy(tx, f.A, second.id, { expectedVersion: 1 }, at(21))
      await expectServiceError(createEdition(tx, f.B, { featuredCaseStudyIds: [first.id] }, at(21)), 'VALIDATION').then((e) =>
        expect(e.fields).toEqual({ 'featuredCaseStudyIds.0': 'not_found' }),
      )
      // 근거는 그 케이스가 인용한 항목만.
      await expectServiceError(
        createEdition(tx, f.A, { featuredCaseStudyIds: [first.id], competencies: [{ label: 'API 설계', evidence: [{ caseStudyId: first.id, citations: [{ kind: 'log', key: 'l_nope' }] }] }] }, at(21)),
        'VALIDATION',
      ).then((e) => expect(e.fields).toEqual({ 'competencies.0.evidence.0.citations.0': 'not_cited' }))

      const decisionKey = allSentences(first).flatMap((s) => s.citations).find((c) => c.label?.startsWith('⚖️'))!.key
      const preview = await previewEdition(tx, f.A, { featuredCaseStudyIds: [first.id], competencies: [{ label: 'API 설계', evidence: [{ caseStudyId: first.id, citations: [{ kind: 'log', key: decisionKey }] }] }] }, at(22))
      expect(preview.matrix.rows[0]!.cells[0]).toMatchObject({ text: '결정 1', available: true })
      expect(await tx.select().from(portfolioEditions).where(eq(portfolioEditions.userId, f.owner.id))).toEqual([])

      const v1 = await createEdition(
        tx,
        f.A,
        {
          headline: '첫 판',
          featuredCaseStudyIds: [first.id],
          competencies: [
            { label: 'API 설계', evidence: [{ caseStudyId: first.id, citations: [{ kind: 'log', key: decisionKey }] }] },
            { label: '디버깅', preset: 'debugging' },
            { label: '직접 입력 역량' },
          ],
          skillsDeclared: ['TypeScript', 'PostgreSQL'],
        },
        at(23),
      )
      expect(v1).toMatchObject({ version: 1, current: true, headline: '첫 판', skillsDeclared: ['TypeScript', 'PostgreSQL'] })
      const p1 = await getPublicPortfolioProfile(tx, f.ownerHandle, at(24))
      expect(p1.headline).toBe('첫 판')
      expect(p1.edition).toEqual({ version: 1, createdAt: at(23).toISOString() })
      expect(p1.matrix.rows.map((r) => [r.label, r.cells[0]!.text])).toEqual([
        ['API 설계', '결정 1'],
        ['디버깅', '막힘 해결 1'],
        ['직접 입력 역량', '–'],
      ])
      expect(p1.evidenceBackedCompetencies).toEqual(['API 설계', '디버깅'])
      expect(p1.skillsDeclared).toEqual(['TypeScript', 'PostgreSQL'])
      expect(p1.matrix.rows[1]!.cells[0]!.evidence.every((e) => e.path.startsWith(`/p/${f.slug}#public-l_`))).toBe(true)

      const v2 = await createEdition(tx, f.A, { headline: '두 번째 판', featuredCaseStudyIds: [second.id] }, at(25))
      expect(v2).toMatchObject({ version: 2, current: true })
      const editions = await listMyEditions(tx, f.A)
      expect(editions.map((e) => [e.version, e.current, e.headline])).toEqual([
        [2, true, '두 번째 판'],
        [1, false, '첫 판'],
      ])
      // 이전 판은 그대로(바꾸지 않음).
      expect(editions[1]).toMatchObject({ featured: [{ caseStudyId: first.id, position: 0 }], skillsDeclared: ['TypeScript', 'PostgreSQL'] })
      expect(await tx.select().from(portfolioItems).where(eq(portfolioItems.editionId, v1.id))).toHaveLength(1)

      const p2 = await getPublicPortfolioProfile(tx, f.ownerHandle, at(26))
      expect(p2).toMatchObject({ headline: '두 번째 판', edition: { version: 2 }, skillsDeclared: [], matrix: { rows: [] } })
      expect(p2.featured).toHaveLength(1)
      expect(p2.featured[0]).toMatchObject({ available: true, jobTarget: 'pm' })
      const text = JSON.stringify(p2)
      for (const secret of [f.owner.email, f.member.email, f.owner.id, f.member.id, first.id, second.id, v1.id, v2.id, f.publication.id, f.project.id, SENTINEL, '첫 판']) {
        expect(text).not.toContain(secret)
      }
      // 익명이던 팀원의 이름은 owner 프로필에 나오지 않음.
      expect(text).not.toContain('박익명')

      // HTTP: 쿠키 없음·no-store·noindex, README 카드는 마크다운.
      const deps = { getDb: () => tx, now: () => at(27), getEnv: () => ({}) }
      const router = createRouter()
        .get('/api/v1/public/profiles/:handle', createPublicProfileHandler(deps))
        .get('/api/v1/public/profiles/:handle/readme-card.md', createReadmeCardHandler({ ...deps, getOrigin: () => 'https://peerchive.test' }))
      const app = createApp()
      app.use(router)
      const web = toWebHandler(app)
      const get = (path: string) => web(new Request(`http://localhost:3000${path}`, { headers: { cookie: 'peerchive_session=whatever' } }))
      const res = await get(`/api/v1/public/profiles/${f.ownerHandle}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      const card = await get(`/api/v1/public/profiles/${f.ownerHandle}/readme-card.md`)
      expect(card.status).toBe(200)
      expect(card.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
      expect(card.headers.get('set-cookie')).toBeNull()
      const md = await card.text()
      expect(md).toContain('### 김지민 · Peerchive 포트폴리오')
      expect(md).toContain('두 번째 판')
      expect(md).toContain(`(https://peerchive.test/p/${f.slug})`)
      expect(md).toContain(`(https://peerchive.test/u/${f.ownerHandle})`)
      for (const secret of [f.owner.email, f.owner.id, SENTINEL]) expect(md).not.toContain(secret)
      expect((await get('/api/v1/public/profiles/no-such-handle-zz')).status).toBe(404)
      const disabled = createApp()
      disabled.use(createRouter().get('/api/v1/public/profiles/:handle', createPublicProfileHandler({ ...deps, getEnv: () => ({ PEERCHIVE_PUBLIC_READS_DISABLED: '1' }) })))
      expect((await toWebHandler(disabled)(new Request(`http://localhost:3000/api/v1/public/profiles/${f.ownerHandle}`))).status).toBe(503)
    })
  })

  it('leak test: workspace sentinels and the anonymous member identity never reach case study, profile, readme or print payloads', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      const a = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'data' }, at(20))
      const b = await createCaseStudy(tx, f.B, { releaseSlug: f.slug, jobTarget: 'design', revealSelf: true }, at(20))
      await publishCaseStudy(tx, f.A, a.id, { expectedVersion: 1 }, at(21))
      await publishCaseStudy(tx, f.B, b.id, { expectedVersion: 1 }, at(21))
      await createEdition(tx, f.A, { featuredCaseStudyIds: [a.id], competencies: [{ label: '협업', preset: 'collaboration' }] }, at(22))
      await createEdition(tx, f.B, { featuredCaseStudyIds: [b.id], competencies: [{ label: '문제 해결', preset: 'problem_solving' }] }, at(22))
      const payloads = [
        JSON.stringify(a),
        JSON.stringify(b),
        JSON.stringify(await getPublicPortfolioProfile(tx, f.ownerHandle, at(23))),
        JSON.stringify(await getPublicPortfolioProfile(tx, f.memberHandle, at(23))),
        formatReadmeCard(await getPublicPortfolioProfile(tx, f.ownerHandle, at(23)), 'http://localhost:3000'),
        formatReadmeCard(await getPublicPortfolioProfile(tx, f.memberHandle, at(23)), 'http://localhost:3000'),
      ]
      for (const text of payloads) {
        for (const secret of [SENTINEL, f.owner.email, f.member.email, f.outsider.email, f.project.id, f.publication.id]) expect(text).not.toContain(secret)
      }
      // 익명이던 팀원(B)은 자기 프로필에서만 "팀원 A"로 자기 연결을 드러내고, 실명(박익명)은 스냅샷에 없으므로 B 케이스에도 없습니다.
      const memberProfile = await getPublicPortfolioProfile(tx, f.memberHandle, at(23))
      expect(memberProfile.displayName).toBe('박익명')
      expect(memberProfile.featured[0]).toMatchObject({ available: true, selfLabel: '팀원 A' })
      expect(JSON.stringify(memberProfile.featured)).not.toContain('박익명')
      // owner의 프로필에는 다른 팀원의 실명이 없음(스냅샷 그대로 "팀원 A").
      expect(payloads[2]).not.toContain('박익명')
      // 저장된 문장도 비공개 표식이 없음.
      const rows = await tx.select().from(caseSentences).where(eq(caseSentences.caseStudyId, a.id))
      expect(JSON.stringify(rows)).not.toContain(SENTINEL)
    })
  })

  it('junior contribution counts: distinct plan forks of published cases and name-mode senior notes only', async () => {
    await withRollback(async (tx) => {
      const f = await publishedTeamCase(tx)
      const dto = await createCaseStudy(tx, f.A, { releaseSlug: f.slug, jobTarget: 'backend' }, at(20))
      await publishCaseStudy(tx, f.A, dto.id, { expectedVersion: 1 }, at(21))
      const junior = await createUser(tx, { displayName: '후배' })
      await forkPublication(tx, { userId: junior.id }, f.slug, at(22))
      await forkPublication(tx, f.A, f.slug, at(22)) // 본인 포크는 세지 않음
      expect(await tx.select().from(planForks).where(eq(planForks.sourcePublicationId, f.publication.id))).toHaveLength(2)
      // 선배 노트: 직접 행을 넣어 계정 이름 모드로 게시한 것만 세는지 봅니다(노트 규칙은 T-13 테스트).
      const t = crypto.randomUUID().slice(0, 8)
      const school = await createSchool(tx, f.A, { name: `포트대${t}학교`, confirmNew: true }, T0)
      const course = await createCourse(tx, f.A, school.id, { title: `웹프로그래밍${t}`, confirmNew: true }, T0)
      const note = (displayMode: 'name' | 'anonymous', status: 'published' | 'draft') => ({
        courseId: course.id,
        authorId: f.owner.id,
        displayMode,
        displayNameSnapshot: displayMode === 'name' ? '김지민' : null,
        answers: { firstWeek: '명세 읽기', timeSink: '디버깅' },
        noAnswersConfirmed: true,
        status,
        publishedAt: status === 'published' ? T0 : null,
      })
      await tx.insert(seniorNotes).values([note('name', 'published'), note('anonymous', 'published'), note('name', 'draft')])
      const profile = await getPublicPortfolioProfile(tx, f.ownerHandle, at(23))
      expect(profile.juniorContribution).toEqual({ planForks: 1, seniorNotes: 1, curatedCourses: [], stuckQaAnswers: 0 })
      expect(profile.contactText).toBe('연락을 받지 않습니다.')
      expect(profile.edition).toBeNull()
      expect(profile.featured).toEqual([])
      expect(profile.timeline).toHaveLength(1)
    })
  })
})
