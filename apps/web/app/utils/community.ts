/**
 * 커뮤니티 화면 도우미(C-02, ADR 0019). 상태·역할은 색이 아니라 글자로 보여 줍니다.
 */
import {
  BOARD_KIND_LABELS,
  JOIN_POLICY_LABELS,
  MAX_BOARDS_PER_ROOM,
  NAME_MODE_LABELS,
  ROOM_BOARD_KINDS,
  SPACE_DESCRIPTION_MAX,
  SPACE_KIND_LABELS,
  SPACE_NAME_MAX,
  SPACE_ROLE_LABELS,
  USER_ROOM_DEFAULT_CAPACITY,
  REAL_NAME_MAX,
  nameModeBannerText,
  noticeText,
  postNoticeText,
  COMMENT_BODY_MAX,
  POST_BODY_MAX,
  POST_TITLE_MAX,
  COMMUNITY_TIME_BUCKET_LABELS,
  RECRUITMENT_KIND_LABELS,
  RECRUITMENT_STATUS_LABELS,
  APPLICATION_STATUS_TEXT,
  RECRUITMENT_TITLE_MAX,
  RECRUITMENT_DESCRIPTION_MAX,
  RECRUITMENT_CAPACITY_MIN,
  RECRUITMENT_CAPACITY_MAX,
  APPLICATION_MESSAGE_MAX,
  APPLICATION_CASES_MAX,
  ARCHIVE_TARGET_LABELS,
  ARCHIVE_STATUS_LABELS,
  ARCHIVE_CANCEL_REASON_LABELS,
  ARCHIVED_MARKER_TEXT,
  COURSE_QA_ANONYMOUS_LABELS,
  ROOM_BADGE_LABELS,
  ROOM_COHORT_LABEL_MAX,
  ROOM_PROFILE_BIO_MAX,
  ROOM_PROFILE_NAME_MAX,
  SPACE_TEMPLATE_LABELS,
} from '@peerchive/domain'
import type { CommunityItemStatus, SpaceStatus } from '~~/shared/types/api'
import { formatDateTime } from './build-log'

export {
  BOARD_KIND_LABELS,
  JOIN_POLICY_LABELS,
  MAX_BOARDS_PER_ROOM,
  NAME_MODE_LABELS,
  ROOM_BOARD_KINDS,
  SPACE_DESCRIPTION_MAX,
  SPACE_KIND_LABELS,
  SPACE_NAME_MAX,
  SPACE_ROLE_LABELS,
  USER_ROOM_DEFAULT_CAPACITY,
  REAL_NAME_MAX,
  nameModeBannerText,
  noticeText,
  postNoticeText,
  COMMENT_BODY_MAX,
  POST_BODY_MAX,
  POST_TITLE_MAX,
  COMMUNITY_TIME_BUCKET_LABELS,
  RECRUITMENT_KIND_LABELS,
  RECRUITMENT_STATUS_LABELS,
  APPLICATION_STATUS_TEXT,
  RECRUITMENT_TITLE_MAX,
  RECRUITMENT_DESCRIPTION_MAX,
  RECRUITMENT_CAPACITY_MIN,
  RECRUITMENT_CAPACITY_MAX,
  APPLICATION_MESSAGE_MAX,
  APPLICATION_CASES_MAX,
  ARCHIVE_TARGET_LABELS,
  ARCHIVE_STATUS_LABELS,
  ARCHIVE_CANCEL_REASON_LABELS,
  ARCHIVED_MARKER_TEXT,
  COURSE_QA_ANONYMOUS_LABELS,
  ROOM_BADGE_LABELS,
  ROOM_COHORT_LABEL_MAX,
  ROOM_PROFILE_BIO_MAX,
  ROOM_PROFILE_NAME_MAX,
  SPACE_TEMPLATE_LABELS,
}

/** 글·댓글 상태(운영 화면). */
export const COMMUNITY_ITEM_STATUS_LABELS: Record<CommunityItemStatus, string> = {
  published: '게시 중',
  deleted_by_author: '작성자가 지움',
  hidden: '운영 조치로 가려짐',
  auto_hidden: '신고 누적으로 임시 숨김(운영 검토 중)',
}

/** 글·댓글 시각(정확한 시각 또는 소규모 익명 방의 버킷). */
export function communityTimeText(item: { createdAt: string | null; createdBucket: 'today' | 'this_week' | 'earlier' | null }): string {
  if (item.createdAt) return formatDateTime(item.createdAt)
  return item.createdBucket ? COMMUNITY_TIME_BUCKET_LABELS[item.createdBucket] : ''
}

export const SPACE_STATUS_LABELS: Record<SpaceStatus, string> = {
  active: '운영 중',
  archived: '보관됨(읽기만)',
  restricted: '운영 조치로 제한됨(읽기만)',
}

/** 이름 표시 방식 설명(방 만들기·방식 바꾸기 화면). 바꾸면 7일 뒤부터 쓰는 글에만 적용됩니다(C-03). */
export const NAME_MODE_HINTS: Record<keyof typeof NAME_MODE_LABELS, string> = {
  real: '계정에 입력한 실명(커뮤니티 화면에서 선택 입력)으로 글을 씁니다(Peerchive가 신분을 확인하지 않음). 가입은 승인제가 기본입니다.',
  display: '공개 프로필의 표시명으로 씁니다. 실명은 보이지 않습니다.',
  anonymous: '글마다 익명으로 씁니다. 방장도 작성자를 볼 수 없습니다. 소규모 익명 방은 말투·시간으로 작성자가 추정될 수 있습니다.',
}

export const COMMUNITY_ERROR_MESSAGES: Record<string, string> = {
  affiliation_required: '학교 메일 인증이 필요합니다. 학교 인증을 마친 뒤 다시 시도하세요.',
  already_member: '이미 이 방의 멤버입니다.',
  already_pending: '이미 가입을 요청했습니다. 방장의 승인을 기다리세요.',
  invite_only: '초대 링크로만 들어갈 수 있는 방입니다.',
  removed: '이 방에는 다시 들어갈 수 없습니다. 방장에게 새 초대를 받으세요.',
  space_full: '정원이 찼습니다.',
  not_joinable: '공식 페이지는 가입하지 않고 학교 인증으로 들어갑니다.',
  space_not_active: '보관되었거나 제한된 공간이라 바꿀 수 없습니다.',
  room_profiles_unavailable: '익명 방에는 방별 프로필이 없습니다.',
  not_member: '이 공간의 멤버가 아닙니다.',
  not_pending: '이미 처리된 요청입니다.',
  not_active_member: '현재 멤버가 아닙니다.',
  use_leave: '자기 자신은 나가기로 떠나세요.',
  self: '자기 역할은 바꿀 수 없습니다. 방장을 넘기려면 다른 멤버에게 방장 역할을 주세요.',
  title_taken: '같은 이름의 게시판이 있습니다.',
  too_many_boards: `게시판은 ${MAX_BOARDS_PER_ROOM}개까지 만들 수 있습니다.`,
  official_exists: '이미 열린 공식 페이지가 있습니다.',
  link_unavailable: '쓸 수 없는 초대 링크입니다(만료·사용·취소됨).',
  rate_limited: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.',
  name_mode_fixed: '공식 페이지의 이름 표시 방식은 익명으로 고정되어 바꿀 수 없습니다.',
  change_already_scheduled: '이미 예약된 변경이 있습니다. 먼저 취소하세요.',
  already_effective: '이미 적용 시각이 지나 취소할 수 없습니다.',
  not_scheduled: '이미 적용되었거나 취소된 예약입니다.',
  not_found: '찾을 수 없습니다.',
  write_not_allowed: '이 게시판에 쓸 자격이 없습니다.',
  real_name_required: '이 방은 실명으로 표시됩니다. 커뮤니티 화면에서 실명(선택)을 먼저 입력하세요.',
  display_persona_required: '표시명으로 쓰려면 먼저 설정의 표시명 프로필(/settings/personas)을 만드세요. 계정 이름은 표시명으로 쓰지 않습니다.',
  post_not_open: '지워졌거나 가려진 글에는 댓글을 쓸 수 없습니다.',
  parent_not_open: '지워졌거나 가려진 댓글에는 답글을 쓸 수 없습니다.',
  not_open: '이미 지워졌거나 가려져 고칠 수 없습니다.',
  not_author: '내가 쓴 글만 고치거나 지울 수 있습니다.',
  version_conflict: '그사이 다른 곳에서 고쳐졌습니다. 새로 불러온 뒤 다시 고치세요.',
  own_item: '내 글에는 공감할 수 없습니다.',
  target_not_open: '지워졌거나 가려진 글입니다.',
  too_large: '내용이 너무 깁니다.',
  forbidden: '이 작업을 할 권한이 없습니다.',
  write_restricted: '이용 제한으로 지금은 글·댓글·공감을 쓸 수 없습니다. 운영 조치 안내에서 사유를 확인하고 이의를 제기할 수 있습니다.',
  moderate_not_allowed: '이 공간의 운영진만 할 수 있습니다.',
  not_space_hidden: '방 운영진이 가린 상태가 아닙니다(이미 되돌렸거나 운영자가 가렸습니다).',
  // C-08 스터디 기록
  not_study_room: '스터디 방에서만 기록을 켤 수 있습니다.',
  already_enabled: '이미 스터디 기록이 켜져 있습니다.',
  study_managed: '스터디 기록의 멤버는 스터디 방 멤버를 따릅니다. 멤버 관리는 스터디 방에서 하세요.',
  // C-07 모집·지원
  no_recruiting_board: '이 공간에는 모집 게시판이 없습니다. 방장·운영진이 모집 게시판을 더하면 올릴 수 있습니다.',
  team_finding_disabled: '수업에서 팀을 배정하는 과목이라 팀원 찾기를 쓸 수 없습니다(스터디 모집은 됩니다).',
  course_required: '팀원 찾기는 과목을 골라야 합니다.',
  host_required: '모집을 올릴 공간이나 과목이 필요합니다.',
  own_recruitment: '내가 올린 모집에는 지원할 수 없습니다.',
  recruitment_not_open: '모집 중이 아닙니다(마감·취소되었거나 마감 예정 시각이 지났습니다).',
  already_applied: '이미 지원했습니다.',
  not_applied: '지원한 적이 없습니다.',
  not_withdrawable: '이미 처리된 지원이라 취소할 수 없습니다.',
  recruiter_only: '모집자만 할 수 있습니다.',
  capacity_full: '모집 인원만큼 이미 선정했습니다.',
  no_accepted: '선정한 지원자가 한 명 이상 있어야 마감할 수 있습니다. 모집을 멈추려면 취소하세요.',
  not_selected: '선정된 지원자만 초대를 받을 수 있습니다.',
  not_closed: '모집이 마감된 뒤에 초대를 받을 수 있습니다.',
  invitation_unavailable: '지금은 초대를 받을 수 없습니다(모집자가 더는 운영하지 않거나 공간이 닫혔습니다).',
  // C-09 채택된 답변·아카이브로 옮기기
  not_question_board: '질문 게시판의 글에서만 할 수 있습니다.',
  comment_not_open: '지워졌거나 가려진 댓글은 채택할 수 없습니다.',
  source_not_open: '지워졌거나 가려진 글은 옮길 수 없습니다.',
  no_accepted_answer: '먼저 답변 하나를 채택하세요.',
  transfer_pending: '같은 곳으로 옮기는 요청이 이미 진행 중입니다.',
  already_transferred: '이 글은 이미 막힘 Q&A로 옮겨져 있습니다.',
  hub_write_not_allowed: '이 과목 학교의 메일로 인증해야 과목 허브로 옮길 수 있습니다.',
  checks_unconfirmed: '공개 전 점검 경고가 있습니다. 내용을 확인한 뒤 "경고를 확인했습니다"에 체크하세요.',
  limit_reached: '이 과목에는 선배 노트를 더 만들 수 없습니다(과목당 3개).',
  already_decided: '이미 동의 여부를 정했습니다.',
  stale_content: '옮길 내용이 바뀌었습니다. 새로 불러온 뒤 다시 확인하세요.',
}

/** 옮기기 입력 오류(422 필드별). */
export const ARCHIVE_FIELD_ERRORS: Record<string, string> = {
  'courseId:required': '과목을 고르세요.',
  'courseId:not_found': '과목을 찾을 수 없습니다.',
  'courseId:other_school': '이 공간의 학교 과목만 고를 수 있습니다.',
  'projectId:required': '과제를 고르세요.',
  'projectId:not_found': '과제를 찾을 수 없습니다.',
  'projectId:not_writable': '내가 owner·editor인 과제만 고를 수 있습니다.',
  'displayMode:required': '복사본에 보일 이름을 고르세요.',
  'displayMode:real_name_required': '실명을 고르려면 커뮤니티 화면에서 실명(선택)을 먼저 입력하세요.',
  'displayMode:display_persona_required': '표시명을 고르려면 먼저 설정의 표시명 프로필(/settings/personas)을 만드세요.',
  'displayName:required': '표시명을 입력하세요.',
  'timeBucket:required': '막혔던 시간을 고르세요.',
  'notAnswerConfirmed:confirm_required': '답변이 과제 답 자체가 아님을 확인해 주세요.',
  'noAnswersConfirmed:confirm_required': '정답·답안·교수 개인 평가가 없음을 확인해 주세요.',
  'answerKey:required': '글을 넣을 질문을 고르세요.',
  'source:too_long': '원 글이 너무 길어 이 곳으로 옮길 수 없습니다.',
  'contentHash:required': '옮길 내용을 다시 불러온 뒤 시도하세요.',
}

export function archiveFieldErrors(fields: Record<string, string> | undefined): string[] {
  if (!fields) return []
  return Object.entries(fields).map(([k, v]) => ARCHIVE_FIELD_ERRORS[`${k}:${v}`] ?? '입력한 내용을 확인하세요.')
}

export function communityErrorMessage(code: string): string {
  return COMMUNITY_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}

export const SPACE_NAME_ERRORS: Record<string, string> = {
  required: '이름을 입력하세요.',
  too_long: `이름은 ${SPACE_NAME_MAX}자까지입니다.`,
  reserved: '`공식`·`학생회`·`운영자`·`관리자`·`Peerchive` 같은 말은 사용자 방 이름에 쓸 수 없습니다.',
  invalid: '쓸 수 없는 글자가 있습니다.',
}

export const NAME_MODE_CHANGE_STATUS_LABELS: Record<'scheduled' | 'applied' | 'cancelled', string> = {
  scheduled: '예약됨',
  applied: '적용됨',
  cancelled: '취소됨',
}
