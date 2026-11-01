/**
 * 테스트용 PDF 글 추출(E-08). 새 의존성 없이 pdf-lib로 PDF를 다시 읽고, PDF 뷰어가 글을 복사할 때 쓰는 것과 같은 ToUnicode 표로
 * 내용 스트림의 글자 코드를 유니코드로 되돌립니다. 우리 PDF(pdf-lib `drawText`: `/F 크기 Tf` + `<hex> Tj`)만 읽으면 되므로 일반 PDF 파서가 아닙니다.
 */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, PDFString, PDFHexString, decodePDFRawStream } from 'pdf-lib'

export interface ExtractedPdf {
  /** 쪽마다 Tj 하나를 한 줄로 이은 글. */
  pages: string[]
  text: string
  /** 링크 주석의 URI. */
  links: string[]
  info: { title?: string; author?: string; subject?: string; keywords?: string; creator?: string; producer?: string }
  pageSizes: Array<{ width: number; height: number }>
  /** 넣은 글꼴(부분 집합 TrueType 파일)과 그 ToUnicode 표(글리프 id → 글자). */
  fonts: Array<{ fontFile: Uint8Array; toUnicode: Map<number, string> }>
}

const decodeStream = (stream: PDFRawStream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')

/** UTF-16BE hex → 문자열. */
const utf16 = (hex: string) => {
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
  return out
}

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>()
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(parseInt(m[1]!, 16), utf16(m[2]!))
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const [lo, hi, start] = [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)]
      for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(start + (c - lo)))
    }
  }
  return map
}

export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedPdf> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const pages: string[] = []
  const links: string[] = []
  const embedded = new Map<string, { fontFile: Uint8Array; toUnicode: Map<number, string> }>()
  for (const page of doc.getPages()) {
    const fonts = new Map<string, Map<number, string>>()
    const fontDict = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict)
    for (const [name, ref] of fontDict?.entries() ?? []) {
      const font = doc.context.lookup(ref, PDFDict)
      const toUnicode = font.lookupMaybe(PDFName.of('ToUnicode'), PDFStream) as PDFRawStream | undefined
      const cmap = toUnicode ? parseToUnicode(decodeStream(toUnicode)) : new Map<number, string>()
      fonts.set(name.asString(), cmap)
      const descriptor = font.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookup(0, PDFDict).lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)
      const fontFile = descriptor?.lookupMaybe(PDFName.of('FontFile2'), PDFStream) as PDFRawStream | undefined
      if (fontFile) embedded.set(ref.toString(), { fontFile: decodePDFRawStream(fontFile).decode(), toUnicode: cmap })
    }
    const contents = page.node.Contents()
    const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r, PDFStream) as PDFRawStream) : contents ? [contents as PDFRawStream] : []
    const lines: string[] = []
    for (const stream of streams) {
      let current = new Map<number, string>()
      for (const m of decodeStream(stream).matchAll(/(\/\S+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f]*)>\s*Tj/g)) {
        if (m[1]) {
          current = fonts.get(m[1]) ?? new Map()
          continue
        }
        const hex = m[2]!
        let line = ''
        for (let i = 0; i + 4 <= hex.length; i += 4) line += current.get(parseInt(hex.slice(i, i + 4), 16)) ?? '�'
        lines.push(line)
      }
    }
    pages.push(lines.join('\n'))
    for (const ref of page.node.Annots()?.asArray() ?? []) {
      const action = doc.context.lookup(ref, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict)
      const uri = action?.lookupMaybe(PDFName.of('URI'), PDFString, PDFHexString)
      if (uri) links.push(uri.decodeText())
    }
  }
  return {
    pages,
    text: pages.join('\n'),
    links,
    info: {
      title: doc.getTitle(),
      author: doc.getAuthor(),
      subject: doc.getSubject(),
      keywords: doc.getKeywords(),
      creator: doc.getCreator(),
      producer: doc.getProducer(),
    },
    pageSizes: doc.getPages().map((p) => p.getSize()),
    fonts: [...embedded.values()],
  }
}
