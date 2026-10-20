/**
 * 게시 때 release의 과목 허브 연결 기록 (T-13, ADR 0013).
 *
 * - 연결 조건: 저장된 스냅샷에 과목이 있고(동의 받은 manifest에 과목이 들어 있었음), 프로젝트의 지금 학기가 스냅샷과 같은 (연도, 학기)일 때.
 *   스냅샷에 과목이 없으면(동의 범위에 과목이 없음) 게시 뒤 학기를 붙여도 과목 허브에 나오지 않습니다.
 * - course_id는 그 학기의 **정본** 과목(병합된 학기·과목이면 정본을 따라감), term_label은 스냅샷의 연도·학기 표시입니다.
 * - 운영자가 과목을 병합하면 merge.ts가 같은 트랜잭션에서 release·선배 노트의 course_id를 정본으로 옮깁니다(rehome).
 */
import { SEMESTER_LABELS } from '@peerchive/domain'
import { courses, eq, type DbExecutor } from '@peerchive/db'
import { loadCanonicalTerm } from '../catalog/catalog'
import type { PublicSnapshot } from '../../../shared/types/api'

export interface CourseLink {
  courseId: string | null
  termLabel: string | null
}

export const termLabelOf = (year: number, semester: keyof typeof SEMESTER_LABELS) => `${year}년 ${SEMESTER_LABELS[semester]}`

export async function courseLinkForRelease(db: DbExecutor, courseTermId: string | null, snapshot: PublicSnapshot): Promise<CourseLink> {
  const course = snapshot.course
  if (!course) return { courseId: null, termLabel: null }
  const termLabel = termLabelOf(course.year, course.semester)
  if (!courseTermId) return { courseId: null, termLabel }
  const term = await loadCanonicalTerm(db, courseTermId)
  if (!term || term.year !== course.year || term.semester !== course.semester) return { courseId: null, termLabel }
  const [row] = await db.select({ id: courses.id, mergedInto: courses.mergedInto }).from(courses).where(eq(courses.id, term.courseId)).limit(1)
  if (!row) return { courseId: null, termLabel }
  return { courseId: row.mergedInto ?? row.id, termLabel }
}
