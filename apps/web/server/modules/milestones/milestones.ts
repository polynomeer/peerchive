/**
 * 마일스톤·스냅샷 (T-06, PROOFU_EVOLUTION_PLAN §6.3, SYSTEM_DESIGN §6.3, §8, §9).
 *
 * - 마일스톤은 순서 안내이며 완료 게이트가 아닙니다. 관리(만들기·수정·순서 변경·삭제·스냅샷)는 active owner/editor,
 *   reviewer/viewer는 읽기만 합니다(쓰기는 403). 읽을 수 없는 프로젝트·마일스톤은 404(§8).
 * - 순서(position)는 1부터 빈틈없이 이어집니다. 순서 변경은 지금 있는 id 전체의 순열만 받고(아니면 422),
 *   삭제하면 뒤의 마일스톤을 당깁니다. 만들기·순서 변경·삭제는 프로젝트 행을 잠가 직렬화합니다.
 * - 수정은 expectedVersion으로 낙관적 동시성을 확인합니다(낡으면 409 `version_conflict` + currentVersion).
 * - 삭제: 어떤 로그 revision(이전 revision 포함)이라도 가리키면 409 `in_use`. revision은 추가만 하는 이력이므로
 *   연결을 끊어(detach) 이력을 바꾸지 않습니다. 스냅샷은 이력이 아닌 큐레이션이라 마일스톤과 함께 지웁니다.
 * - 스냅샷은 같은 프로젝트의 clean 산출물 버전만(다른 프로젝트·없는 버전은 똑같이 422 `not_found`, clean이 아니면
 *   422 `not_clean`), 같은 버전 중복은 409 `duplicate`.
 * - 한도: 프로젝트당 마일스톤 12개, 마일스톤당 스냅샷 6개. 넘으면 409 `limit_reached` + limit(입력은 맞지만 지금 상태와 충돌).
 * - 사후 작성(T-07): 마일스톤·스냅샷은 만들(지정할) 때 프로젝트가 사후 작성 모드였는지를 retrospective로 고정합니다.
 * - 감사 이벤트에는 순서·개수 같은 최소 정보만 남기고 제목·메모는 넣지 않습니다(§6.6).
 */
import { z } from 'zod'
import {
  MILESTONE_LIMIT,
  MILESTONE_TEMPLATE,
  SNAPSHOT_LIMIT,
  canManageMilestones,
  checkMilestoneOrder,
  checkSnapshotTarget,
} from '@peerchive/domain'
import {
  and,
  artifactVersions,
  artifacts,
  asc,
  eq,
  gt,
  inArray,
  logEntries,
  logRevisions,
  milestoneSnapshots,
  milestones,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { contentUrlFor } from '../artifacts/artifacts'
import { type Actor, conflict, forbidden, invalid, notFound, sqlState } from '../errors'
import { claimedDateSchema, latestAllowedClaimedDate } from '../logs/payloads'
import { parseInput } from '../validation'
import { type ProjectRow, isUuid, loadReadableProject } from '../projects/access'
import type { MilestoneDto, MilestoneRefDto, MilestoneSnapshotDto } from '../../../shared/types/api'

export type { MilestoneDto }

type MilestoneRow = typeof milestones.$inferSelect

// ── 입력 ─────────────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const TITLE_MAX = 80
export const NOTE_MAX = 500
export const SNAPSHOT_NOTE_MAX = 300

const title = z
  .string({ error: requiredOr('invalid') })
  .trim()
  .min(1, { error: 'required' })
  .max(TITLE_MAX, { error: 'too_long' })

/** 선택 문자열. 빈 문자열·null은 비웁니다(null 저장). */
const optionalNote = (max: number) =>
  z
    .string({ error: 'invalid' })
    .trim()
    .max(max, { error: 'too_long' })
    .nullish()
    .transform((value) => (value ? value : null))

const date = claimedDateSchema.nullish().transform((value) => value ?? null)

const uuidLower = z.uuid({ error: requiredOr('invalid') }).transform((id) => id.toLowerCase())

export const createMilestoneSchema = z.object({
  title,
  note: optionalNote(NOTE_MAX),
  dueAt: date,
  claimedAt: date,
})

/** PATCH. 생략한 필드는 그대로 두고, null(또는 빈 문자열)은 비웁니다. 제목은 비울 수 없습니다. */
export const updateMilestoneSchema = z.object({
  expectedVersion: z
    .number({ error: requiredOr('invalid') })
    .int({ error: 'invalid' })
    .min(1, { error: 'invalid' }),
  title: title.optional(),
  note: optionalNote(NOTE_MAX).optional(),
  dueAt: date.optional(),
  claimedAt: date.optional(),
})

export const reorderSchema = z.object({
  // 한도보다 넉넉히 받아 길이가 다른 요청도 `mismatch`로 설명합니다.
  milestoneIds: z.array(uuidLower, { error: requiredOr('invalid') }).max(MILESTONE_LIMIT * 2, { error: 'too_many' }),
})

export const addSnapshotSchema = z.object({
  artifactVersionId: uuidLower,
  note: optionalNote(SNAPSHOT_NOTE_MAX),
})

/** 도달일(자기 기입)은 로그 수행일처럼 내일(UTC +1일)보다 미래일 수 없습니다. 예정일은 제한하지 않습니다. */
function checkClaimedAt(claimedAt: string | null | undefined, now: Date, previous?: string | null): void {
  if (claimedAt && claimedAt !== previous && claimedAt > latestAllowedClaimedDate(now)) {
    throw invalid({ claimedAt: 'too_far_future' })
  }
}

// ── 읽기 도우미 ───────────────────────────────────────────────────────────

/**
 * 마일스톤과 그 프로젝트 접근 컨텍스트. 마일스톤이 없거나 프로젝트를 읽을 수 없으면 똑같이 404.
 * - lockProject: 프로젝트 행을 잠급니다(순서를 바꾸는 작업: 삭제).
 * - lockMilestone: 마일스톤 행을 잠급니다(스냅샷 개수·순서). 프로젝트 → 마일스톤 순서로 잠급니다.
 */
async function loadReadableMilestone(
  db: DbExecutor,
  actor: Actor,
  milestoneId: unknown,
  options: { lockProject?: boolean; lockMilestone?: boolean } = {},
) {
  if (!isUuid(milestoneId)) throw notFound()
  const [found] = await db.select().from(milestones).where(eq(milestones.id, milestoneId)).limit(1)
  if (!found) throw notFound()
  const context = await loadReadableProject(db, actor, found.projectId, { lock: options.lockProject })
  if (!options.lockMilestone && !options.lockProject) return { ...context, milestone: found }
  // 잠근 뒤 다시 읽어 그 사이의 삭제·수정을 반영합니다.
  const query = db.select().from(milestones).where(eq(milestones.id, found.id)).limit(1)
  const [milestone] = options.lockMilestone ? await query.for('update') : await query
  if (!milestone) throw notFound()
  return { ...context, milestone }
}

function assertCanManage(actor: Actor, project: ProjectRow, membership: Parameters<typeof canManageMilestones>[2]) {
  if (!canManageMilestones({ userId: actor.userId }, project, membership)) throw forbidden()
}

async function projectMilestones(db: DbExecutor, projectId: string): Promise<MilestoneRow[]> {
  return db.select().from(milestones).where(eq(milestones.projectId, projectId)).orderBy(asc(milestones.position))
}

/** 마일스톤들의 스냅샷(지정 순서)과 로그 수를 모아 DTO로 만듭니다. */
async function toMilestoneDtos(db: DbExecutor, rows: MilestoneRow[]): Promise<MilestoneDto[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const [snapshots, counts] = await Promise.all([
    db
      .select({ snapshot: milestoneSnapshots, version: artifactVersions, title: artifacts.title })
      .from(milestoneSnapshots)
      .innerJoin(artifactVersions, eq(artifactVersions.id, milestoneSnapshots.artifactVersionId))
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(inArray(milestoneSnapshots.milestoneId, ids))
      .orderBy(asc(milestoneSnapshots.milestoneId), asc(milestoneSnapshots.position)),
    // 현재 revision 기준 로그 수(타임라인의 마일스톤 필터와 같은 기준).
    db
      .select({ milestoneId: logRevisions.milestoneId, count: sql<number>`count(*)::int` })
      .from(logEntries)
      .innerJoin(logRevisions, eq(logRevisions.id, logEntries.currentRevisionId))
      .where(inArray(logRevisions.milestoneId, ids))
      .groupBy(logRevisions.milestoneId),
  ])
  const snapshotsBy = new Map<string, MilestoneSnapshotDto[]>()
  for (const { snapshot, version, title } of snapshots) {
    const dto: MilestoneSnapshotDto = {
      artifactVersionId: version.id,
      artifactId: version.artifactId,
      title,
      fileName: version.fileName,
      versionNo: version.versionNo,
      mediaType: version.mediaType,
      scanStatus: version.scanStatus,
      contentUrl: version.scanStatus === 'clean' ? contentUrlFor(version.artifactId, version.id) : null,
      note: snapshot.note,
      retrospective: snapshot.retrospective,
      position: snapshot.position,
      createdAt: snapshot.createdAt.toISOString(),
    }
    snapshotsBy.set(snapshot.milestoneId, [...(snapshotsBy.get(snapshot.milestoneId) ?? []), dto])
  }
  const countBy = new Map(counts.map((row) => [row.milestoneId, row.count]))
  return rows.map((row) => ({
    id: row.id,
    projectId: row.projectId,
    position: row.position,
    title: row.title,
    note: row.note,
    dueAt: row.dueAt,
    claimedAt: row.claimedAt,
    // 공개 스냅샷(publication/snapshot.ts, T-11)도 마일스톤·스냅샷의 이 표시를 그대로 옮깁니다.
    retrospective: row.retrospective,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    logCount: countBy.get(row.id) ?? 0,
    snapshots: snapshotsBy.get(row.id) ?? [],
  }))
}

async function toMilestoneDto(db: DbExecutor, row: MilestoneRow): Promise<MilestoneDto> {
  const [dto] = await toMilestoneDtos(db, [row])
  if (!dto) throw notFound()
  return dto
}

/**
 * 순서를 orderedIds대로 1부터 다시 매깁니다(프로젝트 행을 잠근 트랜잭션 안에서만).
 * (project_id, position) unique 제약은 행마다 즉시 검사되므로, 먼저 모두 큰 값으로 밀어낸 뒤 다시 매깁니다.
 */
async function renumber(db: DbExecutor, projectId: string, orderedIds: readonly string[]): Promise<void> {
  await db
    .update(milestones)
    .set({ position: sql`${milestones.position} + 1000` })
    .where(eq(milestones.projectId, projectId))
  for (const [index, id] of orderedIds.entries()) {
    await db
      .update(milestones)
      .set({ position: index + 1 })
      .where(and(eq(milestones.projectId, projectId), eq(milestones.id, id)))
  }
}

// ── 조회 ─────────────────────────────────────────────────────────────────

/** 프로젝트의 마일스톤(순서대로) + 스냅샷 + 로그 수. 멤버(읽기 전용 포함). */
export async function listMilestones(db: DbExecutor, actor: Actor, projectId: unknown): Promise<MilestoneDto[]> {
  const { project } = await loadReadableProject(db, actor, projectId)
  return toMilestoneDtos(db, await projectMilestones(db, project.id))
}

// ── 만들기 ───────────────────────────────────────────────────────────────

/** 마지막 순서에 추가합니다. 한도(12개)를 넘으면 409 limit_reached. */
export async function createMilestone(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<MilestoneDto> {
  const input = parseInput(createMilestoneSchema, rawInput)
  checkClaimedAt(input.claimedAt, now)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertCanManage(actor, project, membership)
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(milestones)
      .where(eq(milestones.projectId, project.id))
    if (count >= MILESTONE_LIMIT) throw conflict('limit_reached', { limit: MILESTONE_LIMIT })
    const [row] = await tx
      .insert(milestones)
      .values({
        projectId: project.id,
        position: count + 1,
        retrospective: project.retroMode,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
        ...input,
      })
      .returning()
    if (!row) throw new Error('milestone insert failed')
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'milestone.create',
      targetType: 'milestone',
      targetId: row.id,
      projectId: project.id,
      metadata: { position: row.position },
    })
    return toMilestoneDto(tx, row)
  })
}

/**
 * 기본 단계(기획 → 중간발표 → 구현 → 검증 → 최종제출)를 한 번에 만듭니다. 마일스톤이 없는 프로젝트에서만
 * 쓸 수 있습니다(이미 있으면 409 `not_empty`). 이름은 만든 뒤 자유롭게 바꿀 수 있습니다.
 */
export async function applyMilestoneTemplate(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  now = new Date(),
): Promise<MilestoneDto[]> {
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertCanManage(actor, project, membership)
    const existing = await tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.projectId, project.id)).limit(1)
    if (existing.length > 0) throw conflict('not_empty')
    await tx.insert(milestones).values(
      MILESTONE_TEMPLATE.map((templateTitle, index) => ({
        projectId: project.id,
        position: index + 1,
        title: templateTitle,
        retrospective: project.retroMode,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })),
    )
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'milestone.apply_template',
      targetType: 'project',
      targetId: project.id,
      projectId: project.id,
      metadata: { count: MILESTONE_TEMPLATE.length },
    })
    return toMilestoneDtos(tx, await projectMilestones(tx, project.id))
  })
}

// ── 수정 ─────────────────────────────────────────────────────────────────

/** 제목·메모·예정일·도달일 수정. expectedVersion이 현재 version과 다르면 409 version_conflict(+currentVersion). */
export async function updateMilestone(
  db: DbExecutor,
  actor: Actor,
  milestoneId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<MilestoneDto> {
  const input = parseInput(updateMilestoneSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership, milestone } = await loadReadableMilestone(tx, actor, milestoneId, { lockMilestone: true })
    assertCanManage(actor, project, membership)
    if (milestone.version !== input.expectedVersion) {
      throw conflict('version_conflict', { currentVersion: milestone.version })
    }
    checkClaimedAt(input.claimedAt, now, milestone.claimedAt)
    const { expectedVersion, ...changes } = input
    const [updated] = await tx
      .update(milestones)
      .set({ ...changes, version: sql`${milestones.version} + 1`, updatedAt: now })
      .where(and(eq(milestones.id, milestone.id), eq(milestones.version, expectedVersion)))
      .returning()
    if (!updated) throw conflict('version_conflict', { currentVersion: milestone.version })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'milestone.update',
      targetType: 'milestone',
      targetId: milestone.id,
      projectId: project.id,
      metadata: { version: updated.version },
    })
    return toMilestoneDto(tx, updated)
  })
}

// ── 순서 변경 ─────────────────────────────────────────────────────────────

/**
 * 순서 변경. milestoneIds는 지금 있는 마일스톤 전체의 순열이어야 합니다:
 * 중복은 422 `{milestoneIds: 'duplicate'}`, 빠지거나 모르는 id는 422 `{milestoneIds: 'mismatch'}`.
 * 마일스톤의 version은 올리지 않습니다(내용 수정이 아님).
 */
export async function reorderMilestones(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
): Promise<MilestoneDto[]> {
  const input = parseInput(reorderSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertCanManage(actor, project, membership)
    const current = await projectMilestones(tx, project.id)
    const check = checkMilestoneOrder(
      current.map((row) => row.id),
      input.milestoneIds,
    )
    if (check !== 'ok') throw invalid({ milestoneIds: check })
    const unchanged = current.every((row, index) => row.id === input.milestoneIds[index])
    if (!unchanged) {
      await renumber(tx, project.id, input.milestoneIds)
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'milestone.reorder',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        metadata: { count: current.length },
      })
    }
    return toMilestoneDtos(tx, await projectMilestones(tx, project.id))
  })
}

// ── 삭제 ─────────────────────────────────────────────────────────────────

/**
 * 삭제(204). 어떤 로그 revision이라도 이 마일스톤을 가리키면 409 `in_use` + logCount(그 로그 수).
 * 스냅샷은 함께 지우고, 뒤 순서를 당겨 position을 빈틈없이 유지합니다.
 */
export async function deleteMilestone(db: DbExecutor, actor: Actor, milestoneId: unknown): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const { project, membership, milestone } = await loadReadableMilestone(tx, actor, milestoneId, {
        lockProject: true,
        lockMilestone: true,
      })
      assertCanManage(actor, project, membership)
      const [{ logCount } = { logCount: 0 }] = await tx
        .select({ logCount: sql<number>`count(distinct ${logRevisions.logEntryId})::int` })
        .from(logRevisions)
        .where(eq(logRevisions.milestoneId, milestone.id))
      if (logCount > 0) throw conflict('in_use', { logCount })

      await tx.delete(milestoneSnapshots).where(eq(milestoneSnapshots.milestoneId, milestone.id))
      await tx.delete(milestones).where(eq(milestones.id, milestone.id))
      const rest = await projectMilestones(tx, project.id)
      await renumber(
        tx,
        project.id,
        rest.map((row) => row.id),
      )
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'milestone.delete',
        targetType: 'milestone',
        targetId: milestone.id,
        projectId: project.id,
        metadata: { position: milestone.position },
      })
    })
  } catch (error) {
    // 확인과 삭제 사이에 다른 트랜잭션이 이 마일스톤을 가리키는 revision을 커밋한 경우(외래 키 위반).
    if (sqlState(error) === '23503') throw conflict('in_use')
    throw error
  }
}

// ── 스냅샷 ───────────────────────────────────────────────────────────────

/**
 * 스냅샷 지정(201, 갱신된 마일스톤). 같은 프로젝트의 clean 버전만 지정합니다.
 * 없거나 다른 프로젝트 버전은 422 `{artifactVersionId: 'not_found'}`, clean이 아니면 `not_clean`,
 * 이미 지정한 버전은 409 `duplicate`, 6개가 차면 409 `limit_reached`.
 */
export async function addSnapshot(
  db: DbExecutor,
  actor: Actor,
  milestoneId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<MilestoneDto> {
  const input = parseInput(addSnapshotSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership, milestone } = await loadReadableMilestone(tx, actor, milestoneId, { lockMilestone: true })
    assertCanManage(actor, project, membership)
    const [target] = await tx
      .select({ projectId: artifacts.projectId, scanStatus: artifactVersions.scanStatus })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(eq(artifactVersions.id, input.artifactVersionId))
      .limit(1)
    const check = checkSnapshotTarget(project.id, target)
    if (check !== 'ok') throw invalid({ artifactVersionId: check })

    const existing = await tx
      .select({ versionId: milestoneSnapshots.artifactVersionId })
      .from(milestoneSnapshots)
      .where(eq(milestoneSnapshots.milestoneId, milestone.id))
    if (existing.some((row) => row.versionId === input.artifactVersionId)) throw conflict('duplicate')
    if (existing.length >= SNAPSHOT_LIMIT) throw conflict('limit_reached', { limit: SNAPSHOT_LIMIT })

    await tx.insert(milestoneSnapshots).values({
      milestoneId: milestone.id,
      artifactVersionId: input.artifactVersionId,
      note: input.note,
      position: existing.length + 1,
      retrospective: project.retroMode,
      createdBy: actor.userId,
      createdAt: now,
    })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'milestone.snapshot_add',
      targetType: 'milestone',
      targetId: milestone.id,
      projectId: project.id,
      metadata: { artifactVersionId: input.artifactVersionId },
    })
    await emitAnalytics(tx, { name: 'milestone_snapshot_set', actorId: actor.userId, projectId: project.id, props: { retro: project.retroMode } })
    return toMilestoneDto(tx, milestone)
  })
}

/** 스냅샷 해제(204). 지정되지 않은 버전이면 404. 뒤 순서를 당깁니다. 산출물 버전 자체는 그대로입니다. */
export async function removeSnapshot(
  db: DbExecutor,
  actor: Actor,
  milestoneId: unknown,
  artifactVersionId: unknown,
): Promise<void> {
  await db.transaction(async (tx) => {
    const { project, membership, milestone } = await loadReadableMilestone(tx, actor, milestoneId, { lockMilestone: true })
    assertCanManage(actor, project, membership)
    if (!isUuid(artifactVersionId)) throw notFound()
    const [removed] = await tx
      .delete(milestoneSnapshots)
      .where(
        and(
          eq(milestoneSnapshots.milestoneId, milestone.id),
          eq(milestoneSnapshots.artifactVersionId, artifactVersionId.toLowerCase()),
        ),
      )
      .returning({ position: milestoneSnapshots.position })
    if (!removed) throw notFound()
    await tx
      .update(milestoneSnapshots)
      .set({ position: sql`${milestoneSnapshots.position} - 1` })
      .where(and(eq(milestoneSnapshots.milestoneId, milestone.id), gt(milestoneSnapshots.position, removed.position)))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'milestone.snapshot_remove',
      targetType: 'milestone',
      targetId: milestone.id,
      projectId: project.id,
      metadata: { artifactVersionId: artifactVersionId.toLowerCase() },
    })
  })
}

// ── 빌드 로그 연결 (logs.ts가 씀) ─────────────────────────────────────────

/**
 * 로그 revision이 가리킬 마일스톤 확인. 없거나 다른 프로젝트 것이면 422 `{milestoneId: 'not_found'}`
 * (해결 대상과 같은 규칙). 확인한 행을 KEY SHARE로 잠가, 커밋 전에 그 마일스톤이 지워지지 않게 합니다.
 */
export async function checkLogMilestone(db: DbExecutor, projectId: string, milestoneId: string): Promise<void> {
  const [row] = await db
    .select({ projectId: milestones.projectId })
    .from(milestones)
    .where(eq(milestones.id, milestoneId))
    .limit(1)
    .for('key share')
  if (!row || row.projectId !== projectId) throw invalid({ milestoneId: 'not_found' })
}

/** 로그 DTO에 붙일 마일스톤 참조(현재 순서·제목). */
export async function milestoneRefsById(db: DbExecutor, ids: readonly string[]): Promise<Map<string, MilestoneRefDto>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: milestones.id, position: milestones.position, title: milestones.title })
    .from(milestones)
    .where(inArray(milestones.id, unique))
  return new Map(rows.map((row) => [row.id, row]))
}
