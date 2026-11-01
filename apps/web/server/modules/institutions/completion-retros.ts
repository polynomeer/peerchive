/**
 * 수료 회고 (A-06, PROOFU_EVOLUTION_PLAN §8.9.10 "가져오지 않는 것"·§8.9.11, SYSTEM_DESIGN §6.7.2 "수료 회고", DELIVERY_PLAN §4.3 A-06, ADR 0043).
 *
 * 모든 경로는 P2 `institutions` 플래그가 꺼져 있으면 404입니다(`requireFeature`). 운영 도구(신고 상세·조치)·탈퇴 정리는 플래그와 무관합니다.
 *
 * - **쓰기**: 대학이 아닌 기관(부트캠프·교육 프로그램·동아리 연합)의 **수료생**(standing alumni, active + verified 소속, active 계정)만, 그 소속으로.
 *   선배 노트 형식(질문별 답, 2개 이상, 각 1000자)이고 별점·연봉·추천 점수 필드는 없습니다(표에도 입력에도 — 모르는 키는 422). 쓰는 순간 게시되며
 *   사람·기관마다 공개(·숨김) 회고는 하나입니다(409 `retro_exists`, 철회하면 다시 씀). 공개 전 점검 규칙(전화·메일 등) 경고는 확인을 받습니다.
 * - **이름 표시**: 계정 이름 / 표시명 페르소나 이름(없으면 403 `display_persona_required`) / 익명("익명 수료생"). 페르소나로 투영하지 않습니다.
 * - **기관 표시·임계값(A-05 규칙)**: 익명 회고는 작성자가 고른 범위(기관 이름/기관 유형/표시 안 함)에 쓰는 순간의 (정본 기관, 수료생)·(기관 종류,
 *   수료생) 인증 회원 수로 decideAffiliationLabel을 적용해 행에 고정합니다(회원 수는 저장·응답하지 않음). 기관 이름이 아닌 범위면 그 기관 목록에
 *   나오지 않고(기관 이름이 익명을 깨뜨리지 않게) 전체 목록에서 고정된 문자열만 보입니다. 넓혀졌는지는 작성자 본인에게만(`labelBroadened`).
 *   이름을 건 회고는 기관 이름 범위로 고정합니다. 기수는 이름을 건 회고에서 고른 경우만(익명 회고는 422 `showCohort: anonymous_not_allowed`).
 * - **읽기**: 로그인한 active 계정 중 active 기관 인증이 하나라도 있는 사람(대학 포함) 또는 운영자 — 토픽과 같은 범위. 공개 아카이브·검색·
 *   검색엔진에는 내보내지 않습니다(기관 평판 분쟁 위험, ADR 0043). 응답에 작성자 id·소속 id·회원 수가 없습니다.
 * - **철회**: 작성자가 언제든(이미 철회면 200). **운영**: 신고 대상 `completion_retro`, 조치 `hide_retro`(moderation 모듈).
 * - 감사: 회고 id와 방식 플래그만. 익명 회고는 행위자 없이 남깁니다(작성자 id와 익명 글 id를 한 행에 남기지 않는 C-04 원칙).
 */
import { z } from 'zod'
import {
  AFFILIATION_LABEL_BROADENED_NOTE,
  AFFILIATION_LABEL_SCOPES,
  COMPLETION_RETRO_DISPLAY_MODES,
  COMPLETION_RETRO_GUIDELINE,
  COMPLETION_RETRO_PAGE_SIZE,
  COMPLETION_RETRO_QUESTIONS,
  DEFAULT_AFFILIATION_LABEL_SCOPE,
  INSTITUTION_KIND_LABELS,
  NON_UNIVERSITY_KINDS,
  type AffiliationLabelDecision,
  type AffiliationLabelScope,
  type CompletionRetroAnswers,
  type InstitutionKindValue,
  completionRetroAuthorLabel,
  decideAffiliationLabel,
  institutionAffiliationLabel,
  isNonUniversityKind,
  normalizeCompletionRetroAnswers,
  runPublicationChecks,
  type CheckItem,
} from '@peerchive/domain'
import {
  and,
  completionRetros,
  desc,
  eq,
  inArray,
  institutionAffiliations,
  institutionCohorts,
  isNotNull,
  lt,
  operators,
  personas,
  schools,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { affiliationLabelThreshold, verifiedCategoryCount, verifiedMemberCount } from './member-counts'
import { type Actor, ServiceError, conflict, invalid, notFound, rateLimited } from '../errors'
import { requireFeature } from '../features'
import { completionRetroNotice } from '../moderation/notices'
import { isUuid } from '../projects/access'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import type {
  CompletionRetroComposerDto,
  CompletionRetroDto,
  CompletionRetroListDto,
  MyCompletionRetroDto,
} from '../../../shared/types/api'

/** 수료 회고 쓰기 한도(사용자별, 시간당). */
export const COMPLETION_RETRO_CREATE_RATE_LIMIT: RateLimitRule = { limit: 5, windowMs: 60 * 60 * 1000 }

type RetroRow = typeof completionRetros.$inferSelect

// ── 자격 ─────────────────────────────────────────────────────────────────

/** 회고를 쓸 수 있는 내 소속: 대학이 아닌 정본 기관의 수료생(active + verified). 기수 글자는 쓰는 화면·기수 표시에만. */
interface RetroAffiliation {
  affiliationId: string
  institutionId: string
  institutionName: string
  institutionKind: InstitutionKindValue
  cohortId: string | null
  cohortLabel: string | null
}

async function myRetroAffiliations(db: DbExecutor, userId: string): Promise<RetroAffiliation[]> {
  const rows = await db
    .select({
      affiliationId: institutionAffiliations.id,
      institutionId: sql<string>`coalesce(${schools.mergedInto}, ${schools.id})`,
      institutionName: sql<string>`coalesce((select c.name from schools c where c.id = ${schools.mergedInto}), ${schools.name})`,
      institutionKind: sql<InstitutionKindValue>`coalesce((select c.kind from schools c where c.id = ${schools.mergedInto}), ${schools.kind})::text`,
      cohortId: institutionAffiliations.cohortId,
      cohortLabel: institutionCohorts.label,
    })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .innerJoin(users, eq(users.id, institutionAffiliations.userId))
    .leftJoin(institutionCohorts, eq(institutionCohorts.id, institutionAffiliations.cohortId))
    .where(
      and(
        eq(institutionAffiliations.userId, userId),
        eq(institutionAffiliations.status, 'active'),
        eq(institutionAffiliations.standing, 'alumni'),
        isNotNull(institutionAffiliations.verifiedAt),
        eq(users.status, 'active'),
      ),
    )
    .orderBy(desc(institutionAffiliations.verifiedAt), desc(institutionAffiliations.id))
  return rows.filter((r) => isNonUniversityKind(r.institutionKind))
}

/** 읽을 수 있는지: active 계정 + (active 기관 인증 하나 이상 또는 운영자). 토픽 독자와 같은 범위입니다. */
async function canReadRetros(db: DbExecutor, actor: Actor): Promise<boolean> {
  const [row] = (await db.execute(sql`
    select exists (select 1 from ${users} u where u.id = ${actor.userId} and u.status = 'active')
      and (exists (select 1 from ${institutionAffiliations} a where a.user_id = ${actor.userId} and a.status = 'active' and a.verified_at is not null)
        or exists (select 1 from ${operators} o where o.user_id = ${actor.userId} and o.revoked_at is null)) as ok`)) as unknown as Array<{ ok: boolean }>
  return !!row?.ok
}

/** 읽을 수 없으면 404(신고 대상 확인 등에서 씀). */
export async function assertCanReadRetros(db: DbExecutor, actor: Actor): Promise<void> {
  if (!(await canReadRetros(db, actor))) throw notFound()
}

/** 익명 회고의 기관 표시(A-05 규칙, 신분은 수료생). 회원 수는 이 판정에만 씁니다. */
async function decideRetroLabel(db: DbExecutor, aff: RetroAffiliation, requested: AffiliationLabelScope): Promise<AffiliationLabelDecision> {
  const [institution, category] = await Promise.all([
    verifiedMemberCount(db, aff.institutionId, 'alumni'),
    verifiedCategoryCount(db, aff.institutionKind, 'alumni'),
  ])
  return decideAffiliationLabel({
    requested,
    institution: { name: aff.institutionName, kind: aff.institutionKind },
    standing: 'alumni',
    verifiedMembers: institution,
    categoryMembers: category,
    threshold: affiliationLabelThreshold(),
  })
}

/** active 표시명 페르소나의 이름(community/name-modes activeDisplayPersona와 같은 조건 — 커뮤니티 모듈을 import하지 않으려고 둠). */
async function activeDisplayPersona(db: DbExecutor, userId: string): Promise<{ displayName: string } | null> {
  const [row] = await db
    .select({ displayName: personas.displayName })
    .from(personas)
    .where(and(eq(personas.userId, userId), eq(personas.kind, 'display'), eq(personas.status, 'active')))
    .limit(1)
  return row?.displayName ? { displayName: row.displayName } : null
}

async function accountName(db: DbExecutor, userId: string): Promise<string | null> {
  const [user] = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1)
  const name = user?.displayName.trim()
  return name ? [...name].slice(0, 80).join('') : null
}

// ── 쓰기 화면 ─────────────────────────────────────────────────────────────

/**
 * GET /me/completion-retros/composer — 플래그 꺼짐 404. 쓸 수 있는 내 소속(수료생)마다 기관 이름·기수·이미 쓴 회고가 있는지, 익명일 때 범위별
 * 미리보기(`{label, broadened}` — 회원 수 없음), 내 표시명 페르소나 이름·계정 이름. 쓸 소속이 없으면 `options: []`.
 */
export async function getCompletionRetroComposer(db: DbExecutor, actor: Actor): Promise<CompletionRetroComposerDto> {
  requireFeature('institutions')
  const mine = await myRetroAffiliations(db, actor.userId)
  const open = mine.length
    ? await db
        .select({ institutionId: completionRetros.institutionId })
        .from(completionRetros)
        .where(and(eq(completionRetros.authorId, actor.userId), inArray(completionRetros.status, ['published', 'hidden'])))
    : []
  const written = new Set(open.map((r) => r.institutionId))
  const options = await Promise.all(
    mine.map(async (aff) => {
      const previews = Object.fromEntries(
        await Promise.all(
          AFFILIATION_LABEL_SCOPES.map(async (scope) => {
            const d = await decideRetroLabel(db, aff, scope)
            return [scope, { label: d.label, broadened: d.broadened }] as const
          }),
        ),
      ) as CompletionRetroComposerDto['options'][number]['anonymousPreviews']
      return {
        affiliationId: aff.affiliationId,
        institution: { id: aff.institutionId, name: aff.institutionName, kind: aff.institutionKind },
        title: institutionAffiliationLabel(aff.institutionName, aff.institutionKind, 'alumni'),
        cohortLabel: aff.cohortLabel,
        alreadyWritten: written.has(aff.institutionId),
        anonymousPreviews: previews,
      }
    }),
  )
  const persona = await activeDisplayPersona(db, actor.userId)
  return {
    options,
    questions: [...COMPLETION_RETRO_QUESTIONS],
    displayModes: [...COMPLETION_RETRO_DISPLAY_MODES],
    scopes: [...AFFILIATION_LABEL_SCOPES],
    defaultScope: DEFAULT_AFFILIATION_LABEL_SCOPE,
    accountName: await accountName(db, actor.userId),
    displayPersonaName: persona?.displayName ?? null,
    guideline: COMPLETION_RETRO_GUIDELINE,
    broadenedNote: AFFILIATION_LABEL_BROADENED_NOTE,
  }
}

// ── 쓰기 ─────────────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const createCompletionRetroSchema = z
  .object({
    affiliationId: z.uuid({ error: requiredOr('invalid') }),
    displayMode: z.enum(COMPLETION_RETRO_DISPLAY_MODES, { error: requiredOr('invalid') }),
    /** 익명 회고의 기관 표시 범위(기본 기관 이름). 이름을 건 회고는 기관 이름으로 고정되어 다른 값이면 422. */
    labelScope: z.enum(AFFILIATION_LABEL_SCOPES, { error: 'invalid' }).optional(),
    /** 이름을 건 회고에 기수를 보일지(기본 false). */
    showCohort: z.boolean({ error: 'invalid' }).default(false),
    answers: z.unknown(),
    guidelinesConfirmed: z.literal(true, { error: 'confirm_required' }),
    confirmWarnings: z.boolean({ error: 'invalid' }).default(false),
  })

const CREATE_KEYS: ReadonlySet<string> = new Set(Object.keys(createCompletionRetroSchema.shape))

/** 평가 필드(별점·연봉·추천 점수 등)를 포함해 모르는 키는 받지 않습니다(422 `<key>: unknown`). */
function rejectUnknownKeys(raw: unknown): void {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return
  const unknown = Object.keys(raw).filter((k) => !CREATE_KEYS.has(k))
  if (unknown.length) throw invalid(Object.fromEntries(unknown.map((k) => [k, 'unknown'])))
}

function checkItems(answers: CompletionRetroAnswers): CheckItem[] {
  return COMPLETION_RETRO_QUESTIONS.filter((q) => answers[q]).map((q) => ({
    kind: 'text' as const,
    location: { kind: 'completion_retro' as const, field: `answers.${q}` },
    value: answers[q]!,
  }))
}

/**
 * POST /me/completion-retros — 201 + 내 회고. 404(플래그), 403 `display_persona_required`, 409 `retro_exists`·`checks_unconfirmed`(+warnings),
 * 422 `affiliationId: invalid`(내 수료생 소속이 아님)·`displayMode: name_required`(계정 이름 없음)·`labelScope: named_fixed`·
 * `showCohort: anonymous_not_allowed|no_cohort`·`answers`, 429.
 */
export async function createCompletionRetro(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<MyCompletionRetroDto> {
  requireFeature('institutions')
  rejectUnknownKeys(rawInput)
  const input = parseInput(createCompletionRetroSchema, rawInput)
  const answersCheck = normalizeCompletionRetroAnswers(input.answers)
  if (!answersCheck.ok) throw invalid(answersCheck.fields)
  const answers = answersCheck.answers
  const anonymous = input.displayMode === 'anonymous'
  if (!anonymous && input.labelScope !== undefined && input.labelScope !== 'institution') throw invalid({ labelScope: 'named_fixed' })
  if (anonymous && input.showCohort) throw invalid({ showCohort: 'anonymous_not_allowed' })
  const warnings = runPublicationChecks(checkItems(answers))
  if (warnings.length > 0 && !input.confirmWarnings) {
    throw new ServiceError('CONFLICT', 'checks_unconfirmed', undefined, {
      warnings: warnings.map((w) => ({ rule: w.rule, field: w.location.field, sample: w.sample })),
    })
  }
  const id = await db.transaction(async (tx) => {
    const aff = (await myRetroAffiliations(tx, actor.userId)).find((a) => a.affiliationId === input.affiliationId.toLowerCase())
    if (!aff) throw invalid({ affiliationId: 'invalid' })
    if (input.showCohort && !aff.cohortLabel) throw invalid({ showCohort: 'no_cohort' })
    if (!(await hitRateLimit(tx, 'completion_retro_create', actor.userId, COMPLETION_RETRO_CREATE_RATE_LIMIT, now))) throw rateLimited()
    // 같은 사람·기관의 동시 쓰기를 직렬화해 "하나만"을 지킵니다(부분 unique index가 최종 보장).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`completion-retro:${actor.userId}:${aff.institutionId}`}))`)
    const [existing] = await tx
      .select({ id: completionRetros.id })
      .from(completionRetros)
      .where(and(eq(completionRetros.authorId, actor.userId), eq(completionRetros.institutionId, aff.institutionId), inArray(completionRetros.status, ['published', 'hidden'])))
      .limit(1)
    if (existing) throw conflict('retro_exists', { retroId: existing.id })
    let displayNameSnapshot: string | null = null
    if (input.displayMode === 'name') {
      displayNameSnapshot = await accountName(tx, actor.userId)
      if (!displayNameSnapshot) throw invalid({ displayMode: 'name_required' })
    } else if (input.displayMode === 'display') {
      const persona = await activeDisplayPersona(tx, actor.userId)
      if (!persona) throw new ServiceError('FORBIDDEN', 'display_persona_required', undefined, { requirement: 'display_persona' })
      displayNameSnapshot = [...persona.displayName].slice(0, 80).join('')
    }
    const requested: AffiliationLabelScope = anonymous ? (input.labelScope ?? DEFAULT_AFFILIATION_LABEL_SCOPE) : 'institution'
    const decision: AffiliationLabelDecision = anonymous
      ? await decideRetroLabel(tx, aff, requested)
      : { applied: 'institution', label: institutionAffiliationLabel(aff.institutionName, aff.institutionKind, 'alumni'), broadened: false }
    const [row] = await tx
      .insert(completionRetros)
      .values({
        institutionId: aff.institutionId,
        cohortId: aff.cohortId,
        authorId: actor.userId,
        displayMode: input.displayMode,
        displayNameSnapshot,
        labelScopeRequested: requested,
        labelScopeApplied: decision.applied,
        institutionLabel: decision.label,
        cohortLabel: !anonymous && input.showCohort ? aff.cohortLabel : null,
        answers,
        guidelinesConfirmed: true,
        status: 'published',
        publishedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: completionRetros.id })
    await recordAudit(tx, {
      actorId: anonymous ? null : actor.userId,
      action: 'completion_retro.create',
      targetType: 'completion_retro',
      targetId: row!.id,
      metadata: { displayMode: input.displayMode, broadened: decision.broadened, warnings: warnings.length },
    })
    return row!.id
  })
  return myRetro(db, actor, id)
}

// ── 읽기 ─────────────────────────────────────────────────────────────────

const INSTITUTION_FILTER = z.object({
  institution: z.uuid({ error: 'invalid' }).optional(),
  kind: z.enum(NON_UNIVERSITY_KINDS, { error: 'invalid' }).optional(),
  before: z.iso.datetime({ offset: true, error: 'invalid' }).optional(),
})

/** 읽는 사람에게 주는 회고 하나. 작성자 id·소속 id·회원 수·고른 범위는 없습니다(넓혀졌는지는 작성자 본인에게만). */
export function toCompletionRetroDto(row: RetroRow, institution: { name: string; kind: InstitutionKindValue } | null, viewerId: string | null): CompletionRetroDto {
  const mine = viewerId !== null && row.authorId === viewerId
  return {
    id: row.id,
    author: completionRetroAuthorLabel(row.displayMode, row.displayNameSnapshot),
    anonymous: row.displayMode === 'anonymous',
    institutionLabel: row.institutionLabel,
    // 기관 이름 범위로 고정된 회고만 기관을 가리킵니다(넓혀진 익명 회고는 문자열뿐).
    institution: row.labelScopeApplied === 'institution' && institution ? { id: row.institutionId, name: institution.name, kind: institution.kind } : null,
    cohortLabel: row.cohortLabel,
    answers: row.answers as CompletionRetroAnswers,
    publishedAt: row.publishedAt.toISOString(),
    mine,
    canReport: !mine && row.status === 'published',
    ...(mine && { labelBroadened: row.labelScopeApplied !== row.labelScopeRequested }),
  }
}

async function institutionsOf(db: DbExecutor, ids: string[]): Promise<Map<string, { name: string; kind: InstitutionKindValue }>> {
  if (!ids.length) return new Map()
  const rows = await db
    .select({ id: schools.id, name: schools.name, kind: sql<InstitutionKindValue>`${schools.kind}::text` })
    .from(schools)
    .where(inArray(schools.id, [...new Set(ids)]))
  return new Map(rows.map((r) => [r.id, { name: r.name, kind: r.kind }]))
}

/**
 * GET /completion-retros?institution=&kind=&before= — 플래그 꺼짐 404. 읽을 수 없으면 `eligible: false` + 빈 목록. 게시 중인 회고, 최근 순, 한 쪽 20개.
 * institution: 그 기관(정본) 범위로 고정된 회고만. kind: 그 기관 종류(기관 이름·유형 범위). 둘 다 없으면 전체(표시 안 함 범위 포함).
 * `institutions`: 기관 이름 범위의 회고가 있는 기관(필터용, 개수 없음).
 */
export async function listCompletionRetros(db: DbExecutor, actor: Actor, rawQuery: unknown): Promise<CompletionRetroListDto> {
  requireFeature('institutions')
  if (!(await canReadRetros(db, actor))) return { eligible: false, items: [], institutions: [], nextBefore: null }
  const q = parseInput(INSTITUTION_FILTER, rawQuery ?? {})
  const conds = [eq(completionRetros.status, 'published')]
  if (q.institution) {
    conds.push(eq(completionRetros.institutionId, q.institution.toLowerCase()), eq(completionRetros.labelScopeApplied, 'institution'))
  }
  if (q.kind) {
    conds.push(inArray(completionRetros.labelScopeApplied, ['institution', 'institution_kind']))
    conds.push(sql`exists (select 1 from ${schools} s where s.id = ${completionRetros.institutionId} and s.kind::text = ${q.kind})`)
  }
  if (q.before) conds.push(lt(completionRetros.publishedAt, new Date(q.before)))
  const rows = await db
    .select()
    .from(completionRetros)
    .where(and(...conds))
    .orderBy(desc(completionRetros.publishedAt), desc(completionRetros.id))
    .limit(COMPLETION_RETRO_PAGE_SIZE + 1)
  const page = rows.slice(0, COMPLETION_RETRO_PAGE_SIZE)
  const instBy = await institutionsOf(db, page.map((r) => r.institutionId))
  const facets = await db
    .selectDistinct({ id: schools.id, name: schools.name, kind: sql<InstitutionKindValue>`${schools.kind}::text` })
    .from(completionRetros)
    .innerJoin(schools, eq(schools.id, completionRetros.institutionId))
    .where(and(eq(completionRetros.status, 'published'), eq(completionRetros.labelScopeApplied, 'institution')))
    .limit(200)
  return {
    eligible: true,
    items: page.map((r) => toCompletionRetroDto(r, instBy.get(r.institutionId) ?? null, actor.userId)),
    institutions: facets
      .map((f) => ({ id: f.id, name: f.name, kind: f.kind, kindLabel: INSTITUTION_KIND_LABELS[f.kind] }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    nextBefore: rows.length > COMPLETION_RETRO_PAGE_SIZE ? page[page.length - 1]!.publishedAt.toISOString() : null,
  }
}

async function myRetro(db: DbExecutor, actor: Actor, id: string): Promise<MyCompletionRetroDto> {
  const [row] = await db.select().from(completionRetros).where(and(eq(completionRetros.id, id), eq(completionRetros.authorId, actor.userId))).limit(1)
  if (!row) throw notFound()
  const instBy = await institutionsOf(db, [row.institutionId])
  return toMyDto(db, actor, row, instBy.get(row.institutionId) ?? null)
}

async function toMyDto(db: DbExecutor, actor: Actor, row: RetroRow, institution: { name: string; kind: InstitutionKindValue } | null): Promise<MyCompletionRetroDto> {
  return {
    ...toCompletionRetroDto(row, institution, actor.userId),
    // 내 목록에서는 넓혀졌어도 어느 기관의 회고인지 보여 줍니다(본인).
    institution: institution ? { id: row.institutionId, name: institution.name, kind: institution.kind } : null,
    displayMode: row.displayMode,
    status: row.status,
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    moderation: row.status === 'hidden' ? await completionRetroNotice(db, actor, row.id) : null,
  }
}

/** GET /me/completion-retros — 내 회고(모든 상태, 최근 순). 플래그 꺼짐 404. */
export async function listMyCompletionRetros(db: DbExecutor, actor: Actor): Promise<MyCompletionRetroDto[]> {
  requireFeature('institutions')
  const rows = await db
    .select()
    .from(completionRetros)
    .where(eq(completionRetros.authorId, actor.userId))
    .orderBy(desc(completionRetros.createdAt), desc(completionRetros.id))
    .limit(50)
  const instBy = await institutionsOf(db, rows.map((r) => r.institutionId))
  return Promise.all(rows.map((r) => toMyDto(db, actor, r, instBy.get(r.institutionId) ?? null)))
}

/** POST /me/completion-retros/:id/withdraw — 작성자만(아니면 404). 200(이미 철회도 200). 운영 조치로 숨겨진 것도 철회할 수 있습니다. */
export async function withdrawCompletionRetro(db: DbExecutor, actor: Actor, retroId: unknown, now = new Date()): Promise<MyCompletionRetroDto> {
  requireFeature('institutions')
  if (!isUuid(retroId)) throw notFound()
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(completionRetros).where(eq(completionRetros.id, retroId.toLowerCase())).limit(1).for('update')
    if (!row || row.authorId !== actor.userId) throw notFound()
    if (row.status === 'withdrawn') return row.id
    await tx.update(completionRetros).set({ status: 'withdrawn', withdrawnAt: now, updatedAt: now }).where(eq(completionRetros.id, row.id))
    await recordAudit(tx, {
      actorId: row.displayMode === 'anonymous' ? null : actor.userId,
      action: 'completion_retro.withdraw',
      targetType: 'completion_retro',
      targetId: row.id,
      metadata: { displayMode: row.displayMode, wasHidden: row.status === 'hidden' },
    })
    return row.id
  })
  return myRetro(db, actor, id)
}

// ── 신고(moderation 모듈이 씀) ────────────────────────────────────────────

/** 신고할 수 있는 회고: 플래그가 켜져 있고, 신고자가 읽을 수 있고, 게시 중. 아니면 404. */
export async function resolveReportableRetro(db: DbExecutor, actor: Actor, retroId: string): Promise<string> {
  requireFeature('institutions')
  await assertCanReadRetros(db, actor)
  const [row] = await db
    .select({ id: completionRetros.id })
    .from(completionRetros)
    .where(and(eq(completionRetros.id, retroId), eq(completionRetros.status, 'published')))
    .limit(1)
  if (!row) throw notFound()
  return row.id
}

/** 운영자 신고 상세·대상 표시용: 회고 행과 기관(작성자 id 없음). 없으면 null. */
export async function loadRetroForOperator(db: DbExecutor, retroId: string): Promise<{ dto: CompletionRetroDto; status: RetroRow['status'] } | null> {
  const [row] = await db.select().from(completionRetros).where(eq(completionRetros.id, retroId)).limit(1)
  if (!row) return null
  const instBy = await institutionsOf(db, [row.institutionId])
  return { dto: toCompletionRetroDto(row, instBy.get(row.institutionId) ?? null, null), status: row.status }
}

