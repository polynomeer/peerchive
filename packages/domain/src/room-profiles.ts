/**
 * 동문회·OB 방 템플릿과 방별 프로필·신분 배지 (A-01, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 RoomProfile, DELIVERY_PLAN §4.3, ADR 0038).
 *
 * - 사용자 방에 `template`(general/alumni)을 둡니다. alumni는 사용자 방에서만, P2 `alumni` 플래그가 켜져 있을 때만 만듭니다.
 * - **방별 프로필(RoomProfile)**: alumni 방의 active 멤버가 스스로 만듭니다. 방 멤버에게만 보이고 페르소나·PersonaActivity·공개 프로필·
 *   검색·피드와 연결하지 않습니다(커뮤니티 구역 테이블, ADR 0029 경계).
 *   - `real` 방: 이름은 실명으로 고정(방별 이름을 받지 않음 → 422 `name_fixed`). 배지·기수·소개만 방별.
 *   - `display` 방: 방별 이름 필수(1~30자). 계정 표시 이름·핸들은 쓰지 않습니다.
 *   - `anonymous` 방: 방별 프로필이 없습니다(만들기·목록 409, 익명 방으로 바뀌면 worker가 지움).
 * - **배지**: `current`(현역)·`ob`(OB)·`alumni`(졸업생)는 자기 신고이고 현역·OB는 함께 고를 수 없습니다. `cohort`(n기)는 저장하지 않고
 *   기수가 있으면 붙입니다. 사용자가 "인증" 배지를 고를 수는 없습니다. 학교를 연결한 방에서 졸업생 배지를 고른 사람이 그 학교의 active
 *   졸업생(alumni) 인증이 있으면 읽을 때 `alumniVerified`를 붙입니다(저장하지 않음).
 * - **기수**: 자기 신고. 방장·운영진(admin)이 고칠 수 있고, 모든 기수 변경은 이력(누가·언제·이전→이후)을 남깁니다. 이력은 방장·운영진과 본인만 봅니다.
 *
 * 런타임 의존성 없음.
 */
import type { NameMode, SpaceKind, SpaceRole } from './community'

export const SPACE_TEMPLATES = ['general', 'alumni'] as const
export type SpaceTemplate = (typeof SPACE_TEMPLATES)[number]
export const SPACE_TEMPLATE_LABELS: Readonly<Record<SpaceTemplate, string>> = { general: '일반', alumni: '동문회·OB' }

/** 저장하는 배지(자기 신고). */
export const ROOM_STORED_BADGES = ['current', 'ob', 'alumni'] as const
export type RoomStoredBadge = (typeof ROOM_STORED_BADGES)[number]
/** 화면·API의 배지(기수가 있으면 cohort). */
export const ROOM_BADGES = ['current', 'ob', 'alumni', 'cohort'] as const
export type RoomBadge = (typeof ROOM_BADGES)[number]
export const ROOM_BADGE_LABELS: Readonly<Record<RoomBadge, string>> = { current: '현역', ob: 'OB', alumni: '졸업생', cohort: '기수' }

export const ROOM_PROFILE_NAME_MAX = 30
export const ROOM_COHORT_LABEL_MAX = 20
export const ROOM_PROFILE_BIO_MAX = 200
/** display 방에서 방별 이름이 없을 때(실명 방에서 만든 뒤 표시명 방으로 바뀐 경우). */
export const ROOM_PROFILE_NAME_MISSING_LABEL = '방별 이름 없음'

/** 템플릿을 쓸 수 있는 공간 종류: alumni는 사용자 방만. */
export function templateAllowed(kind: SpaceKind, template: SpaceTemplate): boolean {
  return template === 'general' || kind === 'user_room'
}

/** 방별 프로필을 쓰는 방인지: alumni 템플릿이고 지금 효력이 있는 이름 표시 방식이 익명이 아님. */
export function roomProfilesAvailable(template: SpaceTemplate, effectiveMode: NameMode): boolean {
  return template === 'alumni' && (effectiveMode === 'real' || effectiveMode === 'display')
}

/** 다른 멤버의 기수를 고칠 수 있는 역할(방장·운영진). */
export function canEditMemberCohort(role: SpaceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/** 기수 변경 이력을 볼 수 있는지: 방장·운영진, 또는 그 프로필의 본인. */
export function canViewCohortHistory(role: SpaceRole | null | undefined, isSubject: boolean): boolean {
  return isSubject || canEditMemberCohort(role)
}

/** 저장한 배지 + 기수 → 화면 배지(정해진 순서). */
export function displayBadges(stored: readonly string[], cohortLabel: string | null): RoomBadge[] {
  const out: RoomBadge[] = ROOM_STORED_BADGES.filter((b) => stored.includes(b))
  if (cohortLabel) out.push('cohort')
  return out
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const oneLine = (v: string) => v.normalize('NFC').replace(/\s+/g, ' ').trim()

export type RoomTextCheck = { ok: true; value: string | null } | { ok: false; reason: 'invalid' | 'too_long' }

/** 한 줄 글(이름·기수): NFC·공백 하나로·길이·제어 문자. 빈 값·null은 null. */
export function checkOneLine(raw: unknown, max: number): RoomTextCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string' || CONTROL.test(raw) || /[\n\r]/.test(raw)) return { ok: false, reason: 'invalid' }
  const value = oneLine(raw)
  if (!value) return { ok: true, value: null }
  if ([...value].length > max) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

/** 소개: 줄바꿈 허용, 앞뒤 공백 제거. */
export function checkBio(raw: unknown): RoomTextCheck {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string' || CONTROL.test(raw)) return { ok: false, reason: 'invalid' }
  const value = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (!value) return { ok: true, value: null }
  if ([...value].length > ROOM_PROFILE_BIO_MAX) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

export interface RoomProfileValue {
  displayName: string | null
  badges: RoomStoredBadge[]
  cohortLabel: string | null
  bio: string | null
}

export type RoomProfileCheck = { ok: true; value: RoomProfileValue } | { ok: false; fields: Record<string, string> }

/**
 * 방별 프로필 입력 검사. `mode`는 지금 효력이 있는 이름 표시 방식(anonymous는 호출 전에 거름).
 * - real: displayName이 있으면 `name_fixed`(이름은 실명으로 고정).
 * - display: displayName 필수(`required`).
 * - badges: 배열·중복 없음·허용 값만(`invalid`), 현역·OB 함께 고르면 `conflict`. `cohort`·인증 배지는 고를 수 없음(`invalid`).
 */
export function checkRoomProfileInput(raw: { displayName?: unknown; badges?: unknown; cohortLabel?: unknown; bio?: unknown }, mode: Exclude<NameMode, 'anonymous'>): RoomProfileCheck {
  const fields: Record<string, string> = {}
  const name = checkOneLine(raw.displayName, ROOM_PROFILE_NAME_MAX)
  if (!name.ok) fields.displayName = name.reason
  else if (mode === 'real' && name.value !== null) fields.displayName = 'name_fixed'
  else if (mode === 'display' && name.value === null) fields.displayName = 'required'
  let badges: RoomStoredBadge[] = []
  if (raw.badges !== undefined && raw.badges !== null) {
    if (!Array.isArray(raw.badges) || raw.badges.some((b) => typeof b !== 'string' || !(ROOM_STORED_BADGES as readonly string[]).includes(b)) || new Set(raw.badges).size !== raw.badges.length) {
      fields.badges = 'invalid'
    } else {
      badges = ROOM_STORED_BADGES.filter((b) => (raw.badges as string[]).includes(b))
      if (badges.includes('current') && badges.includes('ob')) fields.badges = 'conflict'
    }
  }
  const cohort = checkOneLine(raw.cohortLabel, ROOM_COHORT_LABEL_MAX)
  if (!cohort.ok) fields.cohortLabel = cohort.reason
  const bio = checkBio(raw.bio)
  if (!bio.ok) fields.bio = bio.reason
  if (Object.keys(fields).length || !name.ok || !cohort.ok || !bio.ok) return { ok: false, fields }
  return { ok: true, value: { displayName: mode === 'real' ? null : name.value, badges, cohortLabel: cohort.value, bio: bio.value } }
}
