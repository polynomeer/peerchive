/**
 * 산출물 화면 도우미(T-05): 허용 형식·한도 안내, 검사 상태 문구, 업로드(의도 → PUT → 완료).
 * 상태는 색이 아니라 텍스트로 보여 줍니다(시나리오 H).
 */
import type {
  ArtifactDto,
  ApiErrorData,
  ScanStatus,
  UploadCompleteDto,
  UploadIntentDto,
} from '~~/shared/types/api'

/** 서버 한도와 같은 값(@peerchive/domain). 화면 안내·사전 검사용이며 최종 판정은 서버가 합니다. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const ALLOWED_UPLOADS: Record<string, string[]> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'application/pdf': ['pdf'],
}
export const UPLOAD_ACCEPT = Object.entries(ALLOWED_UPLOADS)
  .flatMap(([type, exts]) => [type, ...exts.map((e) => `.${e}`)])
  .join(',')
export const ALLOWED_UPLOAD_LABEL = 'PNG, JPEG, WebP, GIF 이미지와 PDF'

export const SCAN_STATUS_LABELS: Record<ScanStatus, string> = {
  pending: '검사 대기',
  scanning: '검사 중',
  clean: '사용 가능',
  quarantined: '격리됨',
  failed: '검사 실패',
}

const SCAN_REASON_LABELS: Record<string, string> = {
  disallowed_type: '허용하지 않는 형식(SVG·HTML·압축·실행 파일 등)',
  unknown_type: '형식을 알 수 없음',
  type_mismatch: '선언한 형식과 실제 내용이 다름',
  extension_mismatch: '확장자와 실제 형식이 다름',
  embedded_content: '파일 안에 숨은 코드나 압축 파일이 있음',
  pdf_active_content: 'PDF 안에 스크립트·실행·첨부 기능이 있음',
  malware: '악성코드가 탐지됨',
  scan_error: '검사기 오류',
  object_missing: '파일을 찾을 수 없음',
  integrity_mismatch: '파일이 손상됨',
}

export function scanReasonLabel(reason: string | null): string {
  return reason ? (SCAN_REASON_LABELS[reason] ?? '사유 미상') : '사유 미상'
}

/** "격리됨: 사유"처럼 상태와 사유를 한 줄로. */
export function scanStatusText(status: ScanStatus, reason: string | null): string {
  if (status === 'quarantined') return `격리됨: ${scanReasonLabel(reason)}`
  if (status === 'failed') return `검사 실패: ${scanReasonLabel(reason)}`
  return SCAN_STATUS_LABELS[status]
}

export const isScanInProgress = (status: ScanStatus) => status === 'pending' || status === 'scanning'

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const [value, unit] = bytes < 1024 * 1024 ? [bytes / 1024, 'KB'] : [bytes / 1024 / 1024, 'MB']
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`
}

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 선언할 형식. 브라우저가 준 형식이 허용 목록에 없으면 확장자로 정합니다. 둘 다 아니면 null. */
export function declaredTypeFor(file: { name: string; type: string }): string | null {
  const ext = extensionOf(file.name)
  if (ALLOWED_UPLOADS[file.type]?.includes(ext)) return file.type
  return Object.entries(ALLOWED_UPLOADS).find(([, exts]) => exts.includes(ext))?.[0] ?? null
}

/** 보내기 전 사전 검사. 문제가 없으면 null, 있으면 안내 문구. */
export function precheckFile(file: { name: string; type: string; size: number }): string | null {
  if (file.size === 0) return '빈 파일은 올릴 수 없습니다.'
  if (file.size > MAX_UPLOAD_BYTES) return `파일이 ${formatBytes(MAX_UPLOAD_BYTES)}보다 큽니다.`
  if (!declaredTypeFor(file)) return `${ALLOWED_UPLOAD_LABEL}만 올릴 수 있습니다.`
  return null
}

const UPLOAD_ERROR_MESSAGES: Record<string, string> = {
  quota_exceeded: '저장 한도(500MB)를 넘습니다. 필요 없는 파일을 정리한 뒤 다시 시도하세요.',
  too_large: `파일이 ${formatBytes(MAX_UPLOAD_BYTES)}보다 큽니다.`,
  unsupported_type: `${ALLOWED_UPLOAD_LABEL}만 올릴 수 있습니다.`,
  extension_mismatch: '파일 확장자가 형식과 맞지 않습니다.',
  size_mismatch: '전송 중 파일 크기가 달라졌습니다. 다시 시도하세요.',
  intent_expired: '업로드 시간이 지났습니다. 다시 시도하세요.',
}

export class UploadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }

  /** 화면에 보여 줄 안내 문구. */
  get userMessage(): string {
    if (this.status === 403) return '이 과제에 파일을 올릴 권한이 없습니다(편집자 이상).'
    return UPLOAD_ERROR_MESSAGES[this.code] ?? '업로드하지 못했습니다. 다시 시도하세요.'
  }
}

/** API 오류 → UploadError(422 필드 코드 우선). */
function toUploadError(status: number, data: ApiErrorData | undefined): UploadError {
  const fieldCode = data?.fields ? Object.values(data.fields)[0] : undefined
  return new UploadError(status, fieldCode ?? data?.code ?? 'unknown')
}

/** 진행률을 알 수 있도록 XMLHttpRequest로 PUT합니다(fetch는 업로드 진행률이 없음). */
function putWithProgress(url: string, file: Blob, onProgress: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.responseType = 'json'
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve()
      const body = xhr.response as { data?: ApiErrorData } | null
      reject(toUploadError(xhr.status, body?.data))
    }
    xhr.onerror = () => reject(new UploadError(0, 'network'))
    xhr.send(file)
  })
}

async function postJson<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  try {
    return (await $fetch<unknown>(url, { method: 'POST', ...(body && { body }) })) as T
  } catch (e) {
    const error = apiError(e)
    throw new UploadError(error.status, Object.values(error.fields)[0] ?? error.code)
  }
}

/**
 * 업로드 세 단계. clientId가 같으면 서버가 같은 의도를 돌려주므로, 실패 뒤 같은 clientId로 다시 부르면
 * 이미 받은 내용은 건너뛰고 완료만 합니다.
 */
export async function uploadArtifactFile(
  projectId: string,
  file: File,
  options: { clientId: string; artifactId?: string; onProgress: (ratio: number) => void },
): Promise<UploadCompleteDto> {
  const declaredType = declaredTypeFor(file)
  if (!declaredType) throw new UploadError(422, 'unsupported_type')
  const intent = await postJson<UploadIntentDto>(`/api/v1/projects/${projectId}/artifacts/upload-intents`, {
    fileName: file.name,
    declaredType,
    byteSize: file.size,
    clientId: options.clientId,
    ...(options.artifactId && { artifactId: options.artifactId }),
  })
  if (!intent.uploaded) {
    try {
      await putWithProgress(intent.uploadUrl, file, options.onProgress)
    } catch (error) {
      // 앞선 시도에서 이미 다 받았으면 완료로 넘어갑니다.
      if (!(error instanceof UploadError && error.code === 'already_uploaded')) throw error
    }
  }
  options.onProgress(1)
  return postJson<UploadCompleteDto>(intent.completeUrl)
}

/** 근거로 고를 수 있는 버전(빌드 로그 폼용). */
export interface EvidenceOption {
  versionId: string
  label: string
  scanStatus: ScanStatus
}

export function evidenceOptions(artifacts: ArtifactDto[]): EvidenceOption[] {
  return artifacts.flatMap((artifact) =>
    artifact.versions.map((version) => ({
      versionId: version.id,
      label: `${artifact.title} v${version.versionNo}`,
      scanStatus: version.scanStatus,
    })),
  )
}
