/**
 * 프로젝트 접근 컨텍스트 로딩. 모든 프로젝트 서비스는 여기서 시작합니다.
 * 존재하지 않거나 읽을 수 없는 프로젝트는 똑같이 NOT_FOUND(404)입니다(§8).
 */
import { canReadProjectWorkspace, type Membership } from '@peerchive/domain'
import { and, eq, projectMembers, projects, type DbExecutor } from '@peerchive/db'
import { type Actor, notFound } from '../errors'

export type ProjectRow = typeof projects.$inferSelect

export interface ProjectContext {
  project: ProjectRow
  /** 요청자의 active 멤버십(읽기 가능함이 확인된 상태). */
  membership: Membership
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export async function findMembership(db: DbExecutor, projectId: string, userId: string): Promise<Membership | null> {
  const [row] = await db
    .select({
      projectId: projectMembers.projectId,
      userId: projectMembers.userId,
      role: projectMembers.role,
      status: projectMembers.status,
    })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1)
  return row ?? null
}

/**
 * 프로젝트와 요청자 멤버십을 읽고 읽기 권한을 확인합니다.
 * `lock: true`면 프로젝트 행을 FOR UPDATE로 잠가 멤버 변경을 직렬화합니다(트랜잭션 안에서만).
 */
export async function loadReadableProject(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  options: { lock?: boolean } = {},
): Promise<ProjectContext> {
  if (!isUuid(projectId)) throw notFound()
  const query = db.select().from(projects).where(eq(projects.id, projectId)).limit(1)
  const [project] = options.lock ? await query.for('update') : await query
  if (!project) throw notFound()
  const membership = await findMembership(db, project.id, actor.userId)
  if (!canReadProjectWorkspace({ userId: actor.userId }, project, membership) || !membership) throw notFound()
  return { project, membership }
}
