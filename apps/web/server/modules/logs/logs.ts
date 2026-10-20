/**
 * 빌드 로그 작성·조회·수정 (T-04, SYSTEM_DESIGN §6.3, §8, §9).
 *
 * - 로그(log_entries)는 식별자이고 내용은 revision(log_revisions)에 쌓습니다. 수정은 항상 새 revision이며
 *   이전 revision을 덮어쓰지 않습니다. log_entries.current_revision_id가 최신 revision을 가리킵니다.
 * - 작성은 active owner/editor, 수정은 작성자 본인(지금도 owner/editor)만. reviewer/viewer는 읽기만 합니다.
 * - 읽을 수 없는 프로젝트·로그는 없는 것과 같은 404입니다(§8).
 * - 태그는 바꿀 수 없습니다: 수정 요청의 tag가 다르면 422 `{tag: 'immutable'}`(DB는 복합 외래 키로 한 번 더 막음).
 * - 낡은 expectedRevision은 409 `stale_revision` + `currentRevision`.
 * - 해결(solution)의 대상이 없거나 다른 프로젝트 로그면 422 `{resolvesEntryId: 'not_found'}`(존재를 구분하지 않음).
 * - 파일 근거(evidenceVersionIds, T-05)는 같은 프로젝트의 산출물 버전만 revision별로 붙입니다(artifacts/evidence.ts).
 *   수정 때 생략하면 이전 revision의 근거를 이어받습니다.
 * - 마일스톤(milestoneId, T-06)도 revision별 값입니다. 같은 프로젝트의 마일스톤만 가리키며, 없거나 다른 프로젝트 것이면
 *   422 `{milestoneId: 'not_found'}`. 수정 때 생략하면 이어받고 null이면 비웁니다. 목록은 `milestone=`으로 거릅니다.
 * - 출처·사후 작성(T-07): 사후 작성 모드 과제에서 쓴 로그는 source `retro`, 할 일에서 전환한 로그는 `task`이고,
 *   만들 때의 모드를 retrospective로 고정합니다. DTO의 retrospective는 isRetrospectiveLog로 정합니다.
 *   할 일 전환(tasks.ts)은 이 파일의 parseLogInput·insertLog를 그대로 써서 검증·권한 규칙을 나누지 않습니다.
 * - 감사 이벤트에는 태그·revision 번호만 남기고 본문은 넣지 않습니다(§6.6).
 */
import {
  type LogOrigin,
  type Membership,
  canReviseLog,
  canWriteLog,
  checkResolveTarget,
  isRetrospectiveLog,
  isTagChangeAllowed,
  logSourceFor,
} from '@peerchive/domain'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  ne,
  sql,
  logEntries,
  logRevisions,
  profiles,
  projectMembers,
  tasks,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { checkEvidence, evidenceByRevision, evidenceIdsByRevision, insertEvidence } from '../artifacts/evidence'
import { checkLogMilestone, milestoneRefsById } from '../milestones/milestones'
import { type Actor, conflict, forbidden, invalid, notFound } from '../errors'
import { parseInput } from '../validation'
import { type ProjectRow, isUuid, loadReadableProject } from '../projects/access'
import {
  type LogContent,
  createLogSchema,
  listLogsQuerySchema,
  reviseLogSchema,
  validateLogContent,
} from './payloads'
import type {
  LogAuthorDto,
  LogDto,
  LogLinkDto,
  LogPageDto,
  LogPayload,
  LogRefDto,
  LogRevisionDto,
  LogTag,
  TaskRefDto,
} from '../../../shared/types/api'

export type { LogDto, LogPageDto, LogRevisionDto }

type EntryRow = typeof logEntries.$inferSelect
type RevisionRow = typeof logRevisions.$inferSelect

interface LoadedLog {
  entry: EntryRow
  revision: RevisionRow
  author: LogAuthorDto
}

// ── 읽기 도우미 ───────────────────────────────────────────────────────────

/** entry + 현재 revision + 작성자를 한 번에 읽는 select. */
function selectLogs(db: DbExecutor) {
  return db
    .select({
      entry: logEntries,
      revision: logRevisions,
      displayName: users.displayName,
      handle: profiles.handle,
    })
    .from(logEntries)
    .innerJoin(logRevisions, eq(logRevisions.id, logEntries.currentRevisionId))
    .innerJoin(users, eq(users.id, logEntries.authorId))
    .leftJoin(profiles, eq(profiles.userId, logEntries.authorId))
}

function toLoaded(row: {
  entry: EntryRow
  revision: RevisionRow
  displayName: string
  handle: string | null
}): LoadedLog {
  return {
    entry: row.entry,
    revision: row.revision,
    author: { userId: row.entry.authorId, displayName: row.displayName, handle: row.handle },
  }
}

const SUMMARY_MAX = 80

/** 연결 표시용 한 줄 요약. 막힘은 증상, 그 밖에는 본문(없으면 대표 필드). */
function summarize(tag: LogTag, body: string, payload: Record<string, unknown>): string {
  const pick = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : '')
  const fallback: Partial<Record<LogTag, string>> = {
    solution: pick('method'),
    decision: pick('choice'),
    validation: pick('target'),
  }
  const text = tag === 'stuck' ? pick('symptom') : body || fallback[tag] || ''
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
}

function toRef(log: LoadedLog): LogRefDto {
  return {
    id: log.entry.id,
    tag: log.entry.tag,
    summary: summarize(log.entry.tag, log.revision.body, log.revision.payload),
    author: log.author,
    createdAt: log.entry.createdAt.toISOString(),
  }
}

/**
 * 같은 프로젝트 안의 막힘↔해결 연결을 모아 DTO로 만듭니다.
 * 연결은 각 해결 로그의 "현재" revision 기준입니다(이전 revision의 연결은 이력에만 남음).
 */
async function toLogDtos(
  db: DbExecutor,
  actor: Actor,
  project: ProjectRow,
  membership: Membership,
  logs: LoadedLog[],
): Promise<LogDto[]> {
  const resolvesIds = [
    ...new Set(logs.map((log) => log.revision.resolvesEntryId).filter((id): id is string => !!id)),
  ]
  const stuckIds = logs.filter((log) => log.entry.tag === 'stuck').map((log) => log.entry.id)

  const milestoneIds = logs.map((log) => log.revision.milestoneId).filter((id): id is string => !!id)

  const taskSourced = logs.filter((log) => log.entry.source === 'task').map((log) => log.entry.id)

  const [targets, solutions, evidence, milestoneRefs, sourceTasks] = await Promise.all([
    resolvesIds.length > 0
      ? selectLogs(db).where(and(eq(logEntries.projectId, project.id), inArray(logEntries.id, resolvesIds)))
      : Promise.resolve([]),
    stuckIds.length > 0
      ? selectLogs(db)
          .where(and(eq(logEntries.projectId, project.id), inArray(logRevisions.resolvesEntryId, stuckIds)))
          .orderBy(asc(logEntries.createdAt), asc(logEntries.id))
      : Promise.resolve([]),
    evidenceByRevision(
      db,
      logs.map((log) => log.revision.id),
    ),
    milestoneRefsById(db, milestoneIds),
    taskSourced.length > 0
      ? db
          .select({ id: tasks.id, title: tasks.title, logEntryId: tasks.logEntryId })
          .from(tasks)
          .where(inArray(tasks.logEntryId, taskSourced))
      : Promise.resolve([]),
  ])
  const taskByLog = new Map<string, TaskRefDto>(
    sourceTasks.flatMap((row) => (row.logEntryId ? [[row.logEntryId, { id: row.id, title: row.title }] as const] : [])),
  )
  const targetById = new Map(targets.map((row) => [row.entry.id, toRef(toLoaded(row))]))
  const solutionsByStuck = new Map<string, LogRefDto[]>()
  for (const row of solutions) {
    const key = row.revision.resolvesEntryId
    if (!key) continue
    solutionsByStuck.set(key, [...(solutionsByStuck.get(key) ?? []), toRef(toLoaded(row))])
  }

  return logs.map((log) => ({
    id: log.entry.id,
    projectId: log.entry.projectId,
    tag: log.entry.tag,
    source: log.entry.source,
    author: log.author,
    revisionNo: log.revision.revisionNo,
    body: log.revision.body,
    payload: log.revision.payload as LogPayload,
    links: log.revision.links,
    claimedDate: log.revision.claimedDate,
    createdAt: log.entry.createdAt.toISOString(),
    recordedAt: log.revision.recordedAt.toISOString(),
    resolves: log.revision.resolvesEntryId ? (targetById.get(log.revision.resolvesEntryId) ?? null) : null,
    resolvedBy: solutionsByStuck.get(log.entry.id) ?? [],
    evidence: evidence.get(log.revision.id) ?? [],
    milestone: log.revision.milestoneId ? (milestoneRefs.get(log.revision.milestoneId) ?? null) : null,
    task: taskByLog.get(log.entry.id) ?? null,
    // TODO(T-11/T-12): 공개 로그 DTO도 isRetrospectiveLog로 이 표시를 그대로 옮기세요.
    retrospective: isRetrospectiveLog(log.entry),
    canRevise: canReviseLog({ userId: actor.userId }, project, membership, log.entry),
  }))
}

async function loadLogById(db: DbExecutor, logId: string): Promise<LoadedLog | null> {
  const [row] = await selectLogs(db).where(eq(logEntries.id, logId)).limit(1)
  return row ? toLoaded(row) : null
}

/**
 * 로그와 그 프로젝트 접근 컨텍스트를 읽습니다. 로그가 없거나 프로젝트를 읽을 수 없으면 똑같이 404.
 * `lock: true`면 log_entries 행을 FOR UPDATE로 잠가 동시 수정을 직렬화합니다(트랜잭션 안에서만).
 */
async function loadReadableLog(db: DbExecutor, actor: Actor, logId: unknown, options: { lock?: boolean } = {}) {
  if (!isUuid(logId)) throw notFound()
  const query = db.select().from(logEntries).where(eq(logEntries.id, logId)).limit(1)
  const [entry] = options.lock ? await query.for('update') : await query
  if (!entry) throw notFound()
  const context = await loadReadableProject(db, actor, entry.projectId)
  const log = await loadLogById(db, entry.id)
  // current_revision_id가 비어 있는 로그(작성 트랜잭션 도중)는 아직 없는 것으로 봅니다.
  if (!log) throw notFound()
  return { ...context, log }
}

async function getLogDto(db: DbExecutor, actor: Actor, project: ProjectRow, membership: Membership, logId: string) {
  const log = await loadLogById(db, logId)
  if (!log) throw notFound()
  const [dto] = await toLogDtos(db, actor, project, membership, [log])
  if (!dto) throw notFound()
  return dto
}

// ── 쓰기 공통 검사 ────────────────────────────────────────────────────────

/**
 * DB가 필요한 내용 검사: 해결 대상(같은 프로젝트의 막힘)과 회의 참석자(이 프로젝트 멤버였던 사용자),
 * 마일스톤(같은 프로젝트). 참석자는 지금은 나간 멤버도 허용합니다(회의 당시 멤버였을 수 있고, revision 때 거부되지 않도록).
 */
async function checkRelations(
  db: DbExecutor,
  projectId: string,
  tag: LogTag,
  content: LogContent,
  entryId?: string,
): Promise<void> {
  if (content.milestoneId) await checkLogMilestone(db, projectId, content.milestoneId)
  const fields: Record<string, string> = {}
  if (tag === 'solution' && content.resolvesEntryId) {
    const [target] = await db
      .select({ id: logEntries.id, projectId: logEntries.projectId, tag: logEntries.tag })
      .from(logEntries)
      .where(eq(logEntries.id, content.resolvesEntryId))
      .limit(1)
    const result = checkResolveTarget({ projectId, entryId }, target)
    if (result !== 'ok') fields.resolvesEntryId = result
  }
  if (tag === 'meeting') {
    const attendees = (content.payload as { attendees?: string[] }).attendees ?? []
    if (attendees.length > 0) {
      const rows = await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            inArray(projectMembers.userId, attendees),
            ne(projectMembers.status, 'invited'),
          ),
        )
      if (rows.length !== attendees.length) fields['payload.attendees'] = 'not_member'
    }
  }
  if (Object.keys(fields).length > 0) throw invalid(fields)
}

/** 검증된 내용을 log_revisions 열 값으로. payload는 태그별 타입이지만 열은 일반 JSON 객체입니다. */
function revisionValues(content: LogContent) {
  return { ...content, payload: content.payload as unknown as Record<string, unknown> }
}

// ── 작성 ─────────────────────────────────────────────────────────────────

export interface CreatedLog {
  log: LogDto
  /** false면 같은 clientId로 이미 만든 로그를 돌려준 것(재전송). handler는 200으로 응답합니다. */
  created: boolean
}

async function findByClientId(db: DbExecutor, projectId: string, authorId: string, clientId: string) {
  const [row] = await db
    .select({ id: logEntries.id })
    .from(logEntries)
    .where(and(eq(logEntries.projectId, projectId), eq(logEntries.authorId, authorId), eq(logEntries.clientId, clientId)))
    .limit(1)
  return row?.id ?? null
}

/** 검증을 마친 작성 요청. createLog와 할 일 전환(tasks.ts)이 함께 씁니다. */
export interface ParsedLogInput {
  tag: LogTag
  content: LogContent
  evidenceIds: string[]
  clientId: string | null
}

/** 작성 요청 검증(DB 없이 하는 부분: 태그별 payload·본문·링크·수행일). 실패하면 422. */
export function parseLogInput(rawInput: unknown, now: Date): ParsedLogInput {
  const input = parseInput(createLogSchema, rawInput)
  const checked = validateLogContent(
    input.tag,
    {
      body: input.body ?? '',
      payload: input.payload,
      links: input.links ?? [],
      claimedDate: input.claimedDate ?? null,
      resolvesEntryId: input.resolvesEntryId ?? null,
      milestoneId: input.milestoneId ?? null,
    },
    now,
  )
  if (!checked.content) throw invalid(checked.fields)
  return {
    tag: input.tag,
    content: checked.content,
    evidenceIds: input.evidenceVersionIds ?? [],
    clientId: input.clientId ?? null,
  }
}

/**
 * 로그와 첫 revision을 넣습니다(호출자의 트랜잭션 안에서). 권한(owner/editor)·관계·근거를 확인하고,
 * source·사후 작성 표시는 프로젝트의 지금 모드와 출처(origin)로 정합니다(logSourceFor).
 * clientId가 같은 재전송은 새로 만들지 않고 기존 로그를 돌려줍니다(내용이 달라도 처음 것을 유지).
 */
export async function insertLog(
  tx: DbExecutor,
  actor: Actor,
  project: ProjectRow,
  membership: Membership,
  parsed: ParsedLogInput,
  origin: LogOrigin,
  now: Date,
): Promise<CreatedLog> {
  if (!canWriteLog({ userId: actor.userId }, project, membership)) throw forbidden()
  const { tag, content, evidenceIds, clientId } = parsed

  const replay = async (): Promise<CreatedLog | null> => {
    if (!clientId) return null
    const existingId = await findByClientId(tx, project.id, actor.userId, clientId)
    return existingId ? { log: await getLogDto(tx, actor, project, membership, existingId), created: false } : null
  }
  const earlier = await replay()
  if (earlier) return earlier

  await checkRelations(tx, project.id, tag, content)
  await checkEvidence(tx, project.id, evidenceIds)

  // 동시에 같은 clientId가 들어오면 한쪽은 아무것도 넣지 않고 먼저 만든 로그를 돌려줍니다.
  const [entry] = await tx
    .insert(logEntries)
    .values({
      projectId: project.id,
      authorId: actor.userId,
      tag,
      ...logSourceFor(project.retroMode, origin),
      clientId,
      createdAt: now,
    })
    .onConflictDoNothing({ target: [logEntries.projectId, logEntries.authorId, logEntries.clientId] })
    .returning()
  if (!entry) {
    const raced = await replay()
    if (raced) return raced
    throw new Error('log insert failed')
  }
  const [revision] = await tx
    .insert(logRevisions)
    .values({ logEntryId: entry.id, revisionNo: 1, tag, ...revisionValues(content), recordedAt: now })
    .returning({ id: logRevisions.id })
  if (!revision) throw new Error('log revision insert failed')
  await insertEvidence(tx, revision.id, evidenceIds)
  await tx.update(logEntries).set({ currentRevisionId: revision.id }).where(eq(logEntries.id, entry.id))
  await recordAudit(tx, {
    actorId: actor.userId,
    action: 'log.create',
    targetType: 'log',
    targetId: entry.id,
    projectId: project.id,
    metadata: { tag },
  })
  return { log: await getLogDto(tx, actor, project, membership, entry.id), created: true }
}

/** 로그 작성(active owner/editor). 첫 revision을 같은 트랜잭션에서 만듭니다. */
export async function createLog(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<CreatedLog> {
  const parsed = parseLogInput(rawInput, now)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId)
    return insertLog(tx, actor, project, membership, parsed, 'web', now)
  })
}

// ── 수정(새 revision) ─────────────────────────────────────────────────────

/** 키 순서와 무관한 JSON 비교용 문자열(jsonb는 키 순서를 보존하지 않음). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

const contentKey = (c: LogContent) =>
  stableJson([c.body, c.payload, c.links, c.claimedDate, c.resolvesEntryId, c.milestoneId])

/**
 * 작성자 본인이 새 revision을 만듭니다. 생략한 필드는 이전 revision 값을 이어받고(payload는 전체를 다시 보냄),
 * 바뀐 것이 없으면 422 `{_: 'no_changes'}`. 이전 revision은 그대로 남습니다.
 */
export async function reviseLog(
  db: DbExecutor,
  actor: Actor,
  logId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<LogDto> {
  const input = parseInput(reviseLogSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership, log } = await loadReadableLog(tx, actor, logId, { lock: true })
    if (!canReviseLog({ userId: actor.userId }, project, membership, log.entry)) throw forbidden()
    const tag = log.entry.tag
    if (!isTagChangeAllowed(tag, input.tag)) throw invalid({ tag: 'immutable' })
    const current = log.revision
    if (current.revisionNo !== input.expectedRevision) {
      throw conflict('stale_revision', { currentRevision: current.revisionNo })
    }

    const previous: LogContent = {
      body: current.body,
      payload: current.payload as LogPayload,
      links: current.links as LogLinkDto[],
      claimedDate: current.claimedDate,
      resolvesEntryId: current.resolvesEntryId,
      milestoneId: current.milestoneId,
    }
    const checked = validateLogContent(
      tag,
      {
        body: input.body === undefined ? previous.body : (input.body ?? ''),
        payload: input.payload,
        links: input.links === undefined ? previous.links : (input.links ?? []),
        claimedDate: input.claimedDate === undefined ? previous.claimedDate : input.claimedDate,
        resolvesEntryId: input.resolvesEntryId === undefined ? previous.resolvesEntryId : input.resolvesEntryId,
        milestoneId: input.milestoneId === undefined ? previous.milestoneId : input.milestoneId,
      },
      now,
      previous.claimedDate,
    )
    if (!checked.content) throw invalid(checked.fields)
    const content = checked.content
    const previousEvidence = (await evidenceIdsByRevision(tx, [current.id])).get(current.id) ?? []
    const evidenceIds =
      input.evidenceVersionIds === undefined ? previousEvidence : (input.evidenceVersionIds ?? [])
    if (contentKey(content) === contentKey(previous) && stableJson(evidenceIds) === stableJson(previousEvidence)) {
      throw invalid({ _: 'no_changes' })
    }
    await checkRelations(tx, project.id, tag, content, log.entry.id)
    await checkEvidence(tx, project.id, evidenceIds, previousEvidence)

    const revisionNo = current.revisionNo + 1
    const [revision] = await tx
      .insert(logRevisions)
      .values({ logEntryId: log.entry.id, revisionNo, tag, ...revisionValues(content), recordedAt: now })
      .returning({ id: logRevisions.id })
    if (!revision) throw new Error('log revision insert failed')
    await insertEvidence(tx, revision.id, evidenceIds)
    await tx.update(logEntries).set({ currentRevisionId: revision.id }).where(eq(logEntries.id, log.entry.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'log.revise',
      targetType: 'log',
      targetId: log.entry.id,
      projectId: project.id,
      metadata: { tag, revisionNo },
    })
    return getLogDto(tx, actor, project, membership, log.entry.id)
  })
}

// ── 조회 ─────────────────────────────────────────────────────────────────

/** cursor = base64url(`<created_at ISO>|<id>`). 서버가 만든 값만 받습니다. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (rest.length > 0 || !createdAt || !isUuid(id)) return null
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime()) || date.toISOString() !== createdAt) return null
  return { createdAt, id }
}

/**
 * 프로젝트 타임라인(최신순). 정렬 키는 로그를 처음 만든 시각과 id이며(수정해도 순서가 바뀌지 않음),
 * created_at은 애플리케이션이 밀리초 단위로 넣어 cursor 왕복이 정확합니다.
 */
export async function listLogs(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawQuery: unknown,
): Promise<LogPageDto> {
  const query = parseInput(listLogsQuerySchema, rawQuery)
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  if (query.cursor && !cursor) throw invalid({ cursor: 'invalid' })
  const { project, membership } = await loadReadableProject(db, actor, projectId)

  const conditions = [eq(logEntries.projectId, project.id)]
  if (query.tag) conditions.push(eq(logEntries.tag, query.tag))
  if (query.author) conditions.push(eq(logEntries.authorId, query.author))
  if (query.milestone) conditions.push(eq(logRevisions.milestoneId, query.milestone.toLowerCase()))
  if (cursor) {
    conditions.push(
      sql`(${logEntries.createdAt}, ${logEntries.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
    )
  }
  const rows = await selectLogs(db)
    .where(and(...conditions))
    .orderBy(desc(logEntries.createdAt), desc(logEntries.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit).map(toLoaded)
  const last = page.at(-1)
  return {
    items: await toLogDtos(db, actor, project, membership, page),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last.entry.createdAt, last.entry.id) : null,
  }
}

export async function getLog(db: DbExecutor, actor: Actor, logId: unknown): Promise<LogDto> {
  const { project, membership, log } = await loadReadableLog(db, actor, logId)
  const [dto] = await toLogDtos(db, actor, project, membership, [log])
  if (!dto) throw notFound()
  return dto
}

/** 모든 revision(오래된 순). 정정 이력은 숨기지 않습니다. */
export async function listLogRevisions(db: DbExecutor, actor: Actor, logId: unknown): Promise<LogRevisionDto[]> {
  const { log } = await loadReadableLog(db, actor, logId)
  const rows = await db
    .select()
    .from(logRevisions)
    .where(eq(logRevisions.logEntryId, log.entry.id))
    .orderBy(asc(logRevisions.revisionNo))
  const evidence = await evidenceIdsByRevision(
    db,
    rows.map((row) => row.id),
  )
  return rows.map((row) => ({
    revisionNo: row.revisionNo,
    tag: row.tag,
    body: row.body,
    payload: row.payload as LogPayload,
    links: row.links,
    claimedDate: row.claimedDate,
    resolvesEntryId: row.resolvesEntryId,
    evidenceVersionIds: evidence.get(row.id) ?? [],
    milestoneId: row.milestoneId,
    recordedAt: row.recordedAt.toISOString(),
  }))
}
