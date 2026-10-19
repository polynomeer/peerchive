/**
 * 산출물 업로드·조회·내용 열람 (T-05, SYSTEM_DESIGN §6.3, §9, §10, ADR 0007).
 *
 * 흐름(서명 URL 업로드로 바꿔도 API 모양이 같도록 3단계로 나눕니다)
 * 1. POST /projects/:id/artifacts/upload-intents — 권한·형식·크기·사용자 한도를 확인하고 15분짜리 의도와 격리 키를 만듭니다.
 * 2. PUT /uploads/:intentId — 의도를 만든 사용자가 본문을 보내면 격리 키에 스트림으로 저장하며 SHA-256과 크기를 셉니다.
 *    선언한 크기를 넘으면 413, 모자라면 422 `size_mismatch`이며 받던 내용은 지웁니다.
 * 3. POST /uploads/:intentId/complete — 산출물(새로 만들거나 기존 것)에 버전을 pending으로 만들고 검사 작업을 outbox에 남깁니다.
 *    같은 의도를 다시 완료하면 같은 버전을 돌려주고, 같은 산출물에 같은 내용(sha256)이 이미 있으면 그 버전을 돌려줍니다.
 *
 * 규칙
 * - 업로드는 active owner/editor(canUploadArtifact). 읽을 수 없는 프로젝트·산출물·의도는 404(§8).
 * - 내용은 clean 버전만, 같은 프로젝트 active 멤버에게만 내려줍니다. 그 밖에는 상태와 무관하게 404입니다.
 * - 저장 키는 서버가 만든 무작위 UUID이며 응답에 싣지 않습니다. 파일 이름은 표시용으로만 저장합니다.
 * - 사용자 한도: 그 사용자가 올린 모든 버전의 크기 합 + 아직 완료하지 않은 유효한 의도의 선언 크기(예약)가 500MB를 넘으면 422.
 */
import {
  MAX_FILE_BYTES,
  USER_QUOTA_BYTES,
  canReadArtifactContent,
  canUploadArtifact,
  extensionMatches,
  isAllowedMediaType,
  nextScanStatus,
  type Membership,
} from '@peerchive/domain'
import {
  and,
  artifactVersions,
  artifacts,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  profiles,
  sql,
  uploadIntents,
  users,
  type DbExecutor,
} from '@peerchive/db'
import {
  type ObjectStorage,
  ObjectNotFoundError,
  ObjectTooLargeError,
  SNIFF_BYTES,
  enqueueArtifactScan,
  isObjectKey,
  newQuarantineKey,
  readAll,
  sanitizeFileName,
  sniff,
} from '@peerchive/files'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, gone, invalid, notFound, tooLarge } from '../errors'
import { parseInput } from '../validation'
import { type ProjectRow, findMembership, isUuid, loadReadableProject } from '../projects/access'
import type {
  ArtifactDto,
  ArtifactVersionDto,
  LogAuthorDto,
  UploadCompleteDto,
  UploadIntentDto,
} from '../../../shared/types/api'

export const INTENT_TTL_MS = 15 * 60 * 1000

type ArtifactRow = typeof artifacts.$inferSelect
type VersionRow = typeof artifactVersions.$inferSelect
type IntentRow = typeof uploadIntents.$inferSelect

// ── DTO ──────────────────────────────────────────────────────────────────

export const contentUrlFor = (artifactId: string, versionId: string) =>
  `/api/v1/artifacts/${artifactId}/versions/${versionId}/content`

function toVersionDto(row: VersionRow, uploader: LogAuthorDto): ArtifactVersionDto {
  return {
    id: row.id,
    artifactId: row.artifactId,
    versionNo: row.versionNo,
    fileName: row.fileName,
    declaredType: row.declaredType,
    mediaType: row.mediaType,
    bytes: row.bytes,
    scanStatus: row.scanStatus,
    scanReason: row.scanReason,
    scannedAt: row.scannedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    uploader,
    contentUrl: row.scanStatus === 'clean' ? contentUrlFor(row.artifactId, row.id) : null,
  }
}

/** 산출물들과 그 모든 버전(최신순)을 DTO로. */
async function toArtifactDtos(
  db: DbExecutor,
  actor: Actor,
  project: ProjectRow,
  membership: Membership,
  rows: ArtifactRow[],
): Promise<ArtifactDto[]> {
  if (rows.length === 0) return []
  const versions = await db
    .select({ version: artifactVersions, displayName: users.displayName, handle: profiles.handle })
    .from(artifactVersions)
    .innerJoin(users, eq(users.id, artifactVersions.uploaderId))
    .leftJoin(profiles, eq(profiles.userId, artifactVersions.uploaderId))
    .where(inArray(artifactVersions.artifactId, rows.map((row) => row.id)))
    .orderBy(desc(artifactVersions.versionNo))
  const byArtifact = new Map<string, ArtifactVersionDto[]>()
  for (const { version, displayName, handle } of versions) {
    const dto = toVersionDto(version, { userId: version.uploaderId, displayName, handle })
    byArtifact.set(version.artifactId, [...(byArtifact.get(version.artifactId) ?? []), dto])
  }
  const canUpload = canUploadArtifact({ userId: actor.userId }, project, membership)
  return rows.map((row) => {
    const list = byArtifact.get(row.id) ?? []
    return {
      id: row.id,
      projectId: row.projectId,
      kind: row.kind,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      latestVersion: list[0] ?? null,
      versions: list,
      canUpload,
    }
  })
}

function toIntentDto(row: IntentRow): UploadIntentDto {
  return {
    intentId: row.id,
    uploadUrl: `/api/v1/uploads/${row.id}`,
    completeUrl: `/api/v1/uploads/${row.id}/complete`,
    byteSize: row.byteSize,
    expiresAt: row.expiresAt.toISOString(),
    uploaded: row.uploadedAt !== null,
    completed: row.completedAt !== null,
  }
}

// ── 읽기 도우미 ───────────────────────────────────────────────────────────

/** 산출물과 프로젝트 접근 컨텍스트. 없거나 읽을 수 없으면 똑같이 404. */
async function loadReadableArtifact(db: DbExecutor, actor: Actor, artifactId: unknown, options: { lock?: boolean } = {}) {
  if (!isUuid(artifactId)) throw notFound()
  const query = db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  const [artifact] = options.lock ? await query.for('update') : await query
  if (!artifact) throw notFound()
  const context = await loadReadableProject(db, actor, artifact.projectId)
  return { ...context, artifact }
}

/** 업로드 의도. 없거나 다른 사용자의 것이면 404(다른 사람의 의도가 있는지 드러내지 않음). */
async function loadOwnIntent(db: DbExecutor, actor: Actor, intentId: unknown, options: { lock?: boolean } = {}) {
  if (!isUuid(intentId)) throw notFound()
  const query = db.select().from(uploadIntents).where(eq(uploadIntents.id, intentId)).limit(1)
  const [intent] = options.lock ? await query.for('update') : await query
  if (!intent || intent.userId !== actor.userId) throw notFound()
  return intent
}

/** 지금도 업로드할 수 있는지(의도를 만든 뒤 멤버에서 빠졌을 수 있음). 읽을 수 없으면 404, 역할이 낮으면 403. */
async function assertCanUpload(db: DbExecutor, actor: Actor, projectId: unknown) {
  const context = await loadReadableProject(db, actor, projectId)
  if (!canUploadArtifact({ userId: actor.userId }, context.project, context.membership)) throw forbidden()
  return context
}

/** 사용자 저장 사용량: 올린 버전의 크기 합 + 완료하지 않은 유효한 의도의 예약 크기. */
export async function quotaUsage(db: DbExecutor, userId: string, now: Date): Promise<number> {
  const [used] = await db
    .select({ total: sql<string>`coalesce(sum(${artifactVersions.bytes}), 0)` })
    .from(artifactVersions)
    .where(eq(artifactVersions.uploaderId, userId))
  const [reserved] = await db
    .select({ total: sql<string>`coalesce(sum(${uploadIntents.byteSize}), 0)` })
    .from(uploadIntents)
    .where(and(eq(uploadIntents.userId, userId), isNull(uploadIntents.completedAt), gt(uploadIntents.expiresAt, now)))
  return Number(used?.total ?? 0) + Number(reserved?.total ?? 0)
}

// ── 1. 업로드 의도 ────────────────────────────────────────────────────────

const intentSchema = z.object({
  fileName: z
    .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
    .max(1000, { error: 'too_long' }),
  declaredType: z.string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }),
  byteSize: z
    .number({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
    .int({ error: 'invalid' })
    .min(1, { error: 'empty' }),
  clientId: z.uuid({ error: 'invalid' }).optional(),
  artifactId: z.uuid({ error: 'invalid' }).optional(),
})

export interface CreatedIntent {
  intent: UploadIntentDto
  /** false면 같은 clientId로 이미 만든 의도를 돌려준 것. */
  created: boolean
}

export async function createUploadIntent(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<CreatedIntent> {
  const input = parseInput(intentSchema, rawInput)
  const fields: Record<string, string> = {}
  const fileName = sanitizeFileName(input.fileName)
  if (!fileName) fields.fileName = 'required'
  if (!isAllowedMediaType(input.declaredType)) fields.declaredType = 'unsupported_type'
  else if (fileName && !extensionMatches(input.declaredType, fileName)) fields.fileName = 'extension_mismatch'
  if (input.byteSize > MAX_FILE_BYTES) fields.byteSize = 'too_large'

  return db.transaction(async (tx) => {
    const { project } = await assertCanUpload(tx, actor, projectId)

    if (input.clientId) {
      const [existing] = await tx
        .select()
        .from(uploadIntents)
        .where(
          and(
            eq(uploadIntents.projectId, project.id),
            eq(uploadIntents.userId, actor.userId),
            eq(uploadIntents.clientId, input.clientId),
          ),
        )
        .limit(1)
      if (existing) return { intent: toIntentDto(existing), created: false }
    }
    if (Object.keys(fields).length > 0) throw invalid(fields)

    if (input.artifactId) {
      const [target] = await tx
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(and(eq(artifacts.id, input.artifactId), eq(artifacts.projectId, project.id), eq(artifacts.kind, 'file')))
        .limit(1)
      if (!target) throw invalid({ artifactId: 'not_found' })
    }

    // 같은 사용자의 한도 계산을 직렬화합니다(동시에 여러 의도를 만들어 한도를 넘기지 못하게).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`upload-quota:${actor.userId}`}))`)
    if ((await quotaUsage(tx, actor.userId, now)) + input.byteSize > USER_QUOTA_BYTES) {
      throw invalid({ byteSize: 'quota_exceeded' })
    }

    const [intent] = await tx
      .insert(uploadIntents)
      .values({
        projectId: project.id,
        userId: actor.userId,
        artifactId: input.artifactId ?? null,
        fileName: fileName!,
        declaredType: input.declaredType,
        byteSize: input.byteSize,
        clientId: input.clientId ?? null,
        quarantineKey: newQuarantineKey(),
        expiresAt: new Date(now.getTime() + INTENT_TTL_MS),
        createdAt: now,
      })
      .onConflictDoNothing({ target: [uploadIntents.projectId, uploadIntents.userId, uploadIntents.clientId] })
      .returning()
    if (!intent) {
      // 같은 clientId가 동시에 들어온 경우: 먼저 만든 의도를 돌려줍니다.
      const [raced] = await tx
        .select()
        .from(uploadIntents)
        .where(
          and(
            eq(uploadIntents.projectId, project.id),
            eq(uploadIntents.userId, actor.userId),
            eq(uploadIntents.clientId, input.clientId!),
          ),
        )
        .limit(1)
      if (!raced) throw new Error('upload intent insert failed')
      return { intent: toIntentDto(raced), created: false }
    }
    return { intent: toIntentDto(intent), created: true }
  })
}

// ── 2. 내용 받기 ──────────────────────────────────────────────────────────

/**
 * 본문을 격리 키에 스트림으로 저장합니다. 트랜잭션 밖에서 받고, 다 받은 뒤 의도에 해시·완료 시각을 기록합니다.
 * contentLength(요청 헤더)가 있으면 받기 전에 선언 크기와 비교합니다.
 */
export async function receiveUpload(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  intentId: unknown,
  body: Readable | AsyncIterable<Uint8Array>,
  options: { contentLength?: number | null } = {},
  now = new Date(),
): Promise<UploadIntentDto> {
  const intent = await loadOwnIntent(db, actor, intentId)
  if (intent.completedAt || intent.uploadedAt) throw conflict('already_uploaded')
  if (intent.expiresAt <= now) throw gone('intent_expired')
  await assertCanUpload(db, actor, intent.projectId)
  if (!isObjectKey(intent.quarantineKey)) throw new Error('invalid quarantine key')

  const length = options.contentLength
  if (length != null && Number.isFinite(length)) {
    if (length > intent.byteSize) throw tooLarge()
    if (length !== intent.byteSize) throw invalid({ byteSize: 'size_mismatch' })
  }

  let result
  try {
    result = await storage.put(intent.quarantineKey, body, { maxBytes: intent.byteSize })
  } catch (error) {
    if (error instanceof ObjectTooLargeError) throw tooLarge()
    // 같은 의도에 동시에 두 번 보낸 경우 한쪽은 키가 이미 있어 실패합니다.
    if ((await storage.head(intent.quarantineKey)) !== null) throw conflict('already_uploaded')
    throw error
  }
  if (result.bytes !== intent.byteSize) {
    await storage.delete(intent.quarantineKey)
    throw invalid({ byteSize: 'size_mismatch' })
  }

  const [updated] = await db
    .update(uploadIntents)
    .set({ sha256: result.sha256, uploadedAt: now })
    .where(and(eq(uploadIntents.id, intent.id), isNull(uploadIntents.uploadedAt)))
    .returning()
  if (!updated) throw conflict('already_uploaded')
  return toIntentDto(updated)
}

// ── 3. 완료 ───────────────────────────────────────────────────────────────

export interface CompletedUpload extends UploadCompleteDto {
  /** false면 이미 완료했거나 같은 내용의 버전이 있어 기존 버전을 돌려준 것(200). */
  created: boolean
}

async function completedResult(
  db: DbExecutor,
  actor: Actor,
  project: ProjectRow,
  membership: Membership,
  artifactId: string,
  versionId: string,
  created: boolean,
): Promise<CompletedUpload> {
  const [artifactRow] = await db.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
  if (!artifactRow) throw notFound()
  const [artifact] = await toArtifactDtos(db, actor, project, membership, [artifactRow])
  const version = artifact?.versions.find((v) => v.id === versionId)
  if (!artifact || !version) throw notFound()
  return { artifact, version, created }
}

/** 앞부분 signature로 형식을 판별합니다. 허용 형식이 아니면 null(최종 판정은 검사 작업이 함). */
async function detectMediaType(storage: ObjectStorage, key: string): Promise<string | null> {
  if (!isObjectKey(key)) return null
  const head = await readAll(await storage.get(key, { start: 0, end: SNIFF_BYTES - 1 }))
  const kind = sniff(head)
  return isAllowedMediaType(kind) ? kind : null
}

export async function completeUpload(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  intentId: unknown,
  now = new Date(),
): Promise<CompletedUpload> {
  let discardKey: string | null = null
  const result = await db.transaction(async (tx) => {
    const intent = await loadOwnIntent(tx, actor, intentId, { lock: true })
    const { project, membership } = await loadReadableProject(tx, actor, intent.projectId)
    if (intent.completedAt && intent.artifactVersionId) {
      const [done] = await tx
        .select({ artifactId: artifactVersions.artifactId })
        .from(artifactVersions)
        .where(eq(artifactVersions.id, intent.artifactVersionId))
      if (!done) throw notFound()
      return completedResult(tx, actor, project, membership, done.artifactId, intent.artifactVersionId, false)
    }
    if (intent.expiresAt <= now) throw gone('intent_expired')
    if (!intent.uploadedAt || !intent.sha256) throw conflict('not_uploaded')
    if (!canUploadArtifact({ userId: actor.userId }, project, membership)) throw forbidden()

    let artifact: ArtifactRow
    let versionNo = 1
    if (intent.artifactId) {
      const [target] = await tx
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, intent.artifactId), eq(artifacts.projectId, project.id)))
        .for('update')
      if (!target) throw invalid({ artifactId: 'not_found' })
      artifact = target
      const [same] = await tx
        .select({ id: artifactVersions.id })
        .from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, artifact.id), eq(artifactVersions.sha256, intent.sha256)))
      if (same) {
        // 같은 내용이 이미 있으면 새 버전을 만들지 않고, 받은 내용은 지웁니다(커밋 뒤).
        await tx
          .update(uploadIntents)
          .set({ completedAt: now, artifactVersionId: same.id })
          .where(eq(uploadIntents.id, intent.id))
        discardKey = intent.quarantineKey
        return completedResult(tx, actor, project, membership, artifact.id, same.id, false)
      }
      const [max] = await tx
        .select({ value: sql<number>`coalesce(max(${artifactVersions.versionNo}), 0)::int` })
        .from(artifactVersions)
        .where(eq(artifactVersions.artifactId, artifact.id))
      versionNo = (max?.value ?? 0) + 1
      await tx.update(artifacts).set({ updatedAt: now }).where(eq(artifacts.id, artifact.id))
    } else {
      const [created] = await tx
        .insert(artifacts)
        .values({ projectId: project.id, uploaderId: actor.userId, kind: 'file', title: intent.fileName, createdAt: now, updatedAt: now })
        .returning()
      if (!created) throw new Error('artifact insert failed')
      artifact = created
    }

    const [version] = await tx
      .insert(artifactVersions)
      .values({
        artifactId: artifact.id,
        versionNo,
        uploaderId: actor.userId,
        fileName: intent.fileName,
        declaredType: intent.declaredType,
        mediaType: await detectMediaType(storage, intent.quarantineKey),
        bytes: intent.byteSize,
        sha256: intent.sha256,
        objectKey: intent.quarantineKey,
        scanStatus: 'pending',
        createdAt: now,
      })
      .returning({ id: artifactVersions.id })
    if (!version) throw new Error('artifact version insert failed')
    await enqueueArtifactScan(tx, version.id)
    await tx
      .update(uploadIntents)
      .set({ completedAt: now, artifactVersionId: version.id })
      .where(eq(uploadIntents.id, intent.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'artifact.upload',
      targetType: 'artifact',
      targetId: artifact.id,
      projectId: project.id,
      metadata: { versionNo, declaredType: intent.declaredType, bytes: intent.byteSize },
    })
    return completedResult(tx, actor, project, membership, artifact.id, version.id, true)
  })
  if (discardKey && isObjectKey(discardKey)) await storage.delete(discardKey).catch(() => {})
  return result
}

// ── 조회 ─────────────────────────────────────────────────────────────────

/** 프로젝트의 산출물(최근 순, 최대 200개). 멤버(읽기 전용 포함)는 상태를 볼 수 있습니다. */
export async function listArtifacts(db: DbExecutor, actor: Actor, projectId: unknown): Promise<ArtifactDto[]> {
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  const rows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.projectId, project.id))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.id))
    .limit(200)
  return toArtifactDtos(db, actor, project, membership, rows)
}

export async function getArtifact(db: DbExecutor, actor: Actor, artifactId: unknown): Promise<ArtifactDto> {
  const { project, membership, artifact } = await loadReadableArtifact(db, actor, artifactId)
  const [dto] = await toArtifactDtos(db, actor, project, membership, [artifact])
  if (!dto) throw notFound()
  return dto
}

export interface ArtifactContent {
  stream: Readable
  mediaType: string
  bytes: number
  fileName: string
}

/**
 * clean 버전의 내용. 산출물·버전이 없거나, 같은 프로젝트의 active 멤버가 아니거나, clean이 아니면 모두 404입니다
 * (검사 전·격리 상태를 비멤버에게 드러내지 않고, 멤버에게도 내용은 주지 않음).
 */
export async function openArtifactContent(
  db: DbExecutor,
  storage: ObjectStorage,
  actor: Actor,
  artifactId: unknown,
  versionId: unknown,
): Promise<ArtifactContent> {
  if (!isUuid(artifactId) || !isUuid(versionId)) throw notFound()
  const [row] = await db
    .select({ version: artifactVersions, projectId: artifacts.projectId })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(and(eq(artifactVersions.id, versionId), eq(artifacts.id, artifactId)))
    .limit(1)
  if (!row) throw notFound()
  const membership = await findMembership(db, row.projectId, actor.userId)
  const { version } = row
  if (!canReadArtifactContent({ userId: actor.userId }, { id: row.projectId }, membership, version.scanStatus)) {
    throw notFound()
  }
  // clean인데 판별 형식이 없거나 키가 격리 영역이면 내려주지 않습니다(방어).
  if (!version.mediaType || !isAllowedMediaType(version.mediaType) || !version.objectKey.startsWith('clean/')) throw notFound()
  if (!isObjectKey(version.objectKey)) throw notFound()
  let stream: Readable
  try {
    stream = await storage.get(version.objectKey)
  } catch (error) {
    // DB는 clean인데 내용이 없으면(저장소 손상) 없는 것과 같이 404로 답합니다.
    if (error instanceof ObjectNotFoundError) throw notFound()
    throw error
  }
  return {
    stream,
    mediaType: version.mediaType,
    bytes: version.bytes,
    fileName: version.fileName,
  }
}

// ── 검사 다시 시도 ────────────────────────────────────────────────────────

/** 검사에 실패한(failed) 버전을 다시 검사 대기(pending)로 돌리고 작업을 남깁니다. owner/editor. */
export async function retryArtifactScan(
  db: DbExecutor,
  actor: Actor,
  artifactId: unknown,
  versionId: unknown,
): Promise<ArtifactDto> {
  return db.transaction(async (tx) => {
    const { project, membership, artifact } = await loadReadableArtifact(tx, actor, artifactId)
    if (!canUploadArtifact({ userId: actor.userId }, project, membership)) throw forbidden()
    if (!isUuid(versionId)) throw notFound()
    const [version] = await tx
      .select()
      .from(artifactVersions)
      .where(and(eq(artifactVersions.id, versionId), eq(artifactVersions.artifactId, artifact.id)))
      .for('update')
    if (!version) throw notFound()
    const next = nextScanStatus(version.scanStatus, 'retry')
    if (!next) throw conflict('not_failed')
    await tx.update(artifactVersions).set({ scanStatus: next, scanReason: null }).where(eq(artifactVersions.id, version.id))
    await enqueueArtifactScan(tx, version.id)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'artifact.rescan',
      targetType: 'artifact',
      targetId: artifact.id,
      projectId: project.id,
      metadata: { versionNo: version.versionNo },
    })
    const [dto] = await toArtifactDtos(tx, actor, project, membership, [artifact])
    if (!dto) throw notFound()
    return dto
  })
}
