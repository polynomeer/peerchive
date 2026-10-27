/**
 * 항목별 공개 범위·과제 수행 목록 (S-03, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 VisibilitySetting·ProjectListing·§8.3,
 * DELIVERY_PLAN §4.2 S-03·§5.2 S, ADR 0031).
 *
 * - 공개 범위 항목은 네 가지(`project_list`·`posts`·`notes_and_studies`·`follow_lists`)뿐입니다. **공개 사례·케이스 스터디는 이 설정의 대상이
 *   아닙니다**(§8.3 불변조건 2): 공개 절차(동의·게시)를 거친 것만 나타나고, 이 설정으로 넓힐 수 없습니다.
 * - 다섯 단계 audience는 한 줄로 늘어선 범위입니다: public ⊃ signed_in ⊃ same_institution ⊃ approved_followers ⊃ private(본인만).
 *   §8.3 표의 "X 이상" 그대로, 보는 사람의 가까움(`viewerCloseness`)이 항목이 요구하는 가까움(`AUDIENCE_RANK`) 이상이면 봅니다.
 *   `follow_lists`는 public·private 두 단계만 받습니다.
 * - 기본값(행이 없을 때, 저장하지 않고 계산): `project_list`는 private, `posts`·`notes_and_studies`는 공개 계정이면 signed_in, 비공개 계정이면
 *   approved_followers. `follow_lists`는 signed_in을 받을 수 없어 private입니다. 계정 공개 설정을 바꾸면 기본값도 따라 바뀝니다.
 * - **비공개 계정**(`account_privacy = private`)은 저장한 값이 더 넓어도 모든 항목을 approved_followers 이하로 좁혀 적용합니다(§8.3 "Instagram식").
 * - `approved_followers`: 승인된(active) 팔로우가 있는 사용자입니다. social 모듈의 `personaViewerFor`가 팔로우 행으로 `approvedFollower`를
 *   채웁니다(S-04, ADR 0033). 대기 중(pending) 요청은 아무것도 넓히지 않습니다.
 * - 차단(S-04)은 `canViewPersona`가 먼저 404로 끊습니다(`blocked`: 페르소나 주인이 보는 사람을 차단했고 그 차단이 이 페르소나를 숨김).
 *
 * 런타임 의존성 없음.
 */

export const VISIBILITY_ITEM_KINDS = ['project_list', 'posts', 'notes_and_studies', 'follow_lists'] as const
export type VisibilityItemKind = (typeof VISIBILITY_ITEM_KINDS)[number]

export const VISIBILITY_AUDIENCES = ['public', 'signed_in', 'same_institution', 'approved_followers', 'private'] as const
export type VisibilityAudience = (typeof VISIBILITY_AUDIENCES)[number]

/** `follow_lists`가 받는 단계(§6.7.1). */
export const FOLLOW_LIST_AUDIENCES = ['public', 'private'] as const satisfies readonly VisibilityAudience[]

export const VISIBILITY_ITEM_LABELS: Readonly<Record<VisibilityItemKind, string>> = {
  project_list: '과제 수행 목록',
  posts: '공개 글',
  notes_and_studies: '선배 노트·스터디 기록',
  follow_lists: '팔로워·팔로잉 목록',
}

export const VISIBILITY_AUDIENCE_LABELS: Readonly<Record<VisibilityAudience, string>> = {
  public: '전체 공개',
  signed_in: '로그인 사용자',
  same_institution: '같은 기관',
  approved_followers: '승인한 팔로워',
  private: '비공개(나만)',
}

/** 항목이 요구하는 가까움. 숫자가 클수록 좁습니다. */
export const AUDIENCE_RANK: Readonly<Record<VisibilityAudience, number>> = {
  public: 0,
  signed_in: 1,
  same_institution: 2,
  approved_followers: 3,
  private: 4,
}

/** 공개 범위 항목 이름인지(공개 사례·케이스 스터디처럼 목록 밖의 이름은 false). */
export function isVisibilityItemKind(value: unknown): value is VisibilityItemKind {
  return typeof value === 'string' && (VISIBILITY_ITEM_KINDS as readonly string[]).includes(value)
}

/** 그 항목이 받는 audience인지. `follow_lists`는 public·private만. */
export function isAllowedAudience(itemKind: VisibilityItemKind, audience: unknown): audience is VisibilityAudience {
  if (typeof audience !== 'string') return false
  const allowed: readonly string[] = itemKind === 'follow_lists' ? FOLLOW_LIST_AUDIENCES : VISIBILITY_AUDIENCES
  return allowed.includes(audience)
}

export type AccountPrivacy = 'public' | 'private'

/** 행이 없을 때의 기본값(§6.7.1 초기안). */
export function defaultAudience(itemKind: VisibilityItemKind, accountPrivacy: AccountPrivacy): VisibilityAudience {
  if (itemKind === 'project_list') return 'private'
  // follow_lists는 signed_in을 받지 않으므로 두 단계 중 좁은 쪽(ADR 0031, S-04에서도 그대로 private: ADR 0033).
  if (itemKind === 'follow_lists') return 'private'
  return accountPrivacy === 'private' ? 'approved_followers' : 'signed_in'
}

/**
 * 실제로 적용할 audience: 저장한 값(없으면 기본값)을 비공개 계정이면 approved_followers 이하로 좁힙니다.
 * `follow_lists`도 비공개 계정에서는 approved_followers로 좁혀 적용합니다(저장 값은 public·private만).
 */
export function effectiveAudience(itemKind: VisibilityItemKind, stored: VisibilityAudience | null | undefined, accountPrivacy: AccountPrivacy): VisibilityAudience {
  const base = stored ?? defaultAudience(itemKind, accountPrivacy)
  if (accountPrivacy === 'private' && AUDIENCE_RANK[base] < AUDIENCE_RANK.approved_followers) return 'approved_followers'
  return base
}

/** 보는 사람과 페르소나 주인의 관계. 공개 경로(쿠키 없음)는 늘 `ANONYMOUS_VIEWER`입니다. */
export interface PersonaViewer {
  /** 페르소나 주인 본인. */
  isOwner: boolean
  /** 로그인한 사용자. */
  signedIn: boolean
  /** 열람자와 주인이 같은 정본 학교의 active 학교 인증(InstitutionAffiliation)을 가졌는지. */
  sameInstitution: boolean
  /** 이 페르소나의 승인된(active) 팔로워(보는 사람의 어느 페르소나로든, S-04). */
  approvedFollower: boolean
  /** 주인이 열람자를 차단했고 그 차단이 이 페르소나를 숨기는지(S-04, `blockHides`). */
  blocked: boolean
}

export const ANONYMOUS_VIEWER: Readonly<PersonaViewer> = Object.freeze({
  isOwner: false,
  signedIn: false,
  sameInstitution: false,
  approvedFollower: false,
  blocked: false,
})

/** 보는 사람의 가까움(0 비로그인 … 4 본인). 열이 겹치면(같은 기관이면서 팔로워) 가장 가까운 것. */
export function viewerCloseness(viewer: PersonaViewer): number {
  if (viewer.isOwner) return AUDIENCE_RANK.private
  if (!viewer.signedIn) return AUDIENCE_RANK.public
  if (viewer.approvedFollower) return AUDIENCE_RANK.approved_followers
  if (viewer.sameInstitution) return AUDIENCE_RANK.same_institution
  return AUDIENCE_RANK.signed_in
}

export interface PersonaFacts {
  status: 'active' | 'deactivated'
  accountPrivacy: AccountPrivacy
}

/** 프로필 기본 정보(이름·소개)를 볼 수 있는지(§8.3 첫 줄). 비활성 페르소나·차단당한 사용자는 404. 본인은 차단과 무관. */
export function canViewPersona(persona: PersonaFacts, viewer: PersonaViewer): boolean {
  if (persona.status !== 'active') return false
  if (viewer.isOwner) return true
  return !viewer.blocked
}

/**
 * 항목(과제 수행 목록·공개 글·선배 노트·스터디 기록·팔로우 목록)을 볼 수 있는지(§8.3 셋째·넷째 줄). `canViewPersona`가 먼저입니다.
 * `stored`는 그 항목의 VisibilitySetting(없으면 null → 기본값).
 */
export function canViewPersonaItem(
  persona: PersonaFacts,
  itemKind: VisibilityItemKind,
  stored: VisibilityAudience | null | undefined,
  viewer: PersonaViewer,
): boolean {
  if (!canViewPersona(persona, viewer)) return false
  if (viewer.isOwner) return true
  return viewerCloseness(viewer) >= AUDIENCE_RANK[effectiveAudience(itemKind, stored, persona.accountPrivacy)]
}

// ── 과제 수행 목록(ProjectListing) ───────────────────────────────────────

export interface ListableProjectFacts {
  kind: 'individual' | 'team' | 'study'
  /** 스터디 기록일 때 방의 지금 이름 표시 방식(C-08). */
  studyNameMode: 'real' | 'display' | 'anonymous' | null
  /** 요청자의 멤버십 상태. */
  membershipStatus: 'invited' | 'active' | 'left' | 'removed'
}

export type ListingBlock = 'not_member' | 'anonymous_study' | 'display_study' | 'display_persona'

/**
 * 과제를 과제 수행 목록에 올릴 수 있는지. 실명 페르소나만(표시명 프로필에 팀 과제를 올리면 팀원이 두 프로필을 이을 수 있음, ADR 0031),
 * active 멤버만, `anonymous` 스터디 방의 내부 과제는 불가(ADR 0026). `display` 스터디 방의 과제도 실명 목록에 올리면 그 방의 표시명과
 * 실명 프로필이 이어지므로 불가입니다. 읽을 때도 같은 함수로 다시 거릅니다(방 이름 표시 방식이 나중에 바뀌어도).
 */
export function listingBlock(personaKind: 'real' | 'display', project: ListableProjectFacts): ListingBlock | null {
  if (personaKind !== 'real') return 'display_persona'
  if (project.membershipStatus !== 'active') return 'not_member'
  if (project.kind === 'study' && project.studyNameMode !== 'real') return project.studyNameMode === 'display' ? 'display_study' : 'anonymous_study'
  return null
}
