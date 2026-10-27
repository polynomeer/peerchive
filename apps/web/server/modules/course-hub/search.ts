/**
 * 공개 검색 (T-13, SYSTEM_DESIGN §9 `GET /search`·§11.1, ADR 0013).
 *
 * `GET /api/v1/public/search?q=&type=case|stuck|note&course=` — 로그인 불필요, 쿠키 없음, noindex.
 * - 검색 문서(search_documents)는 worker가 게시 이벤트로 만드는 **파생 데이터**입니다. 공개 여부의 근거로 쓰지 않습니다.
 * - 모든 쿼리는 원본 행과 조인해 **같은 쿼리에서** 지금 공개인지 확인합니다:
 *   사례·막힘 = 문서의 release가 지금 release이고 공개·release가 published이며 엠바고가 없음(`servableReleaseSql`),
 *   노트 = 노트가 published이고 문서를 만든 version과 지금 version이 같음, 막힘 Q&A(C-09) = 항목이 published.
 *   그래서 철회 직후 정리 handler가 아직 돌지 않아 문서 행이 남아 있어도 결과에 나오지 않습니다.
 * - 일치: 정규화한 글의 부분 일치(ILIKE, 한국어 두 글자 검색어도 됨) 또는 pg_trgm 단어 유사도(`<%`). 유사도 순 → 최근 순.
 */
import { SEARCH_KINDS, SEARCH_QUERY_MAX, normalizeSearchText, type SearchKind } from '@peerchive/domain'
import {
  and,
  courseQaItems,
  courses,
  desc,
  eq,
  inArray,
  projects,
  publicationCandidates,
  publications,
  schools,
  searchDocuments,
  seniorNotes,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { loadCanonicalCourse } from '../catalog/catalog'
import { ServiceError, invalid } from '../errors'
import { hiddenStuckSql } from '../moderation/hidden-items'
import { isUuid } from '../projects/access'
import { publicQaPath } from './course-qa'
import { publicCasePath, publicStuckPath } from './hub'
import { courseScopeSql, servableReleaseSql } from './public-scope'
import type { PublicSearchDto, SearchResultDto } from '../../../shared/types/api'

export const SEARCH_RESULT_LIMIT = 20

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`)

export const publicNotePath = (courseId: string, noteId: string) => `/c/${courseId}#note-${noteId}`

interface SearchQuery {
  q: string
  type: SearchKind | null
  courseId: string | null
}

function parseQuery(raw: Record<string, unknown>): { q: string; type: SearchKind | null; course: string | null } {
  const q = typeof raw.q === 'string' ? normalizeSearchText(raw.q) : ''
  if ([...q].length > SEARCH_QUERY_MAX) throw invalid({ q: 'too_long' })
  let type: SearchKind | null = null
  if (raw.type !== undefined && raw.type !== '') {
    if (typeof raw.type !== 'string' || !(SEARCH_KINDS as readonly string[]).includes(raw.type)) throw invalid({ type: 'invalid' })
    type = raw.type as SearchKind
  }
  let course: string | null = null
  if (raw.course !== undefined && raw.course !== '') {
    if (!isUuid(raw.course)) throw invalid({ course: 'invalid' })
    course = raw.course.toLowerCase()
  }
  return { q, type, course }
}

const matchSql = (q: string) =>
  sql`(${searchDocuments.searchText} like ${`%${escapeLike(q)}%`} or ${q} <% ${searchDocuments.searchText})`
const scoreSql = (q: string) => sql<number>`word_similarity(${q}, ${searchDocuments.searchText})`

async function courseLabels(db: DbExecutor, ids: readonly string[]): Promise<Map<string, SearchResultDto['course']>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select({ id: courses.id, mergedInto: courses.mergedInto })
    .from(courses)
    .where(inArray(courses.id, unique))
  const canonicalIds = [...new Set(rows.map((r) => r.mergedInto ?? r.id))]
  const canonical = await db
    .select({ id: courses.id, title: courses.title, schoolName: schools.name })
    .from(courses)
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(inArray(courses.id, canonicalIds))
  const byId = new Map(canonical.map((c) => [c.id, c]))
  return new Map(rows.map((r) => [r.id, byId.get(r.mergedInto ?? r.id) ?? null]))
}

async function searchReleases(db: DbExecutor, query: SearchQuery, kinds: Array<'case' | 'stuck'>, now: Date): Promise<SearchResultDto[]> {
  const rows = await db
    .select({
      kind: searchDocuments.kind,
      itemKey: searchDocuments.itemKey,
      title: searchDocuments.title,
      snippet: searchDocuments.snippet,
      slug: publications.slug,
      courseId: publicationCandidates.courseId,
      score: scoreSql(query.q),
    })
    .from(searchDocuments)
    .innerJoin(publications, eq(publications.id, searchDocuments.publicationId))
    // 문서를 만든 release가 지금 release일 때만(대체·철회된 release의 문서는 조인에서 빠짐).
    .innerJoin(
      publicationCandidates,
      and(eq(publicationCandidates.id, searchDocuments.releaseId), eq(publicationCandidates.id, publications.currentReleaseId)),
    )
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .where(
      and(
        inArray(searchDocuments.kind, kinds),
        servableReleaseSql(now),
        // 운영 조치로 가린 막힘 카드는 문서가 남아 있어도 나오지 않습니다(T-15, 같은 쿼리에서 확인).
        sql`not ${hiddenStuckSql()}`,
        matchSql(query.q),
        query.courseId ? sql`${publicationCandidates.courseId} in ${courseScopeSql(query.courseId)}` : undefined,
      ),
    )
    .orderBy(desc(scoreSql(query.q)), desc(publicationCandidates.publishedAt), searchDocuments.id)
    .limit(SEARCH_RESULT_LIMIT)
  const labels = await courseLabels(db, rows.map((r) => r.courseId).filter((id): id is string => !!id))
  return rows.map((r) => ({
    kind: r.kind,
    title: r.title,
    snippet: r.snippet,
    path: r.kind === 'stuck' && r.itemKey ? publicStuckPath(r.slug, r.itemKey) : publicCasePath(r.slug),
    course: r.courseId ? (labels.get(r.courseId) ?? null) : null,
  }))
}

async function searchNotes(db: DbExecutor, query: SearchQuery): Promise<SearchResultDto[]> {
  const rows = await db
    .select({
      noteId: seniorNotes.id,
      courseId: seniorNotes.courseId,
      title: searchDocuments.title,
      snippet: searchDocuments.snippet,
    })
    .from(searchDocuments)
    // 노트가 지금 published이고, 문서를 만든 version이 지금 version과 같을 때만.
    .innerJoin(seniorNotes, and(eq(seniorNotes.id, searchDocuments.seniorNoteId), eq(seniorNotes.version, searchDocuments.noteVersion)))
    .where(
      and(
        eq(searchDocuments.kind, 'note'),
        eq(seniorNotes.status, 'published'),
        matchSql(query.q),
        query.courseId ? sql`${seniorNotes.courseId} in ${courseScopeSql(query.courseId)}` : undefined,
      ),
    )
    .orderBy(desc(scoreSql(query.q)), desc(seniorNotes.publishedAt), searchDocuments.id)
    .limit(SEARCH_RESULT_LIMIT)
  const labels = await courseLabels(db, rows.map((r) => r.courseId))
  return rows.map((r) => {
    const course = labels.get(r.courseId) ?? null
    return {
      kind: 'note' as const,
      title: r.title,
      snippet: r.snippet,
      path: publicNotePath(course?.id ?? r.courseId, r.noteId),
      course,
    }
  })
}

/** 막힘 Q&A(C-09): 문서가 남아 있어도 항목이 지금 published일 때만(철회·숨김은 같은 쿼리에서 빠짐). */
async function searchQa(db: DbExecutor, query: SearchQuery): Promise<SearchResultDto[]> {
  const rows = await db
    .select({ id: courseQaItems.id, courseId: courseQaItems.courseId, title: searchDocuments.title, snippet: searchDocuments.snippet })
    .from(searchDocuments)
    .innerJoin(courseQaItems, eq(courseQaItems.id, searchDocuments.courseQaItemId))
    .where(
      and(
        eq(searchDocuments.kind, 'qa'),
        eq(courseQaItems.status, 'published'),
        matchSql(query.q),
        query.courseId ? sql`${courseQaItems.courseId} in ${courseScopeSql(query.courseId)}` : undefined,
      ),
    )
    .orderBy(desc(scoreSql(query.q)), desc(courseQaItems.publishedAt), searchDocuments.id)
    .limit(SEARCH_RESULT_LIMIT)
  const labels = await courseLabels(db, rows.map((r) => r.courseId))
  return rows.map((r) => {
    const course = labels.get(r.courseId) ?? null
    return { kind: 'qa' as const, title: r.title, snippet: r.snippet, path: publicQaPath(course?.id ?? r.courseId, r.id), course }
  })
}

/** GET /public/search — 검색어가 비면 빈 결과. 형식 오류 422(q too_long, type·course invalid). 없는 과목이면 빈 결과. */
export async function searchPublic(db: DbExecutor, rawQuery: Record<string, unknown>, now = new Date()): Promise<PublicSearchDto> {
  const parsed = parseQuery(rawQuery)
  let courseId: string | null = null
  if (parsed.course) {
    try {
      courseId = (await loadCanonicalCourse(db, parsed.course)).id
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'NOT_FOUND') return { q: parsed.q, type: parsed.type, courseId: null, results: [] }
      throw error
    }
  }
  const query: SearchQuery = { q: parsed.q, type: parsed.type, courseId }
  if (!query.q) return { q: query.q, type: query.type, courseId, results: [] }
  const results: SearchResultDto[] = []
  const releaseKinds = (['case', 'stuck'] as const).filter((k) => !query.type || query.type === k)
  if (releaseKinds.length > 0) results.push(...(await searchReleases(db, query, [...releaseKinds], now)))
  if (!query.type || query.type === 'note') results.push(...(await searchNotes(db, query)))
  if (!query.type || query.type === 'qa') results.push(...(await searchQa(db, query)))
  return { q: query.q, type: query.type, courseId, results }
}
