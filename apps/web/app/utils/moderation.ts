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
  impersonation: '표시명 사칭(다른 사람·단체로 오인하게 함)',
}

export const REPORT_REASON_HINTS: Partial<Record<ReportReason, string>> = {
  personal_info: '전화번호·주소·학번 등. 처리될 때까지 이 사례의 새 게시가 보류됩니다.',
  copyright: '타인의 저작물·과제 원문 등. 처리될 때까지 이 사례의 새 게시가 보류됩니다.',
  impersonation:
    '다른 실존 인물(교수·학생·졸업생 등)이나 학교·기업·단체로 오인하게 하는 이름·handle·소개. 비슷한 이름만으로는 사칭이 아니며, 확인되면 그 프로필만 숨기고 본인이 고친 뒤 이의제기로 다시 열 수 있습니다.',
}

/** 대상 종류별로 고를 수 있는 사유(서버 reasonApplicable과 같음): 표시명 사칭은 프로필 신고에만. */
export function reportReasonsFor(targetType: ReportTargetType): ReportReason[] {
  return (Object.keys(REPORT_REASON_LABELS) as ReportReason[]).filter((r) => r !== 'impersonation' || targetType === 'persona' || targetType === 'profile')
}

export const REPORT_TARGET_LABELS: Record<ReportTargetType, string> = {
  publication: '공개 사례',
  publication_item: '공개 사례의 항목',
  senior_note: '선배 노트',
  case_study: '케이스 스터디',
  profile: '공개 프로필',
  community_space: '커뮤니티 공간',
  community_post: '커뮤니티 글',
  community_comment: '커뮤니티 댓글',
  community_recruitment: '모집 글',
  community_application: '지원 메시지',
  course_qa: '막힘 Q&A',
  persona: '공개 프로필',
  profile_post: '프로필 글',
  social_link: '소셜 링크',
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
  restrict_space: '커뮤니티 공간 제한(읽기만, 가입·쓰기 중지)',
  archive_space: '커뮤니티 공간 보관(운영자 직접 조치)',
  hide_post: '커뮤니티 글 가리기',
  hide_comment: '커뮤니티 댓글 가리기',
  space_hide: '방 운영진이 가림',
  sanction: '이용 제한(제재)',
  hide_recruitment: '모집 글 가리기',
  hide_application: '지원 메시지 가리기',
  hide_qa: '막힘 Q&A 숨기기',
  hide_persona: '이 프로필만 숨기기(같은 사람의 다른 프로필은 그대로)',
  hide_profile_post: '프로필 글 숨기기',
  hide_social_link: '소셜 링크 숨기기',
}

/** 당사자에게 보이는 조치 설명. */
export const NOTICE_TITLES: Record<Exclude<ModerationActionKind, 'none'>, string> = {
  restrict: '운영 조치로 비공개',
  hide_item: '운영 조치로 가려진 항목이 있습니다',
  hide_note: '운영 조치로 숨겨진 선배 노트',
  hide_case_study: '운영 조치로 숨겨진 케이스 스터디',
  hide_profile: '운영 조치로 숨겨진 공개 프로필',
  restrict_space: '운영 조치로 제한된 커뮤니티 공간',
  archive_space: '운영 조치로 보관된 커뮤니티 공간',
  hide_post: '운영 조치로 가려진 커뮤니티 글',
  hide_comment: '운영 조치로 가려진 커뮤니티 댓글',
  space_hide: '방 운영진이 가린 커뮤니티 글·댓글',
  sanction: '커뮤니티 이용 제한',
  hide_recruitment: '운영 조치로 가려진 모집 글',
  hide_application: '운영 조치로 가려진 지원 메시지',
  hide_qa: '운영 조치로 숨겨진 막힘 Q&A',
  hide_persona: '운영 조치로 숨겨진 공개 프로필',
  hide_profile_post: '운영 조치로 숨겨진 프로필 글',
  hide_social_link: '운영 조치로 숨겨진 소셜 링크',
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
  lookup_not_yours: '다른 운영자의 작성자 확인으로는 제재를 발급할 수 없습니다. 사유를 적고 직접 확인하세요.',
  lookup_expired: '작성자 확인이 24시간이 지나 만료되었습니다. 사유를 적고 다시 확인하세요.',
  author_unavailable: '탈퇴 정리된 작성자에게는 제재를 발급할 수 없습니다.',
  already_revoked: '이미 해제된 제재입니다.',
  target_unavailable: '대상이 탈퇴 정리로 지워져 확인할 수 없습니다.',
  hidden: '운영 조치로 숨겨진 항목이라 지울 수 없습니다. 이의제기는 내 알림에서 할 수 있어요.',
}

/** 이용 제한 문구(C-06). */
export const SANCTION_LEVEL_TEXT: Record<'warning' | 'write_suspended' | 'permanent', string> = {
  warning: '경고(알림만)',
  write_suspended: '쓰기 기간 제한',
  permanent: '커뮤니티 영구 제한',
}
export const SANCTION_SCOPE_TEXT: Record<'community' | 'space', string> = { community: '커뮤니티 전체', space: '그 공간만' }

/** 커뮤니티 신고 대상이면 대화상자에 보일 안내(C-06): 여러 사람의 신고가 모이면 임시로 가려짐, 권리 침해는 별도 절차. */
export function communityReportHint(targetType: ReportTargetType): string | null {
  if (targetType !== 'community_post' && targetType !== 'community_comment') return null
  return '서로 다른 학교 인증 사용자의 신고가 일정 수 이상 모이면 운영 검토 전까지 임시로 가려집니다. 같은 글은 한 번만 신고할 수 있습니다. 저작권 등 권리 침해 게시 중단 요청은 운영자 안내에 따라 별도 절차로 처리합니다.'
}

export function moderationErrorMessage(code: string): string {
  return MODERATION_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}
