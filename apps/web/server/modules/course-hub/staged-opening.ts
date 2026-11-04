/**
 * 과목 허브 단계적 개방 (E-02, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4 E-02, ADR 0047).
 *
 * - 플래그 `hubStagedOpening`(`PEERCHIVE_FEATURE_HUB_STAGED_OPENING`, 기본 꺼짐)이 꺼져 있으면 모든 허브가 지금처럼 열려 있고 여기서는 세지 않습니다.
 * - 켜져 있으면 과목(정본 + 병합된 id)의 **공개 사례 + 선배 노트** 합계를 요청마다 셉니다. 합계가 기준 이상이면 `courses.hub_opened_at`을 조건부 갱신으로 한 번 채우고(ADR 0060 D-07)
 *   그 뒤로는 세지 않고 계속 엽니다. 플래그가 꺼져 있으면 쓰지 않습니다. 기준(`PEERCHIVE_HUB_OPEN_THRESHOLD`, 기본 3)
 *   이상이면 열린 허브, 미만이면 "준비 중"(과목 이름만, 내용 목록 없음). 기준에 이르면 다음 요청부터 열리고 운영자 조작은 필요 없습니다.
 *   - 공개 사례: 허브와 같은 `servableReleaseSql`(공개·release 게시, 지금 release, 엠바고 없음). 철회·대체·엠바고 중인 것은 세지 않습니다.
 *   - 선배 노트: status = 'published'만(초안·철회·숨김 제외).
 *   - 막힘 Q&A·체크인 통계·개념 태그는 세지 않습니다(§8.6 기준은 사례·노트).
 * - 가리는 것은 **허브 모음 페이지**뿐입니다. 공개 사례(/p/:slug)는 이미 공개된 것이라 그대로 열리고 검색의 사례·막힘 결과도 그대로입니다.
 *   허브 안에서만 읽을 수 있는 선배 노트·막힘 Q&A 검색 결과(경로가 /c/:id#…)는 준비 중인 과목이면 검색 SQL에서 뺍니다(hubOpenSql, 제한 전, ADR 0060 D-07). 내용 없는 페이지로 보내지 않습니다.
 * - 운영자 화면(`getHubOpeningProgress`)은 과목별 공개 항목 수와 기준만 봅니다. 알림 신청·등록 수는 싣지 않습니다(course-registrations 모듈을 import하지 않음).
 */
import { hubOpeningStatus, type HubContentCount, type HubOpeningStatus } from '@peerchive/domain'
import {
  and,
  courses,
  eq,
  inArray,
  isNotNull,
  isNull,
  projects,
  publicationCandidates,
  publications,
  schools,
  seniorNotes,
  sql,
  type DbExecutor,
  type SQL,
  type SQLWrapper,
} from '@peerchive/db'
import { loadCanonicalCourse } from '../catalog/catalog'
import { requireOperator } from '../catalog/operators'
import { type Actor, notFound } from '../errors'
import { hubOpenThreshold, isFeatureOn } from '../features'
import { getPublicCourseHub } from './hub'
import { servableReleaseSql } from './public-scope'
import type { CourseHubViewDto, OperatorHubOpeningDto } from '../../../shared/types/api'

export const OPERATOR_HUB_OPENING_LIMIT = 200

export interface HubOpening {
  status: HubOpeningStatus
  count: HubContentCount
  threshold: number
}

export const stagedOpeningOn = () => isFeatureOn('hubStagedOpening')

/** 과목 행의 정본 id(병합은 한 단계로 유지됨: 병합 때 하위 병합도 새 정본을 가리키게 바꿈). */
const canonicalOf = sql<string>`coalesce(${courses.mergedInto}, ${courses.id})`

/**
 * 정본 과목별 공개 사례·선배 노트 수. `canonicalIds`가 null이면 내용이 있는 모든 과목(운영자 화면). 0개인 과목은 결과에 없습니다.
 */
export async function hubContentCounts(db: DbExecutor, canonicalIds: readonly string[] | null, now: Date): Promise<Map<string, HubContentCount>> {
  const out = new Map<string, HubContentCount>()
  if (canonicalIds && canonicalIds.length === 0) return out
  const scope = (): SQL | undefined => (canonicalIds ? inArray(canonicalOf, [...canonicalIds]) : undefined)
  const caseRows = await db
    .select({ courseId: canonicalOf, n: sql<number>`count(*)::int` })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .innerJoin(courses, eq(courses.id, publicationCandidates.courseId))
    .where(and(servableReleaseSql(now), scope()))
    .groupBy(canonicalOf)
  const noteRows = await db
    .select({ courseId: canonicalOf, n: sql<number>`count(*)::int` })
    .from(seniorNotes)
    .innerJoin(courses, eq(courses.id, seniorNotes.courseId))
    .where(and(eq(seniorNotes.status, 'published'), scope()))
    .groupBy(canonicalOf)
  for (const r of caseRows) out.set(r.courseId, { cases: r.n, notes: 0 })
  for (const r of noteRows) out.set(r.courseId, { cases: out.get(r.courseId)?.cases ?? 0, notes: r.n })
  return out
}

/** 정본 과목들의 저장된 개방 시각. */
async function hubOpenedAts(db: DbExecutor, canonicalIds: readonly string[]): Promise<Map<string, Date>> {
  if (canonicalIds.length === 0) return new Map()
  const rows = await db
    .select({ id: courses.id, hubOpenedAt: courses.hubOpenedAt })
    .from(courses)
    .where(and(inArray(courses.id, [...canonicalIds]), isNotNull(courses.hubOpenedAt)))
  return new Map(rows.map((r) => [r.id, r.hubOpenedAt!]))
}

/** 기준 이상을 본 과목의 개방 시각을 채웁니다. 조건부 갱신이라 동시에 여러 요청이 와도 처음 값이 남습니다. */
async function latchHubOpened(db: DbExecutor, canonicalIds: readonly string[], now: Date): Promise<void> {
  if (canonicalIds.length === 0) return
  await db
    .update(courses)
    .set({ hubOpenedAt: now })
    .where(and(inArray(courses.id, [...canonicalIds]), isNull(courses.hubOpenedAt)))
}

/** 정본 과목 하나의 개방 상태. 플래그가 꺼져 있으면 세지 않고 쓰지 않고 open. 기준 이상이면 개방 시각을 저장합니다(ADR 0060 D-07). */
export async function courseHubOpening(db: DbExecutor, canonicalCourseId: string, now: Date): Promise<HubOpening> {
  const threshold = hubOpenThreshold()
  if (!stagedOpeningOn()) return { status: 'open', count: { cases: 0, notes: 0 }, threshold }
  const count = (await hubContentCounts(db, [canonicalCourseId], now)).get(canonicalCourseId) ?? { cases: 0, notes: 0 }
  const openedAt = (await hubOpenedAts(db, [canonicalCourseId])).get(canonicalCourseId) ?? null
  const status = hubOpeningStatus(count, threshold, true, openedAt)
  if (status === 'open' && !openedAt) await latchHubOpened(db, [canonicalCourseId], now)
  return { status, count, threshold }
}

/** 정본 과목 id들 중 허브가 열린 것(플래그가 꺼져 있으면 모두). */
export async function openCourseIds(db: DbExecutor, canonicalIds: readonly string[], now: Date): Promise<Set<string>> {
  const unique = [...new Set(canonicalIds)]
  if (!stagedOpeningOn()) return new Set(unique)
  const threshold = hubOpenThreshold()
  const counts = await hubContentCounts(db, unique, now)
  const opened = await hubOpenedAts(db, unique)
  const open = unique.filter((id) => hubOpeningStatus(counts.get(id) ?? { cases: 0, notes: 0 }, threshold, true, opened.get(id) ?? null) === 'open')
  await latchHubOpened(db, open.filter((id) => !opened.has(id)), now)
  return new Set(open)
}

/**
 * 검색용 SQL 조건: `courseColumn`(병합 전 id일 수 있음)의 허브가 열렸는지(ADR 0060 D-07, 결과 제한 전에 거르기 위해 hubContentCounts와 같은 규칙을 SQL로).
 * 저장된 개방 시각이 있거나 공개 사례 + 선배 노트 합계가 기준 이상. 읽기만 하고 개방 시각을 쓰지는 않습니다. 플래그가 꺼져 있으면 조건 없음.
 */
export function hubOpenSql(courseColumn: SQLWrapper, now: Date): SQL | undefined {
  if (!stagedOpeningOn()) return undefined
  return sql`exists (
    select 1 from ${courses} hc
    join ${courses} hcanon on hcanon.id = coalesce(hc.merged_into, hc.id)
    where hc.id = ${courseColumn}
      and (hcanon.hub_opened_at is not null or (
        (select count(*) from ${seniorNotes} hn join ${courses} hnc on hnc.id = hn.course_id
          where hn.status = 'published' and coalesce(hnc.merged_into, hnc.id) = hcanon.id)
        + (select count(*) from ${publications}
            join ${publicationCandidates} on ${publicationCandidates.id} = ${publications.currentReleaseId}
            join ${projects} on ${projects.id} = ${publications.projectId}
            join ${courses} hpc on hpc.id = ${publicationCandidates.courseId}
            where ${servableReleaseSql(now)} and coalesce(hpc.merged_into, hpc.id) = hcanon.id)
      ) >= ${hubOpenThreshold()})
  )`
}

/**
 * GET /public/courses/:id — 열린 허브(`getPublicCourseHub`) 또는 "준비 중". 없거나 형식이 틀리면 404. 병합된 id면 정본(course.id가 정본).
 * "준비 중"에는 과목 이름·학교와 개방 진행(이미 공개된 항목 수 / 기준)만 싣습니다. 내용 목록을 만들지 않으려고 허브 조회 자체를 부르지 않습니다.
 */
export async function getCourseHubView(db: DbExecutor, courseId: unknown, now = new Date()): Promise<CourseHubViewDto> {
  if (!stagedOpeningOn()) return getPublicCourseHub(db, courseId, now)
  const course = await loadCanonicalCourse(db, courseId).catch(() => {
    throw notFound()
  })
  const opening = await courseHubOpening(db, course.id, now)
  if (opening.status === 'open') return getPublicCourseHub(db, course.id, now)
  const [school] = await db.select({ name: schools.name }).from(schools).where(eq(schools.id, course.schoolId)).limit(1)
  return {
    status: 'preparing',
    course: { id: course.id, title: course.title, code: course.code, school: { name: school?.name ?? '' }, authoredBy: 'student' },
    opening: { count: opening.count.cases + opening.count.notes, threshold: opening.threshold },
  }
}

/**
 * GET /operator/course-hubs/opening — 운영자만(403 operator_only). 공개 사례·선배 노트가 하나라도 있는 정본 과목별 수와 개방 여부
 * (합계 많은 순, 최대 200개). 사람·알림 신청·등록 정보는 싣지 않습니다. 플래그가 꺼져 있어도 진행은 보여 줍니다(켜기 전에 판단하도록).
 */
export async function getHubOpeningProgress(db: DbExecutor, actor: Actor, now = new Date()): Promise<OperatorHubOpeningDto> {
  await requireOperator(db, actor)
  const stagedOpening = stagedOpeningOn()
  const threshold = hubOpenThreshold()
  const counts = await hubContentCounts(db, null, now)
  // 내용이 있는 과목 + 한 번 열린 과목(지금 내용이 줄었어도 열려 있음).
  const latched = await db.select({ id: courses.id }).from(courses).where(and(isNotNull(courses.hubOpenedAt), isNull(courses.mergedInto)))
  const ids = [...new Set([...counts.keys(), ...latched.map((r) => r.id)])]
  const rows = ids.length
    ? await db
        .select({ id: courses.id, title: courses.title, code: courses.code, schoolName: schools.name, hubOpenedAt: courses.hubOpenedAt })
        .from(courses)
        .innerJoin(schools, eq(schools.id, courses.schoolId))
        .where(and(inArray(courses.id, ids), isNull(courses.mergedInto)))
    : []
  const all = rows.map((c) => {
    const count = counts.get(c.id) ?? { cases: 0, notes: 0 }
    return {
      course: { id: c.id, title: c.title, code: c.code, schoolName: c.schoolName },
      cases: count.cases,
      notes: count.notes,
      total: count.cases + count.notes,
      // 플래그가 꺼져 있어도 켰을 때의 상태를 보여 줍니다. 이 화면은 개방 시각을 쓰지 않습니다.
      status: hubOpeningStatus(count, threshold, true, c.hubOpenedAt),
      openedAt: c.hubOpenedAt?.toISOString() ?? null,
    }
  })
  all.sort((a, b) => b.total - a.total || a.course.title.localeCompare(b.course.title, 'ko') || a.course.id.localeCompare(b.course.id))
  const open = all.filter((i) => i.status === 'open').length
  return {
    stagedOpening,
    threshold,
    summary: { coursesWithContent: all.length, open, preparing: all.length - open },
    items: all.slice(0, OPERATOR_HUB_OPENING_LIMIT),
  }
}
