/**
 * 학생 큐레이터 지정·해제 (E-03, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4 E-03, ADR 0048).
 *
 * - 운영자만(403 `operator_only`, 대상 존재 여부보다 먼저). 정본 과목에 지정합니다(병합된 id면 정본).
 * - **자격**(@peerchive/domain curatorEligibility): active 계정, 그 과목을 마침(끝난 학기 등록 또는 끝난 학기 과제 공간의 active 멤버 — E-02와 같은 판정,
 *   참거짓만 받음), 그 과목 학교(정본)의 active 학교 메일 인증. 과목당 최대 2명(과목별 advisory lock 안에서 셈).
 *   오류: 422 `userId: not_found|inactive|not_finished|not_verified`, 409 `already_curator`·`limit_reached`.
 * - **지정은 제안입니다**(ADR 0060 D-08): 운영자가 지정하면 대기 행이 생기고, 본인이 홈에서 수락해야(accepted_at) 권한이 생깁니다. 대기 행도 과목당 2명 한도에 셉니다
 *   (운영자가 수락을 기다리며 넘겨 지정하지 않게). 수락할 때 자격(계정·마침·학교 인증·한도)을 다시 봅니다. 거절은 declined_at·revoked_at을 채우고, 운영자는 다시 제안할 수 있습니다.
 *   본인 경로: `GET /me/curator-proposals`, `POST /me/curator-proposals/:id/accept|decline`(남의 행 404). 감사 `curator.accept`·`curator.decline`.
 * - 해제는 revoked_at·revoked_by를 채우고 행을 남깁니다. 권한은 요청마다 행을 읽어 판정하므로(access.ts) 해제 즉시 사라집니다.
 * - 감사 `curator.grant`·`curator.revoke`: 지정 행·과목·대상 사용자 id만.
 * - 운영자에게 등록 정보·과제 공간·학기는 보이지 않습니다(자격 판정은 이 파일 안에서 참거짓만 씀).
 */
import { z } from 'zod'
import { curatorEligibility } from '@peerchive/domain'
import { and, asc, courseCurators, courses, eq, isNull, ne, sql, users, type DbExecutor } from '@peerchive/db'
import { activeAffiliationSchoolIds } from '../affiliation/affiliations'
import { recordAudit } from '../audit/audit'
import { loadCanonicalCourse } from '../catalog/catalog'
import { requireOperator } from '../catalog/operators'
import { hasFinishedCourse } from '../course-registrations/hub-opening'
import { type Actor, conflict, invalid, notFound, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { courseRefs } from './access'
import type { CuratorProposalDto, OperatorCourseCuratorDto } from '../../../shared/types/api'

const grantSchema = z.object({
  userId: z.uuid({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }).transform((v) => v.toLowerCase()),
})

async function listCurators(db: DbExecutor, courseId: string | null): Promise<OperatorCourseCuratorDto[]> {
  const rows = await db
    .select({ id: courseCurators.id, courseId: courseCurators.courseId, userId: courseCurators.userId, displayName: users.displayName, grantedAt: courseCurators.grantedAt, acceptedAt: courseCurators.acceptedAt })
    .from(courseCurators)
    .innerJoin(users, eq(users.id, courseCurators.userId))
    .innerJoin(courses, eq(courses.id, courseCurators.courseId))
    .where(and(isNull(courseCurators.revokedAt), courseId ? sql`coalesce(${courses.mergedInto}, ${courses.id}) = ${courseId}` : undefined))
    .orderBy(asc(courseCurators.grantedAt), asc(courseCurators.id))
    .limit(500)
  const refs = await courseRefs(db, rows.map((r) => r.courseId))
  return rows.map((r) => ({ id: r.id, course: refs.get(r.courseId)!, userId: r.userId, displayName: r.displayName, grantedAt: r.grantedAt.toISOString(), status: r.acceptedAt ? ('accepted' as const) : ('pending' as const) }))
}

/** GET /operator/curators — 운영자만. 지금 큐레이터와 수락 대기 전체(지정 순, 최대 500). */
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

/** POST /operator/courses/:id/curators {userId} — 운영자만. 대기 중인 제안을 만듭니다. 201 + 그 과목의 큐레이터·대기 목록. */
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

// ── 본인: 제안 수락·거절 (ADR 0060 D-08) ───────────────────────────────

/** GET /me/curator-proposals — 내게 온 대기 중인 제안(홈). 누가 제안했는지는 싣지 않습니다. */
export async function listMyCuratorProposals(db: DbExecutor, actor: Actor): Promise<CuratorProposalDto[]> {
  const rows = await db
    .select({ id: courseCurators.id, courseId: sql<string>`coalesce(${courses.mergedInto}, ${courses.id})`, grantedAt: courseCurators.grantedAt })
    .from(courseCurators)
    .innerJoin(courses, eq(courses.id, courseCurators.courseId))
    .where(and(eq(courseCurators.userId, actor.userId), isNull(courseCurators.revokedAt), isNull(courseCurators.acceptedAt)))
    .orderBy(asc(courseCurators.grantedAt), asc(courseCurators.id))
  const refs = await courseRefs(db, rows.map((r) => r.courseId))
  return rows.map((r) => ({ id: r.id, course: refs.get(r.courseId)!, grantedAt: r.grantedAt.toISOString() }))
}

/** 내 열린 행을 잠가 읽습니다. 남의 행·없는 행·해제되거나 거절한 행은 404. */
async function loadMyProposal(tx: DbExecutor, actor: Actor, proposalId: unknown) {
  if (!isUuid(proposalId)) throw notFound()
  const [row] = await tx
    .select()
    .from(courseCurators)
    .where(and(eq(courseCurators.id, proposalId.toLowerCase()), eq(courseCurators.userId, actor.userId), isNull(courseCurators.revokedAt)))
    .limit(1)
    .for('update')
  if (!row) throw notFound()
  return row
}

/**
 * POST /me/curator-proposals/:id/accept — 수락. 자격을 다시 보고(계정·마침·학교 인증·한도) 안 되면 409 `curator_not_eligible` + `reason`(행은 대기로 남음).
 * 이미 수락했으면 그대로(멱등).
 */
export async function acceptCuratorProposal(db: DbExecutor, actor: Actor, proposalId: unknown, now = new Date()): Promise<{ accepted: true }> {
  return db.transaction(async (tx) => {
    const row = await loadMyProposal(tx, actor, proposalId)
    if (row.acceptedAt) return { accepted: true as const }
    const course = await loadCanonicalCourse(tx, row.courseId)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`course-curators:${course.id}`}))`)
    const [target] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1)
    const others = await tx
      .select({ userId: courseCurators.userId })
      .from(courseCurators)
      .innerJoin(courses, eq(courses.id, courseCurators.courseId))
      .where(and(isNull(courseCurators.revokedAt), ne(courseCurators.id, row.id), sql`coalesce(${courses.mergedInto}, ${courses.id}) = ${course.id}`))
    const [school] = await tx.execute<{ id: string }>(sql`select coalesce(merged_into, id) as id from schools where id = ${course.schoolId}`)
    const eligibility = curatorEligibility({
      userActive: target?.status === 'active',
      alreadyCurator: false,
      activeCurators: others.length,
      finishedCourse: await hasFinishedCourse(tx, actor.userId, course.id, now),
      verifiedForSchool: (await activeAffiliationSchoolIds(tx, actor.userId)).includes(school?.id ?? course.schoolId),
    })
    if (!eligibility.ok) throw conflict('curator_not_eligible', { reason: eligibility.error })
    await tx.update(courseCurators).set({ acceptedAt: now }).where(eq(courseCurators.id, row.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'curator.accept', targetType: 'course_curator', targetId: row.id, metadata: { courseId: course.id, userId: actor.userId } })
    return { accepted: true as const }
  })
}

/** POST /me/curator-proposals/:id/decline — 거절. 이미 수락한 행은 409 `already_accepted`(그만두려면 운영자 해제). */
export async function declineCuratorProposal(db: DbExecutor, actor: Actor, proposalId: unknown, now = new Date()): Promise<{ declined: true }> {
  return db.transaction(async (tx) => {
    const row = await loadMyProposal(tx, actor, proposalId)
    if (row.acceptedAt) throw conflict('already_accepted')
    await tx.update(courseCurators).set({ declinedAt: now, revokedAt: now }).where(eq(courseCurators.id, row.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'curator.decline', targetType: 'course_curator', targetId: row.id, metadata: { courseId: row.courseId, userId: actor.userId } })
    return { declined: true as const }
  })
}
