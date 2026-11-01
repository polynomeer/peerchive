/**
 * 운영자 신고 처리 (T-15, SYSTEM_DESIGN §6.6·§8·§14, DELIVERY_PLAN T-15·§7 G2, ADR 0015).
 *
 * 모든 함수는 운영자만(아니면 403 `operator_only`, 대상 존재 여부보다 먼저 확인). 화면 `/operator`는 운영자가 아니면 404로 보입니다.
 * - 대기열 `GET /operator/reports?status=&overdue=1`: 대상별로 묶은 신고(개수·사유별 개수·처음/마지막 신고 시각·담당자·보류 여부). 신고자 신원은 싣지 않습니다.
 *   신고 누적으로 임시 숨김된 커뮤니티 글·댓글(C-06)은 `autoHidden: true`로 맨 앞에 옵니다(우선 검토). 처리하면서 가리기를 고르면 확정, 기각·조치 없음이면 복원.
 *   처리 기한(C-10, ADR 0027): 묶음마다 `sla`(우선순위·시작·기한·나이·ok/due_soon/overdue). 처리 전 묶음은 지금까지, 끝난 묶음은 처리 시각까지로 잽니다.
 *   `overdue=1`이면 기한을 넘긴 묶음만(처리 전 상태에서만 뜻이 있음). 기한은 환경 변수(@peerchive/domain reportSlaTargets, 기본 24·72시간).
 * - 상세 `GET /operator/reports/:id`: 같은 대상의 신고들(사유·설명), **공개됐던 내용만**(신고 때의 release 스냅샷, 신고 때 버전이 그대로인
 *   게시된·숨긴 노트·케이스 글, 공개 프로필 필드), 보류, 조치·이의제기 이력. 비공개 과제 공간은 운영자에게도 404입니다(§8).
 * - 담당 `POST .../assign`: 자기에게 배정, 그 대상의 처리 전 신고를 in_review로.
 * - 처리 `POST .../resolve {action, note, publicReason?, notifyOwner}`·기각 `POST .../dismiss {note}`: 한 트랜잭션에서 조치 적용(actions.ts) +
 *   같은 대상의 처리 전 신고를 모두 닫음 + 그 신고들이 건 보류를 풂 + 감사. note(내부 메모)는 필수이고, publicReason(당사자에게 보일 사유)은
 *   별도 필드입니다(조치가 있고 notifyOwner면 필수).
 * - 제한 해제 `POST /operator/publications/:id/lift-restriction {note}`: restricted → draft(owner가 후보·동의·게시를 다시 함).
 * - 이의제기 `GET /operator/appeals?status=`·`POST /operator/appeals/:id/decide {decision: uphold|reverse, note}`: 되돌리면 조치를 풉니다.
 * - 감사 `GET /operator/audit?target=<id>`: 그 대상(또는 조치·신고 id)의 감사 기록. 감사에는 신고 설명·메모 글이 없습니다(id·종류만).
 */
import { z } from 'zod'
import {
  ACTIONS_BY_TARGET,
  APPEAL_DECISIONS,
  CASE_SECTION_LABELS,
  MODERATION_ACTION_KINDS,
  MODERATION_NOTE_MAX,
  MODERATION_PUBLIC_REASON_MAX,
  REPORT_STATUSES,
  type ReportStatus,
  appealTransition,
  citationLabel,
  isActionApplicable,
  isReportOpen,
  reportGroupSla,
} from '@peerchive/domain'
import {
  and,
  appeals,
  asc,
  auditEvents,
  caseStudies,
  desc,
  eq,
  holds,
  inArray,
  isNull,
  moderationActions,
  or,
  profiles,
  publicationCandidates,
  publications,
  releaseHiddenItems,
  reports,
  seniorNotes,
  courseQaItems,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { loadRetroForOperator } from '../institutions/completion-retros'
import { recordAudit } from '../audit/audit'
import { communityItemStatuses, operatorCommunityItem, operatorRecruitmentItem, operatorSpaceContent } from '../community/reporting'
import { requireOperator } from '../catalog/operators'
import { publicNotePath } from '../course-hub/search'
import { publicQaPath, toPublicCourseQa } from '../course-hub/course-qa'
import { toPublicSeniorNote } from '../course-hub/hub'
import { type Actor, conflict, invalid, notFound } from '../errors'
import { toPublicProfileDto } from '../identity/profiles'
import { asCaseSnapshot, loadCaseStudiesWithRelease, loadSections } from '../portfolio/release-scope'
import { isPubliclyVisible } from '../portfolio/view'
import { isUuid } from '../projects/access'
import { lockPublication } from '../publication/candidates'
import { loadServedRelease } from '../publication/public-read'
import { parseInput } from '../validation'
import { applyModeration, undoModeration } from './actions'
import { personaReportContent } from './personas'
import { currentReportSlaTargets } from './sla'
import { pointerOf, targetLabels, type TargetPointer } from './targets'
import type {
  OperatorActionDto,
  OperatorAppealDto,
  OperatorAuditEventDto,
  OperatorReportDetailDto,
  OperatorReportDto,
  OperatorReportGroupDto,
  OperatorTargetContentDto,
  PublicSnapshot,
} from '../../../shared/types/api'

type ReportRow = typeof reports.$inferSelect

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

const note = z
  .string({ error: requiredOr('invalid') })
  .trim()
  .min(1, { error: 'required' })
  .max(MODERATION_NOTE_MAX, { error: 'too_long' })

export const resolveSchema = z
  .object({
    action: z.enum(MODERATION_ACTION_KINDS, { error: requiredOr('invalid') }),
    /** 내부 메모(운영자만). */
    note,
    /** 당사자에게 보일 사유(내부 메모와 별도). */
    publicReason: z
      .string({ error: 'invalid' })
      .trim()
      .max(MODERATION_PUBLIC_REASON_MAX, { error: 'too_long' })
      .nullish()
      .transform((v) => (v ? v : null)),
    notifyOwner: z.boolean({ error: 'invalid' }).default(false),
  })
  .refine((v) => v.action === 'none' || !v.notifyOwner || v.publicReason !== null, { error: 'required', path: ['publicReason'] })

export const noteOnlySchema = z.object({ note })
export const decideAppealSchema = z.object({ decision: z.enum(APPEAL_DECISIONS, { error: requiredOr('invalid') }), note })

/** 첫 처리 시각은 한 번만 남깁니다(다시 배정해도 그대로). 신고 시각보다 앞설 수 없습니다(시계가 다른 요청·테스트 시각). */
const firstActionSql = (now: Date) => sql`coalesce(${reports.firstActionAt}, greatest(${reports.createdAt}, ${now.toISOString()}::timestamptz))`

const statusOf = (raw: unknown, fallback: string) => {
  const value = typeof raw === 'string' && raw ? raw : fallback
  return value
}

// ── 대기열 ───────────────────────────────────────────────────────────────

/**
 * GET /operator/reports?status=open|in_review|resolved|dismissed(기본 open)&overdue=1 — 대상별 묶음(처리 전은 임시 숨김 먼저, 그 안에서 오래된 것부터).
 * overdue는 `1`·`true`만(그 밖의 값 422). 처리된 상태와 함께 쓰면 422 `overdue: open_only`.
 */
export async function listReportGroups(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>, now = new Date()): Promise<OperatorReportGroupDto[]> {
  await requireOperator(db, actor)
  const status = statusOf(rawQuery.status, 'open')
  if (!(REPORT_STATUSES as readonly string[]).includes(status)) throw invalid({ status: 'invalid' })
  const overdueRaw = rawQuery.overdue
  if (overdueRaw !== undefined && overdueRaw !== '' && !['1', 'true', '0', 'false'].includes(String(overdueRaw))) throw invalid({ overdue: 'invalid' })
  const overdueOnly = overdueRaw === '1' || overdueRaw === 'true'
  if (overdueOnly && !isReportOpen(status as ReportStatus)) throw invalid({ overdue: 'open_only' })
  const targets = currentReportSlaTargets()
  const rows = await db
    .select({ report: reports, assigneeName: users.displayName })
    .from(reports)
    .leftJoin(users, eq(users.id, reports.assignedTo))
    .where(eq(reports.status, status as ReportStatus))
    .orderBy(asc(reports.createdAt), asc(reports.id))
    .limit(1000)
  const openHolds = rows.length
    ? await db
        .select({ reportId: holds.createdByReportId })
        .from(holds)
        .where(and(inArray(holds.createdByReportId, rows.map((r) => r.report.id)), isNull(holds.releasedAt)))
    : []
  const held = new Set(openHolds.map((h) => h.reportId))
  const groups = new Map<string, { first: ReportRow; rows: typeof rows }>()
  for (const r of rows) {
    const g = groups.get(r.report.targetKey) ?? { first: r.report, rows: [] }
    g.rows.push(r)
    groups.set(r.report.targetKey, g)
  }
  const labels = await targetLabels(db, [...groups.values()].map((g) => pointerOf(g.first)))
  const firsts = [...groups.values()].map((g) => g.first)
  const itemStatus = await communityItemStatuses(
    db,
    firsts.map((f) => f.communityPostId).filter((id): id is string => !!id),
    firsts.map((f) => f.communityCommentId).filter((id): id is string => !!id),
  )
  const out = [...groups.values()].map(({ first, rows: members }) => {
    const reasons: OperatorReportGroupDto['reasons'] = {}
    for (const m of members) reasons[m.report.reason] = (reasons[m.report.reason] ?? 0) + 1
    const assigned = members.find((m) => m.report.assignedTo)
    const autoHiddenAts = members.map((m) => m.report.autoHiddenAt).filter((d): d is Date => !!d)
    const firstActions = members.map((m) => m.report.firstActionAt).filter((d): d is Date => !!d)
    const closedAt = isReportOpen(first.status) ? null : (members.map((m) => m.report.closedAt).find((d) => !!d) ?? null)
    const sla = reportGroupSla(
      { firstReportedAt: members[0]!.report.createdAt, autoHiddenAt: autoHiddenAts.length ? new Date(Math.min(...autoHiddenAts.map((d) => d.getTime()))) : null },
      targets,
      now,
      closedAt,
    )
    const firstActionAt = firstActions.length ? new Date(Math.min(...firstActions.map((d) => d.getTime()))) : null
    return {
      reportId: first.id,
      targetType: first.targetType,
      targetLabel: labels.get(first.targetKey) ?? '',
      count: members.length,
      reasons,
      firstReportedAt: members[0]!.report.createdAt.toISOString(),
      lastReportedAt: members[members.length - 1]!.report.createdAt.toISOString(),
      status: first.status,
      assignee: assigned ? { userId: assigned.report.assignedTo!, displayName: assigned.assigneeName ?? '' } : null,
      hold: members.some((m) => held.has(m.report.id)),
      autoHidden: itemStatus.get(first.communityCommentId ?? first.communityPostId ?? '') === 'auto_hidden',
      sla: {
        priority: sla.priority,
        startedAt: sla.startedAt.toISOString(),
        dueAt: sla.dueAt.toISOString(),
        targetHours: sla.targetHours,
        ageSeconds: sla.ageSeconds,
        state: sla.state,
        firstActionSeconds: firstActionAt ? Math.max(0, Math.floor((firstActionAt.getTime() - members[0]!.report.createdAt.getTime()) / 1000)) : null,
        resolutionSeconds: closedAt ? Math.max(0, Math.floor((closedAt.getTime() - members[0]!.report.createdAt.getTime()) / 1000)) : null,
      },
    }
  })
  if (!isReportOpen(status as ReportStatus)) out.reverse()
  // 임시 숨김(C-06)은 우선 검토: 맨 앞(그 안에서는 오래된 것부터). 숨김 시각은 있는데 지금 상태를 못 읽은 묶음(글이 지워짐 등)도 우선순위로 봅니다.
  // 정렬은 안정적이라 나머지 순서는 그대로입니다.
  else out.sort((a, b) => Number(b.autoHidden || b.sla.priority === 'auto_hidden') - Number(a.autoHidden || a.sla.priority === 'auto_hidden'))
  return (overdueOnly ? out.filter((g) => g.sla.state === 'overdue') : out).slice(0, 100)
}

// ── 상세 ─────────────────────────────────────────────────────────────────

const toReportDto = (r: ReportRow): OperatorReportDto => ({
  id: r.id,
  reason: r.reason,
  details: r.details,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  closedAt: r.closedAt?.toISOString() ?? null,
})

async function contentFor(db: DbExecutor, report: ReportRow, now: Date): Promise<{ content: OperatorTargetContentDto; publicPath: string | null; servedNow: boolean }> {
  const unavailable = (message: string) => ({ kind: 'unavailable' as const, message })
  switch (report.targetType) {
    case 'publication':
    case 'publication_item': {
      const [row] = await db
        .select({ release: publicationCandidates, slug: publications.slug })
        .from(publicationCandidates)
        .innerJoin(publications, eq(publications.id, publicationCandidates.publicationId))
        .where(eq(publicationCandidates.id, report.releaseId!))
        .limit(1)
      if (!row) return { content: unavailable('신고한 공개 버전을 찾을 수 없습니다.'), publicPath: null, servedNow: false }
      const hidden = await db
        .select({ kind: releaseHiddenItems.itemKind, key: releaseHiddenItems.itemKey })
        .from(releaseHiddenItems)
        .where(and(eq(releaseHiddenItems.publicationId, report.publicationId!), isNull(releaseHiddenItems.liftedAt)))
      const served = await loadServedRelease(db, row.slug, now)
      const itemVisible =
        !!served &&
        (report.targetType === 'publication' ||
          (report.itemKind === 'log'
            ? served.snapshot.logs.some((l) => l.key === report.itemKey)
            : report.itemKind === 'claim'
              ? served.snapshot.claims.some((c) => c.key === report.itemKey)
              : served.snapshot.artifacts.some((a) => a.artifactVersionId === report.itemKey)))
      return {
        content: {
          kind: 'release',
          releaseVersion: row.release.releaseNo ?? 0,
          // 신고 때 제공하던 release의 저장된 스냅샷(공개됐던 내용) 그대로. 비공개 작업 테이블은 읽지 않습니다.
          snapshot: row.release.snapshot as unknown as PublicSnapshot,
          focus: report.itemKind && report.itemKey ? { kind: report.itemKind, key: report.itemKey } : null,
          hiddenKeys: hidden.map((h) => `${h.kind}:${h.key}`),
        },
        publicPath: served ? `/p/${row.slug}` : null,
        servedNow: itemVisible,
      }
    }
    case 'senior_note': {
      const [note] = await db.select().from(seniorNotes).where(eq(seniorNotes.id, report.seniorNoteId!)).limit(1)
      const wasPublic = !!note && (note.status === 'published' || note.status === 'hidden') && note.version === report.noteVersion && !!note.publishedAt
      return {
        content: wasPublic
          ? { kind: 'senior_note', note: toPublicSeniorNote(note!, { meToo: 0, helped: 0 }) }
          : unavailable('신고 이후 노트가 고쳐지거나 내려가 신고 때 공개된 글을 볼 수 없습니다.'),
        publicPath: note?.status === 'published' ? publicNotePath(note.courseId, note.id) : null,
        servedNow: note?.status === 'published',
      }
    }
    case 'course_qa': {
      // 막힘 Q&A(C-09): 아카이브 쪽 복사본만 읽습니다(커뮤니티 원 글은 열지 않음). 당사자가 철회했으면 글이 비었을 수 있음.
      const [qa] = await db.select().from(courseQaItems).where(eq(courseQaItems.id, report.courseQaItemId!)).limit(1)
      if (!qa || qa.status === 'withdrawn') return { content: unavailable('당사자가 막힘 Q&A를 철회했습니다.'), publicPath: null, servedNow: false }
      return {
        content: { kind: 'course_qa', qa: toPublicCourseQa(qa, { meToo: 0, helped: 0 }), status: qa.status },
        publicPath: qa.status === 'published' ? publicQaPath(qa.courseId, qa.id) : null,
        servedNow: qa.status === 'published',
      }
    }
    case 'case_study': {
      const [row] = await loadCaseStudiesWithRelease(db, eq(caseStudies.id, report.caseStudyId!), now)
      const cs = row?.caseStudy
      const wasPublic = !!row && (cs!.status === 'published' || cs!.hiddenAt !== null) && cs!.version === report.caseStudyVersion && row.servable
      const [owner] = cs ? await db.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, cs.userId)).limit(1) : []
      if (!wasPublic) {
        return { content: unavailable('신고 이후 케이스 스터디가 고쳐지거나 내려가 신고 때 공개된 글을 볼 수 없습니다.'), publicPath: null, servedNow: false }
      }
      const sections = (await loadSections(db, [cs!])).get(cs!.id) ?? []
      const snapshot = asCaseSnapshot(row!.snapshot)
      return {
        content: {
          kind: 'case_study',
          title: cs!.title,
          sections: sections
            .filter((s) => s.sentences.length > 0)
            .map((s) => ({
              key: s.key,
              label: CASE_SECTION_LABELS[s.key],
              sentences: s.sentences.map((x) => ({ text: x.text, citations: x.citations.map((c) => citationLabel(snapshot, c) ?? `${c.kind}:${c.key}`) })),
            })),
        },
        publicPath: owner && isPubliclyVisible(row!) ? `/u/${owner.handle}` : null,
        servedNow: isPubliclyVisible(row!),
      }
    }
    case 'community_space': {
      // 공간 정보만(이름·소개·종류·상태·멤버 수). 게시판·멤버 목록·글은 운영자에게도 싣지 않습니다(C-02, ADR 0019).
      const space = report.communitySpaceId ? await operatorSpaceContent(db, report.communitySpaceId) : null
      if (!space) return { content: unavailable('공간을 찾을 수 없습니다.'), publicPath: null, servedNow: false }
      return { content: { kind: 'community_space', space }, publicPath: null, servedNow: space.status === 'active' }
    }
    case 'community_post':
    case 'community_comment': {
      // 신고된 글·댓글 하나만(지금 행, 가린 것도 본문 포함). 작성자 id는 없고 익명은 `익명`입니다(작성자 확인은 C-06의 사유 기록 경로, ADR 0022).
      const item = await operatorCommunityItem(db, { postId: report.communityPostId, commentId: report.communityCommentId })
      if (!item) return { content: unavailable('글을 찾을 수 없습니다.'), publicPath: null, servedNow: false }
      return { content: { kind: report.targetType, item }, publicPath: null, servedNow: item.status === 'published' }
    }
    case 'community_recruitment':
    case 'community_application': {
      // 신고된 모집 글 또는 지원 메시지 하나만(C-07). 모집자·지원자 id·지원자 목록은 싣지 않습니다(ADR 0024).
      const recruitmentItem = await operatorRecruitmentItem(db, { recruitmentId: report.communityRecruitmentId, applicationId: report.communityApplicationId })
      if (!recruitmentItem) return { content: unavailable('모집 글을 찾을 수 없습니다.'), publicPath: null, servedNow: false }
      return { content: { kind: report.targetType, recruitmentItem }, publicPath: null, servedNow: !recruitmentItem.hidden }
    }
    case 'profile': {
      const [row] = await db
        .select({ displayName: users.displayName, status: users.status, profile: profiles })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(eq(profiles.userId, report.profileUserId!))
        .limit(1)
      if (!row) return { content: unavailable('프로필을 찾을 수 없습니다.'), publicPath: null, servedNow: false }
      const served = row.status === 'active' && row.profile.hiddenAt === null
      return {
        // 공개 프로필 DTO와 같은 허용 목록(이메일·id 없음).
        content: { kind: 'profile', profile: toPublicProfileDto(row, row.profile) },
        publicPath: served ? `/u/${row.profile.handle}` : null,
        servedNow: served,
      }
    }
    // S-07: 신고된 페르소나 자신의 handle·이름·내용만(다른 페르소나·연결·계정 없음, 주인 확인은 personas.ts의 사유 기록 경로).
    case 'persona':
    case 'profile_post':
    case 'social_link':
      return personaReportContent(db, report)
    // A-06: 수료 회고 하나(지금 행, 숨긴 것도 내용 포함). 작성자 id는 없습니다(당사자 안내는 조치 경로가 author_id로 함).
    case 'completion_retro': {
      const loaded = report.completionRetroId ? await loadRetroForOperator(db, report.completionRetroId) : null
      if (!loaded || loaded.status === 'withdrawn') return { content: unavailable('작성자가 회고를 철회했습니다.'), publicPath: null, servedNow: false }
      return { content: { kind: 'completion_retro', retro: loaded.dto, status: loaded.status }, publicPath: null, servedNow: loaded.status === 'published' }
    }
  }
}

async function actionsFor(db: DbExecutor, targetKey: string): Promise<OperatorActionDto[]> {
  const rows = await db
    .select({ action: moderationActions, appeal: appeals, creator: users.displayName })
    .from(moderationActions)
    .leftJoin(appeals, eq(appeals.actionId, moderationActions.id))
    .innerJoin(users, eq(users.id, moderationActions.createdBy))
    .where(eq(moderationActions.targetKey, targetKey))
    .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
  return rows.map(({ action: a, appeal, creator }) => ({
    id: a.id,
    kind: a.kind,
    outcome: a.outcome as OperatorActionDto['outcome'],
    internalNote: a.internalNote,
    publicReason: a.publicReason,
    notifyOwner: a.notifyOwner,
    createdAt: a.createdAt.toISOString(),
    createdBy: creator,
    reversedAt: a.reversedAt?.toISOString() ?? null,
    reverseCause: (a.reverseCause as OperatorActionDto['reverseCause']) ?? null,
    reverseNote: a.reverseNote,
    appeal: appeal
      ? { id: appeal.id, status: appeal.status, message: appeal.message, createdAt: appeal.createdAt.toISOString(), decisionNote: appeal.decisionNote }
      : null,
  }))
}

async function loadReport(db: DbExecutor, reportId: unknown, lock = false): Promise<ReportRow> {
  if (!isUuid(reportId)) throw notFound()
  const query = db.select().from(reports).where(eq(reports.id, reportId.toLowerCase())).limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

async function detail(db: DbExecutor, report: ReportRow, now: Date): Promise<OperatorReportDetailDto> {
  const siblings = await db.select().from(reports).where(eq(reports.targetKey, report.targetKey)).orderBy(desc(reports.createdAt), desc(reports.id)).limit(200)
  const [labels, { content, publicPath, servedNow }, actions] = await Promise.all([
    targetLabels(db, [pointerOf(report)]),
    contentFor(db, report, now),
    actionsFor(db, report.targetKey),
  ])
  const holdRows = await db
    .select()
    .from(holds)
    .where(inArray(holds.createdByReportId, siblings.map((s) => s.id)))
    .orderBy(desc(holds.createdAt))
  const assignedRow = siblings.find((s) => isReportOpen(s.status) && s.assignedTo) ?? (report.assignedTo ? report : undefined)
  const [assignee] = assignedRow?.assignedTo
    ? await db.select({ userId: users.id, displayName: users.displayName }).from(users).where(eq(users.id, assignedRow.assignedTo)).limit(1)
    : []
  const [publication] = report.publicationId
    ? await db.select({ id: publications.id, status: publications.status }).from(publications).where(eq(publications.id, report.publicationId)).limit(1)
    : []
  return {
    report: toReportDto(report),
    targetType: report.targetType,
    targetLabel: labels.get(report.targetKey) ?? '',
    publicPath,
    servedNow,
    publication: publication ?? null,
    content,
    reports: siblings.map(toReportDto),
    assignee: assignee ?? null,
    holds: holdRows.map((h) => ({ reason: h.reason, createdAt: h.createdAt.toISOString(), releasedAt: h.releasedAt?.toISOString() ?? null })),
    actions,
    allowedActions: [...ACTIONS_BY_TARGET[report.targetType]],
  }
}

/** GET /operator/reports/:id */
export async function getReportDetail(db: DbExecutor, actor: Actor, reportId: unknown, now = new Date()): Promise<OperatorReportDetailDto> {
  await requireOperator(db, actor)
  return detail(db, await loadReport(db, reportId), now)
}

// ── 담당·처리·기각 ───────────────────────────────────────────────────────

/** 같은 대상의 처리 전 신고들을 잠가 읽습니다(이 신고 포함). */
async function lockOpenGroup(tx: DbExecutor, report: ReportRow): Promise<ReportRow[]> {
  return tx
    .select()
    .from(reports)
    .where(and(eq(reports.targetKey, report.targetKey), inArray(reports.status, ['open', 'in_review'])))
    .orderBy(asc(reports.createdAt))
    .for('update')
}

/** POST /operator/reports/:id/assign — 나에게 배정(같은 대상의 처리 전 신고 모두 in_review). 닫힌 신고 409 already_closed. */
export async function assignReport(db: DbExecutor, actor: Actor, reportId: unknown, now = new Date()): Promise<OperatorReportDetailDto> {
  await requireOperator(db, actor)
  return db.transaction(async (tx) => {
    const report = await loadReport(tx, reportId, true)
    if (!isReportOpen(report.status)) throw conflict('already_closed')
    const group = await lockOpenGroup(tx, report)
    await tx
      .update(reports)
      .set({ status: 'in_review', assignedTo: actor.userId, assignedAt: now, firstActionAt: firstActionSql(now) })
      .where(inArray(reports.id, group.map((r) => r.id)))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'report.assign',
      targetType: 'report',
      targetId: report.id,
      metadata: { reports: group.length, targetType: report.targetType },
    })
    return detail(tx, await loadReport(tx, report.id), now)
  })
}

async function closeGroup(
  tx: DbExecutor,
  actor: Actor,
  report: ReportRow,
  input: { kind: (typeof MODERATION_ACTION_KINDS)[number]; outcome: 'resolved' | 'dismissed'; note: string; publicReason: string | null; notifyOwner: boolean },
  now: Date,
): Promise<void> {
  if (!isReportOpen(report.status)) throw conflict('already_closed')
  if (!isActionApplicable(report.targetType, input.kind)) throw invalid({ action: 'not_applicable' })
  const group = await lockOpenGroup(tx, report)
  const target: TargetPointer = pointerOf(report)
  const action = await applyModeration(
    tx,
    actor.userId,
    target,
    { kind: input.kind, outcome: input.outcome, internalNote: input.note, publicReason: input.publicReason, notifyOwner: input.notifyOwner },
    now,
  )
  const ids = group.map((r) => r.id)
  await tx
    .update(reports)
    .set({ status: input.outcome, actionId: action.id, closedAt: now, firstActionAt: firstActionSql(now) })
    .where(inArray(reports.id, ids))
  const released = await tx
    .update(holds)
    .set({ releasedAt: now, releasedBy: actor.userId })
    .where(and(inArray(holds.createdByReportId, ids), isNull(holds.releasedAt)))
    .returning({ id: holds.id })
  await recordAudit(tx, {
    actorId: actor.userId,
    action: input.outcome === 'resolved' ? 'report.resolve' : 'report.dismiss',
    targetType: 'report',
    targetId: report.id,
    metadata: { actionId: action.id, kind: input.kind, reports: ids.length, holdsReleased: released.length, targetType: report.targetType },
  })
}

/** POST /operator/reports/:id/resolve {action, note, publicReason?, notifyOwner} — 200 + 상세. 409 already_closed·target_not_public, 422. */
export async function resolveReport(db: DbExecutor, actor: Actor, reportId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorReportDetailDto> {
  await requireOperator(db, actor)
  const input = parseInput(resolveSchema, rawInput)
  return db.transaction(async (tx) => {
    const report = await loadReport(tx, reportId, true)
    await closeGroup(tx, actor, report, { kind: input.action, outcome: 'resolved', note: input.note, publicReason: input.publicReason, notifyOwner: input.notifyOwner }, now)
    return detail(tx, await loadReport(tx, report.id), now)
  })
}

/** POST /operator/reports/:id/dismiss {note} — 기각(조치 없음). 보류를 풉니다. */
export async function dismissReport(db: DbExecutor, actor: Actor, reportId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorReportDetailDto> {
  await requireOperator(db, actor)
  const input = parseInput(noteOnlySchema, rawInput)
  return db.transaction(async (tx) => {
    const report = await loadReport(tx, reportId, true)
    await closeGroup(tx, actor, report, { kind: 'none', outcome: 'dismissed', note: input.note, publicReason: null, notifyOwner: false }, now)
    return detail(tx, await loadReport(tx, report.id), now)
  })
}

/**
 * POST /operator/publications/:id/lift-restriction {note} — restricted → draft. 제한 조치를 되돌림(lift)으로 기록합니다.
 * 제한 상태가 아니면 409 not_restricted. owner는 새 후보를 만들고 당사자 동의를 다시 받아 게시해야 합니다.
 */
export async function liftRestriction(
  db: DbExecutor,
  actor: Actor,
  publicationId: unknown,
  rawInput: unknown,
  now = new Date(),
): Promise<{ publicationId: string; status: string }> {
  await requireOperator(db, actor)
  const input = parseInput(noteOnlySchema, rawInput)
  if (!isUuid(publicationId)) throw notFound()
  return db.transaction(async (tx) => {
    const publication = await lockPublication(tx, publicationId.toLowerCase())
    if (publication.status !== 'restricted') throw conflict('not_restricted')
    const [action] = await tx
      .select({ id: moderationActions.id })
      .from(moderationActions)
      .where(and(eq(moderationActions.publicationId, publication.id), eq(moderationActions.kind, 'restrict'), isNull(moderationActions.reversedAt)))
      .orderBy(desc(moderationActions.createdAt))
      .limit(1)
    if (!action) throw conflict('not_restricted')
    await undoModeration(tx, action.id, actor.userId, input.note, 'lift', now)
    const [after] = await tx.select({ status: publications.status }).from(publications).where(eq(publications.id, publication.id)).limit(1)
    return { publicationId: publication.id, status: after!.status }
  })
}

// ── 이의제기 ─────────────────────────────────────────────────────────────

async function appealDtos(db: DbExecutor, where: ReturnType<typeof eq> | undefined): Promise<OperatorAppealDto[]> {
  const rows = await db
    .select({ appeal: appeals, action: moderationActions })
    .from(appeals)
    .innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId))
    .where(where)
    .orderBy(asc(appeals.createdAt), asc(appeals.id))
    .limit(100)
  const labels = await targetLabels(db, rows.map((r) => pointerOf(r.action)))
  const reportRows = rows.length
    ? await db.select({ id: reports.id, actionId: reports.actionId }).from(reports).where(inArray(reports.actionId, rows.map((r) => r.action.id)))
    : []
  const reportBy = new Map(reportRows.map((r) => [r.actionId, r.id]))
  return rows.map(({ appeal, action }) => ({
    id: appeal.id,
    status: appeal.status,
    message: appeal.message,
    createdAt: appeal.createdAt.toISOString(),
    decidedAt: appeal.decidedAt?.toISOString() ?? null,
    decisionNote: appeal.decisionNote,
    action: {
      id: action.id,
      kind: action.kind,
      targetType: action.targetType,
      targetLabel: labels.get(action.targetKey) ?? '',
      publicReason: action.publicReason,
      internalNote: action.internalNote,
      createdAt: action.createdAt.toISOString(),
      reversedAt: action.reversedAt?.toISOString() ?? null,
    },
    reportId: reportBy.get(action.id) ?? null,
  }))
}

/** GET /operator/appeals?status=open|upheld|reversed(기본 open). */
export async function listAppeals(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>): Promise<OperatorAppealDto[]> {
  await requireOperator(db, actor)
  const status = statusOf(rawQuery.status, 'open')
  if (!['open', 'upheld', 'reversed'].includes(status)) throw invalid({ status: 'invalid' })
  return appealDtos(db, eq(appeals.status, status as 'open'))
}

/** POST /operator/appeals/:id/decide {decision, note} — 유지 또는 되돌림(조치를 풂). 이미 결정됨 409 already_decided. */
export async function decideAppeal(db: DbExecutor, actor: Actor, appealId: unknown, rawInput: unknown, now = new Date()): Promise<OperatorAppealDto> {
  await requireOperator(db, actor)
  const input = parseInput(decideAppealSchema, rawInput)
  if (!isUuid(appealId)) throw notFound()
  return db.transaction(async (tx) => {
    const [appeal] = await tx.select().from(appeals).where(eq(appeals.id, appealId.toLowerCase())).limit(1).for('update')
    if (!appeal) throw notFound()
    const next = appealTransition(appeal.status, input.decision)
    if (!next) throw conflict('already_decided')
    if (input.decision === 'reverse') await undoModeration(tx, appeal.actionId, actor.userId, input.note, 'appeal', now)
    await tx.update(appeals).set({ status: next, decidedBy: actor.userId, decidedAt: now, decisionNote: input.note }).where(eq(appeals.id, appeal.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'appeal.decide',
      targetType: 'appeal',
      targetId: appeal.id,
      metadata: { actionId: appeal.actionId, decision: input.decision },
    })
    const [dto] = await appealDtos(tx, eq(appeals.id, appeal.id))
    return dto!
  })
}

// ── 감사 ─────────────────────────────────────────────────────────────────

/**
 * 페르소나 주인이 자기 페르소나에 한 일의 감사 행(S-07, ADR 0036). 이 행들의 행위자는 페르소나 주인 사용자이므로, 운영자가 조치 id → 페르소나·링크 id →
 * 이 행의 행위자로 따라가면 주인 확인(사유 기록) 없이 표시명 페르소나의 계정을 알 수 있습니다. 감사 조회에서는 행위자를 비웁니다(행 자체는 남음).
 */
const OWNER_SELF_ACTION = /^(persona\.(create|update|identity_link_update|visibility_update|project_listing_update)|social_link\.|social\.(block|unblock))/

/** GET /operator/audit?target=<uuid> — 그 대상 id(또는 metadata의 actionId·reportId·publicationId)의 감사 기록, 최근 것부터 200개. 페르소나 주인의 자기 행동은 행위자를 비웁니다. */
export async function listAudit(db: DbExecutor, actor: Actor, rawQuery: Record<string, unknown>): Promise<OperatorAuditEventDto[]> {
  await requireOperator(db, actor)
  if (!isUuid(rawQuery.target)) throw invalid({ target: rawQuery.target === undefined ? 'required' : 'invalid' })
  const target = rawQuery.target.toLowerCase()
  const rows = await db
    .select()
    .from(auditEvents)
    .where(
      or(
        eq(auditEvents.targetId, target),
        sql`${auditEvents.metadata}->>'actionId' = ${target}`,
        sql`${auditEvents.metadata}->>'publicationId' = ${target}`,
      ),
    )
    .orderBy(desc(auditEvents.at), desc(auditEvents.id))
    .limit(200)
  return rows.map((r) => ({
    id: r.id,
    actorId: OWNER_SELF_ACTION.test(r.action) ? null : r.actorId,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    metadata: r.metadata,
    at: r.at.toISOString(),
  }))
}
