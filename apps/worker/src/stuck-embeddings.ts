/**
 * 유사 막힘 임베딩 색인 (E-05, DELIVERY_PLAN §4.4, ADR 0055).
 *
 * 무엇을 보내나
 * - 공급자로 보내는 글은 **지금 게시 중이고 엠바고가 없는 공개 release 스냅샷**의 🧱막힘 증상·키워드와 그 막힘을 가리키는 💡해결 방법뿐입니다
 *   (@peerchive/domain `stuckEmbeddingSources`, 운영 조치로 가린 로그 제외). 비공개 작업 공간의 로그 테이블(log_entries·log_revisions)은
 *   이 모듈이 읽지 않습니다. 대상은 T-13 search-index handler가 만든 막힘 검색 문서(kind = 'stuck')에서 고릅니다(같은 outbox 파이프라인).
 * - 글·벡터를 로그에 남기지 않습니다(개수만).
 *
 * 어떻게
 * - 주기 작업 `embeddings.stuck-sync`(기본 10분마다, `PEERCHIVE_EMBEDDINGS_CRON`)가 지금 release의 막힘 문서 중 임베딩이 없거나, 다른 release·모델·차원이거나,
 *   `stale`인 것을 골라 글을 다시 만들고 내용 해시를 비교합니다. 해시가 같으면 `release_id`만 옮기고(공급자 호출 없음), 다르면 임베딩합니다.
 * - 비용 상한: 한 번 실행에 공급자로 보내는 글은 `PEERCHIVE_EMBEDDINGS_MAX_ITEMS_PER_RUN`(기본 200)개까지, 나머지는 다음 실행으로 미룹니다.
 *   배치(`PEERCHIVE_EMBEDDINGS_BATCH_SIZE`), 분당 요청 수(`PEERCHIVE_EMBEDDINGS_RPM`), 429·5xx·네트워크 오류는 지수 백오프로 재시도합니다.
 * - 정리: 철회·제한(`publication.withdrawn`) → 그 공개의 임베딩 삭제, 새 release 게시 → 지금 스냅샷에 없는 카드의 임베딩 삭제(derived cleanup handler),
 *   운영 조치로 로그를 가리거나 해제 → 그 공개의 임베딩을 stale로(가린 막힘 카드는 바로 삭제), 탈퇴 정리 → 삭제(ops/purge.ts).
 *   웹의 읽기는 이 정리를 기다리지 않습니다(요청마다 지금 release·엠바고·가린 카드를 같은 쿼리에서 확인).
 * - 규모 가정(pilot): 대상 검색은 한 번에 최대 1,000개 문서만 봅니다. 공급자가 꺼져 있으면 일정 자체를 등록하지 않습니다.
 */
import type { PgBoss } from 'pg-boss'
import { type HubSnapshot, stuckEmbeddingSources } from '@peerchive/domain'
import {
  and,
  eq,
  inArray,
  isNull,
  notInArray,
  publicationCandidates,
  publications,
  releaseHiddenItems,
  searchDocuments,
  sql,
  stuckEmbeddings,
  type DbExecutor,
} from '@peerchive/db'
import {
  DEFAULT_RETRY,
  type EmbeddingLimits,
  type EmbeddingProvider,
  RateGate,
  type RetryOptions,
  embeddingContentHash,
  normalizeVector,
  withRetry,
} from '@peerchive/embeddings'
import type { DerivedCleanupHandler } from './publication-events'

export const STUCK_EMBEDDING_QUEUE = 'embeddings.stuck-sync'
export const STUCK_EMBEDDING_DEFAULT_CRON = '*/10 * * * *'
/** 한 번 실행에 살펴보는 막힘 문서 수(공급자 호출 수와 별개, DB 작업 상한). */
export const STUCK_EMBEDDING_SCAN_LIMIT = 1000

/**
 * 지금 엠바고 중인 과제인지(웹 `public-scope.ts` embargoActiveSql과 같은 식: projects.embargo_until, 해제되지 않은 프로젝트·학기 엠바고).
 * FROM에 publications(p)이 있어야 합니다. 엠바고 중인 공개의 글은 공급자로 보내지 않습니다.
 */
const embargoActiveSql = (now: Date) => sql`exists (select 1 from projects pr where pr.id = ${publications.projectId} and (
    coalesce(pr.embargo_until > ${now.toISOString()}::timestamptz, false)
    or exists (select 1 from embargoes pe where pe.project_id = pr.id and pe.revoked_at is null and pe.until > ${now.toISOString()}::timestamptz)
    or exists (select 1 from embargoes te where pr.course_term_id is not null and te.course_term_id = pr.course_term_id
      and te.revoked_at is null and te.until > ${now.toISOString()}::timestamptz)))`

export interface StuckEmbeddingRunResult {
  /** 살펴본 막힘 문서 수. */
  scanned: number
  /** 해시가 같아 release만 옮긴 수(공급자 호출 없음). */
  reused: number
  /** 공급자로 보내 새로 저장한 수. */
  embedded: number
  /** 비용 상한 때문에 다음 실행으로 미룬 수. */
  deferred: number
  /** 지금 글이 없어(가린 카드 등) 지운 임베딩 수. */
  removed: number
  /** 재시도 뒤에도 실패한 공급자 요청이 있었는지. */
  failed: boolean
}

export interface StuckEmbeddingRunOptions {
  now?: Date
  retry?: RetryOptions
  gate?: RateGate
}

interface Candidate {
  docId: string
  publicationId: string
  releaseId: string
  itemKey: string
  existingId: string | null
  existingHash: string | null
  existingModel: string | null
  existingDims: number | null
}

/** 임베딩을 새로 만들거나 옮겨야 하는 막힘 문서(지금 release·published·엠바고 없음·가리지 않음). */
async function findCandidates(db: DbExecutor, provider: EmbeddingProvider, now: Date): Promise<Candidate[]> {
  const rows = await db
    .select({
      docId: searchDocuments.id,
      publicationId: searchDocuments.publicationId,
      releaseId: searchDocuments.releaseId,
      itemKey: searchDocuments.itemKey,
      existingId: stuckEmbeddings.id,
      existingHash: stuckEmbeddings.contentHash,
      existingModel: stuckEmbeddings.model,
      existingDims: stuckEmbeddings.dims,
    })
    .from(searchDocuments)
    .innerJoin(publications, and(eq(publications.id, searchDocuments.publicationId), eq(publications.currentReleaseId, searchDocuments.releaseId)))
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, searchDocuments.releaseId))
    .leftJoin(stuckEmbeddings, and(eq(stuckEmbeddings.publicationId, searchDocuments.publicationId), eq(stuckEmbeddings.itemKey, searchDocuments.itemKey)))
    .where(
      and(
        eq(searchDocuments.kind, 'stuck'),
        eq(publications.status, 'published'),
        eq(publicationCandidates.status, 'published'),
        sql`${publicationCandidates.releaseNo} is not null and ${publicationCandidates.publishedAt} is not null`,
        sql`not ${embargoActiveSql(now)}`,
        sql`(${stuckEmbeddings.id} is null or ${stuckEmbeddings.releaseId} <> ${searchDocuments.releaseId} or ${stuckEmbeddings.stale}
          or ${stuckEmbeddings.model} <> ${provider.model} or ${stuckEmbeddings.dims} <> ${provider.dims})`,
      ),
    )
    .orderBy(sql`${publicationCandidates.publishedAt} desc`, searchDocuments.id)
    .limit(STUCK_EMBEDDING_SCAN_LIMIT)
  return rows.filter((r): r is Candidate => !!r.publicationId && !!r.releaseId && !!r.itemKey)
}

/** release별 임베딩할 글(가린 로그 제외). */
async function sourcesFor(db: DbExecutor, candidates: readonly Candidate[]): Promise<Map<string, Map<string, string>>> {
  const releaseIds = [...new Set(candidates.map((c) => c.releaseId))]
  const out = new Map<string, Map<string, string>>()
  if (releaseIds.length === 0) return out
  const releases = await db
    .select({ id: publicationCandidates.id, publicationId: publicationCandidates.publicationId, snapshot: publicationCandidates.snapshot })
    .from(publicationCandidates)
    .where(inArray(publicationCandidates.id, releaseIds))
  const publicationIds = [...new Set(releases.map((r) => r.publicationId))]
  const hidden = await db
    .select({ publicationId: releaseHiddenItems.publicationId, key: releaseHiddenItems.itemKey })
    .from(releaseHiddenItems)
    .where(and(inArray(releaseHiddenItems.publicationId, publicationIds), eq(releaseHiddenItems.itemKind, 'log'), isNull(releaseHiddenItems.liftedAt)))
  for (const release of releases) {
    const hiddenKeys = new Set(hidden.filter((h) => h.publicationId === release.publicationId).map((h) => h.key))
    const sources = stuckEmbeddingSources(release.snapshot as unknown as HubSnapshot, hiddenKeys)
    out.set(release.id, new Map(sources.map((s) => [s.itemKey, s.text])))
  }
  return out
}

/** 지금도 그 release가 게시 중일 때만 저장합니다(그 사이 철회·대체되었으면 쓰지 않음). */
async function upsertIfCurrent(
  db: DbExecutor,
  item: { publicationId: string; releaseId: string; itemKey: string; hash: string },
  provider: EmbeddingProvider,
  vector: number[] | null,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: publications.id })
      .from(publications)
      .where(and(eq(publications.id, item.publicationId), eq(publications.currentReleaseId, item.releaseId), eq(publications.status, 'published')))
      .limit(1)
      .for('share')
    if (!current) return false
    if (vector === null) {
      // 해시가 같음: 벡터는 그대로, release만 옮깁니다.
      const moved = await tx
        .update(stuckEmbeddings)
        .set({ releaseId: item.releaseId, stale: false, updatedAt: now })
        .where(and(eq(stuckEmbeddings.publicationId, item.publicationId), eq(stuckEmbeddings.itemKey, item.itemKey)))
        .returning({ id: stuckEmbeddings.id })
      return moved.length > 0
    }
    await tx
      .insert(stuckEmbeddings)
      .values({
        publicationId: item.publicationId,
        releaseId: item.releaseId,
        itemKey: item.itemKey,
        model: provider.model,
        dims: provider.dims,
        contentHash: item.hash,
        embedding: vector,
        stale: false,
        embeddedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [stuckEmbeddings.publicationId, stuckEmbeddings.itemKey],
        set: { releaseId: item.releaseId, model: provider.model, dims: provider.dims, contentHash: item.hash, embedding: vector, stale: false, embeddedAt: now, updatedAt: now },
      })
    return true
  })
}

/** 한 번 실행(주기 작업·테스트). 공급자가 없으면 부르지 않습니다. */
export async function syncStuckEmbeddings(
  db: DbExecutor,
  provider: EmbeddingProvider,
  limits: Pick<EmbeddingLimits, 'maxItemsPerRun' | 'batchSize' | 'requestsPerMinute'>,
  options: StuckEmbeddingRunOptions = {},
): Promise<StuckEmbeddingRunResult> {
  const now = options.now ?? new Date()
  const result: StuckEmbeddingRunResult = { scanned: 0, reused: 0, embedded: 0, deferred: 0, removed: 0, failed: false }
  const candidates = await findCandidates(db, provider, now)
  result.scanned = candidates.length
  const sources = await sourcesFor(db, candidates)

  const toEmbed: Array<{ publicationId: string; releaseId: string; itemKey: string; hash: string; text: string }> = []
  for (const c of candidates) {
    const text = sources.get(c.releaseId)?.get(c.itemKey)
    if (text === undefined) {
      // 지금 글이 없음(운영 조치로 가린 카드 등): 남은 벡터를 지웁니다.
      if (c.existingId) {
        await db.delete(stuckEmbeddings).where(eq(stuckEmbeddings.id, c.existingId))
        result.removed++
      }
      continue
    }
    const hash = embeddingContentHash(provider.model, provider.dims, text)
    if (c.existingId && c.existingHash === hash && c.existingModel === provider.model && c.existingDims === provider.dims) {
      if (await upsertIfCurrent(db, { ...c, hash }, provider, null, now)) result.reused++
      continue
    }
    toEmbed.push({ publicationId: c.publicationId, releaseId: c.releaseId, itemKey: c.itemKey, hash, text })
  }

  const budget = toEmbed.slice(0, limits.maxItemsPerRun)
  result.deferred = toEmbed.length - budget.length
  const gate = options.gate ?? RateGate.perMinute(limits.requestsPerMinute)
  for (let i = 0; i < budget.length; i += limits.batchSize) {
    const batch = budget.slice(i, i + limits.batchSize)
    let vectors: number[][]
    try {
      await gate.wait()
      vectors = await withRetry(() => provider.embed(batch.map((b) => b.text), 'document'), options.retry ?? DEFAULT_RETRY)
    } catch (error) {
      // 글·응답 본문은 남기지 않습니다. 남은 것은 다음 실행에서 다시 시도합니다.
      console.error(`[worker] stuck embeddings: provider ${provider.name} failed (${(error as Error).name}); ${budget.length - i} item(s) left for the next run`)
      result.failed = true
      result.deferred += budget.length - i
      break
    }
    for (let j = 0; j < batch.length; j++) {
      if (await upsertIfCurrent(db, batch[j]!, provider, normalizeVector(vectors[j]!), now)) result.embedded++
    }
  }
  return result
}

/** 운영 조치로 같은 공개의 로그를 가리거나 해제했을 때: 그 공개의 임베딩을 stale로(가린 막힘 카드는 바로 삭제). 바꾼 행 수. */
export async function onLogVisibilityChanged(db: DbExecutor, publicationId: string, hiddenStuckKey: string | null): Promise<number> {
  let affected = 0
  if (hiddenStuckKey) {
    affected += (
      await db
        .delete(stuckEmbeddings)
        .where(and(eq(stuckEmbeddings.publicationId, publicationId), eq(stuckEmbeddings.itemKey, hiddenStuckKey)))
        .returning({ id: stuckEmbeddings.id })
    ).length
  }
  affected += (
    await db.update(stuckEmbeddings).set({ stale: true }).where(eq(stuckEmbeddings.publicationId, publicationId)).returning({ id: stuckEmbeddings.id })
  ).length
  return affected
}

/**
 * 게시·철회 정리: 철회·제한이면 그 공개의 임베딩을 모두 지우고, 새 release가 게시되면 지금 스냅샷에 없는 카드의 임베딩을 지웁니다
 * (남은 카드는 다음 동기화가 해시를 비교해 release를 옮기거나 다시 임베딩).
 */
export const stuckEmbeddingsCleanupHandler: DerivedCleanupHandler = {
  name: 'stuck-embeddings',
  async onWithdrawn(db, event) {
    const deleted = await db.delete(stuckEmbeddings).where(eq(stuckEmbeddings.publicationId, event.publicationId)).returning({ id: stuckEmbeddings.id })
    return deleted.length
  },
  async onPublished(db, event) {
    const [row] = await db
      .select({ publication: publications, release: publicationCandidates })
      .from(publications)
      .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
      .where(eq(publications.id, event.publicationId))
      .limit(1)
    if (!row || row.publication.status !== 'published' || row.release.status !== 'published' || row.release.id !== event.releaseId) return 0
    const keys = stuckEmbeddingSources(row.release.snapshot as unknown as HubSnapshot).map((s) => s.itemKey)
    const deleted = await db
      .delete(stuckEmbeddings)
      .where(and(eq(stuckEmbeddings.publicationId, event.publicationId), keys.length > 0 ? notInArray(stuckEmbeddings.itemKey, keys) : undefined))
      .returning({ id: stuckEmbeddings.id })
    return deleted.length
  },
}

export const STUCK_EMBEDDING_QUEUE_OPTIONS = { retryLimit: 1, retryDelay: 60, expireInSeconds: 15 * 60 } as const

/** 주기 동기화 등록. 공급자가 없거나 cron이 null(off)이면 일정을 지우고 등록하지 않습니다. */
export async function registerStuckEmbeddingQueue(
  boss: PgBoss,
  db: DbExecutor,
  provider: EmbeddingProvider | null,
  limits: EmbeddingLimits,
  cron: string | null,
  timezone: string,
): Promise<void> {
  await boss.createQueue(STUCK_EMBEDDING_QUEUE, STUCK_EMBEDDING_QUEUE_OPTIONS)
  await boss.updateQueue(STUCK_EMBEDDING_QUEUE, STUCK_EMBEDDING_QUEUE_OPTIONS)
  if (!provider || !cron) {
    await boss.unschedule(STUCK_EMBEDDING_QUEUE).catch(() => {})
    return
  }
  await boss.schedule(STUCK_EMBEDDING_QUEUE, cron, {}, { tz: timezone })
  await boss.work(STUCK_EMBEDDING_QUEUE, { batchSize: 1, pollingIntervalSeconds: 30 }, async ([job]) => {
    if (!job) return
    const r = await syncStuckEmbeddings(db, provider, limits)
    console.info(
      `[worker] stuck embeddings ${job.id}: scanned=${r.scanned} embedded=${r.embedded} reused=${r.reused} removed=${r.removed} deferred=${r.deferred} failed=${r.failed}`,
    )
  })
}

/** cron 설정: 비었으면 기본, `off`면 끔. */
export function parseStuckEmbeddingCron(raw: string | undefined): string | null {
  const value = raw?.trim() ?? ''
  if (!value) return STUCK_EMBEDDING_DEFAULT_CRON
  if (/^(off|0|false|no)$/i.test(value)) return null
  return value
}
