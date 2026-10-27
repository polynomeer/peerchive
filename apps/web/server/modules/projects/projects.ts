/**
 * 과제 공간 생성·조회·수정 (T-03, SYSTEM_DESIGN §6.3, §9).
 * 과제 공간은 항상 비공개입니다. 공개는 별도 release 스냅샷으로만 합니다(불변조건 1).
 *
 * 사후 작성 모드(retroMode, T-07): 만들 때 고르거나("지난 과제 되짚기") 나중에 owner만 켜고 끕니다.
 * editor가 다른 필드와 함께 retroMode를 바꾸려 하면 전체 요청을 403으로 거부합니다(같은 값이면 무시).
 * 모드는 이후 만드는 로그·마일스톤·스냅샷의 `사후 작성` 표시를 정하며, 이미 만든 항목의 표시는 바꾸지 않습니다.
 *
 * 개설 학기(courseTermId, T-10): 만들 때와 수정할 때(owner/editor) 정합니다. 병합된 학기를 고르면 정본 학기로 연결합니다.
 * 학기를 연결·변경할 때마다 embargo_until을 단조 규칙으로 올리며(embargo.ts nextEmbargoUntil), 떼거나 옛 학기로 바꿔도 줄지 않습니다.
 * 단건 조회·수정 응답은 적용 엠바고와 과목 정보를 함께 싣습니다(ProjectDetailDto).
 */
import { z } from 'zod'
import { canChangeRetroMode, canEditProject, type ProjectRole } from '@peerchive/domain'
import { and, desc, eq, sql, courses, projectMembers, projects, schools, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { loadCanonicalTerm, toCourseDto, toCourseTermDto, toSchoolDto } from '../catalog/catalog'
import { listCourseTags } from '../catalog/tags'
import { getProjectEmbargo, nextEmbargoUntil, toEmbargoDto } from '../embargo/embargo'
import { type Actor, conflict, forbidden, invalid } from '../errors'
import { parseInput } from '../validation'
import { type ProjectRow, hasStudyAffiliation, loadReadableProject } from './access'
import type { CourseContextDto, ProjectDetailDto, ProjectDto } from '../../../shared/types/api'

export type { ProjectDetailDto, ProjectDto }

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
  /** 지난 과제 되짚기(사후 작성). */
  retroMode: z.boolean({ error: 'invalid' }).default(false),
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
  /** owner만 바꿀 수 있습니다. */
  retroMode: z.boolean({ error: 'invalid' }).optional(),
  /** 개설 학기. null이면 연결 해제(엠바고는 줄지 않음). */
  courseTermId: z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()).nullable().optional(),
})

/**
 * 프로젝트 DTO. retrospective는 지금의 사후 작성 모드입니다.
 * 공개 스냅샷(publication/snapshot.ts, T-11)은 projects.retro_mode를 retrospective로 옮깁니다(test/retrospective-dto.test.ts가 지킴).
 */
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
    retrospective: row.retroMode,
    studyNameMode: row.studyNameMode,
    visibility: 'private',
    version: row.version,
    myRole,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 과목 정보 패널(학교·과목·학기·태그). 모든 이름은 학생 작성입니다. */
export async function getCourseContext(db: DbExecutor, courseTermId: string | null): Promise<CourseContextDto | null> {
  if (!courseTermId) return null
  const term = await loadCanonicalTerm(db, courseTermId)
  if (!term) return null
  const [row] = await db
    .select({ course: courses, school: schools })
    .from(courses)
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(eq(courses.id, term.courseId))
    .limit(1)
  if (!row) return null
  return {
    school: toSchoolDto(row.school),
    course: toCourseDto(row.course),
    term: toCourseTermDto(term),
    tags: await listCourseTags(db, row.course.id),
  }
}

/** 단건 DTO: 프로젝트 + 적용 엠바고 + 과목 정보. */
export async function toProjectDetailDto(
  db: DbExecutor,
  row: ProjectRow,
  myRole: ProjectRole,
  now: Date,
): Promise<ProjectDetailDto> {
  return {
    ...toProjectDto(row, myRole),
    embargo: toEmbargoDto(await getProjectEmbargo(db, row.id, now)),
    courseContext: await getCourseContext(db, row.courseTermId),
  }
}

/** 고른 학기의 정본 id. 없으면 422 `{courseTermId: 'not_found'}`. */
async function resolveTermId(db: DbExecutor, termId: string): Promise<string> {
  const term = await loadCanonicalTerm(db, termId)
  if (!term) throw invalid({ courseTermId: 'not_found' })
  return term.id
}

/** 생성자는 같은 트랜잭션에서 active owner 멤버가 됩니다. 학기를 고르면 그 학기 종료까지 엠바고가 걸립니다. */
export async function createProject(
  db: DbExecutor,
  actor: Actor,
  rawInput: unknown,
  now = new Date(),
  origin: 'web' | 'fork' = 'web',
): Promise<ProjectDetailDto> {
  const input = parseInput(createProjectSchema, rawInput)
  return db.transaction(async (tx) => {
    const project = await insertProjectInTx(tx, actor.userId, input, origin)
    return toProjectDetailDto(tx, project, 'owner', now)
  })
}

/**
 * 과제 공간 행 + owner 멤버십 + 감사 + 분석을 호출자의 트랜잭션 안에서 만듭니다(웹 만들기·포크·C-07 팀원 모집 마감·C-08 스터디 기록 켜기가 함께 씀).
 * `study`를 주면 스터디 기록(kind study, 방 이름 표시 방식을 옮겨 둠)이고, 나머지 멤버는 커뮤니티 모듈이 방 멤버십에서 채웁니다.
 * 항상 비공개이고, 학기를 주면 정본 학기로 연결해 엠바고를 겁니다(T-10). 학기가 없으면 422 `courseTermId: not_found`.
 */
export async function insertProjectInTx(
  tx: DbExecutor,
  ownerId: string,
  input: z.output<typeof createProjectSchema>,
  origin: 'web' | 'fork' | 'recruitment' | 'study',
  study: { nameMode: 'real' | 'display' | 'anonymous'; schoolId: string | null } | null = null,
): Promise<ProjectRow> {
  const courseTermId = input.courseTermId ? await resolveTermId(tx, input.courseTermId.toLowerCase()) : null
  const embargoUntil = await nextEmbargoUntil(tx, null, null, courseTermId)
  const [project] = await tx
    .insert(projects)
    .values({
      ownerId,
      title: input.title,
      kind: study ? 'study' : input.kind,
      studyNameMode: study?.nameMode ?? null,
      studySchoolId: study?.schoolId ?? null,
      courseTermId,
      embargoUntil,
      summaryByStudent: input.summaryByStudent,
      goal: input.goal,
      constraints: input.constraints,
      retroMode: input.retroMode,
    })
    .returning()
  if (!project) throw new Error('project insert failed')
  await tx.insert(projectMembers).values({ projectId: project.id, userId: ownerId, role: 'owner', status: 'active' })
  await recordAudit(tx, {
    actorId: ownerId,
    action: 'project.create',
    targetType: 'project',
    targetId: project.id,
    projectId: project.id,
    metadata: { retroMode: project.retroMode, courseTermId, embargoUntil: embargoUntil?.toISOString() ?? null, kind: project.kind },
  })
  await emitAnalytics(tx, {
    name: 'project_created',
    actorId: ownerId,
    projectId: project.id,
    props: { kind: project.kind, retro: project.retroMode, withCourse: courseTermId !== null, origin },
  })
  return project
}

/** 요청자가 active 멤버인 프로젝트 목록(최근 수정순). 스터디 기록(kind study, C-08)도 들어 있고 화면이 "스터디 기록" 묶음으로 따로 보입니다. */
export async function listMyProjects(db: DbExecutor, actor: Actor): Promise<ProjectDto[]> {
  const rows = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active')))
    .orderBy(desc(projects.updatedAt), desc(projects.id))
    .limit(200)
  // 스터디 기록(C-08)은 열 때와 같은 학교 인증 조건을 거칩니다(인증을 해제하면 목록에서도 빠짐).
  const visible = []
  for (const row of rows) if (row.project.kind !== 'study' || (await hasStudyAffiliation(db, actor.userId, row.project.studySchoolId))) visible.push(row)
  return visible.map((row) => toProjectDto(row.project, row.role))
}

export async function getProject(db: DbExecutor, actor: Actor, projectId: unknown, now = new Date()): Promise<ProjectDetailDto> {
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  return toProjectDetailDto(db, project, membership.role, now)
}

/**
 * owner/editor만. expectedVersion이 현재 version과 다르면 409(version_conflict).
 * retroMode를 지금과 다른 값으로 바꾸는 것은 owner만(아니면 403).
 * courseTermId를 바꾸면 embargo_until은 단조 규칙으로만 바뀝니다(줄지 않음).
 */
export async function updateProject(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<ProjectDetailDto> {
  const input = parseInput(updateProjectSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    if (!canEditProject({ userId: actor.userId }, project, membership)) throw forbidden()
    // 스터디 기록(C-08)의 종류는 바꿀 수 없습니다(멤버십이 스터디 방에서 파생됨).
    if (project.kind === 'study' && input.kind !== undefined) throw conflict('study_managed')
    const retroChange = input.retroMode !== undefined && input.retroMode !== project.retroMode
    if (retroChange && !canChangeRetroMode({ userId: actor.userId }, project, membership)) throw forbidden()
    if (project.version !== input.expectedVersion) throw conflict('version_conflict')

    const { expectedVersion, courseTermId: requestedTermId, ...changes } = input
    const nextTermId =
      requestedTermId === undefined ? project.courseTermId : requestedTermId && (await resolveTermId(tx, requestedTermId))
    const termChange = nextTermId !== project.courseTermId
    const embargoUntil = termChange
      ? await nextEmbargoUntil(tx, project.embargoUntil, project.courseTermId, nextTermId)
      : project.embargoUntil
    const [updated] = await tx
      .update(projects)
      .set({
        ...changes,
        ...(termChange && { courseTermId: nextTermId, embargoUntil }),
        version: sql`${projects.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(projects.id, project.id), eq(projects.version, expectedVersion)))
      .returning()
    if (!updated) throw conflict('version_conflict')
    if (retroChange) {
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'project.retro_mode',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        metadata: { retroMode: updated.retroMode },
      })
    }
    if (termChange) {
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'project.course_term',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        metadata: {
          from: project.courseTermId,
          to: updated.courseTermId,
          embargoUntil: updated.embargoUntil?.toISOString() ?? null,
        },
      })
    }
    return toProjectDetailDto(tx, updated, membership.role, now)
  })
}
