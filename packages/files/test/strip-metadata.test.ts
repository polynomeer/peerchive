/**
 * 메타데이터 제거 단위 테스트. 표본은 실제 1×1 이미지(samples.ts)에 메타데이터 세그먼트·청크·블록을 바이트로 끼워 만듭니다.
 */
import { crc32 } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  MetadataStripError,
  findPdfMetadata,
  orientationExifSegment,
  processMetadata,
  sniff,
  stripGif,
  stripJpeg,
  stripPng,
  stripWebp,
} from '../src'
import { GIF_1x1, JPEG_1x1, PDF_MINIMAL, PNG_1x1, WEBP_1x1 } from './samples'

const ascii = (text: string) => Buffer.from(text, 'latin1')
const indexOf = (buf: Buffer, text: string | Buffer) => buf.indexOf(typeof text === 'string' ? ascii(text) : text)

// ── JPEG ─────────────────────────────────────────────────────────────────

function segment(marker: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xff00 | marker, 0)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([header, payload])
}

/** IFD0(Orientation, GPS 포인터, Make) + GPS IFD(위도 참조 'N', 위도 값 표식) + IFD1(썸네일) 을 담은 EXIF TIFF. */
function exifTiff(orientation: number, littleEndian: boolean): Buffer {
  const tiff = Buffer.alloc(200)
  const w16 = (v: number, at: number) => (littleEndian ? tiff.writeUInt16LE(v, at) : tiff.writeUInt16BE(v, at))
  const w32 = (v: number, at: number) => (littleEndian ? tiff.writeUInt32LE(v, at) : tiff.writeUInt32BE(v, at))
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1')
  w16(42, 2)
  w32(8, 4)
  // IFD0: 3 entries
  w16(3, 8)
  w16(0x010f, 10) // Make (ASCII, 8 bytes at 100)
  w16(2, 12)
  w32(8, 14)
  w32(100, 18)
  w16(0x0112, 22) // Orientation
  w16(3, 24)
  w32(1, 26)
  w16(orientation, 30)
  w16(0x8825, 34) // GPS IFD pointer
  w16(4, 36)
  w32(1, 38)
  w32(120, 42)
  w32(160, 46) // next IFD(IFD1, 썸네일)
  tiff.write('PhoneCo\0', 100, 'latin1')
  // GPS IFD at 120: GPSLatitudeRef 'N', GPSLatitude 표식 문자열
  w16(2, 120)
  w16(0x0001, 122)
  w16(2, 124)
  w32(2, 126)
  tiff.write('N\0', 130, 'latin1')
  w16(0x0002, 134)
  w16(2, 136)
  w32(12, 138)
  w32(146, 142)
  tiff.write('GPS37.5665N\0', 146, 'latin1')
  w32(0, 158)
  // IFD1 at 160: 0 entries
  w16(0, 160)
  w32(0, 162)
  return tiff
}

const APP0 = JPEG_1x1.subarray(2, 20) // 원래 JFIF APP0(18바이트)
const AFTER_APP0 = JPEG_1x1.subarray(20) // DQT, SOF, DHT, SOS
const SCAN_TAIL = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]) // 엔트로피 데이터(stuffing·RST) + EOI
const ICC = segment(0xe2, ascii('ICC_PROFILE\0\x01\x01fake-icc-profile-bytes'))
const ADOBE = segment(0xee, ascii('Adobe\0\x64\x00\x00\x00\x00\x01'))

function jpegWith(orientation: number, littleEndian = true, extra: Buffer[] = []): Buffer {
  return Buffer.concat([
    JPEG_1x1.subarray(0, 2),
    APP0,
    segment(0xe1, Buffer.concat([ascii('Exif\0\0'), exifTiff(orientation, littleEndian)])),
    segment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><dc:creator>Kim</dc:creator></x:xmpmeta>')),
    ICC,
    segment(0xed, ascii('Photoshop 3.0\x008BIM\x04\x04IPTC-byline')),
    segment(0xfe, ascii('shot at home')),
    segment(0xe5, ascii('VendorPrivate\0data')),
    ADOBE,
    ...extra,
    AFTER_APP0,
    SCAN_TAIL,
  ])
}

/** 첫 SOS 전 세그먼트의 마커 목록. */
function markersBeforeSos(buf: Buffer): number[] {
  const markers: number[] = []
  let pos = 2
  while (pos < buf.length) {
    const marker = buf[pos + 1]!
    markers.push(marker)
    if (marker === 0xda) break
    pos += 2 + buf.readUInt16BE(pos + 2)
  }
  return markers
}

const sosSuffix = (buf: Buffer) => buf.subarray(indexOf(buf, Buffer.from([0xff, 0xda])))

describe('stripJpeg', () => {
  it('removes EXIF (GPS), XMP, COM, IPTC and other APPn; keeps JFIF/ICC/Adobe; rewrites orientation 6 only; scan data identical', () => {
    const input = jpegWith(6)
    const { content, report } = stripJpeg(input)
    expect(sniff(content)).toBe('image/jpeg')
    for (const secret of ['GPS37.5665N', 'PhoneCo', 'xmpmeta', 'Kim', 'shot at home', 'Photoshop', 'IPTC-byline', 'VendorPrivate']) {
      expect(indexOf(content, secret)).toBe(-1)
    }
    expect(markersBeforeSos(content)).toEqual([0xe0, 0xe1, 0xe2, 0xee, 0xdb, 0xc2, 0xc4, 0xda])
    // 새 APP1에는 Orientation 하나뿐입니다.
    const app1 = content.subarray(2 + APP0.length, 2 + APP0.length + 36)
    expect(app1.equals(orientationExifSegment(6, true))).toBe(true)
    expect(app1.readUInt16BE(2)).toBe(34)
    const tiff = app1.subarray(10)
    expect(tiff.toString('latin1', 0, 2)).toBe('II')
    expect(tiff.readUInt16LE(8)).toBe(1) // 항목 1개
    expect(tiff.readUInt16LE(10)).toBe(0x0112)
    expect(tiff.readUInt16LE(18)).toBe(6)
    expect(tiff.readUInt32LE(22)).toBe(0) // 다음 IFD 없음
    expect(indexOf(content, ICC)).toBeGreaterThan(0)
    expect(indexOf(content, ADOBE)).toBeGreaterThan(0)
    expect(sosSuffix(content).equals(sosSuffix(input))).toBe(true)
    expect(report).toEqual({
      format: 'jpeg',
      removed: ['exif', 'gps', 'thumbnail', 'xmp', 'iptc', 'comment', 'app_segment'],
      orientation: 6,
    })
  })

  it('keeps big-endian byte order for the rewritten orientation', () => {
    const { content, report } = stripJpeg(jpegWith(8, false))
    const tiff = content.subarray(2 + APP0.length + 10, 2 + APP0.length + 36)
    expect(tiff.toString('latin1', 0, 2)).toBe('MM')
    expect(tiff.readUInt16BE(2)).toBe(42)
    expect(tiff.readUInt16BE(10)).toBe(0x0112)
    expect(tiff.readUInt16BE(18)).toBe(8)
    expect(report.orientation).toBe(8)
  })

  it('orientation 1 → no APP1 at all', () => {
    const { content, report } = stripJpeg(jpegWith(1))
    expect(markersBeforeSos(content)).not.toContain(0xe1)
    expect(report.orientation).toBeNull()
    expect(indexOf(content, 'Exif')).toBe(-1)
  })

  it('is idempotent and leaves a clean JPEG byte-identical', () => {
    const once = stripJpeg(jpegWith(6)).content
    expect(stripJpeg(once).content.equals(once)).toBe(true)
    expect(stripJpeg(JPEG_1x1).content.equals(JPEG_1x1)).toBe(true)
    expect(stripJpeg(JPEG_1x1).report.removed).toEqual([])
  })

  it('drops the JFIF thumbnail and anything appended after EOI', () => {
    const jfifWithThumb = segment(0xe0, Buffer.concat([ascii('JFIF\0\x01\x01\x00\x00\x48\x00\x48\x01\x01'), Buffer.alloc(3, 0x7f)]))
    const input = Buffer.concat([JPEG_1x1.subarray(0, 2), jfifWithThumb, AFTER_APP0, SCAN_TAIL, ascii('MPF-second-image')])
    const { content, report } = stripJpeg(input)
    expect(content.subarray(2, 20).equals(APP0.subarray(0, 18))).toBe(false) // 다시 쓴 JFIF
    expect(content.readUInt16BE(4)).toBe(16)
    expect(content[18]).toBe(0)
    expect(content[19]).toBe(0)
    expect(indexOf(content, 'MPF-second-image')).toBe(-1)
    expect(content.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true)
    expect(report.removed).toEqual(['thumbnail', 'trailing_data'])
  })

  it('throws a typed error for truncated or malformed files (never returns them unstripped)', () => {
    const input = jpegWith(6)
    const cut = input.subarray(0, 2 + APP0.length + 30) // APP1 중간에서 잘림
    expect(() => stripJpeg(cut)).toThrow(MetadataStripError)
    try {
      stripJpeg(cut)
    } catch (error) {
      expect(error).toMatchObject({ code: 'truncated', format: 'jpeg' })
    }
    expect(() => stripJpeg(input.subarray(0, 2 + APP0.length))).toThrow(expect.objectContaining({ code: 'truncated' }))
    const garbage = Buffer.concat([JPEG_1x1.subarray(0, 2), APP0, Buffer.from([0x00, 0x11, 0x22])])
    expect(() => stripJpeg(garbage)).toThrow(expect.objectContaining({ code: 'malformed' }))
    expect(() => stripJpeg(PNG_1x1)).toThrow(MetadataStripError)
  })
})

// ── PNG ──────────────────────────────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

interface PngChunk {
  type: string
  data: Buffer
  crcOk: boolean
}

function chunksOf(png: Buffer): PngChunk[] {
  const out: PngChunk[] = []
  let pos = 8
  while (pos < png.length) {
    const length = png.readUInt32BE(pos)
    const type = png.toString('latin1', pos + 4, pos + 8)
    const data = png.subarray(pos + 8, pos + 8 + length)
    const crcOk = crc32(png.subarray(pos + 4, pos + 8 + length)) === png.readUInt32BE(pos + 8 + length)
    out.push({ type, data, crcOk })
    pos += 12 + length
  }
  return out
}

const PNG_IHDR_END = 8 + 25
const pngWithMetadata = () =>
  Buffer.concat([
    PNG_1x1.subarray(0, PNG_IHDR_END),
    chunk('sRGB', Buffer.from([0])),
    chunk('tEXt', ascii('Author\0Kim Student')),
    chunk('eXIf', Buffer.concat([ascii('MM\0*'), ascii('GPS37.5665N')])),
    chunk('iTXt', ascii('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>')),
    chunk('tIME', Buffer.from([0x07, 0xea, 10, 20, 9, 0, 0])),
    chunk('pHYs', Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
    chunk('prVt', ascii('private')),
    PNG_1x1.subarray(PNG_IHDR_END, -12), // IDAT
    chunk('zTXt', Buffer.concat([ascii('Comment\0\0'), Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])])),
    PNG_1x1.subarray(-12), // IEND
  ])

describe('stripPng', () => {
  it('drops tEXt/zTXt/iTXt/eXIf/tIME and private chunks; keeps IHDR/sRGB/pHYs/IDAT/IEND byte-identical with valid CRCs', () => {
    const input = pngWithMetadata()
    const { content, report } = stripPng(input)
    expect(sniff(content)).toBe('image/png')
    const chunks = chunksOf(content)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'sRGB', 'pHYs', 'IDAT', 'IEND'])
    expect(chunks.every((c) => c.crcOk)).toBe(true)
    const idat = (buf: Buffer) => chunksOf(buf).find((c) => c.type === 'IDAT')!.data
    expect(idat(content).equals(idat(input))).toBe(true)
    for (const secret of ['Kim Student', 'GPS37', 'xmpmeta', 'private']) expect(indexOf(content, secret)).toBe(-1)
    expect(report).toEqual({ format: 'png', removed: ['text', 'exif', 'time', 'chunk'], orientation: null })
    expect(stripPng(content).content.equals(content)).toBe(true)
    expect(stripPng(PNG_1x1).content.equals(PNG_1x1)).toBe(true)
  })

  it('drops data after IEND and rejects truncated files, bad CRCs and a missing IHDR', () => {
    const { content, report } = stripPng(Buffer.concat([PNG_1x1, ascii('PK appended')]))
    expect(content.equals(PNG_1x1)).toBe(true)
    expect(report.removed).toEqual(['trailing_data'])
    expect(() => stripPng(PNG_1x1.subarray(0, PNG_1x1.length - 6))).toThrow(expect.objectContaining({ code: 'truncated', format: 'png' }))
    const badCrc = Buffer.from(pngWithMetadata())
    badCrc[PNG_IHDR_END + 8 + 1 + 1]! ^= 0xff // sRGB CRC
    expect(() => stripPng(badCrc)).toThrow(expect.objectContaining({ code: 'malformed' }))
    const noIhdr = Buffer.concat([PNG_1x1.subarray(0, 8), chunk('tEXt', ascii('a\0b')), PNG_1x1.subarray(8)])
    expect(() => stripPng(noIhdr)).toThrow(expect.objectContaining({ code: 'malformed' }))
  })
})

// ── WebP ─────────────────────────────────────────────────────────────────

function riffChunk(fourcc: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.write(fourcc, 0, 'latin1')
  head.writeUInt32LE(data.length, 4)
  return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function riff(chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WEBP', 8, 'latin1')
  return Buffer.concat([head, body])
}

const VP8L = WEBP_1x1.subarray(12) // 원래 VP8L 청크(덧붙임 포함)

describe('stripWebp', () => {
  it('drops EXIF and XMP chunks, clears their VP8X flags and fixes the RIFF size; image chunk unchanged', () => {
    const vp8x = Buffer.alloc(10)
    vp8x[0] = 0x20 | 0x10 | 0x08 | 0x04 // ICC + alpha + EXIF + XMP
    const icc = riffChunk('ICCP', ascii('fake-icc'))
    const input = riff([
      riffChunk('VP8X', vp8x),
      icc,
      VP8L,
      riffChunk('EXIF', ascii('MM\0*GPS37.5665N')), // 홀수 크기(덧붙임 있음)
      riffChunk('XMP ', ascii('<x:xmpmeta>Kim</x:xmpmeta>')),
    ])
    const { content, report } = stripWebp(input)
    expect(sniff(content)).toBe('image/webp')
    expect(content.readUInt32LE(4)).toBe(content.length - 8)
    expect(content.toString('latin1', 12, 16)).toBe('VP8X')
    expect(content[20]).toBe(0x20 | 0x10)
    expect(indexOf(content, 'EXIF')).toBe(-1)
    expect(indexOf(content, 'XMP ')).toBe(-1)
    expect(indexOf(content, 'GPS37')).toBe(-1)
    expect(indexOf(content, icc)).toBe(30)
    expect(indexOf(content, VP8L)).toBe(30 + icc.length)
    expect(content.length).toBe(12 + 18 + icc.length + VP8L.length)
    expect(report).toEqual({ format: 'webp', removed: ['exif', 'xmp'], orientation: null })
    expect(stripWebp(content).content.equals(content)).toBe(true)
  })

  it('leaves a simple WebP unchanged and rejects truncated RIFF data', () => {
    expect(stripWebp(WEBP_1x1).content.equals(WEBP_1x1)).toBe(true)
    expect(() => stripWebp(WEBP_1x1.subarray(0, 20))).toThrow(expect.objectContaining({ code: 'truncated', format: 'webp' }))
    expect(() => stripWebp(riff([riffChunk('EXIF', ascii('x'))]))).toThrow(expect.objectContaining({ code: 'malformed' }))
  })
})

// ── GIF ──────────────────────────────────────────────────────────────────

const GIF_HEAD = GIF_1x1.subarray(0, 19) // 헤더 + 화면 기술자 + 전역 색 표(2색)
const GIF_REST = GIF_1x1.subarray(19) // 그래픽 제어 확장 + 이미지 + 끝
const subBlocks = (data: Buffer) => {
  const out: Buffer[] = []
  for (let i = 0; i < data.length; i += 255) {
    const part = data.subarray(i, i + 255)
    out.push(Buffer.from([part.length]), part)
  }
  return Buffer.concat([...out, Buffer.from([0])])
}
const appExt = (id: string, data: Buffer) => Buffer.concat([Buffer.from([0x21, 0xff, 11]), ascii(id), subBlocks(data)])
const NETSCAPE = appExt('NETSCAPE2.0', Buffer.from([1, 0, 0]))

describe('stripGif', () => {
  it('drops comment and XMP application extensions, keeps the NETSCAPE loop and image data', () => {
    const input = Buffer.concat([
      GIF_HEAD,
      NETSCAPE,
      Buffer.from([0x21, 0xfe]),
      subBlocks(ascii('made by Kim at home')),
      appExt('XMP DataXMP', ascii('<x:xmpmeta>Kim</x:xmpmeta>')),
      GIF_REST,
      ascii('trailing'),
    ])
    const { content, report } = stripGif(input)
    expect(sniff(content)).toBe('image/gif')
    expect(content.equals(Buffer.concat([GIF_HEAD, NETSCAPE, GIF_REST]))).toBe(true)
    expect(report).toEqual({ format: 'gif', removed: ['comment', 'xmp', 'trailing_data'], orientation: null })
    expect(stripGif(GIF_1x1).content.equals(GIF_1x1)).toBe(true)
  })

  it('rejects truncated GIFs', () => {
    expect(() => stripGif(GIF_1x1.subarray(0, GIF_1x1.length - 1))).toThrow(expect.objectContaining({ code: 'truncated', format: 'gif' }))
    expect(() => stripGif(Buffer.concat([GIF_HEAD, Buffer.from([0x21, 0xfe, 10, 1, 2])]))).toThrow(MetadataStripError)
  })
})

// ── PDF ──────────────────────────────────────────────────────────────────

const utf16Hex = (text: string) => `<FEFF${Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase()}>`

describe('findPdfMetadata', () => {
  it('finds Info /Author /Creator /Producer (literal, hex UTF-16, indirect) and XMP dc:creator as masked samples only', () => {
    const pdf = Buffer.concat([
      ascii('%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\n'),
      ascii(`4 0 obj<</Author (Hong \\(Gil\\) Dong)/Creator ${utf16Hex('워드프로세서')}/Producer 5 0 R>>endobj\n`),
      ascii('5 0 obj (PDF Maker 2.0) endobj\n'),
      ascii('6 0 obj<</Type/Metadata/Subtype/XML>>stream\n'),
      Buffer.from('<x:xmpmeta><dc:creator><rdf:Seq><rdf:li>홍길동</rdf:li></rdf:Seq></dc:creator></x:xmpmeta>', 'utf8'),
      ascii('\nendstream endobj\ntrailer<</Root 1 0 R/Info 4 0 R>>\n%%EOF'),
    ])
    const found = findPdfMetadata(pdf)
    expect(found).toEqual([
      { field: 'Author', sample: 'H*** (***) ****' },
      { field: 'Creator', sample: '워*****' },
      { field: 'Producer', sample: 'P** ***** *.*' },
      { field: 'dc:creator', sample: '홍**' },
    ])
    expect(JSON.stringify(found)).not.toMatch(/Gil|길동|프로세서|Maker/)
    const processed = processMetadata(pdf, 'application/pdf')
    expect(processed.content).toBe(pdf)
    expect(processed.stripped).toBe(false)
    expect(processed.findings).toEqual({ format: 'pdf', fields: found })
  })

  it('returns nothing for PDFs without author properties or with empty ones', () => {
    expect(findPdfMetadata(PDF_MINIMAL)).toEqual([])
    expect(findPdfMetadata(ascii('%PDF-1.4\n1 0 obj<</Author ()/Creator <>>>endobj\n%%EOF'))).toEqual([])
  })
})

describe('processMetadata', () => {
  it('strips images by detected type and refuses unknown types', () => {
    const result = processMetadata(jpegWith(3), 'image/jpeg')
    expect(result.stripped).toBe(true)
    expect(result.findings).toMatchObject({ format: 'jpeg', orientation: 3 })
    expect(processMetadata(PNG_1x1, 'image/png').findings).toEqual({ format: 'png', removed: [], orientation: null })
    expect(() => processMetadata(PNG_1x1, 'text/html')).toThrow(expect.objectContaining({ code: 'unsupported' }))
  })
})
