/**
 * 이번 학기 과목 등록 (E-01, PROOFU_EVOLUTION_PLAN §8.7, DELIVERY_PLAN §4.4 E-01, ADR 0046).
 *
 * - 등록은 학교·과목 검색(T-10 카탈로그)으로 고른 **이미 있는 과목**만 받습니다(크롤링·계정 연동 없음). 병합된 과목 id면 정본으로 등록합니다.
 *   학기는 지금 학기·다음 학기만(@peerchive/domain registrableTerms, 아니면 422 `term: not_registrable`). 그 학기의 개설 학기 행이 없으면
 *   카탈로그 규칙 그대로 만듭니다(`ensureCourseTermUnattributed`: 종료 시각은 서버 계산, 만든 사람·감사 actor는 남기지 않음).
 * - 같은 (사용자, 개설 학기)는 하나(409 `already_registered`), 학기당 15개(409 `limit_reached`), 사용자별 시간당 60회(429).
 * - **본인만 봅니다**: 목록·지우기·알림 닫기 모두 본인 행만(남의 id는 404). 공개 프로필·검색·페르소나·피드·추천·운영자 경로는 이 모듈을 import하지
 *   않습니다(S-02 경계 테스트). 감사 기록·분석 이벤트도 남기지 않습니다(운영자가 사람별 등록을 볼 길을 만들지 않음).
 * - 과제 공간 만들기 미리 채우기: `POST /projects {courseRegistrationId}`가 이 모듈의 `registrationTermForProject`로 등록의 개설 학기를 찾아
 *   기존 과제 만들기(학기 연결 + 엠바고 단조 규칙)에 넘깁니다.
 * - 학기가 끝나면 worker(`course-term-prompts`)가 등록마다 한 번 `post_term_prompted_at`을 채우고, 홈이 "선배 노트를 남겨 주세요"·"공개할까요?"를
 *   보여 줍니다. 본인이 닫으면 `prompt_dismissed_at`.
 */
import { z } from 'zod'
import {
  COURSE_REGISTRATION_TERM_LIMIT,
  SEMESTERS,
  isRegistrableTerm,
  registrableTerms,
  registrationPhase,
  termRefLabel,
} from '@peerchive/domain'
import {
  and,
  asc,
  courseRegistrations,
  courseTerms,
  courses,
  desc,
  eq,
  inArray,
  ne,
  projectMembers,
  projects,
  schools,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { ensureCourseTermUnattributed, loadCanonicalCourse, loadCanonicalTerm, toCourseDto, toCourseTermDto, toSchoolDto } from '../catalog/catalog'
import { type Actor, conflict, invalid, notFound, rateLimited, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { createProject } from '../projects/projects'
import type { RateLimitRule } from '../security/rate-limit'
import { hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import type { CourseRegistrationDto, MyCourseRegistrationsDto, ProjectDetailDto } from '../../../shared/types/api'

/** 등록·지우기 횟수(사용자별, 시간당). */
export const COURSE_REGISTRATION_RATE_LIMIT: RateLimitRule = { limit: 60, windowMs: 60 * 60 * 1000 }

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const registerCourseSchema = z.object({
  courseId: z.uuid({ error: requiredOr('invalid') }).transform((v) => v.toLowerCase()),
  year: z.number({ error: requiredOr('invalid') }).int({ error: 'invalid' }),
  semester: z.enum(SEMESTERS, { error: requiredOr('invalid') }),
})

type RegistrationRow = typeof courseRegistrations.$inferSelect

async function consume(db: DbExecutor, actor: Actor, now: Date) {
  if (!(await hitRateLimit(db, 'course_registration', actor.userId, COURSE_REGISTRATION_RATE_LIMIT, now))) throw rateLimited()
}

/** 등록 행들을 DTO로(정본 학기·과목·학교 + 이 학기에 연결된 내 과제). */
async function toDtos(db: DbExecutor, actor: Actor, rows: RegistrationRow[], now: Date): Promise<CourseRegistrationDto[]> {
  if (rows.length === 0) return []
  const out: CourseRegistrationDto[] = []
  const termIds = new Set<string>()
  const resolved: Array<{ row: RegistrationRow; term: typeof courseTerms.$inferSelect }> = []
  for (const row of rows) {
    const term = await loadCanonicalTerm(db, row.courseTermId)
    if (!term) continue
    termIds.add(term.id)
    resolved.push({ row, term })
  }
  const courseRows = await db
    .select({ course: courses, school: schools })
    .from(courses)
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(inArray(courses.id, [...new Set(resolved.map((r) => r.term.courseId))]))
  const courseById = new Map(courseRows.map((r) => [r.course.id, r]))
  const mine = termIds.size
    ? await db
        .select({ id: projects.id, title: projects.title, courseTermId: projects.courseTermId })
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(
          and(
            eq(projectMembers.userId, actor.userId),
            eq(projectMembers.status, 'active'),
            ne(projects.kind, 'study'),
            inArray(projects.courseTermId, [...termIds]),
          ),
        )
        .orderBy(desc(projects.updatedAt))
    : []
  for (const { row, term } of resolved) {
    const c = courseById.get(term.courseId)
    if (!c) continue
    out.push({
      id: row.id,
      school: toSchoolDto(c.school),
      course: toCourseDto(c.course),
      term: toCourseTermDto(term),
      termLabel: termRefLabel(term),
      phase: registrationPhase(term, now),
      postTermPrompt: row.postTermPromptedAt !== null && row.promptDismissedAt === null,
      myProjects: mine.filter((p) => p.courseTermId === term.id).map((p) => ({ id: p.id, title: p.title })),
      createdAt: row.createdAt.toISOString(),
    })
  }
  return out
}

async function myRegistrationOr404(db: DbExecutor, actor: Actor, rawId: unknown, lock = false): Promise<RegistrationRow> {
  if (!isUuid(rawId)) throw notFound()
  const q = db
    .select()
    .from(courseRegistrations)
    .where(and(eq(courseRegistrations.id, rawId.toLowerCase()), eq(courseRegistrations.userId, actor.userId)))
    .limit(1)
  const [row] = lock ? await q.for('update') : await q
  if (!row) throw notFound()
  return row
}

const PHASE_ORDER = { current: 0, upcoming: 1, ended: 2 } as const

/** GET /me/course-registrations — 내 등록(지금 → 다음 → 끝난 학기, 같은 단계는 과목 이름순)과 등록할 수 있는 학기. */
export async function listMyCourseRegistrations(db: DbExecutor, actor: Actor, now = new Date()): Promise<MyCourseRegistrationsDto> {
  const rows = await db
    .select()
    .from(courseRegistrations)
    .where(eq(courseRegistrations.userId, actor.userId))
    .orderBy(asc(courseRegistrations.createdAt), asc(courseRegistrations.id))
    .limit(200)
  const items = (await toDtos(db, actor, rows, now)).sort(
    (a, b) =>
      PHASE_ORDER[a.phase] - PHASE_ORDER[b.phase] ||
      b.term.endsAt.localeCompare(a.term.endsAt) ||
      a.course.title.localeCompare(b.course.title, 'ko') ||
      a.id.localeCompare(b.id),
  )
  const [current, next] = registrableTerms(now)
  return {
    items,
    registrableTerms: [
      { ...current, label: termRefLabel(current), current: true },
      { ...next, label: termRefLabel(next), current: false },
    ],
  }
}

/**
 * POST /me/course-registrations {courseId, year, semester} — 201 + 등록.
 * 422: 형식·`term: not_registrable`(지금·다음 학기가 아님)·`courseId: not_found`(카탈로그에 없는 과목). 409 `already_registered`·`limit_reached`. 429.
 */
export async function registerCourse(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<CourseRegistrationDto> {
  const input = parseInput(registerCourseSchema, rawInput)
  if (!isRegistrableTerm(input, now)) throw invalid({ term: 'not_registrable' })
  return db.transaction(async (tx) => {
    const course = await loadCanonicalCourse(tx, input.courseId).catch(() => {
      throw invalid({ courseId: 'not_found' })
    })
    await consume(tx, actor, now)
    // 개설 학기는 카탈로그 규칙으로 찾거나 만듭니다(정본 과목의 학기라 병합되지 않은 행). 만든 사람은 남기지 않습니다(운영자에게 등록이 드러나지 않게).
    const term = await ensureCourseTermUnattributed(tx, course.id, { year: input.year, semester: input.semester })
    // 같은 사람의 등록을 직렬화해 학기당 한도를 지킵니다.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`course-registration:${actor.userId}`}))`)
    const [existing] = await tx
      .select({ id: courseRegistrations.id })
      .from(courseRegistrations)
      .where(and(eq(courseRegistrations.userId, actor.userId), eq(courseRegistrations.courseTermId, term.id)))
      .limit(1)
    if (existing) throw conflict('already_registered')
    const [counted] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from ${courseRegistrations} r
      join ${courseTerms} ct on ct.id = r.course_term_id
      where r.user_id = ${actor.userId} and ct.year = ${input.year} and ct.semester = ${input.semester}`)
    if (Number(counted?.n ?? 0) >= COURSE_REGISTRATION_TERM_LIMIT) throw conflict('limit_reached')
    let row: RegistrationRow | undefined
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp.insert(courseRegistrations).values({ userId: actor.userId, courseTermId: term.id, createdAt: now }).returning()
        return inserted
      })
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('already_registered')
      throw error
    }
    if (!row) throw new Error('course registration insert failed')
    const [dto] = await toDtos(tx, actor, [row], now)
    if (!dto) throw new Error('course registration dto failed')
    return dto
  })
}

/** DELETE /me/course-registrations/:id — 내 등록 지우기(남의 것·없는 id 404). 행을 바로 지웁니다(기록 없음). */
export async function removeCourseRegistration(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<{ removed: true }> {
  return db.transaction(async (tx) => {
    const row = await myRegistrationOr404(tx, actor, rawId, true)
    await consume(tx, actor, now)
    await tx.delete(courseRegistrations).where(eq(courseRegistrations.id, row.id))
    return { removed: true as const }
  })
}

/** POST /me/course-registrations/:id/dismiss-prompt — 학기 종료 알림 닫기(멱등). 알림이 아직 없으면 409 `no_prompt`. */
export async function dismissRegistrationPrompt(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<CourseRegistrationDto> {
  return db.transaction(async (tx) => {
    const row = await myRegistrationOr404(tx, actor, rawId, true)
    if (!row.postTermPromptedAt) throw conflict('no_prompt')
    const [updated] = row.promptDismissedAt
      ? [row]
      : await tx.update(courseRegistrations).set({ promptDismissedAt: now }).where(eq(courseRegistrations.id, row.id)).returning()
    const [dto] = await toDtos(tx, actor, [updated!], now)
    if (!dto) throw notFound()
    return dto
  })
}

/**
 * 과제 공간 만들기의 `courseRegistrationId`(E-01) → 그 등록의 정본 개설 학기 id. 내 등록이 아니거나 없으면 422 `courseRegistrationId: not_found`
 * (남의 등록이 있는지 드러내지 않음). 학기 연결·엠바고는 기존 과제 만들기 규칙(T-10)이 그대로 정합니다.
 */
export async function registrationTermForProject(db: DbExecutor, actor: Actor, registrationId: string): Promise<string> {
  const [row] = await db
    .select({ courseTermId: courseRegistrations.courseTermId })
    .from(courseRegistrations)
    .where(and(eq(courseRegistrations.id, registrationId.toLowerCase()), eq(courseRegistrations.userId, actor.userId)))
    .limit(1)
  if (!row) throw invalid({ courseRegistrationId: 'not_found' })
  const term = await loadCanonicalTerm(db, row.courseTermId)
  if (!term) throw invalid({ courseRegistrationId: 'not_found' })
  return term.id
}

const fromRegistrationSchema = z.object({
  courseRegistrationId: z.uuid({ error: requiredOr('invalid') }),
})

/**
 * POST /projects {courseRegistrationId, title, kind, …} — 등록한 과목에서 과제 공간 만들기(E-01). 등록의 개설 학기로 기존 과제 만들기(`createProject`)를
 * 부르므로 과목·학기 연결과 엠바고(학기 종료까지, 단조 규칙)가 같은 규칙으로 채워집니다. `courseTermId`를 함께 보내면 422 `courseTermId: not_allowed`.
 */
export async function createProjectFromRegistration(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<ProjectDetailDto> {
  const { courseRegistrationId } = parseInput(fromRegistrationSchema, rawInput)
  if ((rawInput as Record<string, unknown>).courseTermId != null) throw invalid({ courseTermId: 'not_allowed' })
  return db.transaction(async (tx) => {
    const courseTermId = await registrationTermForProject(tx, actor, courseRegistrationId)
    const rest = { ...(rawInput as Record<string, unknown>) }
    delete rest.courseRegistrationId
    return createProject(tx, actor, { ...rest, courseTermId }, now)
  })
}
