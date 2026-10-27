/**
 * 공개 후보·동의 (T-11, PROOFU_EVOLUTION_PLAN §9, SYSTEM_DESIGN §1·§6.5·§7.2·§8·§9, DELIVERY_PLAN T-11·시나리오 D, ADR 0011).
 *
 * 흐름: 선택 → 스냅샷(buildPublicSnapshot)·manifest·해시 → 공개 전 점검(경고) → 동의 요청 → 모두 동의·파일 clean·보류 없음이면 ready.
 * 게시·철회·공개 조회는 T-12(releases.ts, public-read.ts)입니다. 이 모듈은 게시 상태 전이(publish)를 하지 않습니다.
 * T-12 규칙: 게시 중인 공개에도 새 후보를 만들 수 있고(다음 공개 버전, 게시 전까지 이전 release를 계속 제공),
 * 한 번 게시한 공개의 slug는 바꿀 수 없으며(422 `slug: locked`), 탈퇴·정지한 당사자의 동의는 유효하지 않습니다.
 *
 * - 후보 만들기: active owner/editor(reviewer/viewer 403, 비멤버 404). 엠바고 중이면 409 `embargo_active` + until
 *   (embargo 모듈의 assertPublishable). 선택한 로그·선언은 지금 revision으로 고정합니다. 파일은 전체 공개에서만(요약 공개면 422
 *   `{artifactVersionIds: 'not_allowed'}`) 같은 프로젝트의 clean 버전만(아니면 422 `not_clean`). 새 후보를 만들면 열린 이전 후보는
 *   superseded가 되고 그 동의는 의미가 없어집니다.
 * - 동의 당사자: 이름·로그·선언·회의 참석·올린 파일이 포함된 모든 사람(나간 멤버 포함) + 후보를 만든 사람(제목·요약 작성자).
 *   만든 사람의 동의는 요청에서 `consentSelf: true`일 때만 granted로 기록합니다.
 * - 동의 결정: 당사자 본인만(아니면 403 `not_subject`, 볼 수 없으면 404), manifestHash가 후보 해시와 다르면 409 `stale_manifest`,
 *   이미 대체된 후보면 409 `superseded`. 결정은 바꿀 수 있습니다(게시 전).
 * - 미동의자 제외(owner만): 거절한 사람의 로그·선언·올린 파일·이름(회의 참석 표시 포함)을 뺀 새 후보. 고정한 revision은 그대로 쓰고,
 *   자기 관련 부분(subjectProjection)이 그대로인 당사자의 동의만 이어받습니다(다르면 다시 요청).
 * - ready 판정: 도메인 transition(mark_ready) — 모든 당사자 granted(현재 해시) + 모든 파일 clean + 열린 보류 없음.
 *   보류(holds, T-15)는 개인정보·저작권 신고가 그 공개에 걸고 신고가 처리되면 풀립니다. 동의 결정·후보 조회·게시 때마다 다시 계산하고,
 *   조건이 깨지면 reopen_candidate로 awaiting_consent로 돌립니다.
 * - 잠금 순서: 프로젝트 → 공개 → 후보(동의 결정도 공개 → 후보 순서).
 */
import { z } from 'zod'
import {
  type Membership,
  type PublicationBlocker,
  type PublicationContext,
  type PublicationEvent,
  type PublicationState,
  canManagePublication,
  STUDY_MEMBER_SCOPE,
  studyExposureAllowed,
  canPreparePublication,
  claimStatusSummary,
  isMetadataReady,
  pdfAuthorSample,
  runPublicationChecks,
  transition,
} from '@peerchive/domain'
import {
  and,
  artifactVersions,
  artifacts,
  asc,
  claimEvidence,
  claimRevisions,
  consents,
  courseTerms,
  courses,
  desc,
  endorsements,
  eq,
  holds,
  inArray,
  isNull,
  logEntries,
  logRevisionEvidence,
  logRevisions,
  milestoneSnapshots,
  milestones,
  ne,
  profiles,
  projectMembers,
  projects,
  publicationCandidates,
  publications,
  roleClaims,
  schools,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { emitAnalytics } from '../analytics/analytics'
import { assertPublishable, getProjectEmbargo, toEmbargoDto } from '../embargo/embargo'
import { type Actor, ServiceError, conflict, forbidden, invalid, notFound, sqlState } from '../errors'
import { HANDLE_PATTERN, RESERVED_HANDLES } from '../identity/profiles'
import { summarize } from '../logs/logs'
import { type ProjectRow, findMembership, isUuid, loadReadableProject } from '../projects/access'
import { type MemberRefs, loadMemberRefs, memberRefSchema } from '../projects/member-refs'
import { parseInput } from '../validation'
import { publicationNotices } from '../moderation/notices'
import { buildManifest, canonicalHash, checkItemsFor, publicKeyFor } from './manifest'
import { listReleases, loadPublicationSummary } from './summary'
import {
  type SnapshotRefs,
  type SnapshotSource,
  analyzeSelection,
  anonymousNamesOf,
  buildPublicSnapshot,
  subjectProjection,
} from './snapshot'
import type {
  CandidatePreviewDto,
  CandidateSelectionDto,
  ConsentRequestDto,
  ConsentStatus,
  ConsentSubjectDto,
  ExposureMode,
  PublicSnapshot,
  PublicationBlockerDto,
  PublicationCandidateDto,
  PublicationCheckDto,
  PublicationOptionsDto,
  PublicationStateDto,
  UsageTerms,
} from '../../../shared/types/api'

// ── 입력 ─────────────────────────────────────────────────────────────────

export const TITLE_MAX = 80
export const SUMMARY_MAX = 1000
export const CONSENT_NOTE_MAX = 300

/** 재사용 라이선스로 고를 수 있는 SPDX id(짧은 허용 목록). */
export const LICENSE_ALLOWLIST = [
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'CC0-1.0',
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'GPL-3.0-only',
] as const

/** 사용자 handle 예약어 + 공개 경로와 겹치는 말. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...RESERVED_HANDLES,
  'candidates',
  'case',
  'cases',
  'consents',
  'p',
  'portfolio',
  'preview',
  'publications',
  'publish',
  'public',
])

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const uuidList = (max: number) =>
  z
    .array(z.uuid({ error: 'invalid' }).transform((id) => id.toLowerCase()), { error: 'invalid' })
    .max(max, { error: 'too_many' })
    .default([])
    .transform((ids) => [...new Set(ids)])

export const slugSchema = z
  .string({ error: requiredOr('invalid') })
  .trim()
  .toLowerCase()
  .min(3, { error: 'too_short' })
  .max(60, { error: 'too_long' })
  .regex(HANDLE_PATTERN, { error: 'invalid_format' })
  .refine((value) => !RESERVED_SLUGS.has(value), { error: 'reserved' })

const usageSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({ kind: z.literal('view_only') }),
    z.strictObject({ kind: z.literal('license'), spdx: z.enum(LICENSE_ALLOWLIST, { error: 'invalid' }) }),
    z.strictObject({
      kind: z.literal('external'),
      source: z.string({ error: 'invalid' }).trim().min(1, { error: 'required' }).max(200, { error: 'too_long' }),
    }),
  ],
  { error: 'invalid' },
)

export const createCandidateSchema = z
  .object({
    level: z.enum(['summary', 'full'], { error: requiredOr('invalid') }),
    title: z.string({ error: requiredOr('invalid') }).trim().min(1, { error: 'required' }).max(TITLE_MAX, { error: 'too_long' }),
    summary: z
      .string({ error: requiredOr('invalid') })
      .trim()
      .min(1, { error: 'required' })
      .max(SUMMARY_MAX, { error: 'too_long' }),
    slug: slugSchema,
    logIds: uuidList(200),
    milestoneIds: uuidList(12),
    artifactVersionIds: uuidList(50),
    claimIds: uuidList(100),
    /** 키는 멤버 참조(사용자 id 또는 익명 스터디 기록의 가명 키, ADR 0026 부록 — 서비스가 실제 id로 바꿈). */
    exposure: z.record(memberRefSchema, z.enum(['name', 'anonymous'], { error: 'invalid' }), { error: 'invalid' }).default({}),
    usageTerms: z.record(z.uuid({ error: 'invalid' }), usageSchema, { error: 'invalid' }).default({}),
    /** 후보를 만드는 사람이 자기 관련 공개에 동의하는지. 체크하지 않으면 pending으로 남습니다. */
    consentSelf: z.boolean({ error: 'invalid' }).default(false),
  })
  .refine((input) => input.level === 'full' || input.artifactVersionIds.length === 0, {
    error: 'not_allowed',
    path: ['artifactVersionIds'],
  })

export const consentDecisionSchema = z.object({
  decision: z.enum(['granted', 'declined'], { error: requiredOr('invalid') }),
  manifestHash: z.string({ error: requiredOr('invalid') }).regex(/^[0-9a-f]{64}$/, { error: 'invalid' }),
  note: z
    .string({ error: 'invalid' })
    .trim()
    .max(CONSENT_NOTE_MAX, { error: 'too_long' })
    .nullish()
    .transform((value) => (value ? value : null)),
})

export const excludeDeclinedSchema = z.object({ consentSelf: z.boolean({ error: 'invalid' }).default(false) })

// ── 행·선택 ──────────────────────────────────────────────────────────────

export type CandidateRow = typeof publicationCandidates.$inferSelect
export type PublicationRow = typeof publications.$inferSelect

/** 저장하는 선택(정규화, 포함된 id만). */
type Selection = CandidateSelectionDto

export const OPEN_STATUSES = ['awaiting_consent', 'ready'] as const
export const isOpen = (status: CandidateRow['status']) => status === 'awaiting_consent' || status === 'ready'

interface Pins {
  logs: ReadonlyMap<string, string>
  claims: ReadonlyMap<string, string>
}

interface CreateOptions {
  now: Date
  consentSelf: boolean
  privateOrigins: readonly string[]
  /** 미동의자 제외: 고정 revision, 이전 후보(동의 이어받기). */
  pins?: Pins
  derivedFrom?: CandidateRow
}

// ── 비공개 행 읽기 ────────────────────────────────────────────────────────

type SourceRows = Omit<SnapshotSource, 'publicKey' | 'privateOrigins'>

async function loadSource(tx: DbExecutor, project: ProjectRow, selection: Selection, pins?: Pins): Promise<SourceRows> {
  const full = selection.level === 'full'

  // 로그(지금 revision 또는 고정 revision) + 파일 근거.
  const entries = selection.logIds.length
    ? await tx
        .select()
        .from(logEntries)
        .where(and(eq(logEntries.projectId, project.id), inArray(logEntries.id, selection.logIds)))
    : []
  if (entries.length !== selection.logIds.length || entries.some((e) => !e.currentRevisionId)) throw invalid({ logIds: 'not_found' })
  const logRevisionIds = entries.map((e) => pins?.logs.get(e.id) ?? e.currentRevisionId!)
  const revisions = logRevisionIds.length ? await tx.select().from(logRevisions).where(inArray(logRevisions.id, logRevisionIds)) : []
  const revisionById = new Map(revisions.map((r) => [r.id, r]))
  const evidenceRows = logRevisionIds.length
    ? await tx
        .select()
        .from(logRevisionEvidence)
        .where(inArray(logRevisionEvidence.logRevisionId, logRevisionIds))
        .orderBy(asc(logRevisionEvidence.position))
    : []
  const logs = entries.map((entry, i) => {
    const revision = revisionById.get(logRevisionIds[i]!)
    if (!revision || revision.logEntryId !== entry.id) throw invalid({ logIds: 'not_found' })
    return {
      entry,
      revision,
      evidenceVersionIds: evidenceRows.filter((r) => r.logRevisionId === revision.id).map((r) => r.artifactVersionId),
    }
  })

  // 마일스톤 + (전체 공개면) 스냅샷 파일. 스냅샷도 clean이어야 합니다.
  const milestoneRows = selection.milestoneIds.length
    ? await tx
        .select()
        .from(milestones)
        .where(and(eq(milestones.projectId, project.id), inArray(milestones.id, selection.milestoneIds)))
    : []
  if (milestoneRows.length !== selection.milestoneIds.length) throw invalid({ milestoneIds: 'not_found' })
  const snapshotRows =
    full && milestoneRows.length
      ? await tx
          .select({ snapshot: milestoneSnapshots, version: artifactVersions, artifact: artifacts })
          .from(milestoneSnapshots)
          .innerJoin(artifactVersions, eq(artifactVersions.id, milestoneSnapshots.artifactVersionId))
          .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
          .where(inArray(milestoneSnapshots.milestoneId, milestoneRows.map((m) => m.id)))
      : []
  if (snapshotRows.some((s) => s.version.scanStatus !== 'clean' || s.artifact.projectId !== project.id))
    throw invalid({ milestoneIds: 'not_clean' })
  // 메타데이터를 지우기 전(backfill 전) 이미지는 공개할 수 없습니다(ADR 0007 "메타데이터 제거").
  if (snapshotRows.some((s) => !isMetadataReady(s.version))) throw invalid({ milestoneIds: 'metadata_not_stripped' })

  // 역할 선언(지금 revision 또는 고정 revision) + 확인 + 근거.
  const claimRows = selection.claimIds.length
    ? await tx
        .select()
        .from(roleClaims)
        .where(and(eq(roleClaims.projectId, project.id), inArray(roleClaims.id, selection.claimIds)))
    : []
  if (claimRows.length !== selection.claimIds.length || claimRows.some((c) => !c.currentRevisionId)) throw invalid({ claimIds: 'not_found' })
  const claimRevisionIds = claimRows.map((c) => pins?.claims.get(c.id) ?? c.currentRevisionId!)
  const [claimRevs, endorsementRows, claimEvidenceRows] = claimRevisionIds.length
    ? await Promise.all([
        tx.select().from(claimRevisions).where(inArray(claimRevisions.id, claimRevisionIds)),
        tx.select().from(endorsements).where(inArray(endorsements.claimRevisionId, claimRevisionIds)),
        tx.select().from(claimEvidence).where(inArray(claimEvidence.claimRevisionId, claimRevisionIds)),
      ])
    : [[], [], []]
  const claims = claimRows.map((claim, i) => {
    const revision = claimRevs.find((r) => r.id === claimRevisionIds[i])
    if (!revision || revision.claimId !== claim.id) throw invalid({ claimIds: 'not_found' })
    return {
      claim,
      revision,
      endorsements: endorsementRows.filter((e) => e.claimRevisionId === revision.id),
      evidence: claimEvidenceRows.filter((e) => e.claimRevisionId === revision.id),
    }
  })

  // 파일(전체 공개만): 같은 프로젝트의 clean 버전만.
  const artifactRows = selection.artifactVersionIds.length
    ? await tx
        .select({ version: artifactVersions, artifact: artifacts })
        .from(artifactVersions)
        .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
        .where(and(eq(artifacts.projectId, project.id), inArray(artifactVersions.id, selection.artifactVersionIds)))
    : []
  if (artifactRows.length !== selection.artifactVersionIds.length) throw invalid({ artifactVersionIds: 'not_found' })
  if (artifactRows.some((a) => a.version.scanStatus !== 'clean')) throw invalid({ artifactVersionIds: 'not_clean' })
  if (artifactRows.some((a) => !isMetadataReady(a.version))) throw invalid({ artifactVersionIds: 'metadata_not_stripped' })

  // 과목 이름(학기 id는 싣지 않음).
  let course: SnapshotSource['course'] = null
  if (project.courseTermId) {
    const [row] = await tx
      .select({ term: courseTerms, course: courses, school: schools })
      .from(courseTerms)
      .innerJoin(courses, eq(courses.id, courseTerms.courseId))
      .innerJoin(schools, eq(schools.id, courses.schoolId))
      .where(eq(courseTerms.id, project.courseTermId))
      .limit(1)
    course = row ?? null
  }

  // 언급될 수 있는 사람.
  const userIds = new Set<string>()
  for (const l of logs) {
    userIds.add(l.entry.authorId)
    const attendees = l.revision.payload.attendees
    if (l.revision.tag === 'meeting' && Array.isArray(attendees)) for (const a of attendees) if (typeof a === 'string') userIds.add(a)
  }
  for (const c of claims) userIds.add(c.claim.userId)
  for (const a of artifactRows) userIds.add(a.version.uploaderId)
  for (const s of snapshotRows) userIds.add(s.version.uploaderId)
  const userRows = userIds.size ? await tx.select().from(users).where(inArray(users.id, [...userIds])) : []

  return {
    level: selection.level,
    title: selection.title,
    summary: selection.summary,
    slug: selection.slug,
    project,
    course,
    users: new Map(userRows.map((u) => [u.id, u])),
    logs,
    milestones: milestoneRows.map((milestone) => ({
      milestone,
      snapshots: snapshotRows.filter((s) => s.snapshot.milestoneId === milestone.id),
    })),
    claims,
    artifacts: artifactRows,
    usageTerms: selection.usageTerms,
    exposure: selection.exposure,
    excludedUserIds: selection.excludedUserIds,
  }
}

// ── 공개 상태 ─────────────────────────────────────────────────────────────

export function applyEvents(state: PublicationState, events: readonly PublicationEvent[], ctx: Parameters<typeof transition>[2]): PublicationState {
  let current = state
  for (const event of events) {
    const result = transition(current, event, ctx)
    if (!result.ok) {
      const embargo = result.error.code === 'PRECONDITION_FAILED' ? result.error.blockers.find((b) => b.kind === 'embargo_active') : undefined
      if (embargo && embargo.kind === 'embargo_active') throw conflict('embargo_active', { until: embargo.until.toISOString() })
      throw conflict('invalid_transition')
    }
    current = result.state
  }
  return current
}

/**
 * 새 후보 전에 공개를 draft로 되돌리는 이벤트. 게시됨은 호출하는 쪽이 따로 다룹니다(공개 상태를 그대로 두고 다음 버전 후보만 만듦, T-12).
 * 제한됨은 운영 조치(T-15)가 풀 때까지 잠깁니다.
 */
function eventsToDraft(state: PublicationState): PublicationEvent[] {
  switch (state) {
    case 'draft':
      return []
    case 'awaiting_consent':
      return ['revise_candidate']
    case 'ready':
      return ['reopen_candidate', 'revise_candidate']
    case 'withdrawn':
      return ['start_new_candidate']
    case 'embargoed':
      return ['end_embargo']
    case 'published':
    case 'restricted':
      throw conflict('publication_locked')
  }
}

interface Readiness {
  ctx: PublicationContext
  /** 계정이 active가 아닌(탈퇴 요청·정지) 당사자. 그 동의는 granted라도 유효하지 않게 넘깁니다. */
  inactiveSubjectIds: ReadonlySet<string>
}

/** 공개에 열린 보류(신고 처리 전, T-15)가 있는지. */
export async function hasOpenHold(db: DbExecutor, publicationId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: holds.id })
    .from(holds)
    .where(and(eq(holds.publicationId, publicationId), isNull(holds.releasedAt)))
    .limit(1)
  return !!row
}

/**
 * 후보의 ready 판정 컨텍스트(지금 DB의 동의·파일 상태·당사자 계정 상태·열린 보류).
 * 파일은 스냅샷의 모든 파일(고른 파일 + 마일스톤 스냅샷)이고, 지금 행이 없으면 failed로 봅니다.
 */
export async function readinessContext(db: DbExecutor, candidate: CandidateRow, now: Date): Promise<Readiness> {
  const snapshot = candidate.snapshot as unknown as PublicSnapshot
  const versionIds = snapshot.artifacts.map((a) => a.artifactVersionId)
  const [consentRows, fileRows, held] = await Promise.all([
    db
      .select({ consent: consents, userStatus: users.status })
      .from(consents)
      .innerJoin(users, eq(users.id, consents.subjectUserId))
      .where(eq(consents.candidateId, candidate.id)),
    versionIds.length
      ? db
          .select({
            id: artifactVersions.id,
            scanStatus: artifactVersions.scanStatus,
            mediaType: artifactVersions.mediaType,
            metadataStripped: artifactVersions.metadataStripped,
          })
          .from(artifactVersions)
          .where(inArray(artifactVersions.id, versionIds))
      : Promise.resolve([]),
    hasOpenHold(db, candidate.publicationId),
  ])
  // 메타데이터를 지우기 전(backfill 전) 이미지는 아직 검사가 끝나지 않은 것(pending)으로 봅니다. 이 기능 전에 만든 후보도
  // backfill 전에는 ready·게시가 되지 않고, backfill 뒤 다시 계산하면 clean입니다.
  const statusById = new Map(
    fileRows.map((f) => [f.id, f.scanStatus === 'clean' && !isMetadataReady(f) ? ('pending' as const) : f.scanStatus]),
  )
  const inactive = new Set(consentRows.filter((r) => r.userStatus !== 'active').map((r) => r.consent.subjectUserId))
  return {
    ctx: {
      now,
      candidate: {
        manifestHash: candidate.manifestHash,
        files: versionIds.map((id) => ({ artifactVersionId: id, scanStatus: statusById.get(id) ?? 'failed' })),
        requiredConsentSubjectIds: consentRows.map((r) => r.consent.subjectUserId),
      },
      consents: consentRows.map(({ consent: c }) => ({
        subjectId: c.subjectUserId,
        manifestHash: c.manifestHash,
        status: inactive.has(c.subjectUserId) && c.status === 'granted' ? 'pending' : c.status,
      })),
      hasOpenHold: held,
    },
    inactiveSubjectIds: inactive,
  }
}

/** mark_ready 전제 조건(모든 당사자 granted·파일 clean·보류 없음) 중 깨진 것 + 탈퇴·정지한 당사자. */
export async function readinessBlockers(
  db: DbExecutor,
  candidate: CandidateRow,
  now: Date,
): Promise<{ blockers: PublicationBlocker[]; inactiveSubjectIds: ReadonlySet<string> }> {
  const { ctx, inactiveSubjectIds } = await readinessContext(db, candidate, now)
  const result = transition('awaiting_consent', 'mark_ready', ctx)
  return { blockers: result.ok || result.error.code !== 'PRECONDITION_FAILED' ? [] : result.error.blockers, inactiveSubjectIds }
}

/** 도메인 blocker → 화면·409 응답용 DTO. 탈퇴·정지한 당사자는 consent_missing 대신 subject_inactive로 보여 줍니다. */
export function toBlockerDtos(
  blockers: readonly PublicationBlocker[],
  consentStatusBy: ReadonlyMap<string, ConsentStatus>,
  inactiveSubjectIds: ReadonlySet<string>,
  refs: Pick<MemberRefs, 'ref'>,
): PublicationBlockerDto[] {
  const out: PublicationBlockerDto[] = []
  for (const b of blockers) {
    // 당사자는 멤버 참조로(익명 스터디 기록은 가명 키, ADR 0026 부록).
    if (b.kind === 'consent_missing') {
      if (inactiveSubjectIds.has(b.subjectId)) out.push({ kind: 'subject_inactive', userId: refs.ref(b.subjectId) })
      else out.push({ kind: 'consent_missing', userId: refs.ref(b.subjectId), status: consentStatusBy.get(b.subjectId) ?? 'pending' })
    } else if (b.kind === 'consent_stale') out.push({ kind: 'consent_stale', userId: refs.ref(b.subjectId) })
    else if (b.kind === 'file_not_clean') out.push({ kind: 'file_not_clean', artifactVersionId: b.artifactVersionId, scanStatus: b.scanStatus })
    else if (b.kind === 'hold_open') out.push({ kind: 'hold_open' })
    else if (b.kind === 'embargo_active') out.push({ kind: 'embargo_active', until: b.until.toISOString() })
  }
  return out
}

/**
 * 열린 후보의 ready 여부를 다시 계산해 후보·공개 상태를 맞춥니다(공개 행을 잠근 트랜잭션 안에서).
 * awaiting_consent → ready(mark_ready), ready인데 조건이 깨지면 → awaiting_consent(reopen_candidate).
 * 공개 상태도 같은 도메인 이벤트로 옮깁니다(열린 후보를 따라감). 단, 게시 중인 공개(다음 버전 후보)는 공개 상태를
 * published로 그대로 둡니다(T-12).
 */
export async function refreshReadiness(tx: DbExecutor, publication: PublicationRow, candidateId: string, now: Date): Promise<CandidateRow> {
  const [candidate] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidateId)).limit(1).for('update')
  if (!candidate) throw notFound()
  if (!isOpen(candidate.status)) return candidate
  const { ctx } = await readinessContext(tx, candidate, now)
  const ready = transition('awaiting_consent', 'mark_ready', ctx).ok
  const event: PublicationEvent | null =
    candidate.status === 'awaiting_consent' && ready ? 'mark_ready' : candidate.status === 'ready' && !ready ? 'reopen_candidate' : null
  if (!event) return candidate
  const candidateState = applyEvents(candidate.status as PublicationState, [event], ctx)
  const pubState = publication.status === 'published' ? 'published' : applyEvents(publication.status, [event], ctx)
  const [updated] = await tx
    .update(publicationCandidates)
    .set({ status: candidateState as CandidateRow['status'], readyAt: candidateState === 'ready' ? now : null })
    .where(eq(publicationCandidates.id, candidate.id))
    .returning()
  await tx.update(publications).set({ status: pubState, updatedAt: now }).where(eq(publications.id, publication.id))
  publication.status = pubState
  return updated!
}

export async function lockPublication(tx: DbExecutor, publicationId: string): Promise<PublicationRow> {
  const [row] = await tx.select().from(publications).where(eq(publications.id, publicationId)).limit(1).for('update')
  if (!row) throw notFound()
  return row
}

// ── 후보 만들기 ───────────────────────────────────────────────────────────

/** 공개 행을 가져오거나 만들고 slug를 확인합니다(프로젝트 행을 잠근 트랜잭션 안에서). */
async function ensurePublication(tx: DbExecutor, actor: Actor, project: ProjectRow, selection: Selection): Promise<PublicationRow> {
  const [taken] = await tx
    .select({ id: publications.id })
    .from(publications)
    .where(and(eq(publications.slug, selection.slug), ne(publications.projectId, project.id)))
    .limit(1)
  if (taken) throw invalid({ slug: 'taken' })
  const [existing] = await tx.select().from(publications).where(eq(publications.projectId, project.id)).limit(1).for('update')
  // 한 번 게시한 공개의 주소는 바꾸지 않습니다(안정된 URL, 이미 퍼진 링크가 다른 사례를 가리키지 않게).
  if (existing?.firstPublishedAt && existing.slug !== selection.slug) throw invalid({ slug: 'locked' })
  if (existing) return existing
  try {
    const [created] = await tx
      .insert(publications)
      .values({ projectId: project.id, slug: selection.slug, level: selection.level, status: 'draft', createdBy: actor.userId })
      .returning()
    return created!
  } catch (error) {
    if (sqlState(error) === '23505') throw invalid({ slug: 'taken' })
    throw error
  }
}

async function createCandidateInTx(
  tx: DbExecutor,
  actor: Actor,
  project: ProjectRow,
  selectionInput: Selection,
  options: CreateOptions,
): Promise<CandidateRow> {
  const { now } = options
  // 익명 스터디 방의 기록(C-08, ADR 0026)은 모든 사람을 익명으로만 공개합니다(이름 노출 422).
  if (!studyExposureAllowed(project.kind === 'study' ? project.studyNameMode : null, selectionInput.exposure)) throw invalid({ exposure: 'anonymous_study' })
  // 노출 방식은 이 과제의 멤버(나간 멤버 포함)에게만 정할 수 있습니다.
  const exposureIds = Object.keys(selectionInput.exposure)
  if (exposureIds.length) {
    const rows = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), inArray(projectMembers.userId, exposureIds), ne(projectMembers.status, 'invited')))
    if (rows.length !== exposureIds.length) throw invalid({ exposure: 'not_member' })
  }

  const sourceRows = await loadSource(tx, project, selectionInput, options.pins)
  const publication = await ensurePublication(tx, actor, project, selectionInput)
  const embargo = await getProjectEmbargo(tx, project.id, now)

  // 열린 이전 후보는 대체합니다(그 동의는 더 이상 쓰이지 않음).
  // 게시 중인 공개는 상태를 그대로 두고 다음 버전 후보만 만듭니다(게시 전까지 지금 release를 계속 제공).
  const live = publication.status === 'published'
  const draftState = live ? publication.status : applyEvents(publication.status, eventsToDraft(publication.status), { now, embargoUntil: embargo.until })
  await tx
    .update(publicationCandidates)
    .set({ status: 'superseded', supersededAt: now, readyAt: null })
    .where(and(eq(publicationCandidates.publicationId, publication.id), inArray(publicationCandidates.status, [...OPEN_STATUSES])))

  const source: SnapshotSource = {
    ...sourceRows,
    publicKey: (kind, id) => publicKeyFor(publication.id, kind, id),
    privateOrigins: options.privateOrigins,
  }
  const snapshot = buildPublicSnapshot(source)
  const analysis = analyzeSelection(source)
  const manifest = buildManifest({
    projectId: project.id,
    publicationId: publication.id,
    snapshot,
    analysis,
    excludedUserIds: selectionInput.excludedUserIds,
  })
  const manifestHash = canonicalHash(manifest)

  // 점검: 공개될 내용 + 원래 파일 이름(문제지·답안 이름만 봄. 이름·연락처는 공개 이름에서 이미 바꿈)
  // + 공개될 PDF의 문서 속성 작성자 정보(검사 작업이 저장한 가린 표본).
  const rawFileNames = new Map<string, string>()
  const authorSamples = new Map<string, string>()
  const versions = [...sourceRows.artifacts.map((a) => a.version), ...sourceRows.milestones.flatMap((m) => m.snapshots.map((s) => s.version))]
  for (const version of versions) {
    rawFileNames.set(version.id, version.fileName)
    const sample = pdfAuthorSample(version.metadataFindings)
    if (sample) authorSamples.set(version.id, sample)
  }
  const pdfAuthorMetadata = snapshot.artifacts.flatMap((a) => {
    const sample = authorSamples.get(a.artifactVersionId)
    return sample ? [{ artifactVersionId: a.artifactVersionId, sample }] : []
  })
  const checks = runPublicationChecks(checkItemsFor(snapshot, rawFileNames), {
    anonymousNames: anonymousNamesOf(source),
    pdfAuthorMetadata,
  }).filter(
    (w) => w.location.field !== 'fileName' || w.rule === 'answer_file',
  )

  // 당사자: 내용이 포함된 사람 + 만든 사람(제목·요약).
  const scopes = new Map<string, string[]>([...analysis.contributors].map(([id, s]) => [id, [...s]]))
  scopes.set(actor.userId, [...new Set([...(scopes.get(actor.userId) ?? []), 'title_summary'])].sort())
  // 스터디 기록(C-08): 공개 절차와 "멤버 동의" — 내용이 없어도 지금 스터디 방 멤버(= active 과제 멤버) 모두가 당사자입니다.
  if (project.kind === 'study') {
    const members = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.status, 'active')))
    for (const { userId } of members) scopes.set(userId, [...new Set([...(scopes.get(userId) ?? []), STUDY_MEMBER_SCOPE])].sort())
  }
  const digests: Record<string, string> = {}
  for (const userId of scopes.keys()) digests[userId] = canonicalHash(subjectProjection(snapshot, analysis.refs, userId))

  // 저장하는 선택은 실제로 포함된 id만(미동의자 제외 뒤 화면 채우기에 그대로 씀).
  const included = analysis.included
  const selection: Selection = {
    ...selectionInput,
    logIds: included.logs.map((l) => l.id),
    milestoneIds: included.milestones.map((m) => m.id),
    claimIds: included.claims.map((c) => c.id),
    artifactVersionIds: selectionInput.artifactVersionIds.filter((id) => included.artifactVersionIds.includes(id)),
    excludedUserIds: [...new Set(selectionInput.excludedUserIds)].sort(),
  }

  const [{ nextVersion }] = (await tx
    .select({ nextVersion: sql<number>`coalesce(max(${publicationCandidates.version}), 0)::int + 1` })
    .from(publicationCandidates)
    .where(eq(publicationCandidates.publicationId, publication.id))) as [{ nextVersion: number }]

  const [candidate] = await tx
    .insert(publicationCandidates)
    .values({
      publicationId: publication.id,
      projectId: project.id,
      version: nextVersion,
      level: selection.level,
      status: 'awaiting_consent',
      snapshot: snapshot as unknown as Record<string, unknown>,
      manifest: manifest as unknown as Record<string, unknown>,
      manifestHash,
      selection: selection as unknown as Record<string, unknown>,
      refs: analysis.refs as unknown as Record<string, unknown>,
      checks: checks as unknown as Array<Record<string, unknown>>,
      subjectDigests: digests,
      derivedFromId: options.derivedFrom?.id ?? null,
      createdBy: actor.userId,
      createdAt: now,
    })
    .returning()
  if (!candidate) throw new Error('candidate insert failed')

  const pubState = live
    ? publication.status
    : applyEvents(draftState, ['create_candidate'], {
        now,
        embargoUntil: embargo.until,
        candidate: { manifestHash, files: [], requiredConsentSubjectIds: [] },
      })
  try {
    // 게시 중이면 공개 수준은 게시할 때 바꿉니다(지금 제공하는 release와 어긋나지 않게).
    await tx
      .update(publications)
      .set(live ? { updatedAt: now } : { status: pubState, slug: selection.slug, level: selection.level, updatedAt: now })
      .where(eq(publications.id, publication.id))
  } catch (error) {
    if (sqlState(error) === '23505') throw invalid({ slug: 'taken' })
    throw error
  }
  publication.status = pubState

  // 동의 요청. 만든 사람은 명시적으로 체크했을 때만 granted, 미동의자 제외 후보는 자기 부분이 같을 때만 이어받습니다.
  const previous = options.derivedFrom
  const previousGrants = previous
    ? new Set(
        (await tx.select().from(consents).where(and(eq(consents.candidateId, previous.id), eq(consents.status, 'granted')))).map(
          (c) => c.subjectUserId,
        ),
      )
    : new Set<string>()
  const previousDigests = (previous?.subjectDigests ?? {}) as Record<string, string>
  const consentValues = [...scopes].map(([userId, scope]) => {
    const self = userId === actor.userId && options.consentSelf
    const carried = !self && previousGrants.has(userId) && previousDigests[userId] === digests[userId]
    return {
      candidateId: candidate.id,
      manifestHash,
      subjectUserId: userId,
      scope,
      status: self || carried ? ('granted' as const) : ('pending' as const),
      decidedAt: self || carried ? now : null,
      carriedFromCandidateId: carried ? previous!.id : null,
      createdAt: now,
    }
  })
  if (consentValues.length) await tx.insert(consents).values(consentValues)

  await recordAudit(tx, {
    actorId: actor.userId,
    action: previous ? 'publication.exclude_declined' : 'publication.candidate_create',
    targetType: 'publication_candidate',
    targetId: candidate.id,
    projectId: project.id,
    metadata: {
      version: nextVersion,
      level: selection.level,
      subjects: consentValues.length,
      warnings: checks.length,
      carried: consentValues.filter((c) => c.carriedFromCandidateId).length,
    },
  })
  return refreshReadiness(tx, publication, candidate.id, now)
}

export interface ServiceOptions {
  /** 이 사이트의 origin(공개 스냅샷에서 이 사이트 링크를 뺌). handler가 NUXT_SITE_ORIGIN을 넘깁니다. */
  privateOrigins?: readonly string[]
}

/**
 * POST /projects/:id/publication-candidates — active owner/editor. 201 + 후보 DTO.
 * reviewer/viewer 403, 비멤버 404, 엠바고 409 embargo_active, 선택 오류 422, 게시됨·제한됨 409 publication_locked.
 */
export async function createCandidate(
  db: DbExecutor,
  actor: Actor,
  projectId: unknown,
  rawInput: unknown,
  now = new Date(),
  options: ServiceOptions = {},
): Promise<PublicationCandidateDto> {
  const input = parseInput(createCandidateSchema, rawInput)
  return db.transaction(async (tx) => {
    const { project, membership } = await loadReadableProject(tx, actor, projectId, { lock: true })
    if (!canPreparePublication({ userId: actor.userId }, project, membership)) throw forbidden()
    await assertPublishable(tx, actor, project.id, now)
    // 익명 스터디 기록의 이름 노출은 키를 보기 전에 422 anonymous_study(ADR 0026). 그다음 멤버 참조를 실제 id로(모르면 422 not_member).
    if (!studyExposureAllowed(project.kind === 'study' ? project.studyNameMode : null, input.exposure)) throw invalid({ exposure: 'anonymous_study' })
    const refs = await loadMemberRefs(tx, project, actor.userId)
    const exposureEntries = Object.entries(input.exposure)
    const exposureIds = refs.resolveAll(exposureEntries.map(([key]) => key), 'exposure')
    const exposure = Object.fromEntries(exposureEntries.map(([, mode], i) => [exposureIds[i]!, mode]))
    if (Object.keys(exposure).length !== exposureEntries.length) throw invalid({ exposure: 'invalid' })
    const selection: Selection = {
      level: input.level,
      title: input.title,
      summary: input.summary,
      slug: input.slug,
      logIds: input.logIds,
      milestoneIds: input.milestoneIds,
      artifactVersionIds: input.artifactVersionIds,
      claimIds: input.claimIds,
      exposure: lowerKeys(exposure),
      usageTerms: lowerKeys(input.usageTerms) as Record<string, UsageTerms>,
      excludedUserIds: [],
    }
    const candidate = await createCandidateInTx(tx, actor, project, selection, {
      now,
      consentSelf: input.consentSelf,
      privateOrigins: options.privateOrigins ?? [],
    })
    await emitCandidatePrepared(tx, actor, project.id, selection, false)
    return toCandidateDto(tx, actor, candidate, membership, now)
  })
}

/** 공개 후보 이벤트(수준·고른 개수만). */
async function emitCandidatePrepared(tx: DbExecutor, actor: Actor, projectId: string, selection: Selection, derived: boolean) {
  const n = (list: readonly unknown[] | undefined, max: number) => Math.min(list?.length ?? 0, max)
  await emitAnalytics(tx, {
    name: 'candidate_prepared',
    actorId: actor.userId,
    projectId,
    props: {
      level: selection.level,
      logs: n(selection.logIds, 1000),
      claims: n(selection.claimIds, 1000),
      milestones: n(selection.milestoneIds, 100),
      files: n(selection.artifactVersionIds, 1000),
      derived,
    },
  })
}

function lowerKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]))
}

/**
 * POST /candidates/:id/exclude-declined — owner만. 거절한 당사자의 자료를 뺀 새 후보(201).
 * 철회된 지금 release에도 쓸 수 있고, 그때는 동의를 철회한 사람도 뺍니다(T-12). 이전 release의 granted 동의는
 * 자기 관련 부분이 그대로인 사람만 이어받습니다.
 * 거절이 없으면 409 `no_declined`, 대체된 후보면 409 `superseded`, 엠바고 409.
 */
export async function excludeDeclined(
  db: DbExecutor,
  actor: Actor,
  candidateId: unknown,
  rawInput: unknown,
  now = new Date(),
  options: ServiceOptions = {},
): Promise<PublicationCandidateDto> {
  const input = parseInput(excludeDeclinedSchema, rawInput)
  if (!isUuid(candidateId)) throw notFound()
  return db.transaction(async (tx) => {
    const [found] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidateId)).limit(1)
    if (!found) throw notFound()
    const { project, membership } = await loadReadableProject(tx, actor, found.projectId, { lock: true })
    if (!canManagePublication({ userId: actor.userId }, project, membership)) throw forbidden()
    await assertPublishable(tx, actor, project.id, now)
    const publication = await lockPublication(tx, found.publicationId)
    const [candidate] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, found.id)).limit(1).for('update')
    if (!candidate) throw notFound()
    // 철회된 지금 release(당사자 동의 철회·owner 철회)에서도 거절·철회한 사람을 뺀 새 후보를 만들 수 있습니다(T-12).
    const withdrawnRelease =
      candidate.status === 'withdrawn' && publication.status === 'withdrawn' && publication.currentReleaseId === candidate.id
    if (!isOpen(candidate.status) && !withdrawnRelease) throw await supersededError(tx, found)
    const excludedStatuses = withdrawnRelease ? (['declined', 'revoked'] as const) : (['declined'] as const)
    const declined = (
      await tx.select().from(consents).where(and(eq(consents.candidateId, candidate.id), inArray(consents.status, [...excludedStatuses])))
    ).map((c) => c.subjectUserId)
    if (declined.length === 0) throw conflict('no_declined')

    const previous = candidate.selection as unknown as Selection
    const refs = candidate.refs as unknown as SnapshotRefs
    const pins: Pins = {
      logs: new Map(Object.values(refs.logs).map((l) => [l.id, l.revisionId])),
      claims: new Map(Object.values(refs.claims).map((c) => [c.id, c.revisionId])),
    }
    const next = await createCandidateInTx(
      tx,
      actor,
      project,
      { ...previous, excludedUserIds: [...new Set([...previous.excludedUserIds, ...declined])] },
      { now, consentSelf: input.consentSelf, privateOrigins: options.privateOrigins ?? [], pins, derivedFrom: candidate },
    )
    await emitCandidatePrepared(tx, actor, project.id, previous, true)
    return toCandidateDto(tx, actor, next, membership, now)
  })
}

export async function supersededError(db: DbExecutor, candidate: CandidateRow): Promise<ServiceError> {
  const [open] = await db
    .select({ id: publicationCandidates.id })
    .from(publicationCandidates)
    .where(and(eq(publicationCandidates.publicationId, candidate.publicationId), inArray(publicationCandidates.status, [...OPEN_STATUSES])))
    .limit(1)
  return conflict('superseded', { currentCandidateId: open?.id ?? null })
}

// ── 볼 수 있는 후보 ───────────────────────────────────────────────────────

interface VisibleCandidate {
  candidate: CandidateRow
  /** active 멤버면 멤버십, 당사자로만 볼 수 있으면 null. */
  membership: Membership | null
}

/** 후보를 볼 수 있는 사람: 그 과제의 active 멤버 또는 그 후보의 동의 당사자(나간 멤버 포함). 그 밖에는 404. */
async function loadVisibleCandidate(db: DbExecutor, actor: Actor, candidateId: unknown): Promise<VisibleCandidate> {
  if (!isUuid(candidateId)) throw notFound()
  const [candidate] = await db.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidateId)).limit(1)
  if (!candidate) throw notFound()
  const membership = await findMembership(db, candidate.projectId, actor.userId)
  if (membership?.status === 'active') return { candidate, membership }
  const [subject] = await db
    .select({ id: consents.id })
    .from(consents)
    .where(and(eq(consents.candidateId, candidate.id), eq(consents.subjectUserId, actor.userId)))
    .limit(1)
  if (!subject) throw notFound()
  return { candidate, membership: null }
}

/** GET /candidates/:id — 멤버·당사자. ready 여부를 다시 계산한 뒤 돌려줍니다. */
export async function getCandidate(db: DbExecutor, actor: Actor, candidateId: unknown, now = new Date()): Promise<PublicationCandidateDto> {
  const visible = await loadVisibleCandidate(db, actor, candidateId)
  return db.transaction(async (tx) => {
    const publication = await lockPublication(tx, visible.candidate.publicationId)
    const candidate = await refreshReadiness(tx, publication, visible.candidate.id, now)
    return toCandidateDto(tx, actor, candidate, visible.membership, now)
  })
}

/** GET /candidates/:id/preview — 저장된 스냅샷 그대로(공개 페이지가 보여 줄 것과 같음). 멤버·당사자, 그 밖에는 404. */
export async function previewCandidate(db: DbExecutor, actor: Actor, candidateId: unknown): Promise<CandidatePreviewDto> {
  const { candidate } = await loadVisibleCandidate(db, actor, candidateId)
  return {
    candidateId: candidate.id,
    status: candidate.status,
    manifestHash: candidate.manifestHash,
    snapshot: candidate.snapshot as unknown as PublicSnapshot,
  }
}

// ── 동의 ─────────────────────────────────────────────────────────────────

/**
 * POST /candidates/:id/consents {decision, manifestHash, note?} — 당사자 본인만. 200 + 후보 DTO.
 * 볼 수 없으면 404, 당사자가 아니면 403 not_subject, 대체됨 409 superseded, 해시 다름 409 stale_manifest.
 */
export async function decideConsent(
  db: DbExecutor,
  actor: Actor,
  candidateId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<PublicationCandidateDto> {
  const visible = await loadVisibleCandidate(db, actor, candidateId)
  const input = parseInput(consentDecisionSchema, rawInput)
  return db.transaction(async (tx) => {
    const publication = await lockPublication(tx, visible.candidate.publicationId)
    const [candidate] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, visible.candidate.id)).limit(1).for('update')
    if (!candidate) throw notFound()
    const [consent] = await tx
      .select()
      .from(consents)
      .where(and(eq(consents.candidateId, candidate.id), eq(consents.subjectUserId, actor.userId)))
      .limit(1)
      .for('update')
    if (!consent) throw forbidden('not_subject')
    if (!isOpen(candidate.status)) throw await supersededError(tx, candidate)
    if (input.manifestHash !== candidate.manifestHash || consent.manifestHash !== candidate.manifestHash)
      throw conflict('stale_manifest', { currentManifestHash: candidate.manifestHash })
    await tx
      .update(consents)
      .set({ status: input.decision, decidedAt: now, note: input.note, carriedFromCandidateId: null })
      .where(eq(consents.id, consent.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'consent.decide',
      targetType: 'consent',
      targetId: consent.id,
      projectId: candidate.projectId,
      metadata: { decision: input.decision, candidateVersion: candidate.version },
    })
    const updated = await refreshReadiness(tx, publication, candidate.id, now)
    await emitAnalytics(tx, {
      name: 'consent_completed',
      actorId: actor.userId,
      projectId: candidate.projectId,
      props: { decision: input.decision, allGranted: updated.status === 'ready' },
    })
    return toCandidateDto(tx, actor, updated, visible.membership, now)
  })
}

/** GET /me/consent-requests — 내 대기 중 동의 요청(열린 후보만, 과제 이름과 미리보기 링크). */
export async function listMyConsentRequests(db: DbExecutor, actor: Actor): Promise<ConsentRequestDto[]> {
  const rows = await db
    .select({ consent: consents, candidate: publicationCandidates, projectTitle: projects.title, requestedBy: users.displayName })
    .from(consents)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, consents.candidateId))
    .innerJoin(projects, eq(projects.id, publicationCandidates.projectId))
    .innerJoin(users, eq(users.id, publicationCandidates.createdBy))
    .where(
      and(
        eq(consents.subjectUserId, actor.userId),
        eq(consents.status, 'pending'),
        inArray(publicationCandidates.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(desc(publicationCandidates.createdAt))
  // 익명 스터디 기록(C-08)은 요청한 사람 이름도 가립니다.
  const masks = new Map<string, MemberRefs>()
  for (const { candidate } of rows) if (!masks.has(candidate.projectId)) masks.set(candidate.projectId, await loadMemberRefs(db, candidate.projectId, actor.userId))
  return rows.map(({ consent, candidate, projectTitle, requestedBy }) => ({
    candidateId: candidate.id,
    projectId: candidate.projectId,
    projectTitle,
    publicTitle: (candidate.snapshot as unknown as PublicSnapshot).title,
    level: candidate.level,
    manifestHash: candidate.manifestHash,
    scope: consent.scope,
    requestedAt: consent.createdAt.toISOString(),
    requestedBy: masks.get(candidate.projectId)!.maskName({ userId: candidate.createdBy, displayName: requestedBy.trim() || '이름 미설정', handle: null }).displayName,
    previewUrl: `/consents?candidate=${candidate.id}`,
  }))
}

// ── 공개 준비 화면 ────────────────────────────────────────────────────────

/**
 * GET /projects/:id/publication — 멤버. 공개 상태·게시 요약, 보여 줄 후보(열린 후보 → 지금 release → 마지막 후보 순), 선택지,
 * 엠바고, 게시 이력.
 */
export async function getPublicationState(db: DbExecutor, actor: Actor, projectId: unknown, now = new Date()): Promise<PublicationStateDto> {
  const { project, membership } = await loadReadableProject(db, actor, projectId)
  const embargo = toEmbargoDto(await getProjectEmbargo(db, project.id, now))
  const [publication] = await db.select().from(publications).where(eq(publications.projectId, project.id)).limit(1)
  let candidate: PublicationCandidateDto | null = null
  if (publication) {
    const [open] = await db
      .select({ id: publicationCandidates.id })
      .from(publicationCandidates)
      .where(and(eq(publicationCandidates.publicationId, publication.id), inArray(publicationCandidates.status, [...OPEN_STATUSES])))
      .limit(1)
    const [latest] = await db
      .select({ id: publicationCandidates.id })
      .from(publicationCandidates)
      .where(eq(publicationCandidates.publicationId, publication.id))
      .orderBy(desc(publicationCandidates.version))
      .limit(1)
    const shownId = open?.id ?? publication.currentReleaseId ?? latest?.id
    if (shownId) candidate = await getCandidate(db, actor, shownId, now)
  }
  const [current] = publication ? await db.select().from(publications).where(eq(publications.id, publication.id)).limit(1) : []
  const holdRows = current
    ? await db
        .select({ reason: holds.reason, createdAt: holds.createdAt })
        .from(holds)
        .where(and(eq(holds.publicationId, current.id), isNull(holds.releasedAt)))
        .orderBy(asc(holds.createdAt))
    : []
  return {
    publication: current ? await loadPublicationSummary(db, current) : null,
    candidate,
    options: await publicationOptions(db, project, actor),
    embargo,
    canPrepare: canPreparePublication({ userId: actor.userId }, project, membership),
    canManage: canManagePublication({ userId: actor.userId }, project, membership),
    releases: current ? await listReleases(db, current.id) : [],
    // 운영 조치 안내(T-15): 지금 효력이 있는 제한·가린 항목. 당사자용 사유만(내부 메모·신고 내용 없음), 이의제기는 owner만.
    moderation: current ? await publicationNotices(db, actor, current.id) : [],
    holds: holdRows.map((h) => ({ reason: h.reason, createdAt: h.createdAt.toISOString() })),
  }
}

async function publicationOptions(db: DbExecutor, project: ProjectRow, actor: Actor): Promise<PublicationOptionsDto> {
  // 익명 스터디 기록(C-08, ADR 0026 부록)은 다른 멤버의 이름과 id를 가립니다(노출 방식 선택지의 키도 가명 키).
  const refs = await loadMemberRefs(db, project, actor.userId)
  const author = (userId: string, displayName: string, handle: string | null) => refs.person({ userId, displayName, handle })
  const [logRows, milestoneRows, snapshotCounts, claimRows, versionRows, memberRows] = await Promise.all([
    db
      .select({ entry: logEntries, revision: logRevisions, displayName: users.displayName, handle: profiles.handle })
      .from(logEntries)
      .innerJoin(logRevisions, eq(logRevisions.id, logEntries.currentRevisionId))
      .innerJoin(users, eq(users.id, logEntries.authorId))
      .leftJoin(profiles, eq(profiles.userId, logEntries.authorId))
      .where(eq(logEntries.projectId, project.id))
      .orderBy(asc(logEntries.createdAt), asc(logEntries.id))
      .limit(500),
    db.select().from(milestones).where(eq(milestones.projectId, project.id)).orderBy(asc(milestones.position)),
    db
      .select({ milestoneId: milestoneSnapshots.milestoneId, count: sql<number>`count(*)::int` })
      .from(milestoneSnapshots)
      .innerJoin(milestones, eq(milestones.id, milestoneSnapshots.milestoneId))
      .where(eq(milestones.projectId, project.id))
      .groupBy(milestoneSnapshots.milestoneId),
    db
      .select({ claim: roleClaims, revision: claimRevisions, displayName: users.displayName, handle: profiles.handle })
      .from(roleClaims)
      .innerJoin(claimRevisions, eq(claimRevisions.id, roleClaims.currentRevisionId))
      .innerJoin(users, eq(users.id, roleClaims.userId))
      .leftJoin(profiles, eq(profiles.userId, roleClaims.userId))
      .where(eq(roleClaims.projectId, project.id))
      .orderBy(asc(roleClaims.createdAt), asc(roleClaims.id)),
    db
      .select({ version: artifactVersions, title: artifacts.title, displayName: users.displayName, handle: profiles.handle })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .innerJoin(users, eq(users.id, artifactVersions.uploaderId))
      .leftJoin(profiles, eq(profiles.userId, artifactVersions.uploaderId))
      .where(eq(artifacts.projectId, project.id))
      .orderBy(asc(artifacts.createdAt), asc(artifactVersions.versionNo)),
    db
      .select({ userId: projectMembers.userId, status: projectMembers.status, displayName: users.displayName })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, project.id), ne(projectMembers.status, 'invited'))),
  ])
  const revisionIds = claimRows.map((c) => c.revision.id)
  const endorsementRows = revisionIds.length ? await db.select().from(endorsements).where(inArray(endorsements.claimRevisionId, revisionIds)) : []
  const countBy = new Map(snapshotCounts.map((r) => [r.milestoneId, r.count]))
  return {
    logs: logRows.map(({ entry, revision, displayName, handle }) => ({
      id: entry.id,
      tag: entry.tag,
      summary: summarize(entry.tag, revision.body, revision.payload),
      author: author(entry.authorId, displayName, handle),
      revisionNo: revision.revisionNo,
      createdAt: entry.createdAt.toISOString(),
      retrospective: entry.source === 'retro' || entry.retrospective,
    })),
    milestones: milestoneRows.map((m) => ({
      id: m.id,
      title: m.title,
      position: m.position,
      snapshotCount: countBy.get(m.id) ?? 0,
      retrospective: m.retrospective,
    })),
    claims: claimRows.map(({ claim, revision, displayName, handle }) => ({
      id: claim.id,
      text: revision.text,
      author: author(claim.userId, displayName, handle),
      revisionNo: revision.revisionNo,
      status: claimStatusSummary(
        { id: claim.id, projectId: claim.projectId, userId: claim.userId, revisions: [{ id: revision.id, revisionNo: revision.revisionNo }] },
        endorsementRows.map((e) => ({ claimRevisionId: e.claimRevisionId, endorserId: e.endorserId, status: e.status })),
      ).status,
    })),
    artifactVersions: versionRows.map(({ version, title, displayName, handle }) => ({
      versionId: version.id,
      artifactId: version.artifactId,
      title,
      fileName: version.fileName,
      versionNo: version.versionNo,
      mediaType: version.mediaType,
      bytes: version.bytes,
      scanStatus: version.scanStatus,
      uploader: author(version.uploaderId, displayName, handle),
    })),
    members: memberRows
      .map((m) => {
        const { userId, displayName } = refs.person({ userId: m.userId, displayName: m.displayName, handle: null })
        return { userId, displayName, status: m.status }
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko') || (a.userId < b.userId ? -1 : 1)),
    licenses: [...LICENSE_ALLOWLIST],
  }
}

// ── DTO ──────────────────────────────────────────────────────────────────

function fixUrlFor(projectId: string, refs: SnapshotRefs, location: PublicationCheckDto['location']): string | null {
  switch (location.kind) {
    case 'log': {
      const ref = location.key ? refs.logs[location.key] : undefined
      return ref ? `/projects/${projectId}#log-${ref.id}` : `/projects/${projectId}`
    }
    case 'artifact':
      return `/projects/${projectId}#artifacts-heading`
    case 'claim':
    case 'milestone':
      return `/projects/${projectId}`
    default:
      return null
  }
}

export async function toCandidateDto(
  db: DbExecutor,
  actor: Actor,
  candidate: CandidateRow,
  membership: Membership | null,
  now: Date,
): Promise<PublicationCandidateDto> {
  const snapshot = candidate.snapshot as unknown as PublicSnapshot
  const refs = candidate.refs as unknown as SnapshotRefs
  const selection = candidate.selection as unknown as Selection
  const [[publication], [creator], subjectRows, embargo] = await Promise.all([
    db.select().from(publications).where(eq(publications.id, candidate.publicationId)).limit(1),
    db.select({ displayName: users.displayName }).from(users).where(eq(users.id, candidate.createdBy)).limit(1),
    db
      .select({ consent: consents, displayName: users.displayName, memberStatus: projectMembers.status })
      .from(consents)
      .innerJoin(users, eq(users.id, consents.subjectUserId))
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, candidate.projectId), eq(projectMembers.userId, consents.subjectUserId)))
      .where(eq(consents.candidateId, candidate.id)),
    getProjectEmbargo(db, candidate.projectId, now),
  ])
  if (!publication) throw notFound()
  // 익명 스터디 기록(C-08)은 당사자 이름도 "스터디 멤버 N"으로 가립니다(본인은 그대로).
  // 당사자·만든 사람·막는 것·선택(노출 방식·제외한 사람)의 사람 참조도 멤버 참조로(ADR 0026 부록).
  const people = await loadMemberRefs(db, candidate.projectId, actor.userId)
  const mask = people.maskName
  const keyByUser = new Map(Object.entries(refs.members).map(([key, userId]) => [userId, key]))
  const memberByKey = new Map(snapshot.members.map((m) => [m.key, m]))

  const subjects: ConsentSubjectDto[] = subjectRows
    .map(({ consent, displayName, memberStatus }) => {
      const key = keyByUser.get(consent.subjectUserId) ?? null
      const member = key ? memberByKey.get(key) : undefined
      return {
        userId: people.ref(consent.subjectUserId),
        displayName: mask({ userId: consent.subjectUserId, displayName: displayName.trim() || '이름 미설정', handle: null }).displayName,
        active: memberStatus === 'active',
        memberKey: key,
        exposure: member ? (member.anonymous ? ('anonymous' as ExposureMode) : ('name' as ExposureMode)) : null,
        scope: consent.scope,
        status: consent.status,
        decidedAt: consent.decidedAt?.toISOString() ?? null,
        note: consent.note,
        carried: consent.carriedFromCandidateId !== null,
      }
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko') || (a.userId < b.userId ? -1 : 1))

  const open = isOpen(candidate.status)
  const blockers: PublicationBlockerDto[] = []
  if (!open) {
    // 게시·철회·대체된 release는 막는 것 대신 상태로 보여 줍니다. 대체된 후보만 superseded.
    if (candidate.status === 'superseded') blockers.push({ kind: 'superseded' })
  } else {
    const statusBy = new Map(subjectRows.map((r) => [r.consent.subjectUserId, r.consent.status]))
    const readiness = await readinessBlockers(db, candidate, now)
    blockers.push(...toBlockerDtos(readiness.blockers, statusBy, readiness.inactiveSubjectIds, people))
    // 엠바고는 ready 판정에는 들어가지 않지만 게시를 막으므로 함께 보여 줍니다.
    if (embargo.active && embargo.until) blockers.push({ kind: 'embargo_active', until: embargo.until.toISOString() })
  }

  const mine = subjectRows.find((r) => r.consent.subjectUserId === actor.userId)?.consent ?? null
  const isOwner = membership !== null && canManagePublication({ userId: actor.userId }, { id: candidate.projectId }, membership)
  const checks = (candidate.checks as unknown as Array<Omit<PublicationCheckDto, 'fixUrl'>>).map((c) => ({
    ...c,
    fixUrl: membership ? fixUrlFor(candidate.projectId, refs, c.location) : null,
  }))
  return {
    id: candidate.id,
    projectId: candidate.projectId,
    publicationId: candidate.publicationId,
    version: candidate.version,
    level: candidate.level,
    status: candidate.status,
    slug: snapshot.slug,
    title: snapshot.title,
    manifestHash: candidate.manifestHash,
    createdAt: candidate.createdAt.toISOString(),
    createdBy: { userId: people.ref(candidate.createdBy), displayName: mask({ userId: candidate.createdBy, displayName: creator?.displayName.trim() || '이름 미설정', handle: null }).displayName },
    readyAt: candidate.readyAt?.toISOString() ?? null,
    supersededAt: candidate.supersededAt?.toISOString() ?? null,
    derivedFromId: candidate.derivedFromId,
    publicationStatus: publication.status,
    checks,
    subjects,
    blockers,
    selection: people.pseudonymous
      ? {
          ...selection,
          exposure: Object.fromEntries(Object.entries(selection.exposure).map(([userId, mode]) => [people.ref(userId), mode])),
          excludedUserIds: selection.excludedUserIds.map(people.ref),
        }
      : selection,
    myConsent: (mine?.status as ConsentStatus | undefined) ?? null,
    canDecide: open && mine !== null,
    canExcludeDeclined:
      isOwner &&
      (open
        ? subjectRows.some((r) => r.consent.status === 'declined')
        : candidate.status === 'withdrawn' && publication.status === 'withdrawn' && publication.currentReleaseId === candidate.id &&
          subjectRows.some((r) => r.consent.status === 'declined' || r.consent.status === 'revoked')),
    canPublish: open && isOwner && blockers.length === 0,
    releaseNo: candidate.releaseNo,
    publishedAt: candidate.publishedAt?.toISOString() ?? null,
    counts: {
      logs: snapshot.logs.length,
      milestones: snapshot.milestones.length,
      claims: snapshot.claims.length,
      artifacts: snapshot.artifacts.length,
      members: snapshot.members.length,
    },
  }
}
