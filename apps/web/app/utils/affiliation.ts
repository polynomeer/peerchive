/**
 * 학교 메일 인증 화면 도우미(C-01, ADR 0018). 상태·재학 여부는 색이 아니라 글자로 보여 줍니다.
 */
import { AFFILIATION_CODE_MAX_ATTEMPTS, AFFILIATION_STANDING_LABELS, DEPARTMENT_LABEL_MAX } from '@peerchive/domain'
import type { AffiliationDto, AffiliationStatus } from '~~/shared/types/api'

export { AFFILIATION_CODE_MAX_ATTEMPTS, AFFILIATION_STANDING_LABELS, DEPARTMENT_LABEL_MAX }

export const AFFILIATION_STATUS_LABELS: Record<AffiliationStatus, string> = {
  pending: '코드 확인 대기',
  active: '인증됨',
  revoked: '해제됨',
  expired: '만료됨',
}

export function affiliationRevokedLabel(item: Pick<AffiliationDto, 'revokedReason'>): string {
  switch (item.revokedReason) {
    case 'operator':
      return '운영자가 취소함'
    case 'merged_duplicate':
      return '학교 병합으로 정리됨'
    default:
      return '내가 해제함'
  }
}

export const AFFILIATION_ERROR_MESSAGES: Record<string, string> = {
  domain_not_allowed: '이 학교에 등록된 메일 도메인이 아닙니다. 학교에서 받은 메일 주소인지 확인하세요. 도메인이 아직 등록되지 않았다면 운영자에게 알려 주세요.',
  already_verified: '이 학교는 이미 인증되어 있습니다.',
  request_in_progress: '같은 요청을 처리하고 있습니다. 잠시 뒤 다시 시도하세요.',
  rate_limited: '요청이 너무 많습니다. 한 시간 뒤 다시 시도하세요.',
  code_mismatch: '인증 코드가 맞지 않습니다.',
  code_expired: '인증 코드가 만료되었습니다(10분). 코드를 다시 받으세요.',
  attempts_exceeded: '코드를 5번 틀려 이 요청이 잠겼습니다. 코드를 다시 받으세요.',
  code_unavailable: '이 코드는 더 쓸 수 없습니다. 코드를 다시 받으세요.',
  email_in_use: '이 학교 메일은 이미 다른 계정에서 인증되었습니다. 한 메일 주소로는 한 계정만 인증할 수 있습니다.',
  not_editable: '해제되었거나 만료된 인증은 고칠 수 없습니다.',
  not_found: '찾을 수 없습니다. 학교를 다시 고르세요.',
}

export function affiliationErrorMessage(code: string): string {
  return AFFILIATION_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}

/** 서울 시각 HH:MM. */
export function seoulTime(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
}

/** 사이트 안 경로만 돌아갈 곳으로 받습니다(열린 리디렉트 방지). */
export function safeReturnPath(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : null
}
