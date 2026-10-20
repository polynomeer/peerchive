/**
 * 파일 형식 판별(magic bytes)과 내장 콘텐츠 점검. 의존성 없이 허용 형식만 정확히 알아보고,
 * 나머지는 거부 사유를 설명할 만큼만 구분합니다(ADR 0007).
 *
 * - 확장자·선언 형식·Content-Type 헤더는 믿지 않고 내용 앞부분만 봅니다.
 * - 판정 규칙(허용 여부, 선언과 일치)은 @peerchive/domain의 decideFileType이 합니다.
 * - 한계: 압축된 PDF 객체 스트림 안의 JavaScript는 보지 않습니다. 이미지 메타데이터(EXIF/GPS) 제거는 strip-metadata.ts가 합니다.
 */
import type { AllowedMediaType, DetectedKind, QuarantineReason } from '@peerchive/domain'

/** 판별에 쓰는 앞부분 길이. */
export const SNIFF_BYTES = 4096

const startsWith = (buf: Uint8Array, bytes: readonly number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b)
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const JPEG = [0xff, 0xd8, 0xff]
const GIF87 = ascii('GIF87a')
const GIF89 = ascii('GIF89a')
const RIFF = ascii('RIFF')
const WEBP = ascii('WEBP')
const PDF = ascii('%PDF-')
const ZIP_HEADERS = [ascii('PK\x03\x04'), ascii('PK\x05\x06'), ascii('PK\x07\x08')]
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const EXECUTABLES = [
  ascii('MZ'), // Windows PE/DOS
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0x00, 0x61, 0x73, 0x6d], // WebAssembly
]

/** WHATWG MIME sniffing의 HTML 시작 태그 목록(뒤에 공백 또는 `>`가 와야 함). */
const HTML_TAGS = [
  '!doctype html', 'html', 'head', 'script', 'iframe', 'h1', 'div', 'font', 'table', 'a', 'style', 'title', 'b',
  'body', 'br', 'p', '!--', 'object', 'embed', 'form', 'meta', 'img', 'link',
]

/** 앞부분을 텍스트로 보고 BOM·공백을 건너뛴 소문자 문자열. */
function leadingText(head: Uint8Array): string {
  let start = 0
  if (startsWith(head, [0xef, 0xbb, 0xbf])) start = 3
  else if (startsWith(head, [0xfe, 0xff]) || startsWith(head, [0xff, 0xfe])) {
    // UTF-16 텍스트: NUL 바이트를 빼고 읽습니다.
    return Buffer.from(head.subarray(2, 1024)).toString('latin1').replace(/\0/g, '').trimStart().toLowerCase()
  }
  return Buffer.from(head.subarray(start, start + 1024)).toString('latin1').trimStart().toLowerCase()
}

function textKind(head: Uint8Array): DetectedKind | null {
  const text = leadingText(head)
  if (text.startsWith('#!') || text.startsWith('<?php')) return 'script'
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'svg'
  if (text.startsWith('<?xml')) return 'xml'
  for (const tag of HTML_TAGS) {
    const open = `<${tag}`
    if (text.startsWith(open)) {
      const next = text.charAt(open.length)
      if (tag === '!--' || next === '' || next === '>' || /\s/.test(next)) return 'html'
    }
  }
  // 그 밖의 `<`로 시작하는 텍스트도 마크업으로 보고 막습니다.
  if (text.startsWith('<')) return 'xml'
  return null
}

/** 앞부분(최대 SNIFF_BYTES)으로 종류를 판별합니다. */
export function sniff(head: Uint8Array): DetectedKind {
  if (startsWith(head, PNG)) return 'image/png'
  if (startsWith(head, JPEG)) return 'image/jpeg'
  if (startsWith(head, GIF87) || startsWith(head, GIF89)) return 'image/gif'
  if (startsWith(head, RIFF) && startsWith(head, WEBP, 8)) return 'image/webp'
  // PDF 표준은 앞 1024바이트 안의 헤더를 허용하지만, 앞에 다른 내용을 숨기지 못하게 0번 위치만 받습니다.
  if (startsWith(head, PDF)) return 'application/pdf'
  if (ZIP_HEADERS.some((sig) => startsWith(head, sig))) return 'zip'
  if (startsWith(head, OLE)) return 'ole'
  if (EXECUTABLES.some((sig) => startsWith(head, sig))) return 'executable'
  return textKind(head) ?? 'unknown'
}

/** 이미지 앞부분에 숨긴 마크업(브라우저가 HTML로 해석할 수 있는 polyglot). */
const EMBEDDED_MARKUP = /<(script|html|svg|iframe|body|object|embed)[\s>/]|<\?php/i
/** ZIP 끝 레코드(End of Central Directory). 파일 뒤에 압축 파일을 붙인 polyglot 탐지. */
const ZIP_EOCD = Buffer.from('PK\x05\x06', 'latin1')
/** PDF의 실행·내장 기능. 이름 안의 `#xx` 이스케이프를 풀고 찾습니다. */
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFiles?|RichMedia|XFA)(?![A-Za-z0-9])/

/**
 * 허용 형식으로 판별된 파일의 내용 점검. 문제가 있으면 격리 사유, 없으면 null.
 * - 이미지: 앞 1KB 안의 HTML/SVG/스크립트 태그, 끝 64KB 안의 ZIP 끝 레코드
 * - PDF: JavaScript·Launch·내장 파일·RichMedia·XFA, ZIP 끝 레코드
 */
export function inspectContent(content: Buffer, mediaType: AllowedMediaType): QuarantineReason | null {
  const tail = content.subarray(Math.max(0, content.length - (65_535 + 22)))
  if (tail.includes(ZIP_EOCD)) return 'embedded_content'
  if (mediaType === 'application/pdf') {
    const text = content.toString('latin1').replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    return PDF_ACTIVE.test(text) ? 'pdf_active_content' : null
  }
  const head = content.subarray(0, 1024).toString('latin1')
  return EMBEDDED_MARKUP.test(head) ? 'embedded_content' : null
}
