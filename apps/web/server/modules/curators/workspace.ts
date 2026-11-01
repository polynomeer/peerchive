/**
 * 큐레이터 작업 화면 (E-03, ADR 0048). `GET /curator/courses/:id` — 그 과목 큐레이터 또는 운영자(403 `curator_only`).
 * 과목·과제 유형 요약·그 과목의 개념 태그·병합 제안·팀원 찾기 끄기 상태. 신고 묶음은 따로(`/reports`, 큐레이터만).
 */
import { type DbExecutor } from '@peerchive/db'
import { listCourseTags } from '../catalog/tags'
import { type Actor } from '../errors'
import { courseRefs, requireCuratorOrOperator } from './access'
import { loadAssignmentTypeSummary } from './summaries'
import { listCourseProposals } from './tag-proposals'
import type { CuratorWorkspaceDto } from '../../../shared/types/api'

export async function getCuratorWorkspace(db: DbExecutor, actor: Actor, courseId: unknown): Promise<CuratorWorkspaceDto> {
  const { course, operator } = await requireCuratorOrOperator(db, actor, courseId)
  const refs = await courseRefs(db, [course.id])
  return {
    course: refs.get(course.id)!,
    operator,
    summary: await loadAssignmentTypeSummary(db, course.id),
    conceptTags: await listCourseTags(db, course.id),
    proposals: await listCourseProposals(db, actor.userId, course.id, operator),
    teamFindingDisabled: course.teamFindingDisabled,
  }
}
