/**
 * 학기 종료 알림 만들기(E-01, PROOFU_EVOLUTION_PLAN §8.7 "학기가 끝나면 등록 과목을 기준으로 선배 노트·공개 제안 알림", ADR 0046).
 *
 * 주기 작업 `course-term-prompts`(기본 매시): 개설 학기의 종료 시각(정본 학기의 `ends_at`, 운영자가 고친 값 포함)이 지난 과목 등록 중 아직 알림이
 * 없는 것에 `post_term_prompted_at = now`를 채웁니다. 홈이 이 값으로 "선배 노트를 남겨 주세요"·"공개할까요?"를 보여 주고 본인이 닫습니다.
 *
 * - **등록마다 한 번**: 조건부 갱신(`post_term_prompted_at is null`)이라 여러 worker·재시도·수동 실행이 겹쳐도 한 번만 채웁니다(idempotent).
 *   닫은 알림은 다시 만들지 않습니다(이미 채워져 있으므로).
 * - active 계정만(탈퇴 요청·정지 계정은 건너뜀). 메일·푸시는 보내지 않습니다(화면 안 알림뿐).
 * - 행에는 시각 하나만 쓰고 감사 기록·분석 이벤트는 남기지 않습니다(등록은 본인만 보는 정보).
 */
import { sql, type DbExecutor } from '@peerchive/db'
import type { TaskOutcome } from './cleanup'

export async function createPostTermPrompts(db: DbExecutor, now: Date, batchSize = 500, maxBatches = 50): Promise<TaskOutcome> {
  let affected = 0
  let batches = 0
  while (batches < maxBatches) {
    const rows = await db.execute<{ id: string }>(sql`
      update course_registrations r set post_term_prompted_at = ${now.toISOString()}::timestamptz
      where r.id in (
        select r2.id from course_registrations r2
        join course_terms ct on ct.id = r2.course_term_id
        left join course_terms canon on canon.id = ct.merged_into
        join users u on u.id = r2.user_id
        where r2.post_term_prompted_at is null
          and coalesce(canon.ends_at, ct.ends_at) <= ${now.toISOString()}::timestamptz
          and u.status = 'active'
        order by r2.id
        limit ${batchSize}
        for update of r2 skip locked)
        and r.post_term_prompted_at is null
      returning r.id`)
    batches++
    affected += rows.length
    if (rows.length < batchSize) break
  }
  return { affected, batches }
}
