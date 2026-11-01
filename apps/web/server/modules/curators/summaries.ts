/**
 * 과제 유형 요약 (E-03, PROOFU_EVOLUTION_PLAN §8.6 "과제 유형 요약 정리", ADR 0048).
 *
 * 정본 과목마다 한 편의 짧은 글(1000자): 이 과목에서 어떤 유형의 과제가 나오는지(개인·팀, 보고서·구현·발표, 주차 흐름 등)를 큐레이터가 정리합니다.
 * 답안·채점 기준·교수 평가는 쓰지 않는다는 안내를 화면에 둡니다(§3.1).
 * - 쓰기 `PUT /curator/courses/:id/summary {body, expectedVersion}`: 그 과목 큐레이터 또는 운영자. expectedVersion은 지금 version(없으면 0),
 *   다르면 409 `version_conflict`. 빈 글이면 요약을 지웁니다. 사용자별 시간당 30회(429). 감사 `curator.summary_update`(과목 id·version·지웠는지·운영자인지).
 * - 읽기: 열린 과목 허브(`GET /public/courses/:id`)의 `assignmentTypeSummary`(글·version·고친 시각, 작성자 없음). "준비 중" 허브에는 싣지 않습니다.
 * - 이전 글은 보관하지 않습니다(version과 감사로 언제 몇 번 고쳤는지만).
 */
import { z } from 'zod'
import { ASSIGNMENT_TYPE_SUMMARY_MAX } from '@peerchive/domain'
import { courseTypeSummaries, eq, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, rateLimited } from '../errors'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { requireCuratorOrOperator } from './access'
import type { AssignmentTypeSummaryDto } from '../../../shared/types/api'

export const SUMMARY_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 60 * 1000 }

const summarySchema = z.object({
  body: z
    .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
    .transform((v) => v.replace(/\r\n/g, '\n').trim())
    .pipe(z.string().max(ASSIGNMENT_TYPE_SUMMARY_MAX, { error: 'too_long' })),
  expectedVersion: z.number({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }).int({ error: 'invalid' }).min(0, { error: 'invalid' }),
})

const toDto = (row: typeof courseTypeSummaries.$inferSelect): AssignmentTypeSummaryDto => ({
  body: row.body,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
})

/** 정본 과목의 과제 유형 요약(없으면 null). 공개 허브가 씁니다. */
export async function loadAssignmentTypeSummary(db: DbExecutor, canonicalCourseId: string): Promise<AssignmentTypeSummaryDto | null> {
  const [row] = await db.select().from(courseTypeSummaries).where(eq(courseTypeSummaries.courseId, canonicalCourseId)).limit(1)
  return row ? toDto(row) : null
}

/** PUT /curator/courses/:id/summary — 200 + 요약(지웠으면 null). */
export async function putAssignmentTypeSummary(
  db: DbExecutor,
  actor: Actor,
  courseId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<AssignmentTypeSummaryDto | null> {
  const { course, operator } = await requireCuratorOrOperator(db, actor, courseId)
  const input = parseInput(summarySchema, rawInput)
  return db.transaction(async (tx) => {
    if (!(await hitRateLimit(tx, 'curator_summary', actor.userId, SUMMARY_RATE_LIMIT, now))) throw rateLimited()
    const [current] = await tx.select().from(courseTypeSummaries).where(eq(courseTypeSummaries.courseId, course.id)).limit(1).for('update')
    if ((current?.version ?? 0) !== input.expectedVersion) throw conflict('version_conflict', { version: current?.version ?? 0 })
    let saved: typeof courseTypeSummaries.$inferSelect | undefined
    if (!input.body) {
      if (current) await tx.delete(courseTypeSummaries).where(eq(courseTypeSummaries.courseId, course.id))
    } else if (current) {
      ;[saved] = await tx
        .update(courseTypeSummaries)
        .set({ body: input.body, version: current.version + 1, updatedBy: actor.userId, updatedAt: now })
        .where(eq(courseTypeSummaries.courseId, course.id))
        .returning()
    } else {
      ;[saved] = await tx
        .insert(courseTypeSummaries)
        .values({ courseId: course.id, body: input.body, version: 1, updatedBy: actor.userId, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning()
      // 같은 순간 다른 사람이 먼저 만들었으면(잠글 행이 없었음) 고침 충돌로 봅니다.
      if (!saved) throw conflict('version_conflict', { version: 1 })
    }
    if (current || saved) {
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'curator.summary_update',
        targetType: 'course',
        targetId: course.id,
        metadata: { version: saved?.version ?? null, cleared: !saved, byOperator: operator },
      })
    }
    return saved ? toDto(saved) : null
  })
}
