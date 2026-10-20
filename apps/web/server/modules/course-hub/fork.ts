/**
 * 플랜 포크: 계획은 포크, 답은 금지 (T-13, PROOFU_EVOLUTION_PLAN §8.4, SYSTEM_DESIGN §6.2 PlanFork·§11, DELIVERY_PLAN 시나리오 F, ADR 0013).
 *
 * `POST /api/v1/public/publications/:slug/fork` — 로그인 필수(401), 지금 공개인 release만(아니면 404, 공개 조회와 같은 판정).
 * - 포크한 사람이 owner인 **새 비공개 과제 공간**을 만듭니다: 제목 "<원래 제목> 계획 포크", 개인 과제, 학기 없음, 사후 작성 꺼짐.
 * - 복사하는 것은 지금 release의 **저장된 스냅샷**에서 고른 허용 목록뿐입니다(@peerchive/domain forkPlanFromSnapshot):
 *   마일스톤 이름·순서(예정일은 복사하지 않고, 날짜가 둘 이상이면 첫 예정일 기준 상대 일수를 마일스톤 메모로), 포함된 로그의 참고 링크
 *   (💡해결 로그 제외, 최대 10개 → 새 프로젝트 개요 메모(summary_by_student)에 목록으로). 로그·해결·결정 내용·역할 선언·파일·사람 이름은
 *   복사하지 않습니다. 원본 스냅샷에는 할 일·체크리스트·주차별 시간이 없으므로 그것도 복사되지 않습니다.
 * - (원본 공개, 사용자)마다 한 번: 이미 포크했으면 기존 프로젝트를 200 `created: false`로 돌려줍니다. 포크 수 = 서로 다른 사용자 수.
 * - 사용자별 한도(시간당 10회, 429). 감사 `plan.fork`.
 */
import { forkPlanFromSnapshot, forkProjectTitle, formatForkReferences, type HubSnapshot } from '@peerchive/domain'
import { and, eq, planForks, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, notFound, rateLimited } from '../errors'
import { createMilestone } from '../milestones/milestones'
import { createProject } from '../projects/projects'
import { loadServedRelease } from '../publication/public-read'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import type { PlanForkResultDto } from '../../../shared/types/api'

export const FORK_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60 * 60 * 1000 }

const projectPath = (id: string) => `/projects/${id}`

export async function forkPublication(db: DbExecutor, actor: Actor, slug: unknown, now = new Date()): Promise<PlanForkResultDto> {
  return db.transaction(async (tx) => {
    const served = await loadServedRelease(tx, slug, now)
    if (!served) throw notFound()
    const { publication, release } = served
    // 같은 사용자의 동시 포크를 직렬화합니다((공개, 사용자) unique).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan-fork:${publication.id}:${actor.userId}`}))`)
    const [existing] = await tx
      .select()
      .from(planForks)
      .where(and(eq(planForks.sourcePublicationId, publication.id), eq(planForks.forkedBy, actor.userId)))
      .limit(1)
    if (existing) {
      const copied = existing.copied as { milestones?: number; references?: number }
      return {
        projectId: existing.targetProjectId,
        projectPath: projectPath(existing.targetProjectId),
        created: false,
        copied: { milestones: copied.milestones ?? 0, references: copied.references ?? 0 },
      }
    }
    if (!(await hitRateLimit(tx, 'plan_fork', actor.userId, FORK_RATE_LIMIT, now))) throw rateLimited()

    const plan = forkPlanFromSnapshot(served.snapshot as unknown as HubSnapshot)
    const project = await createProject(
      tx,
      actor,
      {
        title: forkProjectTitle(served.snapshot.title),
        kind: 'individual',
        courseTermId: null,
        retroMode: false,
        summaryByStudent: formatForkReferences(plan.references),
      },
      now,
    )
    for (const milestone of plan.milestones) {
      await createMilestone(tx, actor, project.id, { title: milestone.title, note: milestone.note }, now)
    }
    const copied = { milestones: plan.milestones.length, references: plan.references.length }
    await tx.insert(planForks).values({
      sourcePublicationId: publication.id,
      sourceReleaseId: release.id,
      releaseVersion: release.releaseNo!,
      targetProjectId: project.id,
      forkedBy: actor.userId,
      copied,
      createdAt: now,
    })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'plan.fork',
      targetType: 'project',
      targetId: project.id,
      projectId: project.id,
      metadata: { sourcePublicationId: publication.id, releaseNo: release.releaseNo!, ...copied },
    })
    return { projectId: project.id, projectPath: projectPath(project.id), created: true, copied }
  })
}
