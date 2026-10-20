/**
 * 사후 작성 표시가 DTO에서 빠지지 않는지 확인합니다(DB 없이 실행).
 * DELIVERY_PLAN T-07: `retro_mode` 표시가 공개 DTO까지 유지되어야 합니다. 공개 DTO(T-11/T-12)는 아래 DTO들에서 만들어지므로
 * 여기서 표시가 사라지면 공개 화면에서도 사라집니다. 공개 DTO를 추가할 때 이 파일에 그 DTO도 넣으세요.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { isRetrospectiveLog } from '@peerchive/domain'
import { toProjectDto } from '../server/modules/projects/projects'
import type {
  LogDto,
  MilestoneDto,
  MilestoneSnapshotDto,
  ProjectDto,
  RetrospectiveMarked,
} from '../shared/types/api'

const row = (retroMode: boolean): Parameters<typeof toProjectDto>[0] => ({
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  title: '지난 학기 캡스톤',
  summaryByStudent: null,
  goal: null,
  constraints: null,
  kind: 'team',
  lifecycle: 'completed',
  courseTermId: null,
  assignmentBriefId: null,
  retroMode,
  version: 1,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  updatedAt: new Date('2026-10-01T00:00:00Z'),
})

describe('retrospective flag on DTOs', () => {
  it('every DTO a public DTO will be built from carries `retrospective`', () => {
    expectTypeOf<ProjectDto>().toExtend<RetrospectiveMarked>()
    expectTypeOf<LogDto>().toExtend<RetrospectiveMarked>()
    expectTypeOf<MilestoneDto>().toExtend<RetrospectiveMarked>()
    expectTypeOf<MilestoneSnapshotDto>().toExtend<RetrospectiveMarked>()
  })

  it('project mapper exposes the current retro mode as `retrospective`', () => {
    expect(toProjectDto(row(true), 'owner')).toMatchObject({ retroMode: true, retrospective: true })
    expect(toProjectDto(row(false), 'viewer')).toMatchObject({ retroMode: false, retrospective: false })
  })

  it('log mapper rule: retro source or flagged at creation', () => {
    expect(isRetrospectiveLog({ source: 'retro', retrospective: true })).toBe(true)
    expect(isRetrospectiveLog({ source: 'task', retrospective: true })).toBe(true)
    expect(isRetrospectiveLog({ source: 'web', retrospective: false })).toBe(false)
  })
})
