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
  /** 공개 프로필에 학교 인증 배지를 보일지(C-01, 기본 끔). 본인에게만 보이는 설정값입니다. */
  showAffiliationBadge: boolean
}

/** 본인에게만 주는 DTO(이메일 포함). */
export interface MeDto {
  id: string
  email: string
  displayName: string
  createdAt: string
  profile: ProfileFields | null
  /** 운영자인지(T-15, 운영 화면 링크용). 본인에게만 보입니다. */
  operator: boolean
  /** 운영 조치로 공개 프로필이 숨겨졌는지(T-15). */
  profileHidden: boolean
  /** pilot 분석 수집을 거부했는지(T-16, 설정 화면). */
  analyticsOptOut: boolean
  /** 선택 실명(C-03). 실명 방식 커뮤니티 글에서만 보이며 공개 프로필·검색에는 나오지 않습니다. 본인에게만. */
  realName: string | null
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
  /** 이 프로필의 페르소나 종류(S-01). */
  kind: PersonaKind
  /** 연결을 켠 상대 페르소나(S-01). 연결이 꺼져 있으면 null이고, 다른 어느 필드에도 상대 페르소나 정보가 없습니다. */
  linkedPersona: PublicLinkedPersonaDto | null
}

// ── 페르소나·표시명 ↔ 실명 연결 (S-01, ADR 0028) ───────────────────────────

export type PersonaKind = 'real' | 'display'
export type PersonaAccountPrivacy = 'public' | 'private'

/** 공개 DTO에 싣는 상대 페르소나 링크. 연결(IdentityLink.visible)이 켜져 있을 때만 있습니다. id는 싣지 않습니다. */
export interface PublicLinkedPersonaDto {
  kind: PersonaKind
  handle: string
  displayName: string
}

/** 내 페르소나(본인에게만). 실명 페르소나의 이름은 계정 표시 이름이고, 프로필 필드는 페르소나마다 따로입니다. */
export interface MyPersonaDto {
  id: string
  kind: PersonaKind
  handle: string
  displayName: string
  accountPrivacy: PersonaAccountPrivacy
  showFollowerCount: boolean
  /** 받은 대기 팔로우 요청 수(S-04). 비공개 → 공개로 바꿀 때 화면이 이 수로 확인을 묻습니다(자동 승인 없음). */
  pendingFollowRequests: number
  /** 운영 조치로 이 페르소나의 공개 프로필이 숨겨졌는지. */
  profileHidden: boolean
  profile: ProfileFields | null
}

/** GET /me/personas — 내 페르소나와 연결 플래그(본인에게만). */
export interface MyPersonasDto {
  personas: MyPersonaDto[]
  /** 표시명 페르소나가 있을 때만. visible이면 두 공개 프로필에 서로의 링크가 보입니다. */
  identityLink: { visible: boolean; changedAt: string } | null
}

// ── 항목별 공개 범위·과제 수행 목록 (S-03, ADR 0031) ──────────────────────

export type VisibilityItemKind = 'project_list' | 'posts' | 'notes_and_studies' | 'follow_lists'
export type VisibilityAudience = 'public' | 'signed_in' | 'same_institution' | 'approved_followers' | 'private'

/** 항목 하나의 공개 범위(본인에게만). */
export interface VisibilitySettingDto {
  itemKind: VisibilityItemKind
  /** 저장한 값, 없으면 기본값. */
  audience: VisibilityAudience
  /** 저장한 행이 없어 기본값을 쓰는 중인지(기본값은 계정 공개 설정을 따라 바뀜). */
  isDefault: boolean
  /** 실제로 적용하는 값(비공개 계정은 approved_followers 이하로 좁힘). */
  effective: VisibilityAudience
  /** 이 항목·페르소나가 받는 값. follow_lists는 public·private, 표시명 페르소나의 project_list는 private만. */
  allowed: VisibilityAudience[]
}

/** GET·PUT /personas/:id/visibility — 페르소나의 항목별 공개 범위(본인에게만). 공개 사례·케이스 스터디는 항목이 아닙니다(공개 절차로만). */
export interface PersonaVisibilityDto {
  personaId: string
  kind: PersonaKind
  accountPrivacy: PersonaAccountPrivacy
  items: VisibilitySettingDto[]
}

/** 공개 프로필의 과제 수행 목록 한 줄. 과목·학기·제목뿐이고, 엠바고 중이면 제목이 null입니다. 다른 멤버·로그·파일·id 없음. */
export interface PublicProjectListingDto {
  courseTitle: string | null
  termLabel: string | null
  title: string | null
}

export type ProjectListingBlock = 'anonymous_study' | 'display_study'

/** 과제 수행 목록 고르기 화면의 과제 한 줄(본인에게만). */
export interface MyProjectListingDto {
  projectId: string
  /** 본인에게는 엠바고 중에도 보입니다(공개 프로필에서는 제목 없이). */
  title: string
  courseTitle: string | null
  termLabel: string | null
  embargoActive: boolean
  listed: boolean
  /** 올릴 수 없는 이유(익명·표시명 스터디 방의 기록). */
  block: ProjectListingBlock | null
}

/** GET /personas/:id/project-listings — 실명 페르소나의 과제 수행 목록 고르기(본인에게만). */
export interface MyProjectListingsDto {
  personaId: string
  /** 과제 수행 목록의 지금 적용 공개 범위. */
  audience: VisibilityAudience
  projects: MyProjectListingDto[]
}

/** 로그인 상태를 반영한 과제 수행 목록(`GET /profiles/:handle`이 함께 실음). 볼 수 없으면 null. */
export interface ProfileProjectsDto {
  projects: PublicProjectListingDto[] | null
}

/** GET /profiles/:handle — 공개 DTO + 보는 사람 기준 과제 수행 목록(S-03). */
export type PublicProfileWithProjectsDto = PublicProfileDto & ProfileProjectsDto

// ── 팔로우·비공개 계정·차단·뮤트 (S-04, ADR 0033) ─────────────────────────

export type FollowStatus = 'pending' | 'active'
export type BlockScope = 'origin_persona' | 'all_personas'

/**
 * 팔로워·팔로잉 수. 공개 응답에는 주인이 `show_follower_count`를 켰을 때만 이 키가 있고, 끄면 키 자체가 없습니다(null도 0도 아님).
 * 본인에게는 늘 있습니다.
 */
export interface FollowCountsDto {
  followers: number
  following: number
}

/**
 * 팔로우 목록 한 줄: 그 페르소나의 handle·이름·종류만. 같은 사용자의 다른 페르소나·연결·id는 싣지 않습니다(표시명으로 팔로우하면 표시명만 보임).
 */
export interface FollowPersonaDto {
  kind: PersonaKind
  handle: string
  displayName: string
}

/** 활동 카드의 원천 종류(S-05). 익명 글은 들어올 자리가 없습니다(PersonaActivity, ADR 0029). */
export type ActivitySourceDto = 'profile_post' | 'community_post' | 'senior_note' | 'publication_release' | 'study_release'
/** 공개 범위 묶음: 공개 사례 / 선배 노트·스터디 기록 / 글. */
export type ActivityKindDto = 'cases' | 'notes_and_studies' | 'posts'

/**
 * 활동 카드 한 줄(S-05, ADR 0035). 내용은 읽을 때 원본을 다시 확인한 것만: 프로필 글 본문, 커뮤니티 글 제목·공간 이름(그 공간을 읽을 수 있을 때만),
 * 선배 노트의 과목·학기(원 글 연결 없음), 공개 사례 제목·요약·학기. 작성자 계정 id·원 글 id·이메일은 없습니다.
 */
export interface ActivityItemDto {
  /** 활동 행 id(불투명). */
  id: string
  source: ActivitySourceDto
  kind: ActivityKindDto
  createdAt: string
  title: string | null
  body: string | null
  /** 사이트 안 경로(/p/…, /c/…, /community/p/…). 프로필 글은 null. */
  href: string | null
  /** 공간 이름·학기 등 짧은 보조 글. */
  context: string | null
  author: FollowPersonaDto
  /** 본인 프로필 글일 때만: 지우기에 쓰는 글 id. */
  profilePostId?: string
}

/** GET /profiles/:handle/activity?kind=&cursor= — 보는 사람이 볼 수 있는 종류(`kinds`)와 그 활동(최근 순). 차단당했으면 404. */
export interface ProfileActivityDto {
  kinds: ActivityKindDto[]
  items: ActivityItemDto[]
  nextCursor: string | null
}

/** GET /feed?cursor= — 내가(어느 프로필로든) 팔로우하는 프로필의 활동. 하루 단위로 기록(사례·노트·스터디)이 글보다 먼저(ADR 0035). */
export interface FeedDto {
  items: ActivityItemDto[]
  nextCursor: string | null
  /** 팔로우 중인 프로필 수(내 쪽 숫자, 0이면 화면이 추천을 먼저 보여 줌). */
  following: number
}

/** GET /feed/suggestions — 같은 과목·같은 학교·관심 직무 교집합으로만 고른 추천(팔로워 수·활동량 정렬 없음). */
export interface FollowSuggestionDto extends FollowPersonaDto {
  accountPrivacy: 'public' | 'private'
  reasons: Array<'course' | 'institution' | 'job_target'>
}

export interface FollowSuggestionsDto {
  suggestions: FollowSuggestionDto[]
}

/** POST /personas/:id/posts {body} — 만든 프로필 글. */
export interface ProfilePostDto {
  id: string
  personaId: string
  body: string
  createdAt: string
}

/** GET /profiles/:handle/followers·following — 볼 수 없으면(`follow_lists` 공개 범위) `entries: null`. 차단당했으면 404. */
export interface FollowListDto {
  entries: FollowPersonaDto[] | null
}

/** 보는 사람의 내 페르소나 하나와 이 프로필의 관계(팔로우 주체 고르기용, 본인에게만). */
export interface ViewerPersonaRelationDto {
  personaId: string
  kind: PersonaKind
  handle: string
  displayName: string
  /** 이 페르소나로 대상을 팔로우한 상태(none = 팔로우 안 함). */
  follow: FollowStatus | 'none'
  /** 이 페르소나에서 대상 페르소나를 차단한 행(없으면 null). */
  block: { id: string; scope: BlockScope } | null
}

/**
 * GET /profiles/:handle/social — 세션을 읽는 프로필 관계 정보(no-store). 화면이 SSR 뒤 브라우저에서만 부릅니다.
 * 차단당한 사용자에게는 404입니다(화면은 프로필을 "찾을 수 없음"으로 바꿈). `followCounts`는 공개 DTO와 같은 규칙(끄면 키 없음, 본인은 늘).
 */
export interface ProfileSocialDto {
  accountPrivacy: PersonaAccountPrivacy
  followCounts?: FollowCountsDto
  /** 팔로워·팔로잉 목록을 이 사람이 볼 수 있는지(`follow_lists` 공개 범위). */
  followListsVisible: boolean
  isOwner: boolean
  /** 로그인한 다른 사람에게만. 내 페르소나별 팔로우·차단 상태와 뮤트. */
  viewer: { personas: ViewerPersonaRelationDto[]; muteId: string | null } | null
}

/** POST /profiles/:handle/follow — 팔로우 결과(공개 계정 active, 비공개 계정 pending). */
export interface FollowResultDto {
  status: FollowStatus | 'none'
}

/** 내 페르소나의 팔로워·팔로잉·요청 한 줄(본인에게만). id는 팔로우 행 id(승인·거절·팔로워 삭제에 씀). */
export interface MyFollowEntryDto extends FollowPersonaDto {
  id: string
  /** 요청 시각(pending) 또는 승인 시각(active). */
  at: string
}

/** GET /personas/:id/follows — 내 페르소나의 팔로우 관리(본인에게만, 남의 것 404). */
export interface MyFollowsDto {
  personaId: string
  kind: PersonaKind
  handle: string
  accountPrivacy: PersonaAccountPrivacy
  showFollowerCount: boolean
  followers: MyFollowEntryDto[]
  following: MyFollowEntryDto[]
  /** 받은 대기 요청. 공개 계정이 된 뒤에도 자동 승인하지 않고 남습니다(모두 승인·모두 거절·그대로 두기). */
  incoming: MyFollowEntryDto[]
  /** 보낸 대기 요청. */
  outgoing: MyFollowEntryDto[]
}

/** 내 차단 한 줄(본인에게만). 차단을 건 상대의 그 페르소나만 보이고, 상대의 다른 페르소나는 드러내지 않습니다. */
export interface MyBlockDto {
  id: string
  target: FollowPersonaDto
  /** 차단을 건 내 페르소나. */
  origin: { kind: PersonaKind; handle: string }
  scope: BlockScope
  createdAt: string
}

export interface MyBlocksDto {
  blocks: MyBlockDto[]
}

export interface MyMuteDto {
  id: string
  target: FollowPersonaDto
  createdAt: string
}

export interface MyMutesDto {
  mutes: MyMuteDto[]
}

/**
 * 사후 작성 표시(PROOFU_EVOLUTION_PLAN §6.7, DELIVERY_PLAN 시나리오 G). 프로젝트·로그·마일스톤·스냅샷 DTO는 모두 이 필드를 가집니다.
 * 공개 DTO(T-11/T-12)는 이 DTO들에서 만들어지므로 이 표시를 빼지 말고 그대로 옮겨야 합니다.
 * 화면은 색이 아니라 `사후 작성` 글자로 보여 줍니다.
 */
export interface RetrospectiveMarked {
  /** 프로젝트는 지금의 retro_mode, 그 밖의 항목은 만들 때(지정할 때) 사후 작성 모드였는지. */
  retrospective: boolean
}

/** 과제 종류. study는 스터디 방의 기록(C-08, ADR 0026). */
export type ProjectKind = 'individual' | 'team' | 'study'

export interface ProjectDto extends RetrospectiveMarked {
  id: string
  title: string
  summaryByStudent: string | null
  goal: string | null
  constraints: string | null
  /** study: 스터디 방의 기록(C-08). 멤버는 스터디 방에서 파생되고 과제 쪽 초대·역할·나가기는 409 `study_managed`. */
  kind: ProjectKind
  lifecycle: 'planning' | 'active' | 'completed' | 'archived'
  courseTermId: string | null
  retroMode: boolean
  /** 스터디 기록이면 연결된 방의 지금 이름 표시 방식(anonymous면 다른 멤버 이름을 "스터디 멤버 N"으로 가림), 아니면 null. */
  studyNameMode: 'real' | 'display' | 'anonymous' | null
  /** 과제 공간은 항상 비공개입니다. */
  visibility: 'private'
  version: number
  myRole: ProjectRole
  createdAt: string
  updatedAt: string
}

// ── 학교·과목·개설 학기·개념 태그·엠바고 (T-10) ──
// 모든 이름은 학생이 입력한 값입니다(화면에 "학생 작성" 표시). 교수 실명·평가 필드는 없습니다(PROOFU_EVOLUTION_PLAN §8.6).

export type Semester = 'spring' | 'summer' | 'fall' | 'winter'

export interface SchoolDto {
  id: string
  name: string
}

export interface CourseDto {
  id: string
  schoolId: string
  title: string
  code: string | null
}

export interface CourseTermDto {
  id: string
  courseId: string
  year: number
  semester: Semester
  /** 학기 종료 시각(서버 계산, 엠바고 기준). */
  endsAt: string
}

export interface ConceptTagDto {
  id: string
  slug: string
  label: string
}

/** POST /courses/:id/terms 응답. 이미 있던 학기면 created=false(200). */
export interface CourseTermResultDto {
  term: CourseTermDto
  created: boolean
}

/** 409 similar_exists / already_exists의 후보(오류 응답에 싣는 짧은 레코드라 type alias로 둡니다). */
export type CatalogCandidateDto = {
  id: string
  name: string
  code?: string | null
}

/** 프로젝트에 연결된 과목 정보(읽기 전용 패널). */
export interface CourseContextDto {
  school: SchoolDto
  course: CourseDto
  term: CourseTermDto
  tags: ConceptTagDto[]
}

/** 등록할 수 있는 학기(E-01: 지금 학기와 다음 학기). */
export interface RegistrableTermDto {
  year: number
  semester: Semester
  /** "2026년 2학기" */
  label: string
  current: boolean
}

/**
 * 이번 학기 과목 등록(E-01, ADR 0046). **본인에게만** 돌려줍니다(공개·소셜·운영자 응답에 없음).
 * phase: upcoming(다음 학기)·current(지금 학기)·ended(개설 학기 종료 시각이 지남).
 */
export interface CourseRegistrationDto {
  id: string
  school: SchoolDto
  course: CourseDto
  term: CourseTermDto
  termLabel: string
  phase: 'upcoming' | 'current' | 'ended'
  /** 학기가 끝난 뒤 worker가 만든 화면 안 알림(선배 노트·공개 제안)이 아직 닫히지 않았는지. */
  postTermPrompt: boolean
  /** 이 학기에 연결된 내 과제(active 멤버, 스터디 기록 제외). 공개 제안 링크에 씁니다. */
  myProjects: Array<{ id: string; title: string }>
  createdAt: string
}

export interface MyCourseRegistrationsDto {
  items: CourseRegistrationDto[]
  registrableTerms: RegistrableTermDto[]
}

export type EmbargoSource ='course_term_end' | 'course_term_embargo' | 'project_embargo'

/** 적용 중인 엠바고. active여도 끝나면 자동 공개하지 않습니다(§9.2). */
export interface EmbargoDto {
  until: string | null
  active: boolean
  source: EmbargoSource | null
}

/** GET/PATCH /projects/:id 응답: 프로젝트 + 엠바고 + 과목 정보. */
export interface ProjectDetailDto extends ProjectDto {
  embargo: EmbargoDto
  courseContext: CourseContextDto | null
}

/** 같은 프로젝트 멤버에게만 주는 DTO. 이메일 없음. */
export interface MemberDto {
  /** 사용자 id. 익명 스터디 기록에서 다른 멤버는 과제별 가명 키(`sm_…`, ADR 0026 부록). 이하 과제 DTO의 사람 참조 모두 같음. */
  userId: string
  displayName: string
  handle: string | null
  role: ProjectRole
  partLabel: string | null
  /** 익명 스터디 기록에서 다른 멤버는 null(방 멤버 목록과 맞춰 보지 못하게, ADR 0026 부록). */
  joinedAt: string | null
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
export interface LogDto extends RetrospectiveMarked {
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
  /** 이 revision에 붙인 파일 근거(첨부 순서). */
  evidence: EvidenceDto[]
  /** 이 revision이 속한 마일스톤(T-06). */
  milestone: MilestoneRefDto | null
  /** 이 로그로 전환된 할 일(source가 task일 때, T-07). */
  task: TaskRefDto | null
  /** 요청자가 새 revision을 만들 수 있는지(작성자 본인 + owner/editor). */
  canRevise: boolean
  /** 게시 상태 피드백 댓글 수(E-10, 팀 안에서만). 공개 스냅샷에는 없습니다. */
  commentCount: number
}

export interface LogPageDto {
  items: LogDto[]
  /** 다음 페이지 cursor. 없으면 마지막 페이지. */
  nextCursor: string | null
}

/** 로그 피드백 댓글 상태(E-10, ADR 0054). */
export type LogCommentStatus = 'published' | 'deleted' | 'hidden'

/**
 * 로그 피드백 댓글 한 건(E-10, ADR 0054). 팀 안에서만 읽고 공개 응답에는 없습니다.
 * 지운 댓글은 본문·작성자 없이 자리만, 숨긴 댓글은 작성자 본인과 owner에게만 본문·작성자를 싣습니다.
 */
export interface LogCommentDto {
  id: string
  logId: string
  status: LogCommentStatus
  author: LogAuthorDto | null
  body: string | null
  /** 쓸 때 로그의 현재 revision 번호(맥락 표시). */
  revisionNo: number
  createdAt: string
  editedAt: string | null
  mine: boolean
  canEdit: boolean
  canDelete: boolean
  canHide: boolean
}

export interface LogCommentListDto {
  items: LogCommentDto[]
  /** 요청자가 새 댓글을 쓸 수 있는지(owner/editor/reviewer, 보관되지 않은 과제). */
  canComment: boolean
  /** 보관된 과제(읽기 전용)인지. */
  archived: boolean
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
  /** 이 revision의 파일 근거(artifact version id, 첨부 순서). */
  evidenceVersionIds: string[]
  /** 이 revision이 속한 마일스톤 id(T-06). */
  milestoneId: string | null
  recordedAt: string
}

// ── 산출물·파일 (T-05) ──────────────────────────────────────────────────

export type ScanStatus = 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed'
export type ArtifactKind = 'file' | 'link' | 'repo' | 'demo'

/** 산출물 버전(파일 하나). 같은 프로젝트 멤버에게만 줍니다. 저장 위치(object key)는 싣지 않습니다. */
export interface ArtifactVersionDto {
  id: string
  artifactId: string
  versionNo: number
  /** 올릴 때의 파일 이름(표시용). */
  fileName: string
  declaredType: string
  /** 서버가 내용으로 판별한 형식. 판별 전이거나 허용 형식이 아니면 null. */
  mediaType: string | null
  bytes: number
  scanStatus: ScanStatus
  /** 격리·실패 사유 코드(예: type_mismatch, malware). */
  scanReason: string | null
  scannedAt: string | null
  createdAt: string
  uploader: LogAuthorDto
  /** clean일 때만 내용 주소. 그 밖에는 null(내용을 내려주지 않음). */
  contentUrl: string | null
  /** 이미지 메타데이터(EXIF/GPS/XMP/주석)를 지운 내용을 내려주는지. PDF·검사 전·backfill 전 이미지는 false. */
  metadataStripped: boolean
  /** PDF 문서 속성(Author·dc:creator)에 작성자 정보가 있는지. 값은 싣지 않습니다. */
  pdfAuthorMetadata: boolean
}

export interface ArtifactDto {
  id: string
  projectId: string
  kind: ArtifactKind
  title: string
  createdAt: string
  updatedAt: string
  latestVersion: ArtifactVersionDto | null
  /** 모든 버전(최신순). */
  versions: ArtifactVersionDto[]
  /** 요청자가 새 버전을 올릴 수 있는지(owner/editor). */
  canUpload: boolean
}

/** 업로드 의도. uploadUrl로 내용을 PUT한 뒤 completeUrl로 완료합니다. */
export interface UploadIntentDto {
  intentId: string
  /** 지금은 이 서버의 PUT 주소. S3 호환 저장소를 쓰면 짧은 서명 URL로 바뀝니다. */
  uploadUrl: string
  completeUrl: string
  /** 정확히 이 크기의 본문만 받습니다. */
  byteSize: number
  expiresAt: string
  uploaded: boolean
  completed: boolean
}

/** 업로드 완료 응답. */
export interface UploadCompleteDto {
  artifact: ArtifactDto
  version: ArtifactVersionDto
}

/** 로그에 붙인 파일 근거 한 건. */
export interface EvidenceDto {
  versionId: string
  artifactId: string
  /** 산출물 이름. */
  title: string
  fileName: string
  versionNo: number
  mediaType: string | null
  scanStatus: ScanStatus
  /** clean일 때만. */
  contentUrl: string | null
}

// ── 마일스톤·스냅샷 (T-06) ───────────────────────────────────────────────

/** 로그 등에서 마일스톤을 가리키는 짧은 참조. position은 응답 시점의 순서입니다. */
export interface MilestoneRefDto {
  id: string
  position: number
  title: string
}

/** 마일스톤 스냅샷 한 건(진화 보기 단위). 같은 프로젝트 멤버에게만 줍니다. */
export interface MilestoneSnapshotDto extends RetrospectiveMarked {
  artifactVersionId: string
  artifactId: string
  /** 산출물 이름. */
  title: string
  fileName: string
  versionNo: number
  mediaType: string | null
  /** 지정할 때 clean이었고 clean은 최종 상태라 항상 clean입니다(형식상 상태를 함께 줌). */
  scanStatus: ScanStatus
  /** clean일 때만 내용 주소. */
  contentUrl: string | null
  note: string | null
  position: number
  createdAt: string
}

/** 마일스톤 한 건. 같은 프로젝트 멤버에게만 줍니다. */
export interface MilestoneDto extends RetrospectiveMarked {
  id: string
  projectId: string
  /** 1부터 빈틈없는 순서. */
  position: number
  title: string
  note: string | null
  /** 예정일(YYYY-MM-DD). */
  dueAt: string | null
  /** 도달일(YYYY-MM-DD, 자기 기입). */
  claimedAt: string | null
  /** 수정 요청의 expectedVersion으로 그대로 보냅니다. */
  version: number
  createdAt: string
  updatedAt: string
  /** 현재 revision이 이 마일스톤에 속한 로그 수. */
  logCount: number
  /** 스냅샷(지정 순서). */
  snapshots: MilestoneSnapshotDto[]
}

// ── 할 일 (T-07) ─────────────────────────────────────────────────────────

export type TaskStatus = 'todo' | 'doing' | 'done'

/** 로그에서 출처 할 일을 가리키는 짧은 참조. */
export interface TaskRefDto {
  id: string
  title: string
}

/** 할 일 한 건. 같은 프로젝트 멤버에게만 줍니다. */
export interface TaskDto {
  id: string
  projectId: string
  title: string
  note: string | null
  status: TaskStatus
  /** 같은 상태 목록 안에서 1부터 빈틈없는 순서. */
  position: number
  /** 담당자. 나간 멤버여도 지정은 남습니다. */
  assignee: LogAuthorDto | null
  /** 마감일(YYYY-MM-DD). */
  dueAt: string | null
  completedAt: string | null
  completedBy: string | null
  /** 이 할 일에서 전환한 빌드 로그(한 번만). */
  log: { id: string; tag: LogTag } | null
  createdBy: string
  /** 수정 요청의 expectedVersion으로 그대로 보냅니다. */
  version: number
  createdAt: string
  updatedAt: string
}

/** POST /tasks/:id/complete 응답. prompt가 있으면 화면이 "막힌 적 있었나요? 결정할 게 있었나요?"를 한 번 묻습니다. */
export interface TaskCompleteDto {
  task: TaskDto
  /** 아직 로그로 전환하지 않은 할 일이면 묻고, 이미 전환했으면 null. 응답하지 않아도 완료는 끝났습니다. */
  prompt: { askStuck: true; askDecision: true } | null
}

/** POST /tasks/:id/convert 응답. */
export interface TaskConvertDto {
  task: TaskDto
  log: LogDto
}

// ── 역할 선언·팀원 확인·기여 장부 (T-08) ──────────────────────────────────

/** 선언 상태(§7.3). 화면 문구: 본인 설명 · 미확인 / 팀원 확인 N명 / 이의 있음. */
export type ClaimStatus = 'unconfirmed' | 'confirmed' | 'disputed'
export type EndorsementStatus = 'confirmed' | 'disputed'

/** 선언 근거 한 건: 고정한 로그 revision 또는 산출물 버전. */
export type ClaimEvidenceDto =
  | {
      kind: 'log'
      logId: string
      tag: LogTag
      /** 고정한 revision의 한 줄 요약(막힘은 증상). */
      summary: string
      /** 선언할 때 고정한 로그 revision 번호. */
      revisionNo: number
      /** 그 로그의 지금 revision 번호(고정 뒤 고쳐졌으면 revisionNo보다 큼). */
      currentRevisionNo: number
      author: LogAuthorDto
    }
  | {
      kind: 'artifact'
      versionId: string
      artifactId: string
      /** 산출물 이름. */
      title: string
      fileName: string
      versionNo: number
      scanStatus: ScanStatus
      /** clean일 때만. */
      contentUrl: string | null
    }
  | {
      /**
       * GitHub 커밋·PR(E-11, ADR 0056). 고를 때 복사한 주소·제목이며 팀 안에서만 보입니다(공개 스냅샷에 넣지 않음).
       * 저장소 연결을 끊어 후보가 지워졌으면 `itemId`·`itemKind`·`ref`가 null인 "링크만 남은 근거"입니다.
       */
      kind: 'github'
      itemId: string | null
      itemKind: GithubItemKind | null
      /** 커밋은 SHA 앞 7자리, PR은 `#번호`. */
      ref: string | null
      url: string
      title: string
    }

/** 확인·이의 한 건. 같은 프로젝트 멤버에게만 줍니다. 이메일 없음. */
export interface EndorsementDto {
  endorser: LogAuthorDto
  status: EndorsementStatus
  note: string | null
  createdAt: string
  updatedAt: string
}

/** 역할 선언 한 건(현재 revision). */
export interface ClaimDto {
  id: string
  projectId: string
  author: LogAuthorDto
  /** 선언한 사람이 지금도 active 멤버인지(나간 멤버의 선언도 남습니다). */
  authorActive: boolean
  /** 현재 revision id. 확인 요청(PUT /claim-revisions/:id/endorsement)의 대상입니다. */
  revisionId: string
  /** 현재 revision 번호. 수정 요청의 expectedRevision으로 그대로 보냅니다. */
  revisionNo: number
  revisionCount: number
  text: string
  createdAt: string
  /** 현재 revision을 저장한 시각. */
  recordedAt: string
  evidence: ClaimEvidenceDto[]
  /** 현재 revision에 남은 확인·이의(이전 revision의 확인은 이력에만 있음). */
  endorsements: EndorsementDto[]
  status: ClaimStatus
  confirmedCount: number
  disputedCount: number
  /** 요청자가 새 revision을 만들 수 있는지(작성자 본인만). */
  canRevise: boolean
  /** 요청자가 확인·이의를 남길 수 있는지(작성자가 아닌 owner/editor/reviewer). */
  canEndorse: boolean
  /** 요청자가 현재 revision에 남긴 확인·이의. */
  myEndorsement: EndorsementStatus | null
}

/** 선언 revision 이력 한 건. 확인은 그 revision에 붙은 것만 보여 줍니다. */
export interface ClaimRevisionDto {
  id: string
  revisionNo: number
  text: string
  recordedAt: string
  evidence: ClaimEvidenceDto[]
  endorsements: EndorsementDto[]
  /** 이 revision만 놓고 본 상태. */
  status: ClaimStatus
  current: boolean
}

export const CONTRIBUTION_DISCLAIMER = '※ 개수는 참고용이며 기여의 크기를 뜻하지 않습니다.'

/** 장부의 멤버 한 명. 점수·비율·순위 없이 종류별 개수와 선언만 담습니다. */
export interface LedgerMemberDto {
  member: LogAuthorDto
  /** active 멤버인지. 나간·내보낸 멤버는 그 기간 기록이 있을 때만 나옵니다. */
  active: boolean
  /** 기간 중 작성한 로그 수(태그별, 처음 기록한 시각 기준). */
  logCounts: Record<LogTag, number>
  /** 기간 중 쓴 막힘 가운데 기간이 끝나기 전 해결 로그가 연결된 수. */
  stuckResolved: number
  tasksCompleted: number
  /** 기간 중 올린 검사 통과(clean) 파일 버전 수. */
  artifactsUploaded: number
  /** 기간 중 회의 로그에 참석자로 적힌 횟수. */
  meetingsAttended: number
  /** 이 멤버의 역할 선언(기간과 무관한 현재 상태). */
  claims: ClaimDto[]
}

export interface UnresolvedStuckDto {
  id: string
  summary: string
  author: LogAuthorDto
  createdAt: string
  /** 만든 날을 1일째로 센 날수(기간 끝 또는 지금 중 이른 쪽 기준, 서울 날짜). */
  openDays: number
}

export interface ContributionDto {
  project: { id: string; title: string }
  /** 서울 날짜(양 끝 포함). */
  period: { from: string; to: string; timeZone: 'Asia/Seoul'; weekNo: number | null }
  generatedAt: string
  /** 이름순. 활동량으로 정렬하지 않습니다. */
  members: LedgerMemberDto[]
  /** 기간 끝까지 만든 막힘 가운데 아직 해결 로그가 없는 것(오래된 순, 최대 20개). */
  unresolvedStuck: UnresolvedStuckDto[]
  /** 기간과 겹치거나 가장 가까운 다음 마일스톤과 그 기간에 등록한 스냅샷 수. */
  milestone: { title: string; dueAt: string | null; snapshotsInPeriod: number } | null
  disclaimer: typeof CONTRIBUTION_DISCLAIMER
}

// ── 디스코드 연동·주간 체크인 (T-09, ADR 0009) ───────────────────────────

/** 본인 연동 상태. 디스코드 사용자 id는 끝 4자리만 보여 줍니다. */
export interface IntegrationsDto {
  discord: { linked: boolean; linkedAt: string | null; externalIdHint: string | null }
}

// ── GitHub App 연동 (E-11, ADR 0056) ──────────────────────────────────────

export type GithubItemKind = 'commit' | 'pull_request'
export type GithubPrState = 'open' | 'closed' | 'merged'

/** 본인 GitHub 계정 연결 상태(GitHub App 설정이 없으면 경로가 404). 저장하는 것은 GitHub 사용자 번호·로그인 이름뿐입니다. */
export interface GithubIdentityDto {
  linked: boolean
  login: string | null
  linkedAt: string | null
}

/** GitHub로 보낼 주소(state 포함, 10분·한 번만). 화면은 이 주소로 이동합니다. */
export interface GithubRedirectDto {
  url: string
}

export interface GithubRepoChoiceDto {
  id: number
  fullName: string
  private: boolean
}

/** 과제의 GitHub 저장소 연결(멤버만). */
export interface ProjectGithubDto {
  link: { fullName: string; htmlUrl: string; private: boolean; linkedAt: string } | null
  /** owner에게만: 설치·사용자 확인을 마치고 고르기를 기다리는 저장소(30분 안에 하나 고름). */
  pendingChoices: GithubRepoChoiceDto[] | null
  /** 연결·해제는 owner만. */
  canManage: boolean
  /** 내 GitHub 계정이 연결되어 있는지(내 커밋·PR이 근거 후보가 되려면 필요). */
  identityLinked: boolean
}

/** 근거 후보 하나(최소 필드: 내용·diff 없음). */
export interface GithubItemDto {
  id: string
  kind: GithubItemKind
  /** 커밋은 SHA 앞 7자리, PR은 `#번호`. */
  ref: string
  /** 커밋 메시지 첫 줄·PR 제목(200자에서 자름). */
  title: string
  url: string
  occurredAt: string
  prState: GithubPrState | null
}

/**
 * GET /projects/:id/github/items — 멤버별 근거 후보(최근 30개씩). 자동으로 확정·집계되지 않고, 본인이 역할 선언 근거로 고르거나
 * 로그 링크로 붙일 때만 쓰입니다. GitHub 계정을 연결하지 않은 멤버는 `identityLinked: false`·빈 목록입니다.
 */
export interface GithubCandidatesDto {
  linked: boolean
  members: Array<{ member: LogAuthorDto; identityLinked: boolean; items: GithubItemDto[] }>
}

/** 일회용 코드(10분, 한 번만). 원문은 이 응답에서 한 번만 받습니다. */
export interface DiscordCodeDto {
  code: string
  expiresAt: string
}

/** 채널 연결. 멤버에게만 줍니다(디스코드 id만, 채널 이름은 선택 label). */
export interface DiscordBindingDto {
  id: string
  guildId: string
  channelId: string
  label: string | null
  summaryEnabled: boolean
  createdAt: string
}

export type CheckinTimeBucket = 'none' | 'lt2h' | 'lt5h' | 'lt10h' | 'ten_plus'
export type CheckinSkipReason = 'busy' | 'bothersome' | 'nothing_to_log' | 'unsure_where' | 'other'

/** 본인 체크인. 통계 공유·기록 못 한 이유는 본인에게만 보입니다. */
export interface CheckinDto {
  id: string
  projectId: string
  week: string
  timeBucket: CheckinTimeBucket
  difficulty: number
  note: string | null
  shareForStats: boolean
  skipReasons: CheckinSkipReason[]
  promotedLogId: string | null
  createdAt: string
  updatedAt: string
}

/** GET /projects/:id/checkins/me */
export interface MyCheckinDto {
  week: string
  from: string
  to: string
  checkin: CheckinDto | null
}

/** 팀원 체크인 한 줄(같은 프로젝트 active 멤버에게만). 통계 공유·이유는 싣지 않습니다. */
export interface TeamCheckinEntryDto {
  member: LogAuthorDto
  submitted: boolean
  timeBucket: CheckinTimeBucket | null
  difficulty: number | null
  note: string | null
  promotedLogId: string | null
  updatedAt: string | null
}

/** GET /projects/:id/checkins?week= */
export interface CheckinWeekDto {
  week: string
  from: string
  to: string
  /** 이름순. */
  entries: TeamCheckinEntryDto[]
}

/** PUT /projects/:id/checkins/me 응답. promote를 요청했으면 만든(또는 이미 있던) 로그. */
export interface CheckinSaveDto {
  checkin: CheckinDto
  log: LogDto | null
}

/** AI 회고 인터뷰(E-12, ADR 0057)의 로그 초안 하나(승인 전, 본인만). payload는 빌드 로그 태그별 구조화 필드와 같은 모양입니다. */
export interface AiRetroDraftDto {
  id: string
  tag: 'progress' | 'stuck' | 'decision' | 'validation' | 'retro'
  body: string
  payload: LogPayload
}

/** 진행 중인 인터뷰(본인만). 질문·답변은 초안을 만들면 서버에서 지웁니다. */
export interface AiRetroSessionDto {
  id: string
  status: 'active' | 'drafted'
  /** 지금까지 한 질문 수. 답을 보낼 때 `questionNo`로 그대로 돌려줍니다(동시 요청 확인). */
  questionCount: number
  /** 질문과 답(마지막 질문은 답이 null). 초안을 만든 뒤에는 빈 배열입니다. */
  turns: Array<{ q: string; a: string | null }>
  expiresAt: string
}

/** GET /projects/:id/ai-retro — AI 회고 인터뷰 상태(본인). */
export interface AiRetroStateDto {
  /** 이 과제에서 AI 회고 인터뷰를 켰는지(기본 꺼짐). */
  optedIn: boolean
  /** 쓸 수 있는 역할인지(owner/editor — 승인한 초안이 빌드 로그가 되므로). */
  canUse: boolean
  session: AiRetroSessionDto | null
  drafts: AiRetroDraftDto[]
  /** 방금 인터뷰를 정리했지만 남길 만한 초안이 없었을 때 true(세션은 지움). */
  noDrafts?: boolean
}

/** POST /projects/:id/ai-retro/drafts/:draftId/approve — 승인으로 만든 로그와 남은 상태. */
export interface AiRetroApproveDto {
  log: LogDto
  state: AiRetroStateDto
}

/** AI 회의 요약(E-13, ADR 0058): 회의 채널 하나의 동의 현황. */
export interface AiMeetingChannelDto {
  /** 디스코드 채널 연결 id(discord_channel_bindings). */
  bindingId: string
  label: string | null
  channelId: string
  /** 회의 채널로 제안됐으면 그 정보, 아니면 null. */
  meeting: {
    id: string
    proposedAt: string
    proposedBy: { userId: string; displayName: string }
    /** 지금 active 멤버 전원과 각자의 동의 여부. */
    members: Array<{ userId: string; displayName: string; agreed: boolean }>
    /** 전원 동의(요약 가능). 새 멤버가 들어오면 그 사람이 동의할 때까지 false. */
    allAgreed: boolean
    myConsent: boolean
  } | null
}

export interface AiMeetingFollowUpDto {
  text: string
  ownerId: string | null
  ownerName: string | null
  due: string | null
}

/** 승인 전 🗣️ 회의 로그 초안. 디스코드 메시지 원문은 없습니다(요약·결정·후속 할 일·개수만). */
export interface AiMeetingDraftDto {
  id: string
  channelLabel: string | null
  requestedBy: { userId: string; displayName: string }
  createdAt: string
  expiresAt: string
  windowStart: string
  windowEnd: string
  messageCount: number
  summary: string
  decisions: string[]
  followUps: AiMeetingFollowUpDto[]
  openQuestions: string[]
  attendees: Array<{ userId: string; displayName: string }>
  /** 보내지 않고 뺀 팀 밖 참여자 메시지 수. */
  excludedMessages: number
  attachmentsOmitted: number
  /** 승인 화면에 채울 회의 로그 기본값(본문·참석자·결정·후속 할 일 줄). */
  logInput: { body: string; payload: { attendees: string[]; decisions: string[]; followUps: string[] } }
  /** 내가 승인할 수 있는지(owner/editor, 요청자 본인은 다른 owner/editor가 없을 때만). */
  canApprove: boolean
  /** 내가 거절할 수 있는지(owner/editor). */
  canReject: boolean
}

export interface AiMeetingStateDto {
  channels: AiMeetingChannelDto[]
  drafts: AiMeetingDraftDto[]
  /** 회의 채널을 제안·거둘 수 있는지(owner, 스터디 기록 제외). */
  canPropose: boolean
}

export interface AiMeetingApproveDto {
  log: LogDto
  tasks: TaskDto[]
  state: AiMeetingStateDto
}

/** GET /me/checkins — 대시보드 "이번 주 체크인". */
export interface MyCheckinStatusDto {
  week: string
  projects: Array<{ projectId: string; title: string; submitted: boolean }>
}

/** API 오류 응답의 data 부분. */
export interface ApiErrorData {
  code: string
  fields?: Record<string, string>
  /** 409 stale_revision일 때 서버의 현재 revision 번호. */
  currentRevision?: number
  /** 409 version_conflict(마일스톤·할 일)일 때 서버의 현재 version. */
  currentVersion?: number
  /** 409 limit_reached일 때 한도. */
  limit?: number
  /** 403 hub_write_not_allowed가 학교 인증 때문이면 'school_affiliation'과 그 과목의 정본 학교 id(C-01). */
  requirement?: 'school_affiliation'
  schoolId?: string | null
  /** 422 code_mismatch(학교 메일 인증 코드)일 때 남은 시도 횟수. */
  attemptsLeft?: number
  /** 409 in_use(마일스톤 삭제)일 때 그 마일스톤을 가리키는 로그 수(이전 revision 포함). */
  logCount?: number
  /** 409 not_current(이전 선언 revision에 확인)일 때 현재 revision id. */
  currentRevisionId?: string
  /** 409 similar_exists / already_exists(학교·과목 만들기)일 때 비슷하거나 같은 기존 항목. */
  candidates?: CatalogCandidateDto[]
  /** 409 embargo_active일 때 엠바고 종료 시각. */
  until?: string
  /** 409 stale_manifest일 때 후보의 현재 manifest 해시. */
  currentManifestHash?: string
  /** 409 superseded일 때 지금 열린 후보 id(없으면 null). */
  currentCandidateId?: string | null
}

// ── 공개 스냅샷 (T-11, ADR 0011) ─────────────────────────────────────────
//
// 공개 페이지(T-12)·포트폴리오가 그대로 보여 줄 데이터입니다. 서버의 buildPublicSnapshot만 이 값을 만들며,
// 후보에 저장된 값을 바꾸지 않고 그대로 내려줍니다. 이메일·사용자 id·체크인·비공개 메모·확인 메모·감사 정보·
// 저장소 키·비공개 경로 링크·학기 id·다른 프로젝트 자료는 들어가지 않습니다(허용 목록으로만 만듦).

export type PublicationLevel = 'summary' | 'full'
export type PublicationStatus = 'draft' | 'embargoed' | 'awaiting_consent' | 'ready' | 'published' | 'withdrawn' | 'restricted'
export type CandidateStatus = 'awaiting_consent' | 'ready' | 'superseded' | 'published' | 'withdrawn' | 'replaced'
export type ConsentStatus = 'pending' | 'granted' | 'declined' | 'revoked'
export type ExposureMode = 'name' | 'anonymous'

/** 산출물 사용 조건(§9.5): 열람만(기본) / 명시한 라이선스 / 외부 자료의 원래 조건. */
export type UsageTerms =
  | { kind: 'view_only' }
  | { kind: 'license'; spdx: string }
  | { kind: 'external'; source: string }

/** 공개 스냅샷의 팀원. key는 공개마다 안정된 가명 키(사용자 id 아님). */
export interface PublicMember {
  key: string
  /** 표시 이름 또는 "팀원 A". */
  label: string
  anonymous: boolean
}

export interface PublicLog extends RetrospectiveMarked {
  key: string
  tag: LogTag
  /** 출처(web/discord/task/retro/ai). 화면은 글자로 보여 줍니다. */
  source: LogSource
  /** 작성자 가명 키. 익명으로 고른 팀원의 로그는 null(작성자 표시 없음). */
  author: string | null
  body: string
  /** 태그별 허용 필드만. 회의 참석자는 가명 키. */
  payload: Record<string, unknown>
  links: LogLinkDto[]
  /** 자기 기입 수행일(YYYY-MM-DD). */
  claimedDate: string | null
  /** 이 revision을 저장한 플랫폼 시각. */
  recordedAt: string
  revisionNo: number
  /** 같은 공개에 포함된 마일스톤·막힘 로그·파일만 가리킵니다. */
  milestone: string | null
  resolves: string | null
  evidence: string[]
}

export interface PublicMilestoneSnapshot extends RetrospectiveMarked {
  /** 공개 파일(artifacts[])의 versionId. */
  artifactVersionId: string
}

export interface PublicMilestone extends RetrospectiveMarked {
  key: string
  position: number
  title: string
  dueAt: string | null
  /** 자기 기입 도달일. */
  claimedAt: string | null
  /** 요약 공개에서는 항상 빈 목록. */
  snapshots: PublicMilestoneSnapshot[]
}

export interface PublicClaim {
  key: string
  member: string
  text: string
  revisionNo: number
  /** 그 revision의 팀원 확인 상태(확인 메모·확인한 사람은 싣지 않음). */
  status: 'unconfirmed' | 'confirmed' | 'disputed'
  confirmedCount: number
  disputedCount: number
  evidence: Array<{ kind: 'log'; log: string } | { kind: 'artifact'; artifactVersionId: string }>
}

export interface PublicArtifact {
  /** 내용은 T-12의 release 확인 경로로만 내려줍니다. */
  artifactVersionId: string
  displayName: string
  mediaType: string | null
  bytes: number
  usage: UsageTerms
}

export interface PublicSnapshot extends RetrospectiveMarked {
  format: 'peerchive.public-snapshot'
  schemaVersion: 1
  level: PublicationLevel
  slug: string
  title: string
  summary: string
  /** study면 "스터디 기록"(C-08). */
  kind: ProjectKind
  /**
   * 스터디 기록일 때만 있는 키: 후보를 만들 때의 스터디 방 이름 표시 방식(이후 방 방식이 바뀌어도 그대로). anonymous면 모든 멤버가 익명이고
   * 이 release로 케이스 스터디·공개 프로필·모집 첨부를 만들 수 없습니다(ADR 0026). 다른 종류의 스냅샷에는 키가 없습니다(기존 manifest 해시 유지).
   */
  studyNameMode?: 'real' | 'display' | 'anonymous'
  course: { school: string; course: string; code: string | null; year: number; semester: Semester } | null
  members: PublicMember[]
  milestones: PublicMilestone[]
  logs: PublicLog[]
  claims: PublicClaim[]
  /** 요약 공개에서는 항상 빈 목록. */
  artifacts: PublicArtifact[]
}

// ── 공개 후보·동의 DTO (멤버·당사자에게만) ──────────────────────────────

export type PublicationCheckRule =
  | 'phone'
  | 'email'
  | 'resident_id'
  | 'student_id'
  | 'private_url'
  | 'answer_file'
  | 'long_code'
  | 'anonymous_name'
  | 'pdf_metadata'
  | 'github_private'

export interface PublicationCheckDto {
  rule: PublicationCheckRule
  location: {
    kind: 'title' | 'summary' | 'log' | 'claim' | 'milestone' | 'artifact' | 'senior_note' | 'case_study' | 'portfolio' | 'course_qa' | 'completion_retro'
    key?: string
    field: string
  }
  /** 가린 표본. */
  sample: string
  /** 고칠 곳(과제 화면 링크). 제목·요약은 null(이 화면에서 고침). */
  fixUrl: string | null
}

export type PublicationBlockerDto =
  | { kind: 'consent_missing'; userId: string; status: ConsentStatus }
  | { kind: 'consent_stale'; userId: string }
  | { kind: 'file_not_clean'; artifactVersionId: string; scanStatus: ScanStatus }
  | { kind: 'hold_open' }
  | { kind: 'embargo_active'; until: string }
  | { kind: 'superseded' }
  /** 당사자 계정이 탈퇴·정지 상태(동의가 있어도 게시 불가, T-12). */
  | { kind: 'subject_inactive'; userId: string }

export interface ConsentSubjectDto {
  userId: string
  displayName: string
  /** 지금 이 과제의 active 멤버인지(나간 멤버도 당사자일 수 있음). */
  active: boolean
  /** 스냅샷의 가명 키(제목·요약만 쓴 사람은 null). */
  memberKey: string | null
  exposure: ExposureMode | null
  scope: string[]
  status: ConsentStatus
  decidedAt: string | null
  note: string | null
  /** 미동의자 제외 후보에서 이전 동의를 이어받았는지. */
  carried: boolean
}

export interface CandidateSelectionDto {
  level: PublicationLevel
  title: string
  summary: string
  slug: string
  logIds: string[]
  milestoneIds: string[]
  artifactVersionIds: string[]
  claimIds: string[]
  exposure: Record<string, ExposureMode>
  usageTerms: Record<string, UsageTerms>
  excludedUserIds: string[]
}

export interface PublicationCandidateDto {
  id: string
  projectId: string
  publicationId: string
  version: number
  level: PublicationLevel
  status: CandidateStatus
  slug: string
  title: string
  manifestHash: string
  createdAt: string
  createdBy: { userId: string; displayName: string }
  readyAt: string | null
  supersededAt: string | null
  derivedFromId: string | null
  publicationStatus: PublicationStatus
  checks: PublicationCheckDto[]
  subjects: ConsentSubjectDto[]
  blockers: PublicationBlockerDto[]
  selection: CandidateSelectionDto
  /** 내 동의(당사자가 아니면 null). */
  myConsent: ConsentStatus | null
  canDecide: boolean
  canExcludeDeclined: boolean
  /** owner이고 열린 후보이며 막는 것이 없음(서버가 게시 때 다시 검사, T-12). */
  canPublish: boolean
  /** 게시한 후보(release)면 공개 버전 번호와 게시 시각. */
  releaseNo: number | null
  publishedAt: string | null
  counts: { logs: number; milestones: number; claims: number; artifacts: number; members: number }
}

/** GET /candidates/:id/preview — 저장된 스냅샷 그대로. */
export interface CandidatePreviewDto {
  candidateId: string
  status: CandidateStatus
  manifestHash: string
  snapshot: PublicSnapshot
}

/** 공개 준비 화면의 선택지(멤버에게만). */
export interface PublicationOptionsDto {
  logs: Array<{ id: string; tag: LogTag; summary: string; author: LogAuthorDto; revisionNo: number; createdAt: string; retrospective: boolean }>
  milestones: Array<{ id: string; title: string; position: number; snapshotCount: number; retrospective: boolean }>
  claims: Array<{ id: string; text: string; author: LogAuthorDto; revisionNo: number; status: 'unconfirmed' | 'confirmed' | 'disputed' }>
  artifactVersions: Array<{
    versionId: string
    artifactId: string
    title: string
    fileName: string
    versionNo: number
    mediaType: string | null
    bytes: number
    scanStatus: ScanStatus
    uploader: LogAuthorDto
  }>
  members: Array<{ userId: string; displayName: string; status: 'invited' | 'active' | 'left' | 'removed' }>
  licenses: string[]
}

/** 공개 요약(멤버·당사자용, T-12). 철회 원인·메모는 팀 안에서만 보입니다. */
export interface PublicationSummaryDto {
  id: string
  slug: string
  level: PublicationLevel
  status: PublicationStatus
  accessEpoch: number
  /** 지금 공개로 제공하는 release(게시됨일 때만). */
  currentRelease: { candidateId: string; version: number; publishedAt: string } | null
  firstPublishedAt: string | null
  withdrawnAt: string | null
  withdrawCause: 'owner' | 'consent_revoked' | null
  withdrawNote: string | null
  /** 공개 페이지 경로(게시됨일 때만). */
  publicPath: string | null
  /** 한 번이라도 게시했으면 slug는 고정입니다. */
  slugLocked: boolean
}

/** 게시 이력 한 줄(T-12). */
export interface ReleaseSummaryDto {
  candidateId: string
  /** 공개 버전(release_no). */
  version: number
  /** 후보 번호. */
  candidateVersion: number
  status: CandidateStatus
  title: string
  level: PublicationLevel
  publishedAt: string
  replacedAt: string | null
  withdrawnAt: string | null
}

/** GET /projects/:id/publication */
export interface PublicationStateDto {
  publication: PublicationSummaryDto | null
  candidate: PublicationCandidateDto | null
  options: PublicationOptionsDto
  embargo: EmbargoDto
  canPrepare: boolean
  /** owner(게시·철회 가능). */
  canManage: boolean
  /** 게시 이력(최근 것부터). */
  releases: ReleaseSummaryDto[]
  /** 이 공개에 대한 운영 조치 안내(T-15, 되돌리지 않은 것). 이의제기는 owner만. */
  moderation: ModerationNoticeDto[]
  /** 신고 처리 전이라 게시가 보류되어 있는지(T-15, 사유만). */
  holds: Array<{ reason: ReportReason; createdAt: string }>
}

/** POST /candidates/:id/publish 응답(T-12). */
export interface PublishResultDto {
  publication: PublicationSummaryDto
  release: ReleaseSummaryDto
  /** 같은 후보·해시로 이미 게시되어 있어 아무것도 바꾸지 않았는지. */
  idempotent: boolean
}

/** POST /publications/:id/consents/revoke 응답(T-12). */
export interface ConsentRevokeResultDto {
  publicationId: string
  publicationStatus: PublicationStatus
  consentStatus: ConsentStatus
}

/** GET /me/publication-consents 한 줄: 내가 동의해 지금 게시 중인 공개(동의 철회 대상, T-12). */
export interface MyPublishedConsentDto {
  publicationId: string
  slug: string
  publicTitle: string
  projectTitle: string
  version: number
  publishedAt: string
  publicPath: string
  scope: string[]
}

/**
 * GET /public/publications/:slug — 익명 공개 조회(T-12). 저장된 스냅샷을 그대로 싣고, 공개 메타데이터만 더합니다.
 * 내부 id(공개·후보·프로젝트)·동의·철회 정보는 싣지 않습니다.
 */
export interface PublicPublicationDto {
  slug: string
  level: PublicationLevel
  /** 공개 버전(release_no). */
  version: number
  publishedAt: string
  firstPublishedAt: string
  snapshot: PublicSnapshot
  /** 이 release가 연결된 과목 허브(정본 과목 id, T-13). 없으면 null. */
  courseId: string | null
  /** 이 공개의 계획을 포크한 서로 다른 사용자 수(T-13). */
  forkCount: number
  /** 운영 조치로 가린 항목의 자리(T-15). 스냅샷에서는 빠져 있고, 화면은 원래 위치에 "운영 조치로 가려진 항목"을 그립니다. */
  hiddenItems: HiddenItemPlaceholderDto[]
}

/** GET /me/consent-requests 한 줄. */
export interface ConsentRequestDto {
  candidateId: string
  projectId: string
  projectTitle: string
  publicTitle: string
  level: PublicationLevel
  manifestHash: string
  scope: string[]
  requestedAt: string
  requestedBy: string
  previewUrl: string
}

// ── 과목 허브·선배 노트·플랜 포크·유용성 신호·검색 (T-13, ADR 0013) ──────────
// 공개 DTO는 게시된 release 스냅샷과 게시된 선배 노트에서만 만듭니다. 교수 실명·평가 필드는 없습니다.

/** affiliation(A-06): 토픽 답변을 옮기며 소속 표시를 유지한 노트(옮기기로만). */
export type SeniorNoteDisplayMode = 'name' | 'display' | 'anonymous' | 'affiliation'
export type SeniorNoteStatus = 'draft' | 'published' | 'withdrawn' | 'hidden'
export type SeniorNoteTimeBucket = 'lt10h' | 'lt20h' | 'lt40h' | 'forty_plus'
export type SeniorNoteQuestion = 'firstWeek' | 'timeSink' | 'differently' | 'wishKnew'
export type SeniorNoteAnswers = Partial<Record<SeniorNoteQuestion, string>>
export type SignalKind = 'me_too' | 'helped'
export type SearchKind = 'case' | 'stuck' | 'note' | 'qa'

/** 항목별 유용성 신호 수(작성자별 합계는 없음). */
export interface SignalCountsDto {
  meToo: number
  helped: number
}

export interface CourseHubCaseDto {
  slug: string
  path: string
  title: string
  termLabel: string | null
  level: PublicationLevel
  /** study면 화면이 "스터디" 배지를 붙입니다(C-08). */
  kind: ProjectKind
  /** 팀 과제·스터디 기록이면 스냅샷에 실린 참여자 수(익명 포함), 개인 과제면 null. */
  teamSize: number | null
  milestoneCount: number
  stuckCount: number
  retrospective: boolean
  forkCount: number
  publishedAt: string
}

export interface CourseHubStuckDto {
  slug: string
  caseTitle: string
  key: string
  symptom: string
  keywords: string[]
  timeBucket: string | null
  resolved: boolean
  recordedAt: string
  /** 공개 사례 페이지의 그 막힘 위치(`/p/<slug>#public-<key>`). */
  path: string
  signals: SignalCountsDto
}

/** 공개 선배 노트. 작성자 id는 싣지 않습니다(익명이면 "익명 선배"). */
export interface PublicSeniorNoteDto {
  id: string
  author: string
  /** 이름이 없는 노트(익명·소속 표시). */
  anonymous: boolean
  /** 토픽 답변을 옮기며 소속 표시를 유지한 노트(A-06): author가 `○○대학교 · 졸업생` 같은 소속 표시입니다. */
  affiliated: boolean
  termLabel: string | null
  totalTimeBucket: SeniorNoteTimeBucket | null
  answers: SeniorNoteAnswers
  publishedAt: string
  signals: SignalCountsDto
}

export interface CourseHubWorkloadDto {
  /** 통계 공유에 동의한 체크인 분포. 동의한 사람이 minGroup명 미만이면 null. */
  stats: { contributors: number; timeBuckets: Record<CheckinTimeBucket, number>; difficulty: Record<'1' | '2' | '3' | '4' | '5', number> } | null
  minGroup: number
  /** stats가 null일 때 "아직 데이터가 충분하지 않음". */
  message: string | null
}

export interface CourseHubRelatedDto {
  id: string
  title: string
  code: string | null
  schoolName: string
  sharedTags: ConceptTagDto[]
}

/** GET /public/courses/:id — 정본 과목의 허브. 병합된 id로 부르면 정본을 돌려줍니다(course.id가 다름). */
export interface PublicCourseHubDto {
  /** E-02: 열린 허브. 단계적 개방 플래그가 꺼져 있으면 항상 open입니다. */
  status: 'open'
  course: { id: string; title: string; code: string | null; school: { name: string }; authoredBy: 'student' }
  conceptTags: ConceptTagDto[]
  cases: CourseHubCaseDto[]
  stuckItems: CourseHubStuckDto[]
  seniorNotes: PublicSeniorNoteDto[]
  /** 막힘 Q&A(C-09): 게시된 것만. 복사한 글과 각자 고른 이름뿐(사람 id·원 글 정보 없음). */
  qaItems: PublicCourseQaDto[]
  workload: CourseHubWorkloadDto
  otherSchools: CourseHubRelatedDto[]
  /** "이번 학기 수강 중 N명"(E-01): 지금 학기에 이 과목을 등록한 active 사용자 수. 5명 미만이면 null(표시하지 않음). 익명 집계뿐입니다. */
  enrollment: { termLabel: string; count: number } | null
  /** 과제 유형 요약(E-03, ADR 0048): 과목 큐레이터가 정리한 짧은 글. 작성자 이름은 싣지 않습니다. 없으면 null. */
  assignmentTypeSummary: AssignmentTypeSummaryDto | null
}

/**
 * 과목 허브 "준비 중"(E-02, ADR 0047): 단계적 개방이 켜져 있고 공개 사례 + 선배 노트가 기준 미만인 과목. 내용 목록(사례·막힘·노트·Q&A·통계·수강 인원)은
 * 싣지 않습니다. count는 이미 공개된 항목 수라 그대로 보여 줍니다.
 */
export interface PreparingCourseHubDto {
  status: 'preparing'
  course: PublicCourseHubDto['course']
  opening: { count: number; threshold: number }
}

/** GET /api/v1/public/courses/:id */
export type CourseHubViewDto = PublicCourseHubDto | PreparingCourseHubDto

/** GET /api/v1/me/course-hubs/:id/opening — 준비 중 허브에서 로그인한 본인에게만 보이는 상태(E-02). 신청 수 같은 다른 사람의 정보는 없습니다. */
export interface MyHubOpeningDto {
  courseId: string
  status: 'open' | 'preparing'
  count: number
  threshold: number
  /** 이 과목을 (어느 학기든) 등록했는지. "열리면 알려 주세요"는 등록한 학생만. */
  registered: boolean
  /** 이 과목을 마쳤는지(끝난 학기 등록 또는 끝난 학기 과제 공간의 멤버). */
  finished: boolean
  notifyRequested: boolean
  /** 이 과목에 내 선배 노트(초안 포함, 철회 제외)가 있는지. */
  wroteNote: boolean
}

export interface HubNoticeCourseDto {
  id: string
  title: string
  code: string | null
  schoolName: string
}

/** GET /api/v1/me/course-hub-notices — 홈의 과목 허브 알림(E-02). 본인 것만. */
export interface MyHubNoticesDto {
  /** 알림을 신청한 허브가 열렸음(닫기 전까지). */
  opened: Array<{ id: string; course: HubNoticeCourseDto; openedAt: string }>
  /** 마친 과목 중 아직 준비 중인 허브: 선배 노트 요청. */
  noteRequests: Array<{ course: HubNoticeCourseDto; count: number; threshold: number }>
}

/** GET /api/v1/operator/course-hubs/opening — 과목별 개방 진행(E-02). 공개 항목 수 집계만(사람·신청 정보 없음). */
export interface OperatorHubOpeningDto {
  stagedOpening: boolean
  threshold: number
  summary: { coursesWithContent: number; open: number; preparing: number }
  items: Array<{ course: HubNoticeCourseDto; cases: number; notes: number; total: number; status: 'open' | 'preparing' }>
}

/** 공개 막힘 Q&A(C-09, ADR 0025). 커뮤니티 질문·채택된 답변을 두 사람의 동의로 복사한 것. */
export interface PublicCourseQaDto {
  id: string
  questionTitle: string
  questionBody: string
  answerBody: string
  /** 질문한 사람이 고른 이름(익명이면 "질문한 학생"). */
  asker: string
  askerAnonymous: boolean
  /** 답한 사람이 고른 이름(익명이면 "답한 학생"). */
  answerer: string
  answererAnonymous: boolean
  publishedAt: string
  signals: SignalCountsDto
}

export type CourseQaStatus = 'published' | 'withdrawn' | 'hidden'

/** 당사자(질문한 사람·답한 사람)에게 보이는 막힘 Q&A(GET /me/course-qa). 상대가 누구인지는 없습니다. */
export interface MyCourseQaDto {
  id: string
  course: { id: string; title: string; schoolName: string }
  questionTitle: string
  role: 'asker' | 'answerer'
  /** 내가 고른 이름. */
  myLabel: string
  status: CourseQaStatus
  publishedAt: string
  withdrawnAt: string | null
  /** 게시 중이면 과목 허브의 위치. */
  path: string | null
}

/** 작성자에게만 주는 선배 노트(초안 포함). */
export interface SeniorNoteDto {
  id: string
  course: { id: string; title: string; schoolName: string }
  displayMode: SeniorNoteDisplayMode
  /** display 모드의 표시명(name 모드는 계정 이름, anonymous는 null). */
  displayName: string | null
  /** 공개 화면에 보일 이름. */
  publicLabel: string
  /** 토픽 답변에서 복사한 소속 표시(A-06, 작성자 본인에게만 주는 DTO). 있으면 표시 방식으로 affiliation을 고를 수 있습니다. */
  affiliationLabel: string | null
  termLabel: string | null
  totalTimeBucket: SeniorNoteTimeBucket | null
  answers: SeniorNoteAnswers
  status: SeniorNoteStatus
  publishedAt: string | null
  withdrawnAt: string | null
  version: number
  createdAt: string
  updatedAt: string
  /** 공개 전 점검 경고(가린 표본만). 게시하려면 확인해야 합니다. */
  warnings: PublicationCheckDto[]
  /** 운영 조치로 숨겨졌으면 그 안내(T-15). */
  moderation: ModerationNoticeDto | null
}

/** POST /public/publications/:slug/fork 응답. */
export interface PlanForkResultDto {
  projectId: string
  projectPath: string
  /** 새로 만들었으면 true(201), 이미 포크한 적이 있어 기존 프로젝트를 돌려주면 false(200). */
  created: boolean
  copied: { milestones: number; references: number }
}

/** PUT/DELETE /signals 응답: 그 대상의 지금 개수와 내 신호. */
export interface SignalStateDto {
  signals: SignalCountsDto
  mine: { meToo: boolean; helped: boolean }
}

/** GET /me/signals 한 줄(지금 공개인 대상만). */
export type MySignalDto =
  | { target: 'stuck_item'; slug: string; itemKey: string; kind: SignalKind }
  | { target: 'senior_note'; noteId: string; kind: SignalKind }
  | { target: 'course_qa'; qaId: string; kind: SignalKind }

export interface SearchResultDto {
  kind: SearchKind
  title: string
  snippet: string
  /** 공개 사례·막힘은 공개 페이지 경로, 노트는 과목 허브의 노트 위치. */
  path: string
  course: { id: string; title: string; schoolName: string } | null
}

/** GET /public/search */
export interface PublicSearchDto {
  q: string
  type: SearchKind | null
  courseId: string | null
  results: SearchResultDto[]
}

/**
 * GET /public/publications/:slug/stuck/:itemKey/similar — 비슷한 공개 막힘(E-05, ADR 0055). 결과는 kind 'stuck'뿐이고 카드와 같은 필드(증상·키워드)만.
 * `indexed: false`는 그 카드의 벡터가 아직 없음(worker 대기). 유사도 점수·내부 id는 싣지 않습니다.
 */
export interface SimilarStuckDto {
  indexed: boolean
  results: SearchResultDto[]
}

/** GET /public/search/semantic — "의미로 찾기"(E-05). 검색어는 저장하지 않습니다. */
export interface PublicSemanticSearchDto {
  q: string
  courseId: string | null
  results: SearchResultDto[]
}

// ── 케이스 스터디·포트폴리오 판·공개 프로필 (T-14, ADR 0014) ─────────────────
// 공개 DTO는 (a) 프로필의 공개 필드, (b) 지금 제공 가능한 release 스냅샷, (c) 사용자가 케이스·판에 쓴 글에서만 만듭니다.
// 내부 id(사용자·케이스·공개·release)·이메일은 공개 DTO에 싣지 않습니다.

export type CaseJobTarget = 'backend' | 'frontend' | 'data' | 'pm' | 'design' | 'general'
export type CaseSectionKey = 'problem_result' | 'my_role' | 'decisions' | 'stuck_solved' | 'validation' | 'limits' | 'sources'
export type CaseStudyStatus = 'draft' | 'published' | 'unavailable'
export type CitationKind = 'summary' | 'log' | 'claim' | 'milestone' | 'artifact'
export type CaseSentenceKind = 'evidence' | 'reflection'
/** 볼 수 없는 이유: 원본 공개 철회 / 새 공개 버전으로 대체 / 그 밖(예: 게시 뒤 엠바고). */
export type CaseUnavailableReason = 'withdrawn' | 'replaced' | 'blocked'

export interface CaseCitationRef {
  releaseVersion: number
  kind: CitationKind
  key: string
}

/** 화면용 인용(스냅샷에서 만든 짧은 표시 + 공개 사례 페이지 안의 위치). */
export interface CaseCitationDto extends CaseCitationRef {
  /** 스냅샷이 지금 제공 가능할 때만 채움. */
  label: string | null
  path: string | null
}

export interface CaseSentenceDto {
  text: string
  kind: CaseSentenceKind
  citations: CaseCitationDto[]
}

export interface CaseSectionDto {
  key: CaseSectionKey
  label: string
  sentences: CaseSentenceDto[]
}

export interface CaseStudySourceInfo {
  slug: string
  path: string
  releaseVersion: number
  publicTitle: string
  termLabel: string | null
  /** 스냅샷에서 이 사람의 표시(이름 또는 "팀원 A"). */
  selfLabel: string
  selfAnonymous: boolean
  revealSelf: boolean
}

/** 작성자에게만 주는 케이스 스터디(초안 포함). */
export interface CaseStudyDto {
  id: string
  title: string
  jobTarget: CaseJobTarget
  /** 읽는 지금 기준 상태(원본 release를 더 이상 제공하지 않으면 unavailable). */
  status: CaseStudyStatus
  unavailableReason: CaseUnavailableReason | null
  version: number
  generator: 'template'
  source: CaseStudySourceInfo
  sections: CaseSectionDto[]
  /** 게시를 막는 출처 없는 문장(구역 키·구역 안 순서). */
  uncited: Array<{ section: CaseSectionKey; index: number }>
  /** 공개 전 점검 경고(가린 표본). 게시하려면 확인해야 합니다. */
  warnings: PublicationCheckDto[]
  /** 고정한 release의 공개 스냅샷(인용 고르기용). 볼 수 없게 되면 null. */
  snapshot: PublicSnapshot | null
  /** 볼 수 없게 되었을 때, 같은 공개의 지금 버전으로 다시 만들 수 있으면 그 slug. */
  recreateSlug: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  /** 운영 조치로 숨겨졌는지(T-15). 숨김이면 다시 게시할 수 없습니다(409 hidden). */
  hidden: boolean
  moderation: ModerationNoticeDto | null
}

export interface CaseStudySummaryDto {
  id: string
  title: string
  jobTarget: CaseJobTarget
  status: CaseStudyStatus
  unavailableReason: CaseUnavailableReason | null
  version: number
  source: { slug: string; releaseVersion: number; publicTitle: string }
  uncitedCount: number
  recreateSlug: string | null
  publishedAt: string | null
  updatedAt: string
}

/** GET /me/case-study-sources 한 줄: 내가 팀원 키로 들어 있는 지금 게시 중인 release. */
export interface CaseStudySourceDto {
  slug: string
  path: string
  title: string
  releaseVersion: number
  publishedAt: string
  termLabel: string | null
  selfLabel: string
  selfAnonymous: boolean
  caseStudies: Array<{ id: string; jobTarget: CaseJobTarget; status: CaseStudyStatus }>
}

export interface CompetencyEvidenceInput {
  caseStudyId: string
  citations: Array<{ kind: Exclude<CitationKind, 'summary'>; key: string }>
}

/** 작성자에게만 주는 포트폴리오 판. */
export interface PortfolioEditionDto {
  id: string
  /** 판이 귀속된 페르소나(S-01, 본인에게만 주는 DTO). */
  persona: { id: string; kind: PersonaKind; handle: string }
  version: number
  current: boolean
  headline: string | null
  createdAt: string
  featured: Array<{ caseStudyId: string; title: string; position: number }>
  competencies: Array<{ label: string; preset: string | null; evidence: CompetencyEvidenceInput[] }>
  skillsDeclared: string[]
  warnings: PublicationCheckDto[]
}

export interface PublicCitationDto {
  label: string
  path: string
}

export interface PublicCaseSentenceDto {
  text: string
  /** 한계·회고 구역의 출처 없는 본인 회고("본인 회고"로 표시). */
  reflection: boolean
  citations: PublicCitationDto[]
  /** 운영 조치로 가린 항목을 인용해 글을 가린 문장(T-15). text는 "운영 조치로 가려진 항목"입니다. */
  moderated?: boolean
}

/** 공개 프로필의 대표 케이스(포트폴리오 요약 보기). 볼 수 없으면 글 없이 안내만. */
export type PublicCaseStudyDto =
  | {
      anchor: string
      available: true
      title: string
      jobTarget: CaseJobTarget
      jobTargetLabel: string
      path: string
      releaseVersion: number
      termLabel: string | null
      selfLabel: string
      sections: Array<{ key: CaseSectionKey; label: string; sentences: PublicCaseSentenceDto[] }>
      /**
       * "이 지원자에게 물어보면 좋은 질문"(E-06, ADR 0050): 학생이 공개로 고른 면접 준비 팩 질문의 **글만**(답변 메모 없음).
       * 실명 페르소나의 공개 프로필에서, 케이스를 지금 볼 수 있고 그 질문이 지금 만들어질 때만. 그 밖에는 빈 배열.
       */
      askQuestions: PublicAskQuestionDto[]
    }
  | { anchor: string; available: false; message: string }

/** 공개 화면의 면접 준비 팩 질문(E-06). 근거가 있으면 그 공개 기록으로 가는 출처 칩. */
export interface PublicAskQuestionDto {
  text: string
  categoryLabel: string
  source: PublicCitationDto | null
}

export type InterviewQuestionCategory = 'decision' | 'conflict' | 'stuck' | 'failure' | 'reflection'

/** 면접 준비 팩의 질문 하나(본인에게만). note는 비공개 답변 메모입니다. */
export interface InterviewQuestionDto {
  /** 안정된 질문 키(`decision:l_…`, `stuck:l_…`, `generic:failure` 등). */
  key: string
  category: InterviewQuestionCategory
  categoryLabel: string
  text: string
  /** 근거 로그(고정 release 스냅샷). 일반 질문은 null. */
  source: { kind: 'log'; key: string; label: string | null; path: string | null } | null
  note: string | null
  /** 질문 글을 공개 프로필에 보이기로 골랐는지(답변 메모는 어떤 경우에도 공개하지 않음). */
  shown: boolean
  /** 메모를 저장한 뒤 질문 글이 바뀌었는지(케이스 수정·새 공개 버전). */
  textChanged: boolean
  updatedAt: string | null
}

/** 지금 이 케이스에서 만들어지지 않는 질문에 남은 메모(본인에게만, 공개되지 않음). */
export interface ArchivedInterviewNoteDto {
  key: string
  /** 메모를 마지막으로 저장할 때의 질문 글. */
  text: string
  note: string | null
  updatedAt: string
}

/** GET /case-studies/:id/interview-prep — 작성자만. */
export interface InterviewPrepDto {
  caseStudyId: string
  generator: 'template'
  /** 케이스의 원본 사례를 지금 볼 수 있는지(아니면 questions가 비고 메모는 모두 archived). */
  available: boolean
  /** 지금 공개 프로필에서 이 케이스를 볼 수 있는지(게시 중·제공 가능·숨김 아님). 고른 질문은 이때만 보입니다. */
  publiclyVisible: boolean
  questions: InterviewQuestionDto[]
  archived: ArchivedInterviewNoteDto[]
}

export interface PublicMatrixCellDto {
  column: string
  available: boolean
  /** 종류별 개수만(점수·수준 없음). */
  counts: Array<{ category: string; label: string; count: number }>
  text: string
  evidence: PublicCitationDto[]
}

export interface PublicCompetencyMatrixDto {
  columns: Array<{ ref: string; title: string; available: boolean }>
  rows: Array<{ label: string; evidenceBacked: boolean; cells: PublicMatrixCellDto[] }>
}

export interface PublicTimelineItemDto {
  termLabel: string | null
  /** 정렬용 연도(학기 정보가 없으면 게시 연도). */
  year: number
  title: string
  path: string
}

/** 공개 포트폴리오 보기(공개 프로필·판 미리보기 공통). */
export interface PortfolioViewDto {
  headline: string | null
  featured: PublicCaseStudyDto[]
  matrix: PublicCompetencyMatrixDto
  evidenceBackedCompetencies: string[]
  skillsDeclared: string[]
}

/** GET /public/profiles/:handle — 이메일·내부 id 없음. */
export interface PublicPortfolioProfileDto extends PortfolioViewDto {
  handle: string
  displayName: string
  jobTargets: string[]
  schoolLabel: string | null
  gradTerm: string | null
  contactPolicy: ContactPolicy
  /** 연락 정책 안내 문구(연락 기능은 P2, 이메일은 싣지 않음). */
  contactText: string
  openToWork: boolean
  edition: { version: number; createdAt: string } | null
  /**
   * 후배 기여: 개수만, 순위 없음. curatedCourses(E-03, ADR 0048)는 지금 큐레이터인 과목 중 본인이 포트폴리오 표시를 켠 것만(기본 꺼짐, 실명 프로필만).
   */
  juniorContribution: { planForks: number; seniorNotes: number; curatedCourses: CuratedCourseLabelDto[]; stuckQaAnswers: number }
  timeline: PublicTimelineItemDto[]
  /** 학교 인증 배지(C-01). 본인이 켰을 때만, active 인증의 학교 이름 + 졸업생 여부. 학과·메일·도메인 없음. */
  affiliationBadges: PublicAffiliationBadgeDto[]
  /** 페르소나 종류(S-01). 표시명 프로필에는 타임라인·후배 기여·대표 케이스가 없습니다(공개 사례에 계정 이름이 있으므로, ADR 0028). */
  kind: PersonaKind
  /** 연결을 켠 상대 페르소나(S-01). 꺼져 있으면 null. */
  linkedPersona: PublicLinkedPersonaDto | null
  /**
   * 과제 수행 목록(S-03). 공개 경로는 늘 비로그인으로 판정하므로 `project_list`가 전체 공개일 때만 배열, 아니면 null.
   * 표시명 프로필은 늘 null(과제 수행 목록은 실명 페르소나만, ADR 0031).
   */
  projects: PublicProjectListingDto[] | null
  /**
   * 팔로워·팔로잉 수(S-04). 공개 경로는 비로그인 판정이라 주인이 `show_follower_count`를 켰을 때만 이 키가 있고, 끄면 키 자체가 없습니다.
   */
  followCounts?: FollowCountsDto
  /**
   * 소셜 링크(S-06). 프로필 기본 정보라 공개 범위 항목이 없고 늘 실립니다(차단당한 사용자는 세션 경로가 페르소나 자체를 404로). 이 페르소나의
   * 링크만이고 상대 페르소나의 링크는 연결을 켜도 싣지 않습니다. `verified`는 되돌림 링크 확인일 뿐 인물 검증이 아닙니다.
   */
  socialLinks: PublicSocialLinkDto[]
}

// ── 제한 공유 링크 (E-07, ADR 0051) ──────────────────────────────────────

/** active: 열 수 있음 / revoked: 철회 / expired: 만료 / superseded: 새 판이 생겨 그 판이 지금 판이 아님(열면 404). */
export type ShareLinkStatus = 'active' | 'revoked' | 'expired' | 'superseded'

/** 본인 공유 링크 목록 항목. 원문 토큰은 만든 응답(`CreatedShareLinkDto`)에서 한 번만 줍니다. 열람은 횟수만 셉니다. */
export interface ShareLinkDto {
  id: string
  edition: { id: string; version: number; personaKind: PersonaKind; personaHandle: string }
  label: string | null
  status: ShareLinkStatus
  expiresAt: string
  revokedAt: string | null
  viewCount: number
  createdAt: string
}

export interface CreatedShareLinkDto extends ShareLinkDto {
  /** 원문 토큰(서버는 해시만 저장). 지금만 볼 수 있습니다. */
  token: string
  /** 공유 페이지 경로(`/s/<token>`). */
  path: string
}

/**
 * 공유 페이지 응답(`GET /api/v1/public/share/:token`). 그 판의 포트폴리오 보기와 프로필 기본 필드만 — 공개 프로필보다 좁습니다:
 * 타임라인·후배 기여·과제 수행 목록·팔로우 수·소셜 링크·학교 인증 배지·상대 페르소나 링크(S-01)는 싣지 않습니다.
 */
export interface SharedPortfolioDto extends PortfolioViewDto {
  handle: string
  displayName: string
  kind: PersonaKind
  jobTargets: string[]
  schoolLabel: string | null
  gradTerm: string | null
  contactText: string
  openToWork: boolean
  edition: { version: number; createdAt: string }
  /** 링크 만료 시각(보는 사람에게 안내). */
  expiresAt: string
}

// ── 학교 메일 인증 (C-01, ADR 0018) ──────────────────────────────────────

export type AffiliationStanding = 'student' | 'alumni'
export type AffiliationStatus = 'pending' | 'active' | 'revoked' | 'expired'
export type AffiliationRevokedReason = 'user_removed' | 'operator' | 'merged_duplicate' | 'certificate_rejected'
/** 기관 종류·인증 수단(I-01, ADR 0037). */
export type InstitutionKind = 'university' | 'bootcamp' | 'training_program' | 'club_federation'
export type AffiliationMethod = 'email' | 'invite_code' | 'cohort_approval' | 'certificate_check'

/** 내 학교·기관 인증(본인에게만). 메일 주소는 저장하지 않으므로 없고, 도메인만 있습니다. */
export interface AffiliationDto {
  id: string
  school: SchoolDto
  /** 메일 도메인. 메일이 아닌 수단(I-01)이면 null. */
  emailDomain: string | null
  /** 인증 수단(I-01). C-01 학교 메일은 email. */
  method: AffiliationMethod
  /** 기관 종류(I-01). 학교는 university. */
  institutionKind: InstitutionKind
  /** 기수 이름(I-01, 대학은 null). */
  cohortLabel: string | null
  /** 기수 승인 요청이면 받은 승인 수·필요 수(I-01). */
  cohortApprovals: { count: number; required: number } | null
  /** 수료증 확인 요청이면 파일·검사·결정 상태(I-01). 결과 외 다른 내용은 없습니다. */
  certificate: { uploaded: boolean; scanStatus: ScanStatus; result: 'approved' | 'rejected' | null; decidedAt: string | null } | null
  standing: AffiliationStanding
  /** 자기 신고 학과(공개하지 않음). */
  departmentLabel: string | null
  status: AffiliationStatus
  verifiedAt: string | null
  revokedAt: string | null
  revokedReason: AffiliationRevokedReason | null
  /** pending일 때 지금 코드의 만료 시각·남은 시도 횟수. */
  code: { expiresAt: string; attemptsLeft: number } | null
  createdAt: string
  updatedAt: string
}

/** GET /me/affiliations. */
export interface AffiliationListDto {
  items: AffiliationDto[]
  /** 공개 프로필 배지 설정(프로필이 없으면 false). */
  showBadge: boolean
  /** 과목 허브 작성에 학교 인증이 필요한지(서버 정책, 기본 true). */
  hubRequiresAffiliation: boolean
}

/** 운영자 목록: 사용자 id·학교·도메인·상태만(학과·재학 상태·메일 없음). */
export interface OperatorAffiliationDto {
  id: string
  userId: string
  school: SchoolDto
  emailDomain: string | null
  status: AffiliationStatus
  verifiedAt: string | null
  revokedAt: string | null
}

// ── 기관 일반화·인증 수단 (I-01, ADR 0037) ───────────────────────────────

/** GET /api/v1/features — P2 기능 플래그(영역별). */
export interface FeatureFlagsDto {
  alumni: boolean
  topics: boolean
  institutions: boolean
  /** E-02 과목 허브 단계적 개방(P1 영역, 기본 꺼짐). */
  hubStagedOpening: boolean
  /** E-04 막힘 Q&A 스레드(P1 영역, 기본 꺼짐). */
  stuckQa: boolean
  /** E-05 유사 막힘 의미 검색. 플래그가 아니라 임베딩 공급자 설정(PEERCHIVE_EMBEDDINGS_PROVIDER + VOYAGE_API_KEY)이 있을 때만 true. */
  semanticStuck: boolean
  /** E-11 GitHub App 연동. 플래그가 아니라 GITHUB_APP_* 설정 여섯 개가 모두 있을 때만 true. */
  github: boolean
  /**
   * E-12 AI 기능(AI 회고 인터뷰). 플래그가 아니라 서버에 AI 공급자가 설정되어 있을 때만 true(PEERCHIVE_AI_ENABLED=on + ANTHROPIC_API_KEY).
   * 실제로 쓰려면 학생이 과제마다 따로 켜야 합니다(`AiRetroStateDto.optedIn`).
   */
  ai: boolean
}

/** 대학이 아닌 기관(검색·운영자 생성 결과). */
export interface InstitutionDto {
  id: string
  name: string
  kind: InstitutionKind
}

/** 초대 코드(운영자). 원문은 발급 응답의 `code`에만 한 번 있습니다. */
export interface InviteCodeDto {
  id: string
  institution: InstitutionDto
  cohortLabel: string | null
  expiresAt: string
  maxUses: number
  usedCount: number
  revokedAt: string | null
  createdAt: string
}

/** POST /operator/institutions/:id/invite-codes — 원문 코드는 이 응답에만. */
export interface IssuedInviteCodeDto extends InviteCodeDto {
  code: string
}

// ── 기관 페이지·기수 방·기관 운영진 (I-02, ADR 0044) ───────────────────

/** GET /operator/institutions/:id/staff — 운영자만 보는 운영진 목록. */
export interface InstitutionStaffDto {
  /** 지정 행 id. */
  id: string
  userId: string
  /** 계정 표시 이름(운영자 확인용). */
  displayName: string
  grantedAt: string
}

/** 기관이 운영하는 기수 방 요약(운영진·운영자). 멤버 수는 5 미만이면 null(사람 목록 없음). */
export interface CohortRoomSummaryDto {
  slug: string
  name: string
  cohortLabel: string
  status: SpaceStatus
  nameMode: NameMode
  memberCount: number | null
}

/** GET /community/institutions/:id — 운영진·운영자의 기관 운영 화면(기관 페이지·기수 방). 소속 사용자 목록은 없습니다. */
export interface InstitutionOverviewDto {
  institution: InstitutionDto
  /** 운영자로 보는지(아니면 그 기관 운영진). */
  asOperator: boolean
  page: { slug: string; name: string; status: SpaceStatus } | null
  cohortRooms: CohortRoomSummaryDto[]
}

/**
 * GET /community/institutions/:id/stats — 기관 집계(임계값 적용). 모든 수는 `minGroup`(5) 미만이면 null이고, 합계는 싣지 않습니다
 * (가린 칸을 빼기로 되살리지 못하게). 사람·글 단위 값은 없습니다.
 */
export interface InstitutionStatsDto {
  institution: InstitutionDto
  minGroup: number
  /** 지금 인증된 회원 수(신분별, 사람 단위). */
  verifiedMembers: { student: number | null; alumni: number | null }
  /** 기관 페이지의 최근 30일 게시 글·댓글 수(페이지가 없으면 null). */
  page: { posts30d: number | null; comments30d: number | null } | null
  /** 보관되지 않은 기수 방 수(사람 수가 아니므로 가리지 않음). */
  cohortRooms: number
  generatedAt: string
}

/** GET /affiliations/:id/cohort-approval — 승인할 수 있는 멤버에게만 보이는 기수 승인 요청. */
export interface CohortApprovalRequestDto {
  id: string
  institution: InstitutionDto
  cohortLabel: string
  /** 요청한 사람의 계정 이름(같은 기수 멤버가 알아보도록). */
  requesterName: string
  approvals: number
  required: number
  /** 내가 이미 승인했는지. */
  approvedByMe: boolean
  status: AffiliationStatus
  createdAt: string
}

/** POST /me/affiliations/certificate — 수료증 요청과 파일을 올릴 주소(PUT). */
export interface CertificateRequestDto {
  affiliation: AffiliationDto
  uploadUrl: string
}

/** 운영자 수료증 확인 목록. 파일 이름·내용은 없습니다. */
export interface OperatorCertificateCheckDto {
  id: string
  affiliationId: string
  user: { id: string; displayName: string }
  institution: InstitutionDto
  cohortLabel: string | null
  standing: AffiliationStanding
  scanStatus: ScanStatus
  mediaType: string | null
  uploadedAt: string | null
  /** 지금 서명 URL을 받아 볼 수 있는지(결정 전·검사 통과·파일 있음). */
  viewable: boolean
  result: 'approved' | 'rejected' | null
  decidedAt: string | null
  filePurgedAt: string | null
  createdAt: string
}

/** POST /operator/certificate-checks/:id/file-url — 짧은(60초) 서명 URL. */
export interface CertificateFileUrlDto {
  url: string
  expiresAt: string
}

export interface SchoolEmailDomainDto {
  id: string
  schoolId: string
  domain: string
  createdAt: string
}

/** GET /me/hub-write?course= — 과목 허브 작성 가능 여부(화면 안내용). */
export interface HubWriteEligibilityDto {
  /** 정본 과목 id. */
  courseId: string
  allowed: boolean
  /** 막힌 이유가 학교 인증이면 'school_affiliation'(그 학교 메일로 인증하면 쓸 수 있음). */
  requirement: 'school_affiliation' | null
  /** 과목의 정본 학교. */
  school: SchoolDto
}

export interface PublicAffiliationBadgeDto {
  /** 예: "한빛대학교 인증", "한빛대학교 인증 · 졸업생". */
  label: string
  alumni: boolean
}

// ── 신고·운영 조치·이의제기 (T-15, ADR 0015) ─────────────────────────────

export type ReportTargetType =
  | 'publication'
  | 'publication_item'
  | 'senior_note'
  | 'case_study'
  | 'profile'
  | 'community_space'
  | 'community_post'
  | 'community_comment'
  | 'community_recruitment'
  | 'community_application'
  | 'course_qa'
  /** S-07: 페르소나(실명·표시명) 공개 프로필·프로필 글·소셜 링크. */
  | 'persona'
  | 'profile_post'
  | 'social_link'
  /** A-06: 수료 회고. */
  | 'completion_retro'
  /** A-07: 동문회·OB 방 항목(명부 항목·일정·투표·앨범 사진·방별 프로필). */
  | 'room_item'
  /** E-04: 막힘 Q&A 스레드의 글 하나(질문·답변). */
  | 'stuck_qa_post'
/** A-07: 신고할 수 있는 방 항목 종류(@peerchive/domain ROOM_ITEM_KINDS). */
export type RoomItemKind = 'directory_entry' | 'event' | 'poll' | 'album_photo' | 'room_profile'
/** impersonation(표시명 사칭, S-07)은 프로필 신고에만. affiliation_impersonation(소속·기수 사칭, A-07)은 커뮤니티 글·댓글·수료 회고·명부 항목·방별 프로필에만. */
export type ReportReason =
  | 'personal_info'
  | 'answer_sharing'
  | 'copyright'
  | 'harassment'
  | 'false_claim'
  | 'spam'
  | 'other'
  | 'impersonation'
  | 'affiliation_impersonation'
export type ReportStatus = 'open' | 'in_review' | 'resolved' | 'dismissed'
export type ModerationActionKind =
  | 'none'
  | 'restrict'
  | 'hide_item'
  | 'hide_note'
  | 'hide_case_study'
  | 'hide_profile'
  | 'restrict_space'
  | 'archive_space'
  | 'hide_post'
  | 'hide_comment'
  /** C-06: 방 운영진의 글·댓글 가리기(자기 공간, 되돌릴 수 있음). */
  | 'space_hide'
  /** C-06: 운영자의 이용 제한(제재) 발급. */
  | 'sanction'
  /** C-07: 모집 글 가리기·지원 메시지 가리기. */
  | 'hide_recruitment'
  | 'hide_application'
  /** C-09: 막힘 Q&A 숨기기. */
  | 'hide_qa'
  /** S-07: 페르소나 하나의 공개 프로필·프로필 글·소셜 링크 숨기기. */
  | 'hide_persona'
  | 'hide_profile_post'
  | 'hide_social_link'
  /** A-06: 수료 회고 숨기기. */
  | 'hide_retro'
  /** A-07: 방 항목 하나 숨기기. */
  | 'hide_room_item'
  /** E-04: 막힘 Q&A 글 하나 숨기기. */
  | 'hide_stuck_qa_post'
export type HiddenItemKind = 'log' | 'claim' | 'artifact'
export type AppealStatus = 'open' | 'upheld' | 'reversed'

/** 신고 대상 지정(공개 화면에서 보이는 값만: slug·스냅샷 키·노트 id·handle·대표 케이스 앵커). */
export type ReportTargetRef =
  | { slug: string }
  | { slug: string; kind: HiddenItemKind; key: string }
  | { noteId: string }
  | { handle: string; anchor: string }
  | { handle: string }
  /** 커뮤니티 공간(C-02): 공간 주소. 신고자가 읽을 수 있거나 소개를 볼 수 있는 공간만. */
  | { spaceSlug: string }
  /** 커뮤니티 글·댓글(C-04): 신고자가 읽을 수 있는 게시 중인 것만. */
  | { postId: string }
  | { commentId: string }
  /** 모집 글(C-07): 볼 수 있는 가려지지 않은 모집. 지원 메시지: 그 모집의 모집자만. */
  | { recruitmentId: string }
  | { applicationId: string }
  /** 막힘 Q&A(C-09): 게시 중인 것만. */
  | { qaId: string }
  /** 프로필 글(S-07): 활동 목록·피드의 활동 id(글 id는 공개되지 않음). 신고자가 지금 볼 수 있는 글만. */
  | { activityId: string }
  /** 소셜 링크(S-07): 그 프로필의 handle과 공개 화면에 보이는 주소. */
  | { handle: string; url: string }
  /** 수료 회고(A-06): 신고자가 읽을 수 있는 게시 중인 회고. */
  | { retroId: string }
  /** 방 항목(A-07): 그 방 active 멤버가 지금 보는 숨기지 않은 항목. */
  | { spaceSlug: string; kind: RoomItemKind; itemId: string }
  /** 막힘 Q&A 글(E-04): 지금 보이는 스레드의 게시 중인 질문·답변. */
  | { stuckQaPostId: string }

export interface HiddenItemPlaceholderDto {
  kind: HiddenItemKind
  key: string
  /** 원래 목록 안의 위치. */
  index: number
}

/** POST /reports 응답. 같은 대상의 처리 전 신고가 이미 있으면 그것(created: false, 200). */
export interface ReportReceiptDto {
  id: string
  status: 'received' | 'in_review' | 'resolved' | 'dismissed'
  created: boolean
  createdAt: string
}

/** GET /me/reports 한 줄. 신고자에게는 상태만 보여 주고 어떤 조치를 했는지는 싣지 않습니다. */
export interface MyReportDto {
  id: string
  targetType: ReportTargetType
  targetLabel: string
  reason: ReportReason
  status: 'received' | 'in_review' | 'resolved' | 'dismissed'
  createdAt: string
  closedAt: string | null
}

/** 당사자(공개 owner·작성자·프로필 주인)에게 보여 주는 운영 조치 안내. 내부 메모는 없습니다. */
export interface ModerationNoticeDto {
  actionId: string
  kind: Exclude<ModerationActionKind, 'none'>
  targetType: ReportTargetType
  targetLabel: string
  /** 당사자가 고칠 곳(비공개 화면 경로). */
  ownerPath: string | null
  /** hide_item이면 가린 항목(당사자 화면용 짧은 글). */
  item: { kind: HiddenItemKind; key: string; label: string } | null
  publicReason: string | null
  /** 이용 제한(kind sanction, C-06)이면 수준·범위·공간 이름·기한·지금 효력. 누가 요청·확인했는지는 없습니다. */
  sanction: { level: SanctionLevel; scope: SanctionScope; spaceName: string | null; until: string | null; active: boolean } | null
  createdAt: string
  reversedAt: string | null
  appeal: { status: AppealStatus; createdAt: string; decidedAt: string | null } | null
  canAppeal: boolean
}

/** POST /appeals 응답. */
export interface AppealDto {
  id: string
  actionId: string
  status: AppealStatus
  createdAt: string
}

/** 운영자 대기열: 대상별 묶음(같은 대상의 신고들). */
export interface OperatorReportGroupDto {
  /** 묶음에서 가장 먼저 들어온 신고(상세 화면 id). */
  reportId: string
  targetType: ReportTargetType
  targetLabel: string
  count: number
  reasons: Partial<Record<ReportReason, number>>
  firstReportedAt: string
  lastReportedAt: string
  status: ReportStatus
  assignee: { userId: string; displayName: string } | null
  hold: boolean
  /** 신고 누적으로 임시 숨김된 커뮤니티 글·댓글(C-06, 우선 검토로 맨 앞). */
  autoHidden: boolean
  /** 처리 기한(C-10, ADR 0027). 처리 전 묶음은 지금까지, 끝난 묶음은 처리 시각까지. */
  sla: ReportSlaDto
  /** 과목 큐레이터의 1차 검토 의견이 이 묶음의 신고에 있는지(E-03, ADR 0048). */
  curatorRecommended: boolean
}

export type ReportSlaState = 'ok' | 'due_soon' | 'overdue'

export interface ReportSlaDto {
  /** auto_hidden: 임시 숨김 시각부터 우선 검토 기한, normal: 첫 신고부터. */
  priority: 'auto_hidden' | 'normal'
  startedAt: string
  dueAt: string
  targetHours: number
  ageSeconds: number
  state: ReportSlaState
  /** 첫 신고 → 첫 처리(배정·처리)까지 초. 아직 없으면 null. */
  firstActionSeconds: number | null
  /** 첫 신고 → 처리 완료까지 초(처리 전 null). */
  resolutionSeconds: number | null
}

export interface OperatorReportDto {
  id: string
  reason: ReportReason
  details: string | null
  status: ReportStatus
  createdAt: string
  closedAt: string | null
}

export interface OperatorActionDto {
  id: string
  kind: ModerationActionKind
  outcome: 'resolved' | 'dismissed'
  internalNote: string
  publicReason: string | null
  notifyOwner: boolean
  createdAt: string
  createdBy: string
  reversedAt: string | null
  reverseCause: 'lift' | 'appeal' | 'space' | null
  reverseNote: string | null
  appeal: { id: string; status: AppealStatus; message: string; createdAt: string; decisionNote: string | null } | null
}

/**
 * 운영자가 보는 신고 대상의 공개 내용. 공개됐던 것만: 신고 때의 release 스냅샷 / 신고 때 버전이 그대로인 게시된(또는 숨긴) 노트·케이스 글 /
 * 공개 프로필 필드. 비공개 과제 공간·초안은 싣지 않습니다.
 */
export type OperatorTargetContentDto =
  | { kind: 'release'; releaseVersion: number; snapshot: PublicSnapshot; focus: { kind: HiddenItemKind; key: string } | null; hiddenKeys: string[] }
  | { kind: 'senior_note'; note: PublicSeniorNoteDto }
  | { kind: 'case_study'; title: string; sections: Array<{ key: string; label: string; sentences: Array<{ text: string; citations: string[] }> }> }
  | { kind: 'profile'; profile: Omit<PublicProfileDto, 'kind' | 'linkedPersona'> }
  /** 커뮤니티 공간(C-02): 이름·소개·종류·상태·멤버 수만. 게시판 글·멤버 목록은 운영자에게도 싣지 않습니다. */
  | { kind: 'community_space'; space: OperatorSpaceDto }
  | { kind: 'community_post' | 'community_comment'; item: OperatorCommunityItemDto }
  /** 모집 글·지원 메시지(C-07) 하나만. 모집자·지원자 id와 지원자 목록은 운영자에게도 싣지 않습니다. */
  | { kind: 'community_recruitment' | 'community_application'; recruitmentItem: OperatorRecruitmentItemDto }
  /** 막힘 Q&A(C-09): 공개된 복사본 그대로(당사자 id 없음). */
  | { kind: 'course_qa'; qa: PublicCourseQaDto; status: CourseQaStatus }
  /**
   * 페르소나·프로필 글·소셜 링크(S-07): **신고된 페르소나 자신의** handle·이름·내용만. 같은 사람의 다른 페르소나·계정·연결은 싣지 않습니다
   * (주인 확인은 사유를 남기는 별도 절차 `POST /operator/persona-owner-lookups`).
   */
  | { kind: 'persona'; persona: OperatorPersonaDto }
  | { kind: 'profile_post'; persona: OperatorPersonaRefDto; post: { body: string; status: 'published' | 'deleted' | 'hidden'; createdAt: string } }
  | { kind: 'social_link'; persona: OperatorPersonaRefDto; link: { provider: SocialLinkProvider; url: string; verification: SocialLinkVerification; hidden: boolean } }
  /** 수료 회고(A-06): 읽는 사람이 보는 것과 같은 회고 하나(작성자 id 없음). */
  | { kind: 'completion_retro'; retro: CompletionRetroDto; status: CompletionRetroStatus }
  /** 방 항목(A-07): 그 항목 하나. 만든 사람·올린 사람의 id·이름은 싣지 않습니다(명부·방별 프로필은 방 멤버에게 보이는 이름만). */
  | { kind: 'room_item'; roomItem: OperatorRoomItemDto }
  /** 막힘 Q&A 글(E-04): 스레드에 보이는 표시와 본문(숨긴 것도 내용 포함). 작성자는 싣지 않습니다(작성자 확인은 신고에 묶인 별도 요청). */
  | { kind: 'stuck_qa_post'; post: StuckQaModerationPostDto }
  | { kind: 'unavailable'; message: string }

/** A-07: 운영자 신고 상세의 방 항목. 방 이름·지금 이름 표시 방식과 항목 값만. */
export interface OperatorRoomItemDto {
  itemKind: RoomItemKind
  space: { name: string; slug: string; nameMode: 'real' | 'display' | 'anonymous' | 'affiliated_anonymous' }
  hidden: boolean
  /** 명부 항목·방별 프로필: 방 멤버에게 보이는 이름(실명 방은 실명, 표시명 방은 방별 이름). 그 밖은 null. */
  name: string | null
  fields: Array<{ label: string; value: string }>
  /** 앨범 사진: 운영자에게만 맞는 짧은 서명 URL(검사 통과한 사진만). */
  photoUrl: string | null
}

/** 운영자 화면의 페르소나 이름표(S-07): 그 페르소나 자신의 값만. */
export interface OperatorPersonaRefDto {
  kind: PersonaKind
  handle: string
  displayName: string
  /** 운영 조치로 숨김. */
  hidden: boolean
}

/** 운영자 화면의 신고된 페르소나 프로필(공개 프로필 필드 + 숨긴 것 포함 소셜 링크). 연결·다른 페르소나·계정 id 없음. */
export interface OperatorPersonaDto extends OperatorPersonaRefDto {
  headline: string | null
  jobTargets: string[]
  schoolLabel: string | null
  gradTerm: string | null
  socialLinks: Array<{ provider: SocialLinkProvider; url: string; verified: boolean; hidden: boolean }>
}

/**
 * POST /operator/persona-owner-lookups {reportId, reason} — 페르소나 주인 확인(S-07, ADR 0036). 사유를 남기고 감사(id만)한 뒤에만 이 응답에 주인을 싣습니다.
 * 저장된 목록·신고 상세 어디에도 다시 나오지 않습니다.
 */
export interface PersonaOwnerLookupResultDto {
  lookupId: string
  owner: {
    /** 계정 내부 id(계정 단위 조치 — 정지 등 — 를 운영 절차로 할 때 씀). */
    userId: string
    accountStatus: 'active' | 'suspended' | 'deleted'
    /** 그 사람의 페르소나 전부(공개 상태와 무관, 숨김 표시). */
    personas: OperatorPersonaRefDto[]
    /** 본인이 두 페르소나 연결을 공개했는지. */
    linkVisible: boolean
    /** 그 사람의 모든 페르소나·글·링크·실명 프로필에 걸린 되돌리지 않은 숨김 조치 수. */
    activeActions: number
  }
}

export interface OperatorReportDetailDto {
  report: OperatorReportDto
  targetType: ReportTargetType
  targetLabel: string
  /** 지금 공개 경로(공개 중일 때만). */
  publicPath: string | null
  /** 지금도 공개로 제공 중인지. */
  servedNow: boolean
  /** 공개 사례면 지금 공개 상태(제한 해제 버튼용). */
  publication: { id: string; status: PublicationStatus } | null
  content: OperatorTargetContentDto
  /** 같은 대상의 모든 신고(최근 것부터). 신고자 신원은 싣지 않습니다. */
  reports: OperatorReportDto[]
  assignee: { userId: string; displayName: string } | null
  holds: Array<{ reason: ReportReason; createdAt: string; releasedAt: string | null }>
  actions: OperatorActionDto[]
  allowedActions: ModerationActionKind[]
  /** 과목 큐레이터의 1차 검토 의견(E-03, ADR 0048). 같은 대상의 의견 전부(최근 것부터). 처리는 운영자가 합니다. */
  curatorRecommendations: OperatorCuratorRecommendationDto[]
}

export interface OperatorAppealDto {
  id: string
  status: AppealStatus
  message: string
  createdAt: string
  decidedAt: string | null
  decisionNote: string | null
  action: { id: string; kind: ModerationActionKind; targetType: ReportTargetType; targetLabel: string; publicReason: string | null; internalNote: string; createdAt: string; reversedAt: string | null }
  /** 그 조치로 처리한 신고 하나(상세 화면 링크). */
  reportId: string | null
}

export interface OperatorAuditEventDto {
  id: string
  actorId: string | null
  action: string
  targetType: string
  targetId: string | null
  metadata: Record<string, unknown>
  at: string
}

// ── 운영: pilot 지표·상태 확인 (T-16, ADR 0016) ─────────────────────────────

export interface RateMetricDto {
  denominator: number | null
  numerator: number | null
  rate: number | null
}

/** GET /api/v1/operator/metrics. 5 미만인 값은 null(가림). @peerchive/domain PilotMetrics와 같은 모양 + 안내. */
export interface OperatorMetricsDto {
  from: string
  to: string
  minGroup: number
  activation: RateMetricDto
  retention: RateMetricDto
  caseConversion: RateMetricDto
  northStar: { planForks: number | null; helpedMarks: number | null; total: number | null }
  reportExports: { exports: number | null; projects: number | null }
  portfolioSharers: number | null
  seniorNotesPublished: number | null
  writeTimeMedianMinutes: null
  eventCounts: Record<string, number | null>
  /** 공개 프로필·팔로우 지표(S-07, DELIVERY_PLAN §6.2). @peerchive/domain ProfileMetrics와 같은 모양, 5 미만 null. */
  profile: OperatorProfileMetricsDto
  generatedAt: string
  notes: string[]
}

export interface OperatorProfileMetricsDto {
  feedUsers: number | null
  followToRecord: RateMetricDto
  feedComposition: RateMetricDto
  displayAdoption: RateMetricDto
  identityLink: { turnedOn: number | null; turnedOff: number | null }
  impersonation: { reports: number | null; confirmed: number | null }
  reportsByTarget: { persona: number | null; profilePost: number | null; socialLink: number | null; legacyProfile: number | null }
  socialLinksVerified: { events: number | null; users: number | null }
  relationRemovals: { blocks: number | null; mutes: number | null; followerRemovals: number | null; activeFollows: number | null; per1000Follows: number | null }
  follows: { requested: number | null; pending: number | null; approved: number | null; fromSuggestions: number | null }
  followerCountShown: RateMetricDto
  settings: { visibilityChanged: number | null; projectListed: number | null }
  ownerLookups: number | null
}

/**
 * GET /api/v1/operator/metrics/community/p2?from=&to= — §6.2 P2 졸업생·토픽·기관 지표(A-07). 운영자만. 영역 플래그가 꺼진 칸은 null(화면에서 숨김).
 * @peerchive/domain P2Metrics와 같은 모양, 모든 칸 5 미만 null. 사람·방·기관 id는 싣지 않습니다.
 */
export interface OperatorP2MetricsDto {
  from: string
  to: string
  minGroup: number
  flags: { alumni: boolean; topics: boolean; institutions: boolean }
  generatedAt: string
  notes: string[]
  alumni: {
    alumniToNotes: RateMetricDto
    supply: number | null
    activeRooms: RateMetricDto
    rsvpRate: RateMetricDto
    directoryConsent: RateMetricDto
    events: {
      alumniRoomsCreated: number | null
      cohortRoomsCreated: number | null
      eventsCreated: number | null
      rsvps: number | null
      directoryConsents: number | null
      directoryWithdrawals: number | null
    }
    reportsByKind: Record<RoomItemKind, number | null>
    hiddenConfirmed: number | null
  } | null
  topics: {
    topicToNote: RateMetricDto
    broadened: RateMetricDto
    postsByScope: { institution: number | null; institutionKind: number | null; none: number | null }
    impersonation: { reports: number | null; confirmed: number | null }
  } | null
  institutions: {
    verifiedByMethod: { invite_code: number | null; cohort_approval: number | null; certificate_check: number | null }
    certificate: CertificateDecisionSummaryDto
    impersonation: { revokedByOperator: number | null; reports: number | null; confirmed: number | null }
    retrosPublished: number | null
    cohortRoomSupply: null
  } | null
}

/** 수료증 처리 시간(받은 시각 → 결정 시각) 요약. 표본 5 미만이면 중앙값·p90 null. */
export interface CertificateDecisionSummaryDto {
  decided: number | null
  medianHours: number | null
  p90Hours: number | null
  withinSla: RateMetricDto
  slaHours: number
  medianTargetHours: number
}

/**
 * GET /api/v1/operator/institutions/verification-queue(A-07) — 인증 수단별 처리 큐. 운영자만, institutions 플래그가 꺼지면 404.
 * 초대 코드는 즉시 인증이라 대기 건이 없고 기간 안 사용 수만, 기수 승인은 승인 대기(운영자가 처리하지 않음 — 나이·만료만), 수료증 확인은 운영자 대기(기한·나이).
 */
export interface VerificationQueueDto {
  generatedAt: string
  inviteCode: { instant: true; redeemedLast7Days: number | null; activeCodes: number }
  cohortApproval: {
    slaHours: null
    pending: Array<{ affiliationId: string; institutionName: string; cohortLabel: string | null; approvals: number; required: number; requestedAt: string; ageHours: number; expiresAt: string }>
  }
  certificateCheck: {
    slaHours: number
    pending: Array<{
      checkId: string
      institutionName: string
      cohortLabel: string | null
      /** 파일을 받은 시각(처리 시간의 시작). 아직 안 받았으면 null(운영자 대기가 아님). */
      receivedAt: string | null
      scanStatus: 'pending' | 'scanning' | 'clean' | 'quarantined' | 'failed'
      ageHours: number | null
      dueAt: string | null
      sla: 'ok' | 'due_soon' | 'overdue' | null
    }>
    /** 최근 30일 결정의 처리 시간(받은 시각 → 결정 시각). */
    recent: CertificateDecisionSummaryDto
  }
}

export type HealthCheckStatus = 'ok' | 'error' | 'stale' | 'missing'

/** GET /api/v1/health?deep=1(운영자만). 개수·시각·상태 코드만. */
export interface DeepHealthDto {
  status: 'ok' | 'degraded'
  checkedAt: string
  flags: { maintenance: boolean; publicReadsDisabled: boolean }
  db: { status: HealthCheckStatus; latencyMs: number | null }
  storage: { status: HealthCheckStatus; driver: string; latencyMs: number | null }
  worker: { status: HealthCheckStatus; lastBeatAt: string | null; ageSeconds: number | null; startedAt: string | null }
  tasks: Array<{ name: string; lastRunAt: string; status: string; affected: number | null }>
  outbox: { backlog: number; oldestAgeSeconds: number | null }
  jobs: { failed: Record<string, number>; deadLetter: Record<string, number>; available: boolean }
  deletion: { overdue: number; graceDays: number }
  /** 신고 처리 기한(C-10): 처리 전 묶음 수·기한 넘김 수(임시 숨김 따로)·가장 오래된 처리 전 묶음의 나이. 개수만(내용·id 없음). */
  reports: { open: number; overdue: number; overdueAutoHidden: number; oldestOpenAgeSeconds: number | null; targets: { autoHiddenHours: number; normalHours: number } }
}

// ── 커뮤니티 운영 지표·주간 운영 시간 (C-10, ADR 0027) ─────────────────────

export type OpsTimeCategory = 'reports' | 'official_pages' | 'affiliation_support' | 'curation' | 'other'

/** 내 주간 운영 시간 한 주(본인에게만). */
export interface OpsTimeEntryDto {
  week: string
  /** 그 주의 서울 날짜(월~일). */
  from: string
  to: string
  minutes: Record<OpsTimeCategory, number>
  total: number
  note: string | null
  updatedAt: string
}

/** GET /api/v1/operator/ops-time — 이번 주와 기록 목록(최근 12주, 본인 것만). */
export interface MyOpsTimeDto {
  currentWeek: string
  entries: OpsTimeEntryDto[]
}

export interface NotAvailableMetricDto {
  value: null
  reason: string
}

type Counts<K extends string> = Record<K, number | null>

/** GET /api/v1/operator/metrics/community. 모든 칸 5 미만 null(가림). id·이름·글 없음. */
export interface CommunityMetricsDto {
  from: string
  to: string
  minGroup: number
  activity: { weeklyActive: Array<{ week: string; users: number | null }>; keyedEvents: number | null; unkeyedEvents: number | null }
  writing: {
    posts: number | null
    comments: number | null
    postsByBoard: Counts<BoardKind>
    postsByMode: Counts<RoomNameMode>
    commentsByMode: Counts<RoomNameMode>
    anonymousShare: RateMetricDto
    namedShare: RateMetricDto
  }
  moderation: {
    reportsFiled: number | null
    communityReportsFiled: number | null
    reportsPer100Posts: number | null
    reportsPer1000Posts: number | null
    casesClosed: number | null
    medianFirstActionHours: number | null
    medianResolutionHours: number | null
    medianAutoHiddenResolutionHours: number | null
    slaMet: RateMetricDto
    autoHideRate: RateMetricDto
    restoreRate: RateMetricDto
    sanctionsByLevel: Counts<'warning' | 'write_suspended' | 'permanent'>
    authorLookups: number | null
    authorLookupsLinked: RateMetricDto
    openCases: number | null
    overdueCases: number | null
    overdueAutoHidden: number | null
  }
  conversion: {
    transfers: Record<'course_qa' | 'stuck_log' | 'senior_note', { requested: number | null; completed: number | null; rate: number | null }>
    questionToStuck: RateMetricDto
    studyRecordsEnabled: number | null
    studyRecordConversion: RateMetricDto
    studyPublished: RateMetricDto
    recruitmentsCreated: Counts<'team' | 'study'>
    recruitmentsClosed: Counts<'project' | 'study_room' | 'cancelled'>
    recruitmentFillRate: RateMetricDto
  }
  opsTime: { weeks: Array<{ week: string; minutes: Counts<OpsTimeCategory>; total: number | null; operators: number | null }>; totalMinutes: number | null }
  notAvailable: Record<'archiveInflow' | 'revisit' | 'writeTime' | 'studyToSeniorNote', NotAvailableMetricDto>
  slaTargets: { autoHiddenHours: number; normalHours: number }
  /** 운영자가 고른 공간 하나(active 멤버 N 이상일 때만). 공간 이름·id는 싣지 않습니다(종류만). */
  space: CommunitySpaceBreakdownDto | null
  generatedAt: string
  notes: string[]
}

export interface CommunitySpaceBreakdownDto {
  kind: SpaceKind
  minMembers: number
  postsByBoard: Counts<BoardKind>
  postsByMode: Counts<RoomNameMode>
  commentsByMode: Counts<RoomNameMode>
  anonymousShare: RateMetricDto
  namedWriters: number | null
  reportCases: number | null
  autoHidden: number | null
}

/** GET /api/v1/operator/metrics/community/spaces — 공간별 보기를 고를 수 있는 공간(active 멤버 N 이상). 운영자 화면의 선택 목록용. */
export interface CommunityMetricsSpaceOptionDto {
  id: string
  name: string
  kind: SpaceKind
}

// ── 캠퍼스 커뮤니티: 공간·게시판·멤버십 (C-02, ADR 0019) ──────────────────

/** topic: 학교를 넘나드는 토픽(A-05, ADR 0042, 운영자만 만듦). */
export type SpaceKind = 'official_school' | 'official_department' | 'user_room' | 'study_room' | 'topic'
/** affiliated_anonymous: 1단계 소속 표시 익명(A-05, 토픽 글·댓글에만). 방이 고를 수 있는 방식은 RoomNameMode. */
export type NameMode = 'real' | 'display' | 'anonymous' | 'affiliated_anonymous'
export type RoomNameMode = Exclude<NameMode, 'affiliated_anonymous'>
/** 사용자 방 템플릿(A-01, ADR 0038). P2 alumni 플래그가 꺼져 있으면 응답은 항상 general입니다. */
export type SpaceTemplate = 'general' | 'alumni'
export type SpaceDiscovery = 'listed' | 'unlisted'
export type JoinPolicy = 'open' | 'approval' | 'invite'
export type SpaceStatus = 'active' | 'archived' | 'restricted'
export type SpaceRole = 'owner' | 'admin' | 'moderator' | 'member'
export type SpaceMembershipStatus = 'pending' | 'active' | 'left' | 'removed'
export type BoardKind = 'free' | 'freshmen' | 'alumni' | 'question' | 'info' | 'recruiting' | 'notice' | 'general'
export type BoardWriteRole = 'member' | 'moderator'

/** 공간 목록 한 줄(내 공간·찾기). 멤버 수는 사용자 방만(공식 페이지는 학교 인증 구성원 전체라 세지 않음). */
export interface SpaceSummaryDto {
  slug: string
  kind: SpaceKind
  /** `공식` 배지: official_* 종류에만 true. */
  official: boolean
  name: string
  description: string | null
  school: { id: string; name: string } | null
  departmentLabel: string | null
  nameMode: NameMode
  template: SpaceTemplate
  discovery: SpaceDiscovery
  joinPolicy: JoinPolicy
  status: SpaceStatus
  memberCount: number | null
  /** 내 멤버십(없으면 null). 공식 페이지는 모더레이터일 때만. */
  myMembership: { role: SpaceRole; status: SpaceMembershipStatus } | null
  /**
   * 기관 공간(I-02, ADR 0044): `page`는 대학이 아닌 기관의 공식 페이지(기관 페이지), `cohort_room`은 기관 기수 방. 그 밖은 null.
   * 기관 공간에서는 그 기관 운영진이 운영 조치를 위해 읽을 수 있습니다(화면 안내).
   */
  institutionSpace: 'page' | 'cohort_room' | null
}

export interface MySpacesDto {
  /** 내가 active 멤버인 방 + 내 학교의 공식 페이지. */
  items: SpaceSummaryDto[]
  /** 승인 대기 중인 방. */
  pending: SpaceSummaryDto[]
  /** 방을 만들 수 있는지(active 학교 인증 하나 이상). */
  canCreateRoom: boolean
  /** 내 active 학교 인증(방 학교 연결·개설 요청 선택지). 학과는 본인 것이라 함께 보냄. */
  schools: Array<{ id: string; name: string; departmentLabel: string | null }>
  /** 읽지 않은 커뮤니티 알림 수(C-03). */
  unreadNotices: number
}

export interface BoardDto {
  id: string
  kind: BoardKind
  title: string
  writeRole: BoardWriteRole
  position: number
  /** 지금 이 사람이 이 게시판에 쓸 자격이 있는지(canWriteBoard). 글쓰기 자체는 C-04. */
  canWrite: boolean
}

export interface SpacePermissionsDto {
  manage: boolean
  manageBoards: boolean
  reviewRequests: boolean
  removeMembers: boolean
  invite: boolean
  changeRoles: boolean
  archive: boolean
  moderate: boolean
  /** 이름 표시 방식 변경 예약·취소(C-03): 사용자 방·스터디 방의 방장만. */
  changeNameMode: boolean
}

/**
 * GET /community/spaces/:slug. access 'member'이면 게시판·권한까지, 'preview'이면 소개만(멤버가 아닌 사람에게 가입 버튼용).
 * 이름 표시 방식(nameMode)은 지금 효력이 있는 값(글쓰기 화면이 항상 보여 줄 값, effective_at이 지난 예약 포함)이고,
 * pendingNameModeChange는 아직 효력이 없는 예약입니다(멤버·소개 모두에 보여 배너로 안내, C-03).
 */
export interface SpaceDetailDto extends SpaceSummaryDto {
  pendingNameModeChange: PendingNameModeChangeDto | null
  /**
   * member: 공간을 읽음 / preview: 소개만 / alumni_history: 졸업생 인증 이력으로 공식 학교 페이지의 졸업생·자유(공감 라운지) 게시판만 읽음
   * (A-04, ADR 0041 — 쓰기·공감 없음, 다른 게시판은 목록에도 없음).
   */
  access: 'member' | 'preview' | 'alumni_history'
  boards: BoardDto[]
  permissions: SpacePermissionsDto
  /** 가입 버튼: join(바로 가입) / request(승인 요청) / pending(대기 중) / none. */
  joinAction: 'join' | 'request' | 'pending' | 'none'
  capacity: number | null
  capacityRequested: number | null
  createdAt: string
}

export interface SpaceMemberDto {
  userId: string
  displayName: string
  handle: string | null
  role: SpaceRole
  status: SpaceMembershipStatus
  joinedAt: string | null
  requestedAt: string | null
}

export interface SpaceMembersDto {
  members: SpaceMemberDto[]
  pending: SpaceMemberDto[]
}

export interface SpaceInvitationDto {
  id: string
  status: 'pending' | 'used' | 'expired' | 'revoked'
  expiresAt: string
  createdAt: string
  usedAt: string | null
  revokedAt: string | null
}

/** POST /community/invitations/preview: 초대받은 사람이 보는 방 소개. 유효하지 않으면 410. */
export interface SpaceInvitationPreviewDto {
  space: Pick<SpaceSummaryDto, 'slug' | 'kind' | 'name' | 'description' | 'nameMode' | 'school'>
  expiresAt: string
  /** 이 사람이 수락할 수 있는지(학교 자격·정원). */
  acceptable: boolean
  reason: 'ok' | 'already_member' | 'not_eligible' | 'full'
}

/**
 * 스터디 기록 상태(C-08, ADR 0026). 방을 읽을 수 있는 사람에게. 과제 id는 그 기록(과제)의 active 멤버에게만 실립니다.
 * portfolioLinkable: 지금 방 방식으로 공개하면 포트폴리오(케이스 스터디)에 연결할 수 있는지(익명 방이면 false). 판정은 공개 후보를 만들 때 고정됩니다.
 */
export interface StudyRecordStateDto {
  /** 스터디 방인지(사용자 방·공식 페이지는 false). */
  available: boolean
  enabled: boolean
  projectId: string | null
  myRole: ProjectRole | null
  /** 방장이고 기록이 아직 꺼져 있고 방이 active일 때. */
  canEnable: boolean
  nameMode: 'real' | 'display' | 'anonymous'
  portfolioLinkable: boolean
}

export interface JoinResultDto {
  status: 'active' | 'pending'
  space: SpaceSummaryDto
}

/** 내 공식 페이지 개설 요청. 요청 수는 운영자에게만 보입니다. */
export interface OfficialPageRequestDto {
  id: string
  school: { id: string; name: string }
  departmentLabel: string | null
  createdAt: string
}

/** 운영자: 개설 요청 묶음(학교·학과별). */
export interface OperatorOfficialRequestGroupDto {
  school: { id: string; name: string }
  departmentLabel: string | null
  departmentKey: string
  /** 서로 다른 요청자 중 지금 그 학교 인증이 active인 수. */
  requesters: number
  studentCouncil: boolean
  thresholdReached: boolean
  /** 이미 열린 공식 페이지(있으면). */
  existingSpaceSlug: string | null
  firstRequestedAt: string
  lastRequestedAt: string
  /** 학생회 표시용 요청 id(가장 최근 것). */
  latestRequestId: string
}

/** 운영자가 보는 공간 정보(내용 없음). */
export interface OperatorSpaceDto {
  id: string
  slug: string
  kind: SpaceKind
  name: string
  description: string | null
  school: { id: string; name: string } | null
  departmentLabel: string | null
  status: SpaceStatus
  nameMode: NameMode
  joinPolicy: JoinPolicy
  discovery: SpaceDiscovery
  memberCount: number
  capacity: number
  capacityRequested: number | null
  createdAt: string
}

// ── 이름 표시 방식 변경·커뮤니티 알림 (C-03, ADR 0020) ──────────────────

export type NameModeChangeStatus = 'scheduled' | 'applied' | 'cancelled'

/** 아직 효력이 없는 예약(배너용). 요청한 사람은 싣지 않습니다(방장만 예약할 수 있음). */
export interface PendingNameModeChangeDto {
  id: string
  fromMode: NameMode
  toMode: NameMode
  requestedAt: string
  effectiveAt: string
}

export interface NameModeChangeDto extends PendingNameModeChangeDto {
  status: NameModeChangeStatus
  appliedAt: string | null
  cancelledAt: string | null
  /** 실명으로 바꾸며 자유 가입을 방장 승인으로 바꿨는지. */
  joinPolicyAdjusted: boolean
}

/** GET /community/spaces/:slug/name-mode-changes — 읽을 수 있는 사람(멤버·공식 페이지는 학교 인증)에게. */
export interface NameModeStateDto {
  /** 지금 효력이 있는 방식. */
  currentMode: NameMode
  /** 공식 페이지: 바꿀 수 없음(anonymous 고정). */
  fixed: boolean
  canChange: boolean
  pending: PendingNameModeChangeDto | null
  /** 최근 것부터 최대 50개. */
  history: NameModeChangeDto[]
}

export type CommunityNoticeKind =
  | 'name_mode_scheduled'
  | 'name_mode_cancelled'
  | 'name_mode_applied'
  | 'post_commented'
  | 'item_auto_hidden'
  | 'item_restored'
  | 'recruitment_invited'
  | 'recruitment_not_selected'
  | 'recruitment_cancelled'

export interface NameModeNoticeDto {
  id: string
  kind: 'name_mode_scheduled' | 'name_mode_cancelled' | 'name_mode_applied'
  /** 지금도 읽을 수 있는 공간이면 이름·주소, 나갔거나 내보내졌으면 null. */
  space: { slug: string; name: string } | null
  fromMode: NameMode
  toMode: NameMode
  effectiveAt: string
  joinPolicyAdjusted: boolean
  createdAt: string
  readAt: string | null
}

/** 내 글의 새 댓글(C-04). 댓글 쓴 사람·내용은 없고 개수만. 지금 읽을 수 없는 공간이면 공간·글 주소 없음. */
export interface PostCommentedNoticeDto {
  id: string
  kind: 'post_commented'
  space: { slug: string; name: string } | null
  postId: string | null
  count: number
  createdAt: string
  readAt: string | null
}

/** 내 글·댓글의 임시 숨김(신고 누적, 운영 검토 중)·복원(C-06). 신고자·신고 수·사유 없음. */
export interface ItemReviewNoticeDto {
  id: string
  kind: 'item_auto_hidden' | 'item_restored'
  space: { slug: string; name: string } | null
  postId: string | null
  target: 'post' | 'comment'
  text: string
  createdAt: string
  readAt: string | null
}

/** 모집 알림(C-07): 선정(초대 받기)·선정되지 않음(거절·마감, 사유 없음)·모집 취소. 제목·모집자는 싣지 않습니다(모집 주소만). */
export interface RecruitmentNoticeDto {
  id: string
  kind: 'recruitment_invited' | 'recruitment_not_selected' | 'recruitment_cancelled'
  space: null
  recruitmentId: string
  recruitmentKind: RecruitmentKind
  text: string
  createdAt: string
  readAt: string | null
}

/** 아카이브로 옮기기 알림(C-09): 동의 요청·끝남·취소. 누가 요청·거절했는지, 글 제목은 없습니다. 지금 읽을 수 없는 공간이면 요청 주소 없음. */
export interface ArchiveNoticeDto {
  id: string
  kind: 'archive_consent_requested' | 'archive_transfer_done' | 'archive_transfer_cancelled'
  space: { slug: string; name: string } | null
  transferId: string | null
  target: ArchiveTransferTarget
  text: string
  createdAt: string
  readAt: string | null
}

export type CommunityNoticeDto = NameModeNoticeDto | PostCommentedNoticeDto | ItemReviewNoticeDto | RecruitmentNoticeDto | ArchiveNoticeDto

export interface CommunityNoticesDto {
  items: CommunityNoticeDto[]
  unread: number
}

// ── 커뮤니티 글·댓글·공감 (C-04, ADR 0022) ──────────────────────────────

export type CommunityItemStatus = 'published' | 'deleted_by_author' | 'hidden' | 'auto_hidden'
export type CommunityTimeBucket = 'today' | 'this_week' | 'earlier'

/**
 * 작성자 표시. 사람 id·핸들·프로필 링크·별칭 id가 없습니다(방장·모더레이터·운영자에게도 같음).
 * anonymous: `글쓴이`(익명 글의 글쓴이)·`익명N`(그 스레드에서 처음 익명으로 쓴 순서). 번호는 그 스레드 안에서만 뜻이 있습니다.
 * display: 글에 작성 시점에 고정한 표시명 페르소나의 지금 이름(페르소나가 없는 예전 글은 `표시명 없음`, 계정 이름 아님, ADR 0030).
 */
export interface CommunityAuthorDto {
  kind: 'real' | 'display' | 'anonymous' | 'withdrawn'
  /** 지우거나 가린 표시명·실명 글은 null. 동문회·OB 방(A-01)의 표시명 글은 방별 이름(있으면). */
  label: string | null
  schoolVerified: boolean
  /** 내 글인지(내 응답에만 true). */
  mine: boolean
  /** 동문회·OB 방(A-01, ADR 0038)의 게시 중인 실명·표시명 글·댓글에만: 작성자의 방별 배지·기수. 익명·지운 글·다른 방에는 없음. */
  roomProfile?: RoomProfileTagDto | null
}

// ── 동문회·OB 방: 방별 프로필·신분 배지 (A-01, ADR 0038) ─────────────────

export type RoomBadge = 'current' | 'ob' | 'alumni' | 'cohort'
export type RoomStoredBadge = 'current' | 'ob' | 'alumni'

/** 이름 옆에 붙는 배지. alumniVerified는 학교 연결 방에서 그 학교 active 졸업생 인증이 있을 때만(자기 신고 아님). */
export interface RoomProfileTagDto {
  badges: RoomBadge[]
  cohortLabel: string | null
  alumniVerified: boolean
}

export interface RoomProfileDto extends RoomProfileTagDto {
  /** 방 안에서만 쓰는 프로필 id(사람 id·핸들이 아님). */
  id: string
  /** real 방은 실명(없으면 `실명 미입력`), display 방은 방별 이름. */
  name: string
  bio: string | null
  /** 내 프로필인지. */
  mine: boolean
  /** A-07: 운영 조치로 숨김(본인 프로필에만 true가 올 수 있음). */
  hidden: boolean
  updatedAt: string
}

export interface RoomProfilesDto {
  /** 지금 효력이 있는 이름 표시 방식(real이면 이름은 실명 고정). */
  nameMode: 'real' | 'display'
  /** 다른 멤버의 기수를 고칠 수 있는지(방장·운영진). */
  canEditCohort: boolean
  /** 쓸 수 있는지(보관·제한된 방은 읽기만). */
  writable: boolean
  mine: (RoomProfileDto & { displayName: string | null; storedBadges: RoomStoredBadge[] }) | null
  profiles: RoomProfileDto[]
}

export interface RoomProfileCohortChangeDto {
  id: string
  fromLabel: string | null
  toLabel: string | null
  /** 바꾼 사람: 본인·방장·운영진(subject 아님)·탈퇴 등으로 알 수 없음. */
  changedBy: 'subject' | 'manager' | 'unknown'
  /** 바꾼 사람의 이 방 프로필 이름(없으면 null). */
  changedByName: string | null
  createdAt: string
}

// ── 동문회·OB 방 모임 도구: 일정·참석·공지 읽음·투표·앨범 (A-02, ADR 0039) ─────────────

export type RoomEventRecurrence = 'none' | 'weekly' | 'monthly'
export type RoomEventStatus = 'scheduled' | 'cancelled'
export type RsvpResponse = 'going' | 'not_going' | 'maybe'

export interface RoomEventOccurrenceDto {
  /** 회차를 가리키는 서울 날짜(YYYY-MM-DD). */
  date: string
  startsAt: string
  endsAt: string | null
  /** 응답 수(참석·불참·미정). */
  counts: Record<RsvpResponse, number>
  /** 내 응답(없으면 null). */
  myResponse: RsvpResponse | null
  /** 지금 응답(새로·바꾸기)할 수 있는지: 예정된 일정이고 회차 시작 전. */
  canRespond: boolean
}

export interface RoomEventDto {
  id: string
  title: string
  description: string | null
  locationText: string | null
  startsAt: string
  endsAt: string | null
  recurrence: RoomEventRecurrence
  /** 반복이 끝나는 서울 날짜(포함). 반복이 아니면 null. */
  repeatUntil: string | null
  status: RoomEventStatus
  /** 모든 회차가 끝났는지. */
  ended: boolean
  /** 다가오는 회차(최대 4개). 모두 끝났으면 마지막 회차 하나. */
  occurrences: RoomEventOccurrenceDto[]
  createdAt: string
}

export interface RoomEventsDto {
  /** 일정을 만들고 고칠 수 있는지(방장·운영진, 방이 active). */
  canManage: boolean
  /** 응답할 수 있는 방인지(보관·제한된 방은 읽기만). */
  writable: boolean
  /** 익명 방이면 응답자 이름 없이 수만 보입니다. */
  namesHidden: boolean
  events: RoomEventDto[]
}

export interface RoomEventRespondentsDto {
  eventId: string
  date: string
  /** 익명 방이면 true(names는 빈 배열, 수만). */
  namesHidden: boolean
  groups: Record<RsvpResponse, { count: number; names: string[] }>
}

/** 공지 읽음(alumni 방의 공지 게시판 글). 누가 읽었는지는 어디에도 없습니다. */
export interface NoticeReadsDto {
  count: number
  readByMe: boolean
}

export interface RoomPollOptionDto {
  index: number
  label: string
  /** 이 선택지의 표 수(집계만). */
  count: number
}

export interface RoomPollDto {
  id: string
  question: string
  options: RoomPollOptionDto[]
  totalVotes: number
  closesAt: string
  open: boolean
  /** 내가 고른 선택지(투표하지 않았으면 null). 다른 사람의 선택은 누구에게도 없습니다. */
  myVote: number | null
  canVote: boolean
  canClose: boolean
  createdAt: string
}

export interface RoomPollsDto {
  canManage: boolean
  writable: boolean
  polls: RoomPollDto[]
}

export interface AlbumPhotoDto {
  id: string
  caption: string | null
  /** 내가 올린 사진인지(올린 사람 이름은 싣지 않음). */
  mine: boolean
  /** 검사 상태(검사 대기·격리·실패는 올린 본인에게만 보임). */
  scanStatus: ScanStatus
  /** 검사를 통과한 사진의 짧은 서명 URL(이 사람에게만 맞음). 그 밖은 null. */
  url: string | null
  urlExpiresAt: string | null
  canDelete: boolean
  createdAt: string
}

export interface AlbumDto {
  canManage: boolean
  writable: boolean
  limits: { maxBytes: number; roomPhotos: number; memberPhotos: number; types: string[] }
  photos: AlbumPhotoDto[]
}

export interface AlbumUploadDto {
  photo: AlbumPhotoDto
  /** PUT으로 파일 내용을 보낼 주소(15분 안에). */
  uploadUrl: string
}

// ── 동문회·OB 방 멤버 명부 동의 (A-03, ADR 0040) ─────────────

/** 명부 항목 하나. 사람 id·핸들·프로필 링크·항목 id가 없습니다(방 안에서 이름과 동의한 값만). */
export interface DirectoryEntryDto {
  /** A-07: 신고에 쓰는 항목 id(동의마다 새 무작위 값 — 사람 id가 아님). */
  id: string
  /** real 방은 실명(없으면 `실명 미입력`), display 방은 방별 프로필 이름(없으면 `방별 이름 없음`). */
  name: string
  cohortLabel: string | null
  currentWork: string | null
  interests: string[]
  /** 자유 글. 방 멤버 모두에게 보입니다. */
  contactMethod: string | null
  /** 내 항목인지. */
  mine: boolean
  /** A-07: 운영 조치로 숨김(본인 항목에만 true가 올 수 있음 — 다른 멤버에게는 숨긴 항목이 오지 않음). */
  hidden: boolean
  updatedAt: string
}

/** 내 명부 항목(동의하지 않았으면 null). */
export interface MyDirectoryEntryDto {
  entry: DirectoryEntryDto | null
}

/** GET …/directory?page=&pageSize= — 쪽 하나(최대 20개). 전체 수·“전부 가져오기”는 없습니다. */
export interface DirectoryPageDto {
  nameMode: 'real' | 'display'
  /** 동의·바꾸기를 할 수 있는지(보관·제한된 방은 읽기와 철회만). */
  writable: boolean
  page: number
  pageSize: number
  hasNext: boolean
  mine: DirectoryEntryDto | null
  entries: DirectoryEntryDto[]
}

interface CommunityTimesDto {
  /** 정확한 시각. 소규모(멤버 10명 미만) 사용자 방의 익명 글·댓글은 null이고 createdBucket만 있습니다. */
  createdAt: string | null
  createdBucket: CommunityTimeBucket | null
  edited: boolean
  editedAt: string | null
}

export interface CommunityPostSummaryDto extends CommunityTimesDto {
  id: string
  boardId: string
  status: CommunityItemStatus
  /** 게시 중이 아니면 null(placeholder를 보여 줌). */
  title: string | null
  placeholder: string | null
  nameMode: NameMode
  author: CommunityAuthorDto
  /**
   * 소속 표시 익명(A-05) 글의 작성 시점 소속 표시(`○○대 · 졸업생`·`부트캠프 수료생`, 표시 안 함이면 null). 그 밖의 방식에는 키가 없습니다.
   * 게시 중이 아니면 null. 소속 id·회원 수는 어디에도 없습니다.
   */
  affiliationLabel?: string | null
  /** 내 글이고 소속 표시가 자동으로 넓혀졌는지(작성자 본인 응답에만 키가 있음). */
  labelBroadened?: boolean
  commentCount: number
  reactionCount: number
}

export interface CommunityCommentDto extends CommunityTimesDto {
  id: string
  parentId: string | null
  status: CommunityItemStatus
  body: string | null
  placeholder: string | null
  nameMode: NameMode
  author: CommunityAuthorDto
  /** 글과 같은 규칙(A-05): 소속 표시 익명 댓글의 작성 시점 소속 표시. */
  affiliationLabel?: string | null
  /** 내 댓글이고 소속 표시가 넓혀졌는지(작성자 본인 응답에만). */
  labelBroadened?: boolean
  version: number
  reactionCount: number
  reacted: boolean
  canEdit: boolean
  canDelete: boolean
  canReport: boolean
  canReply: boolean
  canReact: boolean
  /** 채택된 답변인지(C-09, 질문 게시판). 작성자 표시는 다른 댓글과 같습니다. */
  accepted: boolean
  /** 답글(한 단계). 답글의 replies는 항상 []. */
  replies: CommunityCommentDto[]
}

/** 글쓰기 화면이 항상 보여 줄 이름 표시 방식(§9.1). 서버가 쓰는 순간 다시 정하므로 화면 값은 안내용입니다. */
export interface CommunityComposerDto {
  canWrite: boolean
  /** 지금 쓰면 고정될 방식(공식 페이지는 기본 anonymous). */
  nameMode: NameMode
  /** 고를 수 있는 방식: 공식 페이지 anonymous·display, 사용자 방은 공간 방식 하나. */
  choices: NameMode[]
  note: string
  /** 익명일 때: 방장·모더레이터는 작성자를 볼 수 없고 운영자는 사유를 기록한 경우에만 확인한다는 안내. */
  anonymityNote: string | null
  /** 실명 방식인데 실명을 입력하지 않음(쓰기 전에 입력, 403 real_name_required). */
  realNameRequired: boolean
  /**
   * 고를 수 있는 방식에 표시명이 있는데(표시명 방, 공식 페이지의 표시명 선택) active 표시명 페르소나가 없음. 표시명으로 쓰면 403
   * display_persona_required이므로 화면이 /settings/personas에서 표시명 프로필을 만들도록 안내합니다(ADR 0030). 공식 페이지는 익명 기본이라
   * 표시명을 골랐을 때만 막힙니다.
   */
  displayPersonaRequired: boolean
  /** 이 공간에서 지금 내 쓰기를 막는 이용 제한(C-06). 본인 응답에만 있고 다른 사람에게는 항상 null입니다. */
  restriction: CommunityWriteRestrictionDto | null
  /** 토픽(A-05, ADR 0042)의 소속 표시 고르기. 토픽에만 있고, 내용은 보는 사람 자신의 소속뿐입니다. */
  affiliation?: TopicComposerAffiliationDto
}

// ── 토픽·소속 표시 익명 (A-05, ADR 0042) ─────────────────────────────────

export type AffiliationLabelScope = 'institution' | 'institution_kind' | 'none'
export type TopicCategory = 'career' | 'grad_school' | 'startup' | 'military' | 'campus_life' | 'role'

/** 내 소속 하나의 소속 표시 미리보기(작성자 본인에게만). 회원 수는 없습니다. */
export interface TopicAffiliationOptionDto {
  /** 내 소속 id(글쓰기 요청의 affiliationId). */
  affiliationId: string
  /** 고르기 화면 글자(`○○대 · 졸업생`): 내 소속이라 나에게만 보입니다. */
  title: string
  /** 범위마다 지금 쓰면 붙을 표시와 넓혀졌는지. none은 label null. */
  previews: Record<AffiliationLabelScope, { label: string | null; broadened: boolean }>
}

export interface TopicComposerAffiliationDto {
  scopes: AffiliationLabelScope[]
  defaultScope: AffiliationLabelScope
  /** 내 active 소속(최근 인증 순). 기본은 첫 번째. */
  options: TopicAffiliationOptionDto[]
  /** 넓혀졌을 때 보여 줄 안내(나에게만). */
  broadenedNote: string
}

export interface TopicSummaryDto {
  slug: string
  name: string
  description: string | null
  category: TopicCategory
  status: SpaceStatus
}

/** GET /community/topics. 활성 기관 인증이 없으면 eligible false + 빈 목록. */
export interface TopicListDto {
  eligible: boolean
  items: TopicSummaryDto[]
}

export type SanctionLevel = 'warning' | 'write_suspended' | 'permanent'
export type SanctionScope = 'community' | 'space'

export interface CommunityWriteRestrictionDto {
  level: 'write_suspended' | 'permanent'
  scope: SanctionScope
  until: string | null
  message: string
}

export interface CommunityThreadSpaceDto {
  slug: string
  name: string
  kind: SpaceKind
  official: boolean
  status: SpaceStatus
}

/** GET /community/boards/:id/posts */
export interface BoardPostsDto {
  space: CommunityThreadSpaceDto
  board: { id: string; title: string; kind: BoardKind; writeRole: BoardWriteRole }
  composer: CommunityComposerDto
  items: CommunityPostSummaryDto[]
  nextCursor: string | null
}

/** GET /community/posts/:id (글 + 댓글). 쓰기 응답도 같은 모양. */
export interface CommunityPostDto extends CommunityPostSummaryDto {
  body: string | null
  version: number
  reacted: boolean
  canEdit: boolean
  canDelete: boolean
  canReport: boolean
  canReact: boolean
  space: CommunityThreadSpaceDto
  board: { id: string; title: string; kind: BoardKind }
  /** 댓글 쓰기 안내(이 글에 댓글을 쓸 수 있는지 포함). */
  composer: CommunityComposerDto
  /** 채택된 답변(C-09, 게시 중일 때만). */
  acceptedCommentId: string | null
  /** 내가 글쓴이이고 질문 게시판의 게시 중인 글이면 true. */
  canAccept: boolean
  /** 아카이브로 옮기기(C-09). */
  archive: PostArchiveDto
  /** alumni 방 공지 게시판 글의 읽음 수(A-02). 그 밖의 글에는 없습니다. */
  noticeReads?: NoticeReadsDto
  /** 공감 라운지(공식 학교 페이지 자유 게시판) 글의 미디어(A-04, 플래그가 켜졌을 때만). 그 밖의 글에는 없습니다. */
  lounge?: LoungePostMediaDto
  /** 졸업생 인증 이력으로만 읽는 중이면 true(A-04, 쓰기·공감 없음). */
  alumniHistoryOnly?: boolean
  comments: CommunityCommentDto[]
}

// ── 공감 라운지 미디어 (A-04, ADR 0041) ───────────────────────────────

/** 라운지 글의 미디어 하나. 올린 사람 id·원래 파일 이름·저장 키가 없습니다. */
export interface LoungeMediaDto {
  id: string
  /** 내가 올린 것인지(= 내 글). */
  mine: boolean
  /** 검사 상태(검사 대기·격리·실패는 올린 본인에게만 보임). */
  scanStatus: ScanStatus
  /** 검사를 통과한 이미지의 짧은 서명 URL(이 사람에게만 맞음). 그 밖은 null. */
  url: string | null
  urlExpiresAt: string | null
  mediaType: string | null
  canDelete: boolean
  createdAt: string
}

export interface LoungePostMediaDto {
  /** 게시 중인 글이면 검사를 통과한 미디어(+ 글쓴이에게는 검사 중·실패한 것). 가린·지운 글은 빈 목록. */
  items: LoungeMediaDto[]
  /** 내 글이고 지금 더 붙일 수 있는지(쓰기 자격·게시 중·한도). */
  canAttach: boolean
  limits: { maxBytes: number; perPost: number; types: string[] }
}

export interface LoungeMediaUploadDto {
  media: LoungeMediaDto
  /** PUT으로 파일 내용을 보낼 주소(15분 안에). */
  uploadUrl: string
}

// ── 아카이브로 옮기기 (C-09, ADR 0025) ──────────────────────────────────

export type ArchiveTransferTarget = 'course_qa' | 'stuck_log' | 'senior_note'
export type ArchiveTransferStatus = 'awaiting_consent' | 'done' | 'cancelled'
export type ArchiveCancelReason =
  | 'cancelled_by_initiator'
  | 'declined'
  | 'expired'
  | 'source_unavailable'
  | 'answer_changed'
  | 'account_deleted'
  | 'target_unavailable'
export type ArchiveConsentStatus = 'pending' | 'granted' | 'declined'
export type ArchiveDisplayMode = 'anonymous' | 'display' | 'real'

/** 원 글에 붙는 옮기기 정보. 다른 사람의 요청·동의한 사람은 없습니다. */
export interface PostArchiveDto {
  /** "아카이브로 옮겨짐": 지금 공개된 복사본(게시 중인 막힘 Q&A·게시된 선배 노트)이 있음. 링크 없음. */
  archived: boolean
  /** 내가 글쓴이이고 게시 중인 글이면 true(옮길 곳별 조건은 archive-options). */
  canStart: boolean
  questionBoard: boolean
  /** 내가 요청했거나 동의를 요청받은 것만. */
  transfers: ArchiveTransferSummaryDto[]
}

export interface ArchiveTransferSummaryDto {
  id: string
  target: ArchiveTransferTarget
  status: ArchiveTransferStatus
  cancelReason: ArchiveCancelReason | null
  myRole: 'initiator' | 'party'
  /** 동의를 요청받은 사람이면 내 결정. */
  myConsent: ArchiveConsentStatus | null
  createdAt: string
}

/** GET /community/archive-transfers/:id */
export interface ArchiveTransferDto {
  id: string
  target: ArchiveTransferTarget
  status: ArchiveTransferStatus
  cancelReason: ArchiveCancelReason | null
  cancelText: string | null
  myRole: 'initiator' | 'party'
  postId: string
  course: { id: string; title: string; schoolName: string } | null
  /** 요청한 사람에게만(답한 사람에게는 null). */
  project: { id: string; title: string } | null
  includesAnswer: boolean
  expiresAt: string
  createdAt: string
  completedAt: string | null
  /** 동의를 기다리는 동안만: 옮겨질 글 그대로(요청 때 얼린 것)와 질문한 사람이 고른 이름(막힘 Q&A). */
  preview: { questionTitle: string; questionBody: string; answerBody: string | null; askerLabel: string | null } | null
  /** 공개 전 점검 경고(막힘 Q&A, 가린 표본만). 두 사람 모두에게 같습니다. */
  warnings: Array<{ rule: PublicationCheckRule; field: string; sample: string }>
  /** 동의할 때 그대로 돌려보낼 해시(동의를 기다리는 동안만). */
  contentHash: string | null
  myConsent: { status: ArchiveConsentStatus; displayMode: ArchiveDisplayMode | null; displayLabel: string | null } | null
  /** 요청한 사람에게만: 상대의 동의 상태(누구인지·고른 이름 없음). */
  counterpart: { status: ArchiveConsentStatus; text: string } | null
  /** 막힘 Q&A: 내가 고를 수 있는 이름. displayName은 내 active 표시명 페르소나의 이름(없으면 null, 계정 이름 아님, ADR 0030). */
  displayOptions: { anonymousLabel: string; displayName: string | null; realName: string | null } | null
  canDecide: boolean
  canCancel: boolean
  result: { courseQa: MyCourseQaDto | null; seniorNoteId: string | null; projectId: string | null }
}

/** GET /community/posts/:id/archive-options(글쓴이만). 옮길 곳마다 막는 이유(null이면 가능). */
export interface ArchiveOptionsDto {
  postId: string
  questionBoard: boolean
  hasAcceptedAnswer: boolean
  answerIsMine: boolean
  school: { id: string; name: string } | null
  /** comment_source(A-06): 댓글(답변)은 선배 노트로만 옮깁니다. */
  targets: Record<ArchiveTransferTarget, 'source_not_open' | 'not_author' | 'not_question_board' | 'no_accepted_answer' | 'comment_source' | null>
  projects: Array<{ id: string; title: string }>
  /** 막힘 Q&A 복사본에 고를 수 있는 표시명: 내 active 표시명 페르소나의 이름(없으면 null, 계정 이름 아님, ADR 0030). */
  displayName: string | null
  hasRealName: boolean
  lengths: { title: number; body: number; answer: number }
  limits: { stuckSymptom: number; logBody: number; solution: number; noteAnswer: number }
  timeBuckets: string[]
  /**
   * 옮길 원본(A-06): 글 또는 토픽의 내 댓글(답변). affiliated면 원본이 소속 표시 익명이라 선배 노트 표시로 "소속 표시 유지"를 고를 수 있고,
   * affiliationLabel은 원 글에 고정된 소속 표시(그대로 복사됨, 표시 안 함으로 쓴 글이면 null — 이때는 유지할 표시가 없음).
   */
  source: { kind: 'post' | 'comment'; commentId: string | null; affiliated: boolean; affiliationLabel: string | null }
}

export interface CommunityReactionDto {
  count: number
  reacted: boolean
}

/** 운영자 신고 상세의 글·댓글(지금 행, 가린 글도 본문 포함). 작성자 id 없음 — 익명 작성자 확인은 C-06의 사유 기록 경로. */
export interface OperatorCommunityItemDto {
  space: { slug: string; name: string; kind: SpaceKind }
  postId: string
  /** 댓글이면 그 댓글 id. */
  commentId: string | null
  title: string | null
  body: string | null
  status: CommunityItemStatus
  nameMode: NameMode
  /** 작성자 표시(익명은 `익명`, 표시명·실명은 그 이름). */
  authorLabel: string
  /** 소속 표시 익명(A-05)의 작성 시점 소속 표시(화면과 같은 값). 그 밖에는 키가 없습니다. */
  affiliationLabel?: string | null
  createdAt: string
  edited: boolean
}

// ── 커뮤니티 신고 누적 임시 숨김·방 운영진 도구·이용 제한·작성자 확인 (C-06, ADR 0023) ─────────────

/**
 * GET /community/spaces/:slug/moderation — 방 운영진(방장·admin·moderator, 공식 페이지 모더레이터)의 공간 운영 화면.
 * 작성자 id·핸들·이름은 어디에도 없습니다. 쓰기 제한은 이 공간 범위의 개수만.
 */
export interface SpaceModerationDto {
  space: { slug: string; name: string; kind: SpaceKind }
  /** 지금 효력이 있는 방 운영진 가리기(되돌릴 수 있음). */
  hides: Array<{ actionId: string; targetType: 'post' | 'comment'; postId: string; commentId: string | null; publicReason: string | null; createdAt: string }>
  /** 이 공간의 제재 요청(운영진 누구의 것이든). outcome은 처리됐을 때 제재가 있었는지만. */
  requests: Array<{
    id: string
    targetType: 'post' | 'comment'
    postId: string
    commentId: string | null
    reason: ReportReason
    status: 'received' | 'resolved' | 'dismissed'
    outcome: 'sanctioned' | 'no_action' | null
    mine: boolean
    createdAt: string
    closedAt: string | null
  }>
  /** 이 공간 범위로 지금 쓰기를 막는 제재 수(누구인지는 없음). */
  activeSpaceRestrictions: number
}

/** POST /community/sanction-requests 응답. 같은 사람·대상의 처리 전 요청이 있으면 그것(created false, 200). */
export interface SanctionRequestReceiptDto {
  id: string
  status: 'received' | 'resolved' | 'dismissed'
  created: boolean
  createdAt: string
}

export interface OperatorSanctionRequestDto {
  id: string
  status: 'open' | 'resolved' | 'dismissed'
  targetType: 'post' | 'comment'
  targetId: string
  reason: ReportReason
  details: string | null
  /** 요청한 방 운영진의 표시 이름(운영자에게만). */
  requestedBy: string
  createdAt: string
  closedAt: string | null
  closeNote: string | null
  /** 대상 글·댓글(작성자 id 없음, 익명은 `익명`). */
  item: OperatorCommunityItemDto | null
  sanctionIds: string[]
}

/** POST /operator/community/author-lookups 응답(201). 이 응답만 작성자를 담습니다(이메일·실명 없음). */
export interface AuthorLookupResultDto {
  lookupId: string
  targetType: 'post' | 'comment'
  targetId: string
  postId: string
  spaceId: string
  author: { userId: string; handle: string | null; status: 'active' | 'suspended' | 'deleted'; purged: boolean }
  /** 소속 표시 익명(A-05) 글·댓글이면 표시에 쓴 소속 id(운영자 전용 열, 표시 안 함·탈퇴 정리 뒤면 null). 그 밖의 방식에는 키가 없습니다. */
  affiliationId?: string | null
  /** 그 사람의 제재 이력(최근 50). */
  sanctions: OperatorSanctionDto[]
  createdAt: string
  /** 이 확인으로 제재를 발급할 수 있는 기한(같은 운영자, 24시간). */
  validUntil: string
}

/** GET /operator/community/author-lookups — 확인 기록. 확인한 작성자는 싣지 않습니다. */
export interface OperatorAuthorLookupDto {
  id: string
  operator: string
  targetType: 'post' | 'comment'
  targetId: string
  postId: string
  reason: string
  reportId: string | null
  requestId: string | null
  createdAt: string
  sanctioned: boolean
}

/** 제재(운영자 화면). 대상자(사람)는 싣지 않습니다. */
export interface OperatorSanctionDto {
  id: string
  actionId: string
  level: SanctionLevel
  scope: SanctionScope
  space: { slug: string; name: string } | null
  until: string | null
  active: boolean
  createdAt: string
  revokedAt: string | null
  issuedBy: string
  targetType: 'post' | 'comment'
  targetId: string
  postId: string
  lookupId: string
  reportId: string | null
  requestId: string | null
  internalNote: string
  publicReason: string | null
  appeal: { id: string; status: AppealStatus } | null
}

export interface OperatorSpaceHideDto {
  actionId: string
  space: { slug: string; name: string } | null
  targetType: 'post' | 'comment'
  postId: string
  commentId: string | null
  publicReason: string | null
  internalNote: string
  createdBy: string
  createdAt: string
  reversedAt: string | null
  reverseCause: 'lift' | 'appeal' | 'space' | null
}

// ── 모집·지원 (C-07, ADR 0024) ───────────────────────────────────────────

export type RecruitmentKind = 'team' | 'study'
export type RecruitmentStatus = 'open' | 'closed' | 'cancelled'
export type ApplicationStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn'

/** 모집 카드. 모집자는 싣지 않고(본인 여부 `mine`만) 지원자 수도 싣지 않습니다(모집자는 상세의 recruiter에서 봄). */
export interface RecruitmentSummaryDto {
  id: string
  kind: RecruitmentKind
  title: string
  status: RecruitmentStatus
  /** 모집 인원(수락할 수 있는 지원자 수, 모집자 제외). */
  capacity: number
  closesAt: string | null
  createdAt: string
  closedAt: string | null
  /** 지금 지원을 받는지(모집 중 + 마감 예정 시각 전 + 가려지지 않음). */
  accepting: boolean
  course: { id: string; title: string; code: string | null; schoolName: string } | null
  term: { id: string; year: number; semester: Semester } | null
  space: { slug: string; name: string; official: boolean } | null
  /** 스터디 방 이름 표시 방식(스터디만). */
  roomNameMode: NameMode | null
  mine: boolean
  /** 운영 조치로 가려짐(모집자 본인에게만 true가 보임 — 다른 사람에게는 목록·상세에서 빠짐). */
  hidden: boolean
  /** 내 지원 상태(지원했으면). */
  myApplicationStatus: ApplicationStatus | null
}

/** 지원 첨부: 지원자 자신의 공개 프로필·공개 사례. 읽을 때 다시 확인해 내려간(철회·숨김) 것은 빠집니다. */
export interface ApplicationAttachmentsDto {
  profile: { handle: string } | null
  cases: Array<{ slug: string; title: string }>
}

/** 모집자만 보는 지원 하나. 활동량·포크 수·확인 수·점수·순위·거절 사유 필드는 없습니다(RECRUITER_APPLICATION_KEYS). */
export interface RecruitmentApplicationDto {
  id: string
  applicant: { displayName: string }
  message: string
  messageHidden: boolean
  attachments: ApplicationAttachmentsDto
  status: ApplicationStatus
  createdAt: string
  decidedAt: string | null
}

/** 지원자 본인의 지원. 상태 문장은 거절·마감을 구분하지 않습니다. */
export interface MyApplicationDto {
  id: string
  status: ApplicationStatus
  statusText: string
  message: string
  attachments: ApplicationAttachmentsDto
  createdAt: string
  /** 선정 + 마감되어 초대를 받을 수 있음. */
  invitationAvailable: boolean
  /** 지금 볼 수 없는 모집이면 null(제목 없음). */
  recruitment: Pick<RecruitmentSummaryDto, 'id' | 'kind' | 'title' | 'status'> | null
}

export interface RecruiterViewDto {
  applicationCount: number
  pendingCount: number
  acceptedCount: number
  result: { projectId: string | null; spaceSlug: string | null }
}

export interface RecruitmentDetailDto extends RecruitmentSummaryDto {
  description: string
  /** 지원할 수 있는지와 아니면 이유 코드(own_recruitment·not_open·already_applied·write_restricted). */
  canApply: boolean
  applyBlockedReason: string | null
  myApplication: MyApplicationDto | null
  /** 모집자 본인에게만. */
  recruiter: RecruiterViewDto | null
  canReport: boolean
}

export interface RecruitmentListDto {
  context: { space: { slug: string; name: string; official: boolean } | null; course: { id: string; title: string; code: string | null; schoolName: string } | null }
  items: RecruitmentSummaryDto[]
  /** 이 맥락에서 올릴 수 있는 종류. */
  canPost: { team: boolean; study: boolean }
  /** 올릴 수 없는 이유(예: no_recruiting_board, team_finding_disabled, write_restricted). */
  postBlockedReasons: { team: string | null; study: string | null }
  teamFindingDisabled: boolean
  /** 과목 맥락: 그 과목의 학기(팀원 찾기 마감 시 과제 공간에 연결). */
  terms: Array<{ id: string; year: number; semester: Semester }>
}

export interface MyRecruitmentsDto {
  created: RecruitmentSummaryDto[]
  applications: MyApplicationDto[]
}

/** 지원 화면에서 고를 수 있는 내 공개 항목. */
export interface ApplicationAttachmentOptionsDto {
  profile: { handle: string } | null
  cases: Array<{ slug: string; title: string }>
}

export interface RecruitmentInvitationDto {
  kind: 'project' | 'space'
  inviteUrl: string
}

export interface CourseTeamFindingEntryDto {
  available: boolean
}

/** 운영자 신고 상세의 모집 글·지원 메시지(C-07). 모집자·지원자 id·지원자 목록 없음. */
export interface OperatorRecruitmentItemDto {
  target: 'recruitment' | 'application'
  kind: RecruitmentKind
  title: string
  description: string | null
  message: string | null
  status: string
  hidden: boolean
}

// ── 소셜 링크 (S-06, ADR 0034) ───────────────────────────────────────────

export type SocialLinkProvider = 'github' | 'blog' | 'linkedin' | 'instagram' | 'youtube' | 'other'
export type SocialLinkVerification = 'unverified' | 'verified' | 'lost'
export type SocialLinkCheckResult = 'found' | 'missing' | 'fetch_failed' | 'blocked'

/** 공개 프로필의 소셜 링크. 확인 끊김(lost)·마지막 결과는 싣지 않습니다(본인 화면에만). */
export interface PublicSocialLinkDto {
  provider: SocialLinkProvider
  url: string
  /** 되돌림 링크 확인됨(계정에 이 Peerchive 프로필 링크가 있음). 인물·경력 검증이 아님. */
  verified: boolean
}

/** 내 페르소나의 소셜 링크(본인에게만). */
export interface MySocialLinkDto {
  id: string
  provider: SocialLinkProvider
  url: string
  verification: SocialLinkVerification
  verifiedAt: string | null
  lastCheckedAt: string | null
  lastCheckResult: SocialLinkCheckResult | null
  /** 확인을 요청했고 아직 수집기가 결과를 쓰지 않았음. */
  verifyPending: boolean
  /** 운영 조치로 숨김(S-07): 공개 프로필에 보이지 않고, 숨긴 동안 지울 수 없음. */
  hidden: boolean
  createdAt: string
}

export interface MySocialLinksDto {
  links: MySocialLinkDto[]
  /** 페르소나당 최대 개수. */
  limit: number
  /** 링크한 페이지에 넣어야 하는 이 페르소나의 공개 프로필 주소(`<사이트>/u/<handle>`). */
  backLinkUrl: string
}

// ── 수료 회고 (A-06, ADR 0043) ───────────────────────────────────────────

export type CompletionRetroQuestion = 'learned' | 'curriculum' | 'beforeStart' | 'advice'
export type CompletionRetroAnswers = Partial<Record<CompletionRetroQuestion, string>>
export type CompletionRetroDisplayMode = 'name' | 'display' | 'anonymous'
export type CompletionRetroStatus = 'published' | 'withdrawn' | 'hidden'

/** 읽는 사람에게 주는 수료 회고. 별점·연봉·추천 점수 필드가 없습니다. 작성자 id·소속 id·회원 수도 없습니다. */
export interface CompletionRetroDto {
  id: string
  /** 계정 이름·표시명, 또는 "익명 수료생". */
  author: string
  anonymous: boolean
  /** 쓰는 순간 고정한 기관 표시(`○○부트캠프 · 수료생`·`부트캠프 수료생`), 표시 안 함이면 null. */
  institutionLabel: string | null
  /** 기관 이름 범위로 고정된 회고만(넓혀진 익명 회고는 null). */
  institution: { id: string; name: string; kind: InstitutionKind } | null
  /** 이름을 건 회고에서 작성자가 고른 기수. */
  cohortLabel: string | null
  answers: CompletionRetroAnswers
  publishedAt: string
  mine: boolean
  canReport: boolean
  /** 내 회고이고 기관 표시가 넓혀졌는지(작성자 본인에게만). */
  labelBroadened?: boolean
}

export interface CompletionRetroListDto {
  /** 읽을 수 있는지(active 기관 인증 하나 이상 또는 운영자). false면 빈 목록. */
  eligible: boolean
  items: CompletionRetroDto[]
  /** 기관 이름 범위의 회고가 있는 기관(필터용, 개수 없음). */
  institutions: Array<{ id: string; name: string; kind: InstitutionKind; kindLabel: string }>
  /** 다음 쪽(`before`에 넣음). 없으면 null. */
  nextBefore: string | null
}

export interface MyCompletionRetroDto extends CompletionRetroDto {
  displayMode: CompletionRetroDisplayMode
  status: CompletionRetroStatus
  withdrawnAt: string | null
  /** 운영 조치로 숨겨졌으면 그 안내. */
  moderation: ModerationNoticeDto | null
}

export interface CompletionRetroComposerDto {
  /** 쓸 수 있는 내 소속(대학이 아닌 기관의 수료생). 없으면 []. */
  options: Array<{
    affiliationId: string
    institution: { id: string; name: string; kind: InstitutionKind }
    title: string
    cohortLabel: string | null
    /** 이 기관에 이미 공개(·숨김) 회고가 있음(철회하면 다시 씀). */
    alreadyWritten: boolean
    /** 익명으로 쓸 때 범위별 기관 표시 미리보기(회원 수 없음, 넓혀졌는지만). */
    anonymousPreviews: Record<AffiliationLabelScope, { label: string | null; broadened: boolean }>
  }>
  questions: CompletionRetroQuestion[]
  displayModes: CompletionRetroDisplayMode[]
  scopes: AffiliationLabelScope[]
  defaultScope: AffiliationLabelScope
  accountName: string | null
  displayPersonaName: string | null
  guideline: string
  broadenedNote: string
}

// ── 학생 큐레이터 (E-03, PROOFU_EVOLUTION_PLAN §8.6, ADR 0048) ─────────────────

export type CuratorRecommendationKind = 'dismiss' | 'hide'
export type ConceptTagProposalStatus = 'pending' | 'approved' | 'rejected'

/** 과목 허브의 과제 유형 요약. 작성자 없음. */
export interface AssignmentTypeSummaryDto {
  body: string
  version: number
  updatedAt: string
}

/** 공개 프로필 "후배 기여"의 큐레이터 과목(과목·학교 이름만). */
export interface CuratedCourseLabelDto {
  courseTitle: string
  schoolName: string
}

export interface CuratorCourseRefDto {
  id: string
  title: string
  code: string | null
  schoolName: string
}

/** GET /api/v1/operator/courses/:id/curators · GET /api/v1/operator/curators — 운영자만. 사용자 id·계정 이름·지정 시각. */
export interface OperatorCourseCuratorDto {
  id: string
  course: CuratorCourseRefDto
  userId: string
  displayName: string
  grantedAt: string
}

/** GET /api/v1/me/curated-courses — 내가 지금 큐레이터인 과목. */
export interface MyCuratedCourseDto {
  course: CuratorCourseRefDto
  grantedAt: string
  /** 공개 프로필 "후배 기여"에 이 과목을 보일지(본인 선택, 기본 꺼짐). */
  showInPortfolio: boolean
}

export interface ConceptTagProposalDto {
  id: string
  course: CuratorCourseRefDto
  source: ConceptTagDto
  target: ConceptTagDto
  note: string | null
  status: ConceptTagProposalStatus
  createdAt: string
  decidedAt: string | null
  /** 큐레이터 화면: 내가 낸 제안인지(다른 큐레이터의 이름은 싣지 않음). */
  mine?: boolean
  /** 운영자 화면만: 제안한 큐레이터(탈퇴했으면 null). */
  proposer?: { userId: string; displayName: string } | null
}

/** GET /api/v1/curator/courses/:id — 큐레이터(또는 운영자) 작업 화면. */
export interface CuratorWorkspaceDto {
  course: CuratorCourseRefDto
  /** 운영자로서 보는지(병합 제안·신고 의견은 큐레이터만). */
  operator: boolean
  summary: AssignmentTypeSummaryDto | null
  conceptTags: ConceptTagDto[]
  proposals: ConceptTagProposalDto[]
  teamFindingDisabled: boolean
}

/** 큐레이터가 보는 신고 대상 내용: 지금 공개 중인 것만(공개 화면과 같은 내용). */
export type CuratorReportContentDto =
  | { kind: 'senior_note'; note: PublicSeniorNoteDto }
  | { kind: 'course_qa'; qa: PublicCourseQaDto }
  | { kind: 'publication'; title: string; summary: string; itemKind: 'log' | 'claim' | 'artifact' | null }
  /** E-04: 지금 보이는 막힘 Q&A 글(공개 화면과 같은 표시·본문). */
  | { kind: 'stuck_qa_post'; post: StuckQaModerationPostDto }
  | { kind: 'unavailable'; message: string }

/**
 * GET /api/v1/curator/courses/:id/reports — 그 과목 허브 항목에 대한 처리 전 신고 묶음. **신고자 신원·신고 설명·신고 시각 없음**, 사유별 개수만.
 * 작성자 신원도 공개 화면에 보이는 것 말고는 없습니다.
 */
export interface CuratorReportGroupDto {
  /** 묶음의 가장 오래된 처리 전 신고(의견을 붙이는 곳). */
  reportId: string
  targetType: 'senior_note' | 'course_qa' | 'publication' | 'publication_item' | 'stuck_qa_post'
  targetLabel: string
  reasons: Partial<Record<ReportReason, number>>
  content: CuratorReportContentDto
  /** 지금 공개 경로(공개 중일 때만). */
  publicPath: string | null
  myRecommendation: { recommendation: CuratorRecommendationKind; note: string | null; updatedAt: string } | null
}

export interface OperatorCuratorRecommendationDto {
  reportId: string
  recommendation: CuratorRecommendationKind
  note: string | null
  /** 의견을 낸 큐레이터(탈퇴했으면 null). */
  curator: { userId: string; displayName: string } | null
  createdAt: string
  updatedAt: string
}

// ── 막힘 Q&A 스레드 (E-04, ADR 0049) ─────────────────────────────────────

/** 글의 표시: `질문자`(스레드를 연 사람) / `작성자`(막힘 로그를 쓴 사람) / `익명N`. 이름·사람 id는 없습니다. */
export type StuckQaRole = 'asker' | 'log_author' | 'anonymous'
export type StuckQaPostStatus = 'published' | 'withdrawn' | 'hidden'

/** 보는 사람 자신에 관한 값(로그인했을 때만). */
export interface StuckQaViewerDto {
  /** 이 막힘 로그를 쓴 사람인지(질문 허용을 켜고 끌 수 있음, 쓰면 `작성자`). */
  isLogAuthor: boolean
  /** 지금 질문·답변을 쓸 수 있는지(허용 + 과목 학교 인증, C-01). */
  canWrite: boolean
  /** 인증이 없어서 못 쓰면 'school_affiliation'(화면이 인증 페이지로 안내). */
  requirement: 'school_affiliation' | null
}

/** 카드 목록의 스레드 하나. "도움됐어요" 개수는 싣지 않습니다(정렬에만 씀). */
export interface StuckQaThreadSummaryDto {
  id: string
  question: string
  answerCount: number
  createdAt: string
  lastPostAt: string
}

/** GET /api/v1/stuck-qa/cards/:slug/:itemKey — 막힘 카드 하나의 질문 허용·스레드(카드 안 정렬: 도움됐어요 합 → 최근 글). */
export interface StuckQaCardDto {
  slug: string
  itemKey: string
  symptom: string
  courseId: string | null
  questionsAllowed: boolean
  threads: StuckQaThreadSummaryDto[]
  viewer: StuckQaViewerDto | null
}

export interface StuckQaPostDto {
  id: string
  kind: 'question' | 'answer'
  role: StuckQaRole
  label: string
  /** 게시 중일 때만. 지운 글·숨긴 글은 null(자리 표시). */
  body: string | null
  status: StuckQaPostStatus
  createdAt: string
  /** 보는 사람 자신의 글인지(그 사람의 응답에만 true). */
  mine: boolean
  /** 보는 사람이 "도움됐어요"를 눌렀는지. 개수는 없습니다. */
  helpedByMe: boolean
  /** 내 답변이면 포트폴리오 "후배 기여"에 넣는지(남의 글은 null). */
  countAsContribution: boolean | null
}

/** GET /api/v1/stuck-qa/threads/:id — 질문 먼저, 답변은 도움됐어요 많은 순 → 먼저 쓴 순. */
export interface StuckQaThreadDto {
  id: string
  slug: string
  itemKey: string
  symptom: string
  /** 질문 허용이 켜져 있어 새 답변을 받는지. */
  open: boolean
  posts: StuckQaPostDto[]
  viewer: StuckQaViewerDto | null
}

/** 운영자·큐레이터가 보는 막힘 Q&A 글(표시·본문·상태, 작성자 없음). */
export interface StuckQaModerationPostDto {
  /** 글 id(공개 스레드 화면에도 보이는 값). */
  id: string
  kind: 'question' | 'answer'
  label: string
  body: string
  status: StuckQaPostStatus
  /** 스레드 질문 미리보기(답변을 신고했을 때 맥락). */
  question: string
  slug: string
  createdAt: string
}

/** POST /api/v1/operator/stuck-qa/posts/:id/author-lookup {reportId} — 신고에 묶인 작성자 확인(감사 기록, 이 응답에만 작성자). */
export interface StuckQaAuthorLookupDto {
  postId: string
  reportId: string
  author: { userId: string; handle: string | null; status: 'active' | 'suspended' | 'deleted' } | null
  /** 막힘 로그 작성자로 쓴 글인지. */
  byLogAuthor: boolean
}
