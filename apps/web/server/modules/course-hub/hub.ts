/**
 * 공개 과목 허브 (T-13, PROOFU_EVOLUTION_PLAN §8.1–§8.2·§8.6·§13.2, SYSTEM_DESIGN §11.2, DELIVERY_PLAN 시나리오 F, ADR 0013).
 *
 * `GET /api/v1/public/courses/:id` — 로그인 불필요, 쿠키 없음, 요청마다 DB 상태 확인(ADR 0012의 공개 조회 규칙 그대로).
 * 데이터 출처(이것 말고는 읽지 않음):
 * - 과목·학교 이름, 개념 태그: 학생이 작성한 카탈로그(“학생 작성” 표시). 교수 실명·평가 필드는 없습니다.
 * - 공개 사례·막힘 카드: 이 과목(정본 + 병합된 id)에 연결된 **지금 게시 중인 release의 저장된 스냅샷**만(`servableReleaseSql`:
 *   공개·release 게시 상태, 지금 release, 엠바고 없음을 같은 쿼리에서 확인). 초안·준비·철회·대체·엠바고 중인 것은 나오지 않습니다.
 * - 선배 노트: status = 'published'만. 작성자 id는 싣지 않습니다.
 * - 막힘 Q&A(C-09, ADR 0025): course_qa_items의 status = 'published'만(복사한 글과 고른 이름뿐, 커뮤니티 테이블과 조인하지 않음).
 * - 유용성 신호: 위에서 고른 공개 항목에 대해서만 항목별 개수. 작성자별 합계는 만들지 않습니다.
 * - 워크로드 분포: 이 과목 학기에 연결된 프로젝트의 체크인 중 `share_for_stats = true`만, 동의한 사람이 5명 미만이면 null
 *   (@peerchive/domain aggregateCheckinStats). 개인을 구분할 값은 결과에 없습니다.
 * - 다른 학교에서는: 같은 개념 태그를 가진 다른 학교의 정본 과목(최대 5개).
 * - 이번 학기 수강 중(E-01, ADR 0046): 지금 학기에 이 과목을 등록한 active 사용자 수만(course-registrations/enrollment-count.ts), 5명 미만이면 null.
 *
 * 단계적 개방(E-02, ADR 0047): 이 함수는 열린 허브의 내용을 만듭니다. HTTP 경로는 `staged-opening.ts`의 `getCourseHubView`를 거쳐,
 * 플래그가 켜져 있고 기준 미만이면 이 함수를 부르지 않고 "준비 중"만 돌려줍니다.
 */
import {
  CHECKIN_STATS_MIN_GROUP,
  aggregateCheckinStats,
  extractStuckItems,
  rankStuckItems,
  seniorNoteAuthorLabel,
  isPersonaSeniorNoteMode,
  type CheckinTimeBucket,
  type HubSnapshot,
} from '@peerchive/domain'
import {
  and,
  courseConceptTags,
  courseTerms,
  courses,
  desc,
  eq,
  inArray,
  isNull,
  ne,
  planForks,
  projects,
  publicationCandidates,
  publications,
  schools,
  seniorNotes,
  sql,
  usefulnessSignals,
  weeklyCheckins,
  type DbExecutor,
} from '@peerchive/db'
import { loadCanonicalCourse } from '../catalog/catalog'
import { listCourseTags } from '../catalog/tags'
import { hubEnrollment } from '../course-registrations/enrollment-count'
import { notFound } from '../errors'
import { loadHiddenItems, redactSnapshot } from '../moderation/hidden-items'
import { publishedCourseQa } from './course-qa'
import { courseScopeSql, servableReleaseSql } from './public-scope'
import type {
  ConceptTagDto,
  CourseHubCaseDto,
  CourseHubRelatedDto,
  CourseHubStuckDto,
  CourseHubWorkloadDto,
  PublicCourseHubDto,
  PublicSeniorNoteDto,
  PublicSnapshot,
  SeniorNoteAnswers,
  SignalCountsDto,
} from '../../../shared/types/api'

export const HUB_CASE_LIMIT = 50
export const HUB_STUCK_LIMIT = 30
export const HUB_NOTE_LIMIT = 50
export const HUB_RELATED_LIMIT = 5
export const WORKLOAD_INSUFFICIENT_MESSAGE = '아직 데이터가 충분하지 않음'

export const publicCasePath = (slug: string) => `/p/${slug}`
export const publicStuckPath = (slug: string, key: string) => `/p/${slug}#public-${key}`

/** 게시된 release 하나(과목 허브·검색·포크가 같은 모양으로 씀). */
export interface ServableRelease {
  publicationId: string
  slug: string
  releaseId: string
  level: 'summary' | 'full'
  termLabel: string | null
  publishedAt: Date
  snapshot: PublicSnapshot
}

/** 이 과목(정본 + 병합된 id)에 연결된, 지금 게시 중인 release들(최근 게시 순). 스냅샷은 운영 조치로 가린 항목을 뺀 사본입니다(T-15). */
export async function servableReleasesForCourse(
  db: DbExecutor,
  canonicalCourseId: string,
  now: Date,
  limit = HUB_CASE_LIMIT,
): Promise<ServableRelease[]> {
  const rows = await db
    .select({
      publicationId: publications.id,
      slug: publications.slug,
      releaseId: publicationCandidates.id,
      level: publicationCandidates.level,
      termLabel: publicationCandidates.termLabel,
      publishedAt: publicationCandidates.publishedAt,
      snapshot: publicationCandidates.snapshot,
    })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .where(and(servableReleaseSql(now), sql`${publicationCandidates.courseId} in ${courseScopeSql(canonicalCourseId)}`))
    .orderBy(desc(publicationCandidates.publishedAt), desc(publicationCandidates.id))
    .limit(limit)
  const hidden = await loadHiddenItems(db, rows.map((r) => r.publicationId))
  return rows.map((r) => ({
    ...r,
    publishedAt: r.publishedAt!,
    snapshot: redactSnapshot(r.snapshot as unknown as PublicSnapshot, hidden.get(r.publicationId) ?? []).snapshot,
  }))
}

/** 공개별 포크 수(서로 다른 사용자 수 = 행 수, (공개, 사용자) unique). */
export async function forkCounts(db: DbExecutor, publicationIds: readonly string[]): Promise<Map<string, number>> {
  if (publicationIds.length === 0) return new Map()
  const rows = await db
    .select({ id: planForks.sourcePublicationId, n: sql<number>`count(*)::int` })
    .from(planForks)
    .where(inArray(planForks.sourcePublicationId, [...publicationIds]))
    .groupBy(planForks.sourcePublicationId)
  return new Map(rows.map((r) => [r.id, r.n]))
}

const emptyCounts = (): SignalCountsDto => ({ meToo: 0, helped: 0 })

/** 막힘 카드별 신호 수. 호출자가 지금 공개인 공개 id만 넘깁니다(철회된 대상의 신호는 셀 일이 없음). */
export async function stuckSignalCounts(db: DbExecutor, publicationIds: readonly string[]): Promise<Map<string, SignalCountsDto>> {
  const out = new Map<string, SignalCountsDto>()
  if (publicationIds.length === 0) return out
  const rows = await db
    .select({
      publicationId: usefulnessSignals.publicationId,
      itemKey: usefulnessSignals.itemKey,
      kind: usefulnessSignals.kind,
      n: sql<number>`count(*)::int`,
    })
    .from(usefulnessSignals)
    .where(and(eq(usefulnessSignals.targetKind, 'stuck_item'), inArray(usefulnessSignals.publicationId, [...publicationIds])))
    .groupBy(usefulnessSignals.publicationId, usefulnessSignals.itemKey, usefulnessSignals.kind)
  for (const r of rows) {
    const key = `${r.publicationId}:${r.itemKey}`
    const counts = out.get(key) ?? emptyCounts()
    if (r.kind === 'me_too') counts.meToo = r.n
    else counts.helped = r.n
    out.set(key, counts)
  }
  return out
}

/** 노트별 신호 수(게시된 노트 id만 넘김). */
export async function noteSignalCounts(db: DbExecutor, noteIds: readonly string[]): Promise<Map<string, SignalCountsDto>> {
  const out = new Map<string, SignalCountsDto>()
  if (noteIds.length === 0) return out
  const rows = await db
    .select({ noteId: usefulnessSignals.seniorNoteId, kind: usefulnessSignals.kind, n: sql<number>`count(*)::int` })
    .from(usefulnessSignals)
    .where(and(eq(usefulnessSignals.targetKind, 'senior_note'), inArray(usefulnessSignals.seniorNoteId, [...noteIds])))
    .groupBy(usefulnessSignals.seniorNoteId, usefulnessSignals.kind)
  for (const r of rows) {
    const counts = out.get(r.noteId!) ?? emptyCounts()
    if (r.kind === 'me_too') counts.meToo = r.n
    else counts.helped = r.n
    out.set(r.noteId!, counts)
  }
  return out
}

export function toPublicSeniorNote(row: typeof seniorNotes.$inferSelect, signals: SignalCountsDto): PublicSeniorNoteDto {
  return {
    id: row.id,
    // A-06: 소속 표시 노트는 복사한 소속 표시만(이름·페르소나 없음 — 익명과 같이 다룸). 원 글·옮기기와의 연결은 싣지 않습니다.
    author: seniorNoteAuthorLabel(row.displayMode, row.displayNameSnapshot, row.affiliationLabel),
    anonymous: !isPersonaSeniorNoteMode(row.displayMode),
    affiliated: row.displayMode === 'affiliation',
    termLabel: row.termLabel,
    totalTimeBucket: row.totalTimeBucket,
    answers: row.answers as SeniorNoteAnswers,
    publishedAt: row.publishedAt!.toISOString(),
    signals,
  }
}

function toCase(release: ServableRelease, forks: number): CourseHubCaseDto {
  const s = release.snapshot
  return {
    slug: release.slug,
    path: publicCasePath(release.slug),
    title: s.title,
    termLabel: release.termLabel,
    level: release.level,
    kind: s.kind,
    teamSize: s.kind !== 'individual' ? s.members.length : null,
    milestoneCount: s.milestones.length,
    stuckCount: s.logs.filter((l) => l.tag === 'stuck').length,
    retrospective: s.retrospective,
    forkCount: forks,
    publishedAt: release.publishedAt.toISOString(),
  }
}

async function workloadFor(db: DbExecutor, canonicalCourseId: string): Promise<CourseHubWorkloadDto> {
  // 통계 공유에 동의한 체크인만 가져옵니다(동의하지 않은 행은 쿼리 단계에서 빠짐). 결과에는 분포만 남습니다.
  const rows = await db
    .select({
      userId: weeklyCheckins.userId,
      timeBucket: weeklyCheckins.timeBucket,
      difficulty: weeklyCheckins.difficulty,
      shareForStats: weeklyCheckins.shareForStats,
    })
    .from(weeklyCheckins)
    .innerJoin(projects, eq(projects.id, weeklyCheckins.projectId))
    .innerJoin(courseTerms, eq(courseTerms.id, projects.courseTermId))
    .where(and(eq(weeklyCheckins.shareForStats, true), sql`${courseTerms.courseId} in ${courseScopeSql(canonicalCourseId)}`))
  const stats = aggregateCheckinStats(rows.map((r) => ({ ...r, timeBucket: r.timeBucket as CheckinTimeBucket })))
  return {
    stats: stats
      ? {
          contributors: stats.contributors,
          timeBuckets: stats.timeBuckets,
          difficulty: { '1': stats.difficulty[1], '2': stats.difficulty[2], '3': stats.difficulty[3], '4': stats.difficulty[4], '5': stats.difficulty[5] },
        }
      : null,
    minGroup: CHECKIN_STATS_MIN_GROUP,
    message: stats ? null : WORKLOAD_INSUFFICIENT_MESSAGE,
  }
}

async function relatedCourses(db: DbExecutor, course: { id: string; schoolId: string }, tags: readonly ConceptTagDto[]): Promise<CourseHubRelatedDto[]> {
  if (tags.length === 0) return []
  const tagById = new Map(tags.map((t) => [t.id, t]))
  const tagIds = [...tagById.keys()]
  const rows = await db
    .select({
      tag: { id: courseConceptTags.tagId },
      course: { id: courses.id, title: courses.title, code: courses.code },
      schoolName: schools.name,
    })
    .from(courseConceptTags)
    .innerJoin(courses, eq(courses.id, courseConceptTags.courseId))
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(
      and(
        inArray(courseConceptTags.tagId, [...tagIds]),
        isNull(courses.mergedInto),
        ne(courses.id, course.id),
        ne(courses.schoolId, course.schoolId),
      ),
    )
    .limit(500)
  const byCourse = new Map<string, { course: (typeof rows)[number]['course']; schoolName: string; tagIds: Set<string> }>()
  for (const r of rows) {
    const entry = byCourse.get(r.course.id) ?? { course: r.course, schoolName: r.schoolName, tagIds: new Set<string>() }
    entry.tagIds.add(r.tag.id)
    byCourse.set(r.course.id, entry)
  }
  return [...byCourse.values()]
    .sort((a, b) => b.tagIds.size - a.tagIds.size || a.course.title.localeCompare(b.course.title, 'ko'))
    .slice(0, HUB_RELATED_LIMIT)
    .map((e) => ({
      id: e.course.id,
      title: e.course.title,
      code: e.course.code,
      schoolName: e.schoolName,
      sharedTags: [...e.tagIds].map((id) => tagById.get(id)!).sort((a, b) => a.slug.localeCompare(b.slug)),
    }))
}

/** GET /public/courses/:id — 없거나 형식이 틀리면 404. 병합된 id면 정본의 허브(course.id가 정본). */
export async function getPublicCourseHub(db: DbExecutor, courseId: unknown, now = new Date()): Promise<PublicCourseHubDto> {
  const course = await loadCanonicalCourse(db, courseId).catch(() => {
    throw notFound()
  })
  const [school] = await db.select({ name: schools.name }).from(schools).where(eq(schools.id, course.schoolId)).limit(1)
  const tags = await listCourseTags(db, course.id)

  const releases = await servableReleasesForCourse(db, course.id, now)
  const publicationIds = releases.map((r) => r.publicationId)
  const forks = await forkCounts(db, publicationIds)
  const signals = await stuckSignalCounts(db, publicationIds)

  const cases = releases.map((r) => toCase(r, forks.get(r.publicationId) ?? 0))
  const stuck: CourseHubStuckDto[] = []
  for (const release of releases) {
    for (const item of extractStuckItems(release.snapshot as unknown as HubSnapshot)) {
      stuck.push({
        slug: release.slug,
        caseTitle: release.snapshot.title,
        key: item.key,
        symptom: item.symptom,
        keywords: item.keywords,
        timeBucket: item.timeBucket,
        resolved: item.resolved,
        recordedAt: item.recordedAt,
        path: publicStuckPath(release.slug, item.key),
        signals: signals.get(`${release.publicationId}:${item.key}`) ?? emptyCounts(),
      })
    }
  }
  const stuckItems = rankStuckItems(stuck.map((s) => ({ ...s, meToo: s.signals.meToo, helped: s.signals.helped })))
    .slice(0, HUB_STUCK_LIMIT)
    .map(({ meToo: _m, helped: _h, ...rest }) => rest)

  const noteRows = await db
    .select()
    .from(seniorNotes)
    .where(and(eq(seniorNotes.status, 'published'), sql`${seniorNotes.courseId} in ${courseScopeSql(course.id)}`))
    .orderBy(desc(seniorNotes.publishedAt), desc(seniorNotes.id))
    .limit(HUB_NOTE_LIMIT)
  const noteSignals = await noteSignalCounts(db, noteRows.map((n) => n.id))

  const otherSchools = await relatedCourses(db, course, tags)

  return {
    status: 'open',
    course: { id: course.id, title: course.title, code: course.code, school: { name: school?.name ?? '' }, authoredBy: 'student' },
    conceptTags: tags,
    cases,
    stuckItems,
    seniorNotes: noteRows.map((n) => toPublicSeniorNote(n, noteSignals.get(n.id) ?? emptyCounts())),
    qaItems: await publishedCourseQa(db, course.id),
    workload: await workloadFor(db, course.id),
    otherSchools,
    // E-01: 지금 학기 등록 인원(5명 미만이면 null). 등록 테이블은 이 집계 함수로만 읽습니다.
    enrollment: await hubEnrollment(db, course.id, now),
  }
}
