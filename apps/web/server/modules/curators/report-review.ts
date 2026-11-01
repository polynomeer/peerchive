/**
 * 큐레이터 1차 신고 검토 (E-03, PROOFU_EVOLUTION_PLAN §8.6 "1차 신고 검토", ADR 0048).
 *
 * 범위: 그 과목(정본) 허브에 걸린 공개 항목의 **처리 전**(open·in_review) 신고 — 선배 노트·막힘 Q&A·그 과목 공개 사례와 그 안의 항목
 * (@peerchive/domain CURATOR_REVIEW_TARGETS). 과목은 노트·Q&A의 과목, 공개 사례는 신고 때 release의 과목으로 정합니다.
 * - 목록 `GET /curator/courses/:id/reports`: 대상별 묶음. 실리는 것: 대상 종류·이름표·**사유별 개수**·지금 공개 중인 내용(공개 화면과 같은 DTO,
 *   공개 중이 아니면 "볼 수 없음")·공개 경로·내 의견. **신고자 id·이름·신고 설명(details)·신고 시각·담당 운영자·보류·조치 이력은 싣지 않습니다.**
 *   작성자도 공개 화면에 보이는 이름표 말고는 없습니다(작성자 확인은 운영자만).
 * - 의견 `PUT /curator/courses/:id/reports/:reportId/recommendation {recommendation: dismiss|hide, note?}`: 묶음의 가장 오래된 처리 전 신고에
 *   큐레이터마다 하나(다시 내면 고침). 처리 전이 아니거나 다른 과목·범위 밖 대상이면 404. 사용자별 시간당 60회(429).
 *   감사 `curator.report_recommend`(신고 id·과목 id·의견 종류). **신고 상태·담당·조치는 바뀌지 않습니다** — 처리·가리기·철회·계정 조치는 운영자만.
 * - 큐레이터 전용 경로입니다(운영자는 자기 대기열에서 의견을 봄, operator.ts).
 */
import { z } from 'zod'
import { CURATOR_NOTE_MAX, CURATOR_RECOMMENDATIONS, CURATOR_REVIEW_TARGETS, type CuratorReviewTarget } from '@peerchive/domain'
import { and, courseQaItems, curatorReportRecommendations, eq, reports, seniorNotes, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { publicQaPath, toPublicCourseQa } from '../course-hub/course-qa'
import { toPublicSeniorNote } from '../course-hub/hub'
import { publicNotePath } from '../course-hub/search'
import { type Actor, notFound, rateLimited } from '../errors'
import { pointerOf, targetLabels } from '../moderation/targets'
import { isUuid } from '../projects/access'
import { loadServedRelease } from '../publication/public-read'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { requireCourseCurator } from './access'
import type { CuratorRecommendationKind, CuratorReportContentDto, CuratorReportGroupDto } from '../../../shared/types/api'

export const RECOMMENDATION_RATE_LIMIT: RateLimitRule = { limit: 60, windowMs: 60 * 60 * 1000 }

const recommendSchema = z.object({
  recommendation: z.enum(CURATOR_RECOMMENDATIONS, { error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }),
  note: z
    .string({ error: 'invalid' })
    .trim()
    .max(CURATOR_NOTE_MAX, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v : null)),
})

type ReportRow = typeof reports.$inferSelect

const targetList = sql.join(
  CURATOR_REVIEW_TARGETS.map((t) => sql`${t}`),
  sql`, `,
)

/** 그 과목(정본)의 처리 전 신고(오래된 것부터, 최대 500). 범위 밖 대상 종류는 빠집니다. */
async function openCourseReports(db: DbExecutor, canonicalCourseId: string, onlyReportId?: string): Promise<ReportRow[]> {
  const ids = await db.execute<{ id: string }>(sql`
    select r.id from reports r
    left join senior_notes n on n.id = r.senior_note_id
    left join course_qa_items q on q.id = r.course_qa_item_id
    left join publication_candidates pc on pc.id = r.release_id
    join courses c on c.id = coalesce(n.course_id, q.course_id, pc.course_id)
    where r.status::text in ('open', 'in_review') and r.target_type::text in (${targetList})
      and coalesce(c.merged_into, c.id) = ${canonicalCourseId}
      ${onlyReportId ? sql`and r.target_key = (select target_key from reports where id = ${onlyReportId})` : sql``}
    order by r.created_at, r.id
    limit 500`)
  if (ids.length === 0) return []
  const rows = await db
    .select()
    .from(reports)
    .where(sql`${reports.id} in (${sql.join(ids.map((r) => sql`${r.id}::uuid`), sql`, `)})`)
  const order = new Map(ids.map((r, i) => [r.id, i]))
  return rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)
}

async function contentFor(db: DbExecutor, report: ReportRow, now: Date): Promise<{ content: CuratorReportContentDto; publicPath: string | null }> {
  const unavailable = (message: string) => ({ content: { kind: 'unavailable' as const, message }, publicPath: null })
  switch (report.targetType as CuratorReviewTarget) {
    case 'senior_note': {
      const [note] = await db.select().from(seniorNotes).where(eq(seniorNotes.id, report.seniorNoteId!)).limit(1)
      if (!note || note.status !== 'published') return unavailable('지금 공개 중이 아닙니다(내려갔거나 운영자가 이미 가렸습니다).')
      return { content: { kind: 'senior_note', note: toPublicSeniorNote(note, { meToo: 0, helped: 0 }) }, publicPath: publicNotePath(note.courseId, note.id) }
    }
    case 'course_qa': {
      const [qa] = await db.select().from(courseQaItems).where(eq(courseQaItems.id, report.courseQaItemId!)).limit(1)
      if (!qa || qa.status !== 'published') return unavailable('지금 공개 중이 아닙니다(철회됐거나 운영자가 이미 가렸습니다).')
      return { content: { kind: 'course_qa', qa: toPublicCourseQa(qa, { meToo: 0, helped: 0 }) }, publicPath: publicQaPath(qa.courseId, qa.id) }
    }
    case 'publication':
    case 'publication_item': {
      const [pub] = await db.execute<{ slug: string }>(sql`select slug from publications where id = ${report.publicationId}`)
      // 지금 제공 중인 release(가린 항목을 뺀 사본)만. 신고 때 스냅샷은 운영자만 봅니다.
      const served = pub ? await loadServedRelease(db, pub.slug, now) : null
      if (!served) return unavailable('지금 공개 중이 아닙니다(철회·제한·엠바고).')
      return {
        content: { kind: 'publication', title: served.snapshot.title, summary: served.snapshot.summary, itemKind: report.itemKind ?? null },
        publicPath: `/p/${pub!.slug}`,
      }
    }
  }
}

/** GET /curator/courses/:id/reports — 그 과목 큐레이터만(403 `curator_only`). */
export async function listCuratorReports(db: DbExecutor, actor: Actor, courseId: unknown, now = new Date()): Promise<CuratorReportGroupDto[]> {
  const course = await requireCourseCurator(db, actor, courseId)
  const rows = await openCourseReports(db, course.id)
  const groups = new Map<string, ReportRow[]>()
  for (const r of rows) groups.set(r.targetKey, [...(groups.get(r.targetKey) ?? []), r])
  const anchors = [...groups.values()].map((g) => g[0]!)
  const labels = await targetLabels(db, anchors.map(pointerOf))
  const mine = anchors.length
    ? await db
        .select()
        .from(curatorReportRecommendations)
        .where(
          and(
            eq(curatorReportRecommendations.curatorId, actor.userId),
            sql`${curatorReportRecommendations.reportId} in (${sql.join(anchors.map((a) => sql`${a.id}::uuid`), sql`, `)})`,
          ),
        )
    : []
  const mineBy = new Map(mine.map((m) => [m.reportId, m]))
  const out: CuratorReportGroupDto[] = []
  for (const [key, members] of groups) {
    const anchor = members[0]!
    const reasons: CuratorReportGroupDto['reasons'] = {}
    for (const m of members) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1
    const { content, publicPath } = await contentFor(db, anchor, now)
    const rec = mineBy.get(anchor.id)
    out.push({
      reportId: anchor.id,
      targetType: anchor.targetType as CuratorReviewTarget,
      targetLabel: labels.get(key) ?? '',
      reasons,
      content,
      publicPath,
      myRecommendation: rec ? { recommendation: rec.recommendation, note: rec.note, updatedAt: rec.updatedAt.toISOString() } : null,
    })
  }
  return out.slice(0, 100)
}

/** PUT /curator/courses/:id/reports/:reportId/recommendation — 200 `{reportId, recommendation, note}`. */
export async function recommendOnReport(
  db: DbExecutor,
  actor: Actor,
  courseId: unknown,
  reportId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<{ reportId: string; recommendation: CuratorRecommendationKind; note: string | null }> {
  const course = await requireCourseCurator(db, actor, courseId)
  const input = parseInput(recommendSchema, rawInput)
  if (!isUuid(reportId)) throw notFound()
  return db.transaction(async (tx) => {
    // 이 신고와 같은 대상의, 이 과목 범위의 처리 전 신고(가장 오래된 것이 묶음의 기준).
    const members = await openCourseReports(tx, course.id, reportId.toLowerCase())
    if (!members.some((m) => m.id === reportId.toLowerCase())) throw notFound()
    const anchor = members[0]!
    if (!(await hitRateLimit(tx, 'curator_report_recommend', actor.userId, RECOMMENDATION_RATE_LIMIT, now))) throw rateLimited()
    await tx
      .insert(curatorReportRecommendations)
      .values({
        reportId: anchor.id,
        targetKey: anchor.targetKey,
        courseId: course.id,
        curatorId: actor.userId,
        recommendation: input.recommendation,
        note: input.note,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [curatorReportRecommendations.reportId, curatorReportRecommendations.curatorId],
        set: { recommendation: input.recommendation, note: input.note, updatedAt: now },
      })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'curator.report_recommend',
      targetType: 'report',
      targetId: anchor.id,
      metadata: { courseId: course.id, recommendation: input.recommendation },
    })
    return { reportId: anchor.id, recommendation: input.recommendation, note: input.note }
  })
}
