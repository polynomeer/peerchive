/**
 * 막힘 Q&A 스레드 (E-04, PROOFU_EVOLUTION_PLAN §8.5·§8.6, DELIVERY_PLAN §4.4 E-04, ADR 0049).
 *
 * 기본 꺼짐 P1 플래그 `stuckQa`(PEERCHIVE_FEATURE_STUCK_QA) 뒤에 있습니다. 꺼져 있으면 모든 경로가 404입니다(`requireFeature`를 맨 앞에서 부름).
 *
 * - **카드**: 지금 게시 중인 release 스냅샷의 🧱 막힘 로그(`loadServedRelease` + `extractStuckItems` — 공개·release 게시 상태, 지금 release, 엠바고,
 *   운영 조치로 가린 항목을 요청마다 같은 판정으로 확인). 공개가 철회·제한·대체되었거나 엠바고 중이거나 로그가 가려졌으면 카드·스레드·글이 모두
 *   404이고(읽기·쓰기 모두), 행은 지우지 않습니다.
 * - **질문 허용**(`PUT /stuck-qa/cards/:slug/:itemKey {questionsAllowed}`): 그 막힘 로그를 쓴 사람(지금 release의 refs.logs[키].authorId)만, 과목에
 *   연결된 공개만(질문·답변은 과목 학교 인증이 필요하므로, 아니면 409 `course_not_linked`). 기본 꺼짐. 끄면 새 질문·답변을 받지 않고(409
 *   `questions_closed`) 기존 스레드는 읽기만 됩니다. 감사 `stuck_qa.questions_toggle`(카드 id·참거짓).
 * - **쓰기**(질문으로 스레드 열기·답변): 로그인 + 과목 허브 작성 자격(`writeDecision` = active + 그 과목 학교의 active 학교 메일 인증, C-01·ADR 0018).
 *   로그 작성자는 자기 카드에 질문을 열 수 없고(422 `own_card`) 답변은 `작성자`로 표시됩니다. 본문 1~2000자. 사용자별 시간당 스레드 10회·글 30회.
 * - **익명 번호**: 스레드마다 `질문자`(0)·`익명N`(처음 쓴 순서), 로그 작성자는 `작성자`(@peerchive/domain assignStuckQaAlias). 스레드 행을 잠가
 *   순서를 정합니다. 공개 응답에는 사람 id·이름·번호 행 id가 없습니다(`mine`은 보는 사람 자신의 글에만 true).
 * - **도움됐어요**(`PUT·DELETE /stuck-qa/posts/:id/helpful`): 게시 중인 답변에만, 자기 글 제외(422 `own_post`). **정렬에만** 쓰고 개수를 어떤
 *   응답에도 싣지 않습니다(작성자 개인 점수 없음, §8.5). 보는 사람에게는 자기가 눌렀는지만.
 * - **후배 기여**(`PATCH /stuck-qa/posts/:id {countAsContribution}`): 자기 답변만, 기본 false. 공개 프로필(실명)의 `juniorContribution.stuckQaAnswers`는
 *   켠 답변 중 지금 보이는 것의 개수뿐입니다(stuck-qa-portfolio.ts — 공개 프로필 경로가 이 파일의 import(선배 노트·운영 안내)를 끌어오지 않게 나눔).
 * - **지우기**(`DELETE /stuck-qa/posts/:id`): 자기 글을 언제든(카드가 닫혀도). 본문을 비우고 번호는 남깁니다. 질문을 지우면 스레드가 안 보입니다.
 * - 신고(`stuck_qa_post`)·숨김(`hide_stuck_qa_post`)·운영자 작성자 확인(신고에 묶임, 감사)은 moderation 모듈과 `operatorStuckQaAuthor`가 맡습니다.
 * 이 파일은 과목 허브 구역 테이블만 읽습니다(커뮤니티 테이블·모듈 없음, C-05).
 */
import { z } from 'zod'
import {
  STUCK_QA_BODY_MAX,
  STUCK_QA_POST_LIMIT,
  STUCK_QA_THREAD_LIMIT,
  assignStuckQaAlias,
  extractStuckItems,
  normalizeStuckQaBody,
  rankStuckQaPosts,
  rankStuckQaThreads,
  stuckQaAuthorLabel,
  stuckQaExcerpt,
  type HubSnapshot,
} from '@peerchive/domain'
import {
  and,
  courses,
  eq,
  inArray,
  isNull,
  profiles,
  publications,
  reports,
  sql,
  stuckQaAliases,
  stuckQaCards,
  stuckQaHelpful,
  stuckQaPosts,
  stuckQaThreads,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, rateLimited } from '../errors'
import { requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { loadServedRelease } from '../publication/public-read'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { issuesToFields, parseInput } from '../validation'
import { writeDecision } from './senior-notes'
import type {
  StuckQaAuthorLookupDto,
  StuckQaCardDto,
  StuckQaModerationPostDto,
  StuckQaPostDto,
  StuckQaThreadDto,
  StuckQaThreadSummaryDto,
  StuckQaViewerDto,
} from '../../../shared/types/api'

export const STUCK_QA_THREAD_RATE_LIMIT: RateLimitRule = { limit: 10, windowMs: 60 * 60 * 1000 }
export const STUCK_QA_POST_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 60 * 1000 }
export const STUCK_QA_HELPFUL_RATE_LIMIT: RateLimitRule = { limit: 300, windowMs: 60 * 60 * 1000 }

export const stuckQaThreadPath = (threadId: string) => `/stuck-qa/threads/${threadId}`
export const stuckQaCardPath = (slug: string, itemKey: string) => `/stuck-qa/cards/${slug}/${encodeURIComponent(itemKey)}`

type CardRow = typeof stuckQaCards.$inferSelect
type ThreadRow = typeof stuckQaThreads.$inferSelect
type PostRow = typeof stuckQaPosts.$inferSelect
type CanonicalCourse = { id: string; mergedInto: string | null; schoolId: string }

/** 지금 보이는 막힘 카드(요청마다 판정). */
interface LiveCard {
  publicationId: string
  slug: string
  itemKey: string
  symptom: string
  /** 지금 release의 과목(정본). 연결이 없으면 null(질문·답변 불가). */
  course: CanonicalCourse | null
  /** 지금 release의 refs로 정한 막힘 로그 작성자. */
  logAuthorId: string | null
  card: CardRow | null
}

const ITEM_KEY_PATTERN = /^[A-Za-z0-9_-]{1,40}$/

async function canonicalCourse(db: DbExecutor, courseId: string | null): Promise<CanonicalCourse | null> {
  if (!courseId) return null
  const [row] = await db.select({ id: courses.id, mergedInto: courses.mergedInto, schoolId: courses.schoolId }).from(courses).where(eq(courses.id, courseId)).limit(1)
  if (!row) return null
  if (!row.mergedInto) return row
  const [canon] = await db.select({ id: courses.id, mergedInto: courses.mergedInto, schoolId: courses.schoolId }).from(courses).where(eq(courses.id, row.mergedInto)).limit(1)
  return canon ?? null
}

/** slug·키의 막힘 카드가 지금 공개로 보이면 돌려주고 아니면 null(철회·제한·대체·엠바고·가린 로그·막힘이 아님). */
async function loadLiveCard(db: DbExecutor, slug: unknown, itemKey: unknown, now: Date, lockCard = false): Promise<LiveCard | null> {
  if (typeof itemKey !== 'string' || !ITEM_KEY_PATTERN.test(itemKey)) return null
  const served = await loadServedRelease(db, slug, now)
  if (!served) return null
  const item = extractStuckItems(served.snapshot as unknown as HubSnapshot).find((i) => i.key === itemKey)
  if (!item) return null
  const refs = served.release.refs as { logs?: Record<string, { authorId?: string }> }
  const base = db.select().from(stuckQaCards).where(and(eq(stuckQaCards.publicationId, served.publication.id), eq(stuckQaCards.itemKey, itemKey))).limit(1)
  const [card] = lockCard ? await base.for('update') : await base
  return {
    publicationId: served.publication.id,
    slug: served.publication.slug,
    itemKey,
    symptom: item.symptom,
    course: await canonicalCourse(db, served.release.courseId),
    logAuthorId: refs.logs?.[itemKey]?.authorId ?? null,
    card: card ?? null,
  }
}

async function requireLiveCard(db: DbExecutor, slug: unknown, itemKey: unknown, now: Date, lockCard = false): Promise<LiveCard> {
  const live = await loadLiveCard(db, slug, itemKey, now, lockCard)
  if (!live) throw notFound()
  return live
}

/** 스레드 + 그 카드가 지금 보이고 질문 글이 게시 중이면 돌려줍니다. 아니면 null. */
async function loadLiveThread(db: DbExecutor, threadId: unknown, now: Date): Promise<{ thread: ThreadRow; live: LiveCard } | null> {
  if (!isUuid(threadId)) return null
  const [row] = await db
    .select({ thread: stuckQaThreads, card: stuckQaCards, slug: publications.slug })
    .from(stuckQaThreads)
    .innerJoin(stuckQaCards, eq(stuckQaCards.id, stuckQaThreads.cardId))
    .innerJoin(publications, eq(publications.id, stuckQaCards.publicationId))
    .where(eq(stuckQaThreads.id, threadId.toLowerCase()))
    .limit(1)
  if (!row) return null
  const live = await loadLiveCard(db, row.slug, row.card.itemKey, now)
  if (!live) return null
  const [question] = await db
    .select({ status: stuckQaPosts.status })
    .from(stuckQaPosts)
    .where(and(eq(stuckQaPosts.threadId, row.thread.id), eq(stuckQaPosts.kind, 'question')))
    .limit(1)
  if (question?.status !== 'published') return null
  return { thread: row.thread, live }
}

/** 지금 보이는 스레드의 글(상태는 묻지 않음). 아니면 null. */
async function loadLivePost(db: DbExecutor, postId: unknown, now: Date): Promise<{ post: PostRow; thread: ThreadRow; live: LiveCard } | null> {
  if (!isUuid(postId)) return null
  const [post] = await db.select().from(stuckQaPosts).where(eq(stuckQaPosts.id, postId.toLowerCase())).limit(1)
  if (!post) return null
  const found = await loadLiveThread(db, post.threadId, now)
  return found ? { post, ...found } : null
}

async function viewerFor(db: DbExecutor, actor: Actor | null, live: LiveCard): Promise<StuckQaViewerDto | null> {
  if (!actor) return null
  const allowed = !!live.card?.questionsAllowed
  const decision = live.course ? await writeDecision(db, actor, live.course) : null
  return {
    isLogAuthor: live.logAuthorId === actor.userId,
    canWrite: allowed && !!decision?.decision.ok,
    requirement: decision && !decision.decision.ok && decision.decision.reason === 'affiliation_required' ? 'school_affiliation' : null,
  }
}

/** 쓰기 자격: 허용이 켜져 있고(409 questions_closed), 과목 허브 작성 자격(403 hub_write_not_allowed, 인증이 없으면 requirement 포함). */
async function assertCanPost(tx: DbExecutor, actor: Actor, live: LiveCard): Promise<void> {
  if (!live.card?.questionsAllowed) throw conflict('questions_closed')
  if (!live.course) throw forbidden('hub_write_not_allowed')
  const { decision, schoolId } = await writeDecision(tx, actor, live.course)
  if (decision.ok) return
  if (decision.reason === 'affiliation_required') {
    throw new ServiceError('FORBIDDEN', 'hub_write_not_allowed', undefined, { requirement: 'school_affiliation', schoolId })
  }
  throw forbidden('hub_write_not_allowed')
}

/** 답변별 "도움됐어요" 수(정렬용 — 응답에 싣지 않음). */
async function helpedCounts(db: DbExecutor, postIds: readonly string[]): Promise<Map<string, number>> {
  if (postIds.length === 0) return new Map()
  const rows = await db
    .select({ postId: stuckQaHelpful.postId, n: sql<number>`count(*)::int` })
    .from(stuckQaHelpful)
    .where(inArray(stuckQaHelpful.postId, [...postIds]))
    .groupBy(stuckQaHelpful.postId)
  return new Map(rows.map((r) => [r.postId, r.n]))
}

// ── 카드 ─────────────────────────────────────────────────────────────────

/** GET /stuck-qa/cards/:slug/:itemKey — 로그인 없이도. 404(카드가 지금 보이지 않음·플래그 꺼짐). */
export async function getStuckQaCard(db: DbExecutor, actor: Actor | null, slug: unknown, itemKey: unknown, now = new Date()): Promise<StuckQaCardDto> {
  requireFeature('stuckQa')
  const live = await requireLiveCard(db, slug, itemKey, now)
  return cardDto(db, actor, live)
}

async function cardDto(db: DbExecutor, actor: Actor | null, live: LiveCard): Promise<StuckQaCardDto> {
  let threads: StuckQaThreadSummaryDto[] = []
  if (live.card) {
    // 질문 글이 게시 중인 스레드만.
    const rows = await db
      .select({ thread: stuckQaThreads, question: stuckQaPosts.body })
      .from(stuckQaThreads)
      .innerJoin(stuckQaPosts, and(eq(stuckQaPosts.threadId, stuckQaThreads.id), eq(stuckQaPosts.kind, 'question'), eq(stuckQaPosts.status, 'published')))
      .where(eq(stuckQaThreads.cardId, live.card.id))
      .limit(500)
    const ids = rows.map((r) => r.thread.id)
    const answers = ids.length
      ? await db
          .select({ id: stuckQaPosts.id, threadId: stuckQaPosts.threadId })
          .from(stuckQaPosts)
          .where(and(inArray(stuckQaPosts.threadId, ids), eq(stuckQaPosts.kind, 'answer'), eq(stuckQaPosts.status, 'published')))
      : []
    const counts = await helpedCounts(db, answers.map((a) => a.id))
    const by = new Map<string, { answers: number; helped: number }>()
    for (const a of answers) {
      const t = by.get(a.threadId) ?? { answers: 0, helped: 0 }
      by.set(a.threadId, { answers: t.answers + 1, helped: t.helped + (counts.get(a.id) ?? 0) })
    }
    const ranked = rankStuckQaThreads(
      rows.map((r) => ({
        id: r.thread.id,
        question: stuckQaExcerpt(r.question),
        answerCount: by.get(r.thread.id)?.answers ?? 0,
        helped: by.get(r.thread.id)?.helped ?? 0,
        createdAt: r.thread.createdAt.toISOString(),
        lastPostAt: r.thread.lastPostAt.toISOString(),
      })),
    )
    threads = ranked.slice(0, STUCK_QA_THREAD_LIMIT).map(({ helped: _helped, ...t }) => t)
  }
  return {
    slug: live.slug,
    itemKey: live.itemKey,
    symptom: live.symptom,
    courseId: live.course?.id ?? null,
    questionsAllowed: !!live.card?.questionsAllowed,
    threads,
    viewer: await viewerFor(db, actor, live),
  }
}

const toggleSchema = z.object({ questionsAllowed: z.boolean({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }) })

/** PUT /stuck-qa/cards/:slug/:itemKey {questionsAllowed} — 그 막힘 로그 작성자만(403 not_log_author). 200 + 카드. */
export async function setQuestionsAllowed(db: DbExecutor, actor: Actor, slug: unknown, itemKey: unknown, rawInput: unknown, now = new Date()): Promise<StuckQaCardDto> {
  requireFeature('stuckQa')
  const input = parseInput(toggleSchema, rawInput)
  return db.transaction(async (tx) => {
    const live = await requireLiveCard(tx, slug, itemKey, now, true)
    if (!live.logAuthorId || live.logAuthorId !== actor.userId) throw forbidden('not_log_author')
    const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1)
    if (user?.status !== 'active') throw forbidden('not_log_author')
    if (input.questionsAllowed && !live.course) throw conflict('course_not_linked')
    let card: CardRow
    if (live.card) {
      ;[card] = (await tx
        .update(stuckQaCards)
        .set({ questionsAllowed: input.questionsAllowed, authorId: actor.userId, updatedAt: now })
        .where(eq(stuckQaCards.id, live.card.id))
        .returning()) as [CardRow]
    } else {
      ;[card] = (await tx
        .insert(stuckQaCards)
        .values({ publicationId: live.publicationId, itemKey: live.itemKey, authorId: actor.userId, questionsAllowed: input.questionsAllowed, createdAt: now, updatedAt: now })
        .returning()) as [CardRow]
    }
    if (live.card?.questionsAllowed !== input.questionsAllowed) {
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'stuck_qa.questions_toggle',
        targetType: 'stuck_qa_card',
        targetId: card.id,
        metadata: { questionsAllowed: input.questionsAllowed },
      })
    }
    return cardDto(tx, actor, { ...live, card })
  })
}

// ── 스레드·글 ────────────────────────────────────────────────────────────

const bodySchema = z
  .string({ error: (i) => (i.input === undefined ? 'required' : 'invalid') })
  .transform((v, ctx) => {
    const body = normalizeStuckQaBody(v)
    if (!body) {
      ctx.addIssue({ code: 'custom', message: 'required' })
      return z.NEVER
    }
    if (body.length > STUCK_QA_BODY_MAX) {
      ctx.addIssue({ code: 'custom', message: 'too_long' })
      return z.NEVER
    }
    return body
  })

const questionSchema = z.object({ body: bodySchema })
const answerSchema = z.object({ body: bodySchema, countAsContribution: z.boolean({ error: 'invalid' }).optional().default(false) })

/** 이 사람의 이 스레드 표시를 정하고(필요하면 번호 행을 넣음) 글 행 값을 돌려줍니다. 호출자가 스레드 행을 잠갔어야 합니다. */
async function authorFields(tx: DbExecutor, threadId: string, userId: string, logAuthorId: string | null, opensThread: boolean, now: Date) {
  const existing = await tx.select({ userId: stuckQaAliases.userId, aliasNo: stuckQaAliases.aliasNo }).from(stuckQaAliases).where(eq(stuckQaAliases.threadId, threadId))
  const plan = assignStuckQaAlias({ existing, userId, logAuthorId: logAuthorId ?? '', opensThread })
  if (plan.kind === 'log_author') return { byLogAuthor: true, aliasNo: null }
  if (plan.kind === 'new') await tx.insert(stuckQaAliases).values({ threadId, userId, aliasNo: plan.aliasNo, createdAt: now })
  return { byLogAuthor: false, aliasNo: plan.aliasNo }
}

/** POST /stuck-qa/cards/:slug/:itemKey/threads {body} — 201 + 스레드. 404, 403 hub_write_not_allowed, 409 questions_closed, 422 own_card, 429. */
export async function createStuckQaThread(db: DbExecutor, actor: Actor, slug: unknown, itemKey: unknown, rawInput: unknown, now = new Date()): Promise<StuckQaThreadDto> {
  requireFeature('stuckQa')
  const input = parseInput(questionSchema, rawInput)
  const threadId = await db.transaction(async (tx) => {
    const live = await requireLiveCard(tx, slug, itemKey, now, true)
    await assertCanPost(tx, actor, live)
    if (live.logAuthorId === actor.userId) throw invalid({ card: 'own_card' })
    if (!(await hitRateLimit(tx, 'stuck_qa_thread', actor.userId, STUCK_QA_THREAD_RATE_LIMIT, now))) throw rateLimited()
    const [thread] = await tx.insert(stuckQaThreads).values({ cardId: live.card!.id, askerId: actor.userId, createdAt: now, lastPostAt: now }).returning()
    const author = await authorFields(tx, thread!.id, actor.userId, live.logAuthorId, true, now)
    await tx.insert(stuckQaPosts).values({ threadId: thread!.id, authorId: actor.userId, kind: 'question', ...author, body: input.body, createdAt: now, updatedAt: now })
    return thread!.id
  })
  return getStuckQaThread(db, actor, threadId, now)
}

/** GET /stuck-qa/threads/:id — 로그인 없이도. 404(스레드·카드가 지금 보이지 않음). */
export async function getStuckQaThread(db: DbExecutor, actor: Actor | null, threadId: unknown, now = new Date()): Promise<StuckQaThreadDto> {
  requireFeature('stuckQa')
  const found = await loadLiveThread(db, threadId, now)
  if (!found) throw notFound()
  const { thread, live } = found
  const posts = await db.select().from(stuckQaPosts).where(eq(stuckQaPosts.threadId, thread.id)).limit(STUCK_QA_POST_LIMIT)
  const counts = await helpedCounts(db, posts.filter((p) => p.kind === 'answer' && p.status === 'published').map((p) => p.id))
  const mineHelped = actor && posts.length
    ? new Set(
        (
          await db
            .select({ postId: stuckQaHelpful.postId })
            .from(stuckQaHelpful)
            .where(and(eq(stuckQaHelpful.userId, actor.userId), inArray(stuckQaHelpful.postId, posts.map((p) => p.id))))
        ).map((r) => r.postId),
      )
    : new Set<string>()
  const ranked = rankStuckQaPosts(posts.map((p) => ({ row: p, id: p.id, kind: p.kind, helped: counts.get(p.id) ?? 0, createdAt: p.createdAt.toISOString() })))
  return {
    id: thread.id,
    slug: live.slug,
    itemKey: live.itemKey,
    symptom: live.symptom,
    open: !!live.card?.questionsAllowed,
    posts: ranked.map(({ row }) => postDto(row, actor, mineHelped.has(row.id))),
    viewer: await viewerFor(db, actor, live),
  }
}

function postDto(row: PostRow, actor: Actor | null, helpedByMe: boolean): StuckQaPostDto {
  const { role, label } = stuckQaAuthorLabel(row)
  const mine = !!actor && row.authorId === actor.userId
  return {
    id: row.id,
    kind: row.kind,
    role,
    label,
    body: row.status === 'published' ? row.body : null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    mine,
    helpedByMe,
    countAsContribution: mine && row.kind === 'answer' ? row.countAsContribution : null,
  }
}

/** POST /stuck-qa/threads/:id/posts {body, countAsContribution?} — 201 + 스레드. 404, 403, 409 questions_closed, 429. */
export async function createStuckQaAnswer(db: DbExecutor, actor: Actor, threadId: unknown, rawInput: unknown, now = new Date()): Promise<StuckQaThreadDto> {
  requireFeature('stuckQa')
  const input = parseInput(answerSchema, rawInput)
  const id = await db.transaction(async (tx) => {
    const found = await loadLiveThread(tx, threadId, now)
    if (!found) throw notFound()
    const { live } = found
    await assertCanPost(tx, actor, live)
    // 같은 스레드의 번호 순서를 정하려고 스레드 행을 잠급니다.
    const [thread] = await tx.select().from(stuckQaThreads).where(eq(stuckQaThreads.id, found.thread.id)).limit(1).for('update')
    if (!(await hitRateLimit(tx, 'stuck_qa_post', actor.userId, STUCK_QA_POST_RATE_LIMIT, now))) throw rateLimited()
    const author = await authorFields(tx, thread!.id, actor.userId, live.logAuthorId, false, now)
    await tx.insert(stuckQaPosts).values({
      threadId: thread!.id,
      authorId: actor.userId,
      kind: 'answer',
      ...author,
      body: input.body,
      countAsContribution: input.countAsContribution,
      createdAt: now,
      updatedAt: now,
    })
    await tx.update(stuckQaThreads).set({ lastPostAt: now }).where(eq(stuckQaThreads.id, thread!.id))
    return thread!.id
  })
  return getStuckQaThread(db, actor, id, now)
}

const contributionSchema = z.object({ countAsContribution: z.boolean({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }) })

/** PATCH /stuck-qa/posts/:id {countAsContribution} — 내 답변만(아니면 404), 지금 보이는 스레드에서. 200 + 글. */
export async function setStuckQaContribution(db: DbExecutor, actor: Actor, postId: unknown, rawInput: unknown, now = new Date()): Promise<StuckQaPostDto> {
  requireFeature('stuckQa')
  const input = parseInput(contributionSchema, rawInput)
  const found = await loadLivePost(db, postId, now)
  if (!found || found.post.authorId !== actor.userId || found.post.kind !== 'answer' || found.post.status === 'withdrawn') throw notFound()
  const [row] = await db
    .update(stuckQaPosts)
    .set({ countAsContribution: input.countAsContribution, updatedAt: now })
    .where(eq(stuckQaPosts.id, found.post.id))
    .returning()
  const [helped] = await db.select({ id: stuckQaHelpful.id }).from(stuckQaHelpful).where(and(eq(stuckQaHelpful.postId, row!.id), eq(stuckQaHelpful.userId, actor.userId))).limit(1)
  return postDto(row!, actor, !!helped)
}

/**
 * DELETE /stuck-qa/posts/:id — 내 글 지우기(본문을 비우고 번호·자리는 남김). 카드가 닫히거나 공개가 철회돼도 지울 수 있습니다. 204. 남의 글·없는 글 404.
 * 이미 지웠으면 그대로(204). 운영 조치로 숨긴 글도 지울 수 있습니다(숨김을 되돌려도 지운 상태로 남음).
 */
export async function withdrawStuckQaPost(db: DbExecutor, actor: Actor, postId: unknown, now = new Date()): Promise<void> {
  requireFeature('stuckQa')
  if (!isUuid(postId)) throw notFound()
  const [post] = await db.select().from(stuckQaPosts).where(eq(stuckQaPosts.id, postId.toLowerCase())).limit(1)
  if (!post || post.authorId !== actor.userId) throw notFound()
  if (post.status === 'withdrawn') return
  await db
    .update(stuckQaPosts)
    .set({ status: 'withdrawn', body: '', countAsContribution: false, withdrawnAt: now, updatedAt: now })
    .where(eq(stuckQaPosts.id, post.id))
}

/** PUT·DELETE /stuck-qa/posts/:id/helpful — 게시 중인 남의 답변에만. 200 `{helpedByMe}`(개수 없음). 404, 422 own_post·not_answer, 429. */
export async function setStuckQaHelpful(db: DbExecutor, actor: Actor, postId: unknown, helped: boolean, now = new Date()): Promise<{ helpedByMe: boolean }> {
  requireFeature('stuckQa')
  const found = await loadLivePost(db, postId, now)
  if (!found || found.post.status !== 'published') throw notFound()
  if (found.post.kind !== 'answer') throw invalid({ post: 'not_answer' })
  if (found.post.authorId === actor.userId) throw invalid({ post: 'own_post' })
  if (helped) {
    if (!(await hitRateLimit(db, 'stuck_qa_helpful', actor.userId, STUCK_QA_HELPFUL_RATE_LIMIT, now))) throw rateLimited()
    await db.insert(stuckQaHelpful).values({ postId: found.post.id, userId: actor.userId, createdAt: now }).onConflictDoNothing()
  } else {
    await db.delete(stuckQaHelpful).where(and(eq(stuckQaHelpful.postId, found.post.id), eq(stuckQaHelpful.userId, actor.userId)))
  }
  return { helpedByMe: helped }
}

// ── 신고·운영 (moderation 모듈이 부름) ─────────────────────────────────────

/** 신고할 수 있는 막힘 Q&A 글: 플래그가 켜져 있고, 지금 보이는 스레드의 게시 중인 글. 아니면 404. */
export async function resolveReportableStuckQaPost(db: DbExecutor, rawRef: unknown, now: Date): Promise<string> {
  requireFeature('stuckQa')
  const ref = z.object({ stuckQaPostId: z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()) }).safeParse(rawRef ?? {})
  if (!ref.success) throw invalid(issuesToFields(ref.error.issues, 'targetRef'))
  const found = await loadLivePost(db, ref.data.stuckQaPostId, now)
  if (!found || found.post.status !== 'published') throw notFound()
  return found.post.id
}

/** 글이 지금 보이는지(스레드·카드가 보이고 글이 published). 운영 화면의 "지금 공개 중" 표시용. */
export async function isStuckQaPostVisible(db: DbExecutor, postId: string, now: Date): Promise<boolean> {
  const found = await loadLivePost(db, postId, now)
  return !!found && found.post.status === 'published'
}

/** 운영자·큐레이터 화면의 글 내용(표시·본문·상태, 작성자 없음). 없으면 null. */
export async function moderationStuckQaPost(db: DbExecutor, postId: string): Promise<StuckQaModerationPostDto | null> {
  const [row] = await db
    .select({ post: stuckQaPosts, slug: publications.slug })
    .from(stuckQaPosts)
    .innerJoin(stuckQaThreads, eq(stuckQaThreads.id, stuckQaPosts.threadId))
    .innerJoin(stuckQaCards, eq(stuckQaCards.id, stuckQaThreads.cardId))
    .innerJoin(publications, eq(publications.id, stuckQaCards.publicationId))
    .where(eq(stuckQaPosts.id, postId))
    .limit(1)
  if (!row) return null
  const [question] = await db
    .select({ body: stuckQaPosts.body })
    .from(stuckQaPosts)
    .where(and(eq(stuckQaPosts.threadId, row.post.threadId), eq(stuckQaPosts.kind, 'question')))
    .limit(1)
  return {
    id: row.post.id,
    kind: row.post.kind,
    label: stuckQaAuthorLabel(row.post).label,
    body: row.post.body,
    status: row.post.status,
    question: stuckQaExcerpt(question?.body ?? ''),
    slug: row.slug,
    createdAt: row.post.createdAt.toISOString(),
  }
}

/** 운영자 신고 목록의 이름표("막힘 Q&A 질문·답변 · /p/slug"). */
export async function stuckQaPostLabels(db: DbExecutor, postIds: readonly string[]): Promise<Map<string, string>> {
  if (postIds.length === 0) return new Map()
  const rows = await db
    .select({ id: stuckQaPosts.id, kind: stuckQaPosts.kind, slug: publications.slug })
    .from(stuckQaPosts)
    .innerJoin(stuckQaThreads, eq(stuckQaThreads.id, stuckQaPosts.threadId))
    .innerJoin(stuckQaCards, eq(stuckQaCards.id, stuckQaThreads.cardId))
    .innerJoin(publications, eq(publications.id, stuckQaCards.publicationId))
    .where(inArray(stuckQaPosts.id, [...postIds]))
  return new Map(rows.map((r) => [r.id, `막힘 Q&A ${r.kind === 'question' ? '질문' : '답변'} · /p/${r.slug}`]))
}

/** 조치의 당사자(글쓴이, 탈퇴 정리 뒤에도 가명 처리된 계정 id). */
export async function stuckQaPostAuthorIds(db: DbExecutor, postId: string | null): Promise<string[]> {
  if (!postId) return []
  const [row] = await db.select({ authorId: stuckQaPosts.authorId }).from(stuckQaPosts).where(eq(stuckQaPosts.id, postId)).limit(1)
  return row?.authorId ? [row.authorId] : []
}

/** 당사자 안내의 경로(스레드 화면). */
export async function stuckQaPostOwnerPath(db: DbExecutor, postId: string): Promise<string | null> {
  const [row] = await db.select({ threadId: stuckQaPosts.threadId }).from(stuckQaPosts).where(eq(stuckQaPosts.id, postId)).limit(1)
  return row ? stuckQaThreadPath(row.threadId) : null
}

/** hide_stuck_qa_post 적용: 행을 잠그고 published → hidden(없으면 404, 게시 중이 아니면 409 target_not_public). */
export async function hideStuckQaPostInTx(tx: DbExecutor, postId: string, now: Date): Promise<void> {
  const [post] = await tx.select({ status: stuckQaPosts.status }).from(stuckQaPosts).where(eq(stuckQaPosts.id, postId)).limit(1).for('update')
  if (!post) throw notFound()
  if (post.status !== 'published') throw conflict('target_not_public')
  await tx.update(stuckQaPosts).set({ status: 'hidden', updatedAt: now }).where(eq(stuckQaPosts.id, postId))
}

/** 되돌림: hidden → published(그사이 작성자가 지웠으면 그대로). */
export async function unhideStuckQaPostInTx(tx: DbExecutor, postId: string, now: Date): Promise<void> {
  await tx
    .update(stuckQaPosts)
    .set({ status: 'published', updatedAt: now })
    .where(and(eq(stuckQaPosts.id, postId), eq(stuckQaPosts.status, 'hidden')))
}

const lookupSchema = z.object({ reportId: z.uuid({ error: (i) => (i.input === undefined ? 'required' : 'invalid') }).transform((id) => id.toLowerCase()) })

/**
 * POST /operator/stuck-qa/posts/:id/author-lookup {reportId} — 운영자만(403 operator_only). 그 글을 가리키는 신고(상태 무관)가 있어야 합니다(아니면 404).
 * 감사 `stuck_qa.author_lookup`(글 id·신고 id만). 작성자(내부 id·handle·계정 상태)는 이 응답에만 있습니다. 플래그와 무관하게 동작합니다(이미 받은 신고 처리).
 */
export async function operatorStuckQaAuthor(db: DbExecutor, actor: Actor, postId: unknown, rawInput: unknown): Promise<StuckQaAuthorLookupDto> {
  await requireOperator(db, actor)
  const input = parseInput(lookupSchema, rawInput)
  if (!isUuid(postId)) throw notFound()
  const id = postId.toLowerCase()
  return db.transaction(async (tx) => {
    const [report] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, input.reportId), eq(reports.stuckQaPostId, id))).limit(1)
    if (!report) throw notFound()
    const [post] = await tx.select({ authorId: stuckQaPosts.authorId, byLogAuthor: stuckQaPosts.byLogAuthor }).from(stuckQaPosts).where(eq(stuckQaPosts.id, id)).limit(1)
    if (!post) throw notFound()
    const [author] = post.authorId
      ? await tx
          .select({ userId: users.id, status: users.status, handle: profiles.handle })
          .from(users)
          .leftJoin(profiles, and(eq(profiles.userId, users.id), isNull(profiles.hiddenAt)))
          .where(eq(users.id, post.authorId))
          .limit(1)
      : []
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'stuck_qa.author_lookup',
      targetType: 'stuck_qa_post',
      targetId: id,
      metadata: { reportId: report.id },
    })
    return {
      postId: id,
      reportId: report.id,
      author: author ? { userId: author.userId, handle: author.handle ?? null, status: author.status } : null,
      byLogAuthor: post.byLogAuthor,
    }
  })
}

