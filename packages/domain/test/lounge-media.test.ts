import { describe, expect, it } from 'vitest'
import {
  ALUMNI_HISTORY_BOARD_KINDS,
  type CommunityViewer,
  type SpaceFacts,
  canReadBoard,
  canReadSpace,
  canWriteBoard,
  canReact,
  canKeepAlumniReadOnly,
  countsAsAlumniHistory,
  readsByAlumniHistory,
} from '../src'
import { LOUNGE_MEDIA_PER_POST, LOUNGE_MEDIA_TYPES, checkLoungeMediaUpload, isLoungeBoard } from '../src/lounge-media'

const SCHOOL = '00000000-0000-4000-8000-0000000000a1'
const OTHER = '00000000-0000-4000-8000-0000000000b2'
const VERIFIED = new Date('2022-03-01T00:00:00Z')

const space = (over: Partial<SpaceFacts> = {}): SpaceFacts => ({
  kind: 'official_school',
  schoolId: SCHOOL,
  departmentKey: null,
  discovery: 'listed',
  joinPolicy: 'open',
  status: 'active',
  capacity: 300,
  activeMembers: 0,
  ...over,
})
const graduate = (over: Partial<CommunityViewer> = {}): CommunityViewer => ({
  userId: 'u1',
  status: 'active',
  operator: false,
  affiliations: [],
  alumniHistorySchoolIds: [SCHOOL],
  ...over,
})

describe('A-04 alumni verification history', () => {
  it('counts only verified alumni rows that are active or expired after verification', () => {
    expect(countsAsAlumniHistory({ standing: 'alumni', status: 'active', verifiedAt: VERIFIED })).toBe(true)
    expect(countsAsAlumniHistory({ standing: 'alumni', status: 'expired', verifiedAt: VERIFIED })).toBe(true)
    // 해제·취소(이유 무관), 인증 전, 인증된 적 없는 만료, 재학생 이력은 세지 않습니다.
    expect(countsAsAlumniHistory({ standing: 'alumni', status: 'revoked', verifiedAt: VERIFIED })).toBe(false)
    expect(countsAsAlumniHistory({ standing: 'alumni', status: 'pending', verifiedAt: null })).toBe(false)
    expect(countsAsAlumniHistory({ standing: 'alumni', status: 'expired', verifiedAt: null })).toBe(false)
    expect(countsAsAlumniHistory({ standing: 'student', status: 'expired', verifiedAt: VERIFIED })).toBe(false)
  })

  it('only a verified active alumni row may move to read-only (ADR 0060 D-04)', () => {
    expect(canKeepAlumniReadOnly({ standing: 'alumni', status: 'active', verifiedAt: VERIFIED })).toBe(true)
    expect(canKeepAlumniReadOnly({ standing: 'alumni', status: 'active', verifiedAt: null })).toBe(false)
    expect(canKeepAlumniReadOnly({ standing: 'student', status: 'active', verifiedAt: VERIFIED })).toBe(false)
    expect(canKeepAlumniReadOnly({ standing: 'alumni', status: 'expired', verifiedAt: VERIFIED })).toBe(false)
  })

  it('opens only the alumni and free (lounge) boards of that official school page, read-only', () => {
    expect(ALUMNI_HISTORY_BOARD_KINDS).toEqual(['free', 'alumni'])
    const v = graduate()
    expect(canReadSpace(v, space(), null)).toBe(false)
    expect(readsByAlumniHistory(v, space(), null)).toBe(true)
    expect(canReadBoard(v, space(), null, 'alumni')).toBe(true)
    expect(canReadBoard(v, space(), null, 'free')).toBe(true)
    for (const kind of ['freshmen', 'question', 'info', 'recruiting', 'notice'] as const) expect(canReadBoard(v, space(), null, kind)).toBe(false)
    // 쓰기·공감은 그대로 active 인증이 필요합니다.
    expect(canWriteBoard(v, space(), null, { kind: 'free', writeRole: 'member' })).toBe(false)
    expect(canReact(v, space(), null)).toBe(false)
  })

  it('does not apply to other schools, department pages, rooms, inactive users or an empty history (flag off)', () => {
    expect(canReadBoard(graduate(), space({ schoolId: OTHER }), null, 'alumni')).toBe(false)
    expect(canReadBoard(graduate(), space({ kind: 'official_department', departmentKey: 'cs' }), null, 'alumni')).toBe(false)
    expect(canReadBoard(graduate(), space({ kind: 'user_room' }), null, 'free')).toBe(false)
    expect(canReadBoard(graduate({ status: 'suspended' }), space(), null, 'alumni')).toBe(false)
    expect(canReadBoard(graduate({ alumniHistorySchoolIds: [] }), space(), null, 'alumni')).toBe(false)
    expect(canReadBoard(graduate({ alumniHistorySchoolIds: undefined }), space(), null, 'alumni')).toBe(false)
    // active 인증이 있으면 기존대로 모든 게시판.
    const current = graduate({ affiliations: [{ schoolId: SCHOOL, departmentKey: null }], alumniHistorySchoolIds: undefined })
    expect(canReadBoard(current, space(), null, 'question')).toBe(true)
  })
})

describe('A-04 lounge media', () => {
  it('the lounge is the free board of an official school page', () => {
    expect(isLoungeBoard('official_school', 'free')).toBe(true)
    expect(isLoungeBoard('official_school', 'alumni')).toBe(false)
    expect(isLoungeBoard('official_department', 'free')).toBe(false)
    expect(isLoungeBoard('user_room', 'free')).toBe(false)
  })

  it('accepts images up to the limit and defers video', () => {
    expect(LOUNGE_MEDIA_TYPES).toEqual(['image/png', 'image/jpeg', 'image/webp'])
    expect(LOUNGE_MEDIA_PER_POST).toBe(4)
    expect(checkLoungeMediaUpload({ declaredType: 'image/jpeg', fileName: '사진.JPG', byteSize: 100 })).toEqual({ ok: true, mediaType: 'image/jpeg', extension: 'jpg', byteSize: 100 })
    for (const declaredType of ['video/mp4', 'video/webm', 'video/quicktime', 'image/gif', 'image/svg+xml']) {
      expect(checkLoungeMediaUpload({ declaredType, fileName: 'a.mp4', byteSize: 100 })).toEqual({ ok: false, field: 'declaredType', reason: 'unsupported_type' })
    }
    expect(checkLoungeMediaUpload({ declaredType: 'image/png', fileName: 'a.png', byteSize: 10 * 1024 * 1024 + 1 })).toEqual({ ok: false, field: 'byteSize', reason: 'too_large' })
    expect(checkLoungeMediaUpload({ declaredType: 'image/png', fileName: 'a.jpg', byteSize: 10 })).toMatchObject({ ok: false, field: 'fileName' })
  })
})
