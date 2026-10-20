/**
 * 선배 노트 (T-13, PROOFU_EVOLUTION_PLAN §8.3·§8.6, supply-kit §2, SYSTEM_DESIGN §6.2 SeniorNote, ADR 0013).
 *
 * - 작성: 로그인 + `canWriteToCourseHub`(지금은 active 사용자면 됨; 학교 인증·허브 개방 조건을 넣을 자리). 병합된 과목 id면 정본에 씁니다.
 *   "정답·답안·교수 개인 평가 없음" 확인(noAnswersConfirmed: true)이 필수이고, 질문 4개 중 2개 이상 답해야 합니다(각 1000자).
 *   만들기는 사용자별 한도(시간당 5회)와 사용자·과목당 3개 한도가 있습니다.
 * - 수정(PATCH)·게시·철회는 작성자만(다른 사람에게는 404 — 초안의 존재를 드러내지 않음). 수정은 expectedVersion(409 version_conflict).
 *   게시된 노트를 고치면 draft로 돌아갑니다(점검을 다시 거쳐 게시). 이때도 철회 이벤트를 남겨 검색 문서·신호를 정리합니다.
 * - 게시: 공개 전 점검 규칙(@peerchive/domain runPublicationChecks: 전화·메일·주민번호·학번·사설 URL·긴 코드)을 돌려 경고가 있으면
 *   `confirmWarnings: true` 없이는 409 `checks_unconfirmed`(+경고). 경고는 막지 않고 확인을 받습니다(판단은 학생).
 * - 철회: 작성자가 언제든, 즉시. 공개 읽기는 status = 'published'만 보므로 커밋 즉시 사라집니다. 검색 문서·신호 정리는 worker.
 * - 작성자 표시: 계정 이름 / 표시명 / 익명("익명 선배"). 공개 응답에는 작성자 id가 없고, 운영자는 감사 기록(actor)으로만 압니다.
 */
import { z } from 'zod'
import {
  SENIOR_NOTE_DISPLAY_MODES,
  SENIOR_NOTE_DISPLAY_NAME_MAX,
  SENIOR_NOTE_PER_COURSE_LIMIT,
  SENIOR_NOTE_TERM_LABEL_MAX,
  SENIOR_NOTE_TIME_BUCKETS,
  canWriteToCourseHub,
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
import { loadCanonicalCourse } from '../catalog/catalog'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, rateLimited } from '../errors'
import { seniorNoteNotice } from '../moderation/notices'
import { isUuid } from '../projects/access'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import type { PublicationCheckDto, SeniorNoteDto } from '../../../shared/types/api'

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
    const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1)
    if (!canWriteToCourseHub(user ?? null, course)) throw forbidden('hub_write_not_allowed')
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
    // 작성 자격은 게시 때도 다시 봅니다(정지·탈퇴 계정, 나중에 더할 학교 인증 조건).
    const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, actor.userId)).limit(1)
    const [course] = await tx.select({ id: courses.id, mergedInto: courses.mergedInto }).from(courses).where(eq(courses.id, row.courseId)).limit(1)
    if (!canWriteToCourseHub(user ?? null, course ?? null)) throw forbidden('hub_write_not_allowed')
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
