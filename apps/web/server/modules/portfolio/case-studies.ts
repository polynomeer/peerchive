/**
 * 케이스 스터디 템플릿 초안·편집·게시 (T-14, PROOFU_EVOLUTION_PLAN §10.2·§10.3, SYSTEM_DESIGN §6.5 CaseStudy·CaseSentence·§11,
 * DELIVERY_PLAN T-14 "모든 문장에 출처, 철회된 사례 자동 차단", ADR 0014).
 *
 * - 자격: **지금 게시 중인** release(공개 조회와 같은 판정)에 팀원 키로 들어 있는 사람만 만들 수 있습니다(release의 비공개 refs.members).
 *   그 release에서 익명("팀원 A")이었다면 자기 이름(프로필)과 연결하는 것이므로 `revealSelf: true` 확인이 필요합니다(아니면 422).
 *   다른 팀원의 표시는 스냅샷 그대로이며 바꾸지 않습니다.
 * - 초안: 저장된 스냅샷만으로 @peerchive/domain `generateCaseStudyDraft`가 만듭니다(비공개 작업 테이블을 읽지 않음). "내가 쓴 로그·올린 파일"은
 *   release refs에서 계산해 고르는 데만 씁니다.
 * - 편집: 문장 전체를 바꿉니다(`expectedVersion`, 409 version_conflict). 인용은 고정한 release 스냅샷에 있는 키만(아니면 422).
 *   게시된 케이스를 고치면 draft로 돌아갑니다(다시 점검·게시).
 * - 게시: 출처 없는 문장이 있으면 409 `uncited_sentences`(+위치), 한계·회고 구역의 reflection(본인 회고)만 예외. 공개 전 점검 경고는
 *   `confirmWarnings: true` 없이는 409 `checks_unconfirmed`. 고정한 release를 더 이상 제공하지 않으면 409 `unavailable`.
 * - 읽기 상태: 고정 release가 철회·대체·차단되면 읽는 즉시 unavailable로 봅니다(worker 표시를 기다리지 않음).
 * - 운영 조치로 숨긴 케이스(hidden_at, T-15)는 공개 경로에 나오지 않고 게시가 409 `hidden`입니다(고치기는 됨, 이의제기로 되돌리면 다시 게시 가능).
 */
import { z } from 'zod'
import {
  CASE_JOB_TARGETS,
  CASE_SECTION_LABELS,
  CASE_TITLE_MAX,
  type CaseSectionDraft,
  type CaseSnapshot,
  caseStudyCheckItems,
  citationLabel,
  citationPath,
  clipText,
  findUncitedSentences,
  generateCaseStudyDraft,
  normalizeCaseSections,
  runPublicationChecks,
} from '@peerchive/domain'
import { and, caseStudies, desc, eq, ne, projects, publicationCandidates, publications, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { servableReleaseSql } from '../course-hub/public-scope'
import { type Actor, ServiceError, conflict, invalid, notFound, rateLimited } from '../errors'
import { caseStudyNotice } from '../moderation/notices'
import { isUuid } from '../projects/access'
import { loadServedRelease } from '../publication/public-read'
import type { SnapshotRefs } from '../publication/snapshot'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { parseInput } from '../validation'
import {
  type CaseStudyRow,
  type CaseStudyWithRelease,
  asCaseSnapshot,
  effectiveStatus,
  loadCaseStudiesWithRelease,
  loadSections,
  replaceSentences,
} from './release-scope'
import type {
  CaseSectionDto,
  CaseStudyDto,
  CaseStudySourceDto,
  CaseStudySummaryDto,
  PublicSnapshot,
  PublicationCheckDto,
} from '../../../shared/types/api'

export const CASE_STUDY_CREATE_RATE_LIMIT: RateLimitRule = { limit: 20, windowMs: 60 * 60 * 1000 }
/** 사용자마다 이용 불가가 아닌 케이스 스터디 수 한도. */
export const CASE_STUDY_LIMIT = 50

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const createCaseStudySchema = z.object({
  releaseSlug: z.string({ error: requiredOr('invalid') }).trim().min(1, { error: 'required' }).max(60, { error: 'invalid' }),
  jobTarget: z.enum(CASE_JOB_TARGETS, { error: requiredOr('invalid') }),
  /** 익명이던 release를 내 이름과 연결한다는 확인. */
  revealSelf: z.boolean({ error: 'invalid' }).default(false),
})

const titleSchema = z
  .string({ error: 'invalid' })
  .transform((v) => v.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, { error: 'required' }).max(CASE_TITLE_MAX, { error: 'too_long' }))

export const updateCaseStudySchema = z.object({
  expectedVersion: z.number({ error: requiredOr('invalid') }).int({ error: 'invalid' }).min(1, { error: 'invalid' }),
  title: titleSchema.optional(),
  sections: z.unknown().optional(),
})

export const publishCaseStudySchema = z.object({
  expectedVersion: z.number({ error: requiredOr('invalid') }).int({ error: 'invalid' }).min(1, { error: 'invalid' }),
  confirmWarnings: z.boolean({ error: 'invalid' }).default(false),
})

// ── 자격 ─────────────────────────────────────────────────────────────────

interface Eligibility {
  memberKey: string
  selfAnonymous: boolean
  selfLabel: string
  ownLogKeys: Set<string>
  ownArtifactIds: Set<string>
}

/** release의 비공개 참조(refs)에서 이 사용자의 팀원 키·쓴 로그·올린 파일을 찾습니다. 없으면 null(팀원 아님). */
export function eligibilityFor(refs: SnapshotRefs, snapshot: PublicSnapshot, userId: string): Eligibility | null {
  const memberKey = Object.entries(refs.members ?? {}).find(([, id]) => id === userId)?.[0]
  if (!memberKey) return null
  const member = snapshot.members.find((m) => m.key === memberKey)
  if (!member) return null
  return {
    memberKey,
    selfAnonymous: member.anonymous,
    selfLabel: member.label,
    ownLogKeys: new Set(Object.entries(refs.logs ?? {}).filter(([, l]) => l.authorId === userId).map(([key]) => key)),
    ownArtifactIds: new Set(Object.entries(refs.artifacts ?? {}).filter(([, a]) => a.uploaderId === userId).map(([id]) => id)),
  }
}

// ── DTO ──────────────────────────────────────────────────────────────────

function warningsFor(title: string, sections: readonly CaseSectionDraft[]): PublicationCheckDto[] {
  return runPublicationChecks(caseStudyCheckItems({ title, sections })).map((c) => ({ rule: c.rule, location: c.location, sample: c.sample, fixUrl: null }))
}

function sectionDtos(sections: readonly CaseSectionDraft[], snapshot: CaseSnapshot | null, slug: string): CaseSectionDto[] {
  return sections.map((s) => ({
    key: s.key,
    label: CASE_SECTION_LABELS[s.key],
    sentences: s.sentences.map((sentence) => ({
      text: sentence.text,
      kind: sentence.kind,
      citations: sentence.citations.map((c) => ({
        ...c,
        label: snapshot ? citationLabel(snapshot, c) : null,
        path: snapshot ? citationPath(slug, c) : null,
      })),
    })),
  }))
}

/** 볼 수 없게 된 케이스를 같은 공개의 지금 버전으로 다시 만들 수 있으면 그 slug. */
async function recreateSlugFor(db: DbExecutor, row: CaseStudyWithRelease, userId: string, now: Date): Promise<string | null> {
  const served = await loadServedRelease(db, row.slug, now)
  if (!served || served.release.id === row.caseStudy.releaseId) return null
  return eligibilityFor(served.release.refs as unknown as SnapshotRefs, served.snapshot, userId) ? row.slug : null
}

function memberLabel(row: CaseStudyWithRelease): string {
  return row.snapshot.members.find((m) => m.key === row.caseStudy.memberKey)?.label ?? '팀원'
}

async function toDto(db: DbExecutor, row: CaseStudyWithRelease, userId: string, now: Date): Promise<CaseStudyDto> {
  const { status, reason } = effectiveStatus(row)
  const available = status !== 'unavailable'
  const sections = (await loadSections(db, [row.caseStudy])).get(row.caseStudy.id) ?? []
  const cs = row.caseStudy
  return {
    id: cs.id,
    title: cs.title,
    jobTarget: cs.jobTarget,
    status,
    unavailableReason: reason,
    version: cs.version,
    generator: 'template',
    source: {
      slug: row.slug,
      path: `/p/${row.slug}`,
      releaseVersion: cs.releaseVersion,
      publicTitle: available ? row.snapshot.title : '',
      termLabel: row.termLabel,
      selfLabel: available ? memberLabel(row) : '',
      selfAnonymous: cs.selfAnonymous,
      revealSelf: cs.revealSelf,
    },
    sections: sectionDtos(sections, available ? asCaseSnapshot(row.snapshot) : null, row.slug),
    uncited: findUncitedSentences(sections),
    warnings: warningsFor(cs.title, sections),
    snapshot: available ? row.snapshot : null,
    recreateSlug: available ? null : await recreateSlugFor(db, row, userId, now),
    publishedAt: cs.publishedAt?.toISOString() ?? null,
    createdAt: cs.createdAt.toISOString(),
    updatedAt: cs.updatedAt.toISOString(),
    hidden: cs.hiddenAt !== null,
    moderation: cs.hiddenAt ? await caseStudyNotice(db, { userId }, cs.id) : null,
  }
}

async function loadOwn(db: DbExecutor, actor: Actor, caseStudyId: unknown, now: Date, lock = false): Promise<CaseStudyWithRelease> {
  if (!isUuid(caseStudyId)) throw notFound()
  const id = caseStudyId.toLowerCase()
  if (lock) await db.select({ id: caseStudies.id }).from(caseStudies).where(eq(caseStudies.id, id)).for('update')
  const [row] = await loadCaseStudiesWithRelease(db, eq(caseStudies.id, id), now)
  // 다른 사람의 케이스는 존재를 드러내지 않습니다(초안 포함).
  if (!row || row.caseStudy.userId !== actor.userId) throw notFound()
  return row
}

// ── 만들기 ───────────────────────────────────────────────────────────────

/**
 * POST /case-studies {releaseSlug, jobTarget, revealSelf?} — 201 + 템플릿 초안.
 * 404(지금 게시 중인 공개가 아님), 422 `releaseSlug: not_member`(그 release의 팀원이 아님)·`revealSelf: confirm_required`(익명이던 사람),
 * 409 limit_reached, 429.
 */
export async function createCaseStudy(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<CaseStudyDto> {
  const input = parseInput(createCaseStudySchema, rawInput)
  return db.transaction(async (tx) => {
    const served = await loadServedRelease(tx, input.releaseSlug.toLowerCase(), now)
    if (!served) throw notFound()
    const { publication, release, snapshot } = served
    const eligibility = eligibilityFor(release.refs as unknown as SnapshotRefs, snapshot, actor.userId)
    if (!eligibility) throw invalid({ releaseSlug: 'not_member' })
    if (eligibility.selfAnonymous && !input.revealSelf) throw invalid({ revealSelf: 'confirm_required' })
    if (!(await hitRateLimit(tx, 'case_study_create', actor.userId, CASE_STUDY_CREATE_RATE_LIMIT, now))) throw rateLimited()
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`case-study:${actor.userId}`}))`)
    const [{ count } = { count: 0 }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(caseStudies)
      .where(and(eq(caseStudies.userId, actor.userId), ne(caseStudies.status, 'unavailable')))
    if (count >= CASE_STUDY_LIMIT) throw conflict('limit_reached', { limit: CASE_STUDY_LIMIT })

    const releaseVersion = release.releaseNo!
    const sections = generateCaseStudyDraft(
      asCaseSnapshot(snapshot),
      releaseVersion,
      { memberKey: eligibility.memberKey, ownLogKeys: eligibility.ownLogKeys, ownArtifactIds: eligibility.ownArtifactIds },
      input.jobTarget,
    )
    const [row] = await tx
      .insert(caseStudies)
      .values({
        userId: actor.userId,
        publicationId: publication.id,
        releaseId: release.id,
        releaseVersion,
        memberKey: eligibility.memberKey,
        selfAnonymous: eligibility.selfAnonymous,
        revealSelf: eligibility.selfAnonymous ? true : input.revealSelf,
        jobTarget: input.jobTarget,
        title: clipText(snapshot.title, CASE_TITLE_MAX) || '케이스 스터디',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    await replaceSentences(tx, row!.id, sections)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'case_study.create',
      targetType: 'case_study',
      targetId: row!.id,
      metadata: { publicationId: publication.id, releaseVersion, jobTarget: input.jobTarget, revealSelf: eligibility.selfAnonymous },
    })
    return toDto(tx, await loadOwn(tx, actor, row!.id, now), actor.userId, now)
  })
}

// ── 읽기 ─────────────────────────────────────────────────────────────────

/** GET /case-studies/:id — 작성자만(아니면 404). */
export async function getCaseStudy(db: DbExecutor, actor: Actor, caseStudyId: unknown, now = new Date()): Promise<CaseStudyDto> {
  return toDto(db, await loadOwn(db, actor, caseStudyId, now), actor.userId, now)
}

/** GET /me/case-studies — 내 케이스 스터디(최근 수정 순, 읽는 지금 기준 상태). */
export async function listMyCaseStudies(db: DbExecutor, actor: Actor, now = new Date()): Promise<CaseStudySummaryDto[]> {
  const rows = (await loadCaseStudiesWithRelease(db, eq(caseStudies.userId, actor.userId), now)).sort(
    (a, b) => b.caseStudy.updatedAt.getTime() - a.caseStudy.updatedAt.getTime() || (a.caseStudy.id < b.caseStudy.id ? 1 : -1),
  )
  const sections = await loadSections(db, rows.map((r) => r.caseStudy))
  const out: CaseStudySummaryDto[] = []
  for (const row of rows.slice(0, 100)) {
    const { status, reason } = effectiveStatus(row)
    const cs = row.caseStudy
    out.push({
      id: cs.id,
      title: cs.title,
      jobTarget: cs.jobTarget,
      status,
      unavailableReason: reason,
      version: cs.version,
      source: { slug: row.slug, releaseVersion: cs.releaseVersion, publicTitle: status === 'unavailable' ? '' : row.snapshot.title },
      uncitedCount: findUncitedSentences(sections.get(cs.id) ?? []).length,
      recreateSlug: status === 'unavailable' ? await recreateSlugFor(db, row, actor.userId, now) : null,
      publishedAt: cs.publishedAt?.toISOString() ?? null,
      updatedAt: cs.updatedAt.toISOString(),
    })
  }
  return out
}

/** GET /me/case-study-sources — 내가 팀원 키로 들어 있는 지금 게시 중인 release(케이스 스터디를 만들 수 있는 것). */
export async function listCaseStudySources(db: DbExecutor, actor: Actor, now = new Date()): Promise<CaseStudySourceDto[]> {
  const rows = await db
    .select({ publication: publications, release: publicationCandidates })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .where(
      and(
        servableReleaseSql(now),
        sql`exists (select 1 from jsonb_each_text(${publicationCandidates.refs} -> 'members') m where m.value = ${actor.userId})`,
      ),
    )
    .orderBy(desc(publicationCandidates.publishedAt), desc(publicationCandidates.id))
    .limit(100)
  const mine = await db
    .select({ id: caseStudies.id, releaseId: caseStudies.releaseId, jobTarget: caseStudies.jobTarget, status: caseStudies.status })
    .from(caseStudies)
    .where(eq(caseStudies.userId, actor.userId))
  const out: CaseStudySourceDto[] = []
  for (const { publication, release } of rows) {
    const snapshot = release.snapshot as unknown as PublicSnapshot
    const eligibility = eligibilityFor(release.refs as unknown as SnapshotRefs, snapshot, actor.userId)
    if (!eligibility) continue
    out.push({
      slug: publication.slug,
      path: `/p/${publication.slug}`,
      title: snapshot.title,
      releaseVersion: release.releaseNo!,
      publishedAt: release.publishedAt!.toISOString(),
      termLabel: release.termLabel,
      selfLabel: eligibility.selfLabel,
      selfAnonymous: eligibility.selfAnonymous,
      caseStudies: mine.filter((c) => c.releaseId === release.id).map((c) => ({ id: c.id, jobTarget: c.jobTarget, status: c.status })),
    })
  }
  return out
}

// ── 편집·게시 ────────────────────────────────────────────────────────────

function assertEditable(row: CaseStudyWithRelease): void {
  if (effectiveStatus(row).status === 'unavailable') throw conflict('unavailable')
}

/**
 * PATCH /case-studies/:id {expectedVersion, title?, sections?} — 작성자만(404). 200 + 케이스.
 * 409 version_conflict(+currentVersion)·unavailable, 422(인용이 고정 release 스냅샷에 없음 등, 바뀐 것 없음 no_changes).
 * 게시된 케이스를 고치면 draft로 돌아갑니다.
 */
export async function updateCaseStudy(db: DbExecutor, actor: Actor, caseStudyId: unknown, rawInput: unknown, now = new Date()): Promise<CaseStudyDto> {
  const input = parseInput(updateCaseStudySchema, rawInput)
  if (input.title === undefined && input.sections === undefined) throw invalid({ _: 'no_changes' })
  return db.transaction(async (tx) => {
    const row = await loadOwn(tx, actor, caseStudyId, now, true)
    const cs = row.caseStudy
    assertEditable(row)
    if (cs.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: cs.version })
    let sections: CaseSectionDraft[] | undefined
    if (input.sections !== undefined) {
      const result = normalizeCaseSections(input.sections, asCaseSnapshot(row.snapshot), cs.releaseVersion, cs.jobTarget)
      if (!result.ok) throw invalid(result.fields)
      sections = result.sections
    }
    const wasPublished = cs.status === 'published'
    await tx
      .update(caseStudies)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(wasPublished && { status: 'draft' as const, publishedAt: null }),
        version: cs.version + 1,
        updatedAt: now,
      })
      .where(eq(caseStudies.id, cs.id))
    if (sections) await replaceSentences(tx, cs.id, sections)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'case_study.update',
      targetType: 'case_study',
      targetId: cs.id,
      metadata: { version: cs.version + 1, unpublished: wasPublished },
    })
    return toDto(tx, await loadOwn(tx, actor, cs.id, now), actor.userId, now)
  })
}

/**
 * POST /case-studies/:id/publish {expectedVersion, confirmWarnings?} — 작성자만. 200 + 케이스(이미 게시면 그대로 200).
 * 409 unavailable(고정 release를 더 이상 제공하지 않음)·version_conflict·empty·uncited_sentences(+sentences[{section, index}])·
 * checks_unconfirmed(+warnings).
 */
export async function publishCaseStudy(db: DbExecutor, actor: Actor, caseStudyId: unknown, rawInput: unknown, now = new Date()): Promise<CaseStudyDto> {
  const input = parseInput(publishCaseStudySchema, rawInput)
  return db.transaction(async (tx) => {
    const row = await loadOwn(tx, actor, caseStudyId, now, true)
    const cs = row.caseStudy
    assertEditable(row)
    if (cs.version !== input.expectedVersion) throw conflict('version_conflict', { currentVersion: cs.version })
    if (cs.hiddenAt) throw conflict('hidden')
    if (cs.status === 'published') return toDto(tx, row, actor.userId, now)
    // 자격 재확인: 익명이던 사람은 연결 확인이 저장되어 있어야 합니다(DB check로도 보장).
    if (cs.selfAnonymous && !cs.revealSelf) throw invalid({ revealSelf: 'confirm_required' })
    const sections = (await loadSections(tx, [cs])).get(cs.id) ?? []
    if (sections.every((s) => s.sentences.length === 0)) throw conflict('empty')
    const uncited = findUncitedSentences(sections)
    if (uncited.length > 0) throw conflict('uncited_sentences', { sentences: uncited.map((u) => ({ section: u.section, index: u.index })) })
    const warnings = warningsFor(cs.title, sections)
    if (warnings.length > 0 && !input.confirmWarnings) {
      throw new ServiceError('CONFLICT', 'checks_unconfirmed', undefined, {
        warnings: warnings.map((w) => ({ rule: w.rule, field: w.location.field, sample: w.sample })),
      })
    }
    await tx.update(caseStudies).set({ status: 'published', publishedAt: now, updatedAt: now }).where(eq(caseStudies.id, cs.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'case_study.publish',
      targetType: 'case_study',
      targetId: cs.id,
      metadata: { publicationId: cs.publicationId, releaseVersion: cs.releaseVersion, warnings: warnings.length },
    })
    return toDto(tx, await loadOwn(tx, actor, cs.id, now), actor.userId, now)
  })
}

/** POST /case-studies/:id/unpublish — 작성자만. 200 + 케이스(draft). 게시 중이 아니면 409 not_published. */
export async function unpublishCaseStudy(db: DbExecutor, actor: Actor, caseStudyId: unknown, now = new Date()): Promise<CaseStudyDto> {
  return db.transaction(async (tx) => {
    const row = await loadOwn(tx, actor, caseStudyId, now, true)
    const cs = row.caseStudy
    if (cs.status !== 'published') throw conflict('not_published')
    await tx.update(caseStudies).set({ status: 'draft', publishedAt: null, updatedAt: now }).where(eq(caseStudies.id, cs.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'case_study.unpublish',
      targetType: 'case_study',
      targetId: cs.id,
      metadata: { publicationId: cs.publicationId },
    })
    return toDto(tx, await loadOwn(tx, actor, cs.id, now), actor.userId, now)
  })
}

export type { CaseStudyRow }
