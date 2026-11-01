/**
 * 기관 일반화·인증 수단 규칙 (I-01, PROOFU_EVOLUTION_PLAN §8.9.11, SYSTEM_DESIGN §6.7.2·§8.4·§9.2, DELIVERY_PLAN §4.3 I-01·§5.3 Z, ADR 0037).
 *
 * - 기관은 기존 `schools` 행에 `kind`를 더한 것입니다(대학은 university, 그 밖은 부트캠프·교육 프로그램·동아리 연합). 대학은 학교 메일 인증만 씁니다.
 * - 대학이 아닌 기관의 인증 수단은 세 가지입니다.
 *   - **초대 코드**(`invite_code`): 운영자(I-02부터 기관 운영진)가 발급. 원문은 발급 응답에 한 번만 보이고 HMAC만 저장, 만료·사용 한도·철회.
 *   - **기수 승인**(`cohort_approval`): 기관이 참여하지 않는 기수. 같은 기수에서 **기수 승인이 아닌 수단으로 인증된** 멤버 2명이 승인하면 인증.
 *     자기 승인·같은 사람의 두 번 승인은 안 됩니다(승인 연쇄로 가짜 기수를 만드는 것 방지).
 *   - **수료증 확인**(`certificate_check`): 사용자가 올린 수료증을 운영자가 보고 승인/거절. 파일은 결정 뒤 worker가 지우고 삭제 장부에 남깁니다.
 * - 재학 상태(standing)는 C-01 값(student/alumni)을 그대로 쓰고 기관 종류에 따라 글자만 바꿉니다(대학: 재학생/졸업생, 그 밖: 수강생/수료생).
 *
 * 런타임 의존성 없음, 다른 파일을 import하지 않습니다: 운영 CLI(packages/db/scripts/institution.ts)가 Node 타입 제거로 이 파일만 직접 불러 씁니다.
 * 해시(HMAC)는 서버·CLI가 node:crypto로 계산하고, 여기는 해시할 문자열(`inviteCodeHashMessage`)만 정합니다.
 */

/** affiliation.ts의 INSTITUTION_KINDS와 같은 값(이 파일을 단독으로 불러 쓰려고 다시 둡니다). */
export const INSTITUTION_KIND_VALUES = ['university', 'bootcamp', 'training_program', 'club_federation'] as const
export type InstitutionKindValue = (typeof INSTITUTION_KIND_VALUES)[number]
/** 대학이 아닌 기관 종류(새 인증 수단을 쓰는 곳). */
export const NON_UNIVERSITY_KINDS = ['bootcamp', 'training_program', 'club_federation'] as const
export type NonUniversityKind = (typeof NON_UNIVERSITY_KINDS)[number]

export const INSTITUTION_KIND_LABELS: Readonly<Record<InstitutionKindValue, string>> = {
  university: '대학',
  bootcamp: '부트캠프',
  training_program: '교육 프로그램',
  club_federation: '동아리 연합',
}

/** I-01에서 더한 인증 수단(대학이 아닌 기관에서만). */
export const INSTITUTION_METHODS = ['invite_code', 'cohort_approval', 'certificate_check'] as const
export type InstitutionMethod = (typeof INSTITUTION_METHODS)[number]

export const AFFILIATION_METHOD_LABELS: Readonly<Record<'email' | InstitutionMethod, string>> = {
  email: '학교 메일',
  invite_code: '초대 코드',
  cohort_approval: '기수 승인',
  certificate_check: '수료증 확인',
}

export function isNonUniversityKind(kind: string): kind is NonUniversityKind {
  return (NON_UNIVERSITY_KINDS as readonly string[]).includes(kind)
}

/** 기관 종류에 맞는 재학 상태 글자. 대학은 재학생/졸업생, 그 밖은 수강생/수료생. */
export function standingLabelFor(kind: string, standing: 'student' | 'alumni'): string {
  if (kind === 'university') return standing === 'alumni' ? '졸업생' : '재학생'
  return standing === 'alumni' ? '수료생' : '수강생'
}

/** courses.ts의 normalizeLabel과 같은 규칙. */
const normalizeLabel = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim()

// ── 기관 이름 ────────────────────────────────────────────────────────────

export const INSTITUTION_NAME_MAX = 80

/** 기관 이름: 공백 정리, 1–80자, 제어 문자 거부. */
export function normalizeInstitutionName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  const value = normalizeLabel(raw)
  if (!value || [...value].length > INSTITUTION_NAME_MAX) return null
  return value
}

/** 기관 이름 비교 키. courses.ts의 labelKey와 같은 규칙입니다(schools.name_key, 테스트로 같음을 확인). CLI가 이 파일만 불러 쓰려고 다시 둡니다. */
export function institutionNameKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, '')
}

// ── 기수 ─────────────────────────────────────────────────────────────────

export const COHORT_LABEL_MAX = 20

export type CohortLabelCheck = { ok: true; value: string; key: string } | { ok: false; reason: 'required' | 'too_long' | 'invalid' }

/**
 * 기수 이름(예: `12기`, `2026 봄`): 공백 정리, 1–20자, 줄바꿈·제어 문자 거부. key는 같은 기수 판정용(소문자, 공백 제거) — 같은 기관에서
 * `12 기`와 `12기`는 같은 기수입니다.
 */
export function normalizeCohortLabel(raw: unknown): CohortLabelCheck {
  if (raw === null || raw === undefined) return { ok: false, reason: 'required' }
  if (typeof raw !== 'string') return { ok: false, reason: 'invalid' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = normalizeLabel(raw)
  if (!value) return { ok: false, reason: 'required' }
  if ([...value].length > COHORT_LABEL_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, value, key: value.toLowerCase().replace(/\s+/g, '') }
}

// ── 초대 코드 ────────────────────────────────────────────────────────────

/** 헷갈리는 글자(0/O, 1/I/L, U)를 뺀 32자(Crockford base32). 12자 = 60비트. */
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const INVITE_CODE_LENGTH = 12
export const INVITE_CODE_MAX_USES = 1000
export const INVITE_CODE_DEFAULT_DAYS = 14
export const INVITE_CODE_MAX_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** 초대 코드 사용 시도 한도(고정 창, 시간당). 맞든 틀리든 셉니다(코드 추측 제한). */
export const INVITE_CODE_RATE_LIMITS = {
  perUser: { limit: 10, windowMs: HOUR_MS },
  perIp: { limit: 30, windowMs: HOUR_MS },
} as const

/** 기수 승인·수료증 요청 만들기 한도(사용자당 시간당). */
export const INSTITUTION_REQUEST_RATE_LIMIT = { limit: 10, windowMs: HOUR_MS } as const

/** 새 초대 코드(CSPRNG, 표시는 `XXXX-XXXX-XXXX`). 전역 Web Crypto를 씁니다. */
export function generateInviteCode(): string {
  const bytes = new Uint8Array(INVITE_CODE_LENGTH)
  globalThis.crypto.getRandomValues(bytes)
  let code = ''
  for (const b of bytes) code += INVITE_CODE_ALPHABET[b & 31]
  return formatInviteCode(code)
}

/** 정규 코드(12자) → 표시 형식. */
export function formatInviteCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8, 12)}`
}

/**
 * 입력한 코드 → 정규 코드(대문자 12자). 공백·하이픈은 무시하고, 헷갈리는 글자는 Crockford 규칙으로 바꿉니다(O→0, I·L→1).
 * 형식이 틀리면 null.
 */
export function normalizeInviteCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  const value = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  if (value.length !== INVITE_CODE_LENGTH) return null
  for (const ch of value) if (!INVITE_CODE_ALPHABET.includes(ch)) return null
  return value
}

/** HMAC에 넣을 문자열(서버·CLI가 같은 값을 씀). 정규 코드만 받습니다. */
export function inviteCodeHashMessage(normalizedCode: string): string {
  return `invite-code:v1:${normalizedCode}`
}

export interface InviteCodeState {
  expiresAt: Date
  maxUses: number
  usedCount: number
  revokedAt: Date | null
}

export type InviteRedemptionDecision = { ok: true } | { ok: false; reason: 'invite_code_revoked' | 'invite_code_expired' | 'invite_code_exhausted' }

/** 코드를 쓸 수 있는지. 철회 → 만료 → 한도 순으로 봅니다. */
export function decideInviteRedemption(code: InviteCodeState, now: Date): InviteRedemptionDecision {
  if (code.revokedAt) return { ok: false, reason: 'invite_code_revoked' }
  if (code.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'invite_code_expired' }
  if (code.usedCount >= code.maxUses) return { ok: false, reason: 'invite_code_exhausted' }
  return { ok: true }
}

export type InviteIssueCheck =
  | { ok: true; maxUses: number; expiresAt: Date }
  | { ok: false; field: 'maxUses' | 'expiresInDays'; reason: 'invalid' }

/** 발급 입력 검사: 사용 한도 1–1000(필수), 유효 기간 1–90일(기본 14일). */
export function checkInviteIssue(input: { maxUses: unknown; expiresInDays?: unknown }, now: Date): InviteIssueCheck {
  const maxUses = input.maxUses
  if (typeof maxUses !== 'number' || !Number.isInteger(maxUses) || maxUses < 1 || maxUses > INVITE_CODE_MAX_USES) {
    return { ok: false, field: 'maxUses', reason: 'invalid' }
  }
  const days = input.expiresInDays ?? INVITE_CODE_DEFAULT_DAYS
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > INVITE_CODE_MAX_DAYS) {
    return { ok: false, field: 'expiresInDays', reason: 'invalid' }
  }
  return { ok: true, maxUses, expiresAt: new Date(now.getTime() + days * DAY_MS) }
}

// ── 기수 승인 ────────────────────────────────────────────────────────────

/** 기수 승인으로 인증되는 데 필요한 승인 수(초기안, SYSTEM_DESIGN §6.7.2). */
export const COHORT_APPROVALS_REQUIRED = 2
/** 승인을 다 받지 못한 기수 승인 요청은 30일 뒤 만료됩니다(worker). */
export const COHORT_APPROVAL_TTL_MS = 30 * DAY_MS

export interface ApproverAffiliation {
  userId: string
  status: string
  method: string
  /** 정본 기관 id. */
  institutionId: string
  cohortId: string | null
}

export interface CohortApprovalRequest {
  userId: string
  status: string
  method: string
  institutionId: string
  cohortId: string | null
}

/** 승인자 자격: 같은 정본 기관·같은 기수의 active 인증이고, 그 인증이 기수 승인이 아닌 수단이어야 합니다. */
export function isEligibleCohortApprover(approver: ApproverAffiliation, request: Pick<CohortApprovalRequest, 'institutionId' | 'cohortId'>): boolean {
  return (
    approver.status === 'active' &&
    approver.method !== 'cohort_approval' &&
    approver.cohortId !== null &&
    approver.cohortId === request.cohortId &&
    approver.institutionId === request.institutionId
  )
}

export type CohortApprovalDecision =
  | { ok: true; approvals: number; verified: boolean }
  | { ok: false; reason: 'not_pending' | 'self_approval' | 'not_eligible' | 'already_approved' }

/**
 * 승인 한 번의 결과. 요청이 pending·기수 승인이 아니면 not_pending, 본인이면 self_approval, 자격 있는 인증이 없으면 not_eligible,
 * 이미 승인했으면 already_approved. 통과하면 승인 수(이번 포함)와 인증 여부(필요 수에 이르렀는지).
 * `priorApprovers`는 이미 승인한 사용자 id들(자격은 승인할 때 확인했으므로 다시 보지 않음).
 */
export function decideCohortApproval(
  request: CohortApprovalRequest,
  approverUserId: string,
  approverAffiliations: readonly ApproverAffiliation[],
  priorApprovers: readonly string[],
): CohortApprovalDecision {
  if (request.status !== 'pending' || request.method !== 'cohort_approval' || !request.cohortId) return { ok: false, reason: 'not_pending' }
  if (approverUserId === request.userId) return { ok: false, reason: 'self_approval' }
  if (!approverAffiliations.some((a) => a.userId === approverUserId && isEligibleCohortApprover(a, request))) return { ok: false, reason: 'not_eligible' }
  if (priorApprovers.includes(approverUserId)) return { ok: false, reason: 'already_approved' }
  const approvals = new Set([...priorApprovers, approverUserId]).size
  return { ok: true, approvals, verified: approvals >= COHORT_APPROVALS_REQUIRED }
}

// ── 수료증 확인 ──────────────────────────────────────────────────────────

/** 수료증 파일은 결정 뒤 이 기간 안에 지웁니다(worker 주기 작업은 10분마다라 실제로는 결정 직후). */
export const CERTIFICATE_FILE_MAX_RETENTION_MS = 7 * DAY_MS
/** 결정하지 않은 수료증 요청은 30일 뒤 만료하고 파일을 지웁니다. */
export const CERTIFICATE_PENDING_TTL_MS = 30 * DAY_MS
/** 올리지 않은 요청(파일 없음)은 하루 뒤 만료합니다. */
export const CERTIFICATE_UPLOAD_TTL_MS = DAY_MS
/** 수료증 파일 최대 크기(10MB). */
export const CERTIFICATE_MAX_BYTES = 10 * 1024 * 1024
/** 운영자 열람 서명 URL 유효 시간(60초, SYSTEM_DESIGN §10). */
export const CERTIFICATE_FILE_URL_TTL_MS = 60 * 1000
/** 받는 형식: 이미지(PNG·JPEG·WebP)와 PDF. */
export const CERTIFICATE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const
export type CertificateMediaType = (typeof CERTIFICATE_MEDIA_TYPES)[number]
export const CERTIFICATE_RESULTS = ['approved', 'rejected'] as const
export type CertificateResult = (typeof CERTIFICATE_RESULTS)[number]

const CERTIFICATE_EXTENSIONS: Readonly<Record<CertificateMediaType, readonly string[]>> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
}

export type CertificateUploadCheck =
  | { ok: true; mediaType: CertificateMediaType; extension: string; byteSize: number }
  | { ok: false; field: 'declaredType' | 'fileName' | 'byteSize'; reason: 'unsupported_type' | 'extension_mismatch' | 'too_large' | 'invalid' }

/**
 * 수료증 업로드 선언 검사. 원래 파일 이름은 확장자만 보고 저장하지 않습니다(이름에 사람 이름이 들어 있는 경우가 많음).
 */
export function checkCertificateUpload(input: { declaredType: unknown; fileName: unknown; byteSize: unknown }): CertificateUploadCheck {
  const type = input.declaredType
  if (typeof type !== 'string' || !(CERTIFICATE_MEDIA_TYPES as readonly string[]).includes(type)) {
    return { ok: false, field: 'declaredType', reason: 'unsupported_type' }
  }
  const mediaType = type as CertificateMediaType
  if (typeof input.fileName !== 'string' || input.fileName.length > 255) return { ok: false, field: 'fileName', reason: 'invalid' }
  const base = input.fileName.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (!CERTIFICATE_EXTENSIONS[mediaType].includes(extension)) return { ok: false, field: 'fileName', reason: 'extension_mismatch' }
  const size = input.byteSize
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) return { ok: false, field: 'byteSize', reason: 'invalid' }
  if (size > CERTIFICATE_MAX_BYTES) return { ok: false, field: 'byteSize', reason: 'too_large' }
  return { ok: true, mediaType, extension, byteSize: size }
}

export interface CertificateFileState {
  /** 결정 시각(승인·거절). */
  decidedAt: Date | null
  /** 소속 행 상태(사용자가 취소하거나 새 요청으로 대체되면 pending이 아님). */
  affiliationStatus: string
  scanStatus: string
  uploadedAt: Date | null
  createdAt: Date
  filePurgedAt: Date | null
}

export type CertificateFileDue = { due: false } | { due: true; reason: 'decided' | 'closed' | 'rejected_scan' | 'not_uploaded' | 'stale' }

/**
 * 수료증 파일을 지울 때인지(worker `certificate-files`). 결정했거나, 요청이 끝났거나(취소·대체·만료), 검사에서 격리·실패했거나,
 * 하루 안에 올리지 않았거나, 30일 동안 결정되지 않았으면 지웁니다. 이미 지웠으면 due 아님.
 */
export function certificateFileDue(state: CertificateFileState, now: Date): CertificateFileDue {
  if (state.filePurgedAt) return { due: false }
  if (state.decidedAt) return { due: true, reason: 'decided' }
  if (state.affiliationStatus !== 'pending') return { due: true, reason: 'closed' }
  if (state.scanStatus === 'quarantined' || state.scanStatus === 'failed') return { due: true, reason: 'rejected_scan' }
  if (!state.uploadedAt && now.getTime() - state.createdAt.getTime() >= CERTIFICATE_UPLOAD_TTL_MS) return { due: true, reason: 'not_uploaded' }
  if (now.getTime() - state.createdAt.getTime() >= CERTIFICATE_PENDING_TTL_MS) return { due: true, reason: 'stale' }
  return { due: false }
}

/** 운영자가 결정할 수 있는지: 결정 전, 요청 pending, 검사 통과. */
export function canDecideCertificate(state: Pick<CertificateFileState, 'decidedAt' | 'affiliationStatus' | 'scanStatus' | 'filePurgedAt'>): boolean {
  return !state.decidedAt && !state.filePurgedAt && state.affiliationStatus === 'pending' && state.scanStatus === 'clean'
}
