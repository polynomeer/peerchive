/**
 * /api/v1 응답 DTO 타입. 서버(server/modules)와 화면(app)이 함께 씁니다.
 * DB 행 타입을 그대로 쓰지 않고, 공개 범위가 다른 DTO를 따로 정의합니다.
 */

export type ProjectRole = 'owner' | 'editor' | 'reviewer' | 'viewer'
export type AssignableRole = Exclude<ProjectRole, 'owner'>
export type ContactPolicy = 'closed' | 'on_request' | 'open'

export interface ProfileFields {
  handle: string
  headline: string | null
  jobTargets: string[]
  schoolLabel: string | null
  gradTerm: string | null
  contactPolicy: ContactPolicy
  openToWork: boolean
}

/** 본인에게만 주는 DTO(이메일 포함). */
export interface MeDto {
  id: string
  email: string
  displayName: string
  createdAt: string
  profile: ProfileFields | null
}

/** 누구에게나 주는 공개 프로필 DTO. 이메일·내부 ID·계정 상태 없음. */
export interface PublicProfileDto {
  handle: string
  displayName: string
  headline: string | null
  jobTargets: string[]
  schoolLabel: string | null
  gradTerm: string | null
  contactPolicy: ContactPolicy
  openToWork: boolean
}

export interface ProjectDto {
  id: string
  title: string
  summaryByStudent: string | null
  goal: string | null
  constraints: string | null
  kind: 'individual' | 'team'
  lifecycle: 'planning' | 'active' | 'completed' | 'archived'
  courseTermId: string | null
  retroMode: boolean
  /** 과제 공간은 항상 비공개입니다. */
  visibility: 'private'
  version: number
  myRole: ProjectRole
  createdAt: string
  updatedAt: string
}

/** 같은 프로젝트 멤버에게만 주는 DTO. 이메일 없음. */
export interface MemberDto {
  userId: string
  displayName: string
  handle: string | null
  role: ProjectRole
  partLabel: string | null
  joinedAt: string
}

export type InvitationStatus = 'pending' | 'used' | 'expired' | 'revoked'

/** owner에게만 주는 DTO. 토큰·해시 없음. */
export interface InvitationDto {
  id: string
  role: ProjectRole
  status: InvitationStatus
  expiresAt: string
  createdAt: string
  usedAt: string | null
  revokedAt: string | null
}

/** API 오류 응답의 data 부분. */
export interface ApiErrorData {
  code: string
  fields?: Record<string, string>
}
