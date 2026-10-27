/**
 * 팔로우·비공개 계정·차단·뮤트 (S-04, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 Follow·Block·Mute·§8.3, DELIVERY_PLAN §4.2 S-04·§5.2 T·U,
 * ADR 0033).
 *
 * - **팔로우는 페르소나 → 페르소나**입니다. 팔로우 주체 페르소나는 요청자가 직접 고르고(실명 또는 표시명), 같은 사용자의 페르소나끼리는 팔로우할 수
 *   없습니다(DB check도 같음). 비로그인 사용자는 팔로우할 수 없습니다.
 * - 공개 계정은 바로 `active`, 비공개 계정은 `pending` → 주인이 승인하면 `active`. 비공개 → 공개로 바꿔도 대기 중인 요청은 자동 승인하지 않습니다
 *   (주인에게 묻고, 모두 승인·모두 거절·그대로 두기 중 고름).
 * - **차단**은 사용자 단위로 저장하고, 숨김 범위는 기본으로 차단을 건 내 페르소나(`origin_persona`)입니다. `all_personas`는 고를 때만이며,
 *   연결이 비공개이면 "다른 프로필까지 숨기면 같은 사람임이 추정될 수 있습니다"를 확인받아야 합니다(`blockNeedsLinkConfirm`).
 *   숨겨진 페르소나는 차단당한 사용자에게 404이고(`canViewPersona`의 `blocked`), 그 페르소나를 팔로우할 수도 없습니다.
 * - 팔로워 삭제·요청 거절·차단·뮤트는 상대에게 알리지 않습니다(알림 경로 자체가 없음).
 *
 * 런타임 의존성 없음.
 */
import type { AccountPrivacy, PersonaFacts, PersonaViewer } from './visibility'

export const FOLLOW_STATUSES = ['pending', 'active'] as const
export type FollowStatus = (typeof FOLLOW_STATUSES)[number]

export const BLOCK_SCOPES = ['origin_persona', 'all_personas'] as const
export type BlockScope = (typeof BLOCK_SCOPES)[number]

export const BLOCK_SCOPE_LABELS: Readonly<Record<BlockScope, string>> = {
  origin_persona: '이 프로필에서만',
  all_personas: '내 모든 프로필에서',
}

/** `all_personas`를 고를 때 연결이 비공개이면 보여 주는 경고(API는 확인 플래그 없이 받으면 422). */
export const BLOCK_LINK_WARNING = '다른 프로필까지 숨기면 같은 사람임이 추정될 수 있습니다'

/** 팔로우 요청 생성 한도(사용자당). 대량 팔로우·요청 스팸을 막습니다. */
export const FOLLOW_RATE_LIMIT = { limit: 60, windowMs: 60 * 60 * 1000 } as const

/**
 * 팔로우를 막는 이유. `not_found`는 대상이 비활성이거나 대상 주인이 요청자를 차단한 경우입니다(존재를 드러내지 않음). `acting_persona`는 주체
 * 페르소나가 요청자의 것이 아니거나 비활성인 경우입니다.
 */
export type FollowDenial = 'signed_out' | 'not_found' | 'acting_persona' | 'own_persona' | 'blocked_by_you'

export interface FollowFacts {
  /** 요청자가 로그인했는지. */
  signedIn: boolean
  /** 팔로우 주체 페르소나(요청자의 것이어야 함). 요청자의 것이 아니거나 없으면 null. */
  acting: Pick<PersonaFacts, 'status'> | null
  /** 대상 페르소나. */
  target: PersonaFacts
  /** 대상의 주인이 요청자 본인인지(자기 페르소나·같은 사용자의 다른 페르소나). */
  sameUser: boolean
  /** 대상 주인이 요청자를 차단해 이 대상 페르소나가 요청자에게 숨겨졌는지(`PersonaViewer.blocked`). */
  targetHidden: boolean
  /**
   * 요청자가 **바로 이 대상 페르소나**를 차단해 두었는지. 요청자가 아는 것만 봅니다: 같은 상대의 다른 페르소나를 차단했다는 사실로 막으면
   * "그 페르소나가 같은 사람"이라는 것을 요청자에게 알려 주게 됩니다(ADR 0033).
   */
  blockedByActor: boolean
}

export type FollowDecision = { ok: true; status: FollowStatus } | { ok: false; reason: FollowDenial }

/** 팔로우할 수 있는지와, 된다면 처음 상태(공개 계정 active, 비공개 계정 pending). §8.3 "팔로우 요청" 줄. */
export function decideFollow(facts: FollowFacts): FollowDecision {
  if (!facts.signedIn) return { ok: false, reason: 'signed_out' }
  if (facts.target.status !== 'active' || facts.targetHidden) return { ok: false, reason: 'not_found' }
  if (!facts.acting || facts.acting.status !== 'active') return { ok: false, reason: 'acting_persona' }
  if (facts.sameUser) return { ok: false, reason: 'own_persona' }
  if (facts.blockedByActor) return { ok: false, reason: 'blocked_by_you' }
  return { ok: true, status: initialFollowStatus(facts.target.accountPrivacy) }
}

/** §8.3 `canFollow`: 팔로우 요청을 보낼 수 있는지. */
export function canFollow(facts: FollowFacts): boolean {
  return decideFollow(facts).ok
}

export function initialFollowStatus(accountPrivacy: AccountPrivacy): FollowStatus {
  return accountPrivacy === 'private' ? 'pending' : 'active'
}

/** 공개 응답에 팔로워·팔로잉 수를 실을지. 본인에게는 늘, 다른 사람에게는 `show_follower_count`일 때만(끄면 키 자체가 없음). */
export function showsFollowCounts(persona: { showFollowerCount: boolean }, viewer: Pick<PersonaViewer, 'isOwner'>): boolean {
  return viewer.isOwner || persona.showFollowerCount
}

export interface BlockFacts {
  scope: BlockScope
  originPersonaId: string
}

/** 이 차단이 그 페르소나(차단한 사람의 것)를 차단당한 사람에게 숨기는지. */
export function blockHides(block: BlockFacts, personaId: string): boolean {
  return block.scope === 'all_personas' || block.originPersonaId === personaId
}

/**
 * `all_personas` 차단에 연결 추정 경고 확인이 필요한지. 다른 페르소나가 있고 연결이 공개되지 않았을 때만입니다(연결을 공개했거나 페르소나가 하나면
 * 이미 알려진 것 이상을 드러내지 않음).
 */
export function blockNeedsLinkConfirm(scope: BlockScope, link: { hasOtherPersona: boolean; visible: boolean }): boolean {
  return scope === 'all_personas' && link.hasOtherPersona && !link.visible
}
