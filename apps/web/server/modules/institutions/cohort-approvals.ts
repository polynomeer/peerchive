/**
 * 기수 승인 (I-01, SYSTEM_DESIGN §6.7.2 CohortApproval·§8.4·§9.2, DELIVERY_PLAN §5.3 Z, ADR 0037). P2 플래그 `institutions`가 꺼져 있으면 404.
 *
 * 1. `POST /me/affiliations/cohort-approval {institutionId, cohortLabel, standing}` → 201 + pending 소속(method cohort_approval, 기수 필수).
 *    기수(기관 + 이름)는 없으면 만듭니다. 사용자당 시간당 10회.
 * 2. 요청한 사람이 승인 링크(`/affiliations/approve/:id`)를 같은 기수 멤버에게 직접 전합니다. 목록·검색으로 남의 요청을 찾는 경로는 없습니다.
 * 3. `GET /affiliations/:id/cohort-approval` · `POST /affiliations/:id/cohort-approvals` — **같은 정본 기관·같은 기수에서 기수 승인이 아닌 수단
 *    (초대 코드·수료증 확인·메일)으로 active 인증된 멤버**만. 자격이 없으면 요청이 있는지도 알 수 없게 404, 본인 요청이면 422 `self_approval`,
 *    두 번째 승인은 409 `already_approved`, 이미 끝난 요청은 409 `not_pending`. 승인 2개가 모이면 같은 트랜잭션에서 active.
 *    기수 승인으로만 인증된 멤버는 승인할 수 없습니다(승인 연쇄로 가짜 기수를 만드는 것 방지).
 * 4. 30일 안에 승인을 다 받지 못하면 worker(`affiliation-codes`)가 expired로 바꿉니다.
 */
import { z } from 'zod'
import {
  AFFILIATION_STANDINGS,
  COHORT_APPROVALS_REQUIRED,
  INSTITUTION_REQUEST_RATE_LIMIT,
  decideCohortApproval,
  isEligibleCohortApprover,
} from '@peerchive/domain'
import { and, cohortApprovals, eq, institutionAffiliations, institutionCohorts, schools, sql, users, type DbExecutor } from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound, rateLimited, sqlState } from '../errors'
import { requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { affiliationDto, closeOpenRequests, findOrCreateCohort, loadNonUniversityInstitution, toInstitutionDto } from './institutions'
import type { AffiliationDto, CohortApprovalRequestDto } from '../../../shared/types/api'

type AffiliationRow = typeof institutionAffiliations.$inferSelect

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const requestSchema = z.object({
  institutionId: z.string({ error: requiredOr('invalid') }),
  cohortLabel: z.unknown(),
  standing: z.enum(AFFILIATION_STANDINGS, { error: requiredOr('invalid') }),
})

/** POST /me/affiliations/cohort-approval — 201 + pending 소속(승인 0/2). 404(기관), 409 `already_verified`, 422(대학·기수 이름), 429. */
export async function requestCohortApproval(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<AffiliationDto> {
  requireFeature('institutions')
  const input = parseInput(requestSchema, rawInput)
  if (!(await hitRateLimit(db, 'institution_request_user', actor.userId, INSTITUTION_REQUEST_RATE_LIMIT, now))) throw rateLimited()
  try {
    const row = await db.transaction(async (tx) => {
      const institution = await loadNonUniversityInstitution(tx, input.institutionId)
      const cohort = await findOrCreateCohort(tx, institution.id, input.cohortLabel, actor.userId)
      await closeOpenRequests(tx, actor.userId, institution.id, now)
      const [inserted] = await tx
        .insert(institutionAffiliations)
        .values({
          userId: actor.userId,
          institutionKind: institution.kind,
          schoolId: institution.id,
          method: 'cohort_approval',
          cohortId: cohort.id,
          standing: input.standing,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      return inserted!
    })
    return affiliationDto(db, row)
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('request_in_progress')
    throw error
  }
}

/** 요청 행(정본 기관 id 포함)을 읽습니다. 없거나 기수 승인 요청이 아니면 404. */
async function loadRequest(db: DbExecutor, affiliationId: unknown, lock: boolean) {
  if (!isUuid(affiliationId)) throw notFound()
  const query = db
    .select({ row: institutionAffiliations, institutionId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(eq(institutionAffiliations.id, affiliationId.toLowerCase()))
    .limit(1)
  const [found] = lock ? await query.for('update', { of: institutionAffiliations }) : await query
  if (!found || found.row.method !== 'cohort_approval') throw notFound()
  return found
}

/** 승인하려는 사람의 active 소속(정본 기관 id). */
async function approverAffiliations(db: DbExecutor, userId: string) {
  const rows = await db
    .select({
      id: institutionAffiliations.id,
      userId: institutionAffiliations.userId,
      status: institutionAffiliations.status,
      method: institutionAffiliations.method,
      cohortId: institutionAffiliations.cohortId,
      institutionId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
    })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .innerJoin(users, eq(users.id, institutionAffiliations.userId))
    .where(and(eq(institutionAffiliations.userId, userId), eq(institutionAffiliations.status, 'active'), eq(users.status, 'active')))
  return rows
}

async function priorApprovers(db: DbExecutor, affiliationId: string): Promise<string[]> {
  const rows = await db.select({ userId: cohortApprovals.approverUserId }).from(cohortApprovals).where(eq(cohortApprovals.affiliationId, affiliationId))
  return rows.map((r) => r.userId)
}

const asRequest = (r: { row: AffiliationRow; institutionId: string }) => ({
  userId: r.row.userId,
  status: r.row.status,
  method: r.row.method,
  institutionId: r.institutionId,
  cohortId: r.row.cohortId,
})

/**
 * GET /affiliations/:id/cohort-approval — 승인할 자격이 있는 멤버에게만 요청 내용(기관·기수·요청자 계정 이름·승인 수). 그 밖에는 404.
 * 끝난 요청도 자격 있는 멤버에게는 상태와 함께 보입니다.
 */
export async function getCohortApprovalRequest(db: DbExecutor, actor: Actor, affiliationId: unknown): Promise<CohortApprovalRequestDto> {
  requireFeature('institutions')
  const found = await loadRequest(db, affiliationId, false)
  const request = asRequest(found)
  if (request.userId === actor.userId) throw notFound()
  const mine = await approverAffiliations(db, actor.userId)
  if (!mine.some((a) => isEligibleCohortApprover(a, request))) throw notFound()
  const approvers = await priorApprovers(db, found.row.id)
  const [institution] = await db.select().from(schools).where(eq(schools.id, found.institutionId)).limit(1)
  const [cohort] = await db.select({ label: institutionCohorts.label }).from(institutionCohorts).where(eq(institutionCohorts.id, found.row.cohortId!)).limit(1)
  const [requester] = await db.select({ name: users.displayName }).from(users).where(eq(users.id, found.row.userId)).limit(1)
  return {
    id: found.row.id,
    institution: toInstitutionDto(institution!),
    cohortLabel: cohort?.label ?? '',
    requesterName: requester?.name ?? '',
    approvals: approvers.length,
    required: COHORT_APPROVALS_REQUIRED,
    approvedByMe: approvers.includes(actor.userId),
    status: found.row.status,
    createdAt: found.row.createdAt.toISOString(),
  }
}

/**
 * POST /affiliations/:id/cohort-approvals — 201(승인 기록) + 요청 상태. 404(없음·자격 없음), 422 `self_approval`, 409 `already_approved`·`not_pending`.
 * 두 번째 승인이면 같은 트랜잭션에서 요청을 active로 바꾸고 감사·분석을 남깁니다.
 */
export async function approveCohortMember(db: DbExecutor, actor: Actor, affiliationId: unknown, now = new Date()): Promise<CohortApprovalRequestDto> {
  requireFeature('institutions')
  try {
    await db.transaction(async (tx) => {
      const found = await loadRequest(tx, affiliationId, true)
      const request = asRequest(found)
      const mine = await approverAffiliations(tx, actor.userId)
      const prior = await priorApprovers(tx, found.row.id)
      const eligible = mine.find((a) => isEligibleCohortApprover(a, request))
      // 본인 요청은 자격 판정보다 먼저(본인에게는 요청이 있다는 것이 이미 알려져 있음).
      if (request.userId === actor.userId) throw invalid({ affiliationId: 'self_approval' })
      // 자격이 없으면 요청이 있는지도 알리지 않습니다.
      if (!eligible) throw notFound()
      const decision = decideCohortApproval(request, actor.userId, mine, prior)
      if (!decision.ok) {
        if (decision.reason === 'already_approved') throw conflict('already_approved')
        if (decision.reason === 'not_pending') throw conflict('not_pending')
        if (decision.reason === 'self_approval') throw invalid({ affiliationId: 'self_approval' })
        throw notFound()
      }
      await tx.insert(cohortApprovals).values({ affiliationId: found.row.id, approverUserId: actor.userId, approverAffiliationId: eligible.id, createdAt: now })
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'cohort_approval.approve',
        targetType: 'affiliation',
        targetId: found.row.id,
        metadata: { schoolId: found.institutionId, approvals: decision.approvals, verified: decision.verified, approverMethod: eligible.method },
      })
      if (decision.verified) {
        await tx
          .update(institutionAffiliations)
          .set({ status: 'active', verifiedAt: now, updatedAt: now })
          .where(and(eq(institutionAffiliations.id, found.row.id), eq(institutionAffiliations.status, 'pending')))
        await recordAudit(tx, {
          actorId: null,
          action: 'affiliation.verify',
          targetType: 'affiliation',
          targetId: found.row.id,
          metadata: { schoolId: found.institutionId, method: 'cohort_approval', standing: found.row.standing },
        })
        await emitAnalytics(tx, { name: 'affiliation_verified', actorId: found.row.userId, props: { standing: found.row.standing, method: 'cohort_approval' }, now })
      }
    })
  } catch (error) {
    // 같은 사람이 동시에 두 번 승인한 경우(기본 키).
    if (sqlState(error) === '23505') throw conflict('already_approved')
    throw error
  }
  return getCohortApprovalRequest(db, actor, affiliationId)
}
