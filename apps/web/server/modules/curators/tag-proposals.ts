/**
 * 큐레이터의 개념 태그 병합 제안 (E-03, PROOFU_EVOLUTION_PLAN §8.6 "개념 태그 병합 제안", ADR 0048).
 *
 * - 제안 `POST /curator/courses/:id/tag-merge-proposals {sourceTagId, targetTagId, note?}`: 그 과목 큐레이터만(운영자는 병합을 직접 함).
 *   원본은 **그 과목에 붙은 정본 태그**(아니면 422 `sourceTagId: not_on_course`), 대상은 아무 정본 태그(없으면 422 `targetTagId: not_found`,
 *   병합된 태그면 422 `…: merged`), 같은 태그면 422 `targetTagId: self`. 같은 (원본, 대상)의 대기 제안이 있으면 409 `already_proposed`.
 *   사용자별 하루 20회(429). 감사 `curator.tag_merge_propose`(제안·과목·두 태그 id).
 * - 운영자 대기열 `GET /operator/concept-tag-proposals?status=pending|approved|rejected`(기본 pending): 과목·태그·이유·제안한 큐레이터.
 * - 승인 `POST /operator/concept-tag-proposals/:id/approve`: 같은 트랜잭션에서 기존 병합(ADR 0010, mergeConceptTagInTx)을 실행하고 제안을 approved로.
 *   병합 규칙에 걸리면(그새 병합됨 등) 409·422를 그대로 돌려주고 제안은 대기로 남습니다(운영자가 거절). 이미 결정된 제안은 409 `already_decided`.
 * - 거절 `POST /operator/concept-tag-proposals/:id/reject`: 상태만 바꿉니다. 감사 `concept_tag_proposal.approve|reject`(id만).
 * - 큐레이터 작업 화면은 그 과목의 제안(최근 50개)을 보며, 다른 큐레이터의 이름은 싣지 않고 내가 낸 것인지만 표시합니다.
 */
import { z } from 'zod'
import { CONCEPT_TAG_PROPOSAL_STATUSES, CURATOR_NOTE_MAX, type ConceptTagProposalStatus } from '@peerchive/domain'
import {
  and,
  conceptTagMergeProposals,
  conceptTags,
  courseConceptTags,
  desc,
  eq,
  inArray,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { mergeConceptTagInTx } from '../catalog/merge'
import { toConceptTagDto } from '../catalog/tags'
import { type Actor, conflict, invalid, notFound, rateLimited, sqlState } from '../errors'
import { isUuid } from '../projects/access'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { courseRefs, requireCourseCurator } from './access'
import type { ConceptTagProposalDto } from '../../../shared/types/api'

export const PROPOSAL_DAILY_LIMIT: RateLimitRule = { limit: 20, windowMs: 24 * 60 * 60 * 1000 }

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const proposeSchema = z.object({
  sourceTagId: z.uuid({ error: requiredOr('invalid') }).transform((v) => v.toLowerCase()),
  targetTagId: z.uuid({ error: requiredOr('invalid') }).transform((v) => v.toLowerCase()),
  note: z
    .string({ error: 'invalid' })
    .trim()
    .max(CURATOR_NOTE_MAX, { error: 'too_long' })
    .nullish()
    .transform((v) => (v ? v : null)),
})

type ProposalRow = typeof conceptTagMergeProposals.$inferSelect

async function toDtos(db: DbExecutor, rows: ProposalRow[], view: { operator: true } | { viewerId: string }): Promise<ConceptTagProposalDto[]> {
  if (rows.length === 0) return []
  const tagIds = [...new Set(rows.flatMap((r) => [r.sourceTagId, r.targetTagId]))]
  const tags = await db.select({ id: conceptTags.id, slug: conceptTags.slug, label: conceptTags.label }).from(conceptTags).where(inArray(conceptTags.id, tagIds))
  const tagBy = new Map(tags.map((t) => [t.id, toConceptTagDto(t)]))
  const refs = await courseRefs(db, rows.map((r) => r.courseId))
  const proposerIds = [...new Set(rows.map((r) => r.proposedBy).filter((id): id is string => !!id))]
  const names =
    'operator' in view && proposerIds.length
      ? new Map((await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, proposerIds))).map((u) => [u.id, u.displayName]))
      : new Map<string, string>()
  return rows.map((r) => ({
    id: r.id,
    course: refs.get(r.courseId)!,
    source: tagBy.get(r.sourceTagId)!,
    target: tagBy.get(r.targetTagId)!,
    note: r.note,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    ...('operator' in view
      ? { proposer: r.proposedBy ? { userId: r.proposedBy, displayName: names.get(r.proposedBy) ?? '' } : null }
      : { mine: r.proposedBy === view.viewerId }),
  }))
}

/** 그 과목(정본)의 제안(최근 50개). 큐레이터 작업 화면용 — 호출자가 권한을 확인합니다. */
export async function listCourseProposals(db: DbExecutor, viewerId: string, canonicalCourseId: string, operator: boolean): Promise<ConceptTagProposalDto[]> {
  const rows = await db
    .select()
    .from(conceptTagMergeProposals)
    .where(eq(conceptTagMergeProposals.courseId, canonicalCourseId))
    .orderBy(desc(conceptTagMergeProposals.createdAt), desc(conceptTagMergeProposals.id))
    .limit(50)
  return toDtos(db, rows, operator ? { operator: true } : { viewerId })
}

/** POST /curator/courses/:id/tag-merge-proposals — 201 + 제안. */
export async function proposeTagMerge(db: DbExecutor, actor: Actor, courseId: unknown, rawInput: unknown, now = new Date()): Promise<ConceptTagProposalDto> {
  const course = await requireCourseCurator(db, actor, courseId)
  const input = parseInput(proposeSchema, rawInput)
  if (input.sourceTagId === input.targetTagId) throw invalid({ targetTagId: 'self' })
  return db.transaction(async (tx) => {
    const tags = await tx.select().from(conceptTags).where(inArray(conceptTags.id, [input.sourceTagId, input.targetTagId]))
    const source = tags.find((t) => t.id === input.sourceTagId)
    const target = tags.find((t) => t.id === input.targetTagId)
    if (!source) throw invalid({ sourceTagId: 'not_found' })
    if (source.mergedInto) throw invalid({ sourceTagId: 'merged' })
    if (!target) throw invalid({ targetTagId: 'not_found' })
    if (target.mergedInto) throw invalid({ targetTagId: 'merged' })
    const [attached] = await tx
      .select({ tagId: courseConceptTags.tagId })
      .from(courseConceptTags)
      .where(and(eq(courseConceptTags.courseId, course.id), eq(courseConceptTags.tagId, source.id)))
      .limit(1)
    if (!attached) throw invalid({ sourceTagId: 'not_on_course' })
    if (!(await hitRateLimit(tx, 'curator_tag_proposal', actor.userId, PROPOSAL_DAILY_LIMIT, now))) throw rateLimited()
    let row: ProposalRow
    try {
      row = await tx.transaction(async (sp) => {
        const [inserted] = await sp
          .insert(conceptTagMergeProposals)
          .values({ courseId: course.id, sourceTagId: source.id, targetTagId: target.id, proposedBy: actor.userId, note: input.note, createdAt: now })
          .returning()
        return inserted!
      })
    } catch (error) {
      if (sqlState(error) === '23505') throw conflict('already_proposed')
      throw error
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'curator.tag_merge_propose',
      targetType: 'concept_tag_proposal',
      targetId: row.id,
      metadata: { courseId: course.id, sourceTagId: source.id, targetTagId: target.id },
    })
    return (await toDtos(tx, [row], { viewerId: actor.userId }))[0]!
  })
}

/** GET /operator/concept-tag-proposals?status= — 운영자만. 대기는 오래된 것부터, 결정된 것은 최근 것부터(최대 200). */
export async function listTagMergeProposals(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>): Promise<ConceptTagProposalDto[]> {
  await requireOperator(db, actor)
  const raw = typeof rawQuery.status === 'string' && rawQuery.status ? rawQuery.status : 'pending'
  if (!(CONCEPT_TAG_PROPOSAL_STATUSES as readonly string[]).includes(raw)) throw invalid({ status: 'invalid' })
  const status = raw as ConceptTagProposalStatus
  const rows = await db
    .select()
    .from(conceptTagMergeProposals)
    .where(eq(conceptTagMergeProposals.status, status))
    .orderBy(status === 'pending' ? conceptTagMergeProposals.createdAt : desc(conceptTagMergeProposals.decidedAt), conceptTagMergeProposals.id)
    .limit(200)
  return toDtos(db, rows, { operator: true })
}

async function decide(db: DbExecutor, actor: Actor, proposalId: unknown, decision: 'approved' | 'rejected', now: Date): Promise<ConceptTagProposalDto> {
  await requireOperator(db, actor)
  if (!isUuid(proposalId)) throw notFound()
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(conceptTagMergeProposals).where(eq(conceptTagMergeProposals.id, proposalId.toLowerCase())).limit(1).for('update')
    if (!row) throw notFound()
    if (row.status !== 'pending') throw conflict('already_decided')
    if (decision === 'approved') await mergeConceptTagInTx(tx, actor, row.sourceTagId, row.targetTagId, now, { proposalId: row.id })
    const [updated] = await tx
      .update(conceptTagMergeProposals)
      .set({ status: decision, decidedBy: actor.userId, decidedAt: now })
      .where(eq(conceptTagMergeProposals.id, row.id))
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: decision === 'approved' ? 'concept_tag_proposal.approve' : 'concept_tag_proposal.reject',
      targetType: 'concept_tag_proposal',
      targetId: row.id,
      metadata: { courseId: row.courseId },
    })
    return (await toDtos(tx, [updated!], { operator: true }))[0]!
  })
}

/** POST /operator/concept-tag-proposals/:id/approve — 운영자만. 기존 병합을 실행합니다. */
export const approveTagMergeProposal = (db: DbExecutor, actor: Actor, proposalId: unknown, now = new Date()) => decide(db, actor, proposalId, 'approved', now)
/** POST /operator/concept-tag-proposals/:id/reject — 운영자만. */
export const rejectTagMergeProposal = (db: DbExecutor, actor: Actor, proposalId: unknown, now = new Date()) => decide(db, actor, proposalId, 'rejected', now)
