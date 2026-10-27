/**
 * 신고·보류·운영 조치·이의제기 규칙 (T-15, PROOFU_EVOLUTION_PLAN §9.4 "동의 철회·신고"·§15, SYSTEM_DESIGN §6.6 Report·AuditEvent·
 * §7.2 published → restricted / restricted → draft·§8 운영 예외, DELIVERY_PLAN T-15 "public 상태만 검색, 조치·이의제기·audit 기록", ADR 0015).
 *
 * - 신고 대상은 **지금 공개인 것**뿐입니다(공개 사례·그 안의 항목·게시된 선배 노트·게시된 케이스 스터디·공개 프로필). 비공개 작업 공간은 대상이 아닙니다.
 *   예외: 커뮤니티 공간(`community_space`, C-02)은 공개가 아니라 **신고자가 읽을 수 있는(또는 소개를 볼 수 있는) 공간**이 대상이고, 조치는 공간 제한입니다.
 * - 운영 조치는 "공개 차단"만 합니다(공개 제한·항목 가리기·노트/케이스/프로필 숨김). 삭제는 별도의 명시적 조치이며 여기에 없습니다(차단 ≠ 삭제, §8).
 * - 개인정보·저작권 신고는 그 공개에 **보류(hold)**를 걸어 신고가 처리될 때까지 게시·새 버전 게시를 막습니다(도메인 `hasOpenHold`).
 * - 이의제기는 조치마다 한 번, 조치의 당사자(공개 owner·노트/케이스 작성자·프로필 주인)만 합니다. 되돌리면 조치를 풉니다
 *   (공개 제한은 restricted → draft: owner가 후보·동의·게시를 다시 합니다).
 * 런타임 의존성이 없고, 스냅샷 타입은 필요한 부분만 구조적으로 선언합니다.
 */

export const REPORT_TARGET_TYPES = ['publication', 'publication_item', 'senior_note', 'case_study', 'profile', 'community_space'] as const
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number]

export const REPORT_REASONS = ['personal_info', 'answer_sharing', 'copyright', 'harassment', 'false_claim', 'spam', 'other'] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

export const REPORT_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const
export type ReportStatus = (typeof REPORT_STATUSES)[number]

export const MODERATION_ACTION_KINDS = ['none', 'restrict', 'hide_item', 'hide_note', 'hide_case_study', 'hide_profile', 'restrict_space'] as const
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
  // 커뮤니티 공간(C-02): 공간 제한(읽기만, 목록·가입·쓰기 중지). 글·댓글 신고는 C-06.
  community_space: ['none', 'restrict_space'],
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
