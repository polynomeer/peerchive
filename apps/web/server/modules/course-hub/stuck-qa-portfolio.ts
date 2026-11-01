/**
 * 막힘 Q&A 답변의 포트폴리오 "후배 기여" 개수 (E-04, PROOFU_EVOLUTION_PLAN §8.5 "익명 답변은 포트폴리오의 ‘후배 기여’ 집계에 넣을지 선택", ADR 0049).
 *
 * 공개 프로필 경로(portfolio/public-profile.ts)에서 닿으므로 막힘 Q&A·공개·release·프로젝트·가린 항목 테이블과 플래그만 읽습니다
 * (선배 노트·운영 안내·커뮤니티 모듈을 끌어오지 않게 stuck-qa.ts와 나눔, S-02·C-05 경계).
 */
import { and, eq, projects, publicationCandidates, publications, releaseHiddenItems, sql, stuckQaCards, stuckQaPosts, stuckQaThreads, type DbExecutor } from '@peerchive/db'
import { isFeatureOn } from '../features'
import { servableReleaseSql } from './public-scope'

/**
 * 공개 프로필(실명)의 `juniorContribution.stuckQaAnswers`: 이 사람이 "후배 기여에 넣기"를 켠 게시 중인 답변 중 **지금 보이는 것**의 개수
 * (스레드 질문 게시 중 + 카드의 공개가 제공 가능 + 그 막힘 로그가 지금 release에 있고 가려지지 않음). 플래그가 꺼져 있으면 0.
 * 개수만이고 어느 스레드·과목인지, 도움됐어요 수는 싣지 않습니다.
 */
export async function publicStuckQaAnswerCount(db: DbExecutor, userId: string, now = new Date()): Promise<number> {
  if (!isFeatureOn('stuckQa')) return 0
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stuckQaPosts)
    .innerJoin(stuckQaThreads, eq(stuckQaThreads.id, stuckQaPosts.threadId))
    .innerJoin(stuckQaCards, eq(stuckQaCards.id, stuckQaThreads.cardId))
    .innerJoin(publications, eq(publications.id, stuckQaCards.publicationId))
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .where(
      and(
        eq(stuckQaPosts.authorId, userId),
        eq(stuckQaPosts.kind, 'answer'),
        eq(stuckQaPosts.status, 'published'),
        eq(stuckQaPosts.countAsContribution, true),
        servableReleaseSql(now),
        sql`exists (select 1 from ${stuckQaPosts} q where q.thread_id = ${stuckQaThreads.id} and q.kind = 'question' and q.status = 'published')`,
        sql`exists (select 1 from jsonb_array_elements(${publicationCandidates.snapshot} -> 'logs') l where l ->> 'key' = ${stuckQaCards.itemKey} and l ->> 'tag' = 'stuck')`,
        sql`not exists (select 1 from ${releaseHiddenItems} rh where rh.publication_id = ${publications.id} and rh.item_kind = 'log'
          and rh.item_key = ${stuckQaCards.itemKey} and rh.lifted_at is null)`,
      ),
    )
  return row?.n ?? 0
}
