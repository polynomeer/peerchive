/**
 * C-08 도메인 규칙(ADR 0026): 방 역할 → 과제 역할, 방 멤버십 → 과제 멤버십 계획(멱등), 익명 스터디의 포트폴리오·노출 규칙, 이름 가림 표, 분석 허용 목록.
 */
import { describe, expect, it } from 'vitest'
import { displayStudyExposureAllowed,
  STUDY_MEMBER_LABEL,
  type StudyProjectMember,
  type StudySpaceMember,
  canLinkReleaseToPortfolio,
  isAnonymousStudySnapshot,
  planStudyRecordSync,
  sanitizeAnalyticsProps,
  studyExposureAllowed,
  studyMemberLabels,
  studyProjectRole,
} from '../src/index'

/** 계획을 지금 과제 멤버 목록에 적용(테스트용). */
function apply(project: StudyProjectMember[], plan: ReturnType<typeof planStudyRecordSync>): StudyProjectMember[] {
  const out = new Map(project.map((m) => [m.userId, { ...m }]))
  for (const i of plan.inserts) out.set(i.userId, { userId: i.userId, role: i.role, status: 'active' })
  for (const u of plan.updates) out.set(u.userId, { userId: u.userId, role: u.role, status: u.status })
  return [...out.values()].sort((a, b) => (a.userId < b.userId ? -1 : 1))
}

describe('study record role mapping', () => {
  it('maps the room owner to project owner and every other active member to editor', () => {
    expect(studyProjectRole('owner', 'active', 'active')).toBe('owner')
    for (const role of ['admin', 'moderator', 'member'] as const) expect(studyProjectRole(role, 'active', 'active')).toBe('editor')
  })

  it('pending, left and removed room members are not project members', () => {
    for (const status of ['pending', 'left', 'removed'] as const) {
      expect(studyProjectRole('member', status, 'active')).toBeNull()
      expect(studyProjectRole('owner', status, 'active')).toBeNull()
    }
  })

  it('an archived or restricted room makes everyone but the owner a viewer (read only)', () => {
    for (const spaceStatus of ['archived', 'restricted'] as const) {
      expect(studyProjectRole('owner', 'active', spaceStatus)).toBe('owner')
      expect(studyProjectRole('admin', 'active', spaceStatus)).toBe('viewer')
      expect(studyProjectRole('member', 'active', spaceStatus)).toBe('viewer')
    }
  })
})

describe('planStudyRecordSync', () => {
  const owner: StudySpaceMember = { userId: 'a', role: 'owner', status: 'active' }
  const admin: StudySpaceMember = { userId: 'b', role: 'admin', status: 'active' }
  const member: StudySpaceMember = { userId: 'c', role: 'member', status: 'active' }

  it('inserts every active member with the mapped role and names the owner', () => {
    const plan = planStudyRecordSync([owner, admin, member, { userId: 'd', role: 'member', status: 'pending' }], [], 'active')
    expect(plan.inserts).toEqual([
      { userId: 'a', role: 'owner' },
      { userId: 'b', role: 'editor' },
      { userId: 'c', role: 'editor' },
    ])
    expect(plan.updates).toEqual([])
    expect(plan.ownerId).toBe('a')
  })

  it('is idempotent: applying a plan and planning again gives an empty plan', () => {
    let project: StudyProjectMember[] = []
    project = apply(project, planStudyRecordSync([owner, admin, member], project, 'active'))
    const again = planStudyRecordSync([owner, admin, member], project, 'active')
    expect(again.inserts).toEqual([])
    expect(again.updates).toEqual([])
    expect(again.ownerId).toBe('a')
  })

  it('leave → left, remove → removed, missing membership row (account purge) → removed', () => {
    const project: StudyProjectMember[] = [
      { userId: 'a', role: 'owner', status: 'active' },
      { userId: 'b', role: 'editor', status: 'active' },
      { userId: 'c', role: 'editor', status: 'active' },
      { userId: 'd', role: 'editor', status: 'active' },
    ]
    const plan = planStudyRecordSync(
      [owner, { ...admin, status: 'left' }, { ...member, status: 'removed' }],
      project,
      'active',
    )
    expect(plan.updates).toEqual([
      { userId: 'b', role: 'editor', status: 'left' },
      { userId: 'c', role: 'editor', status: 'removed' },
      { userId: 'd', role: 'editor', status: 'removed' },
    ])
  })

  it('owner succession: the new room owner becomes project owner and the leaving owner steps down', () => {
    const project: StudyProjectMember[] = [
      { userId: 'a', role: 'owner', status: 'active' },
      { userId: 'b', role: 'editor', status: 'active' },
    ]
    const plan = planStudyRecordSync([{ ...owner, status: 'left', role: 'member' }, { ...admin, role: 'owner' }], project, 'active')
    expect(plan.ownerId).toBe('b')
    expect(plan.updates).toEqual([
      { userId: 'a', role: 'editor', status: 'left' },
      { userId: 'b', role: 'owner', status: 'active' },
    ])
  })

  it('rejoining revives the old project membership instead of inserting a second row', () => {
    const plan = planStudyRecordSync([owner, member], [{ userId: 'a', role: 'owner', status: 'active' }, { userId: 'c', role: 'editor', status: 'left' }], 'active')
    expect(plan.inserts).toEqual([])
    expect(plan.updates).toEqual([{ userId: 'c', role: 'editor', status: 'active' }])
  })

  it('archived room (no successor): everyone left, no owner to set; archived with members: viewers', () => {
    const gone = planStudyRecordSync([{ ...owner, status: 'left', role: 'member' }], [{ userId: 'a', role: 'owner', status: 'active' }], 'archived')
    expect(gone.ownerId).toBeNull()
    expect(gone.updates).toEqual([{ userId: 'a', role: 'editor', status: 'left' }])
    const kept = planStudyRecordSync([owner, member], [{ userId: 'a', role: 'owner', status: 'active' }, { userId: 'c', role: 'editor', status: 'active' }], 'archived')
    expect(kept.updates).toEqual([{ userId: 'c', role: 'viewer', status: 'active' }])
  })
})

describe('anonymous study rules', () => {
  it('only an anonymous study snapshot is blocked from portfolio links', () => {
    expect(isAnonymousStudySnapshot({ kind: 'study', studyNameMode: 'anonymous' })).toBe(true)
    expect(canLinkReleaseToPortfolio({ kind: 'study', studyNameMode: 'anonymous' })).toBe(false)
    for (const mode of ['real', 'display']) expect(canLinkReleaseToPortfolio({ kind: 'study', studyNameMode: mode })).toBe(true)
    for (const kind of ['team', 'individual']) expect(canLinkReleaseToPortfolio({ kind, studyNameMode: 'anonymous' })).toBe(true)
    expect(canLinkReleaseToPortfolio({ kind: 'team' })).toBe(true)
  })

  it('anonymous study candidates may not expose any name', () => {
    expect(studyExposureAllowed('anonymous', { u1: 'anonymous' })).toBe(true)
    expect(studyExposureAllowed('anonymous', {})).toBe(true)
    expect(studyExposureAllowed('anonymous', { u1: 'anonymous', u2: 'name' })).toBe(false)
    expect(studyExposureAllowed('display', { u1: 'name' })).toBe(true)
    expect(studyExposureAllowed(null, { u1: 'name' })).toBe(true)
  })

  it('labels other members by join order, never by name', () => {
    const label = studyMemberLabels(['x', 'y'])
    expect(label('x')).toBe(`${STUDY_MEMBER_LABEL} 1`)
    expect(label('y')).toBe('스터디 멤버 2')
    expect(label('z')).toBe('스터디 멤버')
  })
})

describe('study analytics', () => {
  it('allows only mode and course flag on study_record_enabled and origin study on project/log/publish events', () => {
    expect(sanitizeAnalyticsProps('study_record_enabled', { mode: 'anonymous', withCourse: false }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('study_record_enabled', { spaceId: 'x' }).ok).toBe(false)
    expect(sanitizeAnalyticsProps('study_record_enabled', { mode: '익명' }).ok).toBe(false)
    expect(sanitizeAnalyticsProps('project_created', { kind: 'study', origin: 'study' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('log_saved', { tag: 'progress', origin: 'study' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('publication_published', { level: 'summary', origin: 'study' }).ok).toBe(true)
    expect(sanitizeAnalyticsProps('log_saved', { origin: 'room' }).ok).toBe(false)
  })
})

describe('displayStudyExposureAllowed (ADR 0060)', () => {
  const self = '11111111-1111-4111-8111-111111111111'
  it('allows the name exposure only for yourself in a display study record', () => {
    expect(displayStudyExposureAllowed('display', { [self]: 'name', sm_0000000000000000: 'anonymous' }, self)).toBe(true)
    expect(displayStudyExposureAllowed('display', { [self.toUpperCase()]: 'name' }, self)).toBe(true)
    expect(displayStudyExposureAllowed('display', { sm_0000000000000000: 'name' }, self)).toBe(false)
  })
  it('does not apply outside display study records', () => {
    expect(displayStudyExposureAllowed('real', { sm_0000000000000000: 'name' }, self)).toBe(true)
    expect(displayStudyExposureAllowed(null, { sm_0000000000000000: 'name' }, self)).toBe(true)
  })
})
