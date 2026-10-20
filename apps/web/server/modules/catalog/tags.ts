/**
 * 개념 태그 (T-10, PROOFU_EVOLUTION_PLAN §8.1–§8.2, SYSTEM_DESIGN §6.2 ConceptTag).
 *
 * - 학생 작성. slug는 normalizeTagSlug(소문자, 한국어 허용, 공백 → 하이픈, 40자 이하)이며 전역에서 하나입니다.
 *   같은 slug가 이미 있으면 그 태그(병합됐으면 정본)를 씁니다.
 * - 로그인한 사용자는 과목에 기존 태그나 새 태그를 붙일 수 있습니다(과목당 12개, 이미 붙어 있으면 그대로 200).
 * - 비슷한 태그 정리는 운영자 병합으로 합니다(merge.ts).
 */
import { z } from 'zod'
import { CATALOG_SEARCH_LIMIT, COURSE_TAG_LIMIT, TAG_LABEL_MAX, normalizeLabel, normalizeTagSlug } from '@peerchive/domain'
import {
  and,
  asc,
  conceptTags,
  courseConceptTags,
  desc,
  eq,
  isNull,
  or,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid } from '../errors'
import { parseInput } from '../validation'
import { consumeCatalogCreate, loadCanonicalCourse } from './catalog'
import type { ConceptTagDto } from '../../../shared/types/api'

type TagRow = typeof conceptTags.$inferSelect

export const toConceptTagDto = (row: Pick<TagRow, 'id' | 'slug' | 'label'>): ConceptTagDto => ({
  id: row.id,
  slug: row.slug,
  label: row.label,
})

/** GET /concept-tags?q= — 정본 태그만, 최대 20개(slug 부분 일치·유사도, label 부분 일치). */
export async function searchConceptTags(db: DbExecutor, q: unknown): Promise<ConceptTagDto[]> {
  if (typeof q !== 'string') return []
  const normalized = normalizeTagSlug(q.slice(0, 100))
  if (!normalized.ok) return []
  const slug = normalized.slug
  const score = sql<number>`similarity(${conceptTags.slug}, ${slug})`
  const label = `%${normalizeLabel(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = await db
    .select({ id: conceptTags.id, slug: conceptTags.slug, label: conceptTags.label })
    .from(conceptTags)
    .where(
      and(
        isNull(conceptTags.mergedInto),
        or(
          sql`${conceptTags.slug} like ${`%${slug}%`}`,
          sql`${conceptTags.slug} % ${slug}`,
          sql`${conceptTags.label} ilike ${label}`,
        ),
      ),
    )
    .orderBy(sql`(${conceptTags.slug} = ${slug}) desc`, desc(score), asc(conceptTags.slug))
    .limit(CATALOG_SEARCH_LIMIT)
  return rows.map(toConceptTagDto)
}

/** 정본 과목의 태그(slug순). */
export async function listCourseTags(db: DbExecutor, courseId: string): Promise<ConceptTagDto[]> {
  const rows = await db
    .select({ id: conceptTags.id, slug: conceptTags.slug, label: conceptTags.label })
    .from(courseConceptTags)
    .innerJoin(conceptTags, eq(conceptTags.id, courseConceptTags.tagId))
    .where(and(eq(courseConceptTags.courseId, courseId), isNull(conceptTags.mergedInto)))
    .orderBy(asc(conceptTags.slug))
  return rows.map(toConceptTagDto)
}

/** 기존 태그(tagId) 또는 새 이름(label) 중 하나. 둘 다 오면 tagId를 씁니다. */
export const addCourseTagSchema = z
  .object({
    tagId: z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()).optional(),
    label: z
      .string({ error: 'invalid' })
      .transform(normalizeLabel)
      .pipe(z.string().min(1, { error: 'required' }).max(TAG_LABEL_MAX, { error: 'too_long' }))
      .optional(),
  })
  .transform((value, ctx): { tagId: string } | { label: string } => {
    if (value.tagId) return { tagId: value.tagId }
    if (value.label) return { label: value.label }
    ctx.addIssue({ code: 'custom', path: ['label'], message: 'required' })
    return z.NEVER
  })

/** slug의 태그(병합됐으면 정본). */
async function findTagBySlug(db: DbExecutor, slug: string): Promise<TagRow | null> {
  const [row] = await db.select().from(conceptTags).where(eq(conceptTags.slug, slug)).limit(1)
  return row ? resolveTag(db, row) : null
}

async function resolveTag(db: DbExecutor, row: TagRow): Promise<TagRow | null> {
  if (!row.mergedInto) return row
  const [canonical] = await db.select().from(conceptTags).where(eq(conceptTags.id, row.mergedInto)).limit(1)
  return canonical ?? null
}

export interface AddCourseTagResult {
  tags: ConceptTagDto[]
  tag: ConceptTagDto
  /** 새로 붙였으면 true(201), 이미 붙어 있었으면 false(200). */
  added: boolean
}

/**
 * POST /courses/:id/concept-tags {tagId} 또는 {label} — 로그인 사용자. 새 label이면 태그를 만들고(생성 한도),
 * 과목당 12개를 넘으면 409 limit_reached. 없는 tagId는 422 `{tagId: 'not_found'}`.
 */
export async function addCourseTag(
  db: DbExecutor,
  actor: Actor,
  courseId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<AddCourseTagResult> {
  const input = parseInput(addCourseTagSchema, rawInput)
  return db.transaction(async (tx) => {
    const course = await loadCanonicalCourse(tx, courseId)
    // 과목별 태그 붙이기를 직렬화해 12개 한도를 지킵니다.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`catalog-course-tags:${course.id}`}))`)

    const current = await listCourseTags(tx, course.id)
    const alreadyAttached = (t: TagRow) => current.some((c) => c.id === t.id)

    let tag: TagRow | null
    let createdTag = false
    if ('tagId' in input) {
      const [row] = await tx.select().from(conceptTags).where(eq(conceptTags.id, input.tagId)).limit(1)
      tag = row ? await resolveTag(tx, row) : null
      if (!tag) throw invalid({ tagId: 'not_found' })
      if (alreadyAttached(tag)) return { tags: current, tag: toConceptTagDto(tag), added: false }
      if (current.length >= COURSE_TAG_LIMIT) throw conflict('limit_reached', { limit: COURSE_TAG_LIMIT })
    } else {
      const normalized = normalizeTagSlug(input.label)
      if (!normalized.ok) throw invalid({ label: normalized.error })
      tag = await findTagBySlug(tx, normalized.slug)
      if (tag && alreadyAttached(tag)) return { tags: current, tag: toConceptTagDto(tag), added: false }
      // 한도를 먼저 확인해 붙이지 못할 태그를 만들지 않습니다.
      if (current.length >= COURSE_TAG_LIMIT) throw conflict('limit_reached', { limit: COURSE_TAG_LIMIT })
      if (!tag) {
        await consumeCatalogCreate(tx, actor, now)
        const [inserted] = await tx
          .insert(conceptTags)
          .values({ slug: normalized.slug, label: input.label, createdBy: actor.userId })
          .onConflictDoNothing({ target: conceptTags.slug })
          .returning()
        tag = inserted ?? (await findTagBySlug(tx, normalized.slug))
        if (!tag) throw new Error('concept tag insert failed')
        createdTag = Boolean(inserted)
        if (inserted) {
          await recordAudit(tx, { actorId: actor.userId, action: 'concept_tag.create', targetType: 'concept_tag', targetId: inserted.id })
        }
        if (alreadyAttached(tag)) return { tags: current, tag: toConceptTagDto(tag), added: false }
      }
    }

    await tx.insert(courseConceptTags).values({ courseId: course.id, tagId: tag.id, addedBy: actor.userId }).onConflictDoNothing()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'concept_tag.attach',
      targetType: 'course',
      targetId: course.id,
      metadata: { tagId: tag.id, createdTag },
    })
    return { tags: await listCourseTags(tx, course.id), tag: toConceptTagDto(tag), added: true }
  })
}
