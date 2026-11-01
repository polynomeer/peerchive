/**
 * 운영자 병합 (T-10, PROOFU_EVOLUTION_PLAN §8.2 "운영자 병합", SYSTEM_DESIGN §6.2 "정규화는 병합으로", ADR 0010).
 *
 * 전략: 한 트랜잭션에서 원본을 가리키던 행을 정본으로 다시 가리키게 하고(eager re-pointing), 원본에는 merged_into를 남깁니다.
 * 행은 지우지 않습니다(연결 행 course_concept_tags만 옮긴 뒤 원본 연결을 지움).
 * - 학교: 원본 학교의 과목 → 정본 학교. 같은 이름 과목이 모이면 운영자가 과목을 이어서 병합합니다.
 *   학교 메일 도메인(school_email_domains)과 학교 메일 인증(institution_affiliations)도 정본으로 옮깁니다(C-01, ADR 0018). 한 사용자가 두 학교 모두에
 *   진행 중(pending·active) 인증이 있으면 정본 쪽을 남기고 원본 쪽을 revoked(merged_duplicate)로 끝냅니다(정본 쪽이 pending이고 원본이 active면
 *   원본을 남기고 정본 쪽 요청을 만료).
 * - 과목: 같은 학교끼리만(다르면 409 different_school — 학교를 먼저 병합). 원본 과목의 학기는 정본 과목으로 옮기고,
 *   정본에 같은 (연도, 학기)가 있으면 원본 학기를 그 학기로 병합해 프로젝트·학기 엠바고를 옮깁니다. 옮겨진 프로젝트의
 *   embargo_until은 단조 규칙대로 max(지금 값, 정본 학기 종료·학기 엠바고)입니다. 개념 태그 연결도 정본으로 옮깁니다.
 *   과목 허브(T-13)의 공개 release 과목 연결(publication_candidates.course_id)과 선배 노트(senior_notes.course_id)도 정본으로 옮깁니다.
 * - 개념 태그: 과목 연결과 하위 태그(parent_id)를 정본으로 옮깁니다.
 * 순환·사슬 방지: 대상은 정본(merged_into null)이어야 하고 원본도 아직 병합되지 않아야 하며(checkMerge),
 * 원본을 가리키던 병합 행도 정본을 가리키게 바꿔(평탄화) 항상 한 단계입니다.
 */
import { z } from 'zod'
import { checkMerge, raiseEmbargo, type MergeCheck } from '@peerchive/domain'
import {
  and,
  conceptTags,
  courseConceptTags,
  courseHubNotices,
  courseRegistrations,
  courseTerms,
  courses,
  embargoes,
  eq,
  inArray,
  institutionAffiliations,
  isNull,
  ne,
  projects,
  publicationCandidates,
  schoolEmailDomains,
  schools,
  seniorNotes,
  courseQaItems,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound } from '../errors'
import { isUuid } from '../projects/access'
import { parseInput } from '../validation'
import { requireOperator } from './operators'
import { toConceptTagDto } from './tags'
import { toCourseDto, toSchoolDto } from './catalog'
import type { ConceptTagDto, CourseDto, SchoolDto } from '../../../shared/types/api'

export const mergeSchema = z.object({
  into: z.uuid({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') }).transform((id) => id.toLowerCase()),
})

function throwMergeError(check: MergeCheck): void {
  if (check.ok) return
  switch (check.error) {
    case 'self':
      throw invalid({ into: 'self' })
    case 'source_merged':
      throw conflict('already_merged')
    case 'target_merged':
      throw conflict('target_merged')
    case 'different_school':
      throw conflict('different_school')
  }
}

/** 운영자 확인 → 입력 → 두 행을 id 순서로 잠급니다(교착 방지). 원본이 없으면 404, 대상이 없으면 422. */
async function lockPair<Row extends { id: string }>(
  load: (id: string) => Promise<Row | undefined>,
  sourceId: string,
  targetId: string,
): Promise<{ source: Row; target: Row }> {
  const ordered = [sourceId, targetId].sort()
  const rows = new Map<string, Row>()
  for (const id of ordered) {
    const row = await load(id)
    if (row) rows.set(id, row)
  }
  const source = rows.get(sourceId)
  if (!source) throw notFound()
  const target = rows.get(targetId)
  if (!target) throw invalid({ into: 'not_found' })
  return { source, target }
}

/** POST /operator/schools/:id/merge {into} — 운영자만(403). 200 + 정본 학교. */
export async function mergeSchool(db: DbExecutor, actor: Actor, sourceId: unknown, rawInput: unknown, now = new Date()): Promise<SchoolDto> {
  await requireOperator(db, actor)
  const input = parseInput(mergeSchema, rawInput)
  if (!isUuid(sourceId)) throw notFound()
  if (sourceId.toLowerCase() === input.into) throw invalid({ into: 'self' })
  return db.transaction(async (tx) => {
    const load = async (id: string) => (await tx.select().from(schools).where(eq(schools.id, id)).limit(1).for('update'))[0]
    const { source, target } = await lockPair(load, sourceId.toLowerCase(), input.into)
    throwMergeError(checkMerge(source, target))
    // 대학이 아닌 기관(I-01, ADR 0037)은 병합하지 않습니다(기수·초대 코드·수료증을 옮기는 규칙이 없음).
    if (source.kind !== 'university' || target.kind !== 'university') throw conflict('not_university')

    const moved = await tx.update(courses).set({ schoolId: target.id }).where(eq(courses.schoolId, source.id)).returning({ id: courses.id })
    // 학교 메일 인증: 같은 사용자가 두 학교 모두에 진행 중 인증이 있으면 하나만 남깁니다(사용자·학교당 진행 중 하나 — 부분 unique).
    const open = inArray(institutionAffiliations.status, ['pending', 'active'])
    const sourceOpen = await tx.select().from(institutionAffiliations).where(and(eq(institutionAffiliations.schoolId, source.id), open)).for('update')
    const targetOpen = sourceOpen.length
      ? await tx
          .select()
          .from(institutionAffiliations)
          .where(and(eq(institutionAffiliations.schoolId, target.id), open, inArray(institutionAffiliations.userId, sourceOpen.map((r) => r.userId))))
          .for('update')
      : []
    let affiliationsClosed = 0
    for (const src of sourceOpen) {
      const twin = targetOpen.find((t) => t.userId === src.userId)
      if (!twin) continue
      // active가 pending보다 우선, 둘 다 같으면 정본 쪽을 남깁니다.
      const closeSource = !(src.status === 'active' && twin.status === 'pending')
      const loser = closeSource ? src : twin
      await tx
        .update(institutionAffiliations)
        .set(
          loser.status === 'active'
            ? { status: 'revoked', emailHash: null, revokedAt: now, revokedReason: 'merged_duplicate', updatedAt: now }
            : { status: 'expired', emailHash: null, updatedAt: now },
        )
        .where(eq(institutionAffiliations.id, loser.id))
      affiliationsClosed++
    }
    const affiliationsMoved = await tx
      .update(institutionAffiliations)
      .set({ schoolId: target.id })
      .where(eq(institutionAffiliations.schoolId, source.id))
      .returning({ id: institutionAffiliations.id })
    const domainsMoved = await tx
      .update(schoolEmailDomains)
      .set({ schoolId: target.id })
      .where(eq(schoolEmailDomains.schoolId, source.id))
      .returning({ id: schoolEmailDomains.id })
    await tx.update(schools).set({ mergedInto: target.id }).where(eq(schools.mergedInto, source.id))
    await tx.update(schools).set({ mergedInto: target.id, mergedAt: now }).where(eq(schools.id, source.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'school.merge',
      targetType: 'school',
      targetId: source.id,
      metadata: {
        into: target.id,
        coursesMoved: moved.length,
        affiliationsMoved: affiliationsMoved.length,
        affiliationsClosed,
        emailDomainsMoved: domainsMoved.length,
      },
    })
    return toSchoolDto(target)
  })
}

/** POST /operator/courses/:id/merge {into} — 운영자만(403). 200 + 정본 과목. */
export async function mergeCourse(db: DbExecutor, actor: Actor, sourceId: unknown, rawInput: unknown, now = new Date()): Promise<CourseDto> {
  await requireOperator(db, actor)
  const input = parseInput(mergeSchema, rawInput)
  if (!isUuid(sourceId)) throw notFound()
  if (sourceId.toLowerCase() === input.into) throw invalid({ into: 'self' })
  return db.transaction(async (tx) => {
    const load = async (id: string) => (await tx.select().from(courses).where(eq(courses.id, id)).limit(1).for('update'))[0]
    const { source, target } = await lockPair(load, sourceId.toLowerCase(), input.into)
    throwMergeError(checkMerge(source, target))

    // 학기: 정본에 같은 (연도, 학기)가 있으면 병합, 없으면 정본 과목으로 옮김.
    const sourceTerms = await tx
      .select()
      .from(courseTerms)
      .where(and(eq(courseTerms.courseId, source.id), isNull(courseTerms.mergedInto)))
      .for('update')
    const targetTerms = await tx.select().from(courseTerms).where(eq(courseTerms.courseId, target.id)).for('update')
    let termsMoved = 0
    let termsMerged = 0
    let projectsRepointed = 0
    let registrationsRepointed = 0
    for (const term of sourceTerms) {
      const twin = targetTerms.find((t) => t.year === term.year && t.semester === term.semester && !t.mergedInto)
      if (!twin) {
        await tx.update(courseTerms).set({ courseId: target.id }).where(eq(courseTerms.id, term.id))
        termsMoved++
        continue
      }
      // 학기 엠바고를 정본 학기로 옮긴 뒤, 정본 학기의 종료·엠바고로 옮겨 갈 프로젝트의 엠바고를 올립니다(단조).
      await tx.update(embargoes).set({ courseTermId: twin.id }).where(eq(embargoes.courseTermId, term.id))
      const twinEmbargoes = await tx
        .select({ until: embargoes.until })
        .from(embargoes)
        .where(and(eq(embargoes.courseTermId, twin.id), isNull(embargoes.revokedAt)))
      const floor = raiseEmbargo(twin.endsAt, ...twinEmbargoes.map((e) => e.until))
      const repointed = await tx
        .update(projects)
        .set({ courseTermId: twin.id, embargoUntil: sql`greatest(${projects.embargoUntil}, ${floor?.toISOString() ?? null}::timestamptz)` })
        .where(eq(projects.courseTermId, term.id))
        .returning({ id: projects.id })
      projectsRepointed += repointed.length
      // 이번 학기 과목 등록(E-01)도 정본 학기로 옮깁니다. 같은 사람이 이미 정본 학기에 등록했으면 원본 쪽 행을 지웁니다(사람당 하나).
      await tx.execute(sql`
        delete from ${courseRegistrations} r where r.course_term_id = ${term.id}
          and exists (select 1 from ${courseRegistrations} t where t.course_term_id = ${twin.id} and t.user_id = r.user_id)`)
      const moved = await tx
        .update(courseRegistrations)
        .set({ courseTermId: twin.id })
        .where(eq(courseRegistrations.courseTermId, term.id))
        .returning({ id: courseRegistrations.id })
      registrationsRepointed += moved.length
      await tx.update(courseTerms).set({ mergedInto: twin.id }).where(eq(courseTerms.mergedInto, term.id))
      await tx.update(courseTerms).set({ mergedInto: twin.id }).where(eq(courseTerms.id, term.id))
      termsMerged++
    }

    // 개념 태그 연결 옮기기(이미 있으면 건너뜀). 병합으로 12개를 넘을 수 있습니다(운영자 정리 대상).
    await tx.execute(sql`
      insert into ${courseConceptTags} (course_id, tag_id, added_by, created_at)
      select ${target.id}, tag_id, added_by, created_at from ${courseConceptTags} where course_id = ${source.id}
      on conflict do nothing`)
    await tx.delete(courseConceptTags).where(eq(courseConceptTags.courseId, source.id))

    // 과목 허브(T-13): 공개 release의 과목 연결과 선배 노트를 정본으로 옮깁니다(rehome). 공개 읽기도 병합된 id를 함께 보므로
    // 이 갱신이 없어도 보이지만, 정본 하나로 모아 두어 다음 병합·집계가 단순해집니다.
    const releasesRehomed = await tx
      .update(publicationCandidates)
      .set({ courseId: target.id })
      .where(eq(publicationCandidates.courseId, source.id))
      .returning({ id: publicationCandidates.id })
    const notesRehomed = await tx
      .update(seniorNotes)
      .set({ courseId: target.id })
      .where(eq(seniorNotes.courseId, source.id))
      .returning({ id: seniorNotes.id })
    // 막힘 Q&A(C-09)도 같은 방식으로 정본에 모읍니다.
    const qaRehomed = await tx
      .update(courseQaItems)
      .set({ courseId: target.id })
      .where(eq(courseQaItems.courseId, source.id))
      .returning({ id: courseQaItems.id })

    // 과목 허브 단계적 개방(E-02)의 본인 알림 행도 정본으로 옮깁니다. 같은 사람·종류가 정본에 이미 있으면 원본 쪽 행을 지웁니다.
    // 신청 수가 운영자에게 드러나지 않도록 감사 metadata에는 옮긴 수를 남기지 않습니다.
    await tx.execute(sql`
      delete from ${courseHubNotices} n where n.course_id = ${source.id}
        and exists (select 1 from ${courseHubNotices} t where t.course_id = ${target.id} and t.user_id = n.user_id and t.kind = n.kind)`)
    await tx.update(courseHubNotices).set({ courseId: target.id }).where(eq(courseHubNotices.courseId, source.id))

    await tx.update(courses).set({ mergedInto: target.id }).where(eq(courses.mergedInto, source.id))
    await tx.update(courses).set({ mergedInto: target.id, mergedAt: now }).where(eq(courses.id, source.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'course.merge',
      targetType: 'course',
      targetId: source.id,
      metadata: {
        into: target.id,
        termsMoved,
        termsMerged,
        projectsRepointed,
        registrationsRepointed,
        releasesRehomed: releasesRehomed.length,
        seniorNotesRehomed: notesRehomed.length,
        courseQaRehomed: qaRehomed.length,
      },
    })
    return toCourseDto(target)
  })
}

/** POST /operator/concept-tags/:id/merge {into} — 운영자만(403). 200 + 정본 태그. */
export async function mergeConceptTag(
  db: DbExecutor,
  actor: Actor,
  sourceId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<ConceptTagDto> {
  await requireOperator(db, actor)
  const input = parseInput(mergeSchema, rawInput)
  if (!isUuid(sourceId)) throw notFound()
  if (sourceId.toLowerCase() === input.into) throw invalid({ into: 'self' })
  return db.transaction(async (tx) => {
    const load = async (id: string) => (await tx.select().from(conceptTags).where(eq(conceptTags.id, id)).limit(1).for('update'))[0]
    const { source, target } = await lockPair(load, sourceId.toLowerCase(), input.into)
    throwMergeError(checkMerge(source, target))

    await tx.execute(sql`
      insert into ${courseConceptTags} (course_id, tag_id, added_by, created_at)
      select course_id, ${target.id}, added_by, created_at from ${courseConceptTags} where tag_id = ${source.id}
      on conflict do nothing`)
    const unlinked = await tx.delete(courseConceptTags).where(eq(courseConceptTags.tagId, source.id)).returning({ courseId: courseConceptTags.courseId })
    // 하위 태그는 정본 아래로. 정본이 원본의 하위였다면 원본의 상위로 올립니다(자기 자신을 상위로 두지 않음).
    await tx.update(conceptTags).set({ parentId: target.id }).where(and(eq(conceptTags.parentId, source.id), ne(conceptTags.id, target.id)))
    if (target.parentId === source.id) {
      const parent = source.parentId && source.parentId !== target.id ? source.parentId : null
      await tx.update(conceptTags).set({ parentId: parent }).where(eq(conceptTags.id, target.id))
    }
    await tx.update(conceptTags).set({ mergedInto: target.id }).where(eq(conceptTags.mergedInto, source.id))
    await tx.update(conceptTags).set({ mergedInto: target.id, mergedAt: now }).where(eq(conceptTags.id, source.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'concept_tag.merge',
      targetType: 'concept_tag',
      targetId: source.id,
      metadata: { into: target.id, coursesRelinked: unlinked.length },
    })
    return toConceptTagDto(target)
  })
}
