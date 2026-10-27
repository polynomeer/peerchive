/**
 * 역할 선언·팀원 확인 (T-08, PROOFU_EVOLUTION_PLAN §7, SYSTEM_DESIGN §6.4, §7.3, §8, §9).
 *
 * - 선언(role_claims)은 식별자이고 내용은 revision(claim_revisions)에 쌓습니다. 수정은 항상 새 revision이며,
 *   확인(endorsements)은 revision에 붙으므로 새 revision은 `unconfirmed`로 시작합니다(이전 확인은 이력에 남음).
 * - 선언·확인은 active owner/editor/reviewer, viewer는 읽기만(쓰기 403). 읽을 수 없는 프로젝트·선언은 404(§8).
 * - 선언은 언제나 요청자 본인의 것으로 만들고, 수정은 작성자 본인만 합니다(owner도 403). 낡은 expectedRevision은
 *   409 `stale_revision` + currentRevision. 바뀐 것이 없으면 422 `{_: 'no_changes'}`.
 * - 근거(`evidence[]`, 최대 20개)는 같은 프로젝트의 빌드 로그(`{kind:'log', id}`) 또는 산출물 버전(`{kind:'artifact', id}`).
 *   로그는 저장할 때 그 로그의 현재 revision으로 고정합니다. 없거나 다른 프로젝트 것은 422 `{evidence: 'not_found'}`,
 *   격리·실패 파일은 422 `{evidence: 'not_attachable'}`(이전 revision에서 이어받은 파일은 다시 보지 않음). 검사 중은 허용.
 *   수정 때 evidence를 생략하면 이전 revision의 근거를 이어받고(로그는 지금 revision으로 다시 고정), `[]`는 비웁니다.
 * - 확인(PUT /claim-revisions/:id/endorsement)은 현재 revision에만: 이전 revision이면 409 `not_current` + currentRevisionId.
 *   자기 선언은 403 `self_endorsement`. 이의(disputed)에는 메모가 필요합니다(422 `{note: 'required'}`). 다시 보내면 바꿉니다.
 *   철회(DELETE)도 현재 revision에만 하며 남긴 것이 없어도 204입니다.
 * - 한도: 프로젝트·멤버당 선언 10개(409 `limit_reached` + limit).
 * - 동시성: 선언 만들기는 프로젝트 행, 수정·확인·철회는 선언 행을 잠가 직렬화합니다(확인과 새 revision이 엇갈리지 않음).
 * - 감사 이벤트에는 revision 번호·상태·근거 수만 남기고 선언·메모 본문은 넣지 않습니다(§6.6).
 */
import { z } from 'zod'
import {
  CLAIM_EVIDENCE_MAX,
  CLAIM_LIMIT_PER_MEMBER,
  CLAIM_TEXT_MAX,
  ENDORSEMENT_NOTE_MAX,
  type ClaimEvidenceTarget,
  type Endorsement,
  type Membership,
  canDeclareClaim,
  canEndorse,
  canReviseClaim,
  checkClaimEvidenceTarget,
  claimStatusSummary,
  endorseClaim,
  orderMembersByName,
  revisionStatus,
} from '@peerchive/domain'
import {
  and,
  artifactVersions,
  artifacts,
  asc,
  claimEvidence,
  claimRevisions,
  endorsements,
  eq,
  inArray,
  logEntries,
  logRevisions,
  profiles,
  projectMembers,
  roleClaims,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { contentUrlFor } from '../artifacts/artifacts'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound } from '../errors'
import { summarize } from '../logs/logs'
import { parseInput } from '../validation'
import { type ProjectRow, isUuid, loadPersonMask, loadReadableProject } from '../projects/access'
import type {
  ClaimDto,
  ClaimEvidenceDto,
  ClaimRevisionDto,
  EndorsementDto,
} from '../../../shared/types/api'

export type { ClaimDto, ClaimRevisionDto }

// ── 입력 ─────────────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const claimText = z
  .string({ error: requiredOr('invalid') })
  .trim()
  .min(1, { error: 'required' })
  .max(CLAIM_TEXT_MAX, { error: 'too_long' })

const evidenceItem = z.strictObject(
  {
    kind: z.enum(['log', 'artifact'], { error: requiredOr('invalid') }),
    id: z.uuid({ error: requiredOr('invalid') }).transform((id) => id.toLowerCase()),
  },
  { error: (issue) => (issue.code === 'unrecognized_keys' ? 'unknown_key' : 'invalid') },
)

/** 근거 목록. 같은 (kind, id)는 하나로 합치고 순서를 유지합니다. */
const evidenceSchema = z
  .array(evidenceItem, { error: 'invalid' })
  .max(CLAIM_EVIDENCE_MAX, { error: 'too_many' })
  .transform((items) => {
    const seen = new Set<string>()
    return items.filter((item) => {
      const key = `${item.kind}:${item.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })

export type ClaimEvidenceInput = z.output<typeof evidenceSchema>[number]

export const createClaimSchema = z.object({
  text: claimText,
  evidence: evidenceSchema.nullish().transform((items) => items ?? []),
})

/** 생략한 text·evidence는 이전 revision을 이어받습니다(evidence `[]`는 비움). */
export const reviseClaimSchema = z.object({
  expectedRevision: z
    .number({ error: requiredOr('invalid') })
    .int({ error: 'invalid' })
    .min(1, { error: 'invalid' }),
  text: claimText.optional(),
  evidence: evidenceSchema.nullish(),
})

export const endorsementSchema = z
  .object({
    status: z.enum(['confirmed', 'disputed'], { error: requiredOr('invalid') }),
    note: z
      .string({ error: 'invalid' })
      .trim()
      .max(ENDORSEMENT_NOTE_MAX, { error: 'too_long' })
      .nullish()
      .transform((value) => (value ? value : null)),
  })
  // 이의는 사실 기록이 되도록 무엇이 다른지 적게 합니다(톤 가이드는 화면에서 안내).
  .refine((input) => input.status !== 'disputed' || input.note !== null, { error: 'required', path: ['note'] })

// ── 근거 ─────────────────────────────────────────────────────────────────

/** claim_evidence에 넣을 행(position 제외). */
type EvidenceRow =
  | { logEntryId: string; logRevisionId: string; artifactVersionId: null }
  | { logEntryId: null; logRevisionId: null; artifactVersionId: string }

const evidenceKey = (row: EvidenceRow) =>
  row.artifactVersionId ? `a:${row.artifactVersionId}` : `l:${row.logEntryId}:${row.logRevisionId}`

/**
 * 근거 검사 후 저장할 행. 로그는 지금 revision으로 고정합니다. previousVersionIds(이전 revision의 파일)는 상태를 다시 보지 않습니다.
 */
async function resolveEvidence(
  db: DbExecutor,
  projectId: string,
  items: readonly ClaimEvidenceInput[],
  previousVersionIds: readonly string[] = [],
): Promise<EvidenceRow[]> {
  if (items.length === 0) return []
  const logIds = items.filter((item) => item.kind === 'log').map((item) => item.id)
  const versionIds = items.filter((item) => item.kind === 'artifact').map((item) => item.id)
  const [logs, versions] = await Promise.all([
    logIds.length > 0
      ? db
          .select({ id: logEntries.id, projectId: logEntries.projectId, currentRevisionId: logEntries.currentRevisionId })
          .from(logEntries)
          .where(inArray(logEntries.id, logIds))
      : Promise.resolve([]),
    versionIds.length > 0
      ? db
          .select({ id: artifactVersions.id, projectId: artifacts.projectId, scanStatus: artifactVersions.scanStatus })
          .from(artifactVersions)
          .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
          .where(inArray(artifactVersions.id, versionIds))
      : Promise.resolve([]),
  ])
  const logById = new Map(logs.map((row) => [row.id, row]))
  const versionById = new Map(versions.map((row) => [row.id, row]))

  return items.map((item): EvidenceRow => {
    if (item.kind === 'log') {
      const log = logById.get(item.id)
      // 작성 트랜잭션 도중(아직 revision 없음)인 로그는 없는 것으로 봅니다.
      const target: ClaimEvidenceTarget | null =
        log && log.currentRevisionId ? { kind: 'log', projectId: log.projectId } : null
      const check = checkClaimEvidenceTarget(projectId, target)
      if (check !== 'ok' || !log?.currentRevisionId) throw invalid({ evidence: check === 'ok' ? 'not_found' : check })
      return { logEntryId: log.id, logRevisionId: log.currentRevisionId, artifactVersionId: null }
    }
    const version = versionById.get(item.id)
    const target: ClaimEvidenceTarget | null = version
      ? { kind: 'artifact', projectId: version.projectId, scanStatus: version.scanStatus }
      : null
    const check = checkClaimEvidenceTarget(projectId, target, { inherited: previousVersionIds.includes(item.id) })
    if (check !== 'ok') throw invalid({ evidence: check })
    return { logEntryId: null, logRevisionId: null, artifactVersionId: item.id }
  })
}

async function insertEvidence(db: DbExecutor, claimRevisionId: string, rows: readonly EvidenceRow[]): Promise<void> {
  if (rows.length === 0) return
  await db.insert(claimEvidence).values(rows.map((row, position) => ({ claimRevisionId, position, ...row })))
}

/** revision별 저장된 근거 행(순서대로). */
async function evidenceRowsByRevision(db: DbExecutor, revisionIds: readonly string[]): Promise<Map<string, EvidenceRow[]>> {
  const result = new Map<string, EvidenceRow[]>()
  if (revisionIds.length === 0) return result
  const rows = await db
    .select()
    .from(claimEvidence)
    .where(inArray(claimEvidence.claimRevisionId, [...revisionIds]))
    .orderBy(asc(claimEvidence.claimRevisionId), asc(claimEvidence.position))
  for (const row of rows) {
    const item = (
      row.artifactVersionId
        ? { logEntryId: null, logRevisionId: null, artifactVersionId: row.artifactVersionId }
        : { logEntryId: row.logEntryId!, logRevisionId: row.logRevisionId!, artifactVersionId: null }
    ) satisfies EvidenceRow
    result.set(row.claimRevisionId, [...(result.get(row.claimRevisionId) ?? []), item])
  }
  return result
}

/** revision별 근거 DTO(순서대로). 로그는 고정한 revision의 요약을, 파일은 검사 상태를 함께 줍니다. */
async function evidenceByRevision(db: DbExecutor, revisionIds: readonly string[]): Promise<Map<string, ClaimEvidenceDto[]>> {
  const result = new Map<string, Array<{ position: number; dto: ClaimEvidenceDto }>>()
  if (revisionIds.length === 0) return new Map()
  const ids = [...revisionIds]
  const [logs, files] = await Promise.all([
    db
      .select({
        claimRevisionId: claimEvidence.claimRevisionId,
        position: claimEvidence.position,
        logId: logEntries.id,
        tag: logEntries.tag,
        authorId: logEntries.authorId,
        revisionNo: logRevisions.revisionNo,
        body: logRevisions.body,
        payload: logRevisions.payload,
        currentRevisionNo: sql<number>`(select r.revision_no from log_revisions r where r.id = ${logEntries.currentRevisionId})`,
        displayName: users.displayName,
        handle: profiles.handle,
      })
      .from(claimEvidence)
      .innerJoin(logEntries, eq(logEntries.id, claimEvidence.logEntryId))
      .innerJoin(logRevisions, eq(logRevisions.id, claimEvidence.logRevisionId))
      .innerJoin(users, eq(users.id, logEntries.authorId))
      .leftJoin(profiles, eq(profiles.userId, logEntries.authorId))
      .where(inArray(claimEvidence.claimRevisionId, ids)),
    db
      .select({
        claimRevisionId: claimEvidence.claimRevisionId,
        position: claimEvidence.position,
        version: artifactVersions,
        title: artifacts.title,
      })
      .from(claimEvidence)
      .innerJoin(artifactVersions, eq(artifactVersions.id, claimEvidence.artifactVersionId))
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(inArray(claimEvidence.claimRevisionId, ids)),
  ])
  const push = (revisionId: string, position: number, dto: ClaimEvidenceDto) =>
    result.set(revisionId, [...(result.get(revisionId) ?? []), { position, dto }])
  for (const row of logs) {
    push(row.claimRevisionId, row.position, {
      kind: 'log',
      logId: row.logId,
      tag: row.tag,
      summary: summarize(row.tag, row.body, row.payload),
      revisionNo: row.revisionNo,
      currentRevisionNo: Number(row.currentRevisionNo ?? row.revisionNo),
      author: { userId: row.authorId, displayName: row.displayName, handle: row.handle },
    })
  }
  for (const { claimRevisionId, position, version, title } of files) {
    push(claimRevisionId, position, {
      kind: 'artifact',
      versionId: version.id,
      artifactId: version.artifactId,
      title,
      fileName: version.fileName,
      versionNo: version.versionNo,
      scanStatus: version.scanStatus,
      contentUrl: version.scanStatus === 'clean' ? contentUrlFor(version.artifactId, version.id) : null,
    })
  }
  return new Map([...result].map(([id, list]) => [id, list.sort((a, b) => a.position - b.position).map((e) => e.dto)]))
}

// ── 확인 ─────────────────────────────────────────────────────────────────

interface LoadedEndorsement {
  revisionId: string
  endorserId: string
  dto: EndorsementDto
}

async function endorsementsByRevision(db: DbExecutor, revisionIds: readonly string[]): Promise<LoadedEndorsement[]> {
  if (revisionIds.length === 0) return []
  const rows = await db
    .select({ endorsement: endorsements, displayName: users.displayName, handle: profiles.handle })
    .from(endorsements)
    .innerJoin(users, eq(users.id, endorsements.endorserId))
    .leftJoin(profiles, eq(profiles.userId, endorsements.endorserId))
    .where(inArray(endorsements.claimRevisionId, [...revisionIds]))
    .orderBy(asc(endorsements.createdAt), asc(endorsements.id))
  return rows.map(({ endorsement: e, displayName, handle }) => ({
    revisionId: e.claimRevisionId,
    endorserId: e.endorserId,
    dto: {
      endorser: { userId: e.endorserId, displayName, handle },
      status: e.status,
      note: e.note,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    },
  }))
}

const toDomainEndorsement = (e: LoadedEndorsement): Endorsement => ({
  claimRevisionId: e.revisionId,
  endorserId: e.endorserId,
  status: e.dto.status,
})

// ── 선언 DTO ─────────────────────────────────────────────────────────────

type ClaimRow = typeof roleClaims.$inferSelect
type RevisionRow = typeof claimRevisions.$inferSelect

function selectClaims(db: DbExecutor) {
  return db
    .select({
      claim: roleClaims,
      revision: claimRevisions,
      displayName: users.displayName,
      handle: profiles.handle,
      memberStatus: projectMembers.status,
    })
    .from(roleClaims)
    .innerJoin(claimRevisions, eq(claimRevisions.id, roleClaims.currentRevisionId))
    .innerJoin(users, eq(users.id, roleClaims.userId))
    .leftJoin(profiles, eq(profiles.userId, roleClaims.userId))
    .leftJoin(
      projectMembers,
      and(eq(projectMembers.projectId, roleClaims.projectId), eq(projectMembers.userId, roleClaims.userId)),
    )
}

interface SelectedClaim {
  claim: ClaimRow
  revision: RevisionRow
  displayName: string
  handle: string | null
  memberStatus: Membership['status'] | null
}

async function toClaimDtos(
  db: DbExecutor,
  actor: Actor,
  project: ProjectRow,
  membership: Membership,
  rows: SelectedClaim[],
): Promise<ClaimDto[]> {
  const revisionIds = rows.map((row) => row.revision.id)
  const [evidence, loaded, mask] = await Promise.all([
    evidenceByRevision(db, revisionIds),
    endorsementsByRevision(db, revisionIds),
    // 익명 스터디 기록(C-08)은 다른 멤버 이름을 가립니다.
    loadPersonMask(db, project, actor.userId),
  ])
  const viewer = { userId: actor.userId }
  return rows.map(({ claim, revision, displayName, handle, memberStatus }) => {
    const domainClaim = {
      id: claim.id,
      projectId: claim.projectId,
      userId: claim.userId,
      revisions: [{ id: revision.id, revisionNo: revision.revisionNo }],
    }
    const own = loaded.filter((e) => e.revisionId === revision.id)
    const summary = claimStatusSummary(domainClaim, own.map(toDomainEndorsement))
    return {
      id: claim.id,
      projectId: claim.projectId,
      author: mask({ userId: claim.userId, displayName, handle }),
      authorActive: memberStatus === 'active',
      revisionId: revision.id,
      revisionNo: revision.revisionNo,
      // revision 번호는 1부터 빈틈없이 늘어납니다.
      revisionCount: revision.revisionNo,
      text: revision.text,
      createdAt: claim.createdAt.toISOString(),
      recordedAt: revision.recordedAt.toISOString(),
      evidence: (evidence.get(revision.id) ?? []).map((e) => (e.kind === 'log' ? { ...e, author: mask(e.author) } : e)),
      // 자기 확인은 저장되지 않지만, 혹시 있더라도 보여 주지 않습니다(판정도 무시함).
      endorsements: own.filter((e) => e.endorserId !== claim.userId).map((e) => ({ ...e.dto, endorser: mask(e.dto.endorser) })),
      ...summary,
      canRevise: canReviseClaim(viewer, project, membership, claim),
      canEndorse: canEndorse(viewer, project, membership, claim),
      myEndorsement: own.find((e) => e.endorserId === actor.userId)?.dto.status ?? null,
    }
  })
}

/**
 * 프로젝트의 선언 DTO(작성자 이름순, 같은 사람 안에서는 만든 순). 장부(ledger.ts)도 씁니다.
 * `userIds`를 주면 그 사람들의 선언만.
 */
export async function projectClaimDtos(
  db: DbExecutor,
  actor: Actor,
  project: ProjectRow,
  membership: Membership,
  userIds?: readonly string[],
): Promise<ClaimDto[]> {
  if (userIds && userIds.length === 0) return []
  const conditions = [eq(roleClaims.projectId, project.id)]
  if (userIds) conditions.push(inArray(roleClaims.userId, [...userIds]))
  const rows = await selectClaims(db)
    .where(and(...conditions))
    .orderBy(asc(roleClaims.createdAt), asc(roleClaims.id))
  const dtos = await toClaimDtos(db, actor, project, membership, rows)
  // 정렬은 안정적이므로 같은 작성자 안에서는 만든 순서가 유지됩니다.
  return orderMembersByName(dtos.map((dto) => ({ ...dto, displayName: dto.author.displayName, userId: dto.author.userId }))).map(
    ({ displayName: _name, userId: _id, ...dto }) => dto,
  )
}

async function getClaimDto(db: DbExecutor, actor: Actor, project: ProjectRow, membership: Membership, claimId: string) {
  const rows = await selectClaims(db).where(eq(roleClaims.id, claimId)).limit(1)
  const [dto] = await toClaimDtos(db, actor, project, membership, rows)
  if (!dto) throw notFound()
  return dto
}

/**
 * 선언과 그 프로젝트 접근 컨텍스트. 선언이 없거나(아직 revision이 없는 것 포함) 프로젝트를 읽을 수 없으면 똑같이 404.
 * `lock: true`면 선언 행을 FOR UPDATE로 잠그고 다시 읽습니다(트랜잭션 안에서만).
 */
async function loadReadableClaim(db: DbExecutor, actor: Actor, claimId: unknown, options: { lock?: boolean } = {}) {
  if (!isUuid(claimId)) throw notFound()
  const query = db.select().from(roleClaims).where(eq(roleClaims.id, claimId)).limit(1)
  const [claim] = options.lock ? await query.for('update') : await query
  if (!claim || !claim.currentRevisionId) throw notFound()
  const context = await loadReadableProject(db, actor, claim.projectId)
  return { ...context, claim: { ...claim, currentRevisionId: claim.currentRevisionId } }
}

// ── 조회 ─────────────────────────────────────────────────────────────────

/** 프로젝트의 모든 선언(현재 revision·근거·확인·상태). 멤버(읽기 전용 포함). */
export async function listClaims(db: DbExecutor, actor: Actor, projectId: unknown): Promise<ClaimDto[]> {
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  return projectClaimDtos(db, actor, project, membership)
}

/** 모든 revision(오래된 순)과 각 revision에 붙은 확인. 정정 이력은 숨기지 않습니다. */
export async function listClaimRevisions(db: DbExecutor, actor: Actor, claimId: unknown): Promise<ClaimRevisionDto[]> {
  const { claim } = await loadReadableClaim(db, actor, claimId)
  const rows = await db
    .select()
    .from(claimRevisions)
    .where(eq(claimRevisions.claimId, claim.id))
    .orderBy(asc(claimRevisions.revisionNo))
  const ids = rows.map((row) => row.id)
  const [evidence, loaded] = await Promise.all([evidenceByRevision(db, ids), endorsementsByRevision(db, ids)])
  return rows.map((row) => {
    const own = loaded.filter((e) => e.revisionId === row.id && e.endorserId !== claim.userId)
    return {
      id: row.id,
      revisionNo: row.revisionNo,
      text: row.text,
      recordedAt: row.recordedAt.toISOString(),
      evidence: evidence.get(row.id) ?? [],
      endorsements: own.map((e) => e.dto),
      status: revisionStatus(claim, row.id, own.map(toDomainEndorsement)),
      current: row.id === claim.currentRevisionId,
    }
  })
}

// ── 만들기·수정 ──────────────────────────────────────────────────────────

/** 자기 역할 선언(201). active owner/editor/reviewer. 멤버당 10개를 넘으면 409 limit_reached. */
export async function createClaim(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<ClaimDto> {
  const input = parseInput(createClaimSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    if (!canDeclareClaim({ userId: actor.userId }, project, membership)) throw forbidden()
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(roleClaims)
      .where(and(eq(roleClaims.projectId, project.id), eq(roleClaims.userId, actor.userId)))
    if ((count?.n ?? 0) >= CLAIM_LIMIT_PER_MEMBER) throw conflict('limit_reached', { limit: CLAIM_LIMIT_PER_MEMBER })
    const evidence = await resolveEvidence(tx, project.id, input.evidence)

    const [claim] = await tx
      .insert(roleClaims)
      .values({ projectId: project.id, userId: actor.userId, createdAt: now })
      .returning({ id: roleClaims.id })
    if (!claim) throw new Error('claim insert failed')
    const [revision] = await tx
      .insert(claimRevisions)
      .values({ claimId: claim.id, revisionNo: 1, text: input.text, recordedAt: now })
      .returning({ id: claimRevisions.id })
    if (!revision) throw new Error('claim revision insert failed')
    await insertEvidence(tx, revision.id, evidence)
    await tx.update(roleClaims).set({ currentRevisionId: revision.id }).where(eq(roleClaims.id, claim.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'claim.create',
      targetType: 'claim',
      targetId: claim.id,
      projectId: project.id,
      metadata: { revisionNo: 1, evidenceCount: evidence.length },
    })
    if (evidence.length > 0) await emitClaimEvidence(tx, actor, project.id, evidence)
    return getClaimDto(tx, actor, project, membership, claim.id)
  })
}

/**
 * 작성자 본인이 새 revision을 만듭니다(201). 이전 revision의 확인은 그 revision에 남고 현재 선언은 미확인으로 시작합니다.
 */
export async function reviseClaim(
  db: DbExecutor,
  actor: Actor,
  claimId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<ClaimDto> {
  const input = parseInput(reviseClaimSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership, claim } = await loadReadableClaim(tx, actor, claimId, { lock: true })
    if (!canReviseClaim({ userId: actor.userId }, project, membership, claim)) throw forbidden()
    const [current] = await tx.select().from(claimRevisions).where(eq(claimRevisions.id, claim.currentRevisionId)).limit(1)
    if (!current) throw notFound()
    if (current.revisionNo !== input.expectedRevision) {
      throw conflict('stale_revision', { currentRevision: current.revisionNo })
    }

    const previousRows = (await evidenceRowsByRevision(tx, [current.id])).get(current.id) ?? []
    const requested: ClaimEvidenceInput[] =
      input.evidence === undefined
        ? previousRows.map((row) =>
            row.artifactVersionId ? { kind: 'artifact', id: row.artifactVersionId } : { kind: 'log', id: row.logEntryId! },
          )
        : (input.evidence ?? [])
    const previousVersionIds = previousRows.flatMap((row) => (row.artifactVersionId ? [row.artifactVersionId] : []))
    const evidence = await resolveEvidence(tx, project.id, requested, previousVersionIds)
    const text = input.text ?? current.text
    const sameEvidence =
      evidence.length === previousRows.length && evidence.every((row, i) => evidenceKey(row) === evidenceKey(previousRows[i]!))
    if (text === current.text && sameEvidence) throw invalid({ _: 'no_changes' })

    const revisionNo = current.revisionNo + 1
    const [revision] = await tx
      .insert(claimRevisions)
      .values({ claimId: claim.id, revisionNo, text, recordedAt: now })
      .returning({ id: claimRevisions.id })
    if (!revision) throw new Error('claim revision insert failed')
    await insertEvidence(tx, revision.id, evidence)
    await tx.update(roleClaims).set({ currentRevisionId: revision.id }).where(eq(roleClaims.id, claim.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'claim.revise',
      targetType: 'claim',
      targetId: claim.id,
      projectId: project.id,
      metadata: { revisionNo, evidenceCount: evidence.length },
    })
    if (!sameEvidence && evidence.length > 0) await emitClaimEvidence(tx, actor, project.id, evidence)
    return getClaimDto(tx, actor, project, membership, claim.id)
  })
}

/** 선언 근거 이벤트(종류별 개수만). */
async function emitClaimEvidence(tx: DbExecutor, actor: Actor, projectId: string, evidence: ReadonlyArray<{ artifactVersionId?: string | null }>) {
  const files = evidence.filter((e) => e.artifactVersionId).length
  await emitAnalytics(tx, { name: 'evidence_attached', actorId: actor.userId, projectId, props: { target: 'claim', files, logs: evidence.length - files } })
}

// ── 확인·철회 ────────────────────────────────────────────────────────────

/**
 * 확인 대상 revision → 선언(잠금) → 권한 판정. 현재 revision이 아니면 409 not_current, 자기 선언은 403 self_endorsement,
 * viewer는 403. domain의 endorseClaim이 최종 판정합니다.
 */
async function loadEndorsable(
  tx: DbExecutor,
  actor: Actor,
  claimRevisionId: unknown,
  status: 'confirmed' | 'disputed',
) {
  if (!isUuid(claimRevisionId)) throw notFound()
  const [target] = await tx
    .select({ id: claimRevisions.id, claimId: claimRevisions.claimId, revisionNo: claimRevisions.revisionNo })
    .from(claimRevisions)
    .where(eq(claimRevisions.id, claimRevisionId))
    .limit(1)
  if (!target) throw notFound()
  const context = await loadReadableClaim(tx, actor, target.claimId, { lock: true })
  const { claim, membership } = context
  const result = endorseClaim({
    claim: { id: claim.id, projectId: claim.projectId, userId: claim.userId, revisions: [{ id: claim.currentRevisionId, revisionNo: 0 }] },
    claimRevisionId: target.id,
    endorserId: actor.userId,
    endorserMembership: membership,
    status,
  })
  if (!result.ok) {
    switch (result.error.code) {
      case 'SELF_ENDORSEMENT':
        throw forbidden('self_endorsement')
      case 'READ_ONLY_ROLE':
        throw forbidden()
      case 'NOT_PROJECT_MEMBER':
        throw notFound()
      case 'REVISION_NOT_CURRENT':
        throw new ServiceError('CONFLICT', 'not_current', undefined, { currentRevisionId: claim.currentRevisionId })
    }
  }
  return { ...context, target }
}

/** 확인·이의를 남기거나 바꿉니다(200, 갱신한 선언). 현재 revision에만. */
export async function setEndorsement(
  db: DbExecutor,
  actor: Actor,
  claimRevisionId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<ClaimDto> {
  const input = parseInput(endorsementSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership, claim, target } = await loadEndorsable(tx, actor, claimRevisionId, input.status)
    await tx
      .insert(endorsements)
      .values({ claimRevisionId: target.id, endorserId: actor.userId, status: input.status, note: input.note, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [endorsements.claimRevisionId, endorsements.endorserId],
        set: { status: input.status, note: input.note, updatedAt: now },
      })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'endorsement.set',
      targetType: 'claim',
      targetId: claim.id,
      projectId: project.id,
      metadata: { revisionNo: target.revisionNo, status: input.status, hasNote: input.note !== null },
    })
    await emitAnalytics(tx, { name: 'claim_endorsed', actorId: actor.userId, projectId: project.id, props: { status: input.status } })
    return getClaimDto(tx, actor, project, membership, claim.id)
  })
}

/** 내 확인·이의를 철회합니다(204). 현재 revision에만, 남긴 것이 없어도 204. */
export async function withdrawEndorsement(db: DbExecutor, actor: Actor, claimRevisionId: unknown): Promise<void> {
  await db.transaction(async (tx) => {
    // 권한 판정은 상태와 무관하므로 confirmed로 묻습니다.
    const { project, claim, target } = await loadEndorsable(tx, actor, claimRevisionId, 'confirmed')
    const removed = await tx
      .delete(endorsements)
      .where(and(eq(endorsements.claimRevisionId, target.id), eq(endorsements.endorserId, actor.userId)))
      .returning({ status: endorsements.status })
    if (removed.length === 0) return
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'endorsement.withdraw',
      targetType: 'claim',
      targetId: claim.id,
      projectId: project.id,
      metadata: { revisionNo: target.revisionNo, status: removed[0]!.status },
    })
  })
}
