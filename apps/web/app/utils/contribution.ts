/**
 * 역할 선언·팀원 확인·기여 장부 화면 도우미(T-08, PROOFU_EVOLUTION_PLAN §7).
 * 상태는 색이 아니라 글자로 보여 주고(시나리오 H), 점수·비율·순위를 만들지 않습니다.
 */
import type {
  ClaimDto,
  ClaimEvidenceDto,
  LedgerMemberDto,
  LogDto,
  LogTag,
  ProjectRole,
} from '~~/shared/types/api'
import { fieldMessage } from './api-error'
import { SCAN_STATUS_LABELS } from './artifacts'
import { LOG_TAG_LABELS, LOG_TAG_ORDER } from './build-log'

/** 서버 한도와 같은 값(@peerchive/domain). 화면 안내용이며 최종 판정은 서버가 합니다. */
export const CLAIM_TEXT_MAX = 300
export const CLAIM_EVIDENCE_MAX = 20
export const CLAIM_LIMIT_PER_MEMBER = 10
export const ENDORSEMENT_NOTE_MAX = 500

/** 선언·확인할 수 있는 역할(viewer는 읽기만). */
export const canDeclare = (role: ProjectRole | undefined) => role === 'owner' || role === 'editor' || role === 'reviewer'

/** 상태 문구: 본인 설명 · 미확인 / 팀원 확인 N명 / 이의 있음. */
export function claimStatusLabel(claim: Pick<ClaimDto, 'status' | 'confirmedCount' | 'disputedCount'>): string {
  if (claim.status === 'disputed') {
    return claim.confirmedCount > 0 ? `이의 있음 (확인 ${claim.confirmedCount}명 · 이의 ${claim.disputedCount}명)` : `이의 있음 (${claim.disputedCount}명)`
  }
  if (claim.status === 'confirmed') return `팀원 확인 ${claim.confirmedCount}명`
  return '본인 설명 · 미확인'
}

export const ENDORSEMENT_LABELS = { confirmed: '확인', disputed: '이의 제기' } as const

/** 근거 칩 문구(종류 표시 포함). */
export function evidenceLabel(evidence: ClaimEvidenceDto): string {
  if (evidence.kind === 'log') {
    const updated = evidence.currentRevisionNo > evidence.revisionNo ? ' (이후 수정됨)' : ''
    return `로그 ${LOG_TAG_LABELS[evidence.tag]} · ${evidence.summary || '내용 없음'}${updated}`
  }
  const status = evidence.scanStatus === 'clean' ? '' : ` · ${SCAN_STATUS_LABELS[evidence.scanStatus]}`
  return `파일 · ${evidence.title} v${evidence.versionNo}${status}`
}

/** 로그 한 줄 요약(서버 summarize와 같은 규칙: 막힘은 증상, 그 밖에는 본문 또는 대표 필드). */
export function logSummary(log: Pick<LogDto, 'tag' | 'body' | 'payload'>): string {
  const payload = log.payload as unknown as Record<string, unknown>
  const pick = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : '')
  const fallback: Partial<Record<LogTag, string>> = { solution: pick('method'), decision: pick('choice'), validation: pick('target') }
  const text = log.tag === 'stuck' ? pick('symptom') : log.body || fallback[log.tag] || ''
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/** 장부의 기록 종류 줄. 0인 종류는 빼고, 하나도 없으면 "기록 없음". */
export function activityParts(row: LedgerMemberDto): string[] {
  const parts: string[] = []
  for (const tag of LOG_TAG_ORDER) {
    const n = row.logCounts[tag]
    if (!n) continue
    parts.push(tag === 'stuck' && row.stuckResolved > 0 ? `${LOG_TAG_LABELS[tag]} ${n} (해결 ${row.stuckResolved})` : `${LOG_TAG_LABELS[tag]} ${n}`)
  }
  return parts
}

const CLAIM_ERRORS: Record<string, string> = {
  limit_reached: `역할 선언은 한 사람당 ${CLAIM_LIMIT_PER_MEMBER}개까지입니다. 비슷한 선언을 고쳐서 합쳐 보세요.`,
  stale_revision: '그 사이 이 선언이 수정되었습니다. 최신 내용을 불러왔으니 확인한 뒤 다시 저장하세요.',
  not_current: '그 사이 선언이 수정되어 새 버전이 되었습니다. 새 버전을 읽고 다시 확인해 주세요.',
  self_endorsement: '자기 선언은 직접 확인할 수 없습니다.',
}

export function claimErrorMessage(code: string, fallback: string): string {
  return CLAIM_ERRORS[code] ?? fallback
}

const PERIOD_FIELD_MESSAGES: Record<string, string> = {
  before_from: '끝 날짜가 시작 날짜보다 앞입니다.',
  too_long: '기간은 366일까지 고를 수 있습니다.',
}

export const periodFieldMessage = (code: string | undefined) => (code ? (PERIOD_FIELD_MESSAGES[code] ?? fieldMessage(code)) : undefined)

// ── 기간(Asia/Seoul, 월~일) ── 서버(@peerchive/domain seoulWeek)와 같은 계산입니다.

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

export function seoulWeek(at: Date, weeksAgo = 0): { from: string; to: string } {
  const today = new Date(at.getTime() + SEOUL_OFFSET_MS)
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const weekday = (today.getUTCDay() + 6) % 7
  const from = midnight - (weekday + weeksAgo * 7) * DAY_MS
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  return { from: iso(from), to: iso(from + 6 * DAY_MS) }
}

/** 2026-11-02 → 2026. 11. 2.(월) */
export function formatDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  return d.toLocaleDateString('ko-KR', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
}

export const formatPeriod = (from: string, to: string) => (from === to ? formatDay(from) : `${formatDay(from)} ~ ${formatDay(to)}`)
