/**
 * 과목 허브·선배 노트·검색 화면 도우미(T-13). 과목·학교 이름은 학생이 쓴 값이라 "학생 작성"을 붙이고, 상태는 글자로 보여 줍니다.
 */
import {
  SENIOR_NOTE_ANSWER_MAX,
  SENIOR_NOTE_QUESTIONS,
  SENIOR_NOTE_QUESTION_LABELS,
  SENIOR_NOTE_TIME_BUCKET_LABELS,
} from '@peerchive/domain'
import type { CheckinTimeBucket, SearchKind, SeniorNoteDisplayMode, SeniorNoteStatus } from '~~/shared/types/api'

export { SENIOR_NOTE_ANSWER_MAX, SENIOR_NOTE_QUESTIONS, SENIOR_NOTE_QUESTION_LABELS, SENIOR_NOTE_TIME_BUCKET_LABELS }

export const SENIOR_NOTE_DISPLAY_LABELS: Record<SeniorNoteDisplayMode, string> = {
  name: '계정 이름으로 표시',
  display: '직접 정한 표시명',
  anonymous: '익명("익명 선배")',
  affiliation: '소속 표시 유지(토픽에서 옮긴 답변만)',
}

export const SENIOR_NOTE_STATUS_LABELS: Record<SeniorNoteStatus, string> = {
  draft: '초안 · 공개 전',
  published: '공개 중',
  withdrawn: '철회됨',
  hidden: '운영자가 숨김',
}

export const CHECKIN_BUCKET_LABELS: Record<CheckinTimeBucket, string> = {
  none: '0시간',
  lt2h: '~2시간',
  lt5h: '~5시간',
  lt10h: '~10시간',
  ten_plus: '10시간 이상',
}

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  case: '공개 사례',
  stuck: '막힘',
  note: '선배 노트',
  qa: '막힘 Q&A',
}

export const COURSE_HUB_ERROR_MESSAGES: Record<string, string> = {
  unauthenticated: '로그인이 필요합니다.',
  hub_write_not_allowed: '이 학교 메일로 인증하면 선배 노트를 쓸 수 있습니다.',
  limit_reached: '이 과목에는 노트를 더 만들 수 없습니다(과목당 3개).',
  rate_limited: '잠시 뒤 다시 시도하세요(요청이 너무 많습니다).',
  version_conflict: '그 사이 노트가 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.',
  checks_unconfirmed: '공개 전 점검 경고가 있습니다. 내용을 확인한 뒤 "확인하고 게시"를 누르세요.',
  not_published: '게시되지 않은 노트입니다.',
  hidden: '운영자가 숨긴 노트는 고칠 수 없습니다.',
  not_found: '찾을 수 없습니다. 공개가 철회되었을 수 있습니다.',
  validation_failed: '입력을 확인하세요. 선배 노트는 질문 4개 중 2개 이상 답해야 게시할 수 있습니다(커뮤니티에서 옮겨 온 초안은 고쳐서 답을 더하세요).',
}

export function courseHubErrorMessage(code: string): string {
  return COURSE_HUB_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}

/** 학교 인증 페이지 주소. 학교를 미리 고르고, 인증 뒤 돌아올 곳(사이트 안 경로만)을 넘깁니다. */
export function affiliationPageLink(school?: { id: string; name: string } | null, returnTo?: string): string {
  const query = new URLSearchParams()
  if (school?.id) query.set('school', school.id)
  if (school?.name) query.set('schoolName', school.name)
  if (returnTo) query.set('return', returnTo)
  const qs = query.toString()
  return `/settings/affiliations${qs ? `?${qs}` : ''}`
}

/** 과목 허브의 노트 앵커. */
export const noteAnchor = (noteId: string) => `note-${noteId}`
