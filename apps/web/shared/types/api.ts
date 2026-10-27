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

export interface PublicationCheckDto {
  rule: PublicationCheckRule
  location: {
    kind: 'title' | 'summary' | 'log' | 'claim' | 'milestone' | 'artifact' | 'senior_note' | 'case_study' | 'portfolio' | 'course_qa'
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

export type SeniorNoteDisplayMode = 'name' | 'display' | 'anonymous'
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
  anonymous: boolean
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
  course: { id: string; title: string; code: string | null; school: { name: string }; authoredBy: 'student' }
  conceptTags: ConceptTagDto[]
  cases: CourseHubCaseDto[]
  stuckItems: CourseHubStuckDto[]
  seniorNotes: PublicSeniorNoteDto[]
  /** 막힘 Q&A(C-09): 게시된 것만. 복사한 글과 각자 고른 이름뿐(사람 id·원 글 정보 없음). */
  qaItems: PublicCourseQaDto[]
  workload: CourseHubWorkloadDto
  otherSchools: CourseHubRelatedDto[]
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
    }
  | { anchor: string; available: false; message: string }

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
  /** 후배 기여: 개수만, 순위 없음. */
  juniorContribution: { planForks: number; seniorNotes: number }
  timeline: PublicTimelineItemDto[]
  /** 학교 인증 배지(C-01). 본인이 켰을 때만, active 인증의 학교 이름 + 졸업생 여부. 학과·메일·도메인 없음. */
  affiliationBadges: PublicAffiliationBadgeDto[]
}

// ── 학교 메일 인증 (C-01, ADR 0018) ──────────────────────────────────────

export type AffiliationStanding = 'student' | 'alumni'
export type AffiliationStatus = 'pending' | 'active' | 'revoked' | 'expired'
export type AffiliationRevokedReason = 'user_removed' | 'operator' | 'merged_duplicate'

/** 내 학교 인증(본인에게만). 메일 주소는 저장하지 않으므로 없고, 도메인만 있습니다. */
export interface AffiliationDto {
  id: string
  school: SchoolDto
  emailDomain: string
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
  emailDomain: string
  status: AffiliationStatus
  verifiedAt: string | null
  revokedAt: string | null
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
export type ReportReason = 'personal_info' | 'answer_sharing' | 'copyright' | 'harassment' | 'false_claim' | 'spam' | 'other'
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
  | { kind: 'profile'; profile: PublicProfileDto }
  /** 커뮤니티 공간(C-02): 이름·소개·종류·상태·멤버 수만. 게시판 글·멤버 목록은 운영자에게도 싣지 않습니다. */
  | { kind: 'community_space'; space: OperatorSpaceDto }
  | { kind: 'community_post' | 'community_comment'; item: OperatorCommunityItemDto }
  /** 모집 글·지원 메시지(C-07) 하나만. 모집자·지원자 id와 지원자 목록은 운영자에게도 싣지 않습니다. */
  | { kind: 'community_recruitment' | 'community_application'; recruitmentItem: OperatorRecruitmentItemDto }
  /** 막힘 Q&A(C-09): 공개된 복사본 그대로(당사자 id 없음). */
  | { kind: 'course_qa'; qa: PublicCourseQaDto; status: CourseQaStatus }
  | { kind: 'unavailable'; message: string }

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
  generatedAt: string
  notes: string[]
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
}

// ── 캠퍼스 커뮤니티: 공간·게시판·멤버십 (C-02, ADR 0019) ──────────────────

export type SpaceKind = 'official_school' | 'official_department' | 'user_room' | 'study_room'
export type NameMode = 'real' | 'display' | 'anonymous'
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
  discovery: SpaceDiscovery
  joinPolicy: JoinPolicy
  status: SpaceStatus
  memberCount: number | null
  /** 내 멤버십(없으면 null). 공식 페이지는 모더레이터일 때만. */
  myMembership: { role: SpaceRole; status: SpaceMembershipStatus } | null
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
  access: 'member' | 'preview'
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
 */
export interface CommunityAuthorDto {
  kind: 'real' | 'display' | 'anonymous' | 'withdrawn'
  /** 지우거나 가린 표시명·실명 글은 null. */
  label: string | null
  schoolVerified: boolean
  /** 내 글인지(내 응답에만 true). */
  mine: boolean
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
  /** 이 공간에서 지금 내 쓰기를 막는 이용 제한(C-06). 본인 응답에만 있고 다른 사람에게는 항상 null입니다. */
  restriction: CommunityWriteRestrictionDto | null
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
  comments: CommunityCommentDto[]
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
  /** 막힘 Q&A: 내가 고를 수 있는 이름(내 계정 값). */
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
  targets: Record<ArchiveTransferTarget, 'source_not_open' | 'not_author' | 'not_question_board' | 'no_accepted_answer' | null>
  projects: Array<{ id: string; title: string }>
  displayName: string | null
  hasRealName: boolean
  lengths: { title: number; body: number; answer: number }
  limits: { stuckSymptom: number; logBody: number; solution: number; noteAnswer: number }
  timeBuckets: string[]
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
