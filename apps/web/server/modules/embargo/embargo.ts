/**
 * 엠바고 (T-10, PROOFU_EVOLUTION_PLAN §9.2, SYSTEM_DESIGN §6.6 Embargo, §7.2 embargoed, ADR 0010).
 *
 * - 과목·학기가 연결된 과제는 그 학기 종료일까지 공개할 수 없습니다. 끝나도 자동 공개하지 않습니다.
 * - projects.embargo_until은 단조 증가합니다: 학기를 연결하거나 바꿀 때 max(지금 값, 새 학기 종료·학기 엠바고,
 *   이전 학기의 학기 엠바고)로만 올라갑니다. 학기를 옛 학기로 바꾸거나 떼어도 줄지 않으며, 낮추기는 운영자만 합니다.
 * - 운영자가 학기 종료를 늘리면 그 학기에 연결된 프로젝트의 embargo_until도 같은 트랜잭션에서 올립니다(catalog.ts).
 * - 적용 엠바고 = max(projects.embargo_until, 지금 학기의 학기 엠바고, 프로젝트 엠바고)
 *   (@peerchive/domain computeEffectiveEmbargo). 운영자가 embargo_until을 낮추면 학기 종료보다 일찍 풀 수 있습니다.
 * - 게시(T-11/T-12)는 `assertPublishable`을 게시 트랜잭션 안에서 다시 불러야 합니다.
 */
import { z } from 'zod'
import { canManageMembers, computeEffectiveEmbargo, lowerEmbargo, raiseEmbargo } from '@peerchive/domain'
import { and, courseTerms, embargoes, eq, isNull, projects, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, ServiceError, forbidden, invalid, notFound } from '../errors'
import { isUuid, loadReadableProject } from '../projects/access'
import { parseInput } from '../validation'
import type { EmbargoDto } from '../../../shared/types/api'

/** 프로젝트 엠바고를 걸 수 있는 가장 먼 시각(지금부터). */
const MAX_EXPLICIT_EMBARGO_MS = 5 * 366 * 24 * 60 * 60 * 1000

export function toEmbargoDto(embargo: ReturnType<typeof computeEffectiveEmbargo>): EmbargoDto {
  return { until: embargo.until?.toISOString() ?? null, active: embargo.active, source: embargo.source }
}

/** 학기의 종료 시각과 해제되지 않은 학기 엠바고들. 학기가 없으면 빈 값. */
async function termEmbargoInputs(db: DbExecutor, termId: string | null): Promise<{ endsAt: Date | null; embargoes: Date[] }> {
  if (!termId) return { endsAt: null, embargoes: [] }
  const [term] = await db.select({ endsAt: courseTerms.endsAt }).from(courseTerms).where(eq(courseTerms.id, termId)).limit(1)
  const rows = await db
    .select({ until: embargoes.until })
    .from(embargoes)
    .where(and(eq(embargoes.courseTermId, termId), isNull(embargoes.revokedAt)))
  return { endsAt: term?.endsAt ?? null, embargoes: rows.map((r) => r.until) }
}

/**
 * 프로젝트의 학기 연결을 바꿀 때 새 embargo_until(단조) = max(지금 값, 새 학기 종료·학기 엠바고, 이전 학기의 학기 엠바고).
 * 이전 학기의 종료 시각은 연결할 때 이미 지금 값에 들어갔으므로 다시 넣지 않습니다(운영자가 낮춘 값을 되살리지 않음).
 * 이전 학기의 학기 엠바고(embargoes 행)는 접어 넣어, 학기 바꾸기로 학기 엠바고를 피할 수 없게 합니다.
 */
export async function nextEmbargoUntil(
  db: DbExecutor,
  existing: Date | null,
  previousTermId: string | null,
  nextTermId: string | null,
): Promise<Date | null> {
  const previous = await termEmbargoInputs(db, previousTermId)
  const next = await termEmbargoInputs(db, nextTermId)
  return raiseEmbargo(existing, ...previous.embargoes, next.endsAt, ...next.embargoes)
}

/** 프로젝트의 적용 엠바고(권한 확인 없음: 호출자가 확인). 없는 프로젝트면 NOT_FOUND. */
export async function getProjectEmbargo(db: DbExecutor, projectId: string, now: Date) {
  const [project] = await db
    .select({ id: projects.id, embargoUntil: projects.embargoUntil, courseTermId: projects.courseTermId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
  if (!project) throw notFound()
  const term = await termEmbargoInputs(db, project.courseTermId)
  const projectRows = await db
    .select({ until: embargoes.until })
    .from(embargoes)
    .where(and(eq(embargoes.projectId, project.id), isNull(embargoes.revokedAt)))
  return computeEffectiveEmbargo(
    {
      projectEmbargoUntil: project.embargoUntil,
      courseTermEmbargoes: term.embargoes,
      projectEmbargoes: projectRows.map((r) => r.until),
    },
    now,
  )
}

/**
 * 게시 가능 여부의 서버 판정(T-10 범위: 읽기 권한 + 엠바고). 엠바고 중이면 409 `embargo_active` + `until`.
 * T-11/T-12는 게시 트랜잭션 안에서 이 함수를 먼저 부르고 동의·파일·보류 검사를 더합니다.
 * 학기가 끝나 통과하더라도 게시는 여전히 명시적 요청으로만 합니다(자동 공개 없음).
 */
export async function assertPublishable(db: DbExecutor, actor: Actor, projectId: unknown, now: Date): Promise<void> {
  const { project } = await loadReadableProject(db, actor, projectId)
  const embargo = await getProjectEmbargo(db, project.id, now)
  if (embargo.active && embargo.until) {
    throw new ServiceError('CONFLICT', 'embargo_active', undefined, { until: embargo.until.toISOString() })
  }
}

const reason = z
  .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
  .trim()
  .min(1, { error: 'required' })
  .max(500, { error: 'too_long' })

export const addEmbargoSchema = z.object({
  until: z.iso.datetime({ offset: true, error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }),
  reason,
})

function parseFutureUntil(raw: string, now: Date): Date {
  const until = new Date(raw)
  if (until.getTime() <= now.getTime()) throw invalid({ until: 'not_future' })
  if (until.getTime() - now.getTime() > MAX_EXPLICIT_EMBARGO_MS) throw invalid({ until: 'too_far_future' })
  return until
}

/**
 * POST /projects/:id/embargoes {until, reason} — owner만(아니면 403, 비멤버 404). 엠바고를 더 거는 것이므로 언제든 안전합니다.
 * 201 + 적용 엠바고.
 */
export async function addProjectEmbargo(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<EmbargoDto> {
  const input = parseInput(addEmbargoSchema, rawInput)
  const until = parseFutureUntil(input.until, now)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    if (!canManageMembers({ userId: actor.userId }, project, membership)) throw forbidden()
    const [row] = await tx
      .insert(embargoes)
      .values({ scope: 'project', projectId: project.id, until, reason: input.reason, requestedBy: actor.userId })
      .returning({ id: embargoes.id })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'embargo.create',
      targetType: 'embargo',
      targetId: row?.id ?? null,
      projectId: project.id,
      metadata: { scope: 'project', until: until.toISOString() },
    })
    return toEmbargoDto(await getProjectEmbargo(tx, project.id, now))
  })
}

/** POST /operator/course-terms/:id/embargoes {until, reason} — 운영자만. 그 학기에 연결된 모든 프로젝트에 적용됩니다. */
export async function addCourseTermEmbargo(
  db: DbExecutor,
  actor: Actor,
  termId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<{ id: string; until: string }> {
  await requireOperator(db, actor)
  const input = parseInput(addEmbargoSchema, rawInput)
  const until = parseFutureUntil(input.until, now)
  if (!isUuid(termId)) throw notFound()
  return db.transaction(async (tx) => {
    const [term] = await tx.select({ id: courseTerms.id, mergedInto: courseTerms.mergedInto }).from(courseTerms).where(eq(courseTerms.id, termId)).limit(1)
    if (!term) throw notFound()
    const targetTermId = term.mergedInto ?? term.id
    const [row] = await tx
      .insert(embargoes)
      .values({ scope: 'course_term', courseTermId: targetTermId, until, reason: input.reason, requestedBy: actor.userId })
      .returning({ id: embargoes.id })
    if (!row) throw new Error('embargo insert failed')
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'embargo.create',
      targetType: 'embargo',
      targetId: row.id,
      metadata: { scope: 'course_term', courseTermId: targetTermId, until: until.toISOString(), reason: input.reason },
    })
    return { id: row.id, until: until.toISOString() }
  })
}

export const lowerEmbargoSchema = z.object({
  /** 새 값(지금보다 이르거나 같아야 함). null이면 학기 종료로 걸린 엠바고를 지웁니다. */
  until: z.iso.datetime({ offset: true, error: 'invalid' }).nullable(),
  reason,
})

/**
 * PATCH /operator/projects/:id/embargo {until|null, reason} — 운영자만(아니면 403). projects.embargo_until을 낮춥니다(감사 기록).
 * 프로젝트 내용은 읽지 않고 돌려주지도 않습니다(운영자도 비공개 과제 공간 열람 권한 없음). 높이려 하면 422 `{until: 'not_lower'}`.
 * 명시적 엠바고(embargoes 행)는 그대로이므로 응답의 적용 엠바고가 여전히 active일 수 있습니다.
 */
export async function lowerProjectEmbargo(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<EmbargoDto> {
  await requireOperator(db, actor)
  const input = parseInput(lowerEmbargoSchema, rawInput)
  if (!isUuid(projectId)) throw notFound()
  return db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projects.id, embargoUntil: projects.embargoUntil })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .for('update')
    if (!project) throw notFound()
    const result = lowerEmbargo(project.embargoUntil, input.until ? new Date(input.until) : null)
    if (!result.ok) throw invalid({ until: result.error })
    await tx.update(projects).set({ embargoUntil: result.until }).where(eq(projects.id, project.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'embargo.lower',
      targetType: 'project',
      targetId: project.id,
      projectId: project.id,
      metadata: {
        from: project.embargoUntil?.toISOString() ?? null,
        to: result.until?.toISOString() ?? null,
        reason: input.reason,
      },
    })
    return toEmbargoDto(await getProjectEmbargo(tx, project.id, now))
  })
}
