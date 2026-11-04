/**
 * pilot 분석 이벤트 규칙 (DELIVERY_PLAN §6 측정 계획, SYSTEM_DESIGN §14 관측, T-16, ADR 0016).
 *
 * - 이벤트 이름은 DELIVERY_PLAN §6의 최소 분석 이벤트 15개 + `login_succeeded`(활성화 지표의 가입 시점) + `affiliation_verified`(C-01, props는 standing만) + `space_created`·`space_joined`(C-02, 종류·가입 방식만) + `name_mode_scheduled`·`name_mode_applied`(C-03, 바꾸기 전·후 방식만) + `post_created`·`comment_created`·`reaction_added`(C-04, 게시판 종류·방식·답글 여부·대상 종류만) + `community_report_filed`·`community_auto_hidden`·`community_sanction_issued`(C-06, 대상 종류·제재 수준·범위만) + `recruitment_created`·`application_submitted`·`recruitment_closed`(C-07, 모집 종류·마감 결과만) + `archive_transfer_requested`·`archive_transfer_completed`·`course_qa_published`(C-09, 옮길 곳 종류만) + `study_record_enabled`(C-08, 방 이름 표시 방식·과목 연결 여부만) + `community_author_lookup`(C-10, 근거 종류만)
 *   + §6.2 공개 프로필·팔로우 이벤트 11개(S-07, ADR 0036: 사용자 키만, 페르소나 id·상대방 키 없음, 시 단위 시각)
 *   + §6.2 P2 졸업생·토픽·기관 이벤트 6개와 `affiliation_verified`의 `method`(A-07, ADR 0045: 사용자 키만·시 단위 시각, 익명·소속 표시 익명 내용은 키 없음)입니다.
 * - 사용자 키 없는 이벤트(C-10, ADR 0027)는 actorHash가 null입니다. 사람 단위 지표(활성화·기록 유지·공유한 사람 수·주간 활성)는 키 있는 이벤트만 셉니다.
 * - props는 이벤트마다 허용 목록(ANALYTICS_PROP_SPECS)의 키만, 값은 정해진 enum 문자열·참거짓·범위 안의 정수만 받습니다.
 *   자유 문자열 필드는 없으므로 과제 본문·제목·파일 이름·URL·이메일·검색어가 들어갈 자리가 없습니다(§6 "본문·파일 내용·검색 원문·연락처 없음").
 *   목록 밖의 키·값이 하나라도 있으면 sanitizeAnalyticsProps가 거부하고, 웹 emitter는 그 이벤트를 버립니다(일부만 저장하지 않음).
 * - 지표(computePilotMetrics)는 이벤트만으로 계산하며, 작은 수(초안 5 미만)는 null로 가립니다(§11.2와 같은 임계값).
 *   기록 1회 작성 시간은 이벤트로 잴 수 없어 null입니다(인터뷰·관찰로 따로 잼).
 */

export const ANALYTICS_EVENT_NAMES = [
  'project_created',
  'log_saved',
  'evidence_attached',
  'milestone_snapshot_set',
  'checkin_submitted',
  'claim_endorsed',
  'report_exported',
  'candidate_prepared',
  'consent_completed',
  'publication_published',
  'publication_withdrawn',
  'plan_forked',
  'usefulness_marked',
  'senior_note_published',
  'portfolio_shared',
  'login_succeeded',
  'affiliation_verified',
  'space_created',
  'space_joined',
  'name_mode_scheduled',
  'name_mode_applied',
  'post_created',
  'comment_created',
  'reaction_added',
  'community_report_filed',
  'community_auto_hidden',
  'community_sanction_issued',
  'recruitment_created',
  'course_registered',
  'application_submitted',
  'recruitment_closed',
  'archive_transfer_requested',
  'archive_transfer_completed',
  'course_qa_published',
  'study_record_enabled',
  'community_author_lookup',
  // S-07(DELIVERY_PLAN §6.2 P1, ADR 0036): 공개 프로필·팔로우. 사용자 키(actor_hash)는 붙이고 **페르소나 id·handle·상대방 키는 넣지 않습니다**.
  'persona_created',
  'identity_link_toggled',
  'visibility_changed',
  'project_listed',
  'follow_requested',
  'follow_approved',
  'follower_removed',
  'block_created',
  'mute_created',
  'feed_item_opened',
  'social_link_verified',
  // A-07(DELIVERY_PLAN §6.2 P2, ADR 0045): 졸업생·토픽·기관. 사용자 키만(방·글·기관·기수·페르소나 id 없음), 시 단위 시각(P2_EVENT_NAMES).
  // 익명 방의 일정·응답, 익명·소속 표시 익명 토픽 글, 익명 수료 회고는 사용자 키 없이 기록합니다.
  'alumni_room_created',
  'event_created',
  'rsvp_submitted',
  'directory_consent_changed',
  'topic_post_created',
  'completion_retro_published',
  // E-12(ADR 0057): AI 회고 인터뷰. 개수·태그·결정·플래그만(질문·답변·초안 글·모델 이름 없음).
  'ai_retro_drafts_proposed',
  'ai_retro_draft_resolved',
  // E-13(ADR 0058): AI 회의 요약. 개수·결정·플래그만(메시지·요약 글 없음).
  'ai_meeting_draft_proposed',
  'ai_meeting_draft_resolved',
] as const
export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number]

export type AnalyticsPropSpec =
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'bool' }
  /** 개수·수준·번호: 정수, min 이상 max 이하. */
  | { kind: 'int'; min: number; max: number }

export type AnalyticsPropValue = string | number | boolean
export type AnalyticsProps = Readonly<Record<string, AnalyticsPropValue>>

const LOG_TAGS = ['progress', 'stuck', 'solution', 'decision', 'meeting', 'validation', 'retro'] as const
const LOG_SOURCES = ['web', 'discord', 'ai', 'task', 'retro'] as const
const NAME_MODE_VALUES = ['real', 'display', 'anonymous'] as const
/** 글·댓글에 고정된 방식(A-05: 토픽의 소속 표시 익명 포함). 방식 변경 예약·스터디 방은 NAME_MODE_VALUES만. */
const WRITE_MODE_VALUES = [...NAME_MODE_VALUES, 'affiliated_anonymous'] as const
const enumOf = (values: readonly string[]): AnalyticsPropSpec => ({ kind: 'enum', values })
const bool: AnalyticsPropSpec = { kind: 'bool' }
const count = (max: number, min = 0): AnalyticsPropSpec => ({ kind: 'int', min, max })

/**
 * 이벤트별 허용 props. 새 키를 더할 때는 개인을 식별하거나 내용을 담을 수 없는 값(정해진 코드·개수)인지 먼저 확인하세요.
 * 모든 키는 선택입니다(없어도 됨). 목록 밖 키는 거부합니다.
 */
export const ANALYTICS_PROP_SPECS: Readonly<Record<AnalyticsEventName, Readonly<Record<string, AnalyticsPropSpec>>>> = {
  // E-01(ADR 0060 D-06): 과목 등록 수. 사용자 키·과목 id 없이 학기 종류만.
  course_registered: { semester: enumOf(['spring', 'summer', 'fall', 'winter']) },
  // origin study: 스터디 방이 기록을 켜서 만든 내부 과제(C-08). 스터디 기록의 로그는 log_saved에 origin study를 붙입니다(방·과제 id 없음).
  project_created: { kind: enumOf(['individual', 'team', 'study']), retro: bool, withCourse: bool, origin: enumOf(['web', 'fork', 'recruitment', 'study']) },
  log_saved: { tag: enumOf(LOG_TAGS), source: enumOf(LOG_SOURCES), revision: bool, origin: enumOf(['study']) },
  evidence_attached: { target: enumOf(['log', 'claim']), files: count(20), links: count(10), logs: count(20) },
  milestone_snapshot_set: { retro: bool },
  checkin_submitted: {
    timeBucket: enumOf(['none', 'lt2h', 'lt5h', 'lt10h', 'ten_plus']),
    difficulty: count(5, 1),
    shareForStats: bool,
    promoted: bool,
    skipReasons: count(5),
  },
  claim_endorsed: { status: enumOf(['confirmed', 'disputed']) },
  report_exported: { days: count(400, 1) },
  candidate_prepared: {
    level: enumOf(['summary', 'full']),
    logs: count(1000),
    claims: count(1000),
    milestones: count(100),
    files: count(1000),
    derived: bool,
  },
  consent_completed: { decision: enumOf(['granted', 'declined']), allGranted: bool },
  publication_published: { level: enumOf(['summary', 'full']), releaseNo: count(10000, 1), republish: bool, origin: enumOf(['study']) },
  publication_withdrawn: { cause: enumOf(['owner', 'consent_revoked', 'restricted']) },
  plan_forked: { milestones: count(100), references: count(1000) },
  usefulness_marked: { target: enumOf(['stuck_item', 'senior_note', 'course_qa']), kind: enumOf(['me_too', 'helped']) },
  senior_note_published: { displayMode: enumOf(['name', 'display', 'anonymous', 'affiliation']), answers: count(4) },
  portfolio_shared: { featured: count(5), competencies: count(12), skills: count(20) },
  login_succeeded: { newUser: bool },
  // 학교 메일 인증 성공(C-01). 학교 id·도메인은 넣지 않습니다(작은 학교는 학교만으로 사람을 좁힐 수 있음). 재학/졸업생 구분만.
  // A-07(§6.2 affiliation_verified(method)): 인증 수단(학교 메일·초대 코드·기수 승인·수료증 확인). 기관 id·기수는 넣지 않습니다.
  affiliation_verified: { standing: enumOf(['student', 'alumni']), method: enumOf(['email', 'invite_code', 'cohort_approval', 'certificate_check']) },
  // 커뮤니티 공간(C-02). 공간·학교 id·이름은 넣지 않습니다(사용자 키만 해시). 종류·가입 방식만.
  space_created: { kind: enumOf(['official_school', 'official_department', 'user_room', 'study_room', 'topic']) },
  space_joined: {
    kind: enumOf(['user_room', 'study_room']),
    policy: enumOf(['open', 'approval', 'invite']),
  },
  // 이름 표시 방식 변경(C-03). 공간 id·이름은 넣지 않습니다. 바꾸기 전·후 방식만.
  name_mode_scheduled: { from: enumOf(NAME_MODE_VALUES), to: enumOf(NAME_MODE_VALUES) },
  name_mode_applied: { from: enumOf(NAME_MODE_VALUES), to: enumOf(NAME_MODE_VALUES) },
  // 커뮤니티 글·댓글·공감(C-04). 글·공간·게시판 id·제목·본문은 넣지 않습니다. 게시판 종류·고정된 이름 표시 방식·답글 여부·공감 대상 종류만.
  // 익명 글·댓글은 사용자 키 없이 기록합니다(웹 emitter의 unlinked, SYSTEM_DESIGN §6.7 "익명 글과 프로필의 분리").
  // area(C-10, §6.1 space_kind): 공간 종류를 묶은 코드(official = 공식 학교·학과 페이지, room = 사용자 방, study = 스터디 방, topic = 토픽(A-05)). 키 이름에 space를 쓰지 않습니다(C-05 금지 키).
  post_created: {
    kind: enumOf(['free', 'freshmen', 'alumni', 'question', 'info', 'recruiting', 'notice', 'general']),
    mode: enumOf(WRITE_MODE_VALUES),
    area: enumOf(['official', 'room', 'study', 'topic']),
  },
  comment_created: { mode: enumOf(WRITE_MODE_VALUES), reply: bool },
  reaction_added: { target: enumOf(['post', 'comment']) },
  // C-06(ADR 0023): 대상 종류·제재 수준·범위만. 신고·글·공간·사람 id, 사유, 신고 수는 없습니다.
  community_report_filed: { targetKind: enumOf(['space', 'post', 'comment', 'recruitment', 'application']) },
  community_auto_hidden: { targetKind: enumOf(['post', 'comment']) },
  community_sanction_issued: { level: enumOf(['warning', 'write_suspended', 'permanent']), scope: enumOf(['community', 'space']) },
  // C-07(ADR 0024): 모집 종류·마감 결과만. 모집·공간·과목·사람 id, 제목, 지원자 수는 없습니다.
  recruitment_created: { kind: enumOf(['team', 'study']) },
  application_submitted: { kind: enumOf(['team', 'study']) },
  recruitment_closed: { kind: enumOf(['team', 'study']), outcome: enumOf(['project', 'study_room', 'cancelled']) },
  // C-09(ADR 0025): 옮길 곳 종류만. 글·답변·과목·과제·사람 id, 고른 이름은 없습니다(사용자 키 없이 기록).
  archive_transfer_requested: { target: enumOf(['course_qa', 'stuck_log', 'senior_note']) },
  archive_transfer_completed: { target: enumOf(['course_qa', 'stuck_log', 'senior_note']) },
  course_qa_published: {},
  // C-08(ADR 0026): 스터디 기록 켜기. 방·과제·과목 id 없이 그때의 방 이름 표시 방식과 과목 연결 여부만.
  study_record_enabled: { mode: enumOf(NAME_MODE_VALUES), withCourse: bool },
  // C-10(ADR 0027, §6.1 operator_identity_lookup): 운영자 작성자 확인. 근거 종류만(신고·제재 요청·없음). 사용자 키 없이 기록합니다.
  community_author_lookup: { basis: enumOf(['report', 'sanction_request', 'none']) },
  // S-07(ADR 0036, §6.2): 페르소나·팔로우 이벤트. 모두 사용자 키로 기록하고(사람 단위 지표: 피드 사용자 → 기록 활용, 표시명 사용 비율), 페르소나 id·handle·
  // 상대 페르소나·상대 사용자 키는 넣지 않습니다(§6.2 "차단·뮤트·팔로워 삭제 이벤트에는 상대방 키를 담지 않음"). 그래서 이벤트만으로는 한 사람의
  // 실명·표시명 페르소나를 서로 잇거나 특정 페르소나와 사용자 키를 이을 수 없습니다. 페르소나 종류는 만들 때(persona_created)·팔로우 대상(targetKind)만.
  // 시각은 시 단위로 내림합니다(SOCIAL_EVENT_TIME_BUCKET_MS): 팔로우·차단 행의 정확한 시각과 맞춰 사람을 잇는 것을 어렵게 합니다.
  persona_created: { kind: enumOf(['real', 'display']) },
  identity_link_toggled: { visible: bool },
  visibility_changed: {
    itemKind: enumOf(['project_list', 'posts', 'notes_and_studies', 'follow_lists']),
    audience: enumOf(['public', 'signed_in', 'same_institution', 'approved_followers', 'private']),
  },
  project_listed: { listed: bool },
  follow_requested: { targetKind: enumOf(['real', 'display']), pending: bool, origin: enumOf(['profile', 'suggestion']) },
  follow_approved: { bulk: bool },
  follower_removed: {},
  block_created: { scope: enumOf(['origin_persona', 'all_personas']) },
  mute_created: {},
  // 피드에서 항목을 연 것(§6.2 feed_item_opened(source_type)). 피드에는 0~1단계 글이 투영 경로부터 없으므로(S-02) 익명 글 이벤트는 생길 수 없습니다.
  feed_item_opened: { sourceType: enumOf(['publication_release', 'senior_note', 'study_release', 'profile_post', 'community_post']) },
  // worker가 되돌림 링크 확인으로 verified가 된 순간(unverified·lost → verified). 서비스 종류만(주소 없음).
  social_link_verified: { provider: enumOf(['github', 'blog', 'linkedin', 'instagram', 'youtube', 'other']) },
  // A-07(ADR 0045, §6.2 P2). 방·글·기관·기수·페르소나 id, 제목·이름·명부 값은 넣지 않습니다(종류·코드·개수·참거짓만).
  // 동문회·OB 방 만들기: 그때의 이름 표시 방식과 기수 방(I-02, 기관 운영진이 만듦) 여부.
  alumni_room_created: { mode: enumOf(NAME_MODE_VALUES), cohortRoom: bool },
  // 일정 만들기: 반복 규칙만. 익명 방이면 사용자 키 없음.
  event_created: { recurrence: enumOf(['none', 'weekly', 'monthly']) },
  // 참석 응답(회차마다 처음 응답·바꾸기, 지우기는 세지 않음). 익명 방이면 사용자 키 없음.
  rsvp_submitted: { response: enumOf(['going', 'not_going', 'maybe']), changed: bool },
  // 명부 동의·철회(본인). 채운 항목 수만(값 없음).
  directory_consent_changed: { consented: bool, filled: count(4) },
  // 토픽 글(§6.2 topic_post_created(label_scope_applied·broadened)): 적용된 소속 표시 범위와 넓혀졌는지. 익명·소속 표시 익명이면 사용자 키 없음.
  topic_post_created: { labelScope: enumOf(['institution', 'institution_kind', 'none']), broadened: bool },
  // 수료 회고 게시: 이름 표시 방식·적용된 기관 표시 범위·넓혀졌는지. 익명 회고면 사용자 키 없음.
  completion_retro_published: { displayMode: enumOf(['name', 'display', 'anonymous']), labelScope: enumOf(['institution', 'institution_kind', 'none']), broadened: bool },
  // E-12(ADR 0057): 인터뷰가 초안을 제안함 — 초안 수·질문 수·학생이 일찍 끝냈는지. 승인한 초안의 로그는 log_saved(source ai)로 따로 남습니다.
  ai_retro_drafts_proposed: { drafts: count(5), questions: count(10, 1), endedEarly: bool },
  // 초안 하나를 승인·버림 — 태그·결정·승인 전에 고쳤는지.
  ai_retro_draft_resolved: { decision: enumOf(['approved', 'discarded']), tag: enumOf(LOG_TAGS), edited: bool },
  // E-13(ADR 0058): 회의 채널 대화를 요약해 초안을 만듦 — 보낸 메시지 수·결정·후속 할 일 수(메시지·요약 글 없음).
  ai_meeting_draft_proposed: { messages: count(200), decisions: count(20), followUps: count(20) },
  // 초안 하나를 승인·거절 — 승인 때 만든 할 일 수·승인 전에 고쳤는지.
  ai_meeting_draft_resolved: { decision: enumOf(['approved', 'rejected']), tasks: count(20), edited: bool },
}

/** A-07(ADR 0045): 시 단위 시각으로 기록하는 P2 이벤트(affiliation_verified는 C-01부터 있던 이벤트라 시각을 그대로 둠). */
export const P2_EVENT_NAMES: readonly AnalyticsEventName[] = [
  'alumni_room_created',
  'event_created',
  'rsvp_submitted',
  'directory_consent_changed',
  'topic_post_created',
  'completion_retro_published',
]

/** 페르소나·팔로우 이벤트(S-07)의 시각 단위: 1시간으로 내림(ADR 0036). */
export const SOCIAL_EVENT_TIME_BUCKET_MS = 60 * 60 * 1000

/** 페르소나·팔로우 이벤트 시각(시 단위 내림). */
export function socialEventTime(now: Date): Date {
  return new Date(Math.floor(now.getTime() / SOCIAL_EVENT_TIME_BUCKET_MS) * SOCIAL_EVENT_TIME_BUCKET_MS)
}

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value)
}

export type SanitizeResult = { ok: true; props: Record<string, AnalyticsPropValue> } | { ok: false; violations: string[] }

/**
 * 허용 목록 검사. 통과하면 같은 키·값의 새 객체(키 정렬), 아니면 위반한 키 이름 목록(값은 싣지 않음).
 * undefined 값은 없는 키로 봅니다.
 */
export function sanitizeAnalyticsProps(name: AnalyticsEventName, props: Readonly<Record<string, unknown>> = {}): SanitizeResult {
  const specs = ANALYTICS_PROP_SPECS[name]
  if (!specs) return { ok: false, violations: ['_name'] }
  const violations: string[] = []
  const out: Record<string, AnalyticsPropValue> = {}
  for (const key of Object.keys(props).sort()) {
    const value = props[key]
    if (value === undefined) continue
    const spec = Object.hasOwn(specs, key) ? specs[key] : undefined
    if (!spec || !matches(spec, value)) {
      violations.push(key)
      continue
    }
    out[key] = value as AnalyticsPropValue
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true, props: out }
}

function matches(spec: AnalyticsPropSpec, value: unknown): boolean {
  switch (spec.kind) {
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value)
    case 'bool':
      return typeof value === 'boolean'
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= spec.min && value <= spec.max
  }
}

// ── 지표 (DELIVERY_PLAN §6) ──────────────────────────────────────────────

/** 작은 수 가림 임계값(초안, §11.2와 같음). */
export const ANALYTICS_MIN_GROUP = 5
/** 활성화 기준(§6): 가입 7일 이내 과제 생성 + 로그 3개 + 근거 하나. */
export const ACTIVATION_WINDOW_DAYS = 7
export const ACTIVATION_MIN_LOGS = 3
/** 기록 유지: 4주 중 3주 이상. */
export const RETENTION_WEEKS = 4
export const RETENTION_MIN_WEEKS = 3

export interface AnalyticsEventRow {
  name: AnalyticsEventName
  occurredAt: Date
  /** null = 사용자 키 없는 이벤트(사람 단위 지표에서 빠짐). */
  actorHash: string | null
  projectHash: string | null
  props: Readonly<Record<string, unknown>>
}

export interface RateMetric {
  denominator: number | null
  numerator: number | null
  /** 0~1, 소수 셋째 자리. 분자·분모 중 하나라도 가려지면 null. */
  rate: number | null
}

export interface PilotMetrics {
  from: string
  to: string
  minGroup: number
  /** 기간 안에 처음 로그인한(가입한) 사람 중 7일이 지난 사람 → 7일 안에 과제 생성 + 로그 3 + 근거 1. */
  activation: RateMetric
  /** `to` 이전 4주(7일 × 4)에 로그를 남긴 사람 → 그중 3주 이상 남긴 사람. */
  retention: RateMetric
  /** 기간 안에 공개 후보를 만든 과제(서로 다른 과제) → 그중 기간 안에 게시한 과제. "공개 허용이 확인된 종료 과제"는 이벤트로 알 수 없어 근사입니다. */
  caseConversion: RateMetric
  /** 북극성 지표 재료: 플랜 포크 수, "도움됐어요" 수, 합계. */
  northStar: { planForks: number | null; helpedMarks: number | null; total: number | null }
  /** 기여 리포트 인쇄(내보내기) 수와 서로 다른 과제 수. */
  reportExports: { exports: number | null; projects: number | null }
  /** 포트폴리오 판을 만든(공유한) 서로 다른 사람 수. */
  portfolioSharers: number | null
  seniorNotesPublished: number | null
  /** 기록 1회 작성 시간: 이벤트로 잴 수 없음(인터뷰·관찰). */
  writeTimeMedianMinutes: null
  /** 이벤트 이름별 기간 안 개수. */
  eventCounts: Record<AnalyticsEventName, number | null>
}

const DAY_MS = 24 * 60 * 60 * 1000

/** min 미만이면 null. */
export function suppressSmall(value: number, minGroup = ANALYTICS_MIN_GROUP): number | null {
  return value < minGroup ? null : value
}

function rateMetric(numerator: number, denominator: number, minGroup: number): RateMetric {
  const n = suppressSmall(numerator, minGroup)
  const d = suppressSmall(denominator, minGroup)
  return { denominator: d, numerator: n, rate: n === null || d === null ? null : Math.round((numerator / denominator) * 1000) / 1000 }
}

/**
 * 지표 계산(순수 함수). events에는 [from − 28일, to + 7일) 범위의 이벤트를 넘기면 충분합니다.
 * `now`는 활성화 분모(가입 뒤 7일이 지난 사람만)를 정합니다.
 */
export function computePilotMetrics(
  events: readonly AnalyticsEventRow[],
  range: { from: Date; to: Date; now: Date },
  minGroup = ANALYTICS_MIN_GROUP,
): PilotMetrics {
  const { from, to, now } = range
  const inRange = (e: AnalyticsEventRow) => e.occurredAt >= from && e.occurredAt < to
  const ranged = events.filter(inRange)

  // 활성화
  const signups = new Map<string, Date>()
  for (const e of events) {
    if (e.name !== 'login_succeeded' || e.props.newUser !== true || e.actorHash === null) continue
    const prev = signups.get(e.actorHash)
    if (!prev || e.occurredAt < prev) signups.set(e.actorHash, e.occurredAt)
  }
  let cohort = 0
  let activated = 0
  for (const [actor, at] of signups) {
    if (at < from || at >= to) continue
    const end = new Date(at.getTime() + ACTIVATION_WINDOW_DAYS * DAY_MS)
    if (end > now) continue
    cohort++
    const mine = events.filter((e) => e.actorHash === actor && e.occurredAt >= at && e.occurredAt < end)
    const projects = mine.filter((e) => e.name === 'project_created').length
    const logs = mine.filter((e) => e.name === 'log_saved' && e.props.revision !== true).length
    const evidence = mine.filter((e) => e.name === 'evidence_attached').length
    if (projects >= 1 && logs >= ACTIVATION_MIN_LOGS && evidence >= 1) activated++
  }

  // 기록 유지
  const windowStart = to.getTime() - RETENTION_WEEKS * 7 * DAY_MS
  const weeksByActor = new Map<string, Set<number>>()
  for (const e of events) {
    if (e.name !== 'log_saved' || e.actorHash === null) continue
    const t = e.occurredAt.getTime()
    if (t < windowStart || t >= to.getTime()) continue
    const week = Math.floor((t - windowStart) / (7 * DAY_MS))
    const set = weeksByActor.get(e.actorHash) ?? new Set<number>()
    set.add(week)
    weeksByActor.set(e.actorHash, set)
  }
  const retained = [...weeksByActor.values()].filter((weeks) => weeks.size >= RETENTION_MIN_WEEKS).length

  // 사례 전환
  const prepared = new Set(ranged.filter((e) => e.name === 'candidate_prepared' && e.projectHash).map((e) => e.projectHash!))
  const published = new Set(
    ranged.filter((e) => e.name === 'publication_published' && e.projectHash && prepared.has(e.projectHash)).map((e) => e.projectHash!),
  )

  const countOf = (pred: (e: AnalyticsEventRow) => boolean) => ranged.filter(pred).length
  const planForks = countOf((e) => e.name === 'plan_forked')
  const helped = countOf((e) => e.name === 'usefulness_marked' && e.props.kind === 'helped')
  const exportsRows = ranged.filter((e) => e.name === 'report_exported')
  const eventCounts = Object.fromEntries(
    ANALYTICS_EVENT_NAMES.map((name) => [name, suppressSmall(countOf((e) => e.name === name), minGroup)]),
  ) as Record<AnalyticsEventName, number | null>

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    minGroup,
    activation: rateMetric(activated, cohort, minGroup),
    retention: rateMetric(retained, weeksByActor.size, minGroup),
    caseConversion: rateMetric(published.size, prepared.size, minGroup),
    northStar: {
      planForks: suppressSmall(planForks, minGroup),
      helpedMarks: suppressSmall(helped, minGroup),
      total: suppressSmall(planForks + helped, minGroup),
    },
    reportExports: {
      exports: suppressSmall(exportsRows.length, minGroup),
      projects: suppressSmall(new Set(exportsRows.map((e) => e.projectHash).filter(Boolean)).size, minGroup),
    },
    portfolioSharers: suppressSmall(new Set(ranged.filter((e) => e.name === 'portfolio_shared' && e.actorHash !== null).map((e) => e.actorHash)).size, minGroup),
    seniorNotesPublished: suppressSmall(countOf((e) => e.name === 'senior_note_published'), minGroup),
    writeTimeMedianMinutes: null,
    eventCounts,
  }
}
