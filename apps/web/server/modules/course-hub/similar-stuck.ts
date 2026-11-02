/**
 * 유사 막힘 의미 검색 (E-05, DELIVERY_PLAN §4.4, ADR 0055).
 *
 * - 켜짐 조건: 임베딩 공급자가 설정되어 있을 때만(`PEERCHIVE_EMBEDDINGS_PROVIDER=voyage` + `VOYAGE_API_KEY`, @peerchive/embeddings).
 *   꺼져 있으면 두 경로 모두 404이고 `GET /api/v1/features`의 `semanticStuck`이 false라 화면 진입점이 없습니다. 키워드 검색(search.ts)은 그대로입니다.
 * - 벡터(stuck_embeddings)는 worker가 만드는 파생 데이터라 공개 여부의 근거가 아닙니다. 모든 결과는 **같은 쿼리에서**
 *   지금 release(벡터의 release = 공개의 current_release_id)·`servableReleaseSql`(공개·release published, 엠바고 없음)·같은 release의 막힘 검색 문서·
 *   운영 조치로 가린 카드 아님(`hiddenStuckSql`)을 확인합니다. 그래서 철회·숨김·엠바고는 worker 정리 없이 다음 요청부터 빠집니다.
 *   결과의 제목·발췌는 검색 문서(카드와 같은 증상·키워드)에서 오므로 공개 카드보다 많은 글이 나가지 않습니다.
 * - 단계적 개방(E-02)과의 관계: 키워드 검색과 같게, 막힘 결과는 공개 사례 페이지(/p/:slug#public-<키>)로 가므로 허브 "준비 중" 여부로 거르지 않습니다.
 * - 검색어(`q`)는 공급자에 보내 임베딩만 하고 **저장·로그하지 않습니다**. IP마다 분당·서버 전체 시간당 한도(429)가 있습니다.
 * - 유사도: 단위 벡터의 내적(= 코사인)을 SQL에서 계산합니다(`real[]`, pgvector 없음). 후보는 지금 공개인 막힘 벡터 전체(pilot 규모 가정: 수만 건 이하).
 *   pgvector로 옮기면 `StuckVectorIndex` 구현만 바꿉니다(ADR 0055).
 */
import {
  SEARCH_QUERY_MAX,
  SIMILAR_STUCK_MIN_SCORE,
  normalizeSearchText,
  parseSimilarLimit,
} from '@peerchive/domain'
import {
  type EmbeddingProvider,
  type EmbeddingsEnv,
  EMBEDDINGS_ENV_NAMES,
  embeddingProviderKind,
  normalizeVector,
  parseEmbeddingLimits,
  resolveEmbeddingProvider,
} from '@peerchive/embeddings'
import {
  and,
  desc,
  eq,
  projects,
  publicationCandidates,
  publications,
  searchDocuments,
  sql,
  stuckEmbeddings,
  type DbExecutor,
  type SQL,
} from '@peerchive/db'
import { loadCanonicalCourse } from '../catalog/catalog'
import { ServiceError, invalid, notFound, rateLimited } from '../errors'
import { hiddenStuckSql } from '../moderation/hidden-items'
import { isUuid } from '../projects/access'
import { hitRateLimit, type RateLimitRule } from '../security/rate-limit'
import { publicStuckPath } from './hub'
import { courseScopeSql, servableReleaseSql } from './public-scope'
import { courseLabels } from './search'
import type { PublicSemanticSearchDto, SearchResultDto, SimilarStuckDto } from '../../../shared/types/api'

// ── 공급자 ───────────────────────────────────────────────────────────────

let providerOverride: EmbeddingProvider | null | undefined
/** 테스트용: 쓸 공급자(null이면 꺼짐, undefined면 환경 변수). */
export function setEmbeddingProviderForTesting(provider: EmbeddingProvider | null | undefined): void {
  providerOverride = provider
}

/** 실행 시 환경(빌드 도구가 process.env를 상수로 바꾸지 않도록 이름으로 골라 읽음). */
function currentEnv(): EmbeddingsEnv {
  const env = (globalThis.process?.env ?? {}) as EmbeddingsEnv
  const out: Record<string, string | undefined> = {}
  for (const name of EMBEDDINGS_ENV_NAMES) out[name] = env[name]
  return out
}

let cached: { key: string; provider: EmbeddingProvider | null } | null = null
/** 지금 공급자(없으면 null). 환경이 같으면 같은 객체를 씁니다. */
export function embeddingProvider(): EmbeddingProvider | null {
  if (providerOverride !== undefined) return providerOverride
  const env = currentEnv()
  // 캐시 키는 메모리에만 둡니다(키 원문을 로그·응답에 싣지 않음).
  const key = EMBEDDINGS_ENV_NAMES.map((n) => `${n}=${env[n] ?? ''}`).join('\n')
  if (cached?.key !== key) cached = { key, provider: embeddingProviderKind(env) ? resolveEmbeddingProvider(env) : null }
  return cached.provider
}

/** 의미 검색 기능이 켜져 있는지(`GET /features`의 semanticStuck). */
export function semanticStuckEnabled(): boolean {
  return embeddingProvider() !== null
}

function requireProvider(): EmbeddingProvider {
  const provider = embeddingProvider()
  if (!provider) throw notFound()
  return provider
}

// ── 벡터 색인(어댑터) ────────────────────────────────────────────────────

export interface NearestOptions {
  model: string
  dims: number
  limit: number
  now: Date
  /** 결과에서 뺄 카드(자기 자신). */
  exclude?: { publicationId: string; itemKey: string }
  /** 정본 과목 안에서만. */
  courseId?: string | null
}

export interface NearestRow {
  slug: string
  itemKey: string
  title: string
  snippet: string
  courseId: string | null
  score: number
}

/**
 * 벡터 색인 어댑터. 지금 구현(`realArrayVectorIndex`)은 `real[]` + SQL 내적이고, 운영에서 pgvector를 쓰면 같은 조건에
 * `embedding <=> $1` 정렬(HNSW)로 바꾼 구현을 넣습니다. 어떤 구현이든 공개 조건(지금 release·엠바고·가림)은 같은 쿼리에서 확인해야 합니다.
 */
export interface StuckVectorIndex {
  nearest(db: DbExecutor, vector: readonly number[], options: NearestOptions): Promise<NearestRow[]>
}

/** 저장 벡터를 지금 공개 조건과 조인하는 공통 FROM·WHERE(stuck_embeddings·search_documents·publications·publication_candidates·projects). */
function visibleEmbeddingsWhere(options: { model: string; dims: number; now: Date }): SQL {
  return sql`(${stuckEmbeddings.model} = ${options.model} and ${stuckEmbeddings.dims} = ${options.dims}
    and ${servableReleaseSql(options.now)} and not ${hiddenStuckSql()})`
}

const realArrayLiteral = (vector: readonly number[]) => sql`${`{${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(',')}}`}::real[]`

export const realArrayVectorIndex: StuckVectorIndex = {
  async nearest(db, vector, options) {
    const score = sql<number>`(select coalesce(sum(a * b), 0) from unnest(${stuckEmbeddings.embedding}, ${realArrayLiteral(vector)}) as v(a, b))`
    const rows = await db
      .select({
        slug: publications.slug,
        itemKey: stuckEmbeddings.itemKey,
        title: searchDocuments.title,
        snippet: searchDocuments.snippet,
        courseId: publicationCandidates.courseId,
        score,
      })
      .from(stuckEmbeddings)
      // 같은 release의 막힘 검색 문서가 있어야 합니다(운영 조치로 가린 카드는 문서가 지워지고, 남아 있어도 hiddenStuckSql이 거름).
      .innerJoin(
        searchDocuments,
        and(
          eq(searchDocuments.kind, 'stuck'),
          eq(searchDocuments.publicationId, stuckEmbeddings.publicationId),
          eq(searchDocuments.releaseId, stuckEmbeddings.releaseId),
          eq(searchDocuments.itemKey, stuckEmbeddings.itemKey),
        ),
      )
      .innerJoin(publications, eq(publications.id, stuckEmbeddings.publicationId))
      // 벡터를 만든 release가 지금 release일 때만(대체·철회된 release의 벡터는 조인에서 빠짐).
      .innerJoin(
        publicationCandidates,
        and(eq(publicationCandidates.id, stuckEmbeddings.releaseId), eq(publicationCandidates.id, publications.currentReleaseId)),
      )
      .innerJoin(projects, eq(projects.id, publications.projectId))
      .where(
        and(
          visibleEmbeddingsWhere(options),
          options.exclude
            ? sql`not (${stuckEmbeddings.publicationId} = ${options.exclude.publicationId} and ${stuckEmbeddings.itemKey} = ${options.exclude.itemKey})`
            : undefined,
          options.courseId ? sql`${publicationCandidates.courseId} in ${courseScopeSql(options.courseId)}` : undefined,
          sql`${score} >= ${SIMILAR_STUCK_MIN_SCORE}`,
        ),
      )
      .orderBy(desc(score), desc(publicationCandidates.publishedAt), stuckEmbeddings.id)
      .limit(options.limit)
    return rows.map((r) => ({ ...r, score: Number(r.score) }))
  },
}

let vectorIndex: StuckVectorIndex = realArrayVectorIndex

async function toResults(db: DbExecutor, rows: readonly NearestRow[]): Promise<SearchResultDto[]> {
  const labels = await courseLabels(db, rows.map((r) => r.courseId).filter((id): id is string => !!id))
  return rows.map((r) => ({
    kind: 'stuck' as const,
    title: r.title,
    snippet: r.snippet,
    path: publicStuckPath(r.slug, r.itemKey),
    course: r.courseId ? (labels.get(r.courseId) ?? null) : null,
  }))
}

// ── 비슷한 막힘(카드) ────────────────────────────────────────────────────

/** IP마다 분당(카드 기준 조회, 공급자 호출 없음). */
export const SIMILAR_STUCK_IP_RATE_LIMIT: RateLimitRule = { limit: 60, windowMs: 60 * 1000 }

const KEY = /^[A-Za-z0-9_-]{1,64}$/

/**
 * GET /public/publications/:slug/stuck/:itemKey/similar?limit= — 그 막힘 카드와 비슷한 다른 공개 막힘.
 * 카드가 지금 보이지 않으면(철회·대체·엠바고·가림·없는 키) 404. 아직 벡터가 없으면 `indexed: false`와 빈 결과.
 */
export async function similarToStuckCard(
  db: DbExecutor,
  rawSlug: unknown,
  rawKey: unknown,
  rawQuery: Record<string, unknown>,
  now: Date,
): Promise<SimilarStuckDto> {
  const provider = requireProvider()
  if (typeof rawSlug !== 'string' || typeof rawKey !== 'string' || !KEY.test(rawKey)) throw notFound()
  const limit = parseSimilarLimit(rawQuery.limit)
  if (limit === null) throw invalid({ limit: 'invalid' })
  // 원본 카드: 지금 release의 막힘 문서가 공개 조건을 만족해야 합니다(벡터는 있으면 씀).
  const [source] = await db
    .select({
      publicationId: publications.id,
      currentReleaseId: publications.currentReleaseId,
      embedding: stuckEmbeddings.embedding,
      releaseId: stuckEmbeddings.releaseId,
      model: stuckEmbeddings.model,
      dims: stuckEmbeddings.dims,
    })
    .from(searchDocuments)
    .innerJoin(publications, eq(publications.id, searchDocuments.publicationId))
    .innerJoin(
      publicationCandidates,
      and(eq(publicationCandidates.id, searchDocuments.releaseId), eq(publicationCandidates.id, publications.currentReleaseId)),
    )
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .leftJoin(stuckEmbeddings, and(eq(stuckEmbeddings.publicationId, searchDocuments.publicationId), eq(stuckEmbeddings.itemKey, searchDocuments.itemKey)))
    .where(
      and(
        eq(publications.slug, rawSlug),
        eq(searchDocuments.kind, 'stuck'),
        eq(searchDocuments.itemKey, rawKey),
        servableReleaseSql(now),
        sql`not ${hiddenStuckSql()}`,
      ),
    )
    .limit(1)
  if (!source) throw notFound()
  // 벡터가 아직 없거나(worker 대기) 지금 release·모델·차원과 다르면 비교하지 않습니다.
  if (!source.embedding || source.releaseId !== source.currentReleaseId || source.model !== provider.model || source.dims !== provider.dims) {
    return { indexed: false, results: [] }
  }
  const rows = await vectorIndex.nearest(db, source.embedding, {
    model: provider.model,
    dims: provider.dims,
    limit,
    now,
    exclude: { publicationId: source.publicationId, itemKey: rawKey },
  })
  return { indexed: true, results: await toResults(db, rows) }
}

// ── 의미로 찾기(검색어) ──────────────────────────────────────────────────

/** 검색어 임베딩 한도: IP마다 분당(설정), 서버 전체 시간당(설정, 비용 상한). */
export function semanticQueryRateLimits(): { perClient: RateLimitRule; total: RateLimitRule } {
  const limits = parseEmbeddingLimits(currentEnv())
  return {
    perClient: { limit: limits.queryPerMinutePerClient, windowMs: 60 * 1000 },
    total: { limit: limits.queryPerHourTotal, windowMs: 60 * 60 * 1000 },
  }
}

/** 공급자 호출 실패(검색어는 남기지 않음). handler가 503 `embedding_unavailable`로 바꿉니다. */
export class EmbeddingUnavailableError extends Error {
  constructor() {
    super('embedding_unavailable')
    this.name = 'EmbeddingUnavailableError'
  }
}

/**
 * GET /public/search/semantic?q=&course=&limit= — 검색어와 의미가 비슷한 공개 막힘. 검색어가 비면 공급자를 부르지 않고 빈 결과.
 * 검색어는 임베딩에만 쓰고 저장·로그하지 않습니다(한도 버킷에는 IP 해시만).
 */
export async function semanticStuckSearch(
  db: DbExecutor,
  rawQuery: Record<string, unknown>,
  clientKey: string,
  now: Date,
): Promise<PublicSemanticSearchDto> {
  const provider = requireProvider()
  const q = typeof rawQuery.q === 'string' ? normalizeSearchText(rawQuery.q) : ''
  if ([...q].length > SEARCH_QUERY_MAX) throw invalid({ q: 'too_long' })
  const limit = parseSimilarLimit(rawQuery.limit)
  if (limit === null) throw invalid({ limit: 'invalid' })
  let courseId: string | null = null
  if (rawQuery.course !== undefined && rawQuery.course !== '') {
    if (!isUuid(rawQuery.course)) throw invalid({ course: 'invalid' })
    try {
      courseId = (await loadCanonicalCourse(db, rawQuery.course.toLowerCase())).id
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'NOT_FOUND') return { q, courseId: null, results: [] }
      throw error
    }
  }
  if (!q) return { q, courseId, results: [] }
  const rules = semanticQueryRateLimits()
  if (!(await hitRateLimit(db, 'semantic_query_ip', clientKey, rules.perClient, now))) throw rateLimited()
  if (!(await hitRateLimit(db, 'semantic_query_total', 'all', rules.total, now))) throw rateLimited()
  let vector: number[]
  try {
    const [raw] = await provider.embed([q], 'query')
    vector = normalizeVector(raw ?? [])
  } catch {
    // 공급자 오류: 검색어를 남기지 않고 503으로(화면은 키워드 검색을 안내).
    throw new EmbeddingUnavailableError()
  }
  const rows = await vectorIndex.nearest(db, vector, { model: provider.model, dims: provider.dims, limit, now, courseId })
  return { q, courseId, results: await toResults(db, rows) }
}

/** 테스트용: 벡터 색인 구현 바꾸기(null이면 기본). */
export function setStuckVectorIndexForTesting(index: StuckVectorIndex | null): void {
  vectorIndex = index ?? realArrayVectorIndex
}
