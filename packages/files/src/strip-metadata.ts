/**
 * 이미지 메타데이터 제거와 PDF 문서 속성 점검(ADR 0007 "메타데이터 제거"). 의존성 없이 바이트 단위로 처리합니다.
 *
 * - 다시 인코딩하지 않습니다. 컨테이너 구조(JPEG 세그먼트, PNG·WebP 청크, GIF 블록)를 읽어 메타데이터 단위만 빼고
 *   나머지 바이트는 그대로 이어 붙입니다(무손실). 같은 입력은 언제나 같은 출력이고, 출력을 다시 넣어도 같습니다(idempotent).
 * - 구조가 깨졌거나 잘린 파일은 MetadataStripError를 던집니다. 호출자(검사 작업)는 이 파일을 failed로 두고 내려주지 않습니다
 *   (지우지 못한 원본을 내주지 않음).
 * - 형식별로 남기는 것: 화면 표시에 필요한 것(색 프로필·감마·투명도·애니메이션·JPEG 방향)만. 그 밖의 부가 정보는 뺍니다.
 * - PDF는 고쳐 쓰지 않습니다(구조가 복잡해 무손실 제거가 어렵고, 서명·양식이 깨질 수 있음). Info 사전과 압축되지 않은 XMP에서
 *   작성자 관련 속성을 찾아 이름과 가린 표본만 돌려줍니다. 압축된 객체 스트림 안의 속성은 보지 못합니다(best-effort).
 * - 결과 보고(report)에는 지운 항목의 "종류"만 남기고 값(위치·이름·문구)은 남기지 않습니다.
 */
import { crc32 } from 'node:zlib'
import { type MetadataFindings, type PdfMetadataField, maskSample } from '@peerchive/domain'

export type StripFormat = 'jpeg' | 'png' | 'webp' | 'gif'

/** 지운 항목의 종류(값은 남기지 않음). */
export type RemovedKind =
  | 'exif'
  | 'gps'
  | 'xmp'
  | 'iptc'
  | 'comment'
  | 'thumbnail'
  | 'text'
  | 'time'
  | 'app_segment'
  | 'chunk'
  | 'extension'
  | 'trailing_data'

export interface StripReport {
  format: StripFormat
  /** 지운 종류(처음 만난 순서, 중복 없음). 비어 있으면 지운 것이 없습니다. */
  removed: RemovedKind[]
  /** JPEG에서 다시 써 넣은 EXIF Orientation(2–8). 없거나 1이면 null. */
  orientation: number | null
}

export interface StripResult {
  content: Buffer
  report: StripReport
}

export type StripErrorCode = 'truncated' | 'malformed' | 'unsupported'

/** 메타데이터를 안전하게 지울 수 없는 파일(잘림·구조 오류·지원하지 않는 형식). */
export class MetadataStripError extends Error {
  constructor(
    readonly code: StripErrorCode,
    readonly format: StripFormat | 'unknown',
    detail: string,
  ) {
    super(`metadata strip failed (${format}, ${code}): ${detail}`)
    this.name = 'MetadataStripError'
  }
}

const latin1 = (buf: Uint8Array, start: number, end: number) => Buffer.from(buf.subarray(start, end)).toString('latin1')

class Removed {
  private readonly kinds: RemovedKind[] = []
  add(kind: RemovedKind) {
    if (!this.kinds.includes(kind)) this.kinds.push(kind)
  }
  list(): RemovedKind[] {
    return [...this.kinds]
  }
}

// ── JPEG ─────────────────────────────────────────────────────────────────

const EXIF_ID = 'Exif\0\0'
const XMP_IDS = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0']
const ORIENTATION_TAG = 0x0112
const GPS_IFD_TAG = 0x8825

interface ExifInfo {
  littleEndian: boolean
  orientation: number | null
  gps: boolean
  thumbnail: boolean
}

/**
 * EXIF(TIFF) IFD0에서 Orientation·GPS 포인터·썸네일(IFD1) 여부만 읽습니다. EXIF는 어차피 지우므로 내부가 깨져 있으면
 * 방향을 모르는 것(null)으로 보고 넘어갑니다(세그먼트 자체의 잘림은 호출자가 오류로 처리).
 */
function readExif(payload: Buffer): ExifInfo | null {
  const tiff = payload.subarray(EXIF_ID.length)
  if (tiff.length < 8) return null
  const order = latin1(tiff, 0, 2)
  if (order !== 'II' && order !== 'MM') return null
  const le = order === 'II'
  const u16 = (at: number) => (le ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at))
  const u32 = (at: number) => (le ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at))
  if (u16(2) !== 42) return null
  const info: ExifInfo = { littleEndian: le, orientation: null, gps: false, thumbnail: false }
  const ifd = u32(4)
  if (ifd + 2 > tiff.length) return info
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > tiff.length) return info
    const tag = u16(entry)
    if (tag === ORIENTATION_TAG && u16(entry + 2) === 3 && u32(entry + 4) >= 1) {
      const value = u16(entry + 8)
      if (value >= 1 && value <= 8) info.orientation = value
    } else if (tag === GPS_IFD_TAG) {
      info.gps = true
    }
  }
  const next = ifd + 2 + count * 12
  if (next + 4 <= tiff.length && u32(next) !== 0) info.thumbnail = true
  return info
}

/**
 * Orientation 하나만 든 최소 APP1 Exif 세그먼트. TIFF 헤더(원래 EXIF와 같은 바이트 순서) + IFD0 항목 1개 + 다음 IFD 없음.
 * 길이: 마커 2 + 길이 2 + "Exif\0\0" 6 + TIFF 26 = 36바이트.
 */
export function orientationExifSegment(orientation: number, littleEndian: boolean): Buffer {
  const tiff = Buffer.alloc(26)
  const w16 = (value: number, at: number) => (littleEndian ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at))
  const w32 = (value: number, at: number) => (littleEndian ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at))
  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1')
  w16(42, 2)
  w32(8, 4) // IFD0 위치
  w16(1, 8) // 항목 수
  w16(ORIENTATION_TAG, 10)
  w16(3, 12) // SHORT
  w32(1, 14) // 개수
  w16(orientation, 18) // 값(남는 2바이트는 0)
  w32(0, 22) // 다음 IFD 없음(썸네일 없음)
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1, 0)
  header.writeUInt16BE(2 + EXIF_ID.length + tiff.length, 2)
  return Buffer.concat([header, Buffer.from(EXIF_ID, 'latin1'), tiff])
}

/**
 * JPEG: 첫 SOS 전의 세그먼트를 거릅니다.
 * - 남김: APP0 JFIF(썸네일은 0×0으로 바꿈), APP2 ICC_PROFILE(색), APP14 Adobe(색 변환), 그 밖의 비 APP 세그먼트(DQT·DHT·SOF·DRI 등)
 * - 뺌: APP1 Exif·XMP, APP13(Photoshop/IPTC), COM, 그 밖의 모든 APPn(JFXX 썸네일, MPF 등)
 * - 지운 EXIF의 Orientation이 1이 아니면 Orientation만 든 APP1을 원래 EXIF 자리에 다시 넣습니다.
 * - 첫 SOS부터 EOI까지는 그대로 복사하고, EOI 뒤에 붙은 내용(MPF 보조 이미지 등)은 뺍니다. EOI가 없으면(끝이 잘린 스캔)
 *   끝까지 그대로 둡니다.
 */
export function stripJpeg(buf: Buffer): StripResult {
  const fail = (code: StripErrorCode, detail: string) => new MetadataStripError(code, 'jpeg', detail)
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw fail('malformed', 'missing SOI')
  const out: Buffer[] = [buf.subarray(0, 2)]
  const removed = new Removed()
  let exif: ExifInfo | null = null
  let exifAt = -1
  let pos = 2

  for (;;) {
    if (pos >= buf.length) throw fail('truncated', 'no SOS')
    if (buf[pos] !== 0xff) throw fail('malformed', 'expected marker')
    let m = pos + 1
    while (m < buf.length && buf[m] === 0xff) m++ // 채움 바이트
    if (m >= buf.length) throw fail('truncated', 'marker')
    const marker = buf[m]!
    if (marker === 0x00 || marker === 0xd8 || marker === 0xd9) throw fail('malformed', 'unexpected marker before SOS')
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      out.push(buf.subarray(m - 1, m + 1))
      pos = m + 1
      continue
    }
    if (m + 3 > buf.length) throw fail('truncated', 'segment length')
    const length = buf.readUInt16BE(m + 1)
    if (length < 2) throw fail('malformed', 'segment length')
    const end = m + 1 + length
    if (end > buf.length) throw fail('truncated', 'segment')
    const segment = buf.subarray(m - 1, end)
    const payload = buf.subarray(m + 3, end)
    const id = (text: string) => payload.length >= text.length && latin1(payload, 0, text.length) === text

    if (marker === 0xda) {
      out.push(buf.subarray(m - 1, scanEnd(buf, m - 1, fail, removed)))
      break
    }
    if (marker === 0xe0) {
      if (!id('JFIF\0')) removed.add(id('JFXX\0') ? 'thumbnail' : 'app_segment')
      else if (payload.length < 14) throw fail('malformed', 'JFIF')
      else if (payload[12] !== 0 || payload[13] !== 0 || payload.length > 14) {
        // JFIF 안의 썸네일을 빼고 같은 값의 14바이트 JFIF로 다시 씁니다.
        const jfif = Buffer.from(payload.subarray(0, 14))
        jfif[12] = 0
        jfif[13] = 0
        out.push(Buffer.from([0xff, 0xe0, 0x00, 16]), jfif)
        if (payload[12] !== 0 || payload[13] !== 0) removed.add('thumbnail')
      } else out.push(segment)
    } else if (marker === 0xe1) {
      if (id(EXIF_ID)) {
        removed.add('exif')
        const info = readExif(payload)
        if (info?.gps) removed.add('gps')
        if (info?.thumbnail) removed.add('thumbnail')
        if (exifAt < 0) {
          exifAt = out.length
          exif = info
        }
      } else removed.add(XMP_IDS.some(id) ? 'xmp' : 'app_segment')
    } else if (marker === 0xe2) {
      if (id('ICC_PROFILE\0')) out.push(segment)
      else removed.add('app_segment')
    } else if (marker === 0xee) {
      if (id('Adobe')) out.push(segment)
      else removed.add('app_segment')
    } else if (marker === 0xed) {
      removed.add('iptc')
    } else if (marker >= 0xe3 && marker <= 0xef) {
      removed.add('app_segment')
    } else if (marker === 0xfe) {
      removed.add('comment')
    } else {
      out.push(segment)
    }
    pos = end
  }

  const orientation = exif?.orientation && exif.orientation !== 1 ? exif.orientation : null
  if (orientation !== null) out.splice(exifAt, 0, orientationExifSegment(orientation, exif!.littleEndian))
  return { content: Buffer.concat(out), report: { format: 'jpeg', removed: removed.list(), orientation } }
}

/**
 * SOS부터 EOI 다음까지의 끝 위치. 엔트로피 데이터의 0xFF는 뒤에 0x00(stuffing)·RSTn이 오고, 그 밖의 마커는 세그먼트
 * (progressive JPEG의 다음 SOS·DHT 등)이므로 길이만큼 건너뜁니다. EOI가 없으면 파일 끝.
 */
function scanEnd(
  buf: Buffer,
  start: number,
  fail: (code: StripErrorCode, detail: string) => MetadataStripError,
  removed: Removed,
): number {
  let pos = start
  // 처음 위치는 SOS 마커(FF DA)입니다.
  for (;;) {
    // 세그먼트(마커 + 길이 + 내용)를 건너뜁니다.
    if (pos + 4 > buf.length) throw fail('truncated', 'scan header')
    const length = buf.readUInt16BE(pos + 2)
    if (length < 2) throw fail('malformed', 'scan header')
    pos += 2 + length
    if (pos > buf.length) throw fail('truncated', 'scan header')
    // 엔트로피 데이터 또는 다음 마커.
    for (;;) {
      if (pos >= buf.length) return buf.length
      if (buf[pos] !== 0xff) {
        pos++
        continue
      }
      let m = pos + 1
      while (m < buf.length && buf[m] === 0xff) m++
      if (m >= buf.length) return buf.length
      const marker = buf[m]!
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        pos = m + 1
        continue
      }
      if (marker === 0xd9) {
        if (m + 1 < buf.length) removed.add('trailing_data')
        return m + 1
      }
      pos = m - 1
      break
    }
  }
}

// ── PNG ──────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/**
 * 남기는 청크: 필수(IHDR·PLTE·IDAT·IEND), 색·투명도·표시(tRNS·cHRM·gAMA·iCCP·sBIT·sRGB·cICP·mDCV·cLLI·pHYs·bKGD·hIST·sPLT),
 * 애니메이션(acTL·fcTL·fdAT). 모르는 필수 청크(첫 글자 대문자)도 남깁니다(디코더가 판단, 무손실 우선).
 */
const PNG_KEEP = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND',
  'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'pHYs', 'bKGD', 'hIST', 'sPLT',
  'acTL', 'fcTL', 'fdAT',
])
const PNG_REMOVED: Record<string, RemovedKind> = { eXIf: 'exif', tEXt: 'text', zTXt: 'text', iTXt: 'text', tIME: 'time' }

/**
 * PNG: eXIf·tEXt·zTXt·iTXt·tIME와 그 밖의 부가 청크를 빼고, 남긴 청크는 CRC까지 그대로 복사합니다.
 * 모든 청크의 길이·이름·CRC를 확인하고, 첫 청크가 IHDR이 아니거나 IEND 전에 끝나면 오류입니다. IEND 뒤의 내용은 뺍니다.
 */
export function stripPng(buf: Buffer): StripResult {
  const fail = (code: StripErrorCode, detail: string) => new MetadataStripError(code, 'png', detail)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw fail('malformed', 'signature')
  const out: Buffer[] = [buf.subarray(0, 8)]
  const removed = new Removed()
  let pos = 8
  let first = true
  for (;;) {
    if (pos + 12 > buf.length) throw fail('truncated', 'chunk header')
    const length = buf.readUInt32BE(pos)
    if (length > 0x7fffffff) throw fail('malformed', 'chunk length')
    const type = latin1(buf, pos + 4, pos + 8)
    if (!/^[A-Za-z]{4}$/.test(type)) throw fail('malformed', 'chunk type')
    const end = pos + 12 + length
    if (end > buf.length) throw fail('truncated', 'chunk')
    if (crc32(buf.subarray(pos + 4, pos + 8 + length)) !== buf.readUInt32BE(pos + 8 + length)) throw fail('malformed', 'chunk CRC')
    if (first && type !== 'IHDR') throw fail('malformed', 'first chunk is not IHDR')
    first = false
    const critical = type.charCodeAt(0) < 0x61
    if (PNG_KEEP.has(type) || critical) out.push(buf.subarray(pos, end))
    else removed.add(PNG_REMOVED[type] ?? 'chunk')
    pos = end
    if (type === 'IEND') {
      if (pos < buf.length) removed.add('trailing_data')
      break
    }
  }
  return { content: Buffer.concat(out), report: { format: 'png', removed: removed.list(), orientation: null } }
}

// ── WebP ─────────────────────────────────────────────────────────────────

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP'])
const VP8X_EXIF_FLAG = 0x08
const VP8X_XMP_FLAG = 0x04

/**
 * WebP(RIFF): EXIF·XMP 청크와 모르는 청크를 빼고, VP8X의 EXIF·XMP 표시 비트를 지운 뒤 RIFF 크기를 다시 계산합니다.
 * 이미지 청크(VP8/VP8L/ALPH/ANIM/ANMF)와 색 프로필(ICCP)은 그대로입니다. RIFF 크기 뒤에 붙은 내용은 뺍니다.
 */
export function stripWebp(buf: Buffer): StripResult {
  const fail = (code: StripErrorCode, detail: string) => new MetadataStripError(code, 'webp', detail)
  if (buf.length < 12 || latin1(buf, 0, 4) !== 'RIFF' || latin1(buf, 8, 12) !== 'WEBP') throw fail('malformed', 'RIFF header')
  const riffSize = buf.readUInt32LE(4)
  if (riffSize < 4) throw fail('malformed', 'RIFF size')
  const end = 8 + riffSize
  if (end > buf.length) throw fail('truncated', 'RIFF size')
  const removed = new Removed()
  if (end < buf.length) removed.add('trailing_data')
  const chunks: Buffer[] = []
  let pos = 12
  let first = true
  while (pos < end) {
    if (pos + 8 > end) throw fail('truncated', 'chunk header')
    const fourcc = latin1(buf, pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    const dataEnd = pos + 8 + size
    if (dataEnd > end) throw fail('truncated', 'chunk')
    if (first && fourcc !== 'VP8 ' && fourcc !== 'VP8L' && fourcc !== 'VP8X') throw fail('malformed', 'first chunk')
    first = false
    // 홀수 크기 청크는 0 한 바이트를 덧붙입니다. 마지막 청크의 덧붙임이 빠진 파일은 0을 채워 맞춥니다.
    const padded = dataEnd + (size & 1)
    const chunk = padded <= end ? buf.subarray(pos, padded) : Buffer.concat([buf.subarray(pos, dataEnd), Buffer.alloc(1)])
    if (fourcc === 'VP8X') {
      if (size < 10) throw fail('malformed', 'VP8X')
      const flags = chunk[8]!
      if (flags & (VP8X_EXIF_FLAG | VP8X_XMP_FLAG)) {
        const copy = Buffer.from(chunk)
        copy[8] = flags & ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG)
        chunks.push(copy)
      } else chunks.push(chunk)
    } else if (WEBP_KEEP.has(fourcc)) chunks.push(chunk)
    else removed.add(fourcc === 'EXIF' ? 'exif' : fourcc === 'XMP ' ? 'xmp' : 'chunk')
    pos = Math.min(padded, end)
  }
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WEBP', 8, 'latin1')
  return { content: Buffer.concat([header, body]), report: { format: 'webp', removed: removed.list(), orientation: null } }
}

// ── GIF ──────────────────────────────────────────────────────────────────

/** 반복 재생(loop) 정보를 담는 애플리케이션 확장. 이것만 남깁니다. */
const GIF_LOOP_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0'])

/**
 * GIF: 주석 확장(0xFE)과 반복 재생(NETSCAPE2.0·ANIMEXTS1.0) 외의 애플리케이션 확장(XMP 등), 모르는 확장을 뺍니다.
 * 그래픽 제어(0xF9)·일반 텍스트(0x01) 확장, 이미지 블록, 색 표는 그대로입니다. 끝 표시(0x3B) 뒤의 내용은 뺍니다.
 */
export function stripGif(buf: Buffer): StripResult {
  const fail = (code: StripErrorCode, detail: string) => new MetadataStripError(code, 'gif', detail)
  const version = buf.length >= 6 ? latin1(buf, 0, 6) : ''
  if (version !== 'GIF87a' && version !== 'GIF89a') throw fail('malformed', 'header')
  if (buf.length < 13) throw fail('truncated', 'screen descriptor')
  const colorTable = (packed: number) => (packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0)
  let pos = 13 + colorTable(buf[10]!)
  if (pos > buf.length) throw fail('truncated', 'global color table')
  const out: Buffer[] = [buf.subarray(0, pos)]
  const removed = new Removed()

  /** 하위 블록 열(길이 바이트 + 내용, 길이 0에서 끝)의 끝 위치. */
  const skipSubBlocks = (at: number) => {
    let q = at
    for (;;) {
      if (q >= buf.length) throw fail('truncated', 'sub-block')
      const n = buf[q]!
      q += 1
      if (n === 0) return q
      q += n
      if (q > buf.length) throw fail('truncated', 'sub-block')
    }
  }

  for (;;) {
    if (pos >= buf.length) throw fail('truncated', 'no trailer')
    const block = buf[pos]
    if (block === 0x3b) {
      out.push(buf.subarray(pos, pos + 1))
      if (pos + 1 < buf.length) removed.add('trailing_data')
      break
    }
    if (block === 0x2c) {
      if (pos + 10 > buf.length) throw fail('truncated', 'image descriptor')
      const start = pos + 10 + colorTable(buf[pos + 9]!) + 1 // + LZW 최소 코드 크기
      if (start > buf.length) throw fail('truncated', 'image')
      const end = skipSubBlocks(start)
      out.push(buf.subarray(pos, end))
      pos = end
    } else if (block === 0x21) {
      if (pos + 2 > buf.length) throw fail('truncated', 'extension')
      const label = buf[pos + 1]
      const end = skipSubBlocks(pos + 2)
      if (label === 0xf9 || label === 0x01) out.push(buf.subarray(pos, end))
      else if (label === 0xfe) removed.add('comment')
      else if (label === 0xff) {
        const size = buf[pos + 2]!
        const app = size === 11 ? latin1(buf, pos + 3, pos + 14) : ''
        if (GIF_LOOP_APPS.has(app)) out.push(buf.subarray(pos, end))
        else removed.add(app.startsWith('XMP Data') ? 'xmp' : 'extension')
      } else removed.add('extension')
      pos = end
    } else {
      throw fail('malformed', 'unknown block')
    }
  }
  return { content: Buffer.concat(out), report: { format: 'gif', removed: removed.list(), orientation: null } }
}

// ── PDF 문서 속성 ────────────────────────────────────────────────────────

export interface PdfMetadataFinding {
  field: PdfMetadataField
  /** 가린 표본(앞 1글자만, 최대 40글자 기준). 값 전체는 남기지 않습니다. */
  sample: string
}

/** PDF 문자열 바이트 → 글자. UTF-16BE·UTF-8 BOM을 따르고, 그 밖에는 PDFDocEncoding(≈ latin1)으로 봅니다. */
function decodePdfText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = bytes.subarray(2, 2 + ((bytes.length - 2) & ~1))
    return Buffer.from(body).swap16().toString('utf16le')
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8')
  return bytes.toString('latin1')
}

/** text[at]에서 시작하는 PDF 문자열(`(...)` 또는 `<hex>`)의 바이트. 문자열이 아니면 null. */
function readPdfString(text: string, at: number): Buffer | null {
  if (text[at] === '(') {
    const bytes: number[] = []
    let depth = 1
    let i = at + 1
    while (i < text.length && depth > 0) {
      const c = text[i]!
      if (c === '\\') {
        const n = text[i + 1] ?? ''
        const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }
        if (n in simple) {
          bytes.push(simple[n]!)
          i += 2
        } else if (/[0-7]/.test(n)) {
          const oct = /^[0-7]{1,3}/.exec(text.slice(i + 1, i + 4))![0]
          bytes.push(Number.parseInt(oct, 8) & 0xff)
          i += 1 + oct.length
        } else if (n === '\r' || n === '\n') {
          i += n === '\r' && text[i + 2] === '\n' ? 3 : 2 // 줄 이어짐
        } else i += 1
        continue
      }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) break
      bytes.push(c.charCodeAt(0) & 0xff)
      i++
    }
    return depth === 0 ? Buffer.from(bytes) : null
  }
  if (text[at] === '<' && text[at + 1] !== '<') {
    const close = text.indexOf('>', at)
    if (close < 0) return null
    const hex = text.slice(at + 1, close).replace(/\s+/g, '')
    if (!/^[0-9A-Fa-f]*$/.test(hex)) return null
    return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex')
  }
  return null
}

const PDF_INFO_KEY = /\/(Author|Creator|Producer)(?![A-Za-z0-9#])\s*/g
const PDF_REF = /^(\d+)\s+(\d+)\s+R/
const XMP_CREATOR = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/g
const XMP_LI = /<rdf:li\b[^>]*>([^<]*)<\/rdf:li>/g

const maskPdfValue = (value: string) => maskSample([...value].slice(0, 40).join(''), 1, 0)

const unescapeXml = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')

/**
 * PDF 문서 속성(Info 사전의 /Author·/Creator·/Producer, XMP의 dc:creator)을 찾습니다. 압축되지 않은 부분만 보는 best-effort입니다.
 * 간접 참조(`/Author 12 0 R`)는 같은 파일의 `12 0 obj (…)`를 따라갑니다. 빈 값은 무시하고, 같은 항목·표본은 한 번만 돌려줍니다.
 */
export function findPdfMetadata(content: Buffer): PdfMetadataFinding[] {
  const text = content.toString('latin1')
  const found: PdfMetadataFinding[] = []
  const seen = new Set<string>()
  const add = (field: PdfMetadataField, raw: string) => {
    const value = raw.replace(/[\u0000-\u001f]/g, ' ').trim()
    if (!value) return
    const sample = maskPdfValue(value)
    const id = `${field}|${sample}`
    if (seen.has(id)) return
    seen.add(id)
    found.push({ field, sample })
  }

  for (const match of text.matchAll(PDF_INFO_KEY)) {
    const field = match[1] as PdfMetadataField
    const at = match.index + match[0].length
    let bytes = readPdfString(text, at)
    if (!bytes) {
      const ref = PDF_REF.exec(text.slice(at, at + 24))
      if (ref) {
        const obj = new RegExp(`(?:^|[^0-9])${ref[1]}\\s+${ref[2]}\\s+obj\\s*`).exec(text)
        if (obj) bytes = readPdfString(text, obj.index + obj[0].length)
      }
    }
    if (bytes) add(field, decodePdfText(bytes))
  }

  // XMP는 UTF-8 XML입니다. latin1로 읽은 문자열을 바이트로 되돌려 UTF-8로 풉니다.
  for (const creator of text.matchAll(XMP_CREATOR)) {
    const xml = Buffer.from(creator[1]!, 'latin1').toString('utf8')
    const items = [...xml.matchAll(XMP_LI)].map((li) => li[1]!)
    for (const item of items.length ? items : [xml.replace(/<[^>]*>/g, '')]) add('dc:creator', unescapeXml(item))
  }
  return found
}

// ── 검사 작업용 진입점 ───────────────────────────────────────────────────

export interface MetadataProcessing {
  /** 내려줄 내용. 이미지는 메타데이터를 지운 바이트, 그 밖에는 원래 바이트. */
  content: Buffer
  /** 이미지 메타데이터를 지웠는지(이미지면 언제나 true, 그 밖에는 false). */
  stripped: boolean
  /** artifact_versions.metadata_findings에 저장할 값(값 전체 없음). */
  findings: MetadataFindings
}

const STRIPPERS: Record<string, (content: Buffer) => StripResult> = {
  'image/jpeg': stripJpeg,
  'image/png': stripPng,
  'image/webp': stripWebp,
  'image/gif': stripGif,
}

/** 판별한 형식에 따라 이미지는 메타데이터를 지우고, PDF는 문서 속성을 찾습니다. 지울 수 없으면 MetadataStripError. */
export function processMetadata(content: Buffer, mediaType: string): MetadataProcessing {
  const strip = STRIPPERS[mediaType]
  if (strip) {
    const { content: stripped, report } = strip(content)
    return { content: stripped, stripped: true, findings: { format: report.format, removed: report.removed, orientation: report.orientation } }
  }
  if (mediaType === 'application/pdf') return { content, stripped: false, findings: { format: 'pdf', fields: findPdfMetadata(content) } }
  throw new MetadataStripError('unsupported', 'unknown', mediaType)
}
