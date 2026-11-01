import { describe, expect, it } from 'vitest'
import {
  AFFILIATION_LABEL_SCOPES,
  AFFILIATION_LABEL_THRESHOLD,
  type AffiliationLabelScope,
  type CommunityViewer,
  type SpaceFacts,
  asRoomNameMode,
  assignThreadAlias,
  canJoinSpace,
  canManageSpace,
  canModerate,
  canReadSpace,
  canWriteBoard,
  checkNameModeTransition,
  countsTowardLabelThreshold,
  decideAffiliationLabel,
  decidePersonaActivityProjection,
  defaultBoardsFor,
  institutionAffiliationLabel,
  isBroaderOrEqualScope,
  kindAffiliationLabel,
  nameModeAtWrite,
  personaKindForNameMode,
  resolveAuthorDisplay,
  shouldBucketTimes,
} from '../src'

const bootcamp = { name: '코드런 부트캠프', kind: 'bootcamp' as const }
const university = { name: '한빛대학교', kind: 'university' as const }

describe('A-05 affiliation label threshold (scenario Y)', () => {
  it('a 30-member bootcamp graduate is broadened to `부트캠프 수료생`, and only the decision says so', () => {
    const d = decideAffiliationLabel({ requested: 'institution', institution: bootcamp, standing: 'alumni', verifiedMembers: 30, categoryMembers: 120 })
    expect(d).toEqual({ applied: 'institution_kind', label: '부트캠프 수료생', broadened: true })
  })

  it('a university with 60 verified graduates shows `○○대 · 졸업생`', () => {
    expect(decideAffiliationLabel({ requested: 'institution', institution: university, standing: 'alumni', verifiedMembers: 60, categoryMembers: 900 })).toEqual({
      applied: 'institution',
      label: '한빛대학교 · 졸업생',
      broadened: false,
    })
  })

  it('표시 안 함 → no label; 기관 유형만 → the category, never broadened', () => {
    for (const members of [0, 49, 50, 10_000]) {
      expect(decideAffiliationLabel({ requested: 'none', institution: university, standing: 'alumni', verifiedMembers: members, categoryMembers: 10_000 })).toEqual({ applied: 'none', label: null, broadened: false })
      expect(decideAffiliationLabel({ requested: 'institution_kind', institution: university, standing: 'student', verifiedMembers: members, categoryMembers: 10_000 })).toEqual({
        applied: 'institution_kind',
        label: '대학 재학생',
        broadened: false,
      })
    }
  })

  it('the boundary is exactly the threshold (49 broadened, 50 shown), and a bad configured threshold falls back to 50', () => {
    expect(AFFILIATION_LABEL_THRESHOLD).toBe(50)
    const at = (n: number, threshold?: number) =>
      decideAffiliationLabel({ requested: 'institution', institution: university, standing: 'alumni', verifiedMembers: n, categoryMembers: 10_000, threshold }).applied
    expect(at(49)).toBe('institution_kind')
    expect(at(50)).toBe('institution')
    expect(at(99, 100)).toBe('institution_kind')
    expect(at(100, 100)).toBe('institution')
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(at(49, bad)).toBe('institution_kind')
  })

  it('never narrows what the author chose (every scope × member count)', () => {
    for (const requested of AFFILIATION_LABEL_SCOPES) {
      for (const [members, category] of [[0, 0], [1, 49], [49, 50], [50, 50], [51, 51], [50, 10], [1, 10_000]] as const) {
        const d = decideAffiliationLabel({ requested, institution: bootcamp, standing: 'alumni', verifiedMembers: members, categoryMembers: category })
        expect(isBroaderOrEqualScope(d.applied, requested)).toBe(true)
        expect(d.broadened).toBe(d.applied !== requested)
        expect(d.label === null).toBe(d.applied === 'none')
      }
    }
    expect(isBroaderOrEqualScope('institution', 'institution_kind')).toBe(false)
    expect(isBroaderOrEqualScope('institution_kind', 'none')).toBe(false)
  })

  it('second step: when the broadened category (kind + standing, all institutions) is also below the threshold, no label is shown', () => {
    const club = { name: '서울대학생연합', kind: 'club_federation' as const }
    // 기관 이름을 골랐지만 기관 12명, 동아리 연합 수료생 전체 30명 → 표시 안 함(넓혀짐 — 작성자에게만)
    expect(decideAffiliationLabel({ requested: 'institution', institution: club, standing: 'alumni', verifiedMembers: 12, categoryMembers: 30 })).toEqual({
      applied: 'none',
      label: null,
      broadened: true,
    })
    // 기관 유형을 골라도 범주가 49명이면 표시 안 함, 50명이면 유형 글자
    const kindOnly = (n: number) => decideAffiliationLabel({ requested: 'institution_kind', institution: club, standing: 'alumni', verifiedMembers: 0, categoryMembers: n })
    expect(kindOnly(49)).toEqual({ applied: 'none', label: null, broadened: true })
    expect(kindOnly(50)).toEqual({ applied: 'institution_kind', label: '동아리 연합 수료생', broadened: false })
    // 기관이 임계값을 넘으면 범주는 보지 않음(범주 ≥ 기관이므로 실제로는 생기지 않는 조합도 안전하게)
    expect(decideAffiliationLabel({ requested: 'institution', institution: club, standing: 'alumni', verifiedMembers: 50, categoryMembers: 0 }).applied).toBe('institution')
    expect(isBroaderOrEqualScope('none', 'institution')).toBe(true)
    expect(isBroaderOrEqualScope('none', 'institution_kind')).toBe(true)
  })

  it('labels are institution + standing only, with kind-specific standing words', () => {
    expect(institutionAffiliationLabel('  한빛   대학교 ', 'university', 'student')).toBe('한빛 대학교 · 재학생')
    expect(institutionAffiliationLabel('코드런', 'bootcamp', 'alumni')).toBe('코드런 · 수료생')
    const kinds: Array<[Parameters<typeof kindAffiliationLabel>[0], 'student' | 'alumni', string]> = [
      ['university', 'student', '대학 재학생'],
      ['university', 'alumni', '대학 졸업생'],
      ['bootcamp', 'student', '부트캠프 수강생'],
      ['bootcamp', 'alumni', '부트캠프 수료생'],
      ['training_program', 'alumni', '교육 프로그램 수료생'],
      ['club_federation', 'alumni', '동아리 연합 수료생'],
    ]
    for (const [kind, standing, label] of kinds) expect(kindAffiliationLabel(kind, standing)).toBe(label)
  })

  it('only active, verified affiliations of active accounts count toward the threshold', () => {
    const at = new Date()
    expect(countsTowardLabelThreshold({ status: 'active', verifiedAt: at, accountStatus: 'active' })).toBe(true)
    expect(countsTowardLabelThreshold({ status: 'active', verifiedAt: null, accountStatus: 'active' })).toBe(false)
    for (const status of ['pending', 'revoked', 'expired'] as const) expect(countsTowardLabelThreshold({ status, verifiedAt: at, accountStatus: 'active' })).toBe(false)
    for (const accountStatus of ['suspended', 'deleted'] as const) expect(countsTowardLabelThreshold({ status: 'active', verifiedAt: at, accountStatus })).toBe(false)
  })
})

describe('A-05 topic space policy', () => {
  const topic: SpaceFacts = { kind: 'topic', schoolId: null, departmentKey: null, discovery: 'listed', joinPolicy: 'open', status: 'active', capacity: 100000, activeMembers: 0 }
  const viewer = (o: Partial<CommunityViewer> = {}): CommunityViewer => ({ userId: 'u', status: 'active', operator: false, affiliations: [{ schoolId: 's', departmentKey: null }], ...o })
  const board = { kind: 'general' as const, writeRole: 'member' as const }

  it('any active affiliation (university or bootcamp) reads and writes; none → no access; operators read only', () => {
    expect(canReadSpace(viewer(), topic, null)).toBe(true)
    expect(canWriteBoard(viewer(), topic, null, board)).toBe(true)
    expect(canReadSpace(viewer({ affiliations: [] }), topic, null)).toBe(false)
    expect(canWriteBoard(viewer({ affiliations: [] }), topic, null, board)).toBe(false)
    expect(canReadSpace(viewer({ affiliations: [], operator: true }), topic, null)).toBe(true)
    expect(canWriteBoard(viewer({ affiliations: [], operator: true }), topic, null, board)).toBe(false)
    expect(canReadSpace(viewer({ status: 'suspended' }), topic, null)).toBe(false)
    expect(canWriteBoard(viewer({ communityWriteSuspended: true }), topic, null, board)).toBe(false)
    expect(canWriteBoard(viewer(), { ...topic, status: 'archived' }, null, board)).toBe(false)
  })

  it('no joining, no owner: management and moderation are operator-only, name mode fixed, one general board', () => {
    expect(canJoinSpace(viewer(), topic, null, 'self')).toEqual({ ok: false, reason: 'not_joinable' })
    expect(canModerate(viewer(), topic, null)).toBe(false)
    expect(canModerate(viewer({ operator: true }), topic, null)).toBe(true)
    expect(canManageSpace(viewer(), topic, { role: 'owner', status: 'active' }, 'update_settings')).toBe(false)
    expect(canManageSpace(viewer({ operator: true }), topic, null, 'archive')).toBe(true)
    expect(canManageSpace(viewer({ operator: true }), topic, null, 'change_name_mode')).toBe(false)
    expect(checkNameModeTransition('topic', 'affiliated_anonymous', 'real')).toEqual({ ok: false, reason: 'fixed' })
    expect(defaultBoardsFor('topic')).toEqual([{ kind: 'general', title: '게시판', writeRole: 'member' }])
    // 시각 버킷은 사용자 방(소규모)에만: 토픽은 멤버 수를 세지 않는 넓은 공간
    expect(shouldBucketTimes({ kind: 'topic', activeMembers: 0 }, 'affiliated_anonymous')).toBe(false)
    expect(shouldBucketTimes({ kind: 'user_room', activeMembers: 3 }, 'affiliated_anonymous')).toBe(true)
  })

  it('topics always write affiliated_anonymous; it is not allowed elsewhere', () => {
    const now = new Date()
    expect(nameModeAtWrite({ kind: 'topic', currentNameMode: 'affiliated_anonymous' }, now)).toEqual({ ok: true, mode: 'affiliated_anonymous' })
    expect(nameModeAtWrite({ kind: 'topic', currentNameMode: 'affiliated_anonymous' }, now, 'affiliated_anonymous')).toEqual({ ok: true, mode: 'affiliated_anonymous' })
    for (const other of ['real', 'display', 'anonymous']) expect(nameModeAtWrite({ kind: 'topic', currentNameMode: 'affiliated_anonymous' }, now, other)).toEqual({ ok: false, reason: 'mode_fixed' })
    expect(nameModeAtWrite({ kind: 'official_school', currentNameMode: 'anonymous' }, now, 'affiliated_anonymous')).toEqual({ ok: false, reason: 'affiliated_not_allowed' })
    expect(nameModeAtWrite({ kind: 'user_room', currentNameMode: 'anonymous' }, now, 'affiliated_anonymous')).toEqual({ ok: false, reason: 'mode_fixed' })
    expect(checkNameModeTransition('user_room', 'anonymous', 'affiliated_anonymous')).toEqual({ ok: false, reason: 'invalid' })
    expect(asRoomNameMode('affiliated_anonymous')).toBe('anonymous')
    expect(asRoomNameMode('display')).toBe('display')
  })
})

describe('A-05 affiliated anonymity is stage 1: no name, no persona, thread aliases', () => {
  it('the author is shown like anonymous (no name, even for withdrawn authors)', () => {
    const author = { userId: 'a', status: 'deleted' as const, purged: true, displayPersonaName: '밤의개발자', realName: '김실명' }
    expect(resolveAuthorDisplay('affiliated_anonymous', author, { userId: 'b' })).toEqual({ kind: 'anonymous', label: null, threadAlias: 'computed_by_thread', mine: false })
  })

  it('takes thread aliases like anonymous (post author 0, others in order)', () => {
    const base = { postAuthorId: 'a', postNameMode: 'affiliated_anonymous' as const, writeMode: 'affiliated_anonymous' as const }
    expect(assignThreadAlias({ ...base, existing: [], userId: 'a' })).toEqual({ aliasNo: 0, insert: true })
    expect(assignThreadAlias({ ...base, existing: [{ userId: 'a', aliasNo: 0 }], userId: 'b' })).toEqual({ aliasNo: 1, insert: true })
  })

  it('has no persona kind and is refused as anonymous before any other check', () => {
    expect(personaKindForNameMode('affiliated_anonymous')).toBeNull()
    expect(decidePersonaActivityProjection({ type: 'community_post', nameMode: 'affiliated_anonymous', personaId: 'p', discovery: 'listed', published: true }, { id: 'p', kind: 'real' })).toEqual({
      project: false,
      reason: 'anonymous',
    })
  })

  it('scope values are the DB enum values in broadening order', () => {
    expect(AFFILIATION_LABEL_SCOPES).toEqual(['institution', 'institution_kind', 'none'] satisfies AffiliationLabelScope[])
  })
})
