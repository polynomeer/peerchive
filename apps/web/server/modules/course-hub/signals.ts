/**
 * 유용성 신호 (T-13, PROOFU_EVOLUTION_PLAN §8.2 4번·§8.5, SYSTEM_DESIGN §6.2 UsefulnessSignal, ADR 0013).
 *
 * - `PUT /signals`(남기기, idempotent)·`DELETE /signals`(거두기): 로그인 필수. 대상은 **지금 공개**여야 합니다
 *   (막힘 카드: 지금 게시 중인 release 스냅샷에 그 키의 🧱막힘이 있음 / 선배 노트: published). 아니면 404.
 * - 사용자·대상·종류마다 하나(DB 부분 unique). 항목별 개수만 보여 주고 작성자별로 합산하지 않습니다.
 * - 대상이 철회되면 읽기는 그 대상을 고르지 않으므로 신호도 보이지 않고, worker 정리 handler가 행을 지웁니다.
 */
import { z } from 'zod'
import { SIGNAL_KINDS, extractStuckItems, isAllowedSignal, type HubSnapshot } from '@peerchive/domain'
import {
  and,
  eq,
  inArray,
  projects,
  publicationCandidates,
  publications,
  seniorNotes,
  sql,
  usefulnessSignals,
  type DbExecutor,
} from '@peerchive/db'
import { emitAnalytics } from '../analytics/analytics'
import { type Actor, invalid, notFound, rateLimited } from '../errors'
import { loadServedRelease } from '../publication/public-read'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { servableReleaseSql } from './public-scope'
import type { MySignalDto, SignalStateDto } from '../../../shared/types/api'

export const SIGNAL_RATE_LIMIT: RateLimitRule = { limit: 300, windowMs: 60 * 60 * 1000 }

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const signalSchema = z.object({
  target: z.discriminatedUnion(
    'kind',
    [
      z.object({
        kind: z.literal('stuck_item'),
        slug: z.string({ error: requiredOr('invalid') }).min(3, { error: 'invalid' }).max(60, { error: 'invalid' }),
        itemKey: z.string({ error: requiredOr('invalid') }).min(1, { error: 'invalid' }).max(40, { error: 'invalid' }),
      }),
      z.object({
        kind: z.literal('senior_note'),
        noteId: z.uuid({ error: requiredOr('invalid') }).transform((id) => id.toLowerCase()),
      }),
    ],
    { error: requiredOr('invalid') },
  ),
  kind: z.enum(SIGNAL_KINDS, { error: requiredOr('invalid') }),
})

type ResolvedTarget =
  | { targetKind: 'stuck_item'; publicationId: string; itemKey: string }
  | { targetKind: 'senior_note'; seniorNoteId: string }

/** 대상이 지금 공개인지 확인하고 저장 키로 바꿉니다. 아니면 404. */
async function resolveTarget(db: DbExecutor, input: z.output<typeof signalSchema>, now: Date): Promise<ResolvedTarget> {
  if (!isAllowedSignal(input.target.kind, input.kind)) throw invalid({ kind: 'not_allowed' })
  if (input.target.kind === 'stuck_item') {
    const served = await loadServedRelease(db, input.target.slug, now)
    const key = input.target.itemKey
    if (!served || !extractStuckItems(served.snapshot as unknown as HubSnapshot).some((item) => item.key === key)) throw notFound()
    return { targetKind: 'stuck_item', publicationId: served.publication.id, itemKey: key }
  }
  const [note] = await db
    .select({ id: seniorNotes.id })
    .from(seniorNotes)
    .where(and(eq(seniorNotes.id, input.target.noteId), eq(seniorNotes.status, 'published')))
    .limit(1)
  if (!note) throw notFound()
  return { targetKind: 'senior_note', seniorNoteId: note.id }
}

const targetWhere = (target: ResolvedTarget) =>
  target.targetKind === 'stuck_item'
    ? and(
        eq(usefulnessSignals.targetKind, 'stuck_item'),
        eq(usefulnessSignals.publicationId, target.publicationId),
        eq(usefulnessSignals.itemKey, target.itemKey),
      )
    : and(eq(usefulnessSignals.targetKind, 'senior_note'), eq(usefulnessSignals.seniorNoteId, target.seniorNoteId))

async function stateFor(db: DbExecutor, actor: Actor, target: ResolvedTarget): Promise<SignalStateDto> {
  const rows = await db
    .select({
      kind: usefulnessSignals.kind,
      n: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${usefulnessSignals.userId} = ${actor.userId})`,
    })
    .from(usefulnessSignals)
    .where(targetWhere(target))
    .groupBy(usefulnessSignals.kind)
  const by = new Map(rows.map((r) => [r.kind, r]))
  return {
    signals: { meToo: by.get('me_too')?.n ?? 0, helped: by.get('helped')?.n ?? 0 },
    mine: { meToo: !!by.get('me_too')?.mine, helped: !!by.get('helped')?.mine },
  }
}

/** PUT /signals {target, kind} — 200 + 지금 개수·내 신호. 이미 남겼으면 그대로(idempotent). 404(지금 공개 아님), 422, 429. */
export async function putSignal(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<SignalStateDto> {
  const input = parseInput(signalSchema, rawInput)
  const target = await resolveTarget(db, input, now)
  if (!(await hitRateLimit(db, 'usefulness_signal', actor.userId, SIGNAL_RATE_LIMIT, now))) throw rateLimited()
  const inserted = await db
    .insert(usefulnessSignals)
    .values({
      userId: actor.userId,
      targetKind: target.targetKind,
      publicationId: target.targetKind === 'stuck_item' ? target.publicationId : null,
      itemKey: target.targetKind === 'stuck_item' ? target.itemKey : null,
      seniorNoteId: target.targetKind === 'senior_note' ? target.seniorNoteId : null,
      kind: input.kind,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: usefulnessSignals.id })
  // 처음 남길 때만(다시 눌러도 같은 신호).
  if (inserted.length > 0) await emitAnalytics(db, { name: 'usefulness_marked', actorId: actor.userId, props: { target: target.targetKind, kind: input.kind } })
  return stateFor(db, actor, target)
}

/** DELETE /signals {target, kind} — 200 + 지금 개수·내 신호. 남긴 적 없어도 200. 404(지금 공개 아님), 422. */
export async function deleteSignal(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<SignalStateDto> {
  const input = parseInput(signalSchema, rawInput)
  const target = await resolveTarget(db, input, now)
  await db.delete(usefulnessSignals).where(and(targetWhere(target), eq(usefulnessSignals.userId, actor.userId), eq(usefulnessSignals.kind, input.kind)))
  return stateFor(db, actor, target)
}

/** GET /me/signals — 내가 남긴 신호 중 대상이 지금 공개인 것만(화면의 눌림 표시용). */
export async function listMySignals(db: DbExecutor, actor: Actor, now = new Date()): Promise<MySignalDto[]> {
  const stuck = await db
    .select({ slug: publications.slug, itemKey: usefulnessSignals.itemKey, kind: usefulnessSignals.kind })
    .from(usefulnessSignals)
    .innerJoin(publications, eq(publications.id, usefulnessSignals.publicationId))
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .where(and(eq(usefulnessSignals.userId, actor.userId), eq(usefulnessSignals.targetKind, 'stuck_item'), servableReleaseSql(now)))
    .limit(1000)
  const notes = await db
    .select({ noteId: usefulnessSignals.seniorNoteId, kind: usefulnessSignals.kind })
    .from(usefulnessSignals)
    .innerJoin(seniorNotes, eq(seniorNotes.id, usefulnessSignals.seniorNoteId))
    .where(
      and(
        eq(usefulnessSignals.userId, actor.userId),
        eq(usefulnessSignals.targetKind, 'senior_note'),
        inArray(seniorNotes.status, ['published']),
      ),
    )
    .limit(1000)
  return [
    ...stuck.map((r) => ({ target: 'stuck_item' as const, slug: r.slug, itemKey: r.itemKey!, kind: r.kind })),
    ...notes.map((r) => ({ target: 'senior_note' as const, noteId: r.noteId!, kind: r.kind })),
  ]
}
