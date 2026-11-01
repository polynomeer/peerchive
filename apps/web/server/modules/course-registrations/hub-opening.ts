/**
 * 과목 허브 단계적 개방의 본인 화면 (E-02, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4 E-02, ADR 0047).
 *
 * 플래그 `hubStagedOpening`이 꺼져 있으면 모든 함수가 404입니다(허브는 항상 열려 있으므로 알릴 일이 없음).
 * - "준비 중" 허브에서 로그인한 본인의 상태(`getMyHubOpening`): 등록했는지·마쳤는지·알림 신청했는지·내 노트가 있는지. 내 것만 셉니다.
 * - **열리면 알려 주세요**(`requestHubOpenNotify`): 이 과목을 (어느 학기든) 등록한 학생만(아니면 403 `not_registered`). 이미 열렸으면 409 `already_open`.
 *   같은 신청은 하나(다시 눌러도 그대로). 취소하면 행을 지웁니다.
 * - 홈 알림(`listMyHubNotices`): 읽을 때 신청한 허브가 열렸는지 계산하고, 열렸으면 `opened_at`을 **한 번만** 채웁니다(조건부 갱신이라 동시에
 *   여러 번 읽어도 한 번, worker 없음). 닫으면 다시 보이지 않습니다. 허브가 다시 기준 밑으로 내려가면 열림 알림은 그동안 숨깁니다.
 * - **선배 노트 요청**: 이 과목을 마친 학생(끝난 학기의 등록, 또는 끝난 학기 과제 공간의 active 멤버, 스터디 제외)에게 허브가 준비 중인 동안 보입니다.
 *   이미 내 노트(초안 포함, 철회 제외)가 있거나, 닫았거나, 같은 과목의 E-01 학기 종료 알림이 아직 떠 있으면(같은 요청이라) 보이지 않습니다.
 * - 신청·닫음 행은 본인만 봅니다. 신청 수는 공개·운영자 화면 어디에도 내보내지 않고, 감사 기록·분석 이벤트도 남기지 않습니다.
 */
import { hubOpeningStatus } from '@peerchive/domain'
import {
  and,
  courseHubNotices,
  courses,
  eq,
  inArray,
  isNotNull,
  isNull,
  schools,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { loadCanonicalCourse } from '../catalog/catalog'
import { courseScopeSql } from '../course-hub/public-scope'
import { courseHubOpening, hubContentCounts, openCourseIds } from '../course-hub/staged-opening'
import { type Actor, conflict, forbidden, notFound, rateLimited } from '../errors'
import { hubOpenThreshold, requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import type { HubNoticeCourseDto, MyHubNoticesDto, MyHubOpeningDto } from '../../../shared/types/api'

/** 알림 신청·취소·닫기 횟수(사용자별, 시간당). */
export const HUB_NOTICE_RATE_LIMIT: RateLimitRule = { limit: 60, windowMs: 60 * 60 * 1000 }
/** 홈에 보이는 선배 노트 요청 최대 개수. */
export const HUB_NOTE_REQUEST_LIMIT = 10

const ts = (now: Date) => sql`${now.toISOString()}::timestamptz`

async function consume(db: DbExecutor, actor: Actor, now: Date) {
  if (!(await hitRateLimit(db, 'course_hub_notice', actor.userId, HUB_NOTICE_RATE_LIMIT, now))) throw rateLimited()
}

async function canonicalCourseOr404(db: DbExecutor, rawId: unknown) {
  requireFeature('hubStagedOpening')
  return loadCanonicalCourse(db, rawId).catch(() => {
    throw notFound()
  })
}

/** 이 과목(정본 + 병합된 과목)을 어느 학기든 등록했는지. */
async function isRegistered(db: DbExecutor, userId: string, canonicalCourseId: string): Promise<boolean> {
  const rows = await db.execute<{ ok: number }>(sql`
    select 1 as ok from course_registrations r
    join course_terms ct on ct.id = r.course_term_id
    left join course_terms canon on canon.id = ct.merged_into
    where r.user_id = ${userId} and coalesce(canon.course_id, ct.course_id) in ${courseScopeSql(canonicalCourseId)}
    limit 1`)
  return rows.length > 0
}

/**
 * 내가 마친 과목(정본 id): 학기가 끝난(정본 학기의 ends_at ≤ now) 등록, 또는 학기가 끝난 과제 공간(스터디 제외)의 active 멤버.
 * `canonicalCourseId`를 주면 그 과목만 봅니다.
 */
async function finishedCourseIds(db: DbExecutor, userId: string, now: Date, canonicalCourseId?: string): Promise<string[]> {
  const only = canonicalCourseId ? sql`and x.course_id in ${courseScopeSql(canonicalCourseId)}` : sql``
  const rows = await db.execute<{ course_id: string }>(sql`
    select distinct coalesce(c.merged_into, c.id) as course_id from (
      select coalesce(canon.course_id, ct.course_id) as course_id
      from course_registrations r
      join course_terms ct on ct.id = r.course_term_id
      left join course_terms canon on canon.id = ct.merged_into
      where r.user_id = ${userId} and coalesce(canon.ends_at, ct.ends_at) <= ${ts(now)}
      union
      select coalesce(canon.course_id, ct.course_id) as course_id
      from project_members pm
      join projects p on p.id = pm.project_id
      join course_terms ct on ct.id = p.course_term_id
      left join course_terms canon on canon.id = ct.merged_into
      where pm.user_id = ${userId} and pm.status = 'active' and p.kind <> 'study' and coalesce(canon.ends_at, ct.ends_at) <= ${ts(now)}
    ) x
    join courses c on c.id = x.course_id
    where true ${only}`)
  return rows.map((r) => r.course_id)
}

/** 내 선배 노트(초안·게시·숨김, 철회 제외)가 있는 정본 과목 id. */
async function coursesWithMyNote(db: DbExecutor, userId: string, canonicalIds: readonly string[]): Promise<Set<string>> {
  if (canonicalIds.length === 0) return new Set()
  const rows = await db.execute<{ course_id: string }>(sql`
    select distinct coalesce(c.merged_into, c.id) as course_id
    from senior_notes n join courses c on c.id = n.course_id
    where n.author_id = ${userId} and n.status <> 'withdrawn'
      and coalesce(c.merged_into, c.id) in (${sql.join(canonicalIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
  return new Set(rows.map((r) => r.course_id))
}

/** 아직 닫지 않은 E-01 학기 종료 알림(같은 "선배 노트를 남겨 주세요")이 떠 있는 정본 과목 id. */
async function coursesWithTermPrompt(db: DbExecutor, userId: string): Promise<Set<string>> {
  const rows = await db.execute<{ course_id: string }>(sql`
    select distinct coalesce(c.merged_into, c.id) as course_id
    from course_registrations r
    join course_terms ct on ct.id = r.course_term_id
    left join course_terms canon on canon.id = ct.merged_into
    join courses c on c.id = coalesce(canon.course_id, ct.course_id)
    where r.user_id = ${userId} and r.post_term_prompted_at is not null and r.prompt_dismissed_at is null`)
  return new Set(rows.map((r) => r.course_id))
}

async function myNotice(db: DbExecutor, userId: string, courseId: string, kind: 'open_notify' | 'note_request') {
  const [row] = await db
    .select()
    .from(courseHubNotices)
    .where(and(eq(courseHubNotices.userId, userId), eq(courseHubNotices.courseId, courseId), eq(courseHubNotices.kind, kind)))
    .limit(1)
  return row ?? null
}

/** GET /me/course-hubs/:id/opening — 이 과목 허브의 개방 상태와 내 상태(본인 것만). 플래그가 꺼져 있거나 없는 과목이면 404. */
export async function getMyHubOpening(db: DbExecutor, actor: Actor, rawCourseId: unknown, now = new Date()): Promise<MyHubOpeningDto> {
  const course = await canonicalCourseOr404(db, rawCourseId)
  const opening = await courseHubOpening(db, course.id, now)
  const registered = await isRegistered(db, actor.userId, course.id)
  const finished = await finishedCourseIds(db, actor.userId, now, course.id)
  const notify = await myNotice(db, actor.userId, course.id, 'open_notify')
  const mine = await coursesWithMyNote(db, actor.userId, [course.id])
  return {
    courseId: course.id,
    status: opening.status,
    count: opening.count.cases + opening.count.notes,
    threshold: opening.threshold,
    registered,
    finished: finished.length > 0,
    notifyRequested: !!notify,
    wroteNote: mine.has(course.id),
  }
}

/** POST /me/course-hubs/:id/notify — 열리면 알려 주세요(등록한 학생만, 멱등). 403 `not_registered`, 409 `already_open`, 429. */
export async function requestHubOpenNotify(db: DbExecutor, actor: Actor, rawCourseId: unknown, now = new Date()): Promise<{ requested: true }> {
  const course = await canonicalCourseOr404(db, rawCourseId)
  return db.transaction(async (tx) => {
    if ((await courseHubOpening(tx, course.id, now)).status === 'open') throw conflict('already_open')
    if (!(await isRegistered(tx, actor.userId, course.id))) throw forbidden('not_registered')
    if (await myNotice(tx, actor.userId, course.id, 'open_notify')) return { requested: true as const }
    await consume(tx, actor, now)
    await tx
      .insert(courseHubNotices)
      .values({ userId: actor.userId, courseId: course.id, kind: 'open_notify', createdAt: now })
      .onConflictDoNothing({ target: [courseHubNotices.userId, courseHubNotices.courseId, courseHubNotices.kind] })
    return { requested: true as const }
  })
}

/** DELETE /me/course-hubs/:id/notify — 알림 신청 취소(행 삭제, 없으면 그대로). */
export async function cancelHubOpenNotify(db: DbExecutor, actor: Actor, rawCourseId: unknown, now = new Date()): Promise<{ removed: true }> {
  const course = await canonicalCourseOr404(db, rawCourseId)
  return db.transaction(async (tx) => {
    await consume(tx, actor, now)
    await tx
      .delete(courseHubNotices)
      .where(and(eq(courseHubNotices.userId, actor.userId), eq(courseHubNotices.courseId, course.id), eq(courseHubNotices.kind, 'open_notify')))
    return { removed: true as const }
  })
}

/** POST /me/course-hubs/:id/dismiss-note-request — 이 과목의 선배 노트 요청 닫기(멱등). */
export async function dismissHubNoteRequest(db: DbExecutor, actor: Actor, rawCourseId: unknown, now = new Date()): Promise<{ dismissed: true }> {
  const course = await canonicalCourseOr404(db, rawCourseId)
  return db.transaction(async (tx) => {
    if (await myNotice(tx, actor.userId, course.id, 'note_request')) return { dismissed: true as const }
    await consume(tx, actor, now)
    await tx
      .insert(courseHubNotices)
      .values({ userId: actor.userId, courseId: course.id, kind: 'note_request', dismissedAt: now, createdAt: now })
      .onConflictDoNothing({ target: [courseHubNotices.userId, courseHubNotices.courseId, courseHubNotices.kind] })
    return { dismissed: true as const }
  })
}

async function courseLabels(db: DbExecutor, ids: readonly string[]): Promise<Map<string, HubNoticeCourseDto>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({ id: courses.id, title: courses.title, code: courses.code, schoolName: schools.name })
    .from(courses)
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(inArray(courses.id, [...new Set(ids)]))
  return new Map(rows.map((r) => [r.id, r]))
}

/**
 * GET /me/course-hub-notices — 홈 알림: 신청한 허브가 열렸음 + 마친 과목의 선배 노트 요청. 읽을 때 열림을 판정해 `opened_at`을 한 번 채웁니다.
 */
export async function listMyHubNotices(db: DbExecutor, actor: Actor, now = new Date()): Promise<MyHubNoticesDto> {
  requireFeature('hubStagedOpening')
  const threshold = hubOpenThreshold()
  const pending = await db
    .select({ id: courseHubNotices.id, courseId: courseHubNotices.courseId })
    .from(courseHubNotices)
    .where(and(eq(courseHubNotices.userId, actor.userId), eq(courseHubNotices.kind, 'open_notify'), isNull(courseHubNotices.dismissedAt)))
  const notifyOpen = await openCourseIds(db, pending.map((r) => r.courseId), now)
  const newlyOpened = pending.filter((r) => notifyOpen.has(r.courseId)).map((r) => r.id)
  if (newlyOpened.length) {
    // 한 번만: 이미 채워진 행은 그대로 둡니다.
    await db
      .update(courseHubNotices)
      .set({ openedAt: now })
      .where(and(inArray(courseHubNotices.id, newlyOpened), isNull(courseHubNotices.openedAt)))
  }
  const openedRows = newlyOpened.length
    ? await db
        .select()
        .from(courseHubNotices)
        .where(and(inArray(courseHubNotices.id, newlyOpened), isNotNull(courseHubNotices.openedAt)))
    : []

  const finished = await finishedCourseIds(db, actor.userId, now)
  const counts = await hubContentCounts(db, finished, now)
  const preparing = finished.filter((id) => hubOpeningStatus(counts.get(id) ?? { cases: 0, notes: 0 }, threshold, true) === 'preparing')
  const withNote = await coursesWithMyNote(db, actor.userId, preparing)
  const withPrompt = await coursesWithTermPrompt(db, actor.userId)
  const dismissed = preparing.length
    ? await db
        .select({ courseId: courseHubNotices.courseId })
        .from(courseHubNotices)
        .where(and(eq(courseHubNotices.userId, actor.userId), eq(courseHubNotices.kind, 'note_request'), inArray(courseHubNotices.courseId, preparing)))
    : []
  const dismissedIds = new Set(dismissed.map((r) => r.courseId))
  const requestIds = preparing.filter((id) => !withNote.has(id) && !withPrompt.has(id) && !dismissedIds.has(id))

  const labels = await courseLabels(db, [...openedRows.map((r) => r.courseId), ...requestIds])
  const noteRequests = requestIds
    .flatMap((id) => {
      const course = labels.get(id)
      if (!course) return []
      const count = counts.get(id) ?? { cases: 0, notes: 0 }
      return [{ course, count: count.cases + count.notes, threshold }]
    })
    .sort((a, b) => a.course.title.localeCompare(b.course.title, 'ko') || a.course.id.localeCompare(b.course.id))
    .slice(0, HUB_NOTE_REQUEST_LIMIT)
  return {
    opened: openedRows
      .flatMap((r) => {
        const course = labels.get(r.courseId)
        return course ? [{ id: r.id, course, openedAt: r.openedAt!.toISOString() }] : []
      })
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt) || a.id.localeCompare(b.id)),
    noteRequests,
  }
}

/** POST /me/course-hub-notices/:id/dismiss — 열림 알림 닫기(멱등). 내 것이 아니면 404, 아직 열리지 않았으면 409 `not_opened`. */
export async function dismissHubOpenedNotice(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<{ dismissed: true }> {
  requireFeature('hubStagedOpening')
  if (!isUuid(rawId)) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(courseHubNotices)
      .where(and(eq(courseHubNotices.id, rawId.toLowerCase()), eq(courseHubNotices.userId, actor.userId), eq(courseHubNotices.kind, 'open_notify')))
      .limit(1)
      .for('update')
    if (!row) throw notFound()
    if (!row.openedAt) throw conflict('not_opened')
    if (!row.dismissedAt) await tx.update(courseHubNotices).set({ dismissedAt: now }).where(eq(courseHubNotices.id, row.id))
    return { dismissed: true as const }
  })
}
