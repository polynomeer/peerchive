/**
 * E-08 지원용 PDF 조판 단위 테스트(DB 없음). 공개 프로필 DTO 하나로 만든 PDF가
 * - `%PDF-` 머리·A4·메타데이터 제목 "<이름> 포트폴리오"·작성자 없음,
 * - 한글 글이 ToUnicode로 다시 뽑히고(글꼴 부분 집합), 근거는 절대 주소 + 링크 주석,
 * - 볼 수 없는 대표 케이스는 글·안내 모두 없음, 그림 문자는 빠지고 긴 주소는 줄을 넘겨도 잘리지 않는지,
 * - 넣은 부분 집합 글꼴의 글리프가 원본 글꼴의 같은 글자와 같은 모양인지(@pdf-lib/fontkit 짧은 loca 버그 회피, pdf.ts) 봅니다.
 * DB·HTTP(한도·404·S-01)는 portfolio-pdf.integration.test.ts.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import fontkit from '@pdf-lib/fontkit'
import { renderPortfolioPdf, portfolioPdfFileName } from '../server/modules/portfolio/pdf'
import type { PublicPortfolioProfileDto } from '../shared/types/api'
import { extractPdfText } from './pdf-text'

const FONT = new Uint8Array(readFileSync(new URL('../server/assets/fonts/Pretendard-Regular.ttf', import.meta.url)))
const ORIGIN = 'https://peerchive.example'
const NOW = new Date('2026-11-02T09:00:00Z')

function profile(overrides: Partial<PublicPortfolioProfileDto> = {}): PublicPortfolioProfileDto {
  return {
    handle: 'pdf-kim',
    displayName: '김피디',
    jobTargets: ['백엔드'],
    schoolLabel: '피어대학교',
    gradTerm: '2027-02',
    contactPolicy: 'on_request',
    contactText: '연락 요청을 검토합니다.',
    openToWork: true,
    headline: '기록으로 말하는 백엔드 지망생',
    featured: [
      {
        anchor: 'case-1',
        available: true,
        title: '수강신청 서버 부하 줄이기',
        jobTarget: 'backend',
        jobTargetLabel: '백엔드',
        path: '/p/load-case',
        releaseVersion: 2,
        termLabel: '2026년 1학기',
        selfLabel: '팀원 A',
        generator: 'ai',
        sections: [
          {
            key: 'problem_result',
            label: '문제와 결과',
            sentences: [
              { text: '대기열을 도입해 응답 시간을 줄였습니다.', reflection: false, citations: [{ label: '⚖️ 결정 · 대기열 도입', path: '/p/load-case#log-l_abc' }] },
              { text: '다시 한다면 부하 시험을 먼저 하겠습니다.', reflection: true, citations: [] },
            ],
          },
        ],
        askQuestions: [{ text: '왜 캐시 대신 대기열을 택했나요?', categoryLabel: '결정', source: { label: '⚖️ 결정 · 대기열 도입', path: '/p/load-case#log-l_abc' } }],
      },
      { anchor: 'case-2', available: false, message: '원본 사례를 더 이상 볼 수 없습니다' },
    ],
    matrix: {
      columns: [
        { ref: 'case-1', title: '수강신청 서버 부하 줄이기', available: true },
        { ref: 'case-2', title: '볼 수 없는 사례', available: false },
      ],
      rows: [
        {
          label: '문제 해결',
          evidenceBacked: true,
          cells: [
            { column: 'case-1', available: true, counts: [{ category: 'decision', label: '결정', count: 1 }], text: '결정 1', evidence: [{ label: '⚖️ 결정 · 대기열 도입', path: '/p/load-case#log-l_abc' }] },
            { column: 'case-2', available: false, counts: [], text: '볼 수 없음', evidence: [] },
          ],
        },
      ],
    },
    evidenceBackedCompetencies: ['문제 해결'],
    skillsDeclared: ['SQL', 'Kotlin'],
    edition: { version: 3, createdAt: NOW.toISOString() },
    juniorContribution: { planForks: 0, seniorNotes: 0, curatedCourses: [], stuckQaAnswers: 0 },
    timeline: [{ termLabel: '2026년 1학기', year: 2026, title: '수강신청 서버 부하 줄이기', path: '/p/load-case' }],
    affiliationBadges: [],
    kind: 'real',
    linkedPersona: null,
    projects: null,
    socialLinks: [{ provider: 'github', url: 'https://github.com/pdf-kim', verified: true }],
    ...overrides,
  }
}

describe('portfolio PDF renderer (E-08)', () => {
  it('writes an A4 PDF whose Korean text, evidence URLs and metadata can be read back', async () => {
    const bytes = await renderPortfolioPdf(profile(), { font: FONT, origin: `${ORIGIN}/`, now: NOW })
    expect(Buffer.from(bytes.slice(0, 5)).toString('latin1')).toBe('%PDF-')
    // 글꼴은 쓴 글자만 넣습니다(원본 TTF 2.7MB보다 훨씬 작음).
    expect(bytes.byteLength).toBeLessThan(200_000)
    const pdf = await extractPdfText(bytes)
    expect(pdf.pageSizes[0]).toEqual({ width: 595.28, height: 841.89 })
    expect(pdf.text).not.toContain('�')
    for (const expected of [
      '김피디 @pdf-kim',
      '“기록으로 말하는 백엔드 지망생”',
      '수강신청 서버 부하 줄이기',
      '대기열을 도입해 응답 시간을 줄였습니다.',
      '[본인 회고] 다시 한다면 부하 시험을 먼저 하겠습니다.',
      // E-14: AI로 다듬은 케이스 표시(공개 화면과 같은 문구).
      'AI로 다듬음 · 다듬은 문장은 모두 근거 기록에 연결됨',
      '이 지원자에게 물어보면 좋은 질문',
      '[결정] 왜 캐시 대신 대기열을 택했나요?',
      '근거: 결정 · 대기열 도입',
      `${ORIGIN}/p/load-case#log-l_abc`,
      `원본 공개 사례: ${ORIGIN}/p/load-case`,
      `온라인 프로필: ${ORIGIN}/u/pdf-kim`,
      '수강신청 서버 부하 줄이기: 결정 1',
      '자기 선언 스킬(본인 입력, 근거 연결 없음): SQL, Kotlin',
      '연락: 연락 요청을 검토합니다.',
      '2026-11-02 생성 · 포트폴리오 판 v3',
      '김피디 포트폴리오 · 1 / 1',
    ]) {
      expect(pdf.text).toContain(expected)
    }
    // 그림 문자(⚖️)는 글꼴에 없어 빼고, 볼 수 없는 케이스는 글·안내 모두 싣지 않습니다.
    expect(pdf.text).not.toContain('⚖')
    expect(pdf.text).not.toContain('원본 사례를 더 이상 볼 수 없습니다')
    expect(pdf.text).not.toContain('볼 수 없는 사례')
    expect(pdf.links).toEqual(expect.arrayContaining([`${ORIGIN}/p/load-case#log-l_abc`, `${ORIGIN}/p/load-case`, `${ORIGIN}/u/pdf-kim`, 'https://github.com/pdf-kim']))
    expect(pdf.info).toEqual({ title: '김피디 포트폴리오', author: undefined, subject: undefined, keywords: undefined, creator: 'Peerchive', producer: 'Peerchive' })
    expect(portfolioPdfFileName('pdf-kim')).toBe('pdf-kim-portfolio.pdf')
  })

  it('wraps long text and URLs across lines and pages without losing characters', async () => {
    const longPath = `/p/${'a'.repeat(180)}#log-l_${'b'.repeat(40)}`
    const sentence = '가나다라마바사 '.repeat(400).trim()
    const p = profile()
    const first = p.featured[0]!
    if (!first.available) throw new Error('fixture')
    first.sections[0]!.sentences = [{ text: sentence, reflection: false, citations: [{ label: '📝 사례 요약', path: longPath }] }]
    const pdf = await extractPdfText(await renderPortfolioPdf(p, { font: FONT, origin: ORIGIN, now: NOW }))
    expect(pdf.pages.length).toBeGreaterThan(1)
    // 쪽 바닥글을 빼고 줄바꿈을 지우면 원래 글과 주소가 그대로 나옵니다.
    const body = pdf.text.replace(/\n김피디 포트폴리오 · \d+ \/ \d+/g, '')
    expect(body.includes(sentence.slice(0, 20)) && body.replace(/\n/g, ' ').includes(sentence), 'sentence survives wrapping').toBe(true)
    expect(body.replace(/\n/g, '').includes(`${ORIGIN}${longPath}`), 'url survives wrapping').toBe(true)
    expect(pdf.text).toContain(`김피디 포트폴리오 · ${pdf.pages.length} / ${pdf.pages.length}`)
  })

  it('replaces characters the font lacks and keeps an empty portfolio readable', async () => {
    const p = profile({ featured: [], matrix: { columns: [], rows: [] }, evidenceBackedCompetencies: [], skillsDeclared: [], timeline: [], socialLinks: [], headline: '漢字 한 줄 🧱', edition: null })
    const pdf = await extractPdfText(await renderPortfolioPdf(p, { font: FONT, origin: ORIGIN, now: NOW }))
    expect(pdf.text).toContain('공개된 대표 케이스 스터디가 없습니다.')
    expect(pdf.text).not.toContain('�')
    expect(pdf.text).toMatch(/“\?\? 한 줄”/)
    expect(pdf.text).not.toContain('포트폴리오 판 v')
  })

  it('embeds subset glyphs identical to the source font (no blank glyphs from misaligned loca offsets)', async () => {
    const pdf = await extractPdfText(await renderPortfolioPdf(profile(), { font: FONT, origin: ORIGIN, now: NOW }))
    expect(pdf.fonts).toHaveLength(1)
    const source = fontkit.create(Buffer.from(FONT))
    const subset = fontkit.create(Buffer.from(pdf.fonts[0]!.fontFile))
    // pdf-lib처럼 줄마다 원본 글꼴로 조판해(문맥 대체 글리프 포함) 원본 글리프 모양을 모읍니다. 글리프의 codePoints는 캐시 때문에
    // 비어 있을 수 있어 글자별로 묶지 않고, 글자의 기본 글리프 + 조판 결과 전체와 비교합니다.
    const shape = (g: { advanceWidth: number; path: { toSVG(): string } }) => `${g.advanceWidth}:${g.path.toSVG()}`
    const shapes = new Set<string>()
    for (const line of pdf.text.split('\n')) for (const glyph of source.layout(line).glyphs) shapes.add(shape(glyph))
    let compared = 0
    for (const [gid, text] of pdf.fonts[0]!.toUnicode) {
      if ([...text].length !== 1 || /\s/u.test(text)) continue
      const embedded = subset.getGlyph(gid)
      expect(embedded.path.toSVG(), text).not.toBe('')
      const own = shape(source.glyphForCodePoint(text.codePointAt(0)!))
      expect(shape(embedded) === own || shapes.has(shape(embedded)), `glyph for ${text} differs from the source font`).toBe(true)
      compared++
    }
    // 한글·영문·문장 부호를 합쳐 수십 글자 이상을 비교합니다.
    expect(compared).toBeGreaterThan(80)
  })
})
