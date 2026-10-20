/**
 * 기여 확인 규칙 (PROOFU_EVOLUTION_PLAN §7, SYSTEM_DESIGN §6.4, §7.3, §8, T-08).
 *
 * - 확인(Endorsement)은 특정 ClaimRevision에 붙습니다.
 * - 새 revision이 생기면 이전 확인은 승계되지 않고 현재 선언은 unconfirmed로 시작합니다.
 * - 자기 확인은 불가하며, 같은 프로젝트의 active 멤버만 확인할 수 있습니다.
 * - 역할 선언·확인은 active owner/editor/reviewer가 합니다. viewer는 읽기만 합니다(쓰기는 403).
 *   reviewer는 로그를 쓰지 않지만 리뷰·멘토링도 역할이므로 자기 역할을 선언할 수 있고, 팀원의 선언을 확인할 수 있습니다.
 * - 선언 수정(새 revision)은 작성자 본인만. owner도 남의 선언을 고칠 수 없습니다(관리자 우회 없음).
 * - 이의(disputed)가 하나라도 있으면 확인 수와 상관없이 `이의 있음`입니다.
 * - 활동량을 점수·비율·순위로 바꾸지 않습니다. 장부는 종류별 개수와 근거만 보여 주고 이름순으로 정렬합니다.
 */

import { type Membership, type ProjectRef, type ProjectRole, type Viewer, canReadProjectWorkspace } from './permissions'
import { type ScanStatus, canAttachAsEvidence } from './artifacts'

// ── 한도 ────────────────────────────────────────────────────────────────

/** 프로젝트·멤버당 역할 선언 최대 개수. */
export const CLAIM_LIMIT_PER_MEMBER = 10
/** 선언 문장 최대 길이. */
export const CLAIM_TEXT_MAX = 300
/** 선언 revision당 근거 최대 개수(로그 + 파일). */
export const CLAIM_EVIDENCE_MAX = 20
/** 확인·이의 메모 최대 길이. */
export const ENDORSEMENT_NOTE_MAX = 500

// ── 권한 ────────────────────────────────────────────────────────────────

/** 역할 선언·확인을 할 수 있는 역할. viewer는 읽기만 합니다. */
export const CLAIM_ROLES: readonly ProjectRole[] = ['owner', 'editor', 'reviewer']

function hasClaimRole(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && CLAIM_ROLES.includes(membership!.role)
}

/** 자기 역할 선언: active owner/editor/reviewer. 선언은 언제나 요청자 본인의 것으로 만듭니다. */
export function canDeclareClaim(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return hasClaimRole(viewer, project, membership)
}

/** 판정에 필요한 선언 정보. */
export interface ClaimRef {
  projectId: string
  /** 선언한 사용자. */
  userId: string
}

/** 선언 수정(새 revision): 작성자 본인이 지금도 같은 프로젝트의 active owner/editor/reviewer일 때만. owner 우회 없음. */
export function canReviseClaim(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  claim: ClaimRef,
): boolean {
  if (claim.projectId !== project.id) return false
  if (viewer.userId === null || claim.userId !== viewer.userId) return false
  return hasClaimRole(viewer, project, membership)
}

/** 확인·이의·철회: 작성자가 아닌 같은 프로젝트의 active owner/editor/reviewer. */
export function canEndorse(
  viewer: Viewer,
  project: ProjectRef,
  membership: Membership | null | undefined,
  claim: ClaimRef,
): boolean {
  if (claim.projectId !== project.id) return false
  if (viewer.userId === null || claim.userId === viewer.userId) return false
  return hasClaimRole(viewer, project, membership)
}

export interface ClaimRevision {
  id: string
  revisionNo: number
}

export interface RoleClaim {
  id: string
  projectId: string
  /** 역할을 주장한 사용자. */
  userId: string
  revisions: readonly ClaimRevision[]
}

export type EndorsementStatus = 'confirmed' | 'disputed' | 'withdrawn'

export interface Endorsement {
  claimRevisionId: string
  endorserId: string
  status: EndorsementStatus
}

export type ClaimStatus = 'unconfirmed' | 'confirmed' | 'disputed'

export function latestRevision(claim: RoleClaim): ClaimRevision | undefined {
  let latest: ClaimRevision | undefined
  for (const revision of claim.revisions) {
    if (!latest || revision.revisionNo > latest.revisionNo) latest = revision
  }
  return latest
}

/** 최신 revision에 대해 다른 사람이 남긴 유효한 확인만 남깁니다(자기 확인은 방어적으로 제외). */
function currentEndorsements(claim: RoleClaim, endorsements: readonly Endorsement[]): Endorsement[] {
  const latest = latestRevision(claim)
  if (!latest) return []
  return endorsements.filter((e) => e.claimRevisionId === latest.id && e.endorserId !== claim.userId)
}

export function claimStatus(claim: RoleClaim, endorsements: readonly Endorsement[]): ClaimStatus {
  const current = currentEndorsements(claim, endorsements)
  if (current.some((e) => e.status === 'disputed')) return 'disputed'
  if (current.some((e) => e.status === 'confirmed')) return 'confirmed'
  return 'unconfirmed'
}

/** 최신 revision에 다른 멤버의 확인이 있고 이의가 없을 때만 true. */
export function isClaimConfirmed(claim: RoleClaim, endorsements: readonly Endorsement[]): boolean {
  return claimStatus(claim, endorsements) === 'confirmed'
}

export type EndorsementError =
  | { code: 'SELF_ENDORSEMENT' }
  | { code: 'NOT_PROJECT_MEMBER' }
  /** 멤버지만 확인할 수 없는 역할(viewer). */
  | { code: 'READ_ONLY_ROLE' }
  | { code: 'REVISION_NOT_CURRENT'; currentRevisionId: string | null }

export type EndorsementResult = { ok: true; endorsement: Endorsement } | { ok: false; error: EndorsementError }

/**
 * 확인 요청 검증. 저장 전에 서버가 호출합니다.
 * `endorserMembership`은 확인하려는 사용자의 해당 프로젝트 멤버십(없으면 null)입니다.
 */
export function endorseClaim(input: {
  claim: RoleClaim
  claimRevisionId: string
  endorserId: string
  endorserMembership: Membership | null
  status: Exclude<EndorsementStatus, 'withdrawn'>
}): EndorsementResult {
  const { claim, claimRevisionId, endorserId, endorserMembership, status } = input
  if (endorserId === claim.userId) return { ok: false, error: { code: 'SELF_ENDORSEMENT' } }
  if (
    !endorserMembership ||
    endorserMembership.userId !== endorserId ||
    endorserMembership.projectId !== claim.projectId ||
    endorserMembership.status !== 'active'
  ) {
    return { ok: false, error: { code: 'NOT_PROJECT_MEMBER' } }
  }
  if (!CLAIM_ROLES.includes(endorserMembership.role)) return { ok: false, error: { code: 'READ_ONLY_ROLE' } }
  const latest = latestRevision(claim)
  if (!latest || latest.id !== claimRevisionId) {
    return { ok: false, error: { code: 'REVISION_NOT_CURRENT', currentRevisionId: latest?.id ?? null } }
  }
  return { ok: true, endorsement: { claimRevisionId, endorserId, status } }
}

/** 현재 revision 기준 상태와 확인·이의 수. 화면은 "팀원 확인 N명"처럼 사람 수로만 보여 줍니다(비율 없음). */
export interface ClaimStatusSummary {
  status: ClaimStatus
  confirmedCount: number
  disputedCount: number
}

export function claimStatusSummary(claim: RoleClaim, endorsements: readonly Endorsement[]): ClaimStatusSummary {
  const current = currentEndorsements(claim, endorsements)
  return {
    status: claimStatus(claim, endorsements),
    confirmedCount: current.filter((e) => e.status === 'confirmed').length,
    disputedCount: current.filter((e) => e.status === 'disputed').length,
  }
}

/**
 * 한 revision만 놓고 본 상태(이력 표시용). 이전 revision의 확인은 그 revision에만 남아 있다는 것을 보여 줄 때 씁니다.
 */
export function revisionStatus(
  claim: Pick<RoleClaim, 'userId'>,
  claimRevisionId: string,
  endorsements: readonly Endorsement[],
): ClaimStatus {
  return claimStatus({ id: '', projectId: '', userId: claim.userId, revisions: [{ id: claimRevisionId, revisionNo: 1 }] }, endorsements)
}

// ── 근거 ────────────────────────────────────────────────────────────────

/**
 * 근거로 고른 대상(서버가 DB에서 읽은 값). 없거나 읽을 수 없으면 null.
 * - log: 같은 프로젝트의 빌드 로그. 저장할 때 그 로그의 현재 revision을 가리키도록 고정합니다.
 * - artifact: 같은 프로젝트의 산출물 버전.
 */
export type ClaimEvidenceTarget =
  | { kind: 'log'; projectId: string }
  | { kind: 'artifact'; projectId: string; scanStatus: ScanStatus }

export type ClaimEvidenceCheck = 'ok' | 'not_found' | 'not_attachable'

/**
 * 근거 판정.
 * - 없거나 다른 프로젝트 것이면 `not_found`(다른 프로젝트 자료의 존재를 드러내지 않도록 구분하지 않음).
 * - 파일은 검사 대기·검사 중·사용 가능만(검사 중은 "검사 중"으로 표시), 격리·실패는 `not_attachable`.
 *   이전 revision에서 이어받은 파일(`inherited`)은 상태를 다시 보지 않습니다(빌드 로그 근거와 같은 규칙).
 */
export function checkClaimEvidenceTarget(
  projectId: string,
  target: ClaimEvidenceTarget | null | undefined,
  options: { inherited?: boolean } = {},
): ClaimEvidenceCheck {
  if (!target || target.projectId !== projectId) return 'not_found'
  if (target.kind === 'artifact' && !options.inherited && !canAttachAsEvidence(target.scanStatus)) return 'not_attachable'
  return 'ok'
}

// ── 기간(주간 요약·리포트) ───────────────────────────────────────────────

/** 기간 계산 기준 시간대. 한국은 일광 절약 시간이 없어 UTC+9 고정입니다. */
export const CONTRIBUTION_TIME_ZONE = 'Asia/Seoul'
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** 조회 기간 최대 길이(일). 한 학기 + 여유. */
export const CONTRIBUTION_PERIOD_MAX_DAYS = 366

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`)

/** 그 시각의 서울 날짜(YYYY-MM-DD). */
export function seoulDate(at: Date): string {
  return isoDate(at.getTime() + SEOUL_OFFSET_MS)
}

/** 서울 날짜 하나를 더하거나 뺍니다. */
export function addDays(date: string, days: number): string {
  return isoDate(dateMs(date) + days * DAY_MS)
}

/**
 * 그 시각이 속한 ISO 주(월요일~일요일, 서울 날짜). `weeksAgo`만큼 앞선 주를 돌려줄 수 있습니다(지난주 = 1).
 */
export function seoulWeek(at: Date, weeksAgo = 0): { from: string; to: string } {
  const today = seoulDate(at)
  const weekday = (new Date(dateMs(today)).getUTCDay() + 6) % 7 // 월요일 0 … 일요일 6
  const from = addDays(today, -weekday - weeksAgo * 7)
  return { from, to: addDays(from, 6) }
}

/**
 * 서울 날짜 구간 [from, to](양 끝 포함)을 UTC 시각 반열린 구간 [start, end)로 바꿉니다.
 * 기록은 플랫폼 기록 시각(created_at 등)으로 이 구간에 넣습니다.
 */
export function periodBounds(from: string, to: string): { start: Date; end: Date } {
  return { start: new Date(dateMs(from) - SEOUL_OFFSET_MS), end: new Date(dateMs(to) + DAY_MS - SEOUL_OFFSET_MS) }
}

export type PeriodCheck = 'ok' | 'before_from' | 'too_long'

/** 기간 판정: to가 from보다 앞서면 `before_from`, 366일을 넘으면 `too_long`. */
export function checkPeriod(from: string, to: string): PeriodCheck {
  const days = (dateMs(to) - dateMs(from)) / DAY_MS + 1
  if (days < 1) return 'before_from'
  return days > CONTRIBUTION_PERIOD_MAX_DAYS ? 'too_long' : 'ok'
}

/**
 * 기간이 프로젝트 몇 주차인지(프로젝트를 만든 주가 1주차). 기간이 정확히 월~일 한 주가 아니면 null.
 */
export function projectWeekNo(projectCreatedAt: Date, from: string, to: string): number | null {
  const week = seoulWeek(new Date(dateMs(from)))
  if (week.from !== from || week.to !== to) return null
  const start = seoulWeek(projectCreatedAt).from
  const n = Math.round((dateMs(from) - dateMs(start)) / (7 * DAY_MS)) + 1
  return n >= 1 ? n : null
}

/** 막힘이 열린 지 며칠째인지(만든 날이 1일째, 서울 날짜 기준). */
export function openDays(createdAt: Date, asOf: Date): number {
  return Math.max(1, Math.round((dateMs(seoulDate(asOf)) - dateMs(seoulDate(createdAt))) / DAY_MS) + 1)
}

// ── 장부 정렬 ────────────────────────────────────────────────────────────

const nameCollator = new Intl.Collator('ko', { sensitivity: 'base', numeric: true })

/**
 * 장부의 멤버 순서: 이름순(같으면 userId). 활동량으로 정렬하지 않습니다(순위가 생기면 로그 쪼개기 같은 게이밍이 생김).
 */
export function orderMembersByName<T extends { displayName: string; userId: string }>(members: readonly T[]): T[] {
  return [...members].sort(
    (a, b) => nameCollator.compare(a.displayName, b.displayName) || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  )
}

/**
 * 장부에 넣을 멤버인지. active 멤버는 기간 중 기록이 없어도 넣고("기록 없음"), 나간·내보낸 멤버는
 * 그 기간에 남긴 기록이나 선언이 있을 때만 넣습니다(사실 기록은 남기되, 떠난 사람을 빈 줄로 계속 보여 주지 않음).
 * 초대만 받은 사람은 넣지 않습니다.
 */
export function includeInLedger(status: Membership['status'], hasActivity: boolean): boolean {
  if (status === 'active') return true
  if (status === 'left' || status === 'removed') return hasActivity
  return false
}
