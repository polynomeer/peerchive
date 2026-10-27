/**
 * 포트폴리오 판 (T-14, PROOFU_EVOLUTION_PLAN §10.1·§10.4, SYSTEM_DESIGN §6.5 PortfolioEdition·PortfolioItem·CompetencyEvidence, ADR 0014).
 *
 * - 판은 만들 때마다 새 version이며 **바꾸지 않습니다**. 새 판을 만들면 그 판이 지금 판(current)이 되고 이전 판은 남지만 공개하지 않습니다.
 * - 대표 케이스: 내 것, 게시 중, 고정 release를 지금 제공 가능, 최대 5개(아니면 422).
 * - 역량 × 근거: 행 = 역량(직무 프리셋 또는 직접 입력, 최대 12), 칸 = 대표 케이스. 근거는 그 케이스가 **인용한** 스냅샷 항목만 고를 수 있고
 *   (아니면 422 not_cited), 프리셋 행에 근거를 주지 않으면 프리셋 종류 규칙으로 채웁니다(@peerchive/domain suggestCompetencyEvidence).
 *   점수·수준 필드는 없고 칸은 읽을 때 종류별 개수로 셉니다.
 * - 자기 선언 스킬은 근거 있는 역량과 따로 저장·표시합니다.
 * - 사용자 글(한 줄 소개·역량 이름·스킬)에 공개 전 점검 규칙을 돌려 경고를 돌려줍니다(막지 않음).
 * - 판은 페르소나에 귀속합니다(S-01, ADR 0028). `personaId`를 주지 않으면 실명 페르소나(채용자용 기본)이고, version·지금 판은 페르소나마다입니다.
 *   **표시명 페르소나의 판에는 대표 케이스를 넣을 수 없습니다**(422 `featuredCaseStudyIds: display_persona`): 공개 사례(/p/:slug)와 케이스 글에
 *   계정 표시 이름·팀 정보가 있어 연결 플래그와 무관하게 두 페르소나가 이어지기 때문입니다. 한 줄 소개·역량 이름·자기 선언 스킬만 둡니다.
 */
import { z } from 'zod'
import {
  COMPETENCY_LABEL_MAX,
  COMPETENCY_LIMIT,
  COMPETENCY_PRESETS,
  EDITION_HEADLINE_MAX,
  FEATURED_CASE_LIMIT,
  SKILL_LABEL_MAX,
  SKILL_LIMIT,
  type CaseCitation,
  competencyLabelKey,
  editionCheckItems,
  runPublicationChecks,
  suggestCompetencyEvidence,
} from '@peerchive/domain'
import {
  and,
  asc,
  caseStudies,
  competencyEvidence,
  desc,
  eq,
  inArray,
  personas,
  portfolioEditions,
  portfolioItems,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { type Actor, conflict, invalid, rateLimited } from '../errors'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import { findMyPersona } from '../social/personas'
import { asCaseSnapshot, loadCaseStudiesWithRelease, loadSections } from './release-scope'
import { type EditionModel, buildPortfolioView, isPubliclyVisible } from './view'
import type { PortfolioEditionDto, PortfolioViewDto, PublicationCheckDto } from '../../../shared/types/api'

export const EDITION_CREATE_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 60 * 1000 }

const label = (max: number) =>
  z
    .string({ error: 'invalid' })
    .transform((v) => v.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, { error: 'required' }).max(max, { error: 'too_long' }))

const evidenceKind = z.enum(['log', 'claim', 'milestone', 'artifact'], { error: 'invalid' })

export const editionInputSchema = z.object({
  /** 판을 붙일 내 페르소나(S-01). 없으면 실명 페르소나. */
  personaId: z
    .uuid({ error: 'invalid' })
    .transform((v) => v.toLowerCase())
    .optional(),
  /** 빈 글은 null(프로필의 한 줄 소개를 씀). */
  headline: z
    .string({ error: 'invalid' })
    .nullish()
    .transform((v) => (v ?? '').replace(/\s+/g, ' ').trim() || null)
    .pipe(z.string().max(EDITION_HEADLINE_MAX, { error: 'too_long' }).nullable()),
  featuredCaseStudyIds: z
    .array(z.uuid({ error: 'invalid' }).transform((v) => v.toLowerCase()), { error: 'invalid' })
    .max(FEATURED_CASE_LIMIT, { error: 'too_many' })
    .default([]),
  competencies: z
    .array(
      z.strictObject({
        label: label(COMPETENCY_LABEL_MAX),
        preset: z
          .string({ error: 'invalid' })
          .refine((id) => Object.hasOwn(COMPETENCY_PRESETS, id), { error: 'invalid' })
          .nullish()
          .transform((v) => v ?? null),
        evidence: z
          .array(
            z.strictObject({
              caseStudyId: z.uuid({ error: 'invalid' }).transform((v) => v.toLowerCase()),
              citations: z.array(z.strictObject({ kind: evidenceKind, key: z.string({ error: 'invalid' }).min(1).max(64) }), { error: 'invalid' }).max(50, { error: 'too_many' }),
            }),
            { error: 'invalid' },
          )
          .max(FEATURED_CASE_LIMIT, { error: 'too_many' })
          .optional(),
      }),
      { error: 'invalid' },
    )
    .max(COMPETENCY_LIMIT, { error: 'too_many' })
    .default([]),
  skillsDeclared: z.array(label(SKILL_LABEL_MAX), { error: 'invalid' }).max(SKILL_LIMIT, { error: 'too_many' }).default([]),
})

type EditionInput = z.output<typeof editionInputSchema>
type EditionRow = typeof portfolioEditions.$inferSelect
type PersonaRow = typeof personas.$inferSelect

/** 판을 붙일 페르소나: personaId(내 것이 아니면 422 `personaId: not_found`) 또는 실명 페르소나(없으면 409 `real_persona_required`). */
async function editionPersona(db: DbExecutor, actor: Actor, input: EditionInput): Promise<PersonaRow> {
  if (input.personaId) {
    const persona = await findMyPersona(db, actor, { id: input.personaId })
    if (!persona) throw invalid({ personaId: 'not_found' })
    return persona
  }
  const real = await findMyPersona(db, actor, { kind: 'real' })
  if (!real) throw conflict('real_persona_required')
  return real
}

function duplicateIndex(values: readonly string[]): number {
  const seen = new Set<string>()
  for (const [i, v] of values.entries()) {
    const key = competencyLabelKey(v)
    if (seen.has(key)) return i
    seen.add(key)
  }
  return -1
}

/** 입력을 검증하고 판 모델(대표 케이스 순서·역량·근거 행)을 만듭니다. 422는 필드별 코드. */
async function resolveEdition(db: DbExecutor, actor: Actor, persona: PersonaRow, input: EditionInput, now: Date): Promise<EditionModel> {
  const featured = input.featuredCaseStudyIds
  if (persona.kind === 'display' && featured.length > 0) throw invalid({ featuredCaseStudyIds: 'display_persona' })
  if (new Set(featured).size !== featured.length) throw invalid({ featuredCaseStudyIds: 'duplicate' })
  const dupCompetency = duplicateIndex(input.competencies.map((c) => c.label))
  if (dupCompetency >= 0) throw invalid({ [`competencies.${dupCompetency}.label`]: 'duplicate' })
  const dupSkill = duplicateIndex(input.skillsDeclared)
  if (dupSkill >= 0) throw invalid({ [`skillsDeclared.${dupSkill}`]: 'duplicate' })

  const rows = featured.length
    ? (await loadCaseStudiesWithRelease(db, and(inArray(caseStudies.id, featured), eq(caseStudies.userId, actor.userId)), now))
    : []
  const byId = new Map(rows.map((r) => [r.caseStudy.id, r]))
  for (const [i, id] of featured.entries()) {
    const row = byId.get(id)
    if (!row) throw invalid({ [`featuredCaseStudyIds.${i}`]: 'not_found' })
    if (!isPubliclyVisible(row)) throw invalid({ [`featuredCaseStudyIds.${i}`]: 'not_published' })
  }
  // 케이스마다 인용한 항목(요약 제외) — 근거는 이 안에서만 고릅니다.
  const sections = await loadSections(db, rows.map((r) => r.caseStudy))
  const cited = new Map<string, Array<Pick<CaseCitation, 'kind' | 'key'>>>()
  for (const id of featured) {
    const list = (sections.get(id) ?? []).flatMap((s) => s.sentences.flatMap((x) => x.citations)).filter((c) => c.kind !== 'summary')
    const seen = new Set<string>()
    cited.set(
      id,
      list.filter((c) => {
        const k = `${c.kind}:${c.key}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      }),
    )
  }

  const evidence: EditionModel['evidence'][number][] = []
  input.competencies.forEach((competency, ci) => {
    const add = (caseStudyId: string, kind: CaseCitation['kind'], key: string) => {
      if (!evidence.some((e) => e.competencyIndex === ci && e.caseStudyId === caseStudyId && e.kind === kind && e.key === key)) {
        evidence.push({ competencyIndex: ci, caseStudyId, kind, key })
      }
    }
    if (competency.evidence === undefined) {
      if (!competency.preset) return
      for (const id of featured) {
        for (const c of suggestCompetencyEvidence(asCaseSnapshot(byId.get(id)!.snapshot), cited.get(id) ?? [], competency.preset)) add(id, c.kind, c.key)
      }
      return
    }
    competency.evidence.forEach((e, ei) => {
      const base = `competencies.${ci}.evidence.${ei}`
      if (!featured.includes(e.caseStudyId)) throw invalid({ [`${base}.caseStudyId`]: 'not_featured' })
      const allowed = cited.get(e.caseStudyId) ?? []
      e.citations.forEach((c, k) => {
        if (!allowed.some((a) => a.kind === c.kind && a.key === c.key)) throw invalid({ [`${base}.citations.${k}`]: 'not_cited' })
        add(e.caseStudyId, c.kind, c.key)
      })
    })
  })
  return {
    userId: actor.userId,
    headline: input.headline,
    featured,
    competencies: input.competencies.map((c) => ({ label: c.label, preset: c.preset })),
    evidence,
    skillsDeclared: input.skillsDeclared,
  }
}

function warningsFor(model: Pick<EditionModel, 'headline' | 'competencies' | 'skillsDeclared'>): PublicationCheckDto[] {
  return runPublicationChecks(editionCheckItems(model)).map((c) => ({ rule: c.rule, location: c.location, sample: c.sample, fixUrl: null }))
}

async function toDto(db: DbExecutor, edition: EditionRow, persona: Pick<PersonaRow, 'id' | 'kind' | 'handle'>): Promise<PortfolioEditionDto> {
  const items = await db
    .select({ caseStudyId: portfolioItems.caseStudyId, position: portfolioItems.position, title: caseStudies.title })
    .from(portfolioItems)
    .innerJoin(caseStudies, eq(caseStudies.id, portfolioItems.caseStudyId))
    .where(eq(portfolioItems.editionId, edition.id))
    .orderBy(asc(portfolioItems.position))
  const evidence = await db.select().from(competencyEvidence).where(eq(competencyEvidence.editionId, edition.id))
  const competencies = edition.competencies as Array<{ label: string; preset: string | null }>
  const model = { headline: edition.headline, competencies, skillsDeclared: edition.skillsDeclared }
  return {
    id: edition.id,
    persona: { id: persona.id, kind: persona.kind, handle: persona.handle },
    version: edition.version,
    current: edition.status === 'current',
    headline: edition.headline,
    createdAt: edition.createdAt.toISOString(),
    featured: items,
    competencies: competencies.map((c, i) => {
      const mine = evidence.filter((e) => e.competencyIndex === i)
      const caseIds = [...new Set(mine.map((e) => e.caseStudyId))]
      return {
        label: c.label,
        preset: c.preset,
        evidence: caseIds.map((caseStudyId) => ({
          caseStudyId,
          citations: mine
            .filter((e) => e.caseStudyId === caseStudyId)
            .map((e) => ({ kind: e.evidenceKind as 'log' | 'claim' | 'milestone' | 'artifact', key: e.evidenceKey })),
        })),
      }
    }),
    skillsDeclared: [...edition.skillsDeclared],
    warnings: warningsFor(model),
  }
}

/**
 * POST /portfolio-editions — 201 + 새 판(version n, 지금 판). 이전 판은 superseded로 남습니다(공개하지 않음, 바꾸지 않음).
 * 422(대표 케이스 not_found/not_published/duplicate, 근거 not_featured/not_cited, 이름 duplicate 등), 429.
 */
export async function createEdition(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<PortfolioEditionDto> {
  const input = parseInput(editionInputSchema, rawInput)
  return db.transaction(async (tx) => {
    if (!(await hitRateLimit(tx, 'portfolio_edition_create', actor.userId, EDITION_CREATE_RATE_LIMIT, now))) throw rateLimited()
    const persona = await editionPersona(tx, actor, input)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`portfolio-edition:${persona.id}`}))`)
    const model = await resolveEdition(tx, actor, persona, input, now)
    const [{ max } = { max: 0 }] = await tx
      .select({ max: sql<number>`coalesce(max(${portfolioEditions.version}), 0)::int` })
      .from(portfolioEditions)
      .where(eq(portfolioEditions.personaId, persona.id))
    await tx
      .update(portfolioEditions)
      .set({ status: 'superseded' })
      .where(and(eq(portfolioEditions.personaId, persona.id), eq(portfolioEditions.status, 'current')))
    const [edition] = await tx
      .insert(portfolioEditions)
      .values({
        userId: actor.userId,
        personaId: persona.id,
        version: max + 1,
        headline: model.headline,
        competencies: model.competencies.map((c) => ({ label: c.label, preset: c.preset })),
        skillsDeclared: [...model.skillsDeclared],
        status: 'current',
        createdAt: now,
      })
      .returning()
    if (model.featured.length) {
      await tx.insert(portfolioItems).values(model.featured.map((caseStudyId, position) => ({ editionId: edition!.id, caseStudyId, position })))
    }
    if (model.evidence.length) {
      const versionOf = new Map(
        (await tx.select({ id: caseStudies.id, v: caseStudies.releaseVersion }).from(caseStudies).where(inArray(caseStudies.id, [...model.featured]))).map((r) => [
          r.id,
          r.v,
        ]),
      )
      await tx.insert(competencyEvidence).values(
        model.evidence.map((e) => ({
          editionId: edition!.id,
          competencyIndex: e.competencyIndex,
          caseStudyId: e.caseStudyId,
          releaseVersion: versionOf.get(e.caseStudyId)!,
          evidenceKind: e.kind,
          evidenceKey: e.key,
        })),
      )
    }
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'portfolio_edition.create',
      targetType: 'portfolio_edition',
      targetId: edition!.id,
      metadata: { version: edition!.version, personaKind: persona.kind, featured: model.featured.length, competencies: model.competencies.length },
    })
    await emitAnalytics(tx, {
      name: 'portfolio_shared',
      actorId: actor.userId,
      props: { featured: model.featured.length, competencies: model.competencies.length, skills: Math.min(edition!.skillsDeclared.length, 20) },
    })
    return toDto(tx, edition!, persona)
  })
}

/** POST /portfolio-editions/preview — 저장하지 않고 공개 보기 그대로를 만들어 봅니다(같은 검증). */
export async function previewEdition(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<PortfolioViewDto & { warnings: PublicationCheckDto[] }> {
  const input = parseInput(editionInputSchema, rawInput)
  const model = await resolveEdition(db, actor, await editionPersona(db, actor, input), input, now)
  return { ...(await buildPortfolioView(db, model, now)), warnings: warningsFor(model) }
}

/** GET /me/portfolio-editions — 내 판 전체(페르소나별 판이 섞여 있음, 실명 먼저·최근 version 순). */
export async function listMyEditions(db: DbExecutor, actor: Actor): Promise<PortfolioEditionDto[]> {
  const rows = await db
    .select({ edition: portfolioEditions, persona: { id: personas.id, kind: personas.kind, handle: personas.handle } })
    .from(portfolioEditions)
    .innerJoin(personas, eq(personas.id, portfolioEditions.personaId))
    .where(eq(portfolioEditions.userId, actor.userId))
    .orderBy(asc(personas.kind), desc(portfolioEditions.version))
    .limit(50)
  return Promise.all(rows.map((r) => toDto(db, r.edition, r.persona)))
}

/** 공개 프로필용: 이 페르소나의 지금 판 모델(없으면 null). */
export async function loadCurrentEditionModel(db: DbExecutor, personaId: string): Promise<{ edition: EditionRow; model: EditionModel } | null> {
  const [edition] = await db
    .select()
    .from(portfolioEditions)
    .where(and(eq(portfolioEditions.personaId, personaId), eq(portfolioEditions.status, 'current')))
    .limit(1)
  if (!edition) return null
  const items = await db.select().from(portfolioItems).where(eq(portfolioItems.editionId, edition.id)).orderBy(asc(portfolioItems.position))
  const evidence = await db.select().from(competencyEvidence).where(eq(competencyEvidence.editionId, edition.id))
  return {
    edition,
    model: {
      userId: edition.userId,
      headline: edition.headline,
      featured: items.map((i) => i.caseStudyId),
      competencies: (edition.competencies as Array<{ label: string; preset: string | null }>).map((c) => ({ label: c.label, preset: c.preset ?? null })),
      // 근거는 그 케이스의 고정 release 버전을 가리킵니다(케이스가 다른 release로 바뀌는 일은 없음).
      evidence: evidence.map((e) => ({ competencyIndex: e.competencyIndex, caseStudyId: e.caseStudyId, kind: e.evidenceKind as CaseCitation['kind'], key: e.evidenceKey })),
      skillsDeclared: edition.skillsDeclared,
    },
  }
}
