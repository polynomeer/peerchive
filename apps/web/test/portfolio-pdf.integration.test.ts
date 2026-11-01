/**
 * E-08 지원용 PDF 통합 테스트(실제 PostgreSQL, rollback). DATABASE_URL이 없으면 건너뜁니다.
 * - `GET /api/v1/public/profiles/:handle/portfolio.pdf`: `%PDF-`·application/pdf·첨부·늘 noindex·no-store·no-referrer·쿠키 없음.
 * - 공개 프로필 DTO와 같은 내용: 지금 볼 수 있는 대표 케이스 제목·문장·근거 절대 주소, 고른 면접 질문(답변 메모 없음). 철회한 케이스는 0건.
 * - 이메일·사용자/페르소나 id가 글·메타데이터·원본 바이트에 없음, 메타데이터 제목 = "<이름> 포트폴리오", 작성자 없음.
 * - S-01: 연결을 끈 상대 페르소나 정보 0건(양방향), 켜면 공개 프로필과 같이 상대 프로필 이름·주소만.
 * - 숨긴·없는 프로필·정지 계정 404, 운영 스위치 503, IP마다·프로필마다 생성 한도 429.
 * 조판(줄바꿈·글꼴에 없는 글자)은 portfolio-pdf.test.ts, 브라우저 내려받기는 apps/e2e e08-portfolio-pdf.spec.ts.
 */
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import { eq, personas, profiles, users, type DbExecutor } from '@peerchive/db'
import { createLog } from '../server/modules/logs/logs'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { publishCandidate, withdrawPublication } from '../server/modules/publication/releases'
import { createCaseStudy, publishCaseStudy } from '../server/modules/portfolio/case-studies'
import { createEdition } from '../server/modules/portfolio/editions'
import { getInterviewPrep, saveInterviewPrep } from '../server/modules/portfolio/interview-prep'
import { PORTFOLIO_PDF_HANDLE_RATE_LIMIT, PORTFOLIO_PDF_IP_RATE_LIMIT, createPortfolioPdfHandler } from '../server/modules/portfolio/public-http'
import { getPublicPortfolioProfile } from '../server/modules/portfolio/public-profile'
import { hitRateLimit } from '../server/modules/security/rate-limit'
import { createDisplayPersona, setIdentityLink } from '../server/modules/social/personas'
import { closeTestDb, createUser, databaseUrl, minutes, withRollback } from './helpers'
import { extractPdfText } from './pdf-text'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const ORIGIN = 'https://peerchive.example'
const FONT = new Uint8Array(readFileSync(new URL('../server/assets/fonts/Pretendard-Regular.ttf', import.meta.url)))
const tag = () => crypto.randomUUID().slice(0, 8)

type Actor = { userId: string }

/** 개인 과제 하나를 이름으로 공개하고 케이스 스터디로 게시합니다. */
async function publishedCase(db: DbExecutor, A: Actor, title: string, n: number) {
  const project = await createProject(db, A, { title: `과제 ${title}`, kind: 'individual' }, at(n))
  const decision = (
    await createLog(db, A, project.id, { tag: 'decision', payload: { options: ['A안', 'B안'], criteria: '비용', choice: 'B안' } }, at(n + 1))
  ).log
  const slug = `pdf-${tag()}`
  const candidate = await createCandidate(
    db,
    A,
    project.id,
    { level: 'summary', title, summary: `${title} 요약: B안을 골랐다.`, slug, logIds: [decision.id], exposure: { [A.userId]: 'name' }, consentSelf: true },
    at(n + 2),
    ORIGINS,
  )
  const published = await publishCandidate(db, A, candidate.id, { manifestHash: candidate.manifestHash }, at(n + 3))
  const draft = await createCaseStudy(db, A, { releaseSlug: slug, jobTarget: 'backend' }, at(n + 4))
  const cs = await publishCaseStudy(db, A, draft.id, { expectedVersion: draft.version, confirmWarnings: true }, at(n + 5))
  return { slug, cs, publication: published.publication }
}

/** 실명 페르소나: 살아 있는 케이스 + 철회할 케이스를 대표로 둔 판, 고른 면접 질문(메모 포함). */
async function fixture(db: DbExecutor) {
  const handle = `pdf-${tag()}`
  const owner = await createUser(db, { displayName: '김지원', handle })
  const A = { userId: owner.id }
  const live = await publishedCase(db, A, `살아 있는 사례 LIVESENTINEL${tag()}`, 0)
  const gone = await publishedCase(db, A, `철회할 사례 GONESENTINEL${tag()}`, 10)
  const edition = await createEdition(
    db,
    A,
    { featuredCaseStudyIds: [live.cs.id, gone.cs.id], headline: '근거로 말하는 지원자', skillsDeclared: ['SQL'], competencies: [{ label: '디버깅', preset: 'debugging' }] },
    at(20),
  )
  const prep = await getInterviewPrep(db, A, live.cs.id, at(21))
  const question = prep.questions[0]!
  await saveInterviewPrep(db, A, live.cs.id, { questionKey: question.key, shown: true, note: 'NOTESENTINEL 비공개 답변' }, at(21))
  const [real] = await db.select().from(personas).where(eq(personas.handle, handle))
  return { owner, A, handle, realId: real!.id, live, gone, edition, question }
}

function web(db: DbExecutor, now: Date, options: { ip?: string; env?: Record<string, string> } = {}) {
  const app = createApp()
  app.use(
    createRouter().get(
      '/api/v1/public/profiles/:handle/portfolio.pdf',
      createPortfolioPdfHandler({
        getDb: () => db,
        now: () => now,
        getEnv: () => ({ PEERCHIVE_PUBLIC_INDEXING: '1', ...options.env }),
        getOrigin: () => `${ORIGIN}/`,
        clientKey: () => options.ip ?? `203.0.113.${tag()}`,
        loadFont: async () => FONT,
      }),
    ),
  )
  const handler = toWebHandler(app)
  return (handle: string) => handler(new Request(`http://localhost:3000/api/v1/public/profiles/${handle}/portfolio.pdf`, { headers: { cookie: 'peerchive_session=abc' } }))
}

async function pdfOf(db: DbExecutor, handle: string, now: Date) {
  const res = await web(db, now)(handle)
  expect(res.status, handle).toBe(200)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { res, bytes, pdf: await extractPdfText(bytes) }
}

describe.skipIf(!databaseUrl)('portfolio PDF (E-08, PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('builds the PDF from the public profile DTO: live cases with absolute evidence links, no withdrawn case, no private data', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      await withdrawPublication(tx, f.A, f.gone.publication.id, {}, at(30))
      const dto = await getPublicPortfolioProfile(tx, f.handle, at(31))
      const liveCase = dto.featured.find((c) => c.available)
      if (!liveCase?.available) throw new Error('live case missing')
      expect(dto.featured.filter((c) => c.available)).toHaveLength(1)

      const { res, bytes, pdf } = await pdfOf(tx, f.handle, at(31))
      expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(Number(res.headers.get('content-length'))).toBe(bytes.byteLength)
      expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${f.handle}-portfolio.pdf"; filename*=UTF-8''${f.handle}-portfolio.pdf`)
      // 공개 색인을 켜도 PDF는 늘 noindex입니다.
      expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('set-cookie')).toBeNull()

      // 한글 글·살아 있는 케이스·근거 절대 주소.
      expect(pdf.text).not.toContain('�')
      expect(pdf.text).toContain(`김지원 @${f.handle}`)
      expect(pdf.text).toContain('“근거로 말하는 지원자”')
      expect(pdf.text).toContain(liveCase.title)
      expect(pdf.text).toContain(`원본 공개 사례: ${ORIGIN}/p/${f.live.slug}`)
      const evidencePaths = liveCase.sections.flatMap((s) => s.sentences.flatMap((x) => x.citations.map((c) => c.path)))
      expect(evidencePaths.length).toBeGreaterThan(0)
      for (const path of evidencePaths) {
        expect(path.startsWith(`/p/${f.live.slug}`)).toBe(true)
        expect(pdf.text.replace(/\n/g, '')).toContain(`${ORIGIN}${path}`)
        expect(pdf.links).toContain(`${ORIGIN}${path}`)
      }
      expect(pdf.text).toContain('디버깅')
      // 고른 면접 질문은 글만, 답변 메모는 없음.
      expect(pdf.text.replace(/\n/g, ' ')).toContain(f.question.text)
      // 철회한 케이스·비공개 정보는 0건.
      const everything = `${pdf.text}\n${pdf.links.join('\n')}\n${JSON.stringify(pdf.info)}\n${Buffer.from(bytes).toString('latin1')}`
      for (const secret of ['GONESENTINEL', f.gone.slug, f.gone.cs.title, 'NOTESENTINEL', f.owner.email, f.owner.id, f.realId, f.live.cs.id, f.edition.id, '원본 사례를 더 이상 볼 수 없습니다']) {
        expect(everything, secret).not.toContain(secret)
      }
      expect(pdf.info).toMatchObject({ title: '김지원 포트폴리오', author: undefined, subject: undefined, keywords: undefined, creator: 'Peerchive' })
    })
  })

  it('keeps S-01: a persona PDF has nothing about the other persona unless the link is on', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const displayHandle = `pdfd-${tag()}`
      const displayName = `밤지원${tag()}`
      const display = await createDisplayPersona(tx, f.A, { handle: displayHandle, displayName }, at(22))
      await createEdition(tx, f.A, { personaId: display.id, headline: `표시명 한 줄 DISPLAYSENTINEL${tag()}` }, at(23))
      const displayHeadline = (await getPublicPortfolioProfile(tx, displayHandle, at(24))).headline!
      const realSecrets = [f.handle, '김지원', 'LIVESENTINEL', f.live.slug, '근거로 말하는 지원자', f.owner.id, f.realId]
      const displaySecrets = [displayHandle, displayName, displayHeadline, display.id]

      await setIdentityLink(tx, f.A, { visible: false }, at(24))
      const realOff = await pdfOf(tx, f.handle, at(25))
      const displayOff = await pdfOf(tx, displayHandle, at(25))
      const realText = `${realOff.pdf.text}\n${realOff.pdf.links.join('\n')}\n${JSON.stringify(realOff.pdf.info)}\n${Buffer.from(realOff.bytes).toString('latin1')}`
      const displayText = `${displayOff.pdf.text}\n${displayOff.pdf.links.join('\n')}\n${JSON.stringify(displayOff.pdf.info)}\n${Buffer.from(displayOff.bytes).toString('latin1')}`
      expect(realOff.pdf.text).toContain('LIVESENTINEL')
      for (const secret of displaySecrets) expect(realText, `real PDF leaks ${secret}`).not.toContain(secret)
      expect(displayOff.pdf.text).toContain(`${displayName} @${displayHandle}`)
      expect(displayOff.pdf.text).toContain('표시명 프로필')
      expect(displayOff.pdf.info.title).toBe(`${displayName} 포트폴리오`)
      for (const secret of realSecrets) expect(displayText, `display PDF leaks ${secret}`).not.toContain(secret)

      // 연결을 켜면 공개 프로필과 같이 상대 프로필의 이름·주소만 나옵니다(표시명 PDF에 케이스는 여전히 없음).
      await setIdentityLink(tx, f.A, { visible: true }, at(26))
      const realOn = await pdfOf(tx, f.handle, at(27))
      const displayOn = await pdfOf(tx, displayHandle, at(27))
      expect(realOn.pdf.text).toContain(`표시명 프로필: ${displayName} @${displayHandle}`)
      expect(realOn.pdf.text).not.toContain(displayHeadline)
      expect(displayOn.pdf.text).toContain(`실명 프로필: 김지원 @${f.handle}`)
      expect(displayOn.pdf.links).toContain(`${ORIGIN}/u/${f.handle}`)
      for (const secret of ['LIVESENTINEL', f.live.slug, '근거로 말하는 지원자']) expect(displayOn.pdf.text).not.toContain(secret)
    })
  })

  it('404s hidden, unknown and inactive profiles and 503s behind the kill switch', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const get = web(tx, at(30))
      expect((await get(f.handle)).status).toBe(200)
      await tx.update(profiles).set({ hiddenAt: at(31) }).where(eq(profiles.personaId, f.realId))
      const hidden = await get(f.handle)
      expect(hidden.status).toBe(404)
      expect(hidden.headers.get('content-type')).not.toBe('application/pdf')
      expect(hidden.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      await tx.update(profiles).set({ hiddenAt: null }).where(eq(profiles.personaId, f.realId))
      await tx.update(users).set({ status: 'suspended' }).where(eq(users.id, f.owner.id))
      expect((await get(f.handle)).status).toBe(404)
      await tx.update(users).set({ status: 'active' }).where(eq(users.id, f.owner.id))
      expect((await get(`nobody-${tag()}`)).status).toBe(404)
      const off = await web(tx, at(30), { env: { PEERCHIVE_PUBLIC_READS_DISABLED: '1' } })(f.handle)
      expect(off.status).toBe(503)
      expect(off.headers.get('content-type')).not.toBe('application/pdf')
    })
  })

  it('rate limits generation per IP and per profile', async () => {
    await withRollback(async (tx) => {
      const f = await fixture(tx)
      const ip = `198.51.100.${tag()}`
      const get = web(tx, at(30), { ip })
      // 없는 handle 요청도 IP 한도에 셉니다(PDF를 만들기 전).
      for (let i = 0; i < PORTFOLIO_PDF_IP_RATE_LIMIT.limit - 1; i++) expect((await get(`nobody-${tag()}`)).status).toBe(404)
      expect((await get(f.handle)).status).toBe(200)
      const limited = await get(f.handle)
      expect(limited.status).toBe(429)
      expect(limited.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      // 다음 창에서는 다시 됩니다.
      expect((await web(tx, at(31), { ip })(f.handle)).status).toBe(200)

      // 프로필 한도: 다른 IP여도 같은 프로필은 창마다 정해진 횟수까지만(위에서 2번 + 채움).
      const now = at(31)
      for (let i = 1; i < PORTFOLIO_PDF_HANDLE_RATE_LIMIT.limit; i++) await hitRateLimit(tx, 'portfolio_pdf_handle', f.handle, PORTFOLIO_PDF_HANDLE_RATE_LIMIT, now)
      const byHandle = await web(tx, now)(f.handle)
      expect(byHandle.status).toBe(429)
      expect(await byHandle.json()).toMatchObject({ data: { code: 'rate_limited' } })
    })
  })
})
