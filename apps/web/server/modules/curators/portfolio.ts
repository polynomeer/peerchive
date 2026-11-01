/**
 * 큐레이터 본인 화면과 포트폴리오 "후배 기여" 표시 (E-03, PROOFU_EVOLUTION_PLAN §8.6 "큐레이터 활동은 포트폴리오의 ‘후배 기여’에 표시할 수 있습니다", ADR 0048).
 *
 * - `GET /me/curated-courses`: 내가 지금 큐레이터인 과목(과목·지정 시각·포트폴리오 표시 여부). 아니면 빈 목록.
 * - `PATCH /me/curated-courses/:id {showInPortfolio}`: 본인만, 지금 큐레이터인 과목만(아니면 404). 기본 꺼짐. 감사 기록 없음(본인 표시 설정).
 * - 공개 프로필(실명 페르소나만)의 `juniorContribution.curatedCourses`: 지금 큐레이터이고 본인이 켠 과목의 과목·학교 이름만. 해제되면 사라집니다.
 *   표시명 프로필에는 싣지 않습니다(ADR 0028: 후배 기여는 계정 단위 기록).
 * 이 파일은 공개 프로필 경로에서 닿으므로 큐레이터 지정 테이블·과목·학교만 읽습니다(등록·신고·커뮤니티 테이블 없음).
 */
import { z } from 'zod'
import { and, asc, courseCurators, courses, eq, isNull, schools, sql, users, type DbExecutor } from '@peerchive/db'
import { loadCanonicalCourse } from '../catalog/catalog'
import { type Actor, notFound } from '../errors'
import { parseInput } from '../validation'
import { courseRefs } from './access'
import type { CuratedCourseLabelDto, MyCuratedCourseDto } from '../../../shared/types/api'

const canonical = sql<string>`coalesce(${courses.mergedInto}, ${courses.id})`

async function myRows(db: DbExecutor, userId: string) {
  return db
    .select({ id: courseCurators.id, courseId: canonical, grantedAt: courseCurators.grantedAt, showInPortfolio: courseCurators.showInPortfolio })
    .from(courseCurators)
    .innerJoin(courses, eq(courses.id, courseCurators.courseId))
    .innerJoin(users, eq(users.id, courseCurators.userId))
    .where(and(eq(courseCurators.userId, userId), isNull(courseCurators.revokedAt), eq(users.status, 'active')))
    .orderBy(asc(courseCurators.grantedAt), asc(courseCurators.id))
}

/** GET /me/curated-courses */
export async function listMyCuratedCourses(db: DbExecutor, actor: Actor): Promise<MyCuratedCourseDto[]> {
  const rows = await myRows(db, actor.userId)
  const refs = await courseRefs(db, rows.map((r) => r.courseId))
  return rows.map((r) => ({ course: refs.get(r.courseId)!, grantedAt: r.grantedAt.toISOString(), showInPortfolio: r.showInPortfolio }))
}

const displaySchema = z.object({ showInPortfolio: z.boolean({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }) })

/** PATCH /me/curated-courses/:id — 200 + 그 과목 항목. 지금 큐레이터가 아니면 404. */
export async function setCuratorPortfolioDisplay(db: DbExecutor, actor: Actor, courseId: unknown, rawInput: unknown): Promise<MyCuratedCourseDto> {
  const input = parseInput(displaySchema, rawInput)
  const course = await loadCanonicalCourse(db, courseId)
  const rows = (await myRows(db, actor.userId)).filter((r) => r.courseId === course.id)
  if (rows.length === 0) throw notFound()
  for (const r of rows) await db.update(courseCurators).set({ showInPortfolio: input.showInPortfolio }).where(eq(courseCurators.id, r.id))
  const refs = await courseRefs(db, [course.id])
  return { course: refs.get(course.id)!, grantedAt: rows[0]!.grantedAt.toISOString(), showInPortfolio: input.showInPortfolio }
}

/** 공개 프로필 "후배 기여": 지금 큐레이터이고 본인이 켠 과목(과목·학교 이름, 과목 이름순). */
export async function publicCuratedCourses(db: DbExecutor, userId: string): Promise<CuratedCourseLabelDto[]> {
  const rows = await db.execute<{ title: string; school_name: string }>(sql`
    select distinct canon.title, s.name as school_name
    from ${courseCurators} cc
    join ${users} u on u.id = cc.user_id
    join ${courses} c on c.id = cc.course_id
    join ${courses} canon on canon.id = coalesce(c.merged_into, c.id)
    join ${schools} s on s.id = canon.school_id
    where cc.user_id = ${userId} and cc.revoked_at is null and cc.show_in_portfolio and u.status = 'active'
    order by canon.title, s.name`)
  return rows.map((r) => ({ courseTitle: r.title, schoolName: r.school_name }))
}
