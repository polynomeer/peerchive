/**
 * 신고 접수·내 신고 (T-15, PROOFU_EVOLUTION_PLAN §9.4·§15, SYSTEM_DESIGN §6.6 Report·§9 `POST /reports`, ADR 0015).
 *
 * `POST /api/v1/reports {targetType, targetRef, reason, details?}` — **로그인한 사용자만**(파일럿: 남용을 줄이고 rate limit·중복 판정을
 * 사람 단위로 하기 위해서; 공개 화면에는 "로그인 후 신고" 안내). 순서:
 * 1. 입력 검증(422) → 2. 대상이 지금 공개인지(아니면 404, targets.ts) → 3. 같은 신고자·대상의 처리 전 신고가 있으면 그것을 200으로
 *    (`created: false`, 한도를 쓰지 않음) → 4. 사용자별 한도(시간당 10회·하루 30회, 429) → 5. 저장(201).
 * - 대상 내용은 복사하지 않고 포인터만(공개 사례는 신고 때의 release, 노트·케이스는 그때의 version) 남깁니다. details는 운영자만 봅니다.
 * - 개인정보·저작권 신고는 그 공개에 보류(hold)를 겁니다: 신고가 처리될 때까지 게시·새 버전 게시가 막힙니다(이미 제공 중인 release는
 *   그대로이며 내리는 것은 운영자의 restrict).
 * - 감사 `report.create`에는 대상 종류·사유·보류 여부만(설명 글 없음).
 *
 * `GET /api/v1/me/reports` — 내가 한 신고의 상태만(접수·검토 중·처리됨·기각). 어떤 조치를 했는지는 알려 주지 않습니다.
 */
import { z } from 'zod'
import { REPORT_DETAILS_MAX, REPORT_REASONS, REPORT_TARGET_TYPES, reportCreatesHold, reporterVisibleStatus } from '@peerchive/domain'
import { and, desc, eq, holds, inArray, reports, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, rateLimited, sqlState } from '../errors'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { pointerOf, resolvePublicTarget, targetLabels } from './targets'
import type { MyReportDto, ReportReceiptDto } from '../../../shared/types/api'

export const REPORT_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60 * 60 * 1000 }
export const REPORT_DAILY_LIMIT: RateLimitRule = { limit: 30, windowMs: 24 * 60 * 60 * 1000 }

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const createReportSchema = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES, { error: requiredOr('invalid') }),
  targetRef: z.unknown(),
  reason: z.enum(REPORT_REASONS, { error: requiredOr('invalid') }),
  details: z
    .string({ error: 'invalid' })
    .trim()
    .max(REPORT_DETAILS_MAX, { error: 'too_long' })
    .nullish()
    .transform((value) => (value ? value : null)),
})

export interface ReportResult extends ReportReceiptDto {}

/** POST /reports — 201(새 신고) 또는 200(같은 대상의 처리 전 신고가 이미 있음, created: false). 404·422·429. */
export async function createReport(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<ReportResult> {
  const input = parseInput(createReportSchema, rawInput)
  return db.transaction(async (tx) => {
    const target = await resolvePublicTarget(tx, input.targetType, input.targetRef, now, actor)
    const existing = async () => {
      const [row] = await tx
        .select()
        .from(reports)
        .where(and(eq(reports.reporterId, actor.userId), eq(reports.targetKey, target.targetKey), inArray(reports.status, ['open', 'in_review'])))
        .limit(1)
      return row
    }
    const duplicate = await existing()
    if (duplicate) return receipt(duplicate, false)
    if (!(await hitRateLimit(tx, 'report_create', actor.userId, REPORT_RATE_LIMIT, now))) throw rateLimited()
    if (!(await hitRateLimit(tx, 'report_create_daily', actor.userId, REPORT_DAILY_LIMIT, now))) throw rateLimited()
    let row
    try {
      // 같은 사람의 동시 요청은 부분 unique가 막습니다(savepoint 안에서 시도해 바깥 트랜잭션을 살림).
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(reports)
          .values({ reporterId: actor.userId, ...target, reason: input.reason, details: input.details, createdAt: now })
          .returning()
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) !== '23505') throw error
      const again = await existing()
      if (again) return receipt(again, false)
      throw error
    }
    const hold = reportCreatesHold(input.targetType, input.reason) && target.publicationId !== null
    if (hold) {
      await tx.insert(holds).values({ publicationId: target.publicationId!, reason: input.reason, createdByReportId: row.id, createdAt: now })
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'report.create',
      targetType: 'report',
      targetId: row.id,
      metadata: { targetType: input.targetType, reason: input.reason, hold, publicationId: target.publicationId, communitySpaceId: target.communitySpaceId },
    })
    return receipt(row, true)
  })
}

function receipt(row: typeof reports.$inferSelect, created: boolean): ReportResult {
  return { id: row.id, status: reporterVisibleStatus(row.status), created, createdAt: row.createdAt.toISOString() }
}

/** GET /me/reports — 내 신고(최근 것부터, 100개). 상태만. */
export async function listMyReports(db: DbExecutor, actor: Actor): Promise<MyReportDto[]> {
  const rows = await db.select().from(reports).where(eq(reports.reporterId, actor.userId)).orderBy(desc(reports.createdAt), desc(reports.id)).limit(100)
  const labels = await targetLabels(db, rows.map(pointerOf))
  return rows.map((r) => ({
    id: r.id,
    targetType: r.targetType,
    targetLabel: labels.get(r.targetKey) ?? '',
    reason: r.reason,
    status: reporterVisibleStatus(r.status),
    createdAt: r.createdAt.toISOString(),
    closedAt: r.closedAt?.toISOString() ?? null,
  }))
}
