/**
 * 학생 큐레이터 지정·해제 (E-03, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4 E-03, ADR 0048).
 *
 * - 운영자만(403 `operator_only`, 대상 존재 여부보다 먼저). 정본 과목에 지정합니다(병합된 id면 정본).
 * - **자격**(@peerchive/domain curatorEligibility): active 계정, 그 과목을 마침(끝난 학기 등록 또는 끝난 학기 과제 공간의 active 멤버 — E-02와 같은 판정,
 *   참거짓만 받음), 그 과목 학교(정본)의 active 학교 메일 인증. 과목당 최대 2명(과목별 advisory lock 안에서 셈).
 *   오류: 422 `userId: not_found|inactive|not_finished|not_verified`, 409 `already_curator`·`limit_reached`.
 * - 해제는 revoked_at·revoked_by를 채우고 행을 남깁니다. 권한은 요청마다 행을 읽어 판정하므로(access.ts) 해제 즉시 사라집니다.
 * - 감사 `curator.grant`·`curator.revoke`: 지정 행·과목·대상 사용자 id만.
 * - 운영자에게 등록 정보·과제 공간·학기는 보이지 않습니다(자격 판정은 이 파일 안에서 참거짓만 씀).
 */
import { z } from 'zod'
import { curatorEligibility } from '@peerchive/domain'
import { and, asc, courseCurators, courses, eq, isNull, sql, users, type DbExecutor } from '@peerchive/db'
import { activeAffiliationSchoolIds } from '../affiliation/affiliations'
import { recordAudit } from '../audit/audit'
import { loadCanonicalCourse } from '../catalog/catalog'
import { requireOperator } from '../catalog/operators'
import { hasFinishedCourse } from '../course-registrations/hub-opening'
import { type Actor, conflict, invalid, notFound, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { courseRefs } from './access'
import type { OperatorCourseCuratorDto } from '../../../shared/types/api'

const grantSchema = z.object({
  userId: z.uuid({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }).transform((v) => v.toLowerCase()),
})

async function listCurators(db: DbExecutor, courseId: string | null): Promise<OperatorCourseCuratorDto[]> {
  const rows = await db
    .select({ id: courseCurators.id, courseId: courseCurators.courseId, userId: courseCurators.userId, displayName: users.displayName, grantedAt: courseCurators.grantedAt })
    .from(courseCurators)
    .innerJoin(users, eq(users.id, courseCurators.userId))
    .innerJoin(courses, eq(courses.id, courseCurators.courseId))
    .where(and(isNull(courseCurators.revokedAt), courseId ? sql`coalesce(${courses.mergedInto}, ${courses.id}) = ${courseId}` : undefined))
    .orderBy(asc(courseCurators.grantedAt), asc(courseCurators.id))
    .limit(500)
  const refs = await courseRefs(db, rows.map((r) => r.courseId))
  return rows.map((r) => ({ id: r.id, course: refs.get(r.courseId)!, userId: r.userId, displayName: r.displayName, grantedAt: r.grantedAt.toISOString() }))
}

/** GET /operator/curators — 운영자만. 지금 큐레이터 전체(지정 순, 최대 500). */
export async function listAllCurators(db: DbExecutor, actor: Actor): Promise<OperatorCourseCuratorDto[]> {
  await requireOperator(db, actor)
  return listCurators(db, null)
}

/** GET /operator/courses/:id/curators — 운영자만. 그 과목(정본)의 지금 큐레이터. */
export async function listCourseCurators(db: DbExecutor, actor: Actor, courseId: unknown): Promise<OperatorCourseCuratorDto[]> {
  await requireOperator(db, actor)
  const course = await loadCanonicalCourse(db, courseId)
  return listCurators(db, course.id)
}

/** POST /operator/courses/:id/curators {userId} — 운영자만. 201 + 그 과목의 큐레이터 목록. */
export async function grantCourseCurator(db: DbExecutor, actor: Actor, courseId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorCourseCuratorDto[]> {
  await requireOperator(db, actor)
  const { userId } = parseInput(grantSchema, rawInput)
  const course = await loadCanonicalCourse(db, courseId)
  await db.transaction(async (tx) => {
    // 과목별로 직렬화해 2명 한도를 지킵니다.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`course-curators:${course.id}`}))`)
    const [target] = await tx.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1)
    if (!target) throw invalid({ userId: 'not_found' })
    const active = await tx
      .select({ userId: courseCurators.userId })
      .from(courseCurators)
      .innerJoin(courses, eq(courses.id, courseCurators.courseId))
      .where(and(isNull(courseCurators.revokedAt), sql`coalesce(${courses.mergedInto}, ${courses.id}) = ${course.id}`))
    const [school] = await tx.execute<{ id: string }>(sql`select coalesce(merged_into, id) as id from schools where id = ${course.schoolId}`)
    const eligibility = curatorEligibility({
      userActive: target.status === 'active',
      alreadyCurator: active.some((a) => a.userId === userId),
      activeCurators: active.length,
      finishedCourse: await hasFinishedCourse(tx, userId, course.id, now),
      verifiedForSchool: (await activeAffiliationSchoolIds(tx, userId)).includes(school?.id ?? course.schoolId),
    })
    if (!eligibility.ok) {
      if (eligibility.error === 'already_curator' || eligibility.error === 'limit_reached') throw conflict(eligibility.error)
      throw invalid({ userId: eligibility.error })
    }
    let row
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(courseCurators)
          .values({ courseId: course.id, userId, grantedBy: actor.userId, grantedAt: now })
          .returning({ id: courseCurators.id })
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('already_curator')
      throw error
    }
    await recordAudit(tx, { actorId: actor.userId, action: 'curator.grant', targetType: 'course_curator', targetId: row.id, metadata: { courseId: course.id, userId } })
  })
  return listCurators(db, course.id)
}

/** DELETE /operator/courses/:id/curators/:userId — 운영자만. 해제(행은 남김). 큐레이터가 아니면 404. */
export async function revokeCourseCurator(db: DbExecutor, actor: Actor, courseId: unknown, userId: unknown, now = new Date()): Promise<OperatorCourseCuratorDto[]> {
  await requireOperator(db, actor)
  const course = await loadCanonicalCourse(db, courseId)
  if (!isUuid(userId)) throw notFound()
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: courseCurators.id })
      .from(courseCurators)
      .innerJoin(courses, eq(courses.id, courseCurators.courseId))
      .where(
        and(
          eq(courseCurators.userId, userId.toLowerCase()),
          isNull(courseCurators.revokedAt),
          sql`coalesce(${courses.mergedInto}, ${courses.id}) = ${course.id}`,
        ),
      )
      .for('update', { of: courseCurators })
    if (rows.length === 0) throw notFound()
    for (const row of rows) {
      await tx.update(courseCurators).set({ revokedAt: now, revokedBy: actor.userId }).where(eq(courseCurators.id, row.id))
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'curator.revoke',
        targetType: 'course_curator',
        targetId: row.id,
        metadata: { courseId: course.id, userId: userId.toLowerCase() },
      })
    }
  })
  return listCurators(db, course.id)
}
