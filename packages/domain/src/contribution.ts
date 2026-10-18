/**
 * 기여 확인 규칙 (SYSTEM_DESIGN §6.4, §7.3).
 *
 * - 확인(Endorsement)은 특정 ClaimRevision에 붙습니다.
 * - 새 revision이 생기면 이전 확인은 승계되지 않고 현재 선언은 unconfirmed로 시작합니다.
 * - 자기 확인은 불가하며, 같은 프로젝트의 active 멤버만 확인할 수 있습니다.
 */

import type { Membership } from './permissions'

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
  const latest = latestRevision(claim)
  if (!latest || latest.id !== claimRevisionId) {
    return { ok: false, error: { code: 'REVISION_NOT_CURRENT', currentRevisionId: latest?.id ?? null } }
  }
  return { ok: true, endorsement: { claimRevisionId, endorserId, status } }
}
