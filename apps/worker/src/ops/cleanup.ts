/**
 * 주기 정리 작업(T-16, SYSTEM_DESIGN §14, ADR 0016). 이전 slice가 남긴 TODO(만료 업로드 의도·격리 파일 T-05, rate limit 행 T-02,
 * 내부 API nonce·디스코드 코드·📌 요청 T-09, 매직링크·세션 만료)를 정리합니다.
 *
 * - 모든 작업은 idempotent합니다: 조건에 맞는 행만 지우므로 두 번 돌려도, 여러 worker가 동시에 돌려도 결과가 같습니다.
 * - 배치: 한 문장에 batchSize 행까지만 지우고 반복합니다(긴 잠금·큰 트랜잭션 없음). 한 번의 실행은 maxBatches에서 멈추고 다음 주기에 이어 갑니다.
 * - 파일: 행보다 저장소 파일을 먼저 지웁니다(중간에 실패하면 다음 주기에 행을 다시 찾아 지움 — 개인 파일이 남는 쪽보다 행이 남는 쪽을 택함).
 * - 기록: 작업마다 console 한 줄(이름·개수·시간), worker_heartbeats의 `task:<이름>` 행, 지운 것이 있으면 감사 이벤트 `ops.cleanup`(개수만).
 */
import {
  and,
  artifactVersions,
  auditEvents,
  certificateChecks,
  discordPinRequests,
  eq,
  institutionAffiliations,
  inArray,
  lt,
  ne,
  isNotNull,
  sql,
  taskHeartbeatName,
  uploadIntents,
  workerHeartbeats,
  type DbExecutor,
  type SQL,
} from '@peerchive/db'
import { isObjectKey, type ObjectKey, type ObjectStorage } from '@peerchive/files'
import { cleanupStaleAlbumPhotos, referencedAlbumPhotoKeys } from './album-photos'
import type { OpsTaskName } from './config'
import { cleanupPostMedia, referencedPostMediaKeys } from './post-media'

export { cleanupPostMedia, cleanupStaleAlbumPhotos }

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** 보존 기간(기본값). RUNBOOK "데이터 보존" 표와 같은 값입니다. */
export const RETENTION = {
  /** 만료된 업로드 의도는 만료 1시간 뒤 지웁니다(진행 중이던 PUT·완료 요청이 끝날 여유). */
  uploadIntentGraceMs: HOUR_MS,
  /** 주인 없는 격리 파일은 24시간이 지나야 지웁니다(검사·완료 사이의 경합 여유). */
  orphanQuarantineAgeMs: 24 * HOUR_MS,
  /** rate limit 창은 최대 24시간(신고 일일 한도). 창 둘이 지난 행만 지웁니다. */
  rateLimitMaxWindowMs: 24 * HOUR_MS,
  /** 내부 API nonce 기억 시간(@peerchive/bot-protocol NONCE_TTL_SECONDS = 10분)의 두 배. */
  internalNonceTtlMs: 20 * MINUTE_MS,
  /** 쓰였거나 만료된 매직링크 토큰은 만든 지 7일이 지나면 지웁니다. */
  magicLinkRetentionMs: 7 * DAY_MS,
  /** 쓰였거나 만료된 디스코드 코드는 하루 뒤 지웁니다. */
  discordCodeRetentionMs: DAY_MS,
  /** 전달을 마친 outbox 행은 30일 뒤 지웁니다. */
  outboxRetentionMs: 30 * DAY_MS,
  /** 학교 메일 인증(C-01): 코드가 만료(또는 잠김)된 지 1시간 지난 pending 요청은 expired로 바꾸고 메일 해시를 지웁니다. */
  affiliationPendingGraceMs: HOUR_MS,
  /** 쓰였거나 만료된 학교 메일 인증 코드는 하루 뒤 지웁니다. */
  affiliationCodeRetentionMs: DAY_MS,
  /** 기수 승인 요청(I-01)은 30일 안에 승인을 다 받지 못하면 expired로 바꿉니다(@peerchive/domain COHORT_APPROVAL_TTL_MS). */
  cohortApprovalPendingMs: 30 * DAY_MS,
} as const

/** 한 번의 실행에서 최대 배치 수(그 뒤는 다음 주기). */
export const MAX_BATCHES = 50
/** 격리 파일 정리 안전장치: 살펴본 파일 중 이 비율 넘게(그리고 이 개수 넘게) 주인이 없으면 지우지 않고 멈춥니다(잘못된 DB에 붙은 worker 방지). */
export const ORPHAN_GUARD = { minFiles: 50, maxRatio: 0.5 } as const

export interface CleanupDeps {
  storage: ObjectStorage
  batchSize: number
}

export interface TaskOutcome {
  /** 지우거나 바꾼 행 수(파일 정리는 지운 파일 수). */
  affected: number
  batches: number
  /** 지운 저장소 파일 수(있을 때). */
  objects?: number
  /** 안전장치로 멈췄을 때 짧은 코드. */
  halted?: string
  /** 실패한 항목 수(계정 정리: 다음 주기에 다시 시도). */
  failed?: number
}

/** `delete … where ctid = any(array(select ctid … limit n))`를 반복합니다. */
async function deleteInBatches(db: DbExecutor, table: ReturnType<typeof sql.identifier>, where: SQL, batchSize: number): Promise<TaskOutcome> {
  let affected = 0
  let batches = 0
  while (batches < MAX_BATCHES) {
    const result = await db.execute(
      sql`delete from ${table} where ctid = any(array(select ctid from ${table} where ${where} limit ${batchSize}))`,
    )
    const n = Number((result as unknown as { count?: number }).count ?? 0)
    batches++
    affected += n
    if (n < batchSize) break
  }
  return { affected, batches }
}

const t = (name: string) => sql.identifier(name)

/**
 * 만료된 업로드 의도 + 그 격리 파일(버전이 이어받지 않은 것만). 앨범 사진의 끝나지 않은 올리기·통과하지 못한 사진도 함께(A-02),
 * 라운지 미디어의 끝나지 않은 올리기·통과하지 못한 미디어·지운 글의 미디어도 함께(A-04).
 */
export async function cleanupUploadIntents(db: DbExecutor, deps: CleanupDeps, now: Date): Promise<TaskOutcome> {
  const cutoff = new Date(now.getTime() - RETENTION.uploadIntentGraceMs)
  let affected = 0
  let objects = 0
  let batches = 0
  while (batches < MAX_BATCHES) {
    batches++
    const rows = await db
      .select({ id: uploadIntents.id, key: uploadIntents.quarantineKey, completedAt: uploadIntents.completedAt })
      .from(uploadIntents)
      .where(lt(uploadIntents.expiresAt, cutoff))
      .orderBy(uploadIntents.expiresAt)
      .limit(deps.batchSize)
    if (rows.length === 0) break
    const keys = rows.map((r) => r.key).filter(isObjectKey)
    const kept = keys.length
      ? new Set(
          (await db.select({ key: artifactVersions.objectKey }).from(artifactVersions).where(inArray(artifactVersions.objectKey, keys))).map(
            (r) => r.key,
          ),
        )
      : new Set<string>()
    for (const key of keys) {
      if (kept.has(key)) continue
      await deps.storage.delete(key as ObjectKey)
      objects++
    }
    const deleted = await db
      .delete(uploadIntents)
      .where(inArray(uploadIntents.id, rows.map((r) => r.id)))
      .returning({ id: uploadIntents.id })
    affected += deleted.length
    if (rows.length < deps.batchSize) break
  }
  const album = await cleanupStaleAlbumPhotos(db, deps, now)
  const media = await cleanupPostMedia(db, deps, now)
  return {
    affected: affected + album.affected + media.affected,
    batches: batches + album.batches + media.batches,
    objects: objects + album.objects + media.objects,
  }
}

/** 어떤 버전·업로드 의도도 가리키지 않는 24시간 넘은 격리 파일. */
export async function cleanupOrphanQuarantine(db: DbExecutor, deps: CleanupDeps, now: Date): Promise<TaskOutcome> {
  const cutoff = now.getTime() - RETENTION.orphanQuarantineAgeMs
  const candidates: ObjectKey[] = []
  let scanned = 0
  for await (const item of deps.storage.list('quarantine')) {
    scanned++
    if (item.modifiedAt.getTime() < cutoff) candidates.push(item.key)
  }
  const orphans: ObjectKey[] = []
  for (let i = 0; i < candidates.length; i += deps.batchSize) {
    const chunk = candidates.slice(i, i + deps.batchSize)
    const referenced = new Set<string>([
      ...(await db.select({ key: artifactVersions.objectKey }).from(artifactVersions).where(inArray(artifactVersions.objectKey, chunk))).map((r) => r.key),
      ...(await db.select({ key: uploadIntents.quarantineKey }).from(uploadIntents).where(inArray(uploadIntents.quarantineKey, chunk))).map((r) => r.key),
      // 수료증 파일(I-01)은 검사 뒤에도 격리 키에 둡니다. 지우는 것은 `certificate-files` 작업(삭제 장부 기록)뿐입니다.
      ...(await db.select({ key: certificateChecks.objectKey }).from(certificateChecks).where(inArray(certificateChecks.objectKey, chunk))).map((r) => r.key!),
      // 앨범 사진(A-02, ADR 0039)도 검사 뒤 격리 키에 둡니다. 행이 없는(지운 사진의) 파일만 여기서 지웁니다.
      ...(await referencedAlbumPhotoKeys(db, chunk)),
      // 라운지 미디어(A-04, ADR 0041)도 같습니다.
      ...(await referencedPostMediaKeys(db, chunk)),
    ])
    for (const key of chunk) if (!referenced.has(key)) orphans.push(key)
  }
  if (orphans.length > ORPHAN_GUARD.minFiles && orphans.length / Math.max(scanned, 1) > ORPHAN_GUARD.maxRatio) {
    return { affected: 0, batches: 1, objects: 0, halted: 'orphan_ratio_too_high' }
  }
  for (const key of orphans) await deps.storage.delete(key)
  return { affected: orphans.length, batches: 1, objects: orphans.length }
}

export const cleanupRateLimitBuckets = (db: DbExecutor, deps: CleanupDeps, now: Date) =>
  deleteInBatches(
    db,
    t('rate_limit_buckets'),
    sql`window_start < ${new Date(now.getTime() - 2 * RETENTION.rateLimitMaxWindowMs).toISOString()}::timestamptz`,
    deps.batchSize,
  )

export const cleanupInternalNonces = (db: DbExecutor, deps: CleanupDeps, now: Date) =>
  deleteInBatches(
    db,
    t('internal_request_nonces'),
    sql`received_at < ${new Date(now.getTime() - RETENTION.internalNonceTtlMs).toISOString()}::timestamptz`,
    deps.batchSize,
  )

export const cleanupMagicLinkTokens = (db: DbExecutor, deps: CleanupDeps, now: Date) =>
  deleteInBatches(
    db,
    t('magic_link_tokens'),
    sql`(used_at is not null or expires_at < ${now.toISOString()}::timestamptz)
      and created_at < ${new Date(now.getTime() - RETENTION.magicLinkRetentionMs).toISOString()}::timestamptz`,
    deps.batchSize,
  )

export const cleanupSessions = (db: DbExecutor, deps: CleanupDeps, now: Date) =>
  deleteInBatches(db, t('sessions'), sql`expires_at < ${now.toISOString()}::timestamptz`, deps.batchSize)

export const cleanupDiscordCodes = (db: DbExecutor, deps: CleanupDeps, now: Date) => {
  const cutoff = new Date(now.getTime() - RETENTION.discordCodeRetentionMs).toISOString()
  return deleteInBatches(
    db,
    t('discord_codes'),
    sql`(used_at < ${cutoff}::timestamptz or expires_at < ${cutoff}::timestamptz)`,
    deps.batchSize,
  )
}

/**
 * 만료된 📌 승인 요청을 expired로 바꾸고 저장했던 메시지 내용을 지웁니다(웹의 expirePinRequests와 같은 규칙, ADR 0009).
 * DB 제약(결정·만료면 content null)이 있지만, 혹시 남은 내용도 함께 비웁니다.
 */
export async function cleanupPinRequests(db: DbExecutor, _deps: CleanupDeps, now: Date): Promise<TaskOutcome> {
  const expired = await db
    .update(discordPinRequests)
    .set({ status: 'expired', content: null, decidedAt: now })
    .where(and(eq(discordPinRequests.status, 'pending'), lt(discordPinRequests.expiresAt, now)))
    .returning({ id: discordPinRequests.id })
  const scrubbed = await db
    .update(discordPinRequests)
    .set({ content: null })
    .where(and(ne(discordPinRequests.status, 'pending'), isNotNull(discordPinRequests.content)))
    .returning({ id: discordPinRequests.id })
  return { affected: expired.length + scrubbed.length, batches: 1 }
}

export const cleanupOutbox = (db: DbExecutor, deps: CleanupDeps, now: Date) =>
  deleteInBatches(
    db,
    t('outbox_events'),
    sql`dispatched_at is not null and dispatched_at < ${new Date(now.getTime() - RETENTION.outboxRetentionMs).toISOString()}::timestamptz`,
    deps.batchSize,
  )

/**
 * 학교 메일 인증(C-01, ADR 0018): 쓸 수 있는 코드가 없어진 지 1시간 지난 pending 요청을 expired로 바꾸고(메일 해시 삭제 — 주소 HMAC을 오래 두지 않음),
 * 쓰였거나 만료된 지 하루 지난 코드 행을 지웁니다. active·revoked 행은 건드리지 않습니다.
 * 메일이 아닌 수단(I-01, ADR 0037)의 pending은 코드가 없으므로 여기서 만료시키지 않습니다. 기수 승인 요청만 30일 뒤 expired로 바꾸고,
 * 수료증 요청은 `certificate-files` 작업이 파일과 함께 정리합니다.
 */
export async function cleanupAffiliationCodes(db: DbExecutor, deps: CleanupDeps, now: Date): Promise<TaskOutcome> {
  const graceCutoff = new Date(now.getTime() - RETENTION.affiliationPendingGraceMs).toISOString()
  const expired = await db
    .update(institutionAffiliations)
    .set({ status: 'expired', emailHash: null, updatedAt: now })
    .where(
      and(
        eq(institutionAffiliations.status, 'pending'),
        eq(institutionAffiliations.method, 'email'),
        sql`not exists (select 1 from affiliation_codes c where c.affiliation_id = ${institutionAffiliations.id}
          and c.used_at is null and c.attempts < 5 and c.expires_at > ${graceCutoff}::timestamptz)`,
      ),
    )
    .returning({ id: institutionAffiliations.id })
  const cohortExpired = await db
    .update(institutionAffiliations)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(institutionAffiliations.status, 'pending'),
        eq(institutionAffiliations.method, 'cohort_approval'),
        lt(institutionAffiliations.createdAt, new Date(now.getTime() - RETENTION.cohortApprovalPendingMs)),
      ),
    )
    .returning({ id: institutionAffiliations.id })
  const cutoff = new Date(now.getTime() - RETENTION.affiliationCodeRetentionMs).toISOString()
  const codes = await deleteInBatches(
    db,
    t('affiliation_codes'),
    sql`(used_at < ${cutoff}::timestamptz or expires_at < ${cutoff}::timestamptz)`,
    deps.batchSize,
  )
  return { affected: expired.length + cohortExpired.length + codes.affected, batches: codes.batches + 1 }
}

/**
 * AI 회고 인터뷰(E-12, ADR 0057): expires_at이 지난 세션과 그 초안을 지웁니다(초안 → 세션 순서, 외래 키). 질문·답변·초안 글은 로그에 남기지 않고 개수만.
 */
export async function cleanupAiRetroSessions(db: DbExecutor, deps: CleanupDeps, now: Date): Promise<TaskOutcome> {
  const expired = sql`session_id in (select id from ai_retro_sessions where expires_at < ${now.toISOString()}::timestamptz)`
  const drafts = await deleteInBatches(db, t('ai_retro_drafts'), expired, deps.batchSize)
  const sessions = await deleteInBatches(
    db,
    t('ai_retro_sessions'),
    sql`expires_at < ${now.toISOString()}::timestamptz and not exists (select 1 from ai_retro_drafts d where d.session_id = ai_retro_sessions.id)`,
    deps.batchSize,
  )
  return { affected: drafts.affected + sessions.affected, batches: drafts.batches + sessions.batches }
}

export type CleanupTask = (db: DbExecutor, deps: CleanupDeps, now: Date) => Promise<TaskOutcome>

export const CLEANUP_TASKS: Record<Exclude<OpsTaskName, 'account-purge' | 'name-mode-changes' | 'social-link-recheck' | 'certificate-files' | 'course-term-prompts'>, CleanupTask> = {
  'upload-intents': cleanupUploadIntents,
  'orphan-quarantine': cleanupOrphanQuarantine,
  'rate-limit-buckets': cleanupRateLimitBuckets,
  'internal-nonces': cleanupInternalNonces,
  'magic-link-tokens': cleanupMagicLinkTokens,
  sessions: cleanupSessions,
  'discord-codes': cleanupDiscordCodes,
  'pin-requests': cleanupPinRequests,
  outbox: cleanupOutbox,
  'affiliation-codes': cleanupAffiliationCodes,
  'ai-retro-sessions': cleanupAiRetroSessions,
}

/**
 * 작업 하나를 실행하고 기록합니다(heartbeat 행·감사·로그 한 줄). 실패하면 heartbeat에 status=error를 남기고 예외를 다시 던집니다
 * (pg-boss가 재시도). 기록에는 개수·시간·상태 코드만 둡니다.
 */
export async function runRecordedTask(
  db: DbExecutor,
  name: OpsTaskName,
  run: () => Promise<TaskOutcome>,
  now: () => Date = () => new Date(),
): Promise<TaskOutcome> {
  const started = now()
  const startedMs = performance.now()
  try {
    const outcome = await run()
    const ms = Math.round(performance.now() - startedMs)
    const details = {
      status: outcome.halted ? 'halted' : 'ok',
      affected: outcome.affected,
      batches: outcome.batches,
      objects: outcome.objects ?? null,
      halted: outcome.halted ?? null,
      failed: outcome.failed ?? 0,
      ms,
    }
    await beat(db, taskHeartbeatName(name), details, started)
    if (outcome.affected > 0 || outcome.halted || outcome.failed) {
      await db.insert(auditEvents).values({
        actorId: null,
        action: 'ops.cleanup',
        targetType: 'ops_task',
        metadata: { task: name, affected: outcome.affected, objects: outcome.objects ?? null, halted: outcome.halted ?? null, failed: outcome.failed ?? 0 },
      })
    }
    console.info(
      `[worker] ops ${name}: affected=${outcome.affected} batches=${outcome.batches}${outcome.objects !== undefined ? ` objects=${outcome.objects}` : ''}${outcome.halted ? ` halted=${outcome.halted}` : ''}${outcome.failed ? ` failed=${outcome.failed}` : ''} ms=${ms}`,
    )
    return outcome
  } catch (error) {
    const code = (error as { code?: unknown }).code
    await beat(db, taskHeartbeatName(name), { status: 'error', error: typeof code === 'string' ? code : 'error' }, started).catch(() => {})
    console.error(`[worker] ops ${name}: failed (${(error as Error).name})`)
    throw error
  }
}

/** worker_heartbeats 행 고쳐 쓰기. */
export async function beat(
  db: DbExecutor,
  name: string,
  details: Record<string, string | number | boolean | null>,
  startedAt?: Date,
): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ name, beatAt: sql`now()`, startedAt: startedAt ?? null, details })
    .onConflictDoUpdate({
      target: workerHeartbeats.name,
      set: { beatAt: sql`now()`, details, ...(startedAt && { startedAt }) },
    })
}

