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

// ── 과제 공간 운영 정책 (§8 "팀 멤버 관리", "로그 작성·수정") ─────────────
//
// 공통 원칙
// - 모든 판정은 "요청자가 해당 프로젝트의 active 멤버"인 것에서 출발합니다(canReadProjectWorkspace).
// - 관리자(isAdmin)라는 사실만으로는 어떤 권한도 생기지 않습니다. 운영 조치는 별도 경로로 둡니다.
// - owner는 운영 책임자 1명입니다. owner 역할은 초대·역할 변경으로 줄 수 없고 이전(transfer)으로만 넘깁니다.

/** 대상 멤버십이 같은 프로젝트의 active 멤버인지. */
function isActiveMemberOf(project: ProjectRef, membership: Membership | null | undefined): membership is Membership {
  return !!membership && membership.projectId === project.id && membership.status === 'active'
}

function hasActiveRole(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  roles: readonly ProjectRole[],
): membership is Membership {
  return canReadProjectWorkspace(viewer, project, membership) && roles.includes(membership!.role)
}

/** 과제 공간 기본 정보(제목·목표 등) 수정: active owner/editor. */
export function canEditProject(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return hasActiveRole(viewer, project, membership, ['owner', 'editor'])
}

/** 멤버 목록 관리(초대 목록 조회·초대 취소 포함): active owner만. */
export function canManageMembers(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
): boolean {
  return hasActiveRole(viewer, project, membership, ['owner'])
}

/** 초대 생성: owner가 owner 이외의 역할로만 초대할 수 있습니다. */
export function canInvite(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  role: ProjectRole,
): boolean {
  return role !== 'owner' && canManageMembers(viewer, project, membership)
}

/**
 * 다른 멤버의 역할 변경: owner가 active 멤버(본인·owner 제외)를 owner 이외의 역할로 바꿉니다.
 * owner 지정은 canTransferOwnership 경로로만 합니다.
 */
export function canChangeRole(
  viewer: Viewer,
  project: ProjectRef,
  actorMembership: Membership | null | undefined,
  target: Membership | null | undefined,
  newRole: ProjectRole,
): boolean {
  if (newRole === 'owner') return false
  if (!canManageMembers(viewer, project, actorMembership)) return false
  if (!isActiveMemberOf(project, target)) return false
  return target.userId !== viewer.userId && target.role !== 'owner'
}

/** 멤버 내보내기: owner가 본인이 아닌 active 비-owner 멤버를 내보냅니다. */
export function canRemoveMember(
  viewer: Viewer,
  project: ProjectRef,
  actorMembership: Membership | null | undefined,
  target: Membership | null | undefined,
): boolean {
  if (!canManageMembers(viewer, project, actorMembership)) return false
  if (!isActiveMemberOf(project, target)) return false
  return target.userId !== viewer.userId && target.role !== 'owner'
}

/** 스스로 나가기: active 멤버. owner는 먼저 소유권을 이전해야 합니다. */
export function canLeave(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return hasActiveRole(viewer, project, membership, ['editor', 'reviewer', 'viewer'])
}

/** 소유권 이전: owner가 본인이 아닌 같은 프로젝트의 active 멤버에게 넘깁니다. */
export function canTransferOwnership(
  viewer: Viewer,
  project: ProjectRef,
  actorMembership: Membership | null | undefined,
  target: Membership | null | undefined,
): boolean {
  if (!canManageMembers(viewer, project, actorMembership)) return false
  if (!isActiveMemberOf(project, target)) return false
  return target.userId !== viewer.userId
}

// ── 빌드 로그 정책 (§8 "로그 작성·수정") ────────────────────────────────
//
// - 작성: active owner/editor. reviewer는 피드백(별도 기능)만, viewer는 읽기만 합니다.
// - 수정(새 revision): 그 로그의 작성자 본인이 지금도 active owner/editor일 때만. owner라도 남의 로그는 고칠 수 없습니다.

/** 수정 판정에 필요한 로그 정보. */
export interface LogRef {
  projectId: string
  authorId: string
}

/** 빌드 로그 작성: active owner/editor. 관리자 우회 없음. */
export function canWriteLog(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return hasActiveRole(viewer, project, membership, ['owner', 'editor'])
}

/** 빌드 로그 수정: 작성자 본인이 같은 프로젝트의 active owner/editor일 때만. */
export function canReviseLog(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  log: LogRef,
): boolean {
  if (log.projectId !== project.id) return false
  if (viewer.userId === null || log.authorId !== viewer.userId) return false
  return canWriteLog(viewer, project, membership)
}
