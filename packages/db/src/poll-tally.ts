/**
 * 마감한 투표의 집계 고정(ADR 0060 D-03). 웹(마감·읽기·나가기·내보내기)과 worker(탈퇴 정리)가 같은 규칙을 씁니다.
 *
 * - 고정 시점: 일찍 마감할 때, 마감 시각이 지난 투표를 처음 읽을 때, 그리고 **표 행을 지우기 직전**. 마지막 경우가 있어서 worker 없이도 결정적입니다:
 *   마감 시각이 지난 뒤 표 행이 줄어들 수 있는 모든 경로가 먼저 고정하므로, 고정 값은 언제 만들어져도 마감 시점의 수와 같습니다.
 * - 한 문장 UPDATE라 동시에 불러도 안전합니다(첫 번째만 쓰고, 표를 넣는 트랜잭션은 투표 행을 잠그므로 그 뒤에 집계합니다).
 * - 이미 고정한 값은 다시 쓰지 않습니다. 사람 정보 없이 선택지별 수만 저장합니다.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { DbExecutor } from './index'

/** `scope`(room_polls `p`에 대한 조건) 안에서 마감 시각이 지났고 아직 고정하지 않은 투표의 집계를 고정합니다. */
export async function freezeClosedPollTallies(db: DbExecutor, scope: SQL, now: Date): Promise<void> {
  await db.execute(sql`
    update room_polls p
    set final_tally = (
      select array_agg(coalesce(c.n, 0) order by g.i)::integer[]
      from generate_series(0, cardinality(p.options) - 1) as g(i)
      left join (
        select v.option_index, count(*)::integer as n from room_poll_votes v where v.poll_id = p.id group by v.option_index
      ) c on c.option_index = g.i
    )
    where p.final_tally is null and p.closes_at <= ${now.toISOString()}::timestamptz and (${scope})
  `)
}
