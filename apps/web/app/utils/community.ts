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
}

/** 글·댓글 상태(운영 화면). */
export const COMMUNITY_ITEM_STATUS_LABELS: Record<CommunityItemStatus, string> = {
  published: '게시 중',
  deleted_by_author: '작성자가 지움',
  hidden: '운영 조치로 가려짐',
  auto_hidden: '신고 누적으로 임시 숨김',
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
  post_not_open: '지워졌거나 가려진 글에는 댓글을 쓸 수 없습니다.',
  parent_not_open: '지워졌거나 가려진 댓글에는 답글을 쓸 수 없습니다.',
  not_open: '이미 지워졌거나 가려져 고칠 수 없습니다.',
  not_author: '내가 쓴 글만 고치거나 지울 수 있습니다.',
  version_conflict: '그사이 다른 곳에서 고쳐졌습니다. 새로 불러온 뒤 다시 고치세요.',
  own_item: '내 글에는 공감할 수 없습니다.',
  target_not_open: '지워졌거나 가려진 글입니다.',
  too_large: '내용이 너무 깁니다.',
  forbidden: '이 작업을 할 권한이 없습니다.',
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
