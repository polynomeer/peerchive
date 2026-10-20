/**
 * 할 일 (T-07, PROOFU_EVOLUTION_PLAN §6.6, SYSTEM_DESIGN §2.2 Card → Task, §6.3, §8, §9).
 *
 * - 2019 ProofU의 List/Card를 가벼운 할 일 목록으로 이어받습니다. 관리는 active owner/editor, reviewer/viewer는 읽기만
 *   합니다(쓰기는 403). 읽을 수 없는 프로젝트·할 일은 404(§8).
 * - 순서(position)는 (프로젝트, 상태) 목록마다 1부터 빈틈없이 이어집니다. 상태를 바꾸면 새 상태 목록의 맨 뒤로 가고
 *   원래 목록은 당깁니다. 순서 변경은 한 상태 목록 전체의 순열만 받습니다(아니면 422 `mismatch`/`duplicate`).
 *   모든 쓰기는 프로젝트 행을 잠가 직렬화합니다(순서·한도·담당자 멤버십 확인이 멤버 변경과 엇갈리지 않음).
 * - 수정·완료는 expectedVersion으로 낙관적 동시성을 확인합니다(낡으면 409 `version_conflict` + currentVersion).
 *   같은 상태 안의 순서 변경은 version을 올리지 않습니다.
 * - 담당자는 지정·변경할 때 이 프로젝트의 active 멤버여야 합니다(아니면 422 `{assigneeId: 'not_member'}`).
 *   지정한 뒤 그 멤버가 나가도 지정은 남고, 다른 필드만 고칠 때는 다시 확인하지 않습니다.
 * - 완료(`/complete`)는 응답에 프롬프트(`askStuck`, `askDecision`)를 실어 화면이 "막힌 적 있었나요? 결정할 게 있었나요?"를
 *   한 번 묻게 합니다. 응답하지 않아도 완료는 끝났습니다. 이미 완료한 할 일에 다시 보내면 바꾸지 않고 200으로 돌려줍니다(재전송).
 * - 전환(`/convert`)은 완료한 할 일을 빌드 로그(source `task`)로 한 번만 남깁니다. 로그 검증·권한은 logs.ts의
 *   parseLogInput·insertLog를 그대로 씁니다(payload 규칙을 나누지 않음). 완료 전이면 409 `not_done`,
 *   이미 전환했으면 409 `already_converted`. 연결은 tasks.log_entry_id(unique)에 둡니다.
 * - 삭제: 전환한 할 일은 그 로그의 출처이므로 409 `converted`. 나머지는 지우고 같은 상태 목록을 당깁니다(204).
 * - 한도: 열린(할 일·진행 중) 할 일 200개, 전체 500개. 넘으면 409 `limit_reached` + limit.
 * - 감사 이벤트에는 상태·태그 같은 최소 정보만 남기고 제목·메모는 넣지 않습니다(§6.6).
 */
import { z } from 'zod'
import {
  OPEN_TASK_LIMIT,
  TASK_CONVERT_TAGS,
  TASK_LIMIT,
  TASK_STATUSES,
  type Membership,
  type TaskStatus,
  canDeleteTask,
  canManageTasks,
  checkTaskConvert,
  checkTaskOrder,
  opensTask,
  statusChange,
} from '@peerchive/domain'
import { and, asc, eq, isNull, logEntries, profiles, projectMembers, sql, tasks, users, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, invalid, notFound } from '../errors'
import { insertLog, parseLogInput } from '../logs/logs'
import { claimedDateSchema } from '../logs/payloads'
import { parseInput } from '../validation'
import { type ProjectRow, isUuid, loadReadableProject } from '../projects/access'
import type { LogTag, TaskCompleteDto, TaskConvertDto, TaskDto } from '../../../shared/types/api'

export type { TaskDto }

type TaskRow = typeof tasks.$inferSelect

/** 완료 응답의 프롬프트. 화면이 막힘·결정을 한 번 묻습니다. */
export const COMPLETE_PROMPT = { askStuck: true, askDecision: true } as const

// ── 입력 ─────────────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const TITLE_MAX = 120
export const NOTE_MAX = 1000

const title = z
  .string({ error: requiredOr('invalid') })
  .trim()
  .min(1, { error: 'required' })
  .max(TITLE_MAX, { error: 'too_long' })

/** 선택 메모. 빈 문자열·null은 비웁니다. */
const note = z
  .string({ error: 'invalid' })
  .trim()
  .max(NOTE_MAX, { error: 'too_long' })
  .nullish()
  .transform((value) => (value ? value : null))

const dueAt = claimedDateSchema.nullish().transform((value) => value ?? null)
const assigneeId = z
  .uuid({ error: 'invalid' })
  .nullish()
  .transform((id) => (id ? id.toLowerCase() : null))
const status = z.enum(TASK_STATUSES, { error: requiredOr('invalid') })
const expectedVersion = z
  .number({ error: requiredOr('invalid') })
  .int({ error: 'invalid' })
  .min(1, { error: 'invalid' })

export const createTaskSchema = z.object({
  title,
  note,
  assigneeId,
  dueAt,
  // 바로 완료 상태로 만들지는 않습니다(완료는 프롬프트와 함께 /complete로).
  status: z.enum(['todo', 'doing'], { error: 'invalid' }).default('todo'),
})

/** PATCH. 생략한 필드는 그대로 두고, null(또는 빈 문자열)은 비웁니다. 제목은 비울 수 없습니다. */
export const updateTaskSchema = z.object({
  expectedVersion,
  title: title.optional(),
  note: note.optional(),
  assigneeId: assigneeId.optional(),
  dueAt: dueAt.optional(),
  status: status.optional(),
})

export const completeTaskSchema = z.object({ expectedVersion })

export const reorderTasksSchema = z.object({
  status,
  // 한도보다 넉넉히 받아 길이가 다른 요청도 `mismatch`로 설명합니다.
  taskIds: z
    .array(z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()), { error: requiredOr('invalid') })
    .max(TASK_LIMIT * 2, { error: 'too_many' }),
})

export const listTasksQuerySchema = z.object({ status: z.enum(TASK_STATUSES, { error: 'invalid' }).optional() })

// ── 읽기 도우미 ───────────────────────────────────────────────────────────

/** 할 일 + 담당자 이름 + 전환한 로그의 태그. */
function selectTasks(db: DbExecutor) {
  return db
    .select({ task: tasks, assigneeName: users.displayName, assigneeHandle: profiles.handle, logTag: logEntries.tag })
    .from(tasks)
    .leftJoin(users, eq(users.id, tasks.assigneeId))
    .leftJoin(profiles, eq(profiles.userId, tasks.assigneeId))
    .leftJoin(logEntries, eq(logEntries.id, tasks.logEntryId))
}

interface SelectedTask {
  task: TaskRow
  assigneeName: string | null
  assigneeHandle: string | null
  logTag: LogTag | null
}

function toTaskDto(row: SelectedTask): TaskDto {
  const { task } = row
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    note: task.note,
    status: task.status,
    position: task.position,
    assignee: task.assigneeId
      ? { userId: task.assigneeId, displayName: row.assigneeName ?? '', handle: row.assigneeHandle }
      : null,
    dueAt: task.dueAt,
    completedAt: task.completedAt?.toISOString() ?? null,
    completedBy: task.completedBy,
    log: task.logEntryId && row.logTag ? { id: task.logEntryId, tag: row.logTag } : null,
    createdBy: task.createdBy,
    version: task.version,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  }
}

/** 프로젝트의 할 일(상태 순서 todo → doing → done, 그 안에서 position 순). */
async function projectTasks(db: DbExecutor, projectId: string, onlyStatus?: TaskStatus): Promise<TaskDto[]> {
  const conditions = [eq(tasks.projectId, projectId)]
  if (onlyStatus) conditions.push(eq(tasks.status, onlyStatus))
  // enum은 선언 순서(todo, doing, done)로 정렬됩니다.
  const rows = await selectTasks(db)
    .where(and(...conditions))
    .orderBy(asc(tasks.status), asc(tasks.position))
  return rows.map(toTaskDto)
}

async function getTaskDto(db: DbExecutor, taskId: string): Promise<TaskDto> {
  const [row] = await selectTasks(db).where(eq(tasks.id, taskId)).limit(1)
  if (!row) throw notFound()
  return toTaskDto(row)
}

/**
 * 할 일과 그 프로젝트 접근 컨텍스트. 할 일이 없거나 프로젝트를 읽을 수 없으면 똑같이 404.
 * 쓰기(lock)는 프로젝트 → 할 일 순서로 잠그고, 잠근 뒤 다시 읽어 그 사이의 변경을 반영합니다.
 */
async function loadReadableTask(db: DbExecutor, actor: Actor, taskId: unknown, options: { lock?: boolean } = {}) {
  if (!isUuid(taskId)) throw notFound()
  const [found] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  if (!found) throw notFound()
  const context = await loadReadableProject(db, actor, found.projectId, { lock: options.lock })
  if (!options.lock) return { ...context, task: found }
  const [task] = await db.select().from(tasks).where(eq(tasks.id, found.id)).limit(1).for('update')
  if (!task) throw notFound()
  return { ...context, task }
}

function assertCanManage(actor: Actor, project: ProjectRow, membership: Membership) {
  if (!canManageTasks({ userId: actor.userId }, project, membership)) throw forbidden()
}

/** 담당자는 이 프로젝트의 active 멤버(역할 무관)여야 합니다. 프로젝트 행을 잠근 트랜잭션에서 부릅니다. */
async function checkAssignee(db: DbExecutor, projectId: string, userId: string | null): Promise<void> {
  if (!userId) return
  const [row] = await db
    .select({ status: projectMembers.status })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    .limit(1)
  if (row?.status !== 'active') throw invalid({ assigneeId: 'not_member' })
}

async function countTasks(db: DbExecutor, projectId: string): Promise<{ total: number; open: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      open: sql<number>`count(*) filter (where ${tasks.status} <> 'done')::int`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
  return row ?? { total: 0, open: 0 }
}

async function nextPosition(db: DbExecutor, projectId: string, target: TaskStatus): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${tasks.position}), 0)::int` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, target)))
  return (row?.max ?? 0) + 1
}

/**
 * 한 상태 목록의 순서를 orderedIds대로 1부터 다시 매깁니다(프로젝트 행을 잠근 트랜잭션 안에서만).
 * (project_id, status, position) unique 제약은 행마다 즉시 검사되므로, 먼저 모두 큰 값으로 밀어낸 뒤 한 문장으로 다시 매깁니다.
 */
async function renumber(db: DbExecutor, projectId: string, target: TaskStatus, orderedIds: readonly string[]): Promise<void> {
  if (orderedIds.length === 0) return
  await db
    .update(tasks)
    .set({ position: sql`${tasks.position} + ${TASK_LIMIT * 2}` })
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, target)))
  const ids = sql.join(
    orderedIds.map((id) => sql`${id}`),
    sql`, `,
  )
  await db.execute(sql`
    update ${tasks} set position = v.ord::int
    from unnest(array[${ids}]::uuid[]) with ordinality as v(id, ord)
    where ${tasks.id} = v.id and ${tasks.projectId} = ${projectId} and ${tasks.status} = ${target}`)
}

/** 한 상태 목록의 빈틈을 당깁니다(지금 순서 유지). */
async function compact(db: DbExecutor, projectId: string, target: TaskStatus): Promise<void> {
  const rows = await db
    .select({ id: tasks.id, position: tasks.position })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.status, target)))
    .orderBy(asc(tasks.position))
  if (rows.every((row, index) => row.position === index + 1)) return
  await renumber(
    db,
    projectId,
    target,
    rows.map((row) => row.id),
  )
}

/** 상태 변경에 따라 바꿀 열(위치·완료 정보). same이면 빈 객체. 원래 목록의 빈틈은 호출자가 compact로 당깁니다. */
async function statusColumns(db: DbExecutor, actor: Actor, task: TaskRow, to: TaskStatus, now: Date) {
  const change = statusChange(task.status, to)
  if (change === 'same') return {}
  if (opensTask(task.status, to)) {
    const { open } = await countTasks(db, task.projectId)
    if (open >= OPEN_TASK_LIMIT) throw conflict('limit_reached', { limit: OPEN_TASK_LIMIT })
  }
  const position = await nextPosition(db, task.projectId, to)
  if (change === 'complete') return { status: to, position, completedAt: now, completedBy: actor.userId }
  if (change === 'reopen') return { status: to, position, completedAt: null, completedBy: null }
  return { status: to, position }
}

// ── 조회 ─────────────────────────────────────────────────────────────────

/** 프로젝트의 할 일(`status=`로 한 상태만). 멤버(읽기 전용 포함). */
export async function listTasks(db: DbExecutor, actor: Actor, projectId: unknown, rawQuery: unknown): Promise<TaskDto[]> {
  const query = parseInput(listTasksQuerySchema, rawQuery)
  const { project } = await loadReadableProject(db, actor, projectId)
  return projectTasks(db, project.id, query.status)
}

// ── 만들기 ───────────────────────────────────────────────────────────────

/** 상태 목록의 맨 뒤에 추가합니다. 한도를 넘으면 409 limit_reached. */
export async function createTask(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<TaskDto> {
  const input = parseInput(createTaskSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertCanManage(actor, project, membership)
    await checkAssignee(tx, project.id, input.assigneeId)
    const { total, open } = await countTasks(tx, project.id)
    if (total >= TASK_LIMIT) throw conflict('limit_reached', { limit: TASK_LIMIT })
    if (open >= OPEN_TASK_LIMIT) throw conflict('limit_reached', { limit: OPEN_TASK_LIMIT })
    const [row] = await tx
      .insert(tasks)
      .values({
        projectId: project.id,
        ...input,
        position: await nextPosition(tx, project.id, input.status),
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id, status: tasks.status })
    if (!row) throw new Error('task insert failed')
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'task.create',
      targetType: 'task',
      targetId: row.id,
      projectId: project.id,
      metadata: { status: row.status },
    })
    return getTaskDto(tx, row.id)
  })
}

// ── 수정 ─────────────────────────────────────────────────────────────────

/**
 * 제목·메모·담당자·마감일·상태 수정. expectedVersion이 다르면 409 version_conflict(+currentVersion).
 * 상태를 바꾸면 새 상태 목록의 맨 뒤로 갑니다. 여기서 완료로 바꿔도 되지만 프롬프트는 /complete만 돌려줍니다.
 */
export async function updateTask(
  db: DbExecutor,
  actor: Actor,
  taskId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<TaskDto> {
  const input = parseInput(updateTaskSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership, task } = await loadReadableTask(tx, actor, taskId, { lock: true })
    assertCanManage(actor, project, membership)
    if (task.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: task.version })
    if (input.assigneeId !== undefined && input.assigneeId !== task.assigneeId) {
      await checkAssignee(tx, project.id, input.assigneeId)
    }
    const { expectedVersion, status: nextStatus, ...changes } = input
    const moved = nextStatus ? await statusColumns(tx, actor, task, nextStatus, now) : {}
    const [updated] = await tx
      .update(tasks)
      .set({ ...changes, ...moved, version: sql`${tasks.version} + 1`, updatedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, expectedVersion)))
      .returning({ status: tasks.status, version: tasks.version })
    if (!updated) throw conflict('version_conflict', { currentVersion: task.version })
    if (updated.status !== task.status) await compact(tx, project.id, task.status)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'task.update',
      targetType: 'task',
      targetId: task.id,
      projectId: project.id,
      metadata: { version: updated.version, status: updated.status },
    })
    return getTaskDto(tx, task.id)
  })
}

// ── 순서 변경 ─────────────────────────────────────────────────────────────

/**
 * 한 상태 목록의 순서 변경. taskIds는 그 상태에 지금 있는 할 일 전체의 순열이어야 합니다:
 * 중복은 422 `{taskIds: 'duplicate'}`, 빠지거나 모르는 id(다른 상태 포함)는 422 `{taskIds: 'mismatch'}`.
 * version은 올리지 않습니다. 전체 목록을 돌려줍니다.
 */
export async function reorderTasks(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
): Promise<TaskDto[]> {
  const input = parseInput(reorderTasksSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    assertCanManage(actor, project, membership)
    const current = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.projectId, project.id), eq(tasks.status, input.status)))
      .orderBy(asc(tasks.position))
    const check = checkTaskOrder(
      current.map((row) => row.id),
      input.taskIds,
    )
    if (check !== 'ok') throw invalid({ taskIds: check })
    const unchanged = current.every((row, index) => row.id === input.taskIds[index])
    if (!unchanged) {
      await renumber(tx, project.id, input.status, input.taskIds)
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'task.reorder',
        targetType: 'project',
        targetId: project.id,
        projectId: project.id,
        metadata: { status: input.status, count: current.length },
      })
    }
    return projectTasks(tx, project.id)
  })
}

// ── 완료·로그 전환 ─────────────────────────────────────────────────────────

/**
 * 완료(200). 응답의 prompt로 화면이 막힘·결정을 한 번 묻습니다(이미 로그로 전환한 할 일이면 null).
 * 이미 완료한 할 일이면 아무것도 바꾸지 않고 지금 상태를 돌려줍니다(재전송에 안전).
 */
export async function completeTask(
  db: DbExecutor,
  actor: Actor,
  taskId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<TaskCompleteDto> {
  const input = parseInput(completeTaskSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership, task } = await loadReadableTask(tx, actor, taskId, { lock: true })
    assertCanManage(actor, project, membership)
    const promptFor = (logEntryId: string | null) => (logEntryId ? null : COMPLETE_PROMPT)
    if (task.status === 'done') return { task: await getTaskDto(tx, task.id), prompt: promptFor(task.logEntryId) }
    if (task.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: task.version })

    const moved = await statusColumns(tx, actor, task, 'done', now)
    await tx
      .update(tasks)
      .set({ ...moved, version: sql`${tasks.version} + 1`, updatedAt: now })
      .where(eq(tasks.id, task.id))
    await compact(tx, project.id, task.status)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'task.complete',
      targetType: 'task',
      targetId: task.id,
      projectId: project.id,
      metadata: { from: task.status },
    })
    return { task: await getTaskDto(tx, task.id), prompt: promptFor(task.logEntryId) }
  })
}

/**
 * 완료한 할 일을 빌드 로그로 남깁니다(201). 본문은 빌드 로그 작성과 같습니다(`tag`, `body?`, `payload`, `links?`,
 * `claimedDate?`, `milestoneId?`, `evidenceVersionIds?`). 태그는 🧱stuck·⚖️decision·🔨progress만(아니면 422 `{tag: 'invalid'}`),
 * payload·본문 검증은 빌드 로그 규칙 그대로(422). 완료 전이면 409 `not_done`, 이미 전환했으면 409 `already_converted`.
 */
export async function convertTask(
  db: DbExecutor,
  actor: Actor,
  taskId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<TaskConvertDto> {
  return db.transaction(async (tx) => {
    const { project, membership, task } = await loadReadableTask(tx, actor, taskId, { lock: true })
    assertCanManage(actor, project, membership)
    const check = checkTaskConvert(task)
    if (check !== 'ok') throw conflict(check)

    const raw = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {}
    if (raw.tag !== undefined && !(TASK_CONVERT_TAGS as readonly unknown[]).includes(raw.tag)) {
      throw invalid({ tag: 'invalid' })
    }
    // 재전송 식별자는 쓰지 않습니다: 한 번만 전환되므로 같은 요청을 다시 보내면 409 already_converted입니다.
    const parsed = parseLogInput({ ...raw, clientId: undefined }, now)
    const { log } = await insertLog(tx, actor, project, membership, parsed, 'task', now)

    const [linked] = await tx
      .update(tasks)
      .set({ logEntryId: log.id, version: sql`${tasks.version} + 1`, updatedAt: now })
      .where(and(eq(tasks.id, task.id), isNull(tasks.logEntryId)))
      .returning({ id: tasks.id })
    if (!linked) throw conflict('already_converted')
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'task.convert',
      targetType: 'task',
      targetId: task.id,
      projectId: project.id,
      metadata: { tag: log.tag, logId: log.id },
    })
    return { task: await getTaskDto(tx, task.id), log: { ...log, task: { id: task.id, title: task.title } } }
  })
}

// ── 삭제 ─────────────────────────────────────────────────────────────────

/** 삭제(204). 빌드 로그로 전환한 할 일은 409 `converted`(로그의 출처로 남김). 같은 상태 목록을 당깁니다. */
export async function deleteTask(db: DbExecutor, actor: Actor, taskId: unknown): Promise<void> {
  await db.transaction(async (tx) => {
    const { project, membership, task } = await loadReadableTask(tx, actor, taskId, { lock: true })
    assertCanManage(actor, project, membership)
    if (!canDeleteTask(task)) throw conflict('converted')
    await tx.delete(tasks).where(eq(tasks.id, task.id))
    await compact(tx, project.id, task.status)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'task.delete',
      targetType: 'task',
      targetId: task.id,
      projectId: project.id,
      metadata: { status: task.status },
    })
  })
}
