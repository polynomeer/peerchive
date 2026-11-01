/**
 * 스터디 기록 (C-08, PROOFU_EVOLUTION_PLAN §8.9.5·§8.9.8, SYSTEM_DESIGN §6.7 StudyRecord, DELIVERY_PLAN §4.1 C-08, ADR 0026).
 *
 * - 스터디 방의 방장(owner)이 "스터디 기록"을 켜면 내부 과제 공간(kind study)을 만들고 `study_records`로 1:1 연결합니다. 빌드 로그·마일스톤·
 *   할 일·파일·공개 후보·동의·게시는 기존 과제 서비스를 그대로 씁니다(권한도 과제 멤버십 그대로).
 * - **멤버십의 원천은 방 멤버십 하나**입니다. 과제 멤버십은 방 멤버십을 바꾸는 같은 트랜잭션에서 `syncStudyRecordInTx`가 다시 계산해 씁니다
 *   (@peerchive/domain planStudyRecordSync: 방장 → owner, 그 밖의 active 멤버 → editor, 방이 보관·제한되면 owner 외 viewer, 떠나면 left,
 *   내보내지면 removed). 과제 쪽의 초대·역할·내보내기·나가기·소유권 이전은 409 `study_managed`이므로 두 원천이 갈라질 길이 없습니다.
 *   부르는 곳: 가입·초대 수락·승인·나가기(승계)·내보내기·역할 변경(소유권 이전)·보관·운영 제한/해제. 탈퇴 정리(worker purge)도 같은 계획 함수를 씁니다.
 * - 과제 제목은 방 이름을 옮기지 않습니다("과목 이름 스터디 기록" 또는 "스터디 기록"). 커뮤니티 글·이름은 커뮤니티 테이블 밖으로 나가지 않습니다(C-05 센티넬).
 * - 방의 이름 표시 방식은 과제 행(`projects.study_name_mode`)에 옮겨 둡니다(켤 때, worker가 변경을 적용할 때). 과제·공개 모듈은 커뮤니티 테이블을
 *   읽지 않고 이 열만 봅니다. 익명 방이면 기록 안의 다른 멤버 이름을 가리고, 공개는 모두 익명으로만, 포트폴리오 연결은 막습니다.
 * - 기록을 끄는 경로는 없습니다(공개 사례·동의가 이 과제를 가리킬 수 있음).
 */
import { z } from 'zod'
import { asRoomNameMode, planStudyRecordSync } from '@peerchive/domain'
import { and, communitySpaces, courses, eq, projectMembers, projects, spaceMemberships, sql, studyRecords, type DbExecutor } from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { recordAudit } from '../audit/audit'
import { loadCanonicalTerm } from '../catalog/catalog'
import { type Actor, conflict, forbidden, invalid } from '../errors'
import { insertProjectInTx } from '../projects/projects'
import { parseInput } from '../validation'
import { loadReadableSpace, membershipFacts, writeRestricted } from './access'
import type { StudyRecordStateDto } from '../../../shared/types/api'

/**
 * 연결된 스터디 기록이 있으면 과제 멤버십·owner를 방 멤버십에 맞춥니다(멱등). 방 멤버십을 바꾼 **같은 트랜잭션** 안에서, 공간 행을 잠근 뒤 부릅니다.
 * 바뀐 것이 있으면 감사 `project.study_sync`(개수만)를 남깁니다. 기록이 없으면 아무것도 하지 않습니다.
 */
export async function syncStudyRecordInTx(tx: DbExecutor, spaceId: string, now: Date): Promise<void> {
  const [record] = await tx.select({ projectId: studyRecords.projectId }).from(studyRecords).where(eq(studyRecords.spaceId, spaceId)).limit(1)
  if (!record) return
  const [space] = await tx.select({ status: communitySpaces.status }).from(communitySpaces).where(eq(communitySpaces.id, spaceId)).limit(1)
  const [project] = await tx.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, record.projectId)).limit(1).for('update')
  if (!space || !project) return
  const [roomMembers, recordMembers] = await Promise.all([
    tx.select({ userId: spaceMemberships.userId, role: spaceMemberships.role, status: spaceMemberships.status }).from(spaceMemberships).where(eq(spaceMemberships.spaceId, spaceId)),
    tx.select({ userId: projectMembers.userId, role: projectMembers.role, status: projectMembers.status }).from(projectMembers).where(eq(projectMembers.projectId, record.projectId)),
  ])
  const plan = planStudyRecordSync(roomMembers, recordMembers, space.status)
  for (const u of plan.updates) {
    await tx
      .update(projectMembers)
      .set({ role: u.role, status: u.status, updatedAt: now })
      .where(and(eq(projectMembers.projectId, record.projectId), eq(projectMembers.userId, u.userId)))
  }
  if (plan.inserts.length) {
    await tx.insert(projectMembers).values(plan.inserts.map((i) => ({ projectId: record.projectId, userId: i.userId, role: i.role, status: 'active' as const, createdAt: now, updatedAt: now })))
  }
  const ownerChanged = plan.ownerId !== null && plan.ownerId !== project.ownerId
  if (ownerChanged) {
    await tx.update(projects).set({ ownerId: plan.ownerId!, version: sql`${projects.version} + 1`, updatedAt: now }).where(eq(projects.id, record.projectId))
  }
  if (plan.inserts.length || plan.updates.length || ownerChanged) {
    await recordAudit(tx, {
      actorId: null,
      action: 'project.study_sync',
      targetType: 'project',
      targetId: record.projectId,
      projectId: record.projectId,
      metadata: { inserted: plan.inserts.length, updated: plan.updates.length, ownerChanged },
    })
  }
}

/**
 * GET /community/spaces/:slug/study-record — 방을 읽을 수 있는 사람(404). 스터디 방이 아니면 `available: false`.
 * 기록이 켜져 있으면 과제 id와 내 과제 역할(방 멤버가 아니면 null), 방장에게는 켜기 가능 여부.
 */
export async function getStudyRecord(db: DbExecutor, actor: Actor, ref: unknown): Promise<StudyRecordStateDto> {
  const ctx = await loadReadableSpace(db, actor, ref)
  return stateFor(db, actor, ctx)
}

async function stateFor(db: DbExecutor, actor: Actor, ctx: Awaited<ReturnType<typeof loadReadableSpace>>): Promise<StudyRecordStateDto> {
  const space = ctx.space.row
  const m = membershipFacts(ctx.membership)
  const isOwner = m?.status === 'active' && m.role === 'owner'
  const nameMode = asRoomNameMode(space.currentNameMode)
  const base = { nameMode, portfolioLinkable: nameMode !== 'anonymous' }
  if (space.kind !== 'study_room') return { available: false, enabled: false, projectId: null, myRole: null, canEnable: false, ...base }
  const [record] = await db.select({ projectId: studyRecords.projectId }).from(studyRecords).where(eq(studyRecords.spaceId, space.id)).limit(1)
  if (!record) {
    return { available: true, enabled: false, projectId: null, myRole: null, canEnable: isOwner && space.status === 'active', ...base }
  }
  const [mine] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, record.projectId), eq(projectMembers.userId, actor.userId), eq(projectMembers.status, 'active')))
    .limit(1)
  // 과제 id는 그 과제 멤버에게만 줍니다(방을 읽을 수 있어도 과제 멤버가 아니면 — 예: 운영자 — 링크 없음).
  return { available: true, enabled: true, projectId: mine ? record.projectId : null, myRole: mine?.role ?? null, canEnable: false, ...base }
}

export const enableStudyRecordSchema = z.object({
  /** 선택: 과목 학기 연결(엠바고 적용, T-10). 나중에 과제 화면에서도 바꿀 수 있습니다. */
  courseTermId: z.uuid({ error: 'invalid' }).transform((v) => v.toLowerCase()).nullish(),
})

/**
 * POST /community/spaces/:slug/study-record {courseTermId?} — 스터디 방의 방장만. 201 + 상태.
 * 403(방장 아님)·`write_restricted`, 404(읽을 수 없음), 409 `not_study_room`·`space_not_active`·`already_enabled`, 422 `courseTermId: not_found|invalid`.
 */
export async function enableStudyRecord(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<StudyRecordStateDto> {
  const input = parseInput(enableStudyRecordSchema, rawInput ?? {})
  return db.transaction(async (tx) => {
    const ctx = await loadReadableSpace(tx, actor, ref, true, now)
    const space = ctx.space.row
    if (space.kind !== 'study_room') throw conflict('not_study_room')
    const m = membershipFacts(ctx.membership)
    if (!(m?.status === 'active' && m.role === 'owner')) throw forbidden()
    if (space.status !== 'active') throw conflict('space_not_active', { status: space.status })
    if (ctx.viewer.writeRestriction) throw writeRestricted(ctx.viewer.writeRestriction)
    const [existing] = await tx.select({ id: studyRecords.id }).from(studyRecords).where(eq(studyRecords.spaceId, space.id)).limit(1)
    if (existing) throw conflict('already_enabled')

    // 제목: 방 이름을 옮기지 않습니다. 고른 학기 또는 방에 연결된 과목의 이름(카탈로그 데이터)만 씁니다.
    let courseTitle: string | null = null
    if (input.courseTermId) {
      const term = await loadCanonicalTerm(tx, input.courseTermId)
      if (!term) throw invalid({ courseTermId: 'not_found' })
      const [c] = await tx.select({ title: courses.title }).from(courses).where(eq(courses.id, term.courseId)).limit(1)
      courseTitle = c?.title ?? null
    } else if (space.linkedCourseId) {
      const [c] = await tx.select({ title: courses.title }).from(courses).where(eq(courses.id, space.linkedCourseId)).limit(1)
      courseTitle = c?.title ?? null
    }
    const title = courseTitle ? `${courseTitle} 스터디 기록`.slice(0, 120) : '스터디 기록'
    const project = await insertProjectInTx(
      tx,
      actor.userId,
      { title, kind: 'team', courseTermId: input.courseTermId ?? null, summaryByStudent: null, goal: null, constraints: null, retroMode: false },
      'study',
      { nameMode: asRoomNameMode(space.currentNameMode), schoolId: ctx.space.schoolId },
    )
    await tx.insert(studyRecords).values({ spaceId: space.id, projectId: project.id, enabledBy: actor.userId, createdAt: now })
    await syncStudyRecordInTx(tx, space.id, now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.study_record_enable',
      targetType: 'community_space',
      targetId: space.id,
      projectId: project.id,
      metadata: { mode: space.currentNameMode, withCourse: project.courseTermId !== null },
    })
    await emitAnalytics(tx, { name: 'study_record_enabled', actorId: actor.userId, props: { mode: space.currentNameMode, withCourse: project.courseTermId !== null }, now })
    return stateFor(tx, actor, ctx)
  })
}
