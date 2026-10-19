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

// ── 빌드 로그 (T-04) ─────────────────────────────────────────────────────

export type LogTag = 'progress' | 'stuck' | 'solution' | 'decision' | 'meeting' | 'validation' | 'retro'
export type LogSource = 'web' | 'discord' | 'ai' | 'task' | 'retro'
export type TimeBucket = 'lt30m' | 'lt2h' | 'half_day' | 'day_plus'

/** 태그별 구조화 필드(SYSTEM_DESIGN §6.3). progress·retro는 빈 객체입니다. */
export interface StuckPayload {
  symptom: string
  keywords: string[]
  errorText?: string
  attempts: string[]
  timeBucket: TimeBucket
  /** "적은 내용이 과제 답 자체가 아님"을 작성자가 확인했는지. */
  answerCheck: boolean
}
export interface SolutionPayload {
  method: string
  timeBucket?: TimeBucket
  /** 해결 내용이 과제 답 자체가 아님을 확인(항상 true). */
  notAnswerConfirmed: true
}
export interface DecisionPayload {
  options: string[]
  criteria: string
  choice: string
  hindsight?: string
}
export interface ValidationPayload {
  target: string
  conditions: string
  result: string
  openQuestions?: string
}
export interface MeetingPayload {
  /** 참석자 user id(같은 프로젝트 멤버). */
  attendees: string[]
  decisions: string[]
  followUps: string[]
}
export type EmptyPayload = Record<string, never>

export interface LogPayloadByTag {
  progress: EmptyPayload
  stuck: StuckPayload
  solution: SolutionPayload
  decision: DecisionPayload
  meeting: MeetingPayload
  validation: ValidationPayload
  retro: EmptyPayload
}
export type LogPayload = LogPayloadByTag[LogTag]

/** 근거 링크. 서버는 이 URL을 가져오지 않습니다. */
export interface LogLinkDto {
  url: string
  title: string | null
}

/** 같은 프로젝트 멤버에게만 주는 작성자 정보. 이메일 없음. */
export interface LogAuthorDto {
  userId: string
  displayName: string
  handle: string | null
}

/** 다른 로그를 가리키는 짧은 참조(막힘↔해결 연결 표시용). */
export interface LogRefDto {
  id: string
  tag: LogTag
  /** 막힘은 증상, 그 밖에는 본문 앞부분(최대 80자). */
  summary: string
  author: LogAuthorDto
  createdAt: string
}

/** 로그 한 건(현재 revision). 같은 프로젝트 멤버에게만 줍니다. */
export interface LogDto {
  id: string
  projectId: string
  tag: LogTag
  source: LogSource
  author: LogAuthorDto
  /** 현재 revision 번호(1부터). 수정 요청의 expectedRevision으로 그대로 보냅니다. */
  revisionNo: number
  body: string
  payload: LogPayload
  links: LogLinkDto[]
  /** 학생이 기입한 수행일(YYYY-MM-DD, 자기 기입). */
  claimedDate: string | null
  /** 로그를 처음 만든 플랫폼 시각. */
  createdAt: string
  /** 현재 revision을 저장한 플랫폼 시각. */
  recordedAt: string
  /** solution이 해결한 막힘. */
  resolves: LogRefDto | null
  /** 이 막힘을 해결한 solution들(오래된 순). */
  resolvedBy: LogRefDto[]
  /** 요청자가 새 revision을 만들 수 있는지(작성자 본인 + owner/editor). */
  canRevise: boolean
}

export interface LogPageDto {
  items: LogDto[]
  /** 다음 페이지 cursor. 없으면 마지막 페이지. */
  nextCursor: string | null
}

/** revision 이력 한 건. 정정 내역은 지우지 않고 모두 보여 줍니다. */
export interface LogRevisionDto {
  revisionNo: number
  tag: LogTag
  body: string
  payload: LogPayload
  links: LogLinkDto[]
  claimedDate: string | null
  resolvesEntryId: string | null
  recordedAt: string
}

/** API 오류 응답의 data 부분. */
export interface ApiErrorData {
  code: string
  fields?: Record<string, string>
  /** 409 stale_revision일 때 서버의 현재 revision 번호. */
  currentRevision?: number
}
