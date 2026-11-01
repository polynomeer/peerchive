/**
 * 학생 큐레이터 권한 판정 (E-03, PROOFU_EVOLUTION_PLAN §8.6, ADR 0048).
 *
 * - 큐레이터 = 해제되지 않은 `course_curators` 행 + active 계정. 요청마다 DB에서 읽으므로 운영자가 해제하면 **다음 요청부터** 권한이 없습니다.
 * - 과목은 정본 기준입니다(`coalesce(courses.merged_into, courses.id)`). 과목 병합은 지정 행을 정본으로 옮기지만, 옮기기 전 행도 정본으로 판정합니다.
 * - 큐레이터 권한은 그 과목의 과제 유형 요약·병합 제안·1차 신고 의견·팀원 찾기 끄기뿐입니다(이 판정을 쓰는 곳: summaries.ts·tag-proposals.ts·
 *   report-review.ts·팀원 찾기 끄기 경로). 운영자 권한(isOperator)과 섞지 않습니다.
 * 이 파일은 등록 테이블을 읽지 않습니다(공개 프로필 경로가 portfolio.ts를 거쳐 닿을 수 있음).
 */
import { and, courseCurators, courses, eq, inArray, isNull, schools, sql, users, type DbExecutor } from '@peerchive/db'
import { loadCanonicalCourse, type CourseRow } from '../catalog/catalog'
import { isOperator } from '../catalog/operators'
import { type Actor, forbidden } from '../errors'
import type { CuratorCourseRefDto } from '../../../shared/types/api'

/** 이 사람이 지금 큐레이터인 정본 과목 id. */
export async function curatedCourseIds(db: DbExecutor, userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ courseId: sql<string>`coalesce(${courses.mergedInto}, ${courses.id})` })
    .from(courseCurators)
    .innerJoin(courses, eq(courses.id, courseCurators.courseId))
    .innerJoin(users, eq(users.id, courseCurators.userId))
    .where(and(eq(courseCurators.userId, userId), isNull(courseCurators.revokedAt), eq(users.status, 'active')))
  return rows.map((r) => r.courseId)
}

/** 그 정본 과목의 큐레이터인지. */
export async function isCourseCurator(db: DbExecutor, userId: string, canonicalCourseId: string): Promise<boolean> {
  return (await curatedCourseIds(db, userId)).includes(canonicalCourseId)
}

/**
 * 그 과목의 큐레이터만(아니면 403 `curator_only`). 어느 과목의 큐레이터도 아니면 과목 존재 여부보다 먼저 403, 없는 과목 404.
 * 병합된 id면 정본 과목을 돌려줍니다.
 */
export async function requireCourseCurator(db: DbExecutor, actor: Actor, rawCourseId: unknown): Promise<CourseRow> {
  const ids = await curatedCourseIds(db, actor.userId)
  if (ids.length === 0) throw forbidden('curator_only')
  const course = await loadCanonicalCourse(db, rawCourseId)
  if (!ids.includes(course.id)) throw forbidden('curator_only')
  return course
}

/** 그 과목의 큐레이터 또는 운영자(아니면 403 `curator_only`). 과제 유형 요약·팀원 찾기·작업 화면이 씁니다. */
export async function requireCuratorOrOperator(db: DbExecutor, actor: Actor, rawCourseId: unknown): Promise<{ course: CourseRow; operator: boolean }> {
  if (await isOperator(db, actor.userId)) return { course: await loadCanonicalCourse(db, rawCourseId), operator: true }
  return { course: await requireCourseCurator(db, actor, rawCourseId), operator: false }
}

/** 과목 id → 화면용 과목 표시(제목·코드·학교 이름). */
export async function courseRefs(db: DbExecutor, ids: readonly string[]): Promise<Map<string, CuratorCourseRefDto>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: courses.id, title: courses.title, code: courses.code, schoolName: schools.name })
    .from(courses)
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(inArray(courses.id, unique))
  return new Map(rows.map((r) => [r.id, { id: r.id, title: r.title, code: r.code, schoolName: r.schoolName }]))
}
