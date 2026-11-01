/**
 * 소속 표시 임계값의 설정값과 인증 회원 수(A-05, ADR 0042 — A-06 수료 회고도 같은 규칙, ADR 0043). 커뮤니티 테이블을 읽지 않으므로 커뮤니티 모듈
 * 밖(institutions)에 둡니다(C-05 경계: 커뮤니티 모듈을 import할 수 있는 곳은 정해져 있음). 토픽(community/topics.ts)과 수료 회고가 함께 씁니다.
 */
import { AFFILIATION_LABEL_THRESHOLD, type AffiliationStandingValue, type InstitutionKindValue } from '@peerchive/domain'
import { and, eq, institutionAffiliations, isNotNull, schools, sql, users, type DbExecutor } from '@peerchive/db'

/**
 * 임계값(설정값, SYSTEM_DESIGN §6.7.2 "초기안 50, 설정값"). `PEERCHIVE_AFFILIATION_LABEL_THRESHOLD`(정수 5~10000)가 있으면 그 값, 없거나 틀리면 50.
 * 5보다 작게 낮출 수 없습니다(n ≥ 5 익명 집계 원칙의 하한). 요청마다 읽습니다(바꾸려면 재시작).
 */
export function affiliationLabelThreshold(): number {
  const raw = globalThis.process?.env?.PEERCHIVE_AFFILIATION_LABEL_THRESHOLD?.trim()
  if (!raw || !/^\d+$/.test(raw)) return AFFILIATION_LABEL_THRESHOLD
  const n = Number(raw)
  return n >= 5 && n <= 10_000 ? n : AFFILIATION_LABEL_THRESHOLD
}

/**
 * 임계값 판정에 세는 (정본 기관, 신분)의 인증 회원 수(@peerchive/domain countsTowardLabelThreshold와 같은 조건): active + verified_at 있음 +
 * active 계정, 사람 단위로 한 번. pending·만료·철회 소속, 정지·탈퇴 계정, 다른 신분은 세지 않습니다. 결과는 판정에만 쓰고 응답·로그에 싣지 않습니다.
 */
export async function verifiedMemberCount(db: DbExecutor, institutionId: string, standing: AffiliationStandingValue): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${institutionAffiliations.userId})::int` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .innerJoin(users, eq(users.id, institutionAffiliations.userId))
    .where(
      and(
        sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${institutionId}`,
        eq(institutionAffiliations.standing, standing),
        eq(institutionAffiliations.status, 'active'),
        isNotNull(institutionAffiliations.verifiedAt),
        eq(users.status, 'active'),
      ),
    )
  return row?.n ?? 0
}

/**
 * 넓힌 범주(기관 종류, 신분)의 인증 회원 수: 그 종류의 모든 정본 기관을 합쳐 verifiedMemberCount와 같은 규칙(active + verified_at + active 계정,
 * 사람 단위)으로 셉니다. 기관 종류는 정본 기관의 종류입니다(병합된 학교의 소속은 정본 종류로). 판정에만 쓰고 응답·로그에 싣지 않습니다.
 */
export async function verifiedCategoryCount(db: DbExecutor, kind: InstitutionKindValue, standing: AffiliationStandingValue): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${institutionAffiliations.userId})::int` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .innerJoin(users, eq(users.id, institutionAffiliations.userId))
    .where(
      and(
        sql`coalesce((select c.kind from schools c where c.id = ${schools.mergedInto}), ${schools.kind})::text = ${kind}`,
        eq(institutionAffiliations.standing, standing),
        eq(institutionAffiliations.status, 'active'),
        isNotNull(institutionAffiliations.verifiedAt),
        eq(users.status, 'active'),
      ),
    )
  return row?.n ?? 0
}
