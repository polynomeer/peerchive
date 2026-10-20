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

/**
 * 사후 작성 표시(PROOFU_EVOLUTION_PLAN §6.7, DELIVERY_PLAN 시나리오 G). 프로젝트·로그·마일스톤·스냅샷 DTO는 모두 이 필드를 가집니다.
 * 공개 DTO(T-11/T-12)는 이 DTO들에서 만들어지므로 이 표시를 빼지 말고 그대로 옮겨야 합니다.
 * 화면은 색이 아니라 `사후 작성` 글자로 보여 줍니다.
 */
export interface RetrospectiveMarked {
  /** 프로젝트는 지금의 retro_mode, 그 밖의 항목은 만들 때(지정할 때) 사후 작성 모드였는지. */
  retrospective: boolean
}

export interface ProjectDto extends RetrospectiveMarked {
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

export type EmbargoSource = 'course_term_end' | 'course_term_embargo' | 'project_embargo'

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
export type CandidateStatus = 'awaiting_consent' | 'ready' | 'superseded' | 'published' | 'withdrawn'
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
  kind: 'individual' | 'team'
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

export interface PublicationCheckDto {
  rule: PublicationCheckRule
  location: { kind: 'title' | 'summary' | 'log' | 'claim' | 'milestone' | 'artifact'; key?: string; field: string }
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

/** GET /projects/:id/publication */
export interface PublicationStateDto {
  publication: { id: string; slug: string; level: PublicationLevel; status: PublicationStatus } | null
  candidate: PublicationCandidateDto | null
  options: PublicationOptionsDto
  embargo: EmbargoDto
  canPrepare: boolean
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
