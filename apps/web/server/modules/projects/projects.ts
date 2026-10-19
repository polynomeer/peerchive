/**
 * 과제 공간 생성·조회·수정 (T-03, SYSTEM_DESIGN §6.3, §9).
 * 과제 공간은 항상 비공개입니다. 공개는 별도 release 스냅샷으로만 합니다(불변조건 1).
 */
import { z } from 'zod'
import { canEditProject, type ProjectRole } from '@peerchive/domain'
import { and, desc, eq, sql, courseTerms, projectMembers, projects, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, invalid } from '../errors'
import { parseInput } from '../validation'
import { type ProjectRow, loadReadableProject } from './access'
import type { ProjectDto } from '../../../shared/types/api'

export type { ProjectDto }

const longText = z
  .string({ error: 'invalid' })
  .trim()
  .max(2000, { error: 'too_long' })
  .nullish()
  .transform((value) => (value ? value : null))
const title = z.string({ error: 'invalid' }).trim().min(1, { error: 'required' }).max(120, { error: 'too_long' })

export const createProjectSchema = z.object({
  title,
  kind: z.enum(['individual', 'team'], { error: 'invalid' }).default('individual'),
  courseTermId: z.uuid({ error: 'invalid' }).nullish(),
  summaryByStudent: longText,
  goal: longText,
  constraints: longText,
})

export const updateProjectSchema = z.object({
  expectedVersion: z
    .number({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
    .int({ error: 'invalid' })
    .min(1, { error: 'invalid' }),
  title: title.optional(),
  kind: z.enum(['individual', 'team'], { error: 'invalid' }).optional(),
  lifecycle: z.enum(['planning', 'active', 'completed', 'archived'], { error: 'invalid' }).optional(),
  summaryByStudent: longText.optional(),
  goal: longText.optional(),
  constraints: longText.optional(),
})

export function toProjectDto(row: ProjectRow, myRole: ProjectRole): ProjectDto {
  return {
    id: row.id,
    title: row.title,
    summaryByStudent: row.summaryByStudent,
    goal: row.goal,
    constraints: row.constraints,
    kind: row.kind,
    lifecycle: row.lifecycle,
    courseTermId: row.courseTermId,
    retroMode: row.retroMode,
    visibility: 'private',
    version: row.version,
    myRole,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 생성자는 같은 트랜잭션에서 active owner 멤버가 됩니다. */
export async function createProject(db: DbExecutor, actor: Actor, rawInput: unknown): Promise<ProjectDto> {
  const input = parseInput(createProjectSchema, rawInput)
  return db.transaction(async (tx) => {
    if (input.courseTermId) {
      const [term] = await tx
        .select({ id: courseTerms.id })
        .from(courseTerms)
        .where(eq(courseTerms.id, input.courseTermId))
        .limit(1)
      if (!term) throw invalid({ courseTermId: 'not_found' })
    }
    const [project] = await tx
      .insert(projects)
      .values({
        ownerId: actor.userId,
        title: input.title,
        kind: input.kind,
        courseTermId: input.courseTermId ?? null,
        summaryByStudent: input.summaryByStudent,
        goal: input.goal,
        constraints: input.constraints,
      })
      .returning()
    if (!project) throw new Error('project insert failed')
    await tx.insert(projectMembers).values({ projectId: project.id, userId: actor.userId, role: 'owner', status: 'active' })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'project.create',
      targetType: 'project',
      targetId: project.id,
      projectId: project.id,
    })
    return toProjectDto(project, 'owner')
  })
}

/** 요청자가 active 멤버인 프로젝트 목록(최근 수정순). */
export async function listMyProjects(db: DbExecutor, actor: Actor): Promise<ProjectDto[]> {
  const rows = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active')))
    .orderBy(desc(projects.updatedAt), desc(projects.id))
    .limit(200)
  return rows.map((row) => toProjectDto(row.project, row.role))
}

export async function getProject(db: DbExecutor, actor: Actor, projectId: unknown): Promise<ProjectDto> {
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  return toProjectDto(project, membership.role)
}

/** owner/editor만. expectedVersion이 현재 version과 다르면 409(version_conflict). */
export async function updateProject(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
): Promise<ProjectDto> {
  const input = parseInput(updateProjectSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    if (!canEditProject({ userId: actor.userId }, project, membership)) throw forbidden()
    if (project.version !== input.expectedVersion) throw conflict('version_conflict')

    const { expectedVersion, ...changes } = input
    const [updated] = await tx
      .update(projects)
      .set({ ...changes, version: sql`${projects.version} + 1`, updatedAt: new Date() })
      .where(and(eq(projects.id, project.id), eq(projects.version, expectedVersion)))
      .returning()
    if (!updated) throw conflict('version_conflict')
    return toProjectDto(updated, membership.role)
  })
}
