/**
 * 산출물(파일) 규칙 (SYSTEM_DESIGN §6.3 Artifact/ArtifactVersion, §10, ADR 0007).
 *
 * - 업로드는 active owner/editor만 합니다(빌드 로그 작성과 같은 범위).
 * - 파일 내용은 검사를 통과한(`clean`) 버전만, 그 프로젝트의 active 멤버에게만 내려줍니다.
 *   검사 전·격리·실패 상태의 내용은 멤버에게도 주지 않습니다(상태는 메타데이터로만 보여 줌).
 * - 검사 상태: pending → scanning → clean | quarantined | failed. failed는 다시 시도(pending)할 수 있고,
 *   clean·quarantined는 최종 상태입니다.
 * - 허용 형식은 안전하게 표시할 수 있는 이미지·PDF로 좁힙니다. 선언한 형식, 파일 확장자, 실제 signature가
 *   모두 같아야 clean 후보가 됩니다.
 */
import { type Membership, type ProjectRef, type Viewer, canReadProjectWorkspace } from './permissions'

// ── 권한 ─────────────────────────────────────────────────────────────────

/** 파일 업로드(새 산출물·새 버전): active owner/editor. reviewer/viewer는 읽기만 합니다. */
export function canUploadArtifact(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && (membership!.role === 'owner' || membership!.role === 'editor')
}

/**
 * 파일 내용 열람: 그 프로젝트의 active 멤버이고 버전이 `clean`일 때만.
 * 호출자는 거부 시 상태와 무관하게 404로 응답해 검사 전·격리 파일의 존재를 드러내지 않아야 합니다.
 */
export function canReadArtifactContent(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  scanStatus: ScanStatus,
): boolean {
  return scanStatus === 'clean' && canReadProjectWorkspace(viewer, project, membership)
}

// ── 검사 상태 전이 ────────────────────────────────────────────────────────

export const SCAN_STATUSES = ['pending', 'scanning', 'clean', 'quarantined', 'failed'] as const
export type ScanStatus = (typeof SCAN_STATUSES)[number]

/**
 * 검사 작업이 일으키는 사건.
 * - start: worker가 검사를 시작(또는 중단된 검사를 다시 시작)
 * - pass / reject: 검사 결과(통과 / 격리)
 * - error: 검사 자체가 실패(저장소·검사기 오류). 재시도 가능
 * - retry: 사용자가 실패한 검사를 다시 요청
 */
export type ScanEvent = 'start' | 'pass' | 'reject' | 'error' | 'retry'

/**
 * 다음 상태. 허용하지 않는 전이는 null입니다(호출자는 아무것도 바꾸지 않음).
 *
 * - scanning → start: worker가 도중에 죽은 뒤 작업이 다시 실행되는 경우라 허용합니다.
 * - failed → start: 작업 큐의 자동 재시도. failed → retry: 사용자 재시도(pending으로 돌아감).
 * - clean·quarantined는 최종 상태라 어떤 사건으로도 바뀌지 않습니다(작업 중복 실행이 결과를 뒤집지 않음).
 */
export function nextScanStatus(current: ScanStatus, event: ScanEvent): ScanStatus | null {
  switch (event) {
    case 'start':
      return current === 'pending' || current === 'scanning' || current === 'failed' ? 'scanning' : null
    case 'pass':
      return current === 'scanning' ? 'clean' : null
    case 'reject':
      return current === 'scanning' ? 'quarantined' : null
    case 'error':
      return current === 'scanning' ? 'failed' : null
    case 'retry':
      return current === 'failed' ? 'pending' : null
  }
}

/** 더 바뀌지 않는 상태인지. */
export function isFinalScanStatus(status: ScanStatus): boolean {
  return status === 'clean' || status === 'quarantined'
}

/**
 * 빌드 로그 근거로 새로 붙일 수 있는지. 검사 중인 파일은 붙일 수 있고("검사 중"으로 표시),
 * 격리·실패 파일은 붙일 수 없습니다.
 */
export function canAttachAsEvidence(status: ScanStatus): boolean {
  return status === 'pending' || status === 'scanning' || status === 'clean'
}

// ── 허용 형식 ────────────────────────────────────────────────────────────

/** MVP 허용 형식과 확장자. 실행·압축·SVG·HTML은 받지 않습니다(§10). */
export const ALLOWED_FILE_TYPES = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'application/pdf': ['pdf'],
} as const satisfies Record<string, readonly string[]>

export type AllowedMediaType = keyof typeof ALLOWED_FILE_TYPES
export const ALLOWED_MEDIA_TYPES = Object.keys(ALLOWED_FILE_TYPES) as AllowedMediaType[]

/** 파일당 최대 크기(20MB, §10 초안). */
export const MAX_FILE_BYTES = 20 * 1024 * 1024
/** 사용자당 저장 한도(500MB, §10 초안). 그 사용자가 올린 모든 버전의 크기 합입니다. */
export const USER_QUOTA_BYTES = 500 * 1024 * 1024

export function isAllowedMediaType(value: unknown): value is AllowedMediaType {
  return typeof value === 'string' && Object.hasOwn(ALLOWED_FILE_TYPES, value)
}

/** 파일 이름의 마지막 확장자(소문자). 없으면 빈 문자열. */
export function fileExtension(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** 선언한 형식과 파일 확장자가 맞는지(예: image/png ↔ .png). */
export function extensionMatches(mediaType: AllowedMediaType, fileName: string): boolean {
  return (ALLOWED_FILE_TYPES[mediaType] as readonly string[]).includes(fileExtension(fileName))
}

/**
 * 파일 앞부분 signature로 판별한 종류. 허용 형식은 MIME 값, 그 밖에는 거부 사유를 설명하는 이름입니다.
 * 판별 자체는 @peerchive/files의 sniffer가 하고, 여기서는 결과로 판정만 합니다.
 */
export type DetectedKind =
  | AllowedMediaType
  | 'svg'
  | 'html'
  | 'xml'
  | 'zip'
  | 'ole'
  | 'executable'
  | 'script'
  | 'unknown'

/** 검사 판정. 격리 사유는 사용자에게 보여 줄 수 있는 짧은 코드입니다. */
export type FileTypeDecision =
  | { ok: true; mediaType: AllowedMediaType }
  | { ok: false; reason: QuarantineReason }

export type QuarantineReason =
  | 'disallowed_type'
  | 'unknown_type'
  | 'type_mismatch'
  | 'extension_mismatch'
  | 'embedded_content'
  | 'pdf_active_content'
  | 'malware'

/**
 * 선언 형식·파일 이름·실제 판별 결과로 허용 여부를 정합니다.
 * - 허용 목록에 없는 종류(SVG·HTML·XML·압축·Office·실행 파일·스크립트)는 `disallowed_type`
 * - 판별 불가는 `unknown_type`
 * - 판별 결과가 허용 형식이어도 선언과 다르면 `type_mismatch`, 확장자와 다르면 `extension_mismatch`
 */
export function decideFileType(declared: string, fileName: string, detected: DetectedKind): FileTypeDecision {
  if (detected === 'unknown') return { ok: false, reason: 'unknown_type' }
  if (!isAllowedMediaType(detected)) return { ok: false, reason: 'disallowed_type' }
  if (detected !== declared) return { ok: false, reason: 'type_mismatch' }
  if (!extensionMatches(detected, fileName)) return { ok: false, reason: 'extension_mismatch' }
  return { ok: true, mediaType: detected }
}

/** 브라우저에서 바로 보여 줘도 되는 형식(이미지). PDF는 내려받기로만 줍니다. */
export function isInlineMediaType(mediaType: string): boolean {
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif'
}
