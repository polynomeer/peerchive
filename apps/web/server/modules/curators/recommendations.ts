/**
 * 큐레이터 신고 의견 읽기(운영자 화면용, E-03, ADR 0048). 운영자 신고 대기열·상세(moderation/operator.ts)가 씁니다.
 * 의견을 쓰는 쪽은 report-review.ts입니다. 이 파일은 의견 테이블과 계정 이름만 읽습니다.
 */
import { curatorReportRecommendations, desc, eq, inArray, users, type DbExecutor } from '@peerchive/db'
import type { OperatorCuratorRecommendationDto } from '../../../shared/types/api'

/** 같은 대상(target_key)의 큐레이터 의견 전부(최근 것부터, 최대 50). */
export async function curatorRecommendationsFor(db: DbExecutor, targetKey: string): Promise<OperatorCuratorRecommendationDto[]> {
  const rows = await db
    .select({ rec: curatorReportRecommendations, displayName: users.displayName })
    .from(curatorReportRecommendations)
    .leftJoin(users, eq(users.id, curatorReportRecommendations.curatorId))
    .where(eq(curatorReportRecommendations.targetKey, targetKey))
    .orderBy(desc(curatorReportRecommendations.updatedAt), desc(curatorReportRecommendations.id))
    .limit(50)
  return rows.map(({ rec, displayName }) => ({
    reportId: rec.reportId,
    recommendation: rec.recommendation,
    note: rec.note,
    curator: rec.curatorId ? { userId: rec.curatorId, displayName: displayName ?? '' } : null,
    createdAt: rec.createdAt.toISOString(),
    updatedAt: rec.updatedAt.toISOString(),
  }))
}

/** 이 신고 id들 중 큐레이터 의견이 붙은 것. */
export async function reportIdsWithRecommendation(db: DbExecutor, reportIds: readonly string[]): Promise<Set<string>> {
  if (reportIds.length === 0) return new Set()
  const rows = await db
    .selectDistinct({ reportId: curatorReportRecommendations.reportId })
    .from(curatorReportRecommendations)
    .where(inArray(curatorReportRecommendations.reportId, [...reportIds]))
  return new Set(rows.map((r) => r.reportId))
}
