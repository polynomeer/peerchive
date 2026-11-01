import { describe, expect, it } from 'vitest'
import {
  ROOM_COHORT_LABEL_MAX,
  ROOM_PROFILE_BIO_MAX,
  ROOM_PROFILE_NAME_MAX,
  canEditMemberCohort,
  canViewCohortHistory,
  checkOneLine,
  checkRoomProfileInput,
  displayBadges,
  roomProfilesAvailable,
  templateAllowed,
} from '../src/room-profiles'

describe('A-01 alumni room template and room profiles', () => {
  it('alumni template is only for user rooms, and room profiles exist only in non-anonymous alumni rooms', () => {
    expect(templateAllowed('user_room', 'alumni')).toBe(true)
    for (const kind of ['official_school', 'official_department', 'study_room'] as const) {
      expect(templateAllowed(kind, 'alumni')).toBe(false)
      expect(templateAllowed(kind, 'general')).toBe(true)
    }
    expect(roomProfilesAvailable('alumni', 'real')).toBe(true)
    expect(roomProfilesAvailable('alumni', 'display')).toBe(true)
    expect(roomProfilesAvailable('alumni', 'anonymous')).toBe(false)
    expect(roomProfilesAvailable('general', 'display')).toBe(false)
  })

  it('real rooms fix the name to the real name; display rooms require a per-room name', () => {
    expect(checkRoomProfileInput({ displayName: '12기 김지민' }, 'real')).toEqual({ ok: false, fields: { displayName: 'name_fixed' } })
    expect(checkRoomProfileInput({ badges: ['ob'], cohortLabel: ' 12기 ' }, 'real')).toEqual({
      ok: true,
      value: { displayName: null, badges: ['ob'], cohortLabel: '12기', bio: null },
    })
    expect(checkRoomProfileInput({}, 'display')).toEqual({ ok: false, fields: { displayName: 'required' } })
    expect(checkRoomProfileInput({ displayName: '  12기   김지민 ' }, 'display')).toMatchObject({ ok: true, value: { displayName: '12기 김지민' } })
    expect(checkRoomProfileInput({ displayName: 'a'.repeat(ROOM_PROFILE_NAME_MAX + 1) }, 'display')).toEqual({ ok: false, fields: { displayName: 'too_long' } })
    expect(checkRoomProfileInput({ displayName: 'a\u0007b' }, 'display')).toEqual({ ok: false, fields: { displayName: 'invalid' } })
  })

  it('badges are self-declared current/ob/alumni only: no cohort or verified badge, no duplicates, current and ob conflict', () => {
    const ok = (badges: unknown) => checkRoomProfileInput({ displayName: 'x', badges }, 'display')
    expect(ok(['alumni', 'current'])).toMatchObject({ ok: true, value: { badges: ['current', 'alumni'] } })
    expect(ok(['current', 'ob'])).toEqual({ ok: false, fields: { badges: 'conflict' } })
    for (const bad of [['cohort'], ['verified'], ['alumni_verified'], ['ob', 'ob'], 'ob', [1]]) expect(ok(bad), JSON.stringify(bad)).toEqual({ ok: false, fields: { badges: 'invalid' } })
    expect(ok(null)).toMatchObject({ ok: true, value: { badges: [] } })
  })

  it('cohort label and bio limits', () => {
    expect(checkOneLine('a'.repeat(ROOM_COHORT_LABEL_MAX), ROOM_COHORT_LABEL_MAX)).toMatchObject({ ok: true })
    expect(checkOneLine('a'.repeat(ROOM_COHORT_LABEL_MAX + 1), ROOM_COHORT_LABEL_MAX)).toEqual({ ok: false, reason: 'too_long' })
    expect(checkOneLine('12\n기', ROOM_COHORT_LABEL_MAX)).toEqual({ ok: false, reason: 'invalid' })
    expect(checkOneLine('   ', ROOM_COHORT_LABEL_MAX)).toEqual({ ok: true, value: null })
    expect(checkRoomProfileInput({ displayName: 'x', bio: '첫 줄\r\n둘째 줄' }, 'display')).toMatchObject({ ok: true, value: { bio: '첫 줄\n둘째 줄' } })
    expect(checkRoomProfileInput({ displayName: 'x', bio: 'a'.repeat(ROOM_PROFILE_BIO_MAX + 1) }, 'display')).toEqual({ ok: false, fields: { bio: 'too_long' } })
  })

  it('display badges add cohort when a cohort label exists, in a fixed order', () => {
    expect(displayBadges(['alumni', 'ob'], '12기')).toEqual(['ob', 'alumni', 'cohort'])
    expect(displayBadges([], null)).toEqual([])
  })

  it('only owner/admin edit others\' cohort; history is visible to owner/admin and the subject', () => {
    expect(canEditMemberCohort('owner')).toBe(true)
    expect(canEditMemberCohort('admin')).toBe(true)
    expect(canEditMemberCohort('moderator')).toBe(false)
    expect(canEditMemberCohort('member')).toBe(false)
    expect(canEditMemberCohort(null)).toBe(false)
    expect(canViewCohortHistory('member', true)).toBe(true)
    expect(canViewCohortHistory('member', false)).toBe(false)
    expect(canViewCohortHistory('moderator', false)).toBe(false)
    expect(canViewCohortHistory('admin', false)).toBe(true)
  })
})
