/**
 * 학교·과목·개설 학기 검색과 만들기 (T-10, PROOFU_EVOLUTION_PLAN §8.1–§8.6, SYSTEM_DESIGN §6.2, §11.1, ADR 0010).
 *
 * - 이름은 학생이 입력합니다("학생 작성"). 공식 인증 의미가 없고, 교수 실명·평가 필드는 받지 않습니다.
 * - 검색: 정규화 키(labelKey)의 부분 일치 + pg_trgm 유사도. 병합된 행은 결과에 나오지 않고, 병합된 이름으로 찾아도 정본이 나옵니다.
 * - 만들기: 같은 키의 정본이 있으면 409 already_exists(후보), 비슷한 이름(유사도 ≥ 0.6)이나 같은 학교의 같은 과목 코드가 있으면
 *   `confirmNew: true` 없이는 409 similar_exists(후보). 만들기는 사용자별 한도(catalog_create)를 씁니다.
 * - 개설 학기: (과목, 연도, 학기)마다 하나. 종료 시각은 서버가 학기에서 계산하며 사용자는 정할 수 없습니다(엠바고 우회 방지).
 *   운영자만 고칠 수 있습니다(감사 기록).
 */
import { z } from 'zod'
import {
  CATALOG_SEARCH_LIMIT,
  CATALOG_SIMILARITY_THRESHOLD,
  COURSE_CODE_MAX,
  COURSE_TITLE_MAX,
  SCHOOL_NAME_MAX,
  SEMESTERS,
  codeKey,
  isAllowedTermYear,
  labelKey,
  normalizeLabel,
  semesterEndsAt,
} from '@peerchive/domain'
import {
  and,
  asc,
  courseTerms,
  courses,
  desc,
  eq,
  isNull,
  or,
  projects,
  schools,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound, rateLimited, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import type { RateLimitRule } from '../security/rate-limit'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { requireOperator } from './operators'
import type {
  CatalogCandidateDto,
  CourseDto,
  CourseTermDto,
  CourseTermResultDto,
  SchoolDto,
} from '../../../shared/types/api'

/** 학교·과목·학기·개념 태그를 새로 만드는 횟수(사용자별, 시간당). 검색과 이미 있는 항목 선택은 세지 않습니다. */
export const CATALOG_CREATE_RATE_LIMIT: RateLimitRule = { limit: 20, windowMs: 60 * 60 * 1000 }

export type SchoolRow = typeof schools.$inferSelect
export type CourseRow = typeof courses.$inferSelect
export type CourseTermRow = typeof courseTerms.$inferSelect

export const toSchoolDto = (row: Pick<SchoolRow, 'id' | 'name'>): SchoolDto => ({ id: row.id, name: row.name })
export const toCourseDto = (row: Pick<CourseRow, 'id' | 'schoolId' | 'title' | 'code'>): CourseDto => ({
  id: row.id,
  schoolId: row.schoolId,
  title: row.title,
  code: row.code,
})
export const toCourseTermDto = (row: CourseTermRow): CourseTermDto => ({
  id: row.id,
  courseId: row.courseId,
  year: row.year,
  semester: row.semester,
  endsAt: row.endsAt.toISOString(),
})

/** 사용자별 생성 한도. 넘으면 429. */
export async function consumeCatalogCreate(db: DbExecutor, actor: Actor, now: Date): Promise<void> {
  if (!(await hitRateLimit(db, 'catalog_create', actor.userId, CATALOG_CREATE_RATE_LIMIT, now))) throw rateLimited()
}

const searchQuery = (q: unknown): string => (typeof q === 'string' ? labelKey(q.slice(0, 100)) : '')

/**
 * 부분 일치(정규화 키) 또는 trigram 유사도(`%` 연산자, pg_trgm 기본 임계값 0.3 = CATALOG_SEARCH_SIMILARITY, GIN 인덱스 사용).
 * 키에는 글자·숫자·+·#만 남으므로 LIKE 와일드카드가 섞이지 않습니다.
 */
const matches = (column: unknown, key: string) => sql`(${column} like ${`%${key}%`} or ${column} % ${key})`

/** 비슷한 이름(유사도 ≥ 0.6). `%`로 인덱스를 먼저 쓰고 similarity로 좁힙니다. */
const similarEnough = (column: unknown, key: string) =>
  sql`(${column} % ${key} and similarity(${column}, ${key}) >= ${CATALOG_SIMILARITY_THRESHOLD})`

// ── 정본 따라가기 ──

/** 병합은 평탄화하므로 merged_into를 한 번만 따라가면 정본입니다. */
export async function loadCanonicalSchool(db: DbExecutor, schoolId: unknown): Promise<SchoolRow> {
  if (!isUuid(schoolId)) throw notFound()
  const [row] = await db.select().from(schools).where(eq(schools.id, schoolId)).limit(1)
  if (!row) throw notFound()
  if (!row.mergedInto) return row
  const [canonical] = await db.select().from(schools).where(eq(schools.id, row.mergedInto)).limit(1)
  if (!canonical) throw notFound()
  return canonical
}

export async function loadCanonicalCourse(db: DbExecutor, courseId: unknown): Promise<CourseRow> {
  if (!isUuid(courseId)) throw notFound()
  const [row] = await db.select().from(courses).where(eq(courses.id, courseId)).limit(1)
  if (!row) throw notFound()
  if (!row.mergedInto) return row
  const [canonical] = await db.select().from(courses).where(eq(courses.id, row.mergedInto)).limit(1)
  if (!canonical) throw notFound()
  return canonical
}

/** 개설 학기(병합된 학기면 정본). 없으면 null. */
export async function loadCanonicalTerm(db: DbExecutor, termId: string): Promise<CourseTermRow | null> {
  const [row] = await db.select().from(courseTerms).where(eq(courseTerms.id, termId)).limit(1)
  if (!row?.mergedInto) return row ?? null
  const [canonical] = await db.select().from(courseTerms).where(eq(courseTerms.id, row.mergedInto)).limit(1)
  return canonical ?? null
}

// ── 학교 ──

const schoolName = z
  .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
  .transform(normalizeLabel)
  .pipe(z.string().min(2, { error: 'too_short' }).max(SCHOOL_NAME_MAX, { error: 'too_long' }))

export const createSchoolSchema = z.object({
  name: schoolName,
  /** 비슷한 이름이 있다는 안내를 보고도 새로 만들 때. 같은 이름(정규화 키)이면 그래도 409입니다. */
  confirmNew: z.boolean({ error: 'invalid' }).default(false),
})

/** GET /schools?q= — 정본 학교만, 최대 20개. 빈 검색어면 빈 목록. */
export async function searchSchools(db: DbExecutor, q: unknown): Promise<SchoolDto[]> {
  const key = searchQuery(q)
  if (!key) return []
  const aliasMatch = sql`exists (select 1 from schools m where m.merged_into = ${schools.id}
    and (m.name_key like ${`%${key}%`} or m.name_key % ${key}))`
  const score = sql<number>`greatest(similarity(${schools.nameKey}, ${key}),
    coalesce((select max(similarity(m.name_key, ${key})) from schools m where m.merged_into = ${schools.id}), 0))`
  const rows = await db
    .select({ id: schools.id, name: schools.name })
    .from(schools)
    .where(and(isNull(schools.mergedInto), or(matches(schools.nameKey, key), aliasMatch)))
    .orderBy(sql`(${schools.nameKey} = ${key}) desc`, desc(score), asc(schools.name), asc(schools.id))
    .limit(CATALOG_SEARCH_LIMIT)
  return rows.map(toSchoolDto)
}

async function similarSchools(db: DbExecutor, key: string): Promise<Array<CatalogCandidateDto & { exact: boolean }>> {
  const score = sql<number>`similarity(${schools.nameKey}, ${key})`
  const rows = await db
    .select({ id: schools.id, name: schools.name, nameKey: schools.nameKey })
    .from(schools)
    .where(and(isNull(schools.mergedInto), or(eq(schools.nameKey, key), similarEnough(schools.nameKey, key))))
    .orderBy(sql`(${schools.nameKey} = ${key}) desc`, desc(score), asc(schools.name))
    .limit(5)
  return rows.map((row) => ({ id: row.id, name: row.name, exact: row.nameKey === key }))
}

const candidatesOf = (rows: ReadonlyArray<CatalogCandidateDto & { exact?: boolean }>): CatalogCandidateDto[] =>
  rows.map(({ id, name, code }) => (code === undefined ? { id, name } : { id, name, code }))

/** POST /schools {name, confirmNew?} — 201. 같은 이름 409 already_exists, 비슷한 이름 409 similar_exists(confirmNew 전). */
export async function createSchool(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<SchoolDto> {
  const input = parseInput(createSchoolSchema, rawInput)
  const key = labelKey(input.name)
  if (!key) throw invalid({ name: 'invalid' })
  return db.transaction(async (tx) => {
    const similar = await similarSchools(tx, key)
    const exact = similar.filter((c) => c.exact)
    if (exact.length > 0) throw conflict('already_exists', { candidates: candidatesOf(exact) })
    if (similar.length > 0 && !input.confirmNew) throw conflict('similar_exists', { candidates: candidatesOf(similar) })
    await consumeCatalogCreate(tx, actor, now)
    try {
      const row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(schools)
          .values({ name: input.name, nameKey: key, createdBy: actor.userId })
          .returning()
        return inserted
      })
      if (!row) throw new Error('school insert failed')
      await recordAudit(tx, { actorId: actor.userId, action: 'school.create', targetType: 'school', targetId: row.id })
      return toSchoolDto(row)
    } catch (error) {
      // 동시에 같은 이름을 만든 경우(정본 name_key 부분 unique).
      if (sqlState(error) === '23505') {
        throw conflict('already_exists', { candidates: candidatesOf((await similarSchools(tx, key)).filter((c) => c.exact)) })
      }
      throw error
    }
  })
}

// ── 과목 ──

const courseTitle = z
  .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
  .transform(normalizeLabel)
  .pipe(z.string().min(1, { error: 'required' }).max(COURSE_TITLE_MAX, { error: 'too_long' }))

export const createCourseSchema = z.object({
  title: courseTitle,
  code: z
    .string({ error: 'invalid' })
    .transform(normalizeLabel)
    .pipe(z.string().max(COURSE_CODE_MAX, { error: 'too_long' }))
    .nullish()
    .transform((value) => (value ? value : null)),
  confirmNew: z.boolean({ error: 'invalid' }).default(false),
})

/** GET /schools/:id/courses?q= — 정본 학교(병합된 학교면 따라감)의 정본 과목, 최대 20개. 검색어가 없으면 이름순. */
export async function searchCourses(db: DbExecutor, schoolId: unknown, q: unknown): Promise<CourseDto[]> {
  const school = await loadCanonicalSchool(db, schoolId)
  const key = searchQuery(q)
  const base = and(eq(courses.schoolId, school.id), isNull(courses.mergedInto))
  const columns = { id: courses.id, schoolId: courses.schoolId, title: courses.title, code: courses.code }
  if (!key) {
    const rows = await db.select(columns).from(courses).where(base).orderBy(asc(courses.title), asc(courses.id)).limit(CATALOG_SEARCH_LIMIT)
    return rows.map(toCourseDto)
  }
  const codeMatch = sql`${courses.codeKey} like ${`%${key.toUpperCase()}%`}`
  const aliasMatch = sql`exists (select 1 from courses m where m.merged_into = ${courses.id}
    and (m.title_key like ${`%${key}%`} or m.title_key % ${key}))`
  const score = sql<number>`greatest(similarity(${courses.titleKey}, ${key}),
    coalesce((select max(similarity(m.title_key, ${key})) from courses m where m.merged_into = ${courses.id}), 0))`
  const rows = await db
    .select(columns)
    .from(courses)
    .where(and(base, or(matches(courses.titleKey, key), codeMatch, aliasMatch)))
    .orderBy(sql`(${courses.titleKey} = ${key}) desc`, desc(score), asc(courses.title), asc(courses.id))
    .limit(CATALOG_SEARCH_LIMIT)
  return rows.map(toCourseDto)
}

/** POST /schools/:id/courses {title, code?, confirmNew?} — 201. 같은 이름 409 already_exists, 비슷한 이름·같은 코드 409 similar_exists. */
export async function createCourse(
  db: DbExecutor,
  actor: Actor,
  schoolId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<CourseDto> {
  const input = parseInput(createCourseSchema, rawInput)
  const key = labelKey(input.title)
  if (!key) throw invalid({ title: 'invalid' })
  const code = codeKey(input.code)
  return db.transaction(async (tx) => {
    const school = await loadCanonicalSchool(tx, schoolId)
    // 같은 학교의 과목 만들기를 직렬화합니다(학교 병합으로 같은 이름이 모일 수 있어 DB unique 대신 확인).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`catalog-course:${school.id}`}))`)
    const score = sql<number>`similarity(${courses.titleKey}, ${key})`
    const similar = await tx
      .select({ id: courses.id, title: courses.title, code: courses.code, titleKey: courses.titleKey })
      .from(courses)
      .where(
        and(
          eq(courses.schoolId, school.id),
          isNull(courses.mergedInto),
          or(
            eq(courses.titleKey, key),
            similarEnough(courses.titleKey, key),
            code ? eq(courses.codeKey, code) : sql`false`,
          ),
        ),
      )
      .orderBy(sql`(${courses.titleKey} = ${key}) desc`, desc(score), asc(courses.title))
      .limit(5)
    const asCandidate = (row: (typeof similar)[number]) => ({ id: row.id, name: row.title, code: row.code })
    const exact = similar.filter((row) => row.titleKey === key)
    if (exact.length > 0) throw conflict('already_exists', { candidates: exact.map(asCandidate) })
    if (similar.length > 0 && !input.confirmNew) throw conflict('similar_exists', { candidates: similar.map(asCandidate) })
    await consumeCatalogCreate(tx, actor, now)
    const [row] = await tx
      .insert(courses)
      .values({ schoolId: school.id, title: input.title, titleKey: key, code: input.code, codeKey: code, createdBy: actor.userId })
      .returning()
    if (!row) throw new Error('course insert failed')
    await recordAudit(tx, { actorId: actor.userId, action: 'course.create', targetType: 'course', targetId: row.id })
    return toCourseDto(row)
  })
}

// ── 개설 학기 ──

export const createTermSchema = z.object({
  year: z
    .number({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
    .int({ error: 'invalid' }),
  semester: z.enum(SEMESTERS, { error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }),
})

const SEMESTER_ORDER = sql`case ${courseTerms.semester} when 'winter' then 4 when 'fall' then 3 when 'summer' then 2 else 1 end`

/** GET /courses/:id/terms — 정본 과목의 정본 학기(최근순). */
export async function listCourseTerms(db: DbExecutor, courseId: unknown): Promise<CourseTermDto[]> {
  const course = await loadCanonicalCourse(db, courseId)
  const rows = await db
    .select()
    .from(courseTerms)
    .where(and(eq(courseTerms.courseId, course.id), isNull(courseTerms.mergedInto)))
    .orderBy(desc(courseTerms.year), desc(SEMESTER_ORDER))
    .limit(100)
  return rows.map(toCourseTermDto)
}

/**
 * POST /courses/:id/terms {year, semester} — 새로 만들면 201, 이미 있으면 그 학기(200, created=false).
 * 종료 시각(endsAt)은 받지 않습니다: 보내면 422 `{endsAt: 'not_allowed'}`.
 */
export async function createCourseTerm(
  db: DbExecutor,
  actor: Actor,
  courseId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<CourseTermResultDto> {
  const raw = (rawInput ?? {}) as Record<string, unknown>
  if (typeof raw === 'object' && raw !== null && ('endsAt' in raw || 'ends_at' in raw)) throw invalid({ endsAt: 'not_allowed' })
  const input = parseInput(createTermSchema, rawInput)
  if (!isAllowedTermYear(input.year, now)) throw invalid({ year: 'out_of_range' })
  return db.transaction(async (tx) => {
    const course = await loadCanonicalCourse(tx, courseId)
    const findExisting = async () => {
      const [row] = await tx
        .select()
        .from(courseTerms)
        .where(and(eq(courseTerms.courseId, course.id), eq(courseTerms.year, input.year), eq(courseTerms.semester, input.semester)))
        .limit(1)
      // 정본 과목의 학기는 병합되지 않습니다(병합된 학기는 원본 과목에 남음).
      return row ?? null
    }
    const existing = await findExisting()
    if (existing) return { term: toCourseTermDto(existing), created: false }

    await consumeCatalogCreate(tx, actor, now)
    const [inserted] = await tx
      .insert(courseTerms)
      .values({
        courseId: course.id,
        year: input.year,
        semester: input.semester,
        endsAt: semesterEndsAt(input.year, input.semester),
        createdBy: actor.userId,
      })
      .onConflictDoNothing({ target: [courseTerms.courseId, courseTerms.year, courseTerms.semester] })
      .returning()
    if (!inserted) {
      const raced = await findExisting()
      if (!raced) throw new Error('course term insert failed')
      return { term: toCourseTermDto(raced), created: false }
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'course_term.create',
      targetType: 'course_term',
      targetId: inserted.id,
      metadata: { endsAt: inserted.endsAt.toISOString() },
    })
    return { term: toCourseTermDto(inserted), created: true }
  })
}

export const adjustTermSchema = z.object({
  endsAt: z.iso.datetime({ offset: true, error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }),
  reason: z
    .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
    .trim()
    .min(1, { error: 'required' })
    .max(500, { error: 'too_long' }),
})

/**
 * PATCH /course-terms/:id {endsAt, reason} — 운영자만(아니면 403). 학교 일정에 맞춰 종료 시각을 고칩니다(감사 기록).
 * 늘리면 지금 연결된 프로젝트의 embargo_until도 같은 트랜잭션에서 올립니다(단조 규칙).
 * 줄여도 이미 연결된 프로젝트의 embargo_until은 줄지 않습니다. 필요하면 프로젝트별로 운영자가 낮춥니다.
 */
export async function adjustCourseTermEndsAt(
  db: DbExecutor,
  actor: Actor,
  termId: unknown,
  rawInput: unknown,
): Promise<CourseTermDto> {
  await requireOperator(db, actor)
  const input = parseInput(adjustTermSchema, rawInput)
  if (!isUuid(termId)) throw notFound()
  return db.transaction(async (tx) => {
    const [term] = await tx.select().from(courseTerms).where(eq(courseTerms.id, termId)).limit(1).for('update')
    if (!term) throw notFound()
    if (term.mergedInto) throw conflict('term_merged')
    const endsAt = new Date(input.endsAt)
    const [updated] = await tx.update(courseTerms).set({ endsAt }).where(eq(courseTerms.id, term.id)).returning()
    if (!updated) throw notFound()
    let projectsRaised = 0
    if (endsAt.getTime() > term.endsAt.getTime()) {
      const raised = await tx
        .update(projects)
        .set({ embargoUntil: sql`greatest(${projects.embargoUntil}, ${endsAt.toISOString()}::timestamptz)` })
        .where(eq(projects.courseTermId, term.id))
        .returning({ id: projects.id })
      projectsRaised = raised.length
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'course_term.adjust_ends_at',
      targetType: 'course_term',
      targetId: term.id,
      metadata: { from: term.endsAt.toISOString(), to: endsAt.toISOString(), reason: input.reason, projectsRaised },
    })
    return toCourseTermDto(updated)
  })
}
