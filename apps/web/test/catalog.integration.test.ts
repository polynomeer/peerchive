/**
 * T-10 서비스 통합 테스트(실제 PostgreSQL): 학교·과목·학기·개념 태그·운영자 병합·엠바고.
 * DATABASE_URL이 없으면 건너뜁니다. 개발 DB에 남은 행과 겹치지 않도록 이름·검색어에 무작위 토큰을 씁니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { semesterEndsAt } from '@peerchive/domain'
import {
  and,
  auditEvents,
  conceptTags,
  courseConceptTags,
  courseTerms,
  courses,
  embargoes,
  eq,
  operators,
  projects,
  schools,
  type DbExecutor,
} from '@peerchive/db'
import {
  CATALOG_CREATE_RATE_LIMIT,
  adjustCourseTermEndsAt,
  createCourse,
  createCourseTerm,
  createSchool,
  listCourseTerms,
  searchCourses,
  searchSchools,
} from '../server/modules/catalog/catalog'
import { mergeConceptTag, mergeCourse, mergeSchool } from '../server/modules/catalog/merge'
import { isOperator } from '../server/modules/catalog/operators'
import { addCourseTag, listCourseTags, searchConceptTags } from '../server/modules/catalog/tags'
import {
  addCourseTermEmbargo,
  addProjectEmbargo,
  assertPublishable,
  getProjectEmbargo,
  lowerProjectEmbargo,
} from '../server/modules/embargo/embargo'
import { createInvitation, acceptInvitation } from '../server/modules/projects/invitations'
import { createProject, getProject, updateProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z') // 2026년 2학기 진행 중
const FALL_2026_END = semesterEndsAt(2026, 'fall')
/** 개발 DB의 다른 행과 겹치지 않는 토큰(글자만, 정규화 키에 그대로 남음). */
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(0x61 + (b % 26))).join('')

async function operator(db: DbExecutor) {
  const user = await createUser(db)
  await db.insert(operators).values({ userId: user.id })
  return { userId: user.id }
}

async function student(db: DbExecutor) {
  const user = await createUser(db)
  return { userId: user.id }
}

/** 학교 하나와 그 학교의 과목 하나, 2026 2학기. */
async function setup(db: DbExecutor) {
  const actor = await student(db)
  const t = token()
  const school = await createSchool(db, actor, { name: `${t}대학교` }, T0)
  const course = await createCourse(db, actor, school.id, { title: `운영체제 ${t}`, code: `CSE-${t}` }, T0)
  const { term } = await createCourseTerm(db, actor, course.id, { year: 2026, semester: 'fall' }, T0)
  return { actor, t, school, course, term }
}

describe.skipIf(!databaseUrl)('catalog, merges and embargo (PostgreSQL)', () => {
  afterAll(closeTestDb)

  describe('schools and courses', () => {
    it('normalizes names, detects exact and similar names, and creates with confirmNew', async () => {
      await withRollback(async (tx) => {
        const actor = await student(tx)
        const t = token()
        const school = await createSchool(tx, actor, { name: `  한빛   ${t}  대학교 ` }, T0)
        expect(school.name).toBe(`한빛 ${t} 대학교`)

        // 띄어쓰기·대소문자만 다르면 같은 이름: confirmNew여도 409 already_exists.
        const exact = await expectServiceError(
          createSchool(tx, actor, { name: `한빛${t.toUpperCase()}대학교`, confirmNew: true }, T0),
          'CONFLICT',
          'already_exists',
        )
        expect(exact.details?.candidates).toEqual([{ id: school.id, name: school.name }])

        // 비슷한 이름: 확인 전 409 similar_exists + 후보, 확인하면 만듦.
        const similar = await expectServiceError(createSchool(tx, actor, { name: `한빛${t}대학` }, T0), 'CONFLICT', 'similar_exists')
        expect(similar.details?.candidates).toEqual([{ id: school.id, name: school.name }])
        const confirmed = await createSchool(tx, actor, { name: `한빛${t}대학`, confirmNew: true }, T0)
        expect(confirmed.id).not.toBe(school.id)

        const bad = await expectServiceError(createSchool(tx, actor, { name: ' ' }, T0), 'VALIDATION')
        expect(bad.fields).toEqual({ name: 'too_short' })

        // 과목: 같은 학교의 같은 코드는 비슷한 과목으로 봅니다.
        const os = await createCourse(tx, actor, school.id, { title: `운영체제${t}`, code: 'cse 3021' }, T0)
        expect(os).toMatchObject({ title: `운영체제${t}`, code: 'cse 3021', schoolId: school.id })
        await expectServiceError(createCourse(tx, actor, school.id, { title: `운영 체제 ${t}` }, T0), 'CONFLICT', 'already_exists')
        const sameCode = await expectServiceError(
          createCourse(tx, actor, school.id, { title: `컴퓨터구조${t}`, code: 'CSE-3021' }, T0),
          'CONFLICT',
          'similar_exists',
        )
        expect(sameCode.details?.candidates).toEqual([{ id: os.id, name: os.title, code: 'cse 3021' }])
        await createCourse(tx, actor, school.id, { title: `컴퓨터구조${t}`, code: 'CSE-3021', confirmNew: true }, T0)
        // 다른 학교라면 같은 이름이어도 상관없습니다.
        await createCourse(tx, actor, confirmed.id, { title: `운영체제${t}` }, T0)
        await expectServiceError(createCourse(tx, actor, crypto.randomUUID(), { title: 'x' }, T0), 'NOT_FOUND')
      })
    })

    it('search uses partial match and trigram similarity, max 20, and hides merged rows behind the canonical one', async () => {
      await withRollback(async (tx) => {
        const actor = await student(tx)
        const op = await operator(tx)
        const t = token()
        const yonsei = await createSchool(tx, actor, { name: `연세${t}대학교` }, T0)
        const alias = await createSchool(tx, actor, { name: `${t}연대`, confirmNew: true }, T0)
        expect((await searchSchools(tx, t)).map((s) => s.id).sort()).toEqual([yonsei.id, alias.id].sort())

        await mergeSchool(tx, op, alias.id, { into: yonsei.id }, T0)
        // 병합된 이름으로 찾아도 정본만 나옵니다.
        expect(await searchSchools(tx, `${t}연대`)).toEqual([yonsei])
        expect(await searchSchools(tx, t)).toEqual([yonsei])
        expect(await searchSchools(tx, '   ')).toEqual([])

        // 과목 검색: 병합된 학교 id로 찾아도 정본 학교의 과목, 최대 20개.
        for (let i = 0; i < 22; i++) {
          await createCourse(tx, actor, yonsei.id, { title: `${t} 과목 ${String.fromCharCode(0xac00 + i * 500)}`, confirmNew: true }, new Date(T0.getTime() + i * 3_600_000))
        }
        const all = await searchCourses(tx, alias.id, '')
        expect(all).toHaveLength(20)
        expect(all.every((c) => c.schoolId === yonsei.id)).toBe(true)
        const first = all[0]!
        const second = all[1]!
        await mergeCourse(tx, op, second.id, { into: first.id }, T0)
        const afterMerge = await searchCourses(tx, yonsei.id, t)
        expect(afterMerge.map((c) => c.id)).not.toContain(second.id)
        expect(afterMerge.map((c) => c.id)).toContain(first.id)
        expect(await searchCourses(tx, yonsei.id, second.title)).toContainEqual(first)
      })
    })

    it('rate-limits creation per user (schools, courses, terms, new tags share one bucket)', async () => {
      await withRollback(async (tx) => {
        const actor = await student(tx)
        const t = token()
        const school = await createSchool(tx, actor, { name: `${t}한도대학교` }, T0)
        for (let i = 1; i < CATALOG_CREATE_RATE_LIMIT.limit; i++) {
          await createCourse(tx, actor, school.id, { title: `${t}${token()}${i}`, confirmNew: true }, T0)
        }
        await expectServiceError(createCourse(tx, actor, school.id, { title: `${t}${token()}`, confirmNew: true }, T0), 'RATE_LIMITED')
        // 검색·이미 있는 학기 선택은 한도와 무관합니다. 다른 사용자는 별도 한도입니다.
        expect(await searchSchools(tx, t)).toHaveLength(1)
        await createSchool(tx, await student(tx), { name: `${token()}다른대학교` }, T0)
        // 다음 시간 창에서는 다시 됩니다.
        await createCourse(tx, actor, school.id, { title: `${t}${token()}`, confirmNew: true }, new Date(T0.getTime() + 3_600_000))
      })
    })
  })

  describe('course terms', () => {
    it('derives ends_at from the semester, is idempotent, and rejects a user-supplied ends_at', async () => {
      await withRollback(async (tx) => {
        const { actor, course, term } = await setup(tx)
        expect(term).toMatchObject({ courseId: course.id, year: 2026, semester: 'fall', endsAt: FALL_2026_END.toISOString() })

        const again = await createCourseTerm(tx, await student(tx), course.id, { year: 2026, semester: 'fall' }, T0)
        expect(again).toEqual({ term, created: false })

        const winter = await createCourseTerm(tx, actor, course.id, { year: 2027, semester: 'winter' }, T0)
        expect(winter.term.endsAt).toBe('2028-02-29T14:59:59.999Z')

        const forged = await expectServiceError(
          createCourseTerm(tx, actor, course.id, { year: 2026, semester: 'spring', endsAt: '2026-03-01T00:00:00Z' }, T0),
          'VALIDATION',
        )
        expect(forged.fields).toEqual({ endsAt: 'not_allowed' })
        const range = await expectServiceError(createCourseTerm(tx, actor, course.id, { year: 2030, semester: 'fall' }, T0), 'VALIDATION')
        expect(range.fields).toEqual({ year: 'out_of_range' })
        const sem = await expectServiceError(createCourseTerm(tx, actor, course.id, { year: 2026, semester: 'autumn' }, T0), 'VALIDATION')
        expect(sem.fields).toEqual({ semester: 'invalid' })

        expect((await listCourseTerms(tx, course.id)).map((x) => `${x.year}-${x.semester}`)).toEqual(['2027-winter', '2026-fall'])
      })
    })

    it('only operators adjust ends_at (audited); raising it raises linked projects', async () => {
      await withRollback(async (tx) => {
        const { actor, term } = await setup(tx)
        const project = await createProject(tx, actor, { title: '과제', courseTermId: term.id }, T0)
        const later = '2027-01-10T14:59:59.999Z'
        await expectServiceError(adjustCourseTermEndsAt(tx, actor, term.id, { endsAt: later, reason: '종강 연기' }), 'FORBIDDEN', 'operator_only')

        const op = await operator(tx)
        const adjusted = await adjustCourseTermEndsAt(tx, op, term.id, { endsAt: later, reason: '종강 연기' })
        expect(adjusted.endsAt).toBe(later)
        expect((await getProject(tx, actor, project.id, T0)).embargo.until).toBe(later)
        const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, term.id), eq(auditEvents.action, 'course_term.adjust_ends_at')))
        expect(audit?.metadata).toMatchObject({ from: FALL_2026_END.toISOString(), to: later, reason: '종강 연기', projectsRaised: 1 })

        // 줄여도 이미 연결된 프로젝트의 엠바고는 줄지 않습니다.
        await adjustCourseTermEndsAt(tx, op, term.id, { endsAt: '2026-12-01T00:00:00Z', reason: '정정' })
        expect((await getProject(tx, actor, project.id, T0)).embargo.until).toBe(later)
      })
    })
  })

  describe('operators and merges', () => {
    it('operator status comes only from the operators table; operators get no project read access', async () => {
      await withRollback(async (tx) => {
        const { actor, term } = await setup(tx)
        const op = await operator(tx)
        expect(await isOperator(tx, op.userId)).toBe(true)
        expect(await isOperator(tx, actor.userId)).toBe(false)
        await tx.update(operators).set({ revokedAt: T0 }).where(eq(operators.userId, op.userId))
        expect(await isOperator(tx, op.userId)).toBe(false)

        const op2 = await operator(tx)
        const project = await createProject(tx, actor, { title: '비공개', courseTermId: term.id }, T0)
        await expectServiceError(getProject(tx, op2, project.id, T0), 'NOT_FOUND')
        await expectServiceError(assertPublishable(tx, op2, project.id, T0), 'NOT_FOUND')
      })
    })

    it('non-operators get 403 on every merge and embargo-lowering endpoint', async () => {
      await withRollback(async (tx) => {
        const { actor, school, course, term } = await setup(tx)
        const project = await createProject(tx, actor, { title: '과제', courseTermId: term.id }, T0)
        const other = await createSchool(tx, actor, { name: `${token()}다른학교` }, T0)
        await expectServiceError(mergeSchool(tx, actor, school.id, { into: other.id }, T0), 'FORBIDDEN', 'operator_only')
        await expectServiceError(mergeCourse(tx, actor, course.id, { into: course.id }, T0), 'FORBIDDEN', 'operator_only')
        await expectServiceError(mergeConceptTag(tx, actor, crypto.randomUUID(), { into: crypto.randomUUID() }, T0), 'FORBIDDEN')
        await expectServiceError(lowerProjectEmbargo(tx, actor, project.id, { until: null, reason: 'x' }, T0), 'FORBIDDEN')
        await expectServiceError(
          addCourseTermEmbargo(tx, actor, term.id, { until: '2027-03-01T00:00:00Z', reason: 'x' }, T0),
          'FORBIDDEN',
        )
        expect((await tx.select().from(schools).where(eq(schools.id, school.id)))[0]?.mergedInto).toBeNull()
      })
    })

    it('course merge re-points terms, projects (embargo raised monotonically), term embargoes and tags in one transaction', async () => {
      await withRollback(async (tx) => {
        const { actor, t, school, course: target, term: targetFall } = await setup(tx)
        const op = await operator(tx)
        const source = await createCourse(tx, actor, school.id, { title: `${t}OS`, confirmNew: true }, T0)
        const sourceFall = (await createCourseTerm(tx, actor, source.id, { year: 2026, semester: 'fall' }, T0)).term
        const sourceSpring = (await createCourseTerm(tx, actor, source.id, { year: 2026, semester: 'spring' }, T0)).term
        // 정본 학기의 종료를 운영자가 늘려 두었습니다.
        await adjustCourseTermEndsAt(tx, op, targetFall.id, { endsAt: '2027-01-05T00:00:00Z', reason: '학교 일정' })

        const onFall = await createProject(tx, actor, { title: '가을 과제', courseTermId: sourceFall.id }, T0)
        const onSpring = await createProject(tx, actor, { title: '봄 과제', courseTermId: sourceSpring.id }, T0)
        await addCourseTermEmbargo(tx, op, sourceFall.id, { until: '2027-01-02T00:00:00Z', reason: '같은 과제 재출제' }, T0)
        await addCourseTag(tx, actor, source.id, { label: `스케줄링 ${t}` }, T0)
        await addCourseTag(tx, actor, target.id, { label: `스케줄링 ${t}` }, T0)
        await addCourseTag(tx, actor, source.id, { label: `교착 상태 ${t}` }, T0)

        const merged = await mergeCourse(tx, op, source.id, { into: target.id }, T0)
        expect(merged.id).toBe(target.id)

        const [sourceRow] = await tx.select().from(courses).where(eq(courses.id, source.id))
        expect(sourceRow?.mergedInto).toBe(target.id)
        // 겹치지 않는 학기는 정본 과목으로 옮기고, 겹치는 학기는 정본 학기로 병합합니다.
        const [springRow] = await tx.select().from(courseTerms).where(eq(courseTerms.id, sourceSpring.id))
        expect(springRow).toMatchObject({ courseId: target.id, mergedInto: null })
        const [fallRow] = await tx.select().from(courseTerms).where(eq(courseTerms.id, sourceFall.id))
        expect(fallRow).toMatchObject({ courseId: source.id, mergedInto: targetFall.id })

        const [fallProject] = await tx.select().from(projects).where(eq(projects.id, onFall.id))
        expect(fallProject?.courseTermId).toBe(targetFall.id)
        // embargo_until은 정본 학기 종료(운영자가 늘린 값)까지 올라가고(단조), 학기 엠바고는 정본 학기로 옮겨져 계속 적용됩니다.
        expect(fallProject?.embargoUntil?.toISOString()).toBe('2027-01-05T00:00:00.000Z')
        expect(await getProjectEmbargo(tx, onFall.id, T0)).toEqual({
          until: new Date('2027-01-05T00:00:00Z'),
          active: true,
          source: 'course_term_end',
        })
        const movedEmbargo = await tx.select().from(embargoes).where(eq(embargoes.courseTermId, targetFall.id))
        expect(movedEmbargo).toHaveLength(1)
        expect((await tx.select().from(projects).where(eq(projects.id, onSpring.id)))[0]?.courseTermId).toBe(sourceSpring.id)

        // 태그 연결은 정본으로(중복은 하나로), 원본 과목 연결은 지워집니다.
        expect((await listCourseTags(tx, target.id)).map((x) => x.slug).sort()).toEqual([`교착-상태-${t}`, `스케줄링-${t}`])
        expect(await tx.select().from(courseConceptTags).where(eq(courseConceptTags.courseId, source.id))).toEqual([])

        // 프로젝트 상세의 과목 정보는 정본을 보여 줍니다.
        const detail = await getProject(tx, actor, onFall.id, T0)
        expect(detail.courseContext).toMatchObject({ school: { id: school.id }, course: { id: target.id }, term: { id: targetFall.id } })

        // 병합된 과목으로 학기를 만들면 정본 과목의 학기입니다.
        expect((await createCourseTerm(tx, actor, source.id, { year: 2026, semester: 'fall' }, T0)).term.id).toBe(targetFall.id)

        const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.targetId, source.id), eq(auditEvents.action, 'course.merge')))
        expect(audit?.metadata).toEqual({ into: target.id, termsMoved: 1, termsMerged: 1, projectsRepointed: 1, registrationsRepointed: 0, releasesRehomed: 0, seniorNotesRehomed: 0, courseQaRehomed: 0, curatorsMoved: 0, curatorsClosed: 0 })
      })
    })

    it('prevents cycles and chains, self merges, and cross-school course merges until schools are merged', async () => {
      await withRollback(async (tx) => {
        const { actor, t, school, course: a } = await setup(tx)
        const op = await operator(tx)
        const b = await createCourse(tx, actor, school.id, { title: `${t}B과목`, confirmNew: true }, T0)
        const c = await createCourse(tx, actor, school.id, { title: `${t}C과목`, confirmNew: true }, T0)

        const self = await expectServiceError(mergeCourse(tx, op, a.id, { into: a.id }, T0), 'VALIDATION')
        expect(self.fields).toEqual({ into: 'self' })
        await mergeCourse(tx, op, a.id, { into: b.id }, T0)
        await expectServiceError(mergeCourse(tx, op, b.id, { into: a.id }, T0), 'CONFLICT', 'target_merged') // 순환
        await expectServiceError(mergeCourse(tx, op, a.id, { into: c.id }, T0), 'CONFLICT', 'already_merged')
        // b → c이면 a도 c를 가리킵니다(평탄화: 사슬 없음).
        await mergeCourse(tx, op, b.id, { into: c.id }, T0)
        const rows = await tx.select({ id: courses.id, mergedInto: courses.mergedInto }).from(courses).where(eq(courses.schoolId, school.id))
        expect(rows.find((r) => r.id === a.id)?.mergedInto).toBe(c.id)
        expect(rows.find((r) => r.id === b.id)?.mergedInto).toBe(c.id)
        await expectServiceError(mergeCourse(tx, op, c.id, { into: a.id }, T0), 'CONFLICT', 'target_merged')
        const missing = await expectServiceError(mergeCourse(tx, op, c.id, { into: crypto.randomUUID() }, T0), 'VALIDATION')
        expect(missing.fields).toEqual({ into: 'not_found' })

        // 다른 학교의 과목은 학교를 먼저 병합해야 합니다.
        const otherSchool = await createSchool(tx, actor, { name: `${token()}타학교` }, T0)
        const foreign = await createCourse(tx, actor, otherSchool.id, { title: `${t}C과목` }, T0)
        await expectServiceError(mergeCourse(tx, op, foreign.id, { into: c.id }, T0), 'CONFLICT', 'different_school')
        await mergeSchool(tx, op, otherSchool.id, { into: school.id }, T0)
        await expectServiceError(mergeSchool(tx, op, school.id, { into: otherSchool.id }, T0), 'CONFLICT', 'target_merged')
        await mergeCourse(tx, op, foreign.id, { into: c.id }, T0)
        expect((await tx.select().from(courses).where(eq(courses.id, foreign.id)))[0]).toMatchObject({ schoolId: school.id, mergedInto: c.id })
      })
    })
  })

  describe('concept tags', () => {
    it('normalizes slugs, reuses existing tags, is idempotent per course, and limits 12 per course', async () => {
      await withRollback(async (tx) => {
        const { actor, t, course } = await setup(tx)
        const first = await addCourseTag(tx, actor, course.id, { label: `  Process   Scheduling ${t} ` }, T0)
        expect(first.added).toBe(true)
        expect(first.tag).toMatchObject({ slug: `process-scheduling-${t}`, label: `Process Scheduling ${t}` })
        // 같은 slug는 같은 태그, 같은 과목에 다시 붙이면 그대로(200).
        const again = await addCourseTag(tx, await student(tx), course.id, { label: `process scheduling ${t}` }, T0)
        expect(again).toMatchObject({ added: false, tag: { id: first.tag.id } })
        const byId = await addCourseTag(tx, actor, course.id, { tagId: first.tag.id }, T0)
        expect(byId.added).toBe(false)
        expect(await searchConceptTags(tx, `scheduling ${t}`)).toEqual([first.tag])

        const empty = await expectServiceError(addCourseTag(tx, actor, course.id, { label: '!!!' }, T0), 'VALIDATION')
        expect(empty.fields).toEqual({ label: 'required' })
        const long = await expectServiceError(addCourseTag(tx, actor, course.id, { label: '가'.repeat(41) }, T0), 'VALIDATION')
        expect(long.fields).toEqual({ label: 'too_long' })
        const unknown = await expectServiceError(addCourseTag(tx, actor, course.id, { tagId: crypto.randomUUID() }, T0), 'VALIDATION')
        expect(unknown.fields).toEqual({ tagId: 'not_found' })

        for (let i = 2; i <= 12; i++) await addCourseTag(tx, actor, course.id, { label: `개념${i} ${t}` }, new Date(T0.getTime() + i * 3_600_000))
        const limit = await expectServiceError(
          addCourseTag(tx, actor, course.id, { label: `열세번째 ${t}` }, new Date(T0.getTime() + 20 * 3_600_000)),
          'CONFLICT',
          'limit_reached',
        )
        expect(limit.details).toEqual({ limit: 12 })
        // 한도에 걸린 태그는 만들지 않습니다.
        expect(await tx.select().from(conceptTags).where(eq(conceptTags.slug, `열세번째-${t}`))).toEqual([])
        // 이미 붙은 태그는 한도와 무관하게 200입니다.
        expect((await addCourseTag(tx, actor, course.id, { tagId: first.tag.id }, T0)).tags).toHaveLength(12)
      })
    })

    it('operator tag merge moves course links and children; merged slugs resolve to the canonical tag', async () => {
      await withRollback(async (tx) => {
        const { actor, t, course } = await setup(tx)
        const op = await operator(tx)
        const deadlock = (await addCourseTag(tx, actor, course.id, { label: `deadlock ${t}` }, T0)).tag
        const kyochak = (await addCourseTag(tx, actor, course.id, { label: `교착상태 ${t}` }, T0)).tag
        const [child] = await tx.insert(conceptTags).values({ slug: `child-${t}`, label: 'child', parentId: kyochak.id }).returning()
        await mergeConceptTag(tx, op, kyochak.id, { into: deadlock.id }, T0)
        expect(await listCourseTags(tx, course.id)).toEqual([deadlock])
        expect((await tx.select().from(conceptTags).where(eq(conceptTags.id, child!.id)))[0]?.parentId).toBe(deadlock.id)
        expect((await searchConceptTags(tx, `교착상태 ${t}`)).map((x) => x.id)).not.toContain(kyochak.id)
        // 병합된 slug로 다시 붙이면 정본 태그입니다.
        const relabel = await addCourseTag(tx, actor, course.id, { label: `교착상태 ${t}` }, T0)
        expect(relabel).toMatchObject({ added: false, tag: { id: deadlock.id } })
        await expectServiceError(mergeConceptTag(tx, op, deadlock.id, { into: kyochak.id }, T0), 'CONFLICT', 'target_merged')
      })
    })
  })

  describe('embargo', () => {
    it('is set from the term on create and is monotonic when switching to an older term or removing it', async () => {
      await withRollback(async (tx) => {
        const { actor, course, term } = await setup(tx)
        const project = await createProject(tx, actor, { title: '진행 중 과제', courseTermId: term.id }, T0)
        expect(project.embargo).toEqual({ until: FALL_2026_END.toISOString(), active: true, source: 'course_term_end' })

        const old = (await createCourseTerm(tx, actor, course.id, { year: 2024, semester: 'spring' }, T0)).term
        const switched = await updateProject(tx, actor, project.id, { expectedVersion: project.version, courseTermId: old.id }, T0)
        expect(switched.courseTermId).toBe(old.id)
        expect(switched.embargo).toEqual(project.embargo) // 옛 학기로 바꿔도 그대로
        const removed = await updateProject(tx, actor, project.id, { expectedVersion: switched.version, courseTermId: null }, T0)
        expect(removed.courseTermId).toBeNull()
        expect(removed.courseContext).toBeNull()
        expect(removed.embargo.until).toBe(FALL_2026_END.toISOString())

        // 더 늦은 학기로 바꾸면 올라갑니다.
        const winter = (await createCourseTerm(tx, actor, course.id, { year: 2026, semester: 'winter' }, T0)).term
        const later = await updateProject(tx, actor, project.id, { expectedVersion: removed.version, courseTermId: winter.id }, T0)
        expect(later.embargo.until).toBe(winter.endsAt)
        const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.projectId, project.id), eq(auditEvents.action, 'project.course_term')))
        expect(audits).toHaveLength(3)

        // 학기 엠바고도 학기를 바꿔 피할 수 없습니다.
        const op = await operator(tx)
        await addCourseTermEmbargo(tx, op, winter.id, { until: '2028-01-01T00:00:00Z', reason: '재출제' }, T0)
        const away = await updateProject(tx, actor, project.id, { expectedVersion: later.version, courseTermId: old.id }, T0)
        expect(away.embargo.until).toBe('2028-01-01T00:00:00.000Z')
        const editErr = await expectServiceError(
          updateProject(tx, actor, project.id, { expectedVersion: away.version, courseTermId: crypto.randomUUID() }, T0),
          'VALIDATION',
        )
        expect(editErr.fields).toEqual({ courseTermId: 'not_found' })
      })
    })

    it('retro projects linked to a past term are not embargoed', async () => {
      await withRollback(async (tx) => {
        const { actor, course } = await setup(tx)
        const past = (await createCourseTerm(tx, actor, course.id, { year: 2024, semester: 'fall' }, T0)).term
        const retro = await createProject(tx, actor, { title: '지난 과제', courseTermId: past.id, retroMode: true }, T0)
        expect(retro.embargo).toEqual({ until: past.endsAt, active: false, source: 'course_term_end' })
        await assertPublishable(tx, actor, retro.id, T0)
        const none = await createProject(tx, actor, { title: '학기 없음' }, T0)
        expect(none.embargo).toEqual({ until: null, active: false, source: null })
      })
    })

    it('assertPublishable blocks before the term ends (409 embargo_active + until) and passes after', async () => {
      await withRollback(async (tx) => {
        const { actor, term } = await setup(tx)
        const project = await createProject(tx, actor, { title: '과제', courseTermId: term.id }, T0)
        const blocked = await expectServiceError(assertPublishable(tx, actor, project.id, T0), 'CONFLICT', 'embargo_active')
        expect(blocked.details).toEqual({ until: FALL_2026_END.toISOString() })
        await expectServiceError(
          assertPublishable(tx, actor, project.id, new Date(FALL_2026_END.getTime() - 1)),
          'CONFLICT',
          'embargo_active',
        )
        await assertPublishable(tx, actor, project.id, new Date(FALL_2026_END.getTime() + 1))
        await expectServiceError(assertPublishable(tx, await student(tx), project.id, T0), 'NOT_FOUND')

        // 프로젝트 엠바고(owner)는 더 늦게까지 막습니다. owner가 아니면 403.
        const editor = await createUser(tx)
        const { token: inv } = await createInvitation(tx, actor, project.id, { role: 'editor' }, T0)
        await acceptInvitation(tx, { userId: editor.id }, { token: inv }, T0)
        await expectServiceError(
          addProjectEmbargo(tx, { userId: editor.id }, project.id, { until: '2027-06-01T00:00:00Z', reason: '특허 출원' }, T0),
          'FORBIDDEN',
        )
        const past = await expectServiceError(addProjectEmbargo(tx, actor, project.id, { until: '2026-01-01T00:00:00Z', reason: 'x' }, T0), 'VALIDATION')
        expect(past.fields).toEqual({ until: 'not_future' })
        const extended = await addProjectEmbargo(tx, actor, project.id, { until: '2027-06-01T00:00:00Z', reason: '특허 출원' }, T0)
        expect(extended).toEqual({ until: '2027-06-01T00:00:00.000Z', active: true, source: 'project_embargo' })
        await expectServiceError(assertPublishable(tx, actor, project.id, new Date(FALL_2026_END.getTime() + 1)), 'CONFLICT', 'embargo_active')
      })
    })

    it('operators can lower (not raise) the project embargo, audited, without reading the project', async () => {
      await withRollback(async (tx) => {
        const { actor, term } = await setup(tx)
        const op = await operator(tx)
        const project = await createProject(tx, actor, { title: '과제', courseTermId: term.id }, T0)
        const raise = await expectServiceError(
          lowerProjectEmbargo(tx, op, project.id, { until: '2027-12-31T00:00:00Z', reason: '연장' }, T0),
          'VALIDATION',
        )
        expect(raise.fields).toEqual({ until: 'not_lower' })
        await expectServiceError(lowerProjectEmbargo(tx, op, project.id, { until: null }, T0), 'VALIDATION')
        await expectServiceError(lowerProjectEmbargo(tx, op, crypto.randomUUID(), { until: null, reason: 'x' }, T0), 'NOT_FOUND')

        const lowered = await lowerProjectEmbargo(tx, op, project.id, { until: null, reason: '학기 잘못 연결(지난 학기 과제)' }, T0)
        expect(lowered).toEqual({ until: null, active: false, source: null })
        expect(Object.keys(lowered)).toEqual(['until', 'active', 'source'])
        await assertPublishable(tx, actor, project.id, T0)
        const [audit] = await tx.select().from(auditEvents).where(and(eq(auditEvents.projectId, project.id), eq(auditEvents.action, 'embargo.lower')))
        expect(audit).toMatchObject({
          actorId: op.userId,
          metadata: { from: FALL_2026_END.toISOString(), to: null, reason: '학기 잘못 연결(지난 학기 과제)' },
        })
        // 같은 학기로 다시 저장해도(학기 변경 없음) 엠바고는 다시 걸리지 않습니다.
        const same = await updateProject(tx, actor, project.id, { expectedVersion: 1, courseTermId: term.id, goal: '목표' }, T0)
        expect(same.embargo.active).toBe(false)
      })
    })
  })
})
