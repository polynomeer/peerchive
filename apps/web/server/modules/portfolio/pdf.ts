/**
 * 지원용 PDF (E-08, PROOFU_EVOLUTION_PLAN §10.6 "지원용 PDF 개선", DELIVERY_PLAN §4.4, ADR 0052).
 *
 * 입력은 **공개 프로필 DTO 하나뿐**입니다(`getPublicPortfolioProfile` — 인쇄 보기 `/u/:handle/print`가 그리는 것과 같은 응답).
 * 이 파일은 DB를 읽지 않으므로 PDF에는 공개 프로필에 없는 정보(이메일·내부 id·비공개 기록·연결을 끈 상대 페르소나)가 들어갈 길이 없습니다.
 *
 * - A4, 한글 글꼴(Pretendard Regular, OFL)을 쓰는 글자만 부분 집합으로 넣습니다(pdf-lib + @pdf-lib/fontkit, 순수 JS, 브라우저·네이티브 의존 없음).
 *   ToUnicode 표가 함께 들어가 PDF 뷰어에서 글을 복사·검색할 수 있습니다.
 * - 대표 케이스는 지금 볼 수 있는 것(`available`)만 싣습니다. 게시 취소·숨김·철회·대체·엠바고한 케이스는 안내 문구도 없이 뺍니다.
 * - 근거는 출처 이름과 **절대 주소**(사이트 origin + 공개 사례의 기록 앵커)를 함께 적고, 주소에 링크 주석을 붙입니다.
 * - 글꼴에 없는 글자: 그림 문자(출처 이름의 🧱·⚖️ 등)는 빼고, 그 밖의 글자는 `?`로 바꿉니다.
 * - 메타데이터: 제목 = "<표시 이름> 포트폴리오", 만든 프로그램 = Peerchive, 언어 ko-KR. 작성자·주제·키워드(이메일·id)는 넣지 않습니다.
 */
import { PDFDocument, PDFString, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { INTERVIEW_PUBLIC_HEADING, REFLECTION_LABEL, SOCIAL_LINK_PROVIDER_LABELS, SOCIAL_LINK_VERIFIED_LABEL, SOCIAL_LINK_VERIFIED_NOTE } from '@peerchive/domain'
import type { PublicPortfolioProfileDto } from '../../../shared/types/api'

/** A4(pt). */
const PAGE_SIZE: [number, number] = [595.28, 841.89]
const MARGIN_X = 50
const MARGIN_TOP = 56
const MARGIN_BOTTOM = 60
const CONTENT_WIDTH = PAGE_SIZE[0] - MARGIN_X * 2

const INK = rgb(0.1, 0.1, 0.12)
const MUTED = rgb(0.38, 0.38, 0.42)
const LINK = rgb(0.06, 0.33, 0.66)

export const PORTFOLIO_PDF_MEDIA_TYPE = 'application/pdf'
export const PORTFOLIO_PDF_FOOTNOTE =
  '모든 문장의 출처는 동의를 받아 공개된 사례 기록입니다. 원본 사례가 철회되면 온라인 프로필에서 바로 닫히지만, 이미 내려받은 PDF는 회수되지 않습니다.'

export interface PortfolioPdfOptions {
  /** 한글 글꼴(TTF) 바이트. 서버는 `server/assets/fonts/Pretendard-Regular.ttf`를 씁니다. */
  font: Uint8Array
  /** 절대 주소를 만들 사이트 origin(NUXT_SITE_ORIGIN 첫 항목). */
  origin: string
  /** 생성 시각(바닥글의 날짜·PDF 생성 시각). */
  now: Date
}

/** PDF 파일 이름(handle은 영문·숫자·`-`·`_`). */
export const portfolioPdfFileName = (handle: string) => `${handle}-portfolio.pdf`

const EMOJI_LIKE = /[\p{Extended_Pictographic}\u200d\ufe0e\ufe0f\u20e3]/u

/**
 * @pdf-lib/fontkit 1.1.1의 TrueType 부분 집합 버그를 비켜 가는 감쌈. 부분 집합은 glyf 오프셋이 0xffff 이하이면 짧은 loca(오프셋/2)로
 * 쓰는데, 원본 글리프 길이가 홀수이면(Pretendard는 긴 loca라 홀수 길이 글리프가 많음) 그 뒤 글리프의 오프셋이 어긋나 뷰어에서 글자가
 * 빈칸으로 그려집니다(ToUnicode는 맞아서 글 추출은 됨). 부분 집합에 글리프를 넣을 때마다 짝수 길이로 0 한 바이트를 채웁니다(글리프 끝의
 * 채움 바이트는 TrueType 명세상 허용, 글꼴 파일 자체는 바꾸지 않음). 회귀는 portfolio-pdf.test.ts가 부분 집합 글리프를 원본과 비교해 막습니다.
 */
interface SubsetInternals {
  glyf: Uint8Array[]
  offset: number
  _addGlyph(gid: number): number
}

const evenGlyphFontkit: Parameters<PDFDocument['registerFontkit']>[0] = {
  create(data, postscriptName) {
    const font = fontkit.create(data, postscriptName)
    const createSubset = font.createSubset.bind(font)
    font.createSubset = () => {
      const subset = createSubset()
      const internals = subset as unknown as SubsetInternals
      const addGlyph = internals._addGlyph.bind(subset)
      internals._addGlyph = (gid: number) => {
        const index = addGlyph(gid)
        const buffer = internals.glyf[index]!
        if (buffer.length % 2 === 1) {
          // fontkit 번들이 쓰는 자체 Buffer 구현과 같은 종류로 만듭니다(Node Buffer는 그 인코더가 받지 않음).
          const Ctor = buffer.constructor as unknown as { alloc?: (size: number) => Uint8Array }
          const padded = Ctor.alloc ? Ctor.alloc(buffer.length + 1) : new Uint8Array(buffer.length + 1)
          padded.set(buffer)
          internals.glyf[index] = padded
          internals.offset += 1
        }
        return index
      }
      return subset
    }
    return font
  },
}

/** 서울 날짜(YYYY-MM-DD). */
const seoulDate = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(d)

interface TextStyle {
  size: number
  color?: RGB
  indent?: number
  /** 앞 여백(pt). */
  before?: number
  /** 줄 전체에 걸 링크(절대 주소). */
  link?: string
  /** 둘째 줄부터 더 들일 폭(글머리표 `• ` 뒤에 맞춤). */
  hang?: boolean
}

/** 글을 한 줄씩 쌓아 가며 쪽을 넘기는 작은 조판기. */
class Writer {
  page!: PDFPage
  y = 0
  readonly pages: PDFPage[] = []

  constructor(
    readonly doc: PDFDocument,
    readonly font: PDFFont,
    private readonly glyphs: ReadonlySet<number>,
  ) {
    this.newPage()
  }

  newPage() {
    this.page = this.doc.addPage(PAGE_SIZE)
    this.pages.push(this.page)
    this.y = PAGE_SIZE[1] - MARGIN_TOP
  }

  /** 글꼴에 없는 글자를 정리하고 공백을 한 칸으로 모읍니다. */
  clean(text: string): string {
    let out = ''
    for (const ch of text.normalize('NFC')) {
      const cp = ch.codePointAt(0)!
      if (/\s/u.test(ch)) out += ' '
      else if (this.glyphs.has(cp)) out += ch
      else if (!EMOJI_LIKE.test(ch)) out += '?'
    }
    return out.replace(/ {2,}/g, ' ').trim()
  }

  width(text: string, size: number) {
    return this.font.widthOfTextAtSize(text, size)
  }

  /** 단어 단위로 줄을 나누고, 한 단어가 줄보다 길면(주소 등) 글자 단위로 자릅니다. */
  wrap(text: string, size: number, maxWidth: number): string[] {
    const lines: string[] = []
    let line = ''
    for (const word of text.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (this.width(candidate, size) <= maxWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      line = ''
      let rest = word
      while (this.width(rest, size) > maxWidth) {
        let cut = 1
        while (cut < rest.length && this.width(rest.slice(0, cut + 1), size) <= maxWidth) cut++
        lines.push(rest.slice(0, cut))
        rest = rest.slice(cut)
      }
      line = rest
    }
    if (line) lines.push(line)
    return lines
  }

  gap(pt: number) {
    this.y -= pt
  }

  text(raw: string, style: TextStyle) {
    const text = this.clean(raw)
    if (!text) return
    const indent = style.indent ?? 0
    const hang = style.hang ? this.width('• ', style.size) : 0
    const lineHeight = style.size * 1.45
    const lines = this.wrap(text, style.size, CONTENT_WIDTH - indent - hang)
    if (style.before) this.y -= style.before
    for (const [i, line] of lines.entries()) {
      if (this.y - lineHeight < MARGIN_BOTTOM) this.newPage()
      this.y -= lineHeight
      const x = MARGIN_X + indent + (i > 0 ? hang : 0)
      const baseline = this.y + (lineHeight - style.size) / 2 + style.size * 0.2
      this.page.drawText(line, { x, y: baseline, size: style.size, font: this.font, color: style.color ?? INK })
      if (style.link) this.linkAnnotation(style.link, x, baseline - style.size * 0.25, this.width(line, style.size), style.size * 1.2)
    }
  }

  /** 주소 영역에 URI 링크 주석을 붙입니다(테두리 없음). */
  private linkAnnotation(url: string, x: number, y: number, w: number, h: number) {
    const annot = this.doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    })
    this.page.node.addAnnot(this.doc.context.register(annot))
  }

  heading(text: string, size: number) {
    // 제목이 쪽 맨 아래에 홀로 남지 않게 다음 줄 몇 개 자리를 미리 봅니다.
    if (this.y - size * 1.45 * 3 < MARGIN_BOTTOM) this.newPage()
    this.text(text, { size, before: size * 0.9 })
  }

  /** 출처 이름 + 절대 주소(주소에 링크). */
  evidence(label: string, url: string, indent: number) {
    this.text(`근거: ${label}`, { size: 8, color: MUTED, indent })
    this.text(url, { size: 8, color: LINK, indent: indent + 10, link: url })
  }
}

/**
 * 공개 프로필 DTO로 지원용 PDF를 만듭니다. 인쇄 보기와 같은 순서(머리글 → 대표 케이스 → 역량 × 근거 → 역량과 스킬 → 과제 수행 목록 → 타임라인 → 안내)입니다.
 */
export async function renderPortfolioPdf(profile: PublicPortfolioProfileDto, options: PortfolioPdfOptions): Promise<Uint8Array> {
  const base = options.origin.replace(/\/+$/, '')
  const abs = (path: string) => `${base}${path.startsWith('/') ? path : `/${path}`}`
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.registerFontkit(evenGlyphFontkit)
  const font = await doc.embedFont(options.font, { subset: true })
  const w = new Writer(doc, font, new Set(font.getCharacterSet()))

  // ── 머리글 ──
  const profileUrl = abs(`/u/${profile.handle}`)
  w.text('Peerchive 포트폴리오', { size: 9, color: MUTED })
  w.text(`${profile.displayName} @${profile.handle}`, { size: 18, before: 2 })
  if (profile.kind === 'display') w.text('표시명 프로필', { size: 9, color: MUTED })
  // 상대 페르소나(S-01)는 DTO에 있을 때(본인이 연결을 켰을 때)만.
  if (profile.linkedPersona) {
    const linked = profile.linkedPersona
    w.text(`${linked.kind === 'real' ? '실명 프로필' : '표시명 프로필'}: ${linked.displayName} @${linked.handle} · 본인이 두 프로필의 연결을 공개했습니다.`, { size: 9, before: 2 })
    w.text(abs(`/u/${linked.handle}`), { size: 9, color: LINK, link: abs(`/u/${linked.handle}`) })
  }
  const target = [profile.jobTargets.length ? `${profile.jobTargets.join(', ')} 지망` : '', profile.gradTerm ? `${profile.gradTerm} 졸업(예정)` : '']
    .filter(Boolean)
    .join(' · ')
  if (target) w.text(target, { size: 10, before: 4 })
  if (profile.schoolLabel) w.text(`학교(본인 입력): ${profile.schoolLabel}`, { size: 9, color: MUTED })
  if (profile.affiliationBadges.length) w.text(`학교 인증: ${profile.affiliationBadges.map((b) => b.label).join(', ')}`, { size: 9, color: MUTED })
  if (profile.headline) w.text(`“${w.clean(profile.headline)}”`, { size: 11.5, before: 6 })
  w.text(`${profile.openToWork ? '구직 중 · ' : ''}연락: ${profile.contactText}`, { size: 9, before: 4 })
  w.text(`온라인 프로필: ${profileUrl}`, { size: 9, color: LINK, link: profileUrl })
  if (profile.socialLinks.length) {
    for (const link of profile.socialLinks) {
      w.text(`${SOCIAL_LINK_PROVIDER_LABELS[link.provider]}: ${link.url}${link.verified ? ` (${SOCIAL_LINK_VERIFIED_LABEL})` : ''}`, { size: 9, link: link.url })
    }
    if (profile.socialLinks.some((l) => l.verified)) w.text(`${SOCIAL_LINK_VERIFIED_LABEL}: ${SOCIAL_LINK_VERIFIED_NOTE}.`, { size: 8, color: MUTED })
  }

  // ── 대표 케이스(지금 볼 수 있는 것만) ──
  const cases = profile.featured.filter((f) => f.available)
  w.heading('대표 케이스 스터디', 13)
  if (!cases.length) w.text('공개된 대표 케이스 스터디가 없습니다.', { size: 9.5, color: MUTED })
  for (const c of cases) {
    if (!c.available) continue
    w.heading(c.title, 11.5)
    w.text([`${c.jobTargetLabel} 관점`, c.termLabel, `공개 버전 v${c.releaseVersion}`, `사례 속 본인 표시: ${c.selfLabel}`].filter(Boolean).join(' · '), { size: 8.5, color: MUTED })
    w.text(`원본 공개 사례: ${abs(c.path)}`, { size: 8.5, color: LINK, link: abs(c.path) })
    for (const section of c.sections) {
      w.text(section.label, { size: 10, before: 5 })
      for (const s of section.sentences) {
        w.text(`• ${s.reflection ? `[${REFLECTION_LABEL}] ` : ''}${s.text}`, { size: 9.5, indent: 8, hang: true, before: 1 })
        for (const cite of s.citations) w.evidence(cite.label, abs(cite.path), 18)
      }
    }
    if (c.askQuestions.length) {
      w.text(INTERVIEW_PUBLIC_HEADING, { size: 10, before: 5 })
      for (const q of c.askQuestions) {
        w.text(`• [${q.categoryLabel}] ${q.text}`, { size: 9.5, indent: 8, hang: true, before: 1 })
        if (q.source) w.evidence(q.source.label, abs(q.source.path), 18)
      }
      w.text('지원자가 고른 질문입니다. 답변은 싣지 않습니다.', { size: 8, color: MUTED, indent: 8 })
    }
  }

  // ── 역량 × 근거(지금 볼 수 있는 케이스 칸만) ──
  if (profile.matrix.rows.length) {
    w.heading('역량 × 근거', 13)
    w.text('칸에는 근거의 종류와 개수만 적습니다. 점수나 수준을 매기지 않습니다.', { size: 8, color: MUTED })
    const titleOf = new Map(profile.matrix.columns.map((col) => [col.ref, col.title]))
    for (const row of profile.matrix.rows) {
      w.text(`${row.label}${row.evidenceBacked ? '' : ' (아직 근거 없음)'}`, { size: 10, before: 5 })
      for (const cell of row.cells) {
        if (!cell.available) continue
        w.text(`${titleOf.get(cell.column) ?? ''}: ${cell.text}`, { size: 9, indent: 8 })
        for (const e of cell.evidence) w.evidence(e.label, abs(e.path), 18)
      }
    }
  }

  if (profile.evidenceBackedCompetencies.length || profile.skillsDeclared.length) {
    w.heading('역량과 스킬', 13)
    if (profile.evidenceBackedCompetencies.length) w.text(`경험 근거가 있는 역량: ${profile.evidenceBackedCompetencies.join(', ')}`, { size: 9.5 })
    if (profile.skillsDeclared.length) w.text(`자기 선언 스킬(본인 입력, 근거 연결 없음): ${profile.skillsDeclared.join(', ')}`, { size: 9.5 })
  }

  // 과제 수행 목록(S-03): 공개 DTO에 있을 때(전체 공개)만.
  if (profile.projects?.length) {
    w.heading('과제 수행 목록', 13)
    for (const p of profile.projects) {
      const parts = [p.courseTitle ?? '과목 미연결 과제', p.termLabel, p.title ?? '제목 비공개 기간(엠바고)'].filter(Boolean)
      w.text(`• ${parts.join(' · ')}`, { size: 9, indent: 8, hang: true })
    }
  }

  if (profile.timeline.length) {
    w.heading('과제 타임라인', 13)
    for (const item of profile.timeline) {
      w.text(`• ${item.year} · ${item.termLabel ? `${item.termLabel} · ` : ''}${item.title}`, { size: 9, indent: 8, hang: true })
      w.text(abs(item.path), { size: 8, color: LINK, indent: 18, link: abs(item.path) })
    }
  }

  // ── 안내 ──
  w.gap(10)
  w.text(PORTFOLIO_PDF_FOOTNOTE, { size: 8, color: MUTED })
  w.text(
    `${seoulDate(options.now)} 생성${profile.edition ? ` · 포트폴리오 판 v${profile.edition.version}` : ''} · 점수·순위를 매기지 않습니다. 최신 내용은 온라인 프로필에서 확인하세요.`,
    { size: 8, color: MUTED },
  )

  // 쪽 바닥글: 이름 · 쪽 번호.
  const footerName = w.clean(`${profile.displayName} 포트폴리오`)
  w.pages.forEach((page, i) => {
    page.drawText(`${footerName} · ${i + 1} / ${w.pages.length}`, { x: MARGIN_X, y: MARGIN_BOTTOM / 2, size: 7.5, font, color: MUTED })
  })

  // 메타데이터: 이름 + "포트폴리오"만. 작성자·주제·키워드는 비워 둡니다(이메일·id 없음).
  doc.setTitle(`${profile.displayName} 포트폴리오`, { showInWindowTitleBar: true })
  doc.setCreator('Peerchive')
  doc.setProducer('Peerchive')
  doc.setLanguage('ko-KR')
  doc.setCreationDate(options.now)
  doc.setModificationDate(options.now)
  return doc.save()
}
