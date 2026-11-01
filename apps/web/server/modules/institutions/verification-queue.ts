/**
 * 기관 인증 수단별 처리 큐 (A-07, DELIVERY_PLAN §4.3 A-07 "기관 인증 수단별 처리 큐(수료증 확인 시간 기록)"·§6.2 기관 인증, ADR 0045·0037).
 *
 * `GET /api/v1/operator/institutions/verification-queue` — 운영자만, P2 `institutions` 플래그가 꺼지면 404. 대학 메일 인증(C-01)은 큐가 아니므로 없습니다.
 * - 초대 코드: 사용하는 순간 인증되므로 대기 건이 없습니다. 최근 7일 사용 수(5 미만 null)와 지금 쓸 수 있는 코드 수만.
 * - 기수 승인: 같은 기수 멤버 2명이 승인하는 큐라 운영자가 처리하지 않습니다(기한 없음). 오래된 순 대기 건의 나이·받은 승인 수·만료 시각만 —
 *   승인이 모이지 않는 기관을 알아보고 협력 기관에 안내하는 용도입니다. 요청한 사람·승인한 사람은 싣지 않습니다.
 * - 수료증 확인: 운영자 대기. 파일을 받은 시각(uploaded_at)부터 나이와 건별 기한(`PEERCHIVE_CERTIFICATE_SLA_HOURS`, 기본 72시간 — §6.2 "처리 중앙값 3일 이내")을
 *   보이고, 최근 30일 결정의 처리 시간(받은 시각 → 결정 시각 decided_at) 중앙값·p90을 5 미만 가림으로 줍니다. 결정은 기존 `/operator/certificates`.
 * 기관 이름·기수 이름은 운영자 화면(수료증 목록)에 이미 있는 값입니다. 사람 id는 싣지 않습니다.
 */
import { COHORT_APPROVALS_REQUIRED, COHORT_APPROVAL_TTL_MS, ageHours, certificateSlaHours, queueSla, suppressSmall, summarizeDecisionTimes } from '@peerchive/domain'
import {
  and,
  asc,
  certificateChecks,
  cohortApprovals,
  eq,
  gt,
  gte,
  inArray,
  institutionAffiliations,
  institutionCohorts,
  institutionInviteCodes,
  isNotNull,
  isNull,
  lt,
  schools,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { requireOperator } from '../catalog/operators'
import type { Actor } from '../errors'
import { requireFeature } from '../features'
import type { VerificationQueueDto } from '../../../shared/types/api'

const DAY_MS = 24 * 60 * 60 * 1000
const QUEUE_LIMIT = 200

let slaOverride: number | null = null
/** 테스트용: 환경 변수 대신 쓸 수료증 기한(시간, null이면 process.env). */
export function setCertificateSlaHoursForTesting(hours: number | null): void {
  slaOverride = hours
}

export function currentCertificateSlaHours(): number {
  return slaOverride ?? certificateSlaHours((globalThis.process?.env ?? {}) as Record<string, string | undefined>)
}

/** 기간 [from, to) 안에 결정한 수료증의 (결정 − 받은 시각) ms. 운영 지표(§6.2)도 씁니다. */
export async function certificateDecisionDurations(db: DbExecutor, from: Date, to: Date): Promise<number[]> {
  const rows = await db
    .select({ uploadedAt: certificateChecks.uploadedAt, decidedAt: certificateChecks.decidedAt })
    .from(certificateChecks)
    .where(and(isNotNull(certificateChecks.decidedAt), isNotNull(certificateChecks.uploadedAt), gte(certificateChecks.decidedAt, from), lt(certificateChecks.decidedAt, to)))
  return rows.map((r) => Math.max(0, r.decidedAt!.getTime() - r.uploadedAt!.getTime()))
}

export async function getVerificationQueue(db: DbExecutor, actor: Actor, now = new Date()): Promise<VerificationQueueDto> {
  requireFeature('institutions')
  await requireOperator(db, actor)
  const slaHours = currentCertificateSlaHours()

  const [redeemed] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(institutionAffiliations)
    .where(and(eq(institutionAffiliations.method, 'invite_code'), gte(institutionAffiliations.verifiedAt, new Date(now.getTime() - 7 * DAY_MS))))
  const [activeCodes] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(institutionInviteCodes)
    .where(and(isNull(institutionInviteCodes.revokedAt), gt(institutionInviteCodes.expiresAt, now), sql`${institutionInviteCodes.usedCount} < ${institutionInviteCodes.maxUses}`))

  const cohortRows = await db
    .select({ id: institutionAffiliations.id, createdAt: institutionAffiliations.createdAt, institutionName: schools.name, cohortLabel: institutionCohorts.label })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .leftJoin(institutionCohorts, eq(institutionCohorts.id, institutionAffiliations.cohortId))
    .where(and(eq(institutionAffiliations.method, 'cohort_approval'), eq(institutionAffiliations.status, 'pending')))
    .orderBy(asc(institutionAffiliations.createdAt), asc(institutionAffiliations.id))
    .limit(QUEUE_LIMIT)
  const approvalCounts = cohortRows.length
    ? await db
        .select({ id: cohortApprovals.affiliationId, n: sql<number>`count(*)::int` })
        .from(cohortApprovals)
        .where(inArray(cohortApprovals.affiliationId, cohortRows.map((r) => r.id)))
        .groupBy(cohortApprovals.affiliationId)
    : []
  const approvalsBy = new Map(approvalCounts.map((r) => [r.id, r.n]))

  const certRows = await db
    .select({
      id: certificateChecks.id,
      uploadedAt: certificateChecks.uploadedAt,
      scanStatus: certificateChecks.scanStatus,
      institutionName: schools.name,
      cohortLabel: institutionCohorts.label,
    })
    .from(certificateChecks)
    .innerJoin(institutionAffiliations, eq(institutionAffiliations.id, certificateChecks.affiliationId))
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .leftJoin(institutionCohorts, eq(institutionCohorts.id, institutionAffiliations.cohortId))
    .where(and(isNull(certificateChecks.decidedAt), isNotNull(certificateChecks.uploadedAt), eq(institutionAffiliations.status, 'pending')))
    .orderBy(asc(certificateChecks.uploadedAt), asc(certificateChecks.id))
    .limit(QUEUE_LIMIT)

  const durations = await certificateDecisionDurations(db, new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() + 1))

  return {
    generatedAt: now.toISOString(),
    inviteCode: { instant: true, redeemedLast7Days: suppressSmall(redeemed?.n ?? 0), activeCodes: activeCodes?.n ?? 0 },
    cohortApproval: {
      slaHours: null,
      pending: cohortRows.map((r) => ({
        affiliationId: r.id,
        institutionName: r.institutionName,
        cohortLabel: r.cohortLabel,
        approvals: approvalsBy.get(r.id) ?? 0,
        required: COHORT_APPROVALS_REQUIRED,
        requestedAt: r.createdAt.toISOString(),
        ageHours: ageHours(r.createdAt, now),
        expiresAt: new Date(r.createdAt.getTime() + COHORT_APPROVAL_TTL_MS).toISOString(),
      })),
    },
    certificateCheck: {
      slaHours,
      pending: certRows.map((r) => {
        const sla = r.uploadedAt ? queueSla(r.uploadedAt, now, slaHours) : null
        return {
          checkId: r.id,
          institutionName: r.institutionName,
          cohortLabel: r.cohortLabel,
          receivedAt: r.uploadedAt?.toISOString() ?? null,
          scanStatus: r.scanStatus,
          ageHours: r.uploadedAt ? ageHours(r.uploadedAt, now) : null,
          dueAt: sla?.dueAt.toISOString() ?? null,
          sla: sla?.state ?? null,
        }
      }),
      recent: summarizeDecisionTimes(durations, slaHours),
    },
  }
}
