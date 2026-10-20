/**
 * 포트폴리오·케이스 스터디 파생 상태 정리 handler (T-14, SYSTEM_DESIGN §1-4·§11, ADR 0012·0014).
 *
 * - 케이스 스터디는 게시된 release 하나에 고정됩니다. 그 release가 철회(`publication.withdrawn`)되거나 새 버전 게시로 대체
 *   (`publication.published`의 이전 release)되면, 그 release에 고정된 케이스를 `unavailable`(이유 withdrawn/replaced)로 표시합니다.
 * - 웹의 공개 읽기(공개 프로필·README 카드·인쇄 보기)는 이 표시를 기다리지 않습니다: 요청마다 `servableReleaseSql`로 고정 release를
 *   확인하므로 철회·대체 커밋 즉시 케이스 글이 사라집니다. 이 handler는 저장된 상태를 맞추고 작성자 화면의 "새 버전으로 다시 만들기"를 돕습니다.
 * - 판정은 이벤트 내용이 아니라 지금 release 행의 상태(withdrawn/replaced)로 하므로, 이벤트가 늦거나 순서가 바뀌거나 중복돼도 결과가 같습니다
 *   (idempotent, 지금 게시 중인 release의 케이스는 건드리지 않음).
 */
import { and, caseStudies, eq, inArray, ne, publicationCandidates, sql, type DbExecutor } from '@peerchive/db'
import { type DerivedCleanupHandler, registerDerivedCleanup } from './publication-events'

/** 이 공개의 철회·대체된 release에 고정된 케이스를 이용 불가로 표시하고 그 수를 돌려줍니다. */
export async function markUnavailableCaseStudies(db: DbExecutor, publicationId: string, now = new Date()): Promise<number> {
  const updated = await db
    .update(caseStudies)
    .set({
      status: 'unavailable',
      unavailableAt: now,
      unavailableReason: sql`(select case when ${publicationCandidates.status} = 'replaced' then 'replaced' else 'withdrawn' end
        from ${publicationCandidates} where ${publicationCandidates.id} = ${caseStudies.releaseId})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(caseStudies.publicationId, publicationId),
        ne(caseStudies.status, 'unavailable'),
        inArray(
          caseStudies.releaseId,
          db
            .select({ id: publicationCandidates.id })
            .from(publicationCandidates)
            .where(and(eq(publicationCandidates.publicationId, publicationId), inArray(publicationCandidates.status, ['withdrawn', 'replaced']))),
        ),
      ),
    )
    .returning({ id: caseStudies.id })
  return updated.length
}

export const caseStudiesCleanupHandler: DerivedCleanupHandler = {
  name: 'case-studies',
  onWithdrawn: (db, event) => markUnavailableCaseStudies(db, event.publicationId),
  onPublished: (db, event) => markUnavailableCaseStudies(db, event.publicationId),
}

let registered = false
/** T-14 파생 상태 handler를 등록합니다(worker 시작 때 한 번). */
export function registerPortfolioDerived(): void {
  if (registered) return
  registered = true
  registerDerivedCleanup(caseStudiesCleanupHandler)
}
