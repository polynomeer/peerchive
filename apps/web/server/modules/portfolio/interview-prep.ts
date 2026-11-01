/**
 * 면접 준비 팩 (E-06, PROOFU_EVOLUTION_PLAN §10.5, DELIVERY_PLAN §4.4 E-06, ADR 0050).
 *
 * - 질문: 저장하지 않고 **읽을 때마다** 케이스 문장의 인용(고정 release 스냅샷의 결정·회의·막힘 로그)에서 템플릿으로 만듭니다
 *   (@peerchive/domain `INTERVIEW_TEMPLATE_GENERATOR`). 그래서 케이스를 고치면 다음 요청부터 질문이 바뀌고, 따로 다시 만들기 작업이 없습니다.
 *   운영 조치로 가린 항목(T-15)에서는 질문을 만들지 않습니다. 원본 사례를 볼 수 없게 된 케이스(철회·대체·차단)는 질문이 없습니다.
 * - 항목(`interview_prep_entries`): (사용자, 공개, 질문 키)마다 비공개 답변 메모와 공개 선택(shown). 질문 키는 공개마다 안정된 스냅샷 로그 키로
 *   만들어서, 케이스를 고치거나 새 공개 버전으로 다시 만들어도 같은 질문이면 메모가 이어집니다. 지금 만들어지지 않는 키의 메모는 지우지 않고
 *   본인에게만 "보관된 메모"로 보여 주며(공개 선택은 효력 없음), 지우기만 할 수 있습니다.
 * - 읽기·쓰기는 케이스 작성자만(다른 사람에게는 404, 존재를 드러내지 않음). 메모 글은 감사 기록에도 넣지 않습니다.
 * - 공개(`publicInterviewQuestions`): 공개 프로필이 이미 "지금 볼 수 있다"고 거른 케이스에 대해, shown인 항목 중 **지금 만들어지는 질문의 글만**
 *   돌려줍니다. 메모 열은 읽지도 않습니다.
 */
import { z } from 'zod'
import {
  INTERVIEW_ENTRY_LIMIT,
  INTERVIEW_QUESTION_CATEGORY_LABELS,
  INTERVIEW_TEMPLATE_GENERATOR,
  type CaseSectionDraft,
  type InterviewQuestion,
  citationLabel,
  citationPath,
  hiddenItemSet,
  isInterviewQuestionKey,
  isItemHidden,
  normalizeInterviewNote,
} from '@peerchive/domain'
import { and, asc, caseStudies, eq, inArray, interviewPrepEntries, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound, rateLimited } from '../errors'
import { isUuid } from '../projects/access'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { type CaseStudyWithRelease, asCaseSnapshot, effectiveStatus, loadCaseStudiesWithRelease, loadSections } from './release-scope'
import { isPubliclyVisible } from './view'
import type { ArchivedInterviewNoteDto, InterviewPrepDto, InterviewQuestionDto } from '../../../shared/types/api'

export const INTERVIEW_PREP_SAVE_RATE_LIMIT: RateLimitRule = { limit: 300, windowMs: 60 * 60 * 1000 }

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const saveInterviewPrepSchema = z.object({
  questionKey: z.string({ error: requiredOr('invalid') }).refine(isInterviewQuestionKey, { error: 'invalid' }),
  /** 문자열(메모) 또는 null·빈 글(메모 지움). 주지 않으면 그대로. */
  note: z.union([z.string(), z.null()], { error: 'invalid' }).optional(),
  shown: z.boolean({ error: 'invalid' }).optional(),
})

type EntryRow = typeof interviewPrepEntries.$inferSelect

/** 케이스의 지금 질문(원본 사례를 볼 수 없으면 없음). 생성기는 지금 템플릿뿐입니다(AI는 E-12 이후 이 자리에서 고름). */
export function questionsForCase(row: CaseStudyWithRelease, sections: readonly CaseSectionDraft[]): InterviewQuestion[] {
  if (effectiveStatus(row).status === 'unavailable') return []
  const hidden = hiddenItemSet(row.hidden)
  return INTERVIEW_TEMPLATE_GENERATOR.generate({
    snapshot: asCaseSnapshot(row.snapshot),
    sections,
    isHidden: (kind, key) => isItemHidden(hidden, kind, key),
  })
}

async function loadOwnCase(db: DbExecutor, actor: Actor, caseStudyId: unknown, now: Date, lock = false): Promise<CaseStudyWithRelease> {
  if (!isUuid(caseStudyId)) throw notFound()
  const id = caseStudyId.toLowerCase()
  if (lock) await db.select({ id: caseStudies.id }).from(caseStudies).where(eq(caseStudies.id, id)).for('update')
  const [row] = await loadCaseStudiesWithRelease(db, eq(caseStudies.id, id), now)
  if (!row || row.caseStudy.userId !== actor.userId) throw notFound()
  return row
}

async function loadEntries(db: DbExecutor, userId: string, publicationId: string): Promise<EntryRow[]> {
  return db
    .select()
    .from(interviewPrepEntries)
    .where(and(eq(interviewPrepEntries.userId, userId), eq(interviewPrepEntries.publicationId, publicationId)))
    .orderBy(asc(interviewPrepEntries.createdAt), asc(interviewPrepEntries.id))
}

async function toDto(db: DbExecutor, row: CaseStudyWithRelease): Promise<InterviewPrepDto> {
  const cs = row.caseStudy
  const sections = (await loadSections(db, [cs])).get(cs.id) ?? []
  const questions = questionsForCase(row, sections)
  const entries = await loadEntries(db, cs.userId, cs.publicationId)
  const byKey = new Map(entries.map((e) => [e.questionKey, e]))
  const snapshot = asCaseSnapshot(row.snapshot)
  const current = new Set(questions.map((q) => q.key))
  const questionDtos: InterviewQuestionDto[] = questions.map((q) => {
    const entry = byKey.get(q.key)
    return {
      key: q.key,
      category: q.category,
      categoryLabel: INTERVIEW_QUESTION_CATEGORY_LABELS[q.category],
      text: q.text,
      source: q.source ? { ...q.source, label: citationLabel(snapshot, q.source), path: citationPath(row.slug, q.source) } : null,
      note: entry?.note ?? null,
      shown: entry?.shown ?? false,
      textChanged: !!entry && entry.questionText !== q.text,
      updatedAt: entry?.updatedAt.toISOString() ?? null,
    }
  })
  const archived: ArchivedInterviewNoteDto[] = entries
    .filter((e) => !current.has(e.questionKey))
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .map((e) => ({ key: e.questionKey, text: e.questionText, note: e.note, updatedAt: e.updatedAt.toISOString() }))
  return {
    caseStudyId: cs.id,
    generator: INTERVIEW_TEMPLATE_GENERATOR.name,
    available: effectiveStatus(row).status !== 'unavailable',
    publiclyVisible: isPubliclyVisible(row),
    questions: questionDtos,
    archived,
  }
}

/** GET /case-studies/:id/interview-prep — 작성자만(아니면 404). 지금 질문 + 내 메모·공개 선택 + 보관된 메모. */
export async function getInterviewPrep(db: DbExecutor, actor: Actor, caseStudyId: unknown, now = new Date()): Promise<InterviewPrepDto> {
  return toDto(db, await loadOwnCase(db, actor, caseStudyId, now))
}

/**
 * PUT /case-studies/:id/interview-prep {questionKey, note?, shown?} — 작성자만(404). 200 + 팩.
 * - 지금 만들어지는 질문: 메모를 쓰거나 지우고(null·빈 글), 공개 선택을 켜고 끕니다. 메모도 선택도 없으면 항목을 지웁니다.
 * - 지금 만들어지지 않는 질문(보관된 메모): 지우기만(note null, shown false). 그 밖은 422 `questionKey: not_current`.
 * 422 `note: too_long`(2000자)·`invalid`, 409 limit_reached(공개마다 100개), 429.
 */
export async function saveInterviewPrep(db: DbExecutor, actor: Actor, caseStudyId: unknown, rawInput: unknown, now = new Date()): Promise<InterviewPrepDto> {
  const input = parseInput(saveInterviewPrepSchema, rawInput)
  let note: string | null | undefined
  if (input.note !== undefined) {
    const checked = normalizeInterviewNote(input.note)
    if (!checked.ok) throw invalid({ note: checked.code })
    note = checked.note
  }
  if (note === undefined && input.shown === undefined) throw invalid({ _: 'no_changes' })
  return db.transaction(async (tx) => {
    const row = await loadOwnCase(tx, actor, caseStudyId, now, true)
    const cs = row.caseStudy
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`interview-prep:${actor.userId}:${cs.publicationId}`}))`)
    if (!(await hitRateLimit(tx, 'interview_prep_save', actor.userId, INTERVIEW_PREP_SAVE_RATE_LIMIT, now))) throw rateLimited()
    const sections = (await loadSections(tx, [cs])).get(cs.id) ?? []
    const question = questionsForCase(row, sections).find((q) => q.key === input.questionKey)
    const [existing] = await tx
      .select()
      .from(interviewPrepEntries)
      .where(
        and(
          eq(interviewPrepEntries.userId, actor.userId),
          eq(interviewPrepEntries.publicationId, cs.publicationId),
          eq(interviewPrepEntries.questionKey, input.questionKey),
        ),
      )
    if (!question) {
      // 보관된 메모는 지우기만 됩니다(지금 없는 질문을 공개로 고르거나 메모를 새로 쓸 수 없음).
      if (!existing || input.shown === true || (note !== undefined && note !== null)) throw invalid({ questionKey: 'not_current' })
    }
    const nextNote = note !== undefined ? note : (existing?.note ?? null)
    const nextShown = question ? (input.shown ?? existing?.shown ?? false) : false
    if (nextNote === null && !nextShown) {
      if (existing) await tx.delete(interviewPrepEntries).where(eq(interviewPrepEntries.id, existing.id))
    } else if (existing) {
      await tx
        .update(interviewPrepEntries)
        .set({ note: nextNote, shown: nextShown, questionText: question?.text ?? existing.questionText, updatedAt: now })
        .where(eq(interviewPrepEntries.id, existing.id))
    } else {
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(interviewPrepEntries)
        .where(and(eq(interviewPrepEntries.userId, actor.userId), eq(interviewPrepEntries.publicationId, cs.publicationId)))
      if (count >= INTERVIEW_ENTRY_LIMIT) throw conflict('limit_reached', { limit: INTERVIEW_ENTRY_LIMIT })
      await tx.insert(interviewPrepEntries).values({
        userId: actor.userId,
        publicationId: cs.publicationId,
        questionKey: input.questionKey,
        questionText: question!.text,
        note: nextNote,
        shown: nextShown,
        createdAt: now,
        updatedAt: now,
      })
    }
    if ((existing?.shown ?? false) !== nextShown) {
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'interview_prep.shown_toggle',
        targetType: 'interview_prep_entry',
        targetId: cs.id,
        metadata: { caseStudyId: cs.id, questionKey: input.questionKey, shown: nextShown },
      })
    }
    return toDto(tx, row)
  })
}

/**
 * 공개 프로필용: 이미 "지금 볼 수 있다"고 거른 케이스들에서 학생이 공개로 고른 질문(지금 만들어지는 것만)을 케이스 id별로.
 * 메모 열은 고르지 않습니다. 볼 수 없는 케이스가 섞여 들어와도 여기서 한 번 더 거릅니다.
 */
export async function publicInterviewQuestions(
  db: DbExecutor,
  rows: readonly CaseStudyWithRelease[],
  sections: ReadonlyMap<string, CaseSectionDraft[]>,
): Promise<Map<string, InterviewQuestion[]>> {
  const out = new Map<string, InterviewQuestion[]>()
  const visible = rows.filter(isPubliclyVisible)
  if (visible.length === 0) return out
  const shown = await db
    .select({ userId: interviewPrepEntries.userId, publicationId: interviewPrepEntries.publicationId, questionKey: interviewPrepEntries.questionKey })
    .from(interviewPrepEntries)
    .where(
      and(
        eq(interviewPrepEntries.shown, true),
        inArray(interviewPrepEntries.userId, [...new Set(visible.map((r) => r.caseStudy.userId))]),
        inArray(interviewPrepEntries.publicationId, [...new Set(visible.map((r) => r.caseStudy.publicationId))]),
      ),
    )
  for (const row of visible) {
    const cs = row.caseStudy
    const keys = new Set(shown.filter((s) => s.userId === cs.userId && s.publicationId === cs.publicationId).map((s) => s.questionKey))
    if (keys.size === 0) continue
    out.set(cs.id, questionsForCase(row, sections.get(cs.id) ?? []).filter((q) => keys.has(q.key)))
  }
  return out
}
