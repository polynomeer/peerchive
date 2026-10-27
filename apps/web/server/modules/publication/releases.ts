/**
 * 게시·철회·동의 철회 (T-12, PROOFU_EVOLUTION_PLAN §9.3–§9.5, SYSTEM_DESIGN §1·§7.2·§8·§9·§11, DELIVERY_PLAN T-12·시나리오 D·E, ADR 0012).
 *
 * - 게시 `POST /candidates/:id/publish {manifestHash, idempotencyKey?}`: active owner만(editor 이하 403, 비멤버 404).
 *   한 트랜잭션에서 프로젝트 → 공개 → 후보 순서로 행을 잠근 뒤 모든 조건을 다시 검사합니다: 멤버십·역할, 후보가 열려 있음
 *   (대체됨 409 `superseded`), 요청 해시 = 후보 해시(409 `stale_manifest`), 엠바고(`assertPublishable`, 409 `embargo_active`),
 *   모든 당사자 동의(현재 해시, 탈퇴·정지 계정 제외)·스냅샷의 모든 파일이 지금 clean·열린 보류 없음(도메인 publish/republish 전이).
 *   하나라도 깨지면 409 `publish_blocked` + `blockers[]`(지금 다시 계산한 값). 성공하면 후보가 release(published, release_no+1)가 되고
 *   공개의 current_release_id가 바뀌며, 이전 release는 replaced(더 이상 제공하지 않음), access_epoch +1, outbox `publication.published`.
 *   같은 후보·해시로 다시 부르면(재시도) 아무것도 바꾸지 않고 같은 결과를 200으로 돌려줍니다(`idempotent: true`).
 * - 철회 `POST /publications/:id/withdraw {reason?}`: owner만. 공개 → withdrawn, 지금 release → withdrawn, 열린 후보 → superseded,
 *   access_epoch +1, outbox `publication.withdrawn`을 한 트랜잭션에. 공개 조회는 요청마다 DB 상태를 읽으므로 커밋 즉시 404입니다
 *   (worker·캐시에 기대지 않음). 이미 철회됐으면 그대로 200.
 * - 동의 철회 `POST /publications/:id/consents/revoke {note?}`: 지금 release의 당사자 본인. 동의 → revoked, 공개가 게시 중이면
 *   같은 트랜잭션에서 철회(원인 consent_revoked). owner는 철회한 사람을 뺀 새 후보를 만들 수 있습니다(exclude-declined).
 */
import { z } from 'zod'
import { canManagePublication, transition, type PublicationEvent } from '@peerchive/domain'
import {
  PUBLICATION_PUBLISHED_TOPIC,
  PUBLICATION_WITHDRAWN_TOPIC,
  and,
  consents,
  desc,
  eq,
  inArray,
  outboxEvents,
  projects,
  publicationCandidates,
  publications,
  sql,
  type DbExecutor,
  type PublicationOutboxPayload,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { courseLinkForRelease } from '../course-hub/course-link'
import { assertPublishable, getProjectEmbargo } from '../embargo/embargo'
import { type Actor, conflict, forbidden, notFound } from '../errors'
import { findMembership, isUuid, loadReadableProject } from '../projects/access'
import { type MemberRefs, loadMemberRefs } from '../projects/member-refs'
import { parseInput } from '../validation'
import {
  type CandidateRow,
  OPEN_STATUSES,
  type PublicationRow,
  isOpen,
  lockPublication,
  readinessContext,
  refreshReadiness,
  supersededError,
  toBlockerDtos,
} from './candidates'
import { loadPublicationSummary, publicPathFor, toPublicationSummary, toReleaseSummary } from './summary'
import type {
  ConsentRevokeResultDto,
  ConsentStatus,
  MyPublishedConsentDto,
  PublicSnapshot,
  PublicationSummaryDto,
  PublishResultDto,
} from '../../../shared/types/api'

export const WITHDRAW_NOTE_MAX = 300

const note = z
  .string({ error: 'invalid' })
  .trim()
  .max(WITHDRAW_NOTE_MAX, { error: 'too_long' })
  .nullish()
  .transform((value) => (value ? value : null))

export const publishSchema = z.object({
  manifestHash: z
    .string({ error: (issue) => (issue.input === undefined ? 'required' : 'invalid') })
    .regex(/^[0-9a-f]{64}$/, { error: 'invalid' }),
  /**
   * 선택. 재시도 구분용으로 받기만 합니다. 게시는 (후보, manifest 해시)가 자연 키라서, 같은 후보·해시의 재요청은
   * 키와 무관하게 같은 결과(200, idempotent)를 돌려줍니다.
   */
  idempotencyKey: z.string({ error: 'invalid' }).trim().min(1, { error: 'invalid' }).max(100, { error: 'too_long' }).optional(),
})

export const withdrawSchema = z.object({ reason: note })
export const revokeSchema = z.object({ note })

// ── 게시 ─────────────────────────────────────────────────────────────────

/**
 * POST /candidates/:id/publish — owner만. 200 + {publication, release, idempotent}.
 * 404(볼 수 없음), 403(owner 아님), 409 superseded / stale_manifest / embargo_active / publish_blocked(+blockers) / publication_locked.
 */
export async function publishCandidate(
  db: DbExecutor,
  actor: Actor,
  candidateId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<PublishResultDto> {
  if (!isUuid(candidateId)) throw notFound()
  const input = parseInput(publishSchema, rawInput)
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidateId)).limit(1)
    if (!found) throw notFound()
    // 잠금 순서: 프로젝트(멤버 변경 직렬화) → 공개 → 후보. 멤버십·역할을 잠근 상태에서 다시 확인합니다.
    const { project, membership } = await loadReadableProject(tx, actor, found.projectId, { lock: true })
    if (!canManagePublication({ userId: actor.userId }, project, membership)) throw forbidden()
    const publication = await lockPublication(tx, found.publicationId)
    const [candidate] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, found.id)).limit(1).for('update')
    if (!candidate) throw notFound()

    // 재시도: 이 후보가 이미 지금 release로 게시되어 있으면 아무것도 바꾸지 않습니다.
    if (candidate.status === 'published' && publication.status === 'published' && publication.currentReleaseId === candidate.id) {
      if (input.manifestHash !== candidate.manifestHash) throw conflict('stale_manifest', { currentManifestHash: candidate.manifestHash })
      return { publication: toPublicationSummary(publication, candidate), release: toReleaseSummary(candidate), idempotent: true }
    }
    if (publication.status === 'restricted') throw conflict('publication_locked')
    if (!isOpen(candidate.status)) throw await supersededError(tx, candidate)
    if (input.manifestHash !== candidate.manifestHash) throw conflict('stale_manifest', { currentManifestHash: candidate.manifestHash })
    await assertPublishable(tx, actor, project.id, now)

    // ready 여부를 지금 상태로 다시 계산하고(동의·파일·계정), 게시 전이의 전제 조건을 다시 검사합니다.
    const refreshed = await refreshReadiness(tx, publication, candidate.id, now)
    const embargo = await getProjectEmbargo(tx, project.id, now)
    const { ctx, inactiveSubjectIds } = await readinessContext(tx, refreshed, now)
    // 409 publish_blocked의 당사자도 멤버 참조로(익명 스터디 기록은 가명 키, ADR 0026 부록).
    const refs = await loadMemberRefs(tx, project, actor.userId)
    const event: PublicationEvent = publication.status === 'published' ? 'republish' : 'publish'
    const result = transition(publication.status, event, { ...ctx, embargoUntil: embargo.until })
    if (!result.ok) {
      if (result.error.code === 'INVALID_TRANSITION') {
        // 공개는 ready가 아닌데 후보는 열려 있음(동의·파일 조건 미충족으로 awaiting_consent에 머묾).
        const pending = transition('ready', 'publish', { ...ctx, embargoUntil: embargo.until })
        throw blockedError(pending.ok || pending.error.code !== 'PRECONDITION_FAILED' ? [] : pending.error.blockers, refreshed, ctx, inactiveSubjectIds, refs)
      }
      throw blockedError(result.error.blockers, refreshed, ctx, inactiveSubjectIds, refs)
    }
    if (refreshed.status !== 'ready') throw blockedError([], refreshed, ctx, inactiveSubjectIds, refs)

    const [{ nextRelease }] = (await tx
      .select({ nextRelease: sql<number>`coalesce(max(${publicationCandidates.releaseNo}), 0)::int + 1` })
      .from(publicationCandidates)
      .where(eq(publicationCandidates.publicationId, publication.id))) as [{ nextRelease: number }]

    // 이전 release는 더 이상 제공하지 않습니다(부분 unique: 공개마다 published는 하나).
    const replaced = await tx
      .update(publicationCandidates)
      .set({ status: 'replaced', replacedAt: now })
      .where(and(eq(publicationCandidates.publicationId, publication.id), eq(publicationCandidates.status, 'published')))
      .returning({ id: publicationCandidates.id })
    // 과목 허브 연결(T-13): 스냅샷의 과목과 프로젝트의 지금 학기가 같을 때만 정본 과목을 기록합니다.
    const link = await courseLinkForRelease(tx, project.courseTermId, refreshed.snapshot as unknown as PublicSnapshot)
    const [release] = await tx
      .update(publicationCandidates)
      .set({ status: 'published', releaseNo: nextRelease, publishedAt: now, courseId: link.courseId, termLabel: link.termLabel })
      .where(eq(publicationCandidates.id, refreshed.id))
      .returning()
    const accessEpoch = publication.accessEpoch + 1
    const [updated] = await tx
      .update(publications)
      .set({
        status: result.state,
        currentReleaseId: release!.id,
        level: release!.level,
        accessEpoch,
        firstPublishedAt: publication.firstPublishedAt ?? now,
        withdrawnAt: null,
        withdrawCause: null,
        withdrawNote: null,
        updatedAt: now,
      })
      .where(eq(publications.id, publication.id))
      .returning()

    await tx.insert(outboxEvents).values({
      topic: PUBLICATION_PUBLISHED_TOPIC,
      payload: {
        publicationId: publication.id,
        projectId: project.id,
        releaseId: release!.id,
        releaseNo: nextRelease,
        accessEpoch,
        replacedReleaseId: replaced[0]?.id ?? null,
      } satisfies PublicationOutboxPayload,
      createdAt: now,
    })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'publication.publish',
      targetType: 'publication',
      targetId: publication.id,
      projectId: project.id,
      metadata: { releaseNo: nextRelease, candidateVersion: release!.version, level: release!.level, accessEpoch, replaced: replaced.length > 0 },
    })
    await emitAnalytics(tx, {
      name: 'publication_published',
      actorId: actor.userId,
      projectId: project.id,
      props: { level: release!.level, releaseNo: nextRelease, republish: event === 'republish', ...(project.kind === 'study' && { origin: 'study' as const }) },
    })
    return { publication: toPublicationSummary(updated!, release!), release: toReleaseSummary(release!), idempotent: false }
  })
}

function blockedError(
  blockers: Parameters<typeof toBlockerDtos>[0],
  candidate: CandidateRow,
  ctx: Awaited<ReturnType<typeof readinessContext>>['ctx'],
  inactiveSubjectIds: ReadonlySet<string>,
  refs: MemberRefs,
) {
  const statusBy = new Map<string, ConsentStatus>((ctx.consents ?? []).map((c) => [c.subjectId, c.status]))
  const dtos = toBlockerDtos(blockers, statusBy, inactiveSubjectIds, refs)
  return conflict('publish_blocked', {
    candidateStatus: candidate.status,
    blockers: dtos.map((b) => ({ ...b }) as Record<string, string>),
  })
}

// ── 철회 ─────────────────────────────────────────────────────────────────

interface WithdrawOptions {
  cause: 'owner' | 'consent_revoked'
  note: string | null
  actorId: string
  now: Date
}

/**
 * 게시 중인 공개를 철회합니다(공개 행을 잠근 트랜잭션 안에서). 공개 조회가 요청마다 이 상태를 읽으므로 커밋하는 순간 막힙니다.
 * 파생 데이터(검색·포트폴리오·집계, T-13/T-14) 정리는 outbox → worker가 하고, 늦어져도 읽기는 이미 막혀 있습니다.
 */
async function withdrawInTx(tx: DbExecutor, publication: PublicationRow, options: WithdrawOptions): Promise<PublicationRow> {
  const result = transition(publication.status, 'withdraw', { now: options.now })
  if (!result.ok) throw conflict('not_published')
  const accessEpoch = publication.accessEpoch + 1
  const [updated] = await tx
    .update(publications)
    .set({
      status: result.state,
      accessEpoch,
      withdrawnAt: options.now,
      withdrawCause: options.cause,
      withdrawNote: options.note,
      updatedAt: options.now,
    })
    .where(eq(publications.id, publication.id))
    .returning()
  let releaseNo = 0
  if (publication.currentReleaseId) {
    const [release] = await tx
      .update(publicationCandidates)
      .set({ status: 'withdrawn', withdrawnAt: options.now })
      .where(and(eq(publicationCandidates.id, publication.currentReleaseId), eq(publicationCandidates.status, 'published')))
      .returning()
    releaseNo = release?.releaseNo ?? 0
  }
  // 열려 있던 다음 버전 후보도 대체합니다(철회한 사람의 자료가 들어 있을 수 있음). owner가 새 후보를 만듭니다.
  await tx
    .update(publicationCandidates)
    .set({ status: 'superseded', supersededAt: options.now, readyAt: null })
    .where(and(eq(publicationCandidates.publicationId, publication.id), inArray(publicationCandidates.status, [...OPEN_STATUSES])))

  await tx.insert(outboxEvents).values({
    topic: PUBLICATION_WITHDRAWN_TOPIC,
    payload: {
      publicationId: publication.id,
      projectId: publication.projectId,
      releaseId: publication.currentReleaseId!,
      releaseNo,
      accessEpoch,
      cause: options.cause,
    } satisfies PublicationOutboxPayload,
    createdAt: options.now,
  })
  await recordAudit(tx, {
    actorId: options.actorId,
    action: 'publication.withdraw',
    targetType: 'publication',
    targetId: publication.id,
    projectId: publication.projectId,
    metadata: { cause: options.cause, releaseNo, accessEpoch },
  })
  await emitAnalytics(tx, { name: 'publication_withdrawn', actorId: options.actorId, projectId: publication.projectId, props: { cause: options.cause } })
  return updated!
}

// ── 운영 제한 (T-15) ─────────────────────────────────────────────────────

/**
 * 운영 조치로 게시 중인 공개를 제한합니다(published → restricted, 공개 행을 잠근 트랜잭션 안에서, ADR 0015). 철회와 같은 방식으로 지금 release를
 * withdrawn으로, 열린 후보를 superseded로 바꾸고 access_epoch를 올리며 outbox `publication.withdrawn`(cause restricted)을 남깁니다.
 * 공개 조회는 공개 상태가 published가 아니므로 커밋 즉시 404이고, worker는 파생 데이터만 정리합니다. 감사는 호출자(운영 조치)가 남깁니다.
 * 해제(lift_restriction)는 restricted → draft이고 release를 되살리지 않습니다: owner가 후보·동의·게시를 다시 합니다.
 */
export async function restrictInTx(tx: DbExecutor, publication: PublicationRow, now: Date): Promise<PublicationRow> {
  const result = transition(publication.status, 'restrict', { now })
  if (!result.ok) throw conflict('not_published')
  const accessEpoch = publication.accessEpoch + 1
  const [updated] = await tx
    .update(publications)
    .set({ status: result.state, accessEpoch, updatedAt: now })
    .where(eq(publications.id, publication.id))
    .returning()
  let releaseNo = 0
  if (publication.currentReleaseId) {
    const [release] = await tx
      .update(publicationCandidates)
      .set({ status: 'withdrawn', withdrawnAt: now })
      .where(and(eq(publicationCandidates.id, publication.currentReleaseId), eq(publicationCandidates.status, 'published')))
      .returning()
    releaseNo = release?.releaseNo ?? 0
  }
  await tx
    .update(publicationCandidates)
    .set({ status: 'superseded', supersededAt: now, readyAt: null })
    .where(and(eq(publicationCandidates.publicationId, publication.id), inArray(publicationCandidates.status, [...OPEN_STATUSES])))
  await tx.insert(outboxEvents).values({
    topic: PUBLICATION_WITHDRAWN_TOPIC,
    payload: {
      publicationId: publication.id,
      projectId: publication.projectId,
      releaseId: publication.currentReleaseId!,
      releaseNo,
      accessEpoch,
      cause: 'restricted',
    } satisfies PublicationOutboxPayload,
    createdAt: now,
  })
  return updated!
}

/** 제한 해제: restricted → draft(도메인 lift_restriction). 제한 상태가 아니면 409 not_restricted. */
export async function liftRestrictionInTx(tx: DbExecutor, publication: PublicationRow, now: Date): Promise<PublicationRow> {
  const result = transition(publication.status, 'lift_restriction', { now })
  if (!result.ok) throw conflict('not_restricted')
  const [updated] = await tx.update(publications).set({ status: result.state, updatedAt: now }).where(eq(publications.id, publication.id)).returning()
  return updated!
}

/**
 * POST /publications/:id/withdraw {reason?} — owner만. 200 + 공개 요약. 이미 철회됐으면 그대로 200.
 * 404(볼 수 없음), 403(owner 아님), 409 not_published(게시된 적 없음·제한됨 등).
 */
export async function withdrawPublication(
  db: DbExecutor,
  actor: Actor,
  publicationId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<PublicationSummaryDto> {
  if (!isUuid(publicationId)) throw notFound()
  const input = parseInput(withdrawSchema, rawInput)
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(publications).where(eq(publications.id, publicationId)).limit(1)
    if (!found) throw notFound()
    const { project, membership } = await loadReadableProject(tx, actor, found.projectId, { lock: true })
    if (!canManagePublication({ userId: actor.userId }, project, membership)) throw forbidden()
    const publication = await lockPublication(tx, found.id)
    if (publication.status === 'withdrawn') return loadPublicationSummary(tx, publication)
    if (publication.status !== 'published') throw conflict('not_published')
    const updated = await withdrawInTx(tx, publication, { cause: 'owner', note: input.reason, actorId: actor.userId, now })
    return loadPublicationSummary(tx, updated)
  })
}

// ── 동의 철회 ─────────────────────────────────────────────────────────────

/**
 * POST /publications/:id/consents/revoke {note?} — 지금 release의 당사자 본인(나간 멤버 포함). 200.
 * 게시 중이면 같은 트랜잭션에서 공개를 철회합니다(원인 consent_revoked). 이미 철회한 동의면 그대로 200.
 * 당사자가 아니면 active 멤버에게는 403 not_subject, 그 밖에는 404. 게시한 적 없는 공개는 404.
 */
export async function revokeConsent(
  db: DbExecutor,
  actor: Actor,
  publicationId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<ConsentRevokeResultDto> {
  if (!isUuid(publicationId)) throw notFound()
  const input = parseInput(revokeSchema, rawInput)
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(publications).where(eq(publications.id, publicationId)).limit(1)
    if (!found || !found.currentReleaseId) throw notFound()
    // 잠금 순서: 프로젝트 → 공개 → 동의. 당사자는 멤버가 아닐 수 있으므로 권한 확인 없이 행만 잠급니다.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, found.projectId)).limit(1).for('update')
    const publication = await lockPublication(tx, found.id)
    const releaseId = publication.currentReleaseId!
    const [consent] = await tx
      .select()
      .from(consents)
      .where(and(eq(consents.candidateId, releaseId), eq(consents.subjectUserId, actor.userId)))
      .limit(1)
      .for('update')
    if (!consent) {
      const membership = await findMembership(tx, publication.projectId, actor.userId)
      if (membership?.status === 'active') throw forbidden('not_subject')
      throw notFound()
    }
    if (consent.status !== 'revoked') {
      await tx.update(consents).set({ status: 'revoked', decidedAt: now, note: input.note ?? consent.note }).where(eq(consents.id, consent.id))
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'consent.revoke',
        targetType: 'consent',
        targetId: consent.id,
        projectId: publication.projectId,
        metadata: { publicationStatus: publication.status },
      })
    }
    let status = publication.status
    if (publication.status === 'published') {
      status = (await withdrawInTx(tx, publication, { cause: 'consent_revoked', note: null, actorId: actor.userId, now })).status
    }
    return { publicationId: publication.id, publicationStatus: status, consentStatus: 'revoked' }
  })
}

/** GET /me/publication-consents — 내가 동의해 지금 게시 중인 공개(동의 철회 대상). */
export async function listMyPublishedConsents(db: DbExecutor, actor: Actor): Promise<MyPublishedConsentDto[]> {
  const rows = await db
    .select({ consent: consents, release: publicationCandidates, publication: publications, projectTitle: projects.title })
    .from(consents)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, consents.candidateId))
    .innerJoin(publications, eq(publications.currentReleaseId, publicationCandidates.id))
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .where(
      and(
        eq(consents.subjectUserId, actor.userId),
        eq(consents.status, 'granted'),
        eq(publications.status, 'published'),
        eq(publicationCandidates.status, 'published'),
      ),
    )
    .orderBy(desc(publicationCandidates.publishedAt))
  return rows.map(({ consent, release, publication, projectTitle }) => ({
    publicationId: publication.id,
    slug: publication.slug,
    publicTitle: (release.snapshot as unknown as PublicSnapshot).title,
    projectTitle,
    version: release.releaseNo ?? 0,
    publishedAt: release.publishedAt!.toISOString(),
    publicPath: publicPathFor(publication.slug),
    scope: consent.scope,
  }))
}
