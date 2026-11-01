/**
 * 신고·보류·운영 조치·이의제기 규칙 (T-15, PROOFU_EVOLUTION_PLAN §9.4 "동의 철회·신고"·§15, SYSTEM_DESIGN §6.6 Report·AuditEvent·
 * §7.2 published → restricted / restricted → draft·§8 운영 예외, DELIVERY_PLAN T-15 "public 상태만 검색, 조치·이의제기·audit 기록", ADR 0015).
 *
 * - 신고 대상은 **지금 공개인 것**뿐입니다(공개 사례·그 안의 항목·게시된 선배 노트·게시된 케이스 스터디·공개 프로필). 비공개 작업 공간은 대상이 아닙니다.
 *   예외: 커뮤니티 공간(`community_space`, C-02)은 공개가 아니라 **신고자가 읽을 수 있는(또는 소개를 볼 수 있는) 공간**이 대상이고, 조치는 공간 제한입니다.
 *   커뮤니티 글·댓글(`community_post`·`community_comment`, C-04)도 신고자가 읽을 수 있는 게시 중인 것이 대상이고, 조치는 가리기(hide_post·hide_comment)입니다.
 * - 운영 조치는 "공개 차단"만 합니다(공개 제한·항목 가리기·노트/케이스/프로필 숨김). 삭제는 별도의 명시적 조치이며 여기에 없습니다(차단 ≠ 삭제, §8).
 * - 개인정보·저작권 신고는 그 공개에 **보류(hold)**를 걸어 신고가 처리될 때까지 게시·새 버전 게시를 막습니다(도메인 `hasOpenHold`).
 * - S-07(ADR 0036): 페르소나(실명·표시명)·프로필 글·소셜 링크도 대상입니다. 조치는 그 페르소나·글·링크 하나에만 걸리고, 같은 사람의 다른 페르소나에는
 *   영향이 없습니다(함께 사라지면 두 페르소나가 같은 사람임이 드러남, ADR 0028).
 * - 이의제기는 조치마다 한 번, 조치의 당사자(공개 owner·노트/케이스 작성자·프로필 주인)만 합니다. 되돌리면 조치를 풉니다
 *   (공개 제한은 restricted → draft: owner가 후보·동의·게시를 다시 합니다).
 * 런타임 의존성이 없고, 스냅샷 타입은 필요한 부분만 구조적으로 선언합니다.
 */

export const REPORT_TARGET_TYPES = [
  'publication',
  'publication_item',
  'senior_note',
  'case_study',
  'profile',
  'community_space',
  'community_post',
  'community_comment',
  // C-07(ADR 0024): 모집 글(읽을 수 있는 사람)·지원 메시지(그 모집의 모집자만).
  'community_recruitment',
  'community_application',
  // C-09(ADR 0025): 과목 허브의 막힘 Q&A(공개 대상, 누구나 신고).
  'course_qa',
  // S-07(ADR 0036): 페르소나 단위 공개 프로필(실명·표시명 어느 쪽이든)·프로필 글·소셜 링크. 신고·조치는 그 페르소나 행으로만 가리키고
  // 주인 사용자로 풀지 않습니다(표시명 신고가 운영 화면에 실명 handle을 붙이거나 실명 프로필을 숨기지 않게). 기존 `profile`(사용자 단위, 실명만)은
  // 이전 신고·API 호환으로 남깁니다(화면은 `persona`를 씀).
  'persona',
  'profile_post',
  'social_link',
  // A-06(ADR 0043): 수료 회고(읽을 수 있는 사람 — active 기관 인증이 있는 계정 — 이 게시 중인 회고를 신고).
  'completion_retro',
  // A-07(ADR 0045): 동문회·OB 방의 항목(명부 항목·일정·투표·앨범 사진·방별 프로필). 그 방 active 멤버가 지금 보는 것만 신고하고,
  // 대상은 항목 종류(ROOM_ITEM_KINDS) + 항목 id 하나입니다(주인 사용자 id는 신고·조치 행에 두지 않음).
  'room_item',
] as const
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number]

/**
 * 신고 사유. `impersonation`(S-07, ADR 0036): 표시명 사칭 — 다른 실존 인물·단체로 오인하게 하는 표시명·handle·소개. 프로필(페르소나·실명 프로필)
 * 신고에만 고를 수 있습니다(reasonApplicable). 처리 기준은 RUNBOOK §4.5.
 */
export const REPORT_REASONS = [
  'personal_info',
  'answer_sharing',
  'copyright',
  'harassment',
  'false_claim',
  'spam',
  'other',
  'impersonation',
  // A-07(ADR 0045): 소속·기수 사칭 — 토픽 글의 소속 표시, 명부·방별 프로필의 기수, 수료 회고의 기관이 사실과 다르게 보이게 함(가짜 인증·기수 자기 신고).
  'affiliation_impersonation',
] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

/** A-07(ADR 0045): 동문회·OB 방에서 신고할 수 있는 항목 종류. */
export const ROOM_ITEM_KINDS = ['directory_entry', 'event', 'poll', 'album_photo', 'room_profile'] as const
export type RoomItemKind = (typeof ROOM_ITEM_KINDS)[number]

/** 소속·기수 사칭을 고를 수 있는 대상: 커뮤니티 글·댓글(토픽의 소속 표시 포함), 수료 회고, 방 항목 중 기수를 적는 명부 항목·방별 프로필. */
export const AFFILIATION_IMPERSONATION_TARGETS: readonly ReportTargetType[] = ['community_post', 'community_comment', 'completion_retro', 'room_item']
const AFFILIATION_IMPERSONATION_ROOM_ITEMS: readonly RoomItemKind[] = ['directory_entry', 'room_profile']

/**
 * 이 대상에 이 사유를 고를 수 있는지. 표시명 사칭은 프로필(페르소나·실명 프로필)에만, 소속·기수 사칭(A-07)은 소속·기수가 보이는 대상에만
 * (방 항목이면 명부 항목·방별 프로필만 — roomItemKind를 넘기지 않으면 방 항목은 거부).
 */
export function reasonApplicable(target: ReportTargetType, reason: ReportReason, roomItemKind?: RoomItemKind | null): boolean {
  if (reason === 'impersonation') return target === 'persona' || target === 'profile'
  if (reason === 'affiliation_impersonation') {
    if (!AFFILIATION_IMPERSONATION_TARGETS.includes(target)) return false
    return target !== 'room_item' || (!!roomItemKind && AFFILIATION_IMPERSONATION_ROOM_ITEMS.includes(roomItemKind))
  }
  return true
}

export const REPORT_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export const MODERATION_ACTION_KINDS = [
  'none',
  'restrict',
  'hide_item',
  'hide_note',
  'hide_case_study',
  'hide_profile',
  'restrict_space',
  'archive_space',
  'hide_post',
  'hide_comment',
  // C-06(ADR 0023): 방 운영진(방장·admin·moderator, 공식 페이지 모더레이터)의 글·댓글 가리기(자기 공간, 되돌릴 수 있음)와 운영자의 이용 제한(제재) 발급.
  // 둘 다 신고 처리(resolve)로는 고르지 않고 별도 경로로만 만듭니다(ACTIONS_BY_TARGET에 없음). 대상 열은 글·댓글 id이고 공간 id는 넣지 않습니다
  // (방장이 당사자가 되어 제재 안내를 받지 않게).
  'space_hide',
  'sanction',
  // C-07(ADR 0024): 모집 글 가리기(목록·상세에서 빠지고 지원을 받지 않음, 모집자에게는 자리 표시)·지원 메시지 가리기(모집자에게 자리 표시).
  'hide_recruitment',
  'hide_application',
  // C-09(ADR 0025): 막힘 Q&A 숨기기(published → hidden, 되돌리면 다시 published).
  'hide_qa',
  // S-07(ADR 0036): 페르소나 하나의 공개 프로필 숨기기(그 페르소나의 profiles.hidden_at만 — 같은 사람의 다른 페르소나는 그대로)·프로필 글 숨기기
  // (published → hidden, 활동은 DB 트리거가 거둠)·소셜 링크 숨기기(social_links.hidden_at, 공개 DTO에서 빠짐). 모두 되돌릴 수 있습니다.
  'hide_persona',
  'hide_profile_post',
  'hide_social_link',
  // A-06(ADR 0043): 수료 회고 숨기기(published → hidden, 되돌리면 다시 published — 그사이 철회했으면 그대로).
  'hide_retro',
  // A-07(ADR 0045): 방 항목 하나 숨기기(그 행의 hidden_at — 방 멤버 화면에서 빠짐, 되돌리면 다시 보임).
  'hide_room_item',
] as const
export type ModerationActionKind = (typeof MODERATION_ACTION_KINDS)[number]

/** 공개 사례 안에서 가릴 수 있는 항목 종류(스냅샷 키: 로그·선언은 가명 키, 파일은 버전 id). */
export const HIDDEN_ITEM_KINDS = ['log', 'claim', 'artifact'] as const
export type HiddenItemKind = (typeof HIDDEN_ITEM_KINDS)[number]

export const APPEAL_STATUSES = ['open', 'upheld', 'reversed'] as const
export type AppealStatus = (typeof APPEAL_STATUSES)[number]
export const APPEAL_DECISIONS = ['uphold', 'reverse'] as const
export type AppealDecision = (typeof APPEAL_DECISIONS)[number]

/** 보류를 만드는 신고 사유(게시를 막을 만큼 급한 것): 개인정보 노출·저작권(권리 침해). */
export const HOLD_REASONS: readonly ReportReason[] = ['personal_info', 'copyright']

export const REPORT_DETAILS_MAX = 1000
export const MODERATION_NOTE_MAX = 1000
export const MODERATION_PUBLIC_REASON_MAX = 300
export const APPEAL_MESSAGE_MAX = 1000
export const ITEM_KEY_MAX = 64

/** 가린 항목 자리에 보여 줄 글. */
export const HIDDEN_ITEM_PLACEHOLDER = '운영 조치로 가려진 항목'

/** 대상 종류별로 고를 수 있는 조치. 'none'(조치 없음)은 모두 가능합니다. */
export const ACTIONS_BY_TARGET: Readonly<Record<ReportTargetType, readonly ModerationActionKind[]>> = {
  publication: ['none', 'restrict'],
  publication_item: ['none', 'hide_item', 'restrict'],
  senior_note: ['none', 'hide_note'],
  case_study: ['none', 'hide_case_study'],
  profile: ['none', 'hide_profile'],
  // 커뮤니티 공간(C-02): 공간 제한(읽기만, 목록·가입·쓰기 중지).
  community_space: ['none', 'restrict_space'],
  // 커뮤니티 글·댓글(C-04): 가리기(본문 대신 "운영 조치로 가려진 글입니다", 삭제 아님). 신고 누적 임시 숨김(auto_hidden)은 'none'으로 처리하면
  // 다시 보이고(복원), hide_post·hide_comment로 처리하면 가림이 확정됩니다(C-06). 제재는 작성자 확인 뒤 별도 경로(space_hide·sanction은 여기 없음).
  community_post: ['none', 'hide_post'],
  community_comment: ['none', 'hide_comment'],
  community_recruitment: ['none', 'hide_recruitment'],
  community_application: ['none', 'hide_application'],
  course_qa: ['none', 'hide_qa'],
  persona: ['none', 'hide_persona'],
  profile_post: ['none', 'hide_profile_post'],
  social_link: ['none', 'hide_social_link'],
  completion_retro: ['none', 'hide_retro'],
  room_item: ['none', 'hide_room_item'],
}

export function isActionApplicable(target: ReportTargetType, action: ModerationActionKind): boolean {
  return ACTIONS_BY_TARGET[target].includes(action)
}

/** 이 신고가 공개에 보류를 거는지: 공개 사례(또는 그 항목) + 개인정보·저작권 사유. */
export function reportCreatesHold(target: ReportTargetType, reason: ReportReason): boolean {
  return (target === 'publication' || target === 'publication_item') && HOLD_REASONS.includes(reason)
}

// ── 신고 상태 ────────────────────────────────────────────────────────────

export type ReportEvent = 'assign' | 'resolve' | 'dismiss'

/** 신고 상태 전이. 허용되지 않으면 null. 닫힌 신고(resolved/dismissed)는 다시 열지 않습니다(새 신고를 받음). */
export function reportTransition(status: ReportStatus, event: ReportEvent): ReportStatus | null {
  if (!isReportOpen(status)) return null
  switch (event) {
    case 'assign':
      return 'in_review'
    case 'resolve':
      return 'resolved'
    case 'dismiss':
      return 'dismissed'
  }
}

/** 처리 전(open·in_review)인지. 같은 사람·같은 대상의 처리 전 신고는 하나뿐입니다(중복이면 기존 신고를 돌려줌). */
export function isReportOpen(status: ReportStatus): boolean {
  return status === 'open' || status === 'in_review'
}

/** 신고자에게 보여 줄 상태(조치 내용은 알리지 않음). */
export function reporterVisibleStatus(status: ReportStatus): 'received' | 'in_review' | 'resolved' | 'dismissed' {
  return status === 'open' ? 'received' : status
}

/** 같은 대상을 묶는 키(중복 신고 판정·운영자 대기열 묶음). id는 소문자 uuid, 키는 스냅샷 키 그대로. */
export type ReportTargetIdentity =
  | { type: 'publication'; publicationId: string }
  | { type: 'publication_item'; publicationId: string; itemKind: HiddenItemKind; itemKey: string }
  | { type: 'senior_note'; seniorNoteId: string }
  | { type: 'case_study'; caseStudyId: string }
  | { type: 'profile'; userId: string }
  | { type: 'community_space'; spaceId: string }
  | { type: 'community_post'; postId: string }
  | { type: 'community_comment'; commentId: string }
  | { type: 'community_recruitment'; recruitmentId: string }
  | { type: 'community_application'; applicationId: string }
  | { type: 'course_qa'; courseQaId: string }
  | { type: 'persona'; personaId: string }
  | { type: 'profile_post'; profilePostId: string }
  | { type: 'social_link'; socialLinkId: string }
  | { type: 'completion_retro'; retroId: string }
  | { type: 'room_item'; kind: RoomItemKind; itemId: string }

export function reportTargetKey(target: ReportTargetIdentity): string {
  switch (target.type) {
    case 'publication':
      return `publication:${target.publicationId}`
    case 'publication_item':
      return `publication_item:${target.publicationId}:${target.itemKind}:${target.itemKey}`
    case 'senior_note':
      return `senior_note:${target.seniorNoteId}`
    case 'case_study':
      return `case_study:${target.caseStudyId}`
    case 'profile':
      return `profile:${target.userId}`
    case 'community_space':
      return `community_space:${target.spaceId}`
    case 'community_post':
      return `community_post:${target.postId}`
    case 'community_comment':
      return `community_comment:${target.commentId}`
    case 'community_recruitment':
      return `community_recruitment:${target.recruitmentId}`
    case 'community_application':
      return `community_application:${target.applicationId}`
    case 'course_qa':
      return `course_qa:${target.courseQaId}`
    case 'persona':
      return `persona:${target.personaId}`
    case 'profile_post':
      return `profile_post:${target.profilePostId}`
    case 'social_link':
      return `social_link:${target.socialLinkId}`
    case 'completion_retro':
      return `completion_retro:${target.retroId}`
    case 'room_item':
      return `room_item:${target.kind}:${target.itemId}`
  }
}

// ── 이의제기 ─────────────────────────────────────────────────────────────

export type AppealCheck = 'ok' | 'not_appealable' | 'already_appealed' | 'already_reversed'

/** 이 조치에 이의를 제기할 수 있는지(당사자 확인은 호출자가 함). 조치 없음은 대상이 아니고, 조치마다 한 번입니다. */
export function canAppeal(action: { kind: ModerationActionKind; reversed: boolean }, hasAppeal: boolean): AppealCheck {
  if (action.kind === 'none') return 'not_appealable'
  if (hasAppeal) return 'already_appealed'
  if (action.reversed) return 'already_reversed'
  return 'ok'
}

/** 이의 결정: 열린 이의만. 유지 → upheld, 되돌림 → reversed(호출자가 조치를 풂). */
export function appealTransition(status: AppealStatus, decision: AppealDecision): AppealStatus | null {
  if (status !== 'open') return null
  return decision === 'uphold' ? 'upheld' : 'reversed'
}

// ── 가린 항목(hide_item) ─────────────────────────────────────────────────

export interface HiddenItemRef {
  kind: HiddenItemKind
  key: string
}

/** 가린 항목 자리(공개 페이지가 원래 위치에 "운영 조치로 가려진 항목"을 그림). index는 원래 목록 안의 위치입니다. */
export interface HiddenItemPlaceholder extends HiddenItemRef {
  index: number
}

const refId = (kind: string, key: string) => `${kind}:${key}`

export function hiddenItemSet(hidden: readonly HiddenItemRef[]): ReadonlySet<string> {
  return new Set(hidden.map((h) => refId(h.kind, h.key)))
}

export function isItemHidden(hidden: ReadonlySet<string>, kind: string, key: string): boolean {
  return hidden.has(refId(kind, key))
}

interface RedactableLog {
  key: string
  resolves?: string | null
  evidence?: readonly string[]
}
type RedactableClaimEvidence = { kind: 'log'; log: string } | { kind: 'artifact'; artifactVersionId: string }
interface RedactableClaim {
  key: string
  evidence?: readonly RedactableClaimEvidence[]
}
interface RedactableArtifact {
  artifactVersionId: string
}
interface RedactableMilestone {
  snapshots?: ReadonlyArray<{ artifactVersionId: string }>
}

/** 공개 스냅샷 중 가리기에 필요한 부분(웹의 PublicSnapshot과 같은 모양). */
export interface RedactableSnapshot {
  logs: readonly RedactableLog[]
  claims: readonly RedactableClaim[]
  artifacts: readonly RedactableArtifact[]
  milestones: readonly RedactableMilestone[]
}

/**
 * 가린 항목을 스냅샷에서 뺀 사본과 자리 표시를 돌려줍니다. 공개 읽기(사례 페이지·파일·과목 허브·신호·포크·케이스 초안)는 저장된 스냅샷 대신
 * 이 사본을 씁니다. 가린 항목을 가리키는 참조(해결한 막힘·파일 근거·선언 근거·마일스톤 스냅샷)도 함께 지워 다른 항목을 통해 새지 않게 합니다.
 * 저장된 스냅샷(release)은 바꾸지 않습니다. 가린 것이 없으면 같은 객체를 그대로 돌려줍니다.
 */
export function redactHiddenItems<T extends RedactableSnapshot>(
  snapshot: T,
  hidden: readonly HiddenItemRef[],
): { snapshot: T; placeholders: HiddenItemPlaceholder[] } {
  if (hidden.length === 0) return { snapshot, placeholders: [] }
  const set = hiddenItemSet(hidden)
  const placeholders: HiddenItemPlaceholder[] = []
  const hiddenLog = (key: string | null | undefined) => !!key && set.has(refId('log', key))
  const hiddenArtifact = (id: string) => set.has(refId('artifact', id))

  snapshot.logs.forEach((l, index) => {
    if (hiddenLog(l.key)) placeholders.push({ kind: 'log', key: l.key, index })
  })
  snapshot.claims.forEach((c, index) => {
    if (set.has(refId('claim', c.key))) placeholders.push({ kind: 'claim', key: c.key, index })
  })
  snapshot.artifacts.forEach((a, index) => {
    if (hiddenArtifact(a.artifactVersionId)) placeholders.push({ kind: 'artifact', key: a.artifactVersionId, index })
  })
  if (placeholders.length === 0) return { snapshot, placeholders }

  const logs = snapshot.logs
    .filter((l) => !hiddenLog(l.key))
    .map((l) => ({
      ...l,
      ...(l.resolves !== undefined && { resolves: hiddenLog(l.resolves) ? null : l.resolves }),
      ...(l.evidence && { evidence: l.evidence.filter((id) => !hiddenArtifact(id)) }),
    }))
  const claims = snapshot.claims
    .filter((c) => !set.has(refId('claim', c.key)))
    .map((c) => ({
      ...c,
      ...(c.evidence && {
        evidence: c.evidence.filter((e) => (e.kind === 'log' ? !hiddenLog(e.log) : !hiddenArtifact(e.artifactVersionId))),
      }),
    }))
  const artifacts = snapshot.artifacts.filter((a) => !hiddenArtifact(a.artifactVersionId))
  const milestones = snapshot.milestones.map((m) =>
    m.snapshots ? { ...m, snapshots: m.snapshots.filter((s) => !hiddenArtifact(s.artifactVersionId)) } : m,
  )
  return { snapshot: { ...snapshot, logs, claims, artifacts, milestones } as T, placeholders }
}

/** 케이스 스터디 문장의 인용 중 가린 항목을 가리키는 것이 있는지(있으면 공개 화면에서 문장 전체를 자리 표시로 바꿈). */
export function citesHiddenItem(citations: ReadonlyArray<{ kind: string; key: string }>, hidden: ReadonlySet<string>): boolean {
  return citations.some((c) => hidden.has(refId(c.kind, c.key)))
}
