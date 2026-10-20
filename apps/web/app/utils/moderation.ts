/**
 * 신고·운영 조치 화면 문구(T-15, ADR 0015). 서버 응답 코드·값을 한국어로 바꿉니다.
 */
import type { AppealStatus, ModerationActionKind, MyReportDto, ReportReason, ReportTargetRef, ReportTargetType } from '~~/shared/types/api'

/** 신고 대화상자의 대상 하나(공개 화면에 보이는 값으로만 가리킴). */
export interface ReportChoice {
  id: string
  label: string
  targetType: ReportTargetType
  targetRef: ReportTargetRef
}

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  personal_info: '개인정보 노출',
  answer_sharing: '과제 답안·정답 공유',
  copyright: '저작권·권리 침해',
  harassment: '괴롭힘·비방',
  false_claim: '거짓 기여 주장',
  spam: '스팸·홍보',
  other: '기타',
}

export const REPORT_REASON_HINTS: Partial<Record<ReportReason, string>> = {
  personal_info: '전화번호·주소·학번 등. 처리될 때까지 이 사례의 새 게시가 보류됩니다.',
  copyright: '타인의 저작물·과제 원문 등. 처리될 때까지 이 사례의 새 게시가 보류됩니다.',
}

export const REPORT_TARGET_LABELS: Record<ReportTargetType, string> = {
  publication: '공개 사례',
  publication_item: '공개 사례의 항목',
  senior_note: '선배 노트',
  case_study: '케이스 스터디',
  profile: '공개 프로필',
}

export const REPORTER_STATUS_LABELS: Record<MyReportDto['status'], string> = {
  received: '접수됨',
  in_review: '검토 중',
  resolved: '처리됨',
  dismissed: '기각됨',
}

export const ACTION_LABELS: Record<ModerationActionKind, string> = {
  none: '조치 없음',
  restrict: '공개 사례 전체 비공개(운영 제한)',
  hide_item: '항목 하나 가리기',
  hide_note: '선배 노트 숨기기',
  hide_case_study: '케이스 스터디 숨기기',
  hide_profile: '공개 프로필 숨기기',
}

/** 당사자에게 보이는 조치 설명. */
export const NOTICE_TITLES: Record<Exclude<ModerationActionKind, 'none'>, string> = {
  restrict: '운영 조치로 비공개',
  hide_item: '운영 조치로 가려진 항목이 있습니다',
  hide_note: '운영 조치로 숨겨진 선배 노트',
  hide_case_study: '운영 조치로 숨겨진 케이스 스터디',
  hide_profile: '운영 조치로 숨겨진 공개 프로필',
}

export const APPEAL_STATUS_LABELS: Record<AppealStatus, string> = {
  open: '이의제기 검토 중',
  upheld: '이의제기 검토 결과 조치 유지',
  reversed: '이의제기가 받아들여져 조치가 풀렸습니다',
}

export const MODERATION_ERROR_MESSAGES: Record<string, string> = {
  not_found: '지금 공개되어 있지 않은 대상입니다. 이미 내려갔을 수 있습니다.',
  rate_limited: '신고가 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  unauthenticated: '로그인이 필요합니다.',
  already_appealed: '이 조치에는 이미 이의를 제기했습니다.',
  already_reversed: '이미 풀린 조치입니다.',
  not_appealable: '이의제기 대상이 아닙니다.',
  already_closed: '이미 처리된 신고입니다.',
  target_not_public: '대상이 이미 그 조치를 받을 수 없는 상태입니다(공개 중이 아니거나 이미 숨김).',
  not_restricted: '운영 제한 상태가 아닙니다.',
  already_decided: '이미 결정한 이의제기입니다.',
  operator_only: '운영자만 할 수 있습니다.',
}

export function moderationErrorMessage(code: string): string {
  return MODERATION_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}
