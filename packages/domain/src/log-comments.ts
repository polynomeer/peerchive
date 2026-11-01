/**
 * 로그별 피드백 댓글 (E-10, PROOFU_EVOLUTION_PLAN §16 협업 고도화, DELIVERY_PLAN §4.4 E-10, ADR 0054).
 *
 * 빌드 로그 한 건(log_entries)에 팀원이 남기는 피드백입니다. 이 파일은 규칙(권한·상태별 표시·본문 정규화)만 담고 런타임 의존성이 없습니다.
 *
 * - **팀 안에서만**: 읽기는 그 과제의 active 멤버 전체(canReadProjectWorkspace), 쓰기는 owner/editor/reviewer(§8 "reviewer는 피드백만",
 *   viewer는 읽기만). 비멤버는 존재를 드러내지 않는 404입니다(호출자가 처리).
 * - 댓글은 revision이 아니라 로그(entry)에 붙으므로 로그를 고쳐도 남습니다. 쓸 때의 revision 번호를 맥락으로만 기록합니다.
 * - **보관(archived) 과제는 읽기 전용**: 새 댓글·수정은 막고(409 `project_archived`), 삭제·숨김은 정리를 위해 허용합니다.
 * - 삭제는 작성자 본인만(본문을 비우는 소프트 삭제), 숨김·숨김 해제는 owner만. owner도 남의 댓글을 고치거나 지우지 않습니다.
 * - 댓글은 공개 스냅샷·공개 DTO·검색·케이스·기여 장부 어디에도 들어가지 않습니다(공개 여부 분리, ADR 0011 허용 목록에 없음).
 */
import { type Membership, type ProjectRef, type Viewer, canReadProjectWorkspace } from './permissions'

/** 댓글 본문 최대 길이(글자). */
export const LOG_COMMENT_BODY_MAX = 2000
/** 로그 하나에 보여 줄 댓글 수 한도(오래된 순). */
export const LOG_COMMENT_LIMIT = 200

/** 상태: 게시 / 작성자가 지움(탈퇴 정리 포함, 본문을 비움) / owner가 숨김. */
export const LOG_COMMENT_STATUSES = ['published', 'deleted', 'hidden'] as const
export type LogCommentStatus = (typeof LOG_COMMENT_STATUSES)[number]

/** 판정에 필요한 과제 정보. lifecycle이 archived면 읽기 전용입니다. */
export interface LogCommentProject extends ProjectRef {
  lifecycle: string
}

/** 판정에 필요한 댓글 정보. */
export interface LogCommentRef {
  authorId: string
  status: LogCommentStatus
}

/** 줄바꿈을 \n으로 맞추고 앞뒤 공백을 자릅니다. 비면 null. */
export function normalizeLogCommentBody(raw: string): string | null {
  const body = raw.replace(/\r\n?/g, '\n').trim()
  return body.length === 0 ? null : body
}

export function isProjectArchived(project: LogCommentProject): boolean {
  return project.lifecycle === 'archived'
}

/** 댓글 읽기: 과제의 active 멤버(역할 무관). */
export function canReadLogComments(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return canReadProjectWorkspace(viewer, project, membership)
}

/** 댓글 쓰기 역할: active owner/editor/reviewer. 보관 여부는 따로 봅니다(canWriteLogComment). */
export function hasLogCommentRole(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && membership!.role !== 'viewer'
}

/** 새 댓글: 쓰기 역할 + 보관되지 않은 과제. */
export function canWriteLogComment(viewer: Viewer, project: LogCommentProject, membership: Membership | null | undefined): boolean {
  return hasLogCommentRole(viewer, project, membership) && !isProjectArchived(project)
}

/** 수정: 작성자 본인 + 게시 상태 + 지금도 쓰기 역할 + 보관되지 않은 과제. */
export function canEditLogComment(
  viewer: Viewer,
  project: LogCommentProject,
  membership: Membership | null | undefined,
  comment: LogCommentRef,
): boolean {
  return comment.status === 'published' && viewer.userId !== null && comment.authorId === viewer.userId && canWriteLogComment(viewer, project, membership)
}

/** 삭제: 작성자 본인(지금 역할 무관, active 멤버) + 아직 지우지 않은 댓글. 숨긴 댓글도 지울 수 있습니다. */
export function canDeleteLogComment(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  comment: LogCommentRef,
): boolean {
  return comment.status !== 'deleted' && viewer.userId !== null && comment.authorId === viewer.userId && canReadProjectWorkspace(viewer, project, membership)
}

/** 숨김·숨김 해제: active owner. 지운 댓글은 대상이 아닙니다. */
export function canHideLogComment(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  comment: LogCommentRef,
): boolean {
  return comment.status !== 'deleted' && canReadProjectWorkspace(viewer, project, membership) && membership!.role === 'owner'
}

/**
 * 본문을 볼 수 있는지: 게시 댓글은 모두, 숨긴 댓글은 작성자 본인과 owner(숨김 해제 판단용), 지운 댓글은 아무도(본문이 비어 있음).
 */
export function canSeeLogCommentBody(viewer: Viewer, membership: Membership | null | undefined, comment: LogCommentRef): boolean {
  if (comment.status === 'published') return true
  if (comment.status === 'deleted') return false
  return (viewer.userId !== null && comment.authorId === viewer.userId) || membership?.role === 'owner'
}
