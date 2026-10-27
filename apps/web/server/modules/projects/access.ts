/**
 * 프로젝트 접근 컨텍스트 로딩. 모든 프로젝트 서비스는 여기서 시작합니다.
 * 존재하지 않거나 읽을 수 없는 프로젝트는 똑같이 NOT_FOUND(404)입니다(§8).
 */
import { canReadProjectWorkspace, type Membership } from '@peerchive/domain'
import { and, eq, institutionAffiliations, projectMembers, projects, schools, sql, type DbExecutor } from '@peerchive/db'
import { type Actor, conflict, notFound } from '../errors'

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
  // 스터디 기록(C-08): 방의 열람 범위(C-05)처럼 학교 인증도 있어야 합니다(해제하면 멤버여도 다음 요청부터 404).
  if (project.kind === 'study' && !(await hasStudyAffiliation(db, actor.userId, project.studySchoolId))) throw notFound()
  return { project, membership }
}

/**
 * 스터디 기록을 읽을 학교 인증(C-08, ADR 0026 — C-05 `canReadSpace`의 학교 조건과 같음): 방에 학교가 연결되어 있으면 그 학교(정본 비교)의
 * active 인증, 학교 무관 방이면 아무 학교의 active 인증. 학교 인증 테이블만 읽습니다(커뮤니티 테이블은 읽지 않음).
 */
export async function hasStudyAffiliation(db: DbExecutor, userId: string, studySchoolId: string | null): Promise<boolean> {
  const canonical = sql`coalesce(${schools.mergedInto}, ${schools.id})`
  const target = studySchoolId ? sql`(select coalesce(s.merged_into, s.id) from schools s where s.id = ${studySchoolId})` : null
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(and(eq(institutionAffiliations.userId, userId), eq(institutionAffiliations.status, 'active'), target ? sql`${canonical} = ${target}` : undefined))
    .limit(1)
  return !!row
}

// ── 스터디 기록(C-08, ADR 0026) ───────────────────────────────────────────

/**
 * 스터디 기록(kind = study)의 멤버십은 스터디 방에서 파생됩니다(커뮤니티 모듈이 방 멤버십을 바꾸는 트랜잭션에서 다시 계산해 씀).
 * 과제 쪽의 초대·역할 변경·내보내기·나가기·소유권 이전은 409 `study_managed`(멤버 관리는 스터디 방에서).
 */
export function assertNotStudyManaged(project: Pick<ProjectRow, 'kind'>): void {
  if (project.kind === 'study') throw conflict('study_managed')
}

// 익명 스터디 기록의 이름·id 가리기는 member-refs.ts(`loadMemberRefs`, ADR 0026 부록).
export { isAnonymousStudyProject } from './member-refs'
