import { describe, expect, it } from 'vitest'
import {
  NAME_MODES,
  NAME_MODE_CHANGE_DELAY_MS,
  DISPLAY_PERSONA_MISSING_LABEL,
  REAL_NAME_MISSING_LABEL,
  WITHDRAWN_AUTHOR_LABEL,
  type AuthorProfileBits,
  type NameMode,
  type ScheduledChangeFacts,
  canCancelNameModeChange,
  canManageSpace,
  checkNameModeTransition,
  checkRealName,
  daysUntil,
  effectiveNameMode,
  isNameModeChangeDue,
  joinPolicyForNameModeChange,
  nameModeAtWrite,
  nameModeBannerText,
  nameModeEffectiveAt,
  noticeText,
  resolveAuthorDisplay,
  sanitizeNoticePayload,
} from '../src'

const T0 = new Date('2026-11-03T09:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const at = (ms: number) => new Date(T0.getTime() + ms)

const scheduled = (toMode: NameMode, effectiveAt = nameModeEffectiveAt(T0)): ScheduledChangeFacts => ({ status: 'scheduled', toMode, effectiveAt })

const author = (overrides: Partial<AuthorProfileBits> = {}): AuthorProfileBits => ({
  userId: 'u-author',
  status: 'active',
  purged: false,
  displayPersonaName: '지민',
  realName: '김지민',
  ...overrides,
})

describe('name mode transitions', () => {
  it('official pages cannot change at all; rooms can move between any two different modes', () => {
    for (const kind of ['official_school', 'official_department'] as const) {
      for (const to of NAME_MODES) expect(checkNameModeTransition(kind, 'anonymous', to)).toEqual({ ok: false, reason: 'fixed' })
    }
    for (const kind of ['user_room', 'study_room'] as const) {
      for (const from of NAME_MODES) {
        for (const to of NAME_MODES) {
          expect(checkNameModeTransition(kind, from, to)).toEqual(from === to ? { ok: false, reason: 'same_mode' } : { ok: true })
        }
      }
      expect(checkNameModeTransition(kind, 'real', 'affiliated_anonymous')).toEqual({ ok: false, reason: 'invalid' })
      expect(checkNameModeTransition(kind, 'real', undefined)).toEqual({ ok: false, reason: 'invalid' })
    }
  })

  it('only the room owner may schedule; admins, moderators, operators and official pages cannot', () => {
    const room = { kind: 'user_room' as const, schoolId: null, departmentKey: null, discovery: 'listed' as const, joinPolicy: 'open' as const, status: 'active' as const, capacity: 300, activeMembers: 3 }
    const viewer = { userId: 'v', status: 'active' as const, operator: false, affiliations: [{ schoolId: 's', departmentKey: null }] }
    expect(canManageSpace(viewer, room, { role: 'owner', status: 'active' }, 'change_name_mode')).toBe(true)
    for (const role of ['admin', 'moderator', 'member'] as const) expect(canManageSpace(viewer, room, { role, status: 'active' }, 'change_name_mode')).toBe(false)
    expect(canManageSpace(viewer, { ...room, status: 'archived' }, { role: 'owner', status: 'active' }, 'change_name_mode')).toBe(false)
    const official = { ...room, kind: 'official_school' as const, schoolId: 's' }
    expect(canManageSpace({ ...viewer, operator: true }, official, null, 'change_name_mode')).toBe(false)
  })

  it('effective_at is exactly requested_at + 7 days', () => {
    expect(NAME_MODE_CHANGE_DELAY_MS).toBe(7 * DAY)
    expect(nameModeEffectiveAt(T0).toISOString()).toBe('2026-11-10T09:00:00.000Z')
  })

  it('switching to real turns open rooms into approval; other policies and other targets stay', () => {
    expect(joinPolicyForNameModeChange('real', 'open')).toBe('approval')
    expect(joinPolicyForNameModeChange('real', 'approval')).toBe('approval')
    expect(joinPolicyForNameModeChange('real', 'invite')).toBe('invite')
    expect(joinPolicyForNameModeChange('anonymous', 'open')).toBe('open')
    expect(joinPolicyForNameModeChange('display', 'open')).toBe('open')
  })

  it('cancel only before effective_at; due only at/after effective_at', () => {
    const change = scheduled('anonymous')
    expect(canCancelNameModeChange(change, at(7 * DAY - 1))).toBe('ok')
    expect(canCancelNameModeChange(change, at(7 * DAY))).toBe('already_effective')
    expect(canCancelNameModeChange({ ...change, status: 'cancelled' }, T0)).toBe('not_scheduled')
    expect(canCancelNameModeChange({ ...change, status: 'applied' }, T0)).toBe('not_scheduled')
    expect(isNameModeChangeDue(change, at(7 * DAY - 1))).toBe(false)
    expect(isNameModeChangeDue(change, at(7 * DAY))).toBe(true)
    expect(isNameModeChangeDue({ ...change, status: 'cancelled' }, at(8 * DAY))).toBe(false)
  })

  it('banner: remaining days rounded up, explains old posts stay', () => {
    expect(daysUntil(nameModeEffectiveAt(T0), T0)).toBe(7)
    expect(daysUntil(nameModeEffectiveAt(T0), at(6 * DAY + 1))).toBe(1)
    expect(daysUntil(nameModeEffectiveAt(T0), at(8 * DAY))).toBe(0)
    expect(nameModeBannerText('anonymous', nameModeEffectiveAt(T0), T0)).toBe('7일 뒤 이름 표시 방식이 익명으로 바뀝니다. 이미 쓴 글은 바뀌지 않습니다.')
    expect(nameModeBannerText('real', nameModeEffectiveAt(T0), at(8 * DAY))).toBe('곧 이름 표시 방식이 실명으로 바뀝니다. 이미 쓴 글은 바뀌지 않습니다.')
    // 보는 기기 시계가 예약 시각보다 이르더라도 7일을 넘겨 말하지 않음
    expect(nameModeBannerText('real', nameModeEffectiveAt(T0), at(-60_000))).toBe('7일 뒤 이름 표시 방식이 실명으로 바뀝니다. 이미 쓴 글은 바뀌지 않습니다.')
  })
})

describe('write-time freeze (C-04 contract)', () => {
  it('rooms use the mode in force at write time; a scheduled change does nothing before effective_at', () => {
    const space = { kind: 'user_room' as const, currentNameMode: 'real' as const, scheduledChange: scheduled('anonymous') }
    expect(nameModeAtWrite(space, T0)).toEqual({ ok: true, mode: 'real' })
    expect(nameModeAtWrite(space, at(7 * DAY - 1))).toEqual({ ok: true, mode: 'real' })
    // effective_at이 지나면 worker가 적용하기 전이라도 새 방식
    expect(nameModeAtWrite(space, at(7 * DAY))).toEqual({ ok: true, mode: 'anonymous' })
    expect(effectiveNameMode('real', { ...scheduled('anonymous'), status: 'cancelled' }, at(30 * DAY))).toBe('real')
    expect(effectiveNameMode('real', null, at(30 * DAY))).toBe('real')
  })

  it('room writers cannot pick another mode; official pages allow per-post display but never real', () => {
    const room = { kind: 'user_room' as const, currentNameMode: 'display' as const }
    expect(nameModeAtWrite(room, T0, 'display')).toEqual({ ok: true, mode: 'display' })
    expect(nameModeAtWrite(room, T0, 'anonymous')).toEqual({ ok: false, reason: 'mode_fixed' })
    expect(nameModeAtWrite(room, T0, 'bogus')).toEqual({ ok: false, reason: 'invalid' })
    const official = { kind: 'official_school' as const, currentNameMode: 'anonymous' as const }
    expect(nameModeAtWrite(official, T0)).toEqual({ ok: true, mode: 'anonymous' })
    expect(nameModeAtWrite(official, T0, 'display')).toEqual({ ok: true, mode: 'display' })
    expect(nameModeAtWrite(official, T0, 'real')).toEqual({ ok: false, reason: 'real_not_allowed' })
  })

  it('a post keeps its frozen mode forever: simulate posts across a real → anonymous change (0 retroactive changes)', () => {
    let current: NameMode = 'real'
    let change: ScheduledChangeFacts | null = scheduled('anonymous')
    const posts: Array<{ at: Date; mode: NameMode }> = []
    const write = (when: Date) => {
      const r = nameModeAtWrite({ kind: 'user_room', currentNameMode: current, scheduledChange: change }, when)
      if (!r.ok) throw new Error(r.reason)
      posts.push({ at: when, mode: r.mode })
    }
    write(at(DAY))
    write(at(6 * DAY))
    write(at(7 * DAY + 1)) // 기한은 지났지만 worker 전
    // worker 적용
    current = 'anonymous'
    change = { ...change!, status: 'applied' }
    write(at(8 * DAY))
    expect(posts.map((p) => p.mode)).toEqual(['real', 'real', 'anonymous', 'anonymous'])
    // 표시는 고정된 방식만 봄: 이전 실명 글은 실명, 이후 글은 익명. 반대 방향(익명 → 실명)도 이전 익명 글은 익명.
    const shown = posts.map((p) => resolveAuthorDisplay(p.mode, author(), { userId: 'someone' }).kind)
    expect(shown).toEqual(['real', 'real', 'anonymous', 'anonymous'])
    expect(resolveAuthorDisplay('anonymous', author(), null)).toEqual({ kind: 'anonymous', label: null, threadAlias: 'computed_by_thread', mine: false })
  })
})

describe('resolveAuthorDisplay', () => {
  it('real → the optional real name (with school verification flag), missing → placeholder', () => {
    expect(resolveAuthorDisplay('real', author({ schoolVerified: true }), null)).toEqual({ kind: 'real', label: '김지민', realNameMissing: false, schoolVerified: true, mine: false })
    expect(resolveAuthorDisplay('real', author({ realName: null }), null)).toEqual({ kind: 'real', label: REAL_NAME_MISSING_LABEL, realNameMissing: true, schoolVerified: false, mine: false })
    expect(resolveAuthorDisplay('real', author({ realName: '   ' }), null).label).toBe(REAL_NAME_MISSING_LABEL)
  })

  it('display → the display persona frozen on the item, never the real name', () => {
    const d = resolveAuthorDisplay('display', author(), null)
    expect(d).toEqual({ kind: 'display', label: '지민', displayPersonaMissing: false, mine: false })
    expect(JSON.stringify(d)).not.toContain('김지민')
  })

  it('display without a frozen display persona (legacy persona_id null) → neutral label, never the real name (ADR 0030)', () => {
    for (const displayPersonaName of [null, '   ']) {
      const d = resolveAuthorDisplay('display', author({ displayPersonaName }), { userId: 'u-author' })
      expect(d).toEqual({ kind: 'display', label: DISPLAY_PERSONA_MISSING_LABEL, displayPersonaMissing: true, mine: true })
      expect(JSON.stringify(d)).not.toContain('김지민')
    }
  })

  it('anonymous → no name, id, handle or real name, even for the owner/moderator/operator viewer', () => {
    for (const viewer of [null, { userId: 'owner' }, { userId: 'moderator' }, { userId: 'operator' }]) {
      const d = resolveAuthorDisplay('anonymous', author(), viewer)
      expect(d).toEqual({ kind: 'anonymous', label: null, threadAlias: 'computed_by_thread', mine: false })
      const text = JSON.stringify(d)
      for (const secret of ['u-author', '김지민', '지민']) expect(text).not.toContain(secret)
    }
    // 작성자 본인만 mine
    expect(resolveAuthorDisplay('anonymous', author(), { userId: 'u-author' }).mine).toBe(true)
    // 탈퇴해도 익명은 익명(탈퇴 여부도 드러내지 않음)
    expect(resolveAuthorDisplay('anonymous', author({ status: 'deleted', purged: true }), null).kind).toBe('anonymous')
  })

  it('withdrawn authors of real/display posts show a fixed label', () => {
    for (const mode of ['real', 'display'] as const) {
      expect(resolveAuthorDisplay(mode, author({ status: 'deleted', purged: true, realName: null, displayPersonaName: '탈퇴한 사용자' }), { userId: 'u-author' })).toEqual({
        kind: 'withdrawn',
        label: WITHDRAWN_AUTHOR_LABEL,
        mine: false,
      })
    }
  })
})

describe('real name input', () => {
  it('normalizes, allows clearing, rejects long and control characters', () => {
    expect(checkRealName('  김   지민 ')).toEqual({ ok: true, value: '김 지민' })
    expect(checkRealName('')).toEqual({ ok: true, value: null })
    expect(checkRealName(null)).toEqual({ ok: true, value: null })
    expect(checkRealName('가'.repeat(31))).toEqual({ ok: false, reason: 'too_long' })
    expect(checkRealName('김\u0007')).toEqual({ ok: false, reason: 'invalid' })
    expect(checkRealName(42)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('community notice payload allowlist', () => {
  const effectiveAt = nameModeEffectiveAt(T0).toISOString()
  it('keeps modes, time and the join-policy flag only', () => {
    expect(sanitizeNoticePayload('name_mode_scheduled', { fromMode: 'anonymous', toMode: 'real', effectiveAt, joinPolicyAdjusted: true })).toEqual({
      fromMode: 'anonymous',
      toMode: 'real',
      effectiveAt,
      joinPolicyAdjusted: true,
    })
    expect(sanitizeNoticePayload('name_mode_applied', { fromMode: 'real', toMode: 'display', effectiveAt })).toEqual({ fromMode: 'real', toMode: 'display', effectiveAt })
  })
  it('rejects extra keys, bad values and same-mode payloads', () => {
    expect(sanitizeNoticePayload('name_mode_applied', { fromMode: 'real', toMode: 'display', effectiveAt, joinPolicyAdjusted: true })).toBeNull()
    expect(sanitizeNoticePayload('name_mode_scheduled', { fromMode: 'real', toMode: 'display', effectiveAt, spaceName: '방' })).toBeNull()
    expect(sanitizeNoticePayload('name_mode_scheduled', { fromMode: 'real', toMode: 'real', effectiveAt })).toBeNull()
    expect(sanitizeNoticePayload('name_mode_scheduled', { fromMode: 'real', toMode: 'display', effectiveAt: 'tomorrow' })).toBeNull()
    expect(sanitizeNoticePayload('bogus' as never, { fromMode: 'real', toMode: 'display', effectiveAt })).toBeNull()
  })
  it('notice texts say old posts stay', () => {
    const p = { fromMode: 'real' as const, toMode: 'anonymous' as const, effectiveAt }
    expect(noticeText('name_mode_scheduled', p)).toContain('이미 쓴 글은 바뀌지 않습니다')
    expect(noticeText('name_mode_scheduled', { ...p, toMode: 'real', fromMode: 'anonymous', joinPolicyAdjusted: true })).toContain('방장 승인')
    expect(noticeText('name_mode_cancelled', p)).toContain('취소')
    expect(noticeText('name_mode_applied', p)).toContain('이제부터 쓰는 글에만')
  })
})
