import { describe, expect, it } from 'vitest'
import {
  ALBUM_PHOTO_MAX_BYTES,
  ROOM_EVENT_MAX_OCCURRENCES,
  canDeleteAlbumPhoto,
  canManageRoomGatherings,
  canRespondToOccurrence,
  checkAlbumPhotoUpload,
  checkRoomEventInput,
  checkRoomPollInput,
  eventOccurrences,
  findOccurrence,
  isDateString,
  isPollOpen,
  tracksNoticeReads,
} from '../src/index'

const NOW = new Date('2026-11-01T03:00:00Z') // 서울 12:00

describe('A-02 room gatherings: permissions', () => {
  it('only owner/admin manage events and polls; uploader or owner/admin delete photos', () => {
    expect(canManageRoomGatherings('owner')).toBe(true)
    expect(canManageRoomGatherings('admin')).toBe(true)
    expect(canManageRoomGatherings('moderator')).toBe(false)
    expect(canManageRoomGatherings('member')).toBe(false)
    expect(canManageRoomGatherings(null)).toBe(false)
    expect(canDeleteAlbumPhoto('member', true)).toBe(true)
    expect(canDeleteAlbumPhoto('member', false)).toBe(false)
    expect(canDeleteAlbumPhoto('moderator', false)).toBe(false)
    expect(canDeleteAlbumPhoto('admin', false)).toBe(true)
  })

  it('notice reads are tracked only on notice boards of (effective) alumni rooms', () => {
    expect(tracksNoticeReads('alumni', 'notice')).toBe(true)
    expect(tracksNoticeReads('alumni', 'general')).toBe(false)
    expect(tracksNoticeReads('general', 'notice')).toBe(false)
  })
})

describe('A-02 event recurrence', () => {
  it('one-off events have one occurrence keyed by the Seoul date (UTC evening = next Seoul day)', () => {
    const o = eventOccurrences({ startsAt: new Date('2026-11-20T16:00:00Z'), endsAt: null, recurrence: 'none', repeatUntil: null })
    expect(o).toHaveLength(1)
    expect(o[0]!.date).toBe('2026-11-21')
  })

  it('weekly: every 7 days until repeatUntil (inclusive, Seoul date); `from` skips ended occurrences', () => {
    const s = { startsAt: new Date('2026-11-06T10:00:00Z'), endsAt: new Date('2026-11-06T12:00:00Z'), recurrence: 'weekly' as const, repeatUntil: '2026-11-27' }
    const all = eventOccurrences(s)
    expect(all.map((o) => o.date)).toEqual(['2026-11-06', '2026-11-13', '2026-11-20', '2026-11-27'])
    expect(all[1]!.endsAt!.toISOString()).toBe('2026-11-13T12:00:00.000Z')
    expect(eventOccurrences(s, { from: new Date('2026-11-13T11:00:00Z') }).map((o) => o.date)).toEqual(['2026-11-13', '2026-11-20', '2026-11-27'])
    expect(eventOccurrences(s, { from: new Date('2026-11-13T12:00:00Z'), limit: 1 }).map((o) => o.date)).toEqual(['2026-11-20'])
  })

  it('monthly: same Seoul day-of-month and time, months without that day are skipped', () => {
    // 서울 1월 31일 19:00 = UTC 10:00
    const s = { startsAt: new Date('2027-01-31T10:00:00Z'), endsAt: null, recurrence: 'monthly' as const, repeatUntil: '2027-05-31' }
    const all = eventOccurrences(s)
    expect(all.map((o) => o.date)).toEqual(['2027-01-31', '2027-03-31', '2027-05-31'])
    expect(all[1]!.startsAt.toISOString()).toBe('2027-03-31T10:00:00.000Z')
  })

  it('monthly across the Seoul/UTC date boundary keeps the Seoul day', () => {
    // 서울 12월 1일 01:00 = UTC 11월 30일 16:00
    const s = { startsAt: new Date('2026-11-30T16:00:00Z'), endsAt: null, recurrence: 'monthly' as const, repeatUntil: '2027-02-01' }
    expect(eventOccurrences(s).map((o) => o.date)).toEqual(['2026-12-01', '2027-01-01', '2027-02-01'])
  })

  it('caps occurrences; findOccurrence accepts only dates on the rule', () => {
    const s = { startsAt: new Date('2026-11-02T01:00:00Z'), endsAt: null, recurrence: 'weekly' as const, repeatUntil: '2027-11-02' }
    expect(eventOccurrences(s).length).toBeLessThanOrEqual(ROOM_EVENT_MAX_OCCURRENCES)
    expect(findOccurrence(s, '2026-11-09')?.startsAt.toISOString()).toBe('2026-11-09T01:00:00.000Z')
    expect(findOccurrence(s, '2026-11-10')).toBeNull()
    expect(findOccurrence(s, '2026-13-01')).toBeNull()
    expect(findOccurrence(s, 42)).toBeNull()
  })

  it('responses are accepted only before the occurrence starts and only for scheduled events', () => {
    const occ = { date: '2026-11-02', startsAt: new Date('2026-11-02T01:00:00Z'), endsAt: null }
    expect(canRespondToOccurrence('scheduled', occ, new Date('2026-11-02T00:59:59Z'))).toBe(true)
    expect(canRespondToOccurrence('scheduled', occ, new Date('2026-11-02T01:00:00Z'))).toBe(false)
    expect(canRespondToOccurrence('cancelled', occ, NOW)).toBe(false)
  })

  it('isDateString', () => {
    expect(isDateString('2026-02-28')).toBe(true)
    expect(isDateString('2026-02-29')).toBe(false)
    expect(isDateString('2026-2-28')).toBe(false)
  })
})

describe('A-02 input checks', () => {
  it('event input: required title/start, timezone required, end after start (≤7 days), repeat rules', () => {
    const ok = checkRoomEventInput({ title: ' 홈커밍 ', startsAt: '2026-11-20T19:00:00+09:00', locationText: '학생회관' }, NOW)
    expect(ok).toEqual({
      ok: true,
      value: { title: '홈커밍', description: null, locationText: '학생회관', startsAt: new Date('2026-11-20T10:00:00Z'), endsAt: null, recurrence: 'none', repeatUntil: null },
    })
    const bad = (raw: Record<string, unknown>) => {
      const r = checkRoomEventInput(raw, NOW)
      return r.ok ? null : r.fields
    }
    expect(bad({})).toMatchObject({ title: 'required', startsAt: 'required' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T19:00:00' })).toMatchObject({ startsAt: 'invalid' })
    expect(bad({ title: 'x', startsAt: '2020-01-01T00:00:00Z' })).toMatchObject({ startsAt: 'out_of_range' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T10:00:00Z', endsAt: '2026-11-20T09:00:00Z' })).toMatchObject({ endsAt: 'out_of_range' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T10:00:00Z', endsAt: '2026-11-28T10:00:00Z' })).toMatchObject({ endsAt: 'out_of_range' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T10:00:00Z', recurrence: 'weekly' })).toMatchObject({ repeatUntil: 'required' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T10:00:00Z', recurrence: 'weekly', repeatUntil: '2026-11-19' })).toMatchObject({ repeatUntil: 'out_of_range' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T10:00:00Z', recurrence: 'weekly', repeatUntil: '2028-01-01' })).toMatchObject({ repeatUntil: 'out_of_range' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T10:00:00Z', repeatUntil: '2026-12-01' })).toMatchObject({ repeatUntil: 'not_allowed' })
    expect(bad({ title: 'x', startsAt: '2026-11-20T10:00:00Z', recurrence: 'daily' })).toMatchObject({ recurrence: 'invalid' })
    expect(bad({ title: 'x'.repeat(81), startsAt: '2026-11-20T10:00:00Z' })).toMatchObject({ title: 'too_long' })
  })

  it('poll input: 2–10 unique options, closesAt 5 minutes – 90 days ahead', () => {
    const ok = checkRoomPollInput({ question: '장소', options: ['강남', ' 신촌 '], closesAt: '2026-11-08T03:00:00Z' }, NOW)
    expect(ok).toEqual({ ok: true, value: { question: '장소', options: ['강남', '신촌'], closesAt: new Date('2026-11-08T03:00:00Z') } })
    const fields = (raw: Record<string, unknown>) => {
      const r = checkRoomPollInput(raw, NOW)
      return r.ok ? null : r.fields
    }
    expect(fields({ question: 'q', options: ['a'], closesAt: '2026-11-08T03:00:00Z' })).toMatchObject({ options: 'count' })
    expect(fields({ question: 'q', options: ['a', 'a'], closesAt: '2026-11-08T03:00:00Z' })).toMatchObject({ options: 'duplicate' })
    expect(fields({ question: 'q', options: ['a', ''], closesAt: '2026-11-08T03:00:00Z' })).toMatchObject({ options: 'invalid' })
    expect(fields({ question: 'q', options: ['a', 'b'], closesAt: '2026-11-01T03:01:00Z' })).toMatchObject({ closesAt: 'out_of_range' })
    expect(fields({ options: ['a', 'b'] })).toMatchObject({ question: 'required', closesAt: 'required' })
    expect(isPollOpen({ closesAt: new Date(NOW.getTime() + 1) }, NOW)).toBe(true)
    expect(isPollOpen({ closesAt: NOW }, NOW)).toBe(false)
  })

  it('album upload: images only, extension must match, size limit', () => {
    expect(checkAlbumPhotoUpload({ declaredType: 'image/jpeg', fileName: '김지민_홈커밍.JPG', byteSize: 100 })).toEqual({ ok: true, mediaType: 'image/jpeg', extension: 'jpg', byteSize: 100 })
    expect(checkAlbumPhotoUpload({ declaredType: 'application/pdf', fileName: 'a.pdf', byteSize: 100 })).toMatchObject({ ok: false, field: 'declaredType' })
    expect(checkAlbumPhotoUpload({ declaredType: 'image/gif', fileName: 'a.gif', byteSize: 100 })).toMatchObject({ ok: false, field: 'declaredType' })
    expect(checkAlbumPhotoUpload({ declaredType: 'image/png', fileName: 'a.jpg', byteSize: 100 })).toMatchObject({ ok: false, reason: 'extension_mismatch' })
    expect(checkAlbumPhotoUpload({ declaredType: 'image/png', fileName: 'a.png', byteSize: ALBUM_PHOTO_MAX_BYTES + 1 })).toMatchObject({ ok: false, reason: 'too_large' })
    expect(checkAlbumPhotoUpload({ declaredType: 'image/png', fileName: 'a.png', byteSize: 0 })).toMatchObject({ ok: false, field: 'byteSize' })
  })
})
