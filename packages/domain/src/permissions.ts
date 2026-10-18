/**
 * 접근 정책 (SYSTEM_DESIGN §8).
 *
 * API·repository·파일·검색·집계·PDF·AI 작업이 같은 정책 함수를 쓰도록
 * 순수 함수로 둡니다. DB 조회는 호출자가 하고, 여기서는 판정만 합니다.
 */

export const PROJECT_ROLES = ['owner', 'editor', 'reviewer', 'viewer'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'left', 'removed'] as const
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number]

/** 요청 주체. `userId === null`이면 로그인하지 않은 방문자입니다. */
export interface Viewer {
  userId: string | null
  /** 운영자 여부. 운영자라는 사실만으로 비공개 과제 공간을 읽을 수 없습니다. */
  isAdmin?: boolean
}

export interface ProjectRef {
  id: string
}

export interface Membership {
  projectId: string
  userId: string
  role: ProjectRole
  status: MembershipStatus
}

/**
 * 비공개 과제 공간 읽기 권한.
 *
 * - 방문자·비멤버: 불가
 * - 해당 프로젝트의 `active` 멤버(owner/editor/reviewer/viewer): 가능
 * - 관리자: 원칙적 불가. 분쟁 조사용 접근은 사유·기간·범위·감사 기록을 갖춘
 *   별도 예외 경로로만 허용하며 이 함수는 그 경로를 제공하지 않습니다.
 *
 * 멤버십이 다른 프로젝트·다른 사용자 것이면(호출자 실수) 거부합니다.
 * 호출자는 거부 시 404로 응답해 비공개 객체의 존재를 노출하지 않아야 합니다.
 */
export function canReadProjectWorkspace(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
): boolean {
  if (viewer.userId === null) return false
  if (!membership) return false
  if (membership.projectId !== project.id) return false
  if (membership.userId !== viewer.userId) return false
  return membership.status === 'active'
}
