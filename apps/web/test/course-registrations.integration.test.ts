/**
 * E-01 이번 학기 과목 등록 서비스 통합 테스트(실제 PostgreSQL, rollback): 등록·지우기·중복·카탈로그 과목만·지금/다음 학기만, 본인만 보기
 * (다른 사용자·공개 프로필·검색·피드·추천·운영자 감사 기록에 0건), 과목 허브의 "이번 학기 수강 중 N명"(5명 미만 가림), 등록 과목에서 과제 공간 만들기
 * (과목·학기·엠바고 채움), 학기 종료 알림 닫기, 과목 병합 때 등록 옮기기.
 * 학기 종료 알림 작업(worker)과 탈퇴 정리는 apps/worker 테스트가 봅니다.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { semesterEndsAt } from '@peerchive/domain'
import { auditEvents, courseRegistrations, courseTerms, eq, operators, or, personas, sql, type DbExecutor } from '@peerchive/db'
import { createPostTermPrompts } from '../../worker/src/ops/course-term-prompts'
import { createCourse, createSchool } from '../server/modules/catalog/catalog'
import { mergeCourse } from '../server/modules/catalog/merge'
import { getPublicCourseHub } from '../server/modules/course-hub/hub'
import { searchPublic } from '../server/modules/course-hub/search'
import {
  COURSE_REGISTRATION_RATE_LIMIT,
  createProjectFromRegistration,
  dismissRegistrationPrompt,
  listMyCourseRegistrations,
  registerCourse,
  removeCourseRegistration,
} from '../server/modules/course-registrations/registrations'
import { getPublicProfile, upsertProfile } from '../server/modules/identity/profiles'
import { getProject } from '../server/modules/projects/projects'
import { getFeed, getFollowSuggestions } from '../server/modules/social/feed'
import { followProfile } from '../server/modules/social/follows'
import { closeTestDb, createUser, databaseUrl, expectServiceError, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z') // 2026년 2학기 진행 중 → 등록 가능: 2026 2학기·2026 겨울
const FALL_END = semesterEndsAt(2026, 'fall')
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => String.fromCharCode(0x61 + (b % 26))).join('')

async function world(db: DbExecutor) {
  const maker = { userId: (await createUser(db)).id }
  const tag = token()
  const school = await createSchool(db, maker, { name: `등록대학교${tag}`, confirmNew: true }, T0)
  const os = await createCourse(db, maker, school.id, { title: `운영체제${tag}`, confirmNew: true }, T0)
  const net = await createCourse(db, maker, school.id, { title: `컴퓨터네트워크${tag}`, confirmNew: true }, T0)
  return { school, os, net, tag }
}

const student = async (db: DbExecutor, handle?: string) => ({ userId: (await createUser(db, handle ? { handle } : {})).id })

describe.skipIf(!databaseUrl)('E-01 course registration (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('registers a catalog course for the current/next term, lists it only to its owner, rejects duplicates, and removes it', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const me = await student(tx)
      const other = await student(tx)

      const reg = await registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)
      expect(reg).toMatchObject({
        school: { id: w.school.id },
        course: { id: w.os.id },
        term: { year: 2026, semester: 'fall', endsAt: FALL_END.toISOString() },
        termLabel: '2026년 2학기',
        phase: 'current',
        postTermPrompt: false,
        myProjects: [],
      })
      // 다음 학기(겨울 계절학기)도 됩니다. 개설 학기는 만든 사람 없이 만들어집니다.
      const next = await registerCourse(tx, me, { courseId: w.net.id, year: 2026, semester: 'winter' }, T0)
      expect(next.phase).toBe('upcoming')
      const [term] = await tx.select().from(courseTerms).where(eq(courseTerms.id, next.term.id))
      expect(term!.createdBy).toBeNull()

      // 중복 409, 지금·다음이 아닌 학기 422, 카탈로그에 없는 과목 422, 형식 422.
      await expectServiceError(registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0), 'CONFLICT', 'already_registered')
      const past = await expectServiceError(registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'spring' }, T0), 'VALIDATION')
      expect(past.fields).toEqual({ term: 'not_registrable' })
      await expectServiceError(registerCourse(tx, me, { courseId: w.os.id, year: 2027, semester: 'spring' }, T0), 'VALIDATION')
      const missing = await expectServiceError(registerCourse(tx, me, { courseId: crypto.randomUUID(), year: 2026, semester: 'fall' }, T0), 'VALIDATION')
      expect(missing.fields).toEqual({ courseId: 'not_found' })
      await expectServiceError(registerCourse(tx, me, { courseId: 'nope', year: 2026, semester: 'fall' }, T0), 'VALIDATION')

      const mine = await listMyCourseRegistrations(tx, me, T0)
      expect(mine.items.map((r) => r.id)).toEqual([reg.id, next.id])
      expect(mine.registrableTerms).toEqual([
        { year: 2026, semester: 'fall', label: '2026년 2학기', current: true },
        { year: 2026, semester: 'winter', label: '2026년 겨울 계절학기', current: false },
      ])
      // 다른 사람: 목록 0건, 지우기·알림 닫기 404.
      expect((await listMyCourseRegistrations(tx, other, T0)).items).toEqual([])
      await expectServiceError(removeCourseRegistration(tx, other, reg.id, T0), 'NOT_FOUND')
      await expectServiceError(dismissRegistrationPrompt(tx, other, reg.id, T0), 'NOT_FOUND')
      await expectServiceError(createProjectFromRegistration(tx, other, { courseRegistrationId: reg.id, title: '남의 등록' }, T0), 'VALIDATION')

      // 다른 사람은 같은 과목을 따로 등록합니다.
      await registerCourse(tx, other, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)

      expect(await removeCourseRegistration(tx, me, reg.id, T0)).toEqual({ removed: true })
      await expectServiceError(removeCourseRegistration(tx, me, reg.id, T0), 'NOT_FOUND')
      expect((await listMyCourseRegistrations(tx, me, T0)).items.map((r) => r.id)).toEqual([next.id])
      // 지운 뒤 다시 등록할 수 있습니다.
      await registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)
    })
  })

  it('a merged course id registers the canonical course; merging repoints registrations and drops a duplicate of the same person', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const op = await student(tx)
      await tx.insert(operators).values({ userId: op.userId })
      const dup = await createCourse(tx, op, w.school.id, { title: `운영체제론${w.tag}`, confirmNew: true }, T0)
      const a = await student(tx)
      const b = await student(tx)
      const aDup = await registerCourse(tx, a, { courseId: dup.id, year: 2026, semester: 'fall' }, T0)
      await registerCourse(tx, a, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)
      const bDup = await registerCourse(tx, b, { courseId: dup.id, year: 2026, semester: 'fall' }, T0)
      await mergeCourse(tx, op, dup.id, { into: w.os.id }, T0)
      const rows = await tx.select().from(courseRegistrations).where(or(eq(courseRegistrations.userId, a.userId), eq(courseRegistrations.userId, b.userId)))
      expect(rows).toHaveLength(2)
      expect(rows.find((r) => r.id === aDup.id)).toBeUndefined()
      expect(rows.find((r) => r.id === bDup.id)!.courseTermId).not.toBe(bDup.term.id)
      expect((await listMyCourseRegistrations(tx, b, T0)).items[0]!.course.id).toBe(w.os.id)
      // 병합된 id로 등록하면 정본 과목으로(이미 있으면 409).
      await expectServiceError(registerCourse(tx, b, { courseId: dup.id, year: 2026, semester: 'fall' }, T0), 'CONFLICT', 'already_registered')
    })
  })

  it('limits registrations per term and per hour', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const me = await student(tx)
      const maker = await student(tx)
      for (let i = 0; i < 15; i++) {
        const c = await createCourse(tx, maker, w.school.id, { title: `한도과목${w.tag}${String.fromCharCode(0x61 + i)}`, confirmNew: true }, T0)
        await registerCourse(tx, me, { courseId: c.id, year: 2026, semester: 'fall' }, T0)
      }
      await expectServiceError(registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0), 'CONFLICT', 'limit_reached')
      // 다음 학기는 따로 셉니다.
      await registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'winter' }, T0)
      expect(COURSE_REGISTRATION_RATE_LIMIT.limit).toBe(60)
    })
  })

  it('creating a project space from a registration fills course, term and embargo with the existing project rules', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const me = await student(tx)
      const reg = await registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)
      const project = await createProjectFromRegistration(tx, me, { courseRegistrationId: reg.id, title: '운영체제 팀 과제', kind: 'team' }, T0)
      expect(project.courseTermId).toBe(reg.term.id)
      expect(project.courseContext).toMatchObject({ school: { id: w.school.id }, course: { id: w.os.id }, term: { id: reg.term.id } })
      expect(project.embargo).toMatchObject({ active: true, until: FALL_END.toISOString(), source: 'course_term_end' })
      expect((await getProject(tx, me, project.id, T0)).embargo.until).toBe(FALL_END.toISOString())
      // 등록 목록에 이 학기의 내 과제로 보입니다(공개 제안 링크).
      expect((await listMyCourseRegistrations(tx, me, T0)).items[0]!.myProjects).toEqual([{ id: project.id, title: '운영체제 팀 과제' }])
      // courseTermId와 함께 보내면 422.
      const both = await expectServiceError(
        createProjectFromRegistration(tx, me, { courseRegistrationId: reg.id, courseTermId: reg.term.id, title: 'x' }, T0),
        'VALIDATION',
      )
      expect(both.fields).toEqual({ courseTermId: 'not_allowed' })
    })
  })

  it('the hub shows "이번 학기 수강 중 N명" only for n ≥ 5 active users of the current term', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const users = [] as Array<{ userId: string }>
      for (let i = 0; i < 5; i++) users.push(await student(tx))
      for (const u of users.slice(0, 4)) await registerCourse(tx, u, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)
      // 다음 학기 등록은 이번 학기 수에 들어가지 않습니다.
      await registerCourse(tx, users[4]!, { courseId: w.os.id, year: 2026, semester: 'winter' }, T0)
      expect((await getPublicCourseHub(tx, w.os.id, T0)).enrollment).toBeNull()

      await registerCourse(tx, users[4]!, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)
      const hub = await getPublicCourseHub(tx, w.os.id, T0)
      expect(hub.enrollment).toEqual({ termLabel: '2026년 2학기', count: 5 })
      // 사람을 가리키는 값은 없습니다.
      const body = JSON.stringify(hub)
      for (const u of users) expect(body.includes(u.userId)).toBe(false)

      // 탈퇴 요청(계정 deleted)은 세지 않아 다시 4명 → 표시 없음.
      await tx.execute(sql`update users set status = 'deleted' where id = ${users[0]!.userId}`)
      expect((await getPublicCourseHub(tx, w.os.id, T0)).enrollment).toBeNull()
      // 다른 과목 허브에는 0.
      expect((await getPublicCourseHub(tx, w.net.id, T0)).enrollment).toBeNull()
    })
  })

  it('registrations never reach the public profile, search, feed, follow suggestions or operator audit records', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const handleA = `rega${token()}`
      const handleB = `regb${token()}`
      const a = await student(tx)
      const b = await student(tx)
      await upsertProfile(tx, a, { handle: handleA, displayName: '수강생가' })
      await upsertProfile(tx, b, { handle: handleB, displayName: '수강생나' })
      const regs = [
        await registerCourse(tx, a, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0),
        await registerCourse(tx, a, { courseId: w.net.id, year: 2026, semester: 'winter' }, T0),
        await registerCourse(tx, b, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0),
      ]
      const [bPersona] = await tx.select({ id: personas.id }).from(personas).where(eq(personas.userId, b.userId))
      await followProfile(tx, b, handleA, { as: bPersona!.id }, T0)
      const forbidden = [...regs.map((r) => r.id), w.os.id, w.net.id, w.os.title, w.net.title, ...regs.map((r) => r.term.id)]
      const outputs = JSON.stringify([
        await getPublicProfile(tx, handleA),
        await getPublicProfile(tx, handleB),
        // 검색 응답은 검색어를 되돌려 주므로 결과만 봅니다.
        (await searchPublic(tx, { q: w.os.title }, T0)).results,
        (await searchPublic(tx, { q: w.tag }, T0)).results,
        await getFeed(tx, a),
        await getFeed(tx, b),
        await getFollowSuggestions(tx, a),
        await getFollowSuggestions(tx, b),
      ])
      for (const value of forbidden) expect(outputs.includes(value), `leaks ${value}`).toBe(false)
      // 같은 과목을 등록한 것만으로는 추천되지 않습니다(추천은 과제·학교 인증·관심 직무만 봄).
      expect((await getFollowSuggestions(tx, a)).suggestions).toEqual([])

      // 감사 기록: 등록·지우기·알림 닫기는 남기지 않고, 등록 경로에서 만든 학기도 actor가 없습니다.
      await removeCourseRegistration(tx, a, regs[0]!.id, T0)
      const audit = await tx
        .select()
        .from(auditEvents)
        .where(or(eq(auditEvents.actorId, a.userId), eq(auditEvents.actorId, b.userId)))
      expect(audit.map((e) => e.action)).not.toEqual(expect.arrayContaining([expect.stringMatching(/registration/)]))
      const text = JSON.stringify(audit)
      for (const value of [...regs.map((r) => r.id), ...regs.map((r) => r.term.id)]) expect(text.includes(value)).toBe(false)
      expect(audit.filter((e) => e.action === 'course_term.create')).toEqual([])
    })
  })

  it('after the term ends the worker prompt shows once per registration and the owner can dismiss it', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const me = await student(tx)
      const reg = await registerCourse(tx, me, { courseId: w.os.id, year: 2026, semester: 'fall' }, T0)
      await expectServiceError(dismissRegistrationPrompt(tx, me, reg.id, T0), 'CONFLICT', 'no_prompt')
      const after = new Date(FALL_END.getTime() + 60 * 60 * 1000)
      await createPostTermPrompts(tx, after)
      const listed = (await listMyCourseRegistrations(tx, me, after)).items[0]!
      expect(listed).toMatchObject({ id: reg.id, phase: 'ended', postTermPrompt: true })
      const dismissed = await dismissRegistrationPrompt(tx, me, reg.id, after)
      expect(dismissed.postTermPrompt).toBe(false)
      // 멱등: 다시 닫아도 같고, 작업을 다시 돌려도 알림이 돌아오지 않습니다.
      expect((await dismissRegistrationPrompt(tx, me, reg.id, after)).postTermPrompt).toBe(false)
      await createPostTermPrompts(tx, new Date(after.getTime() + 60_000))
      expect((await listMyCourseRegistrations(tx, me, after)).items[0]!.postTermPrompt).toBe(false)
    })
  })
})
