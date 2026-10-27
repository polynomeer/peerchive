/**
 * 선배 노트 (T-13, PROOFU_EVOLUTION_PLAN §8.3·§8.6, supply-kit §2, SYSTEM_DESIGN §6.2 SeniorNote, ADR 0013).
 *
 * - 작성: 로그인 + `canWriteToCourseHub`(active 사용자 + 그 과목 학교의 active 학교 메일 인증, C-01·ADR 0018; 허브 개방 조건을 넣을 자리).
 *   인증이 없으면 403 `hub_write_not_allowed` + `requirement: 'school_affiliation'`·`schoolId`(화면이 인증 페이지로 안내). 병합된 과목 id면 정본에 씁니다.
 *   "정답·답안·교수 개인 평가 없음" 확인(noAnswersConfirmed: true)이 필수이고, 질문 4개 중 2개 이상 답해야 합니다(각 1000자).
 *   만들기는 사용자별 한도(시간당 5회)와 사용자·과목당 3개 한도가 있습니다.
 * - 수정(PATCH)·게시·철회는 작성자만(다른 사람에게는 404 — 초안의 존재를 드러내지 않음). 수정은 expectedVersion(409 version_conflict).
 *   게시된 노트를 고치면 draft로 돌아갑니다(점검을 다시 거쳐 게시). 이때도 철회 이벤트를 남겨 검색 문서·신호를 정리합니다.
 * - 게시: 공개 전 점검 규칙(@peerchive/domain runPublicationChecks: 전화·메일·주민번호·학번·사설 URL·긴 코드)을 돌려 경고가 있으면
 *   `confirmWarnings: true` 없이는 409 `checks_unconfirmed`(+경고). 경고는 막지 않고 확인을 받습니다(판단은 학생).
 * - 철회: 작성자가 언제든, 즉시. 공개 읽기는 status = 'published'만 보므로 커밋 즉시 사라집니다. 검색 문서·신호 정리는 worker.
 * - 작성자 표시: 계정 이름 / 표시명 / 익명("익명 선배"). 공개 응답에는 작성자 id가 없고, 운영자는 감사 기록(actor)으로만 압니다.
 * - C-09(ADR 0025): 커뮤니티 글을 옮겨 만든 초안(`createSeniorNoteDraftFromTransfer`)은 답이 하나뿐일 수 있습니다. 게시할 때 답 2개 이상을 다시
 *   확인합니다(422 `answers: too_few`). 작성 자격·과목당 한도·만들기 한도는 직접 만들기와 같습니다.
 */
import { z } from 'zod'
import {
  SENIOR_NOTE_DISPLAY_MODES,
  SENIOR_NOTE_DISPLAY_NAME_MAX,
  SENIOR_NOTE_PER_COURSE_LIMIT,
  SENIOR_NOTE_TERM_LABEL_MAX,
  SENIOR_NOTE_TIME_BUCKETS,
  hubWriteDecision,
  normalizeLabel,
  normalizeSeniorNoteAnswers,
  runPublicationChecks,
  seniorNoteAuthorLabel,
  seniorNoteCheckItems,
  type SeniorNoteAnswers,
} from '@peerchive/domain'
import {
  SENIOR_NOTE_PUBLISHED_TOPIC,
  SENIOR_NOTE_WITHDRAWN_TOPIC,
  and,
  courses,
  desc,
  eq,
  ne,
  outboxEvents,
  schools,
  seniorNotes,
  sql,
  users,
  type DbExecutor,
  type SeniorNoteOutboxPayload,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { activeAffiliationSchoolIds } from '../affiliation/affiliations'
import { hubWritePolicy } from '../affiliation/config'
import { emitAnalytics } from '../analytics/analytics'
import { loadCanonicalCourse } from '../catalog/catalog'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, rateLimited } from '../errors'
import { seniorNoteNotice } from '../moderation/notices'
import { isUuid } from '../projects/access'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import type { HubWriteEligibilityDto, PublicationCheckDto, SeniorNoteDto } from '../../../shared/types/api'

/** 선배 노트 만들기 한도(사용자별, 시간당). */
export const SENIOR_NOTE_CREATE_RATE_LIMIT: RateLimitRule = { limit: 5, windowMs: 60 * 60 * 1000 }

type NoteRow = typeof seniorNotes.$inferSelect

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const optionalShort = (max: number) =>
  z
    .string({ error: 'invalid' })
    .transform(normalizeLabel)
    .pipe(z.string().max(max, { error: 'too_long' }))
    .nullish()
    .transform((value) => (value ? value : null))

const fields = {
  displayMode: z.enum(SENIOR_NOTE_DISPLAY_MODES, { error: requiredOr('invalid') }),
  displayName: optionalShort(SENIOR_NOTE_DISPLAY_NAME_MAX),
  termLabel: optionalShort(SENIOR_NOTE_TERM_LABEL_MAX),
  totalTimeBucket: z.enum(SENIOR_NOTE_TIME_BUCKETS, { error: 'invalid' }).nullish().transform((v) => v ?? null),
  answers: z.unknown(),
}

export const createSeniorNoteSchema = z.object({
  ...fields,
  /** "이 노트에 과제 정답·답안·교수 개인 평가가 포함되어 있지 않습니다." 체크(필수). */
  noAnswersConfirmed: z.literal(true, { error: 'confirm_required' }),
})

export const updateSeniorNoteSchema = z.object({
  expectedVersion: z.number({ error: requiredOr('invalid') }).int({ error: 'invalid' }).min(1, { error: 'invalid' }),
  displayMode: fields.displayMode.optional(),
  displayName: fields.displayName.optional(),
  termLabel: fields.termLabel.optional(),
  totalTimeBucket: fields.totalTimeBucket.optional(),
  answers: z.unknown().optional(),
})

export const publishSeniorNoteSchema = z.object({
  expectedVersion: z.number({ error: requiredOr('invalid') }).int({ error: 'invalid' }).min(1, { error: 'invalid' }),
  /** 공개 전 점검 경고를 보고 그대로 게시할 때 true. */
  confirmWarnings: z.boolean({ error: 'invalid' }).default(false),
})

function parseAnswers(raw: unknown): SeniorNoteAnswers {
  const result = normalizeSeniorNoteAnswers(raw)
  if (!result.ok) throw invalid(result.fields)
  return result.answers
}

/** display 모드면 표시명이 필요합니다. */
function checkDisplay(mode: NoteRow['displayMode'], displayName: string | null): void {
  if (mode === 'display' && !displayName) throw invalid({ displayName: 'required' })
}

async function accountName(db: DbExecutor, userId: string): Promise<string | null> {
  const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
  const name = user?.displayName.trim()
  return name ? name.slice(0, 80) : null
}

/** 저장할 표시 이름: name이면 지금 계정 이름, display면 입력값, anonymous면 null. */
async function displaySnapshot(db: DbExecutor, userId: string, mode: NoteRow['displayMode'], displayName: string | null) {
  if (mode === 'anonymous') return null
  if (mode === 'display') return displayName
  return accountName(db, userId)
}

function warningsFor(row: Pick<NoteRow, 'answers' | 'displayMode' | 'displayNameSnapshot' | 'termLabel'>): PublicationCheckDto[] {
  const checks = runPublicationChecks(
    seniorNoteCheckItems({
      answers: row.answers as SeniorNoteAnswers,
      // 계정 이름(name 모드)은 작성자가 고른 공개 이름이므로 점검하지 않고, 직접 입력한 표시명만 봅니다.
      displayName: row.displayMode === 'display' ? row.displayNameSnapshot : null,
      termLabel: row.termLabel,
    }),
  )
  return checks.map((c) => ({ rule: c.rule, location: c.location, sample: c.sample, fixUrl: null }))
}

async function toDto(db: DbExecutor, row: NoteRow): Promise<SeniorNoteDto> {
  const [course] = await db
    .select({ id: courses.id, title: courses.title, schoolName: schools.name })
    .from(courses)
    .innerJoin(schools, eq(schools.id, courses.schoolId))
    .where(eq(courses.id, row.courseId))
    .limit(1)
  return {
    id: row.id,
    course: course ?? { id: row.courseId, title: '', schoolName: '' },
    displayMode: row.displayMode,
    displayName: row.displayMode === 'anonymous' ? null : row.displayNameSnapshot,
    publicLabel: seniorNoteAuthorLabel(row.displayMode, row.displayNameSnapshot),
    termLabel: row.termLabel,
    totalTimeBucket: row.totalTimeBucket,
    answers: row.answers as SeniorNoteAnswers,
    status: row.status,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    warnings: warningsFor(row),
    // 운영 조치로 숨긴 노트면 그 안내(T-15). 작성자에게만 주는 DTO입니다.
    moderation: row.status === 'hidden' ? await seniorNoteNotice(db, { userId: row.authorId }, row.id) : null,
  }
}

/** 작성 자격 판정(만들기·게시·화면 안내 공통). 과목은 정본·과목 학교는 병합을 따라간 정본입니다. */
async function writeDecision(tx: DbExecutor, actor: Actor, course: { id: string; mergedInto: string | null; schoolId: string }) {
  const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1)
  const [school] = await tx
    .select({ id: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})` })
    .from(schools)
    .where(eq(schools.id, course.schoolId))
    .limit(1)
  const decision = hubWriteDecision(
    user ? { status: user.status, activeSchoolIds: await activeAffiliationSchoolIds(tx, actor.userId) } : null,
    { id: course.id, mergedInto: course.mergedInto, schoolId: school?.id ?? null },
    hubWritePolicy(),
  )
  return { decision, schoolId: school?.id ?? null }
}

/**
 * 작성 자격 확인(만들기·게시 때 모두). 과목은 정본이어야 하고, 정책상 요구하면 그 과목 학교(정본)의 active 학교 메일 인증이 있어야 합니다.
 * 인증이 없어서 막히면 화면이 인증 페이지로 안내할 수 있게 requirement·schoolId를 싣습니다.
 */
export async function assertCanWrite(tx: DbExecutor, actor: Actor, course: { id: string; mergedInto: string | null; schoolId: string }): Promise<void> {
  const { decision, schoolId } = await writeDecision(tx, actor, course)
  if (decision.ok) return
  if (decision.reason === 'affiliation_required') {
    throw new ServiceError('FORBIDDEN', 'hub_write_not_allowed', undefined, { requirement: 'school_affiliation', schoolId })
  }
  throw forbidden('hub_write_not_allowed')
}

/**
 * GET /me/hub-write?course= — 이 과목 허브에 쓸 수 있는지(화면 안내용). 404(없는 과목).
 * `requirement: 'school_affiliation'`이면 그 학교(정본) 메일로 인증하면 쓸 수 있습니다.
 */
export async function getHubWriteEligibility(db: DbExecutor, actor: Actor, courseId: unknown): Promise<HubWriteEligibilityDto> {
  const course = await loadCanonicalCourse(db, courseId)
  const { decision, schoolId } = await writeDecision(db, actor, course)
  const [school] = schoolId ? await db.select({ id: schools.id, name: schools.name }).from(schools).where(eq(schools.id, schoolId)).limit(1) : []
  return {
    courseId: course.id,
    allowed: decision.ok,
    requirement: !decision.ok && decision.reason === 'affiliation_required' ? 'school_affiliation' : null,
    school: school ?? { id: course.schoolId, name: '' },
  }
}

const outboxPayload = (row: NoteRow): SeniorNoteOutboxPayload => ({ seniorNoteId: row.id, courseId: row.courseId, version: row.version })

// ── 만들기 ───────────────────────────────────────────────────────────────

/** POST /courses/:id/senior-notes — 201 + 노트(초안). 404(없는 과목), 403 hub_write_not_allowed, 409 limit_reached, 422, 429. */
export async function createSeniorNote(
  db: DbExecutor,
  actor: Actor,
  courseId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<SeniorNoteDto> {
  const course = await loadCanonicalCourse(db, courseId)
  const input = parseInput(createSeniorNoteSchema, rawInput)
  const answers = parseAnswers(input.answers)
  checkDisplay(input.displayMode, input.displayName)
  return db.transaction(async (tx) => {
    await assertCanWrite(tx, actor, course)
    if (!(await hitRateLimit(tx, 'senior_note_create', actor.userId, SENIOR_NOTE_CREATE_RATE_LIMIT, now))) throw rateLimited()
    // 같은 사용자의 동시 만들기를 직렬화해 과목당 한도를 지킵니다.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`senior-note:${actor.userId}:${course.id}`}))`)
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(seniorNotes)
      .where(and(eq(seniorNotes.authorId, actor.userId), eq(seniorNotes.courseId, course.id), ne(seniorNotes.status, 'hidden')))
    if (count >= SENIOR_NOTE_PER_COURSE_LIMIT) throw conflict('limit_reached', { limit: SENIOR_NOTE_PER_COURSE_LIMIT })
    const [row] = await tx
      .insert(seniorNotes)
      .values({
        courseId: course.id,
        authorId: actor.userId,
        displayMode: input.displayMode,
        displayNameSnapshot: await displaySnapshot(tx, actor.userId, input.displayMode, input.displayName),
        termLabel: input.termLabel,
        totalTimeBucket: input.totalTimeBucket,
        answers,
        noAnswersConfirmed: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'senior_note.create',
      targetType: 'senior_note',
      targetId: row!.id,
      metadata: { courseId: course.id, displayMode: input.displayMode },
    })
    return toDto(tx, row!)
  })
}

/**
 * 커뮤니티 글에서 옮겨 온 선배 노트 초안(C-09, 옮기기 트랜잭션 안에서). 글 본문을 고른 질문 하나의 답으로 넣습니다(1000자 이하는 호출자가 확인).
 * 작성 자격(403 hub_write_not_allowed)·만들기 한도(429)·과목당 3개(409 limit_reached)는 직접 만들기와 같습니다. 정본 과목 id를 넘기세요.
 */
export async function createSeniorNoteDraftFromTransfer(
  tx: DbExecutor,
  actor: Actor,
  course: { id: string; mergedInto: string | null; schoolId: string },
  input: { answerKey: keyof SeniorNoteAnswers; body: string; displayMode: NoteRow['displayMode']; displayName: string | null },
  now: Date,
): Promise<SeniorNoteDto> {
  checkDisplay(input.displayMode, input.displayName)
  await assertCanWrite(tx, actor, course)
  if (!(await hitRateLimit(tx, 'senior_note_create', actor.userId, SENIOR_NOTE_CREATE_RATE_LIMIT, now))) throw rateLimited()
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`senior-note:${actor.userId}:${course.id}`}))`)
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(seniorNotes)
    .where(and(eq(seniorNotes.authorId, actor.userId), eq(seniorNotes.courseId, course.id), ne(seniorNotes.status, 'hidden')))
  if (count >= SENIOR_NOTE_PER_COURSE_LIMIT) throw conflict('limit_reached', { limit: SENIOR_NOTE_PER_COURSE_LIMIT })
  const [row] = await tx
    .insert(seniorNotes)
    .values({
      courseId: course.id,
      authorId: actor.userId,
      displayMode: input.displayMode,
      displayNameSnapshot: await displaySnapshot(tx, actor.userId, input.displayMode, input.displayName),
      answers: { [input.answerKey]: input.body },
      noAnswersConfirmed: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  await recordAudit(tx, {
    actorId: actor.userId,
    action: 'senior_note.create',
    targetType: 'senior_note',
    targetId: row!.id,
    metadata: { courseId: course.id, displayMode: input.displayMode, transferred: true },
  })
  return toDto(tx, row!)
}

/** 작성자의 노트를 잠그고 읽습니다. 작성자가 아니면 404. */
async function loadOwnNote(tx: DbExecutor, actor: Actor, noteId: unknown): Promise<NoteRow> {
  if (!isUuid(noteId)) throw notFound()
  const [row] = await tx.select().from(seniorNotes).where(eq(seniorNotes.id, noteId.toLowerCase())).limit(1).for('update')
  if (!row || row.authorId !== actor.userId) throw notFound()
  return row
}

async function emit(tx: DbExecutor, topic: string, row: NoteRow, now: Date) {
  await tx.insert(outboxEvents).values({ topic, payload: { ...outboxPayload(row) }, createdAt: now })
}

// ── 수정 ─────────────────────────────────────────────────────────────────

/**
 * PATCH /senior-notes/:id — 작성자만(아니면 404). 200 + 노트. 낡은 expectedVersion 409 version_conflict(+currentVersion),
 * 운영자가 숨긴 노트 409 hidden. 게시된 노트를 고치면 draft로 돌아갑니다(다시 게시해야 공개).
 */
export async function updateSeniorNote(
  db: DbExecutor,
  actor: Actor,
  noteId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<SeniorNoteDto> {
  const input = parseInput(updateSeniorNoteSchema, rawInput)
  const answers = input.answers === undefined ? undefined : parseAnswers(input.answers)
  return db.transaction(async (tx) => {
    const row = await loadOwnNote(tx, actor, noteId)
    if (row.status === 'hidden') throw conflict('hidden')
    if (row.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: row.version })
    const displayMode = input.displayMode ?? row.displayMode
    const displayName =
      input.displayName !== undefined ? input.displayName : displayMode === 'display' && row.displayMode === 'display' ? row.displayNameSnapshot : null
    checkDisplay(displayMode, displayName)
    const wasPublished = row.status === 'published'
    const [updated] = await tx
      .update(seniorNotes)
      .set({
        displayMode,
        displayNameSnapshot: await displaySnapshot(tx, actor.userId, displayMode, displayName),
        ...(input.termLabel !== undefined && { termLabel: input.termLabel }),
        ...(input.totalTimeBucket !== undefined && { totalTimeBucket: input.totalTimeBucket }),
        ...(answers && { answers }),
        ...(wasPublished && { status: 'draft' as const, withdrawnAt: now }),
        version: row.version + 1,
        updatedAt: now,
      })
      .where(eq(seniorNotes.id, row.id))
      .returning()
    // 게시된 것을 고치면 공개에서 내려갑니다. 검색 문서·신호 정리는 철회와 같은 이벤트로 합니다.
    if (wasPublished) await emit(tx, SENIOR_NOTE_WITHDRAWN_TOPIC, updated!, now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'senior_note.update',
      targetType: 'senior_note',
      targetId: row.id,
      metadata: { version: updated!.version, unpublished: wasPublished },
    })
    return toDto(tx, updated!)
  })
}

// ── 게시·철회 ────────────────────────────────────────────────────────────

/**
 * POST /senior-notes/:id/publish {expectedVersion, confirmWarnings?} — 작성자만. 200 + 노트.
 * 경고가 있는데 confirmWarnings가 아니면 409 checks_unconfirmed(+warnings), 낡은 버전 409 version_conflict, 숨김 409 hidden.
 * 이미 같은 버전으로 게시되어 있으면 그대로 200.
 */
export async function publishSeniorNote(
  db: DbExecutor,
  actor: Actor,
  noteId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<SeniorNoteDto> {
  const input = parseInput(publishSeniorNoteSchema, rawInput)
  return db.transaction(async (tx) => {
    const row = await loadOwnNote(tx, actor, noteId)
    if (row.status === 'hidden') throw conflict('hidden')
    if (row.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: row.version })
    if (row.status === 'published') return toDto(tx, row)
    // 옮겨 온 초안(C-09)은 답이 하나일 수 있습니다: 게시 전에 답 2개 이상을 다시 확인합니다.
    const answersCheck = normalizeSeniorNoteAnswers(row.answers)
    if (!answersCheck.ok) throw invalid(answersCheck.fields)
    // 작성 자격은 게시 때도 다시 봅니다(정지·탈퇴 계정, 학교 인증 해제·취소).
    const [course] = await tx
      .select({ id: courses.id, mergedInto: courses.mergedInto, schoolId: courses.schoolId })
      .from(courses)
      .where(eq(courses.id, row.courseId))
      .limit(1)
    if (!course) throw forbidden('hub_write_not_allowed')
    await assertCanWrite(tx, actor, course)
    const displayNameSnapshot = await displaySnapshot(tx, actor.userId, row.displayMode, row.displayNameSnapshot)
    const warnings = warningsFor({ ...row, displayNameSnapshot })
    if (warnings.length > 0 && !input.confirmWarnings) {
      throw new ServiceError('CONFLICT', 'checks_unconfirmed', undefined, {
        warnings: warnings.map((w) => ({ rule: w.rule, field: w.location.field, sample: w.sample })),
      })
    }
    const [updated] = await tx
      .update(seniorNotes)
      .set({ status: 'published', publishedAt: now, withdrawnAt: null, displayNameSnapshot, updatedAt: now })
      .where(eq(seniorNotes.id, row.id))
      .returning()
    await emit(tx, SENIOR_NOTE_PUBLISHED_TOPIC, updated!, now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'senior_note.publish',
      targetType: 'senior_note',
      targetId: row.id,
      metadata: { courseId: row.courseId, version: row.version, warnings: warnings.length, displayMode: row.displayMode },
    })
    await emitAnalytics(tx, {
      name: 'senior_note_published',
      actorId: actor.userId,
      props: { displayMode: row.displayMode, answers: Object.values(row.answers ?? {}).filter((a) => typeof a === 'string' && a.trim()).length },
    })
    return toDto(tx, updated!)
  })
}

/** POST /senior-notes/:id/withdraw — 작성자만. 200(이미 철회도 200). 게시된 적 없는 초안 409 not_published. */
export async function withdrawSeniorNote(db: DbExecutor, actor: Actor, noteId: unknown, now = new Date()): Promise<SeniorNoteDto> {
  return db.transaction(async (tx) => {
    const row = await loadOwnNote(tx, actor, noteId)
    if (row.status === 'withdrawn') return toDto(tx, row)
    if (row.status !== 'published') throw conflict('not_published')
    const [updated] = await tx
      .update(seniorNotes)
      .set({ status: 'withdrawn', withdrawnAt: now, updatedAt: now })
      .where(eq(seniorNotes.id, row.id))
      .returning()
    await emit(tx, SENIOR_NOTE_WITHDRAWN_TOPIC, updated!, now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'senior_note.withdraw',
      targetType: 'senior_note',
      targetId: row.id,
      metadata: { courseId: row.courseId },
    })
    return toDto(tx, updated!)
  })
}

/** GET /me/senior-notes?course= — 내 노트(최근 수정 순). course를 주면 그 과목(정본·병합 포함)만. */
export async function listMySeniorNotes(db: DbExecutor, actor: Actor, courseId?: unknown): Promise<SeniorNoteDto[]> {
  let canonical: string | null = null
  if (courseId !== undefined && courseId !== null && courseId !== '') {
    canonical = (await loadCanonicalCourse(db, courseId)).id
  }
  const rows = await db
    .select()
    .from(seniorNotes)
    .where(and(eq(seniorNotes.authorId, actor.userId), canonical ? eq(seniorNotes.courseId, canonical) : undefined))
    .orderBy(desc(seniorNotes.updatedAt), desc(seniorNotes.id))
    .limit(50)
  return Promise.all(rows.map((r) => toDto(db, r)))
}
