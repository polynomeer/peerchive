/**
 * 탈퇴 계정 정리(purge)와 삭제 장부(T-16, SYSTEM_DESIGN §1-7·§6.6·§11, ADR 0016).
 *
 * 탈퇴 요청(T-02)은 계정을 deleted로 바꾸고 세션을 끊기만 합니다. 유예 기간(기본 7일)이 지나면 이 작업이 한 트랜잭션에서 정리합니다.
 *
 * 지우는 것(그 사람만의 자료): 프로필, 세션, 로그인 수단, 그 주소의 매직링크 토큰, 외부 연동(디스코드 id), 학교 메일 인증·인증 코드(C-01),
 * 커뮤니티 멤버십·그 사람이 만들거나 쓴 공간 초대·공식 페이지 개설 요청(C-02, 방장이었으면 먼저 승계: 가장 오래된 admin → 멤버, 없으면 방 보관), 디스코드 코드·📌 요청,
 * 주간 체크인(모든 과제), 유용성 신호, 선배 노트(철회 + 삭제), 케이스 스터디·포트폴리오 판, 분석 이벤트, 업로드 의도,
 * **혼자만 쓴 과제 전체**(다른 사람이 멤버였던 적 없는 과제: 로그·할 일·마일스톤·선언·체크인·디스코드 연결·파일과 저장소 파일·공개·후보).
 *
 * 남기는 것(팀 기록): 다른 사람이 멤버였던 과제의 로그·역할 선언·파일·할 일은 지우지 않습니다(조용히 지우면 팀 이력과 동료의 확인·근거가
 * 깨짐). 작성자 표시는 users 행의 이름을 "탈퇴한 사용자"로 바꿔 가명 처리하고, 그 사람이 남의 기록에 쓴 메모 글(확인 메모·동의 메모·
 * 신고 설명·이의제기 글)은 지웁니다. 멤버십은 removed, owner였으면 남은 active 멤버(editor → reviewer → viewer, 먼저 들어온 순)에게 넘깁니다.
 *
 * 공개: 그 사람이 당사자인 지금 게시 중인 release는 동의 철회와 같은 방식으로 철회합니다(consent revoked, 공개 withdrawn, access_epoch +1,
 * outbox `publication.withdrawn`). 팀은 기존 규칙대로 철회한 사람을 뺀 새 후보(exclude-declined)를 만들 수 있고, 게시 판정은 탈퇴 계정의
 * 동의를 무효로 봅니다(subject_inactive). 운영 기록(신고·조치·다른 사람의 포크)이 가리키는 공개·노트·케이스·과제는 내용을 비운 묘비 행으로 남깁니다.
 *
 * 장부: 지운 종류마다 deletion_ledger 한 행(subject_hash = HMAC(삭제 pepper, 사용자 id), 종류, 개수, 요청·정리 시각). 이름·이메일·id 목록은 없습니다.
 * 저장소 파일은 행을 지운 뒤 커밋 직전에 지웁니다(파일 삭제가 실패하면 트랜잭션 전체가 되돌아가 다음 주기에 다시 시도).
 */
import {
  PUBLICATION_WITHDRAWN_TOPIC,
  affiliationCodes,
  analyticsEvents,
  and,
  appeals,
  artifactVersions,
  artifacts,
  auditEvents,
  authAccounts,
  caseSentences,
  caseStudies,
  claimEvidence,
  communitySpaces,
  claimRevisions,
  competencyEvidence,
  consents,
  deletionLedger,
  discordChannelBindings,
  discordCodes,
  discordNotices,
  discordPinRequests,
  embargoes,
  endorsements,
  eq,
  hashSubject,
  inArray,
  institutionAffiliations,
  integrations,
  invitations,
  isNotNull,
  isNull,
  logEntries,
  logRevisionEvidence,
  logRevisions,
  lte,
  magicLinkTokens,
  milestoneSnapshots,
  milestones,
  moderationActions,
  ne,
  officialPageRequests,
  operators,
  or,
  outboxEvents,
  planForks,
  portfolioEditions,
  portfolioItems,
  profiles,
  projectMembers,
  projects,
  publicationCandidates,
  publications,
  reports,
  roleClaims,
  searchDocuments,
  seniorNotes,
  sessions,
  spaceInvitations,
  spaceMemberships,
  sql,
  tasks,
  uploadIntents,
  usefulnessSignals,
  users,
  weeklyCheckins,
  type DbExecutor,
  type PublicationOutboxPayload,
} from '@peerchive/db'
import { chooseOwnerSuccessor } from '@peerchive/domain'
import { cleanKeyFor, isObjectKey, type ObjectKey, type ObjectStorage } from '@peerchive/files'
import type { TaskOutcome } from './cleanup'

/** 가명 처리한 표시 이름. */
export const DELETED_DISPLAY_NAME = '탈퇴한 사용자'
const SCRUBBED_TEXT = '[탈퇴한 사용자가 남긴 글은 지웠습니다]'
const TOMBSTONE_PROJECT_TITLE = '삭제된 과제'
const TOMBSTONE_CASE_TITLE = '삭제된 케이스 스터디'

export const purgedEmailFor = (userId: string) => `purged+${userId.toLowerCase()}@deleted.invalid`

export interface PurgeDeps {
  storage: ObjectStorage
  deletionPepper: string
  /** 웹과 같은 분석 pepper. 없으면 분석 이벤트 삭제를 건너뜁니다. */
  analyticsPepper: string | null
}

export interface PurgeOptions {
  now: Date
  /** purge: 유예 뒤 정리(status deleted 필요) / reapply: 복구 뒤 재적용(상태와 무관하게 다시 정리). */
  source: 'purge' | 'reapply'
}

/** 종류 → 개수(0인 종류는 없음). */
export type PurgeCounts = Record<string, number>

const SOLO_MEMBER_STATUSES = ['active', 'left', 'removed'] as const

class Counter {
  readonly counts: PurgeCounts = {}
  add(kind: string, n: number) {
    if (n > 0) this.counts[kind] = (this.counts[kind] ?? 0) + n
  }
  total(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0)
  }
}

const idsOf = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id)

/** PostgreSQL 외래 키 위반(23503)인지. */
function isForeignKeyViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: unknown }).code === '23503') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/**
 * 계정 하나 정리. 사용자가 없으면 null, source가 purge인데 deleted가 아니면 null(유예 중 복구 등은 하지 않음).
 * 같은 사용자를 다시 정리하면 지울 것이 없어 개수가 비고 장부 행도 생기지 않습니다(account 행은 처음 한 번).
 */
export async function purgeAccount(db: DbExecutor, deps: PurgeDeps, userId: string, options: PurgeOptions): Promise<PurgeCounts | null> {
  const { now } = options
  const objectKeys = new Set<ObjectKey>()
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for('update')
    if (!user) return null
    if (options.source === 'purge' && user.status !== 'deleted') return null
    const c = new Counter()
    const email = user.privateEmail.toLowerCase()

    // 1) 그 사람이 당사자인 지금 게시 중인 release: 동의 철회 + 공개 철회(웹의 동의 철회와 같은 결과).
    const live = await tx
      .select({ publicationId: publications.id, projectId: publications.projectId, consentId: consents.id })
      .from(consents)
      .innerJoin(publicationCandidates, eq(publicationCandidates.id, consents.candidateId))
      .innerJoin(publications, eq(publications.currentReleaseId, publicationCandidates.id))
      .where(and(eq(consents.subjectUserId, userId), eq(publications.status, 'published'), eq(publicationCandidates.status, 'published')))
    for (const row of live) {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, row.projectId)).limit(1).for('update')
      await tx.update(consents).set({ status: 'revoked', decidedAt: now }).where(eq(consents.id, row.consentId))
      if (await withdrawForDeletion(tx, row.publicationId, now)) c.add('publications_withdrawn', 1)
    }

    // 2) 그 사람만의 자료.
    c.add('sessions', (await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id })).length)
    const accounts = await tx.delete(authAccounts).where(eq(authAccounts.userId, userId)).returning({ provider: authAccounts.provider, accountId: authAccounts.providerAccountId })
    c.add('auth_accounts', accounts.length)
    const emails = [...new Set([email, ...accounts.filter((a) => a.provider === 'email').map((a) => a.accountId.toLowerCase())])]
    c.add('magic_link_tokens', (await tx.delete(magicLinkTokens).where(inArray(magicLinkTokens.email, emails)).returning({ id: magicLinkTokens.id })).length)
    c.add('profile', (await tx.delete(profiles).where(eq(profiles.userId, userId)).returning({ id: profiles.userId })).length)
    c.add('integrations', (await tx.delete(integrations).where(eq(integrations.userId, userId)).returning({ id: integrations.id })).length)
    // 학교 메일 인증(C-01): 코드 → 소속 순서(외래 키). 이력(학교·도메인·인증 시각)도 그 사람만의 자료라 남기지 않습니다.
    const affiliationIds = idsOf(await tx.select({ id: institutionAffiliations.id }).from(institutionAffiliations).where(eq(institutionAffiliations.userId, userId)))
    if (affiliationIds.length) {
      c.add('affiliation_codes', (await tx.delete(affiliationCodes).where(inArray(affiliationCodes.affiliationId, affiliationIds)).returning({ id: affiliationCodes.id })).length)
      c.add(
        'institution_affiliations',
        (await tx.delete(institutionAffiliations).where(inArray(institutionAffiliations.id, affiliationIds)).returning({ id: institutionAffiliations.id })).length,
      )
    }
    // 커뮤니티(C-02): 방장 자리를 넘긴 뒤(웹 succeedOwner와 같은 규칙) 멤버십·초대·개설 요청을 지웁니다. 공간 행(created_by)은 가명 처리된 users를 가리킨 채 남습니다.
    await purgeCommunity(tx, userId, c, now)
    c.add('discord_codes', (await tx.delete(discordCodes).where(eq(discordCodes.userId, userId)).returning({ id: discordCodes.id })).length)
    c.add(
      'discord_pin_requests',
      (
        await tx
          .delete(discordPinRequests)
          .where(or(eq(discordPinRequests.authorUserId, userId), eq(discordPinRequests.requesterUserId, userId)))
          .returning({ id: discordPinRequests.id })
      ).length,
    )
    c.add('checkins', (await tx.delete(weeklyCheckins).where(eq(weeklyCheckins.userId, userId)).returning({ id: weeklyCheckins.id })).length)
    c.add('signals', (await tx.delete(usefulnessSignals).where(eq(usefulnessSignals.userId, userId)).returning({ id: usefulnessSignals.id })).length)
    if (deps.analyticsPepper) {
      const actorHash = hashSubject(deps.analyticsPepper, userId)
      c.add('analytics_events', (await tx.delete(analyticsEvents).where(eq(analyticsEvents.actorHash, actorHash)).returning({ id: analyticsEvents.id })).length)
    }

    // 3) 포트폴리오 판·케이스 스터디.
    const editionIds = idsOf(await tx.select({ id: portfolioEditions.id }).from(portfolioEditions).where(eq(portfolioEditions.userId, userId)))
    const caseIds = idsOf(await tx.select({ id: caseStudies.id }).from(caseStudies).where(eq(caseStudies.userId, userId)))
    if (editionIds.length || caseIds.length) {
      const byEdition = editionIds.length ? inArray(competencyEvidence.editionId, editionIds) : sql`false`
      const byCase = caseIds.length ? inArray(competencyEvidence.caseStudyId, caseIds) : sql`false`
      await tx.delete(competencyEvidence).where(or(byEdition, byCase))
      await tx
        .delete(portfolioItems)
        .where(or(editionIds.length ? inArray(portfolioItems.editionId, editionIds) : sql`false`, caseIds.length ? inArray(portfolioItems.caseStudyId, caseIds) : sql`false`))
    }
    if (editionIds.length) c.add('portfolio_editions', (await tx.delete(portfolioEditions).where(inArray(portfolioEditions.id, editionIds)).returning({ id: portfolioEditions.id })).length)
    if (caseIds.length) {
      await tx.delete(caseSentences).where(inArray(caseSentences.caseStudyId, caseIds))
      const referenced = await referencedIds(tx, caseIds, 'case')
      const deletable = caseIds.filter((id) => !referenced.has(id))
      if (deletable.length) await tx.delete(caseStudies).where(inArray(caseStudies.id, deletable))
      if (referenced.size) {
        await tx
          .update(caseStudies)
          .set({ title: TOMBSTONE_CASE_TITLE, status: 'draft', publishedAt: null, unavailableAt: null, unavailableReason: null, updatedAt: now })
          .where(inArray(caseStudies.id, [...referenced]))
      }
      c.add('case_studies', caseIds.length)
    }

    // 4) 선배 노트: 철회 + 삭제(신고·조치가 가리키면 글을 비운 철회 행으로 남김).
    const noteIds = idsOf(await tx.select({ id: seniorNotes.id }).from(seniorNotes).where(eq(seniorNotes.authorId, userId)))
    if (noteIds.length) {
      await tx.delete(usefulnessSignals).where(inArray(usefulnessSignals.seniorNoteId, noteIds))
      await tx.delete(searchDocuments).where(inArray(searchDocuments.seniorNoteId, noteIds))
      const referenced = await referencedIds(tx, noteIds, 'note')
      const deletable = noteIds.filter((id) => !referenced.has(id))
      if (deletable.length) await tx.delete(seniorNotes).where(inArray(seniorNotes.id, deletable))
      if (referenced.size) {
        await tx
          .update(seniorNotes)
          .set({ answers: {}, displayNameSnapshot: null, termLabel: null, totalTimeBucket: null, status: 'withdrawn', withdrawnAt: now, updatedAt: now })
          .where(inArray(seniorNotes.id, [...referenced]))
      }
      c.add('senior_notes', noteIds.length)
    }

    // 5) 남의 기록에 쓴 메모 글.
    let notes = 0
    notes += (await tx.update(endorsements).set({ note: null }).where(and(eq(endorsements.endorserId, userId), isNotNull(endorsements.note))).returning({ id: endorsements.id })).length
    notes += (await tx.update(consents).set({ note: null }).where(and(eq(consents.subjectUserId, userId), isNotNull(consents.note))).returning({ id: consents.id })).length
    notes += (await tx.update(reports).set({ details: null }).where(and(eq(reports.reporterId, userId), isNotNull(reports.details))).returning({ id: reports.id })).length
    notes += (await tx.update(appeals).set({ message: SCRUBBED_TEXT }).where(and(eq(appeals.appellantId, userId), ne(appeals.message, SCRUBBED_TEXT))).returning({ id: appeals.id })).length
    c.add('notes_scrubbed', notes)

    // 6) 과제: 혼자만 쓴 과제는 전체 삭제, 팀 과제는 멤버십만 정리.
    const memberOf = await tx.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, userId))
    const owned = await tx.select({ projectId: projects.id }).from(projects).where(eq(projects.ownerId, userId))
    const projectIds = [...new Set([...memberOf, ...owned].map((r) => r.projectId))].sort()
    for (const projectId of projectIds) {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1).for('update')
      const [others] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), ne(projectMembers.userId, userId), inArray(projectMembers.status, [...SOLO_MEMBER_STATUSES])))
      if ((others?.n ?? 0) === 0) await purgeSoloProject(tx, projectId, userId, c, objectKeys, now)
      else await leaveTeamProject(tx, projectId, userId, c, objectKeys, now)
    }

    // 7) 운영자 권한 회수, 사용자 행 가명 처리.
    await tx.update(operators).set({ revokedAt: now }).where(and(eq(operators.userId, userId), isNull(operators.revokedAt)))
    const pseudonymized = user.purgedAt === null || user.displayName !== DELETED_DISPLAY_NAME || user.privateEmail !== purgedEmailFor(userId) || user.status !== 'deleted'
    if (pseudonymized) {
      await tx
        .update(users)
        .set({
          displayName: DELETED_DISPLAY_NAME,
          privateEmail: purgedEmailFor(userId),
          status: 'deleted',
          deletionRequestedAt: user.deletionRequestedAt ?? now,
          purgedAt: user.purgedAt ?? now,
          analyticsOptOut: true,
          updatedAt: now,
        })
        .where(eq(users.id, userId))
      c.add('account', 1)
    }
    c.add('artifact_objects', objectKeys.size)

    // 8) 장부(개수만)·감사.
    const kinds = Object.keys(c.counts).sort()
    if (kinds.length) {
      const subjectHash = hashSubject(deps.deletionPepper, userId)
      const requestedAt = truncateToMinute(user.deletionRequestedAt ?? now)
      await tx.insert(deletionLedger).values(
        kinds.map((kind) => ({ subjectHash, entityKind: kind, count: c.counts[kind]!, requestedAt, purgedAt: now, source: options.source })),
      )
      await tx.insert(auditEvents).values({
        actorId: null,
        action: options.source === 'purge' ? 'account.purge' : 'account.purge_reapply',
        targetType: 'user',
        targetId: userId,
        metadata: { kinds: kinds.length, objects: objectKeys.size },
      })
    }

    // 9) 저장소 파일(커밋 직전). 실패하면 전체를 되돌려 다음에 다시 시도합니다.
    for (const key of objectKeys) await deps.storage.delete(key)
    return c.counts
  })
}

/** 커뮤니티 멤버십·초대·개설 요청 정리. 그 사람이 active owner인 방은 승계(없으면 보관)합니다. */
async function purgeCommunity(tx: DbExecutor, userId: string, c: Counter, now: Date): Promise<void> {
  const owned = await tx
    .select({ spaceId: spaceMemberships.spaceId })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.userId, userId), eq(spaceMemberships.role, 'owner'), eq(spaceMemberships.status, 'active')))
  for (const { spaceId } of owned.sort((a, b) => (a.spaceId < b.spaceId ? -1 : 1))) {
    await tx.select({ id: communitySpaces.id }).from(communitySpaces).where(eq(communitySpaces.id, spaceId)).limit(1).for('update')
    // 떠나는 owner를 먼저 내립니다(active owner unique).
    await tx
      .update(spaceMemberships)
      .set({ status: 'left', role: 'member', endedAt: now, updatedAt: now })
      .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.userId, userId)))
    const members = await tx
      .select({ userId: spaceMemberships.userId, role: spaceMemberships.role, status: spaceMemberships.status, joinedAt: spaceMemberships.joinedAt })
      .from(spaceMemberships)
      .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.status, 'active')))
    const successorId = chooseOwnerSuccessor(members, userId)
    if (successorId) {
      await tx
        .update(spaceMemberships)
        .set({ role: 'owner', updatedAt: now })
        .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.userId, successorId)))
      await tx.insert(auditEvents).values({ actorId: null, action: 'community.owner_succession', targetType: 'community_space', targetId: spaceId, metadata: { reason: 'account_deleted' } })
      c.add('space_owner_transfers', 1)
    } else {
      await tx.update(communitySpaces).set({ status: 'archived', archivedAt: now, updatedAt: now }).where(and(eq(communitySpaces.id, spaceId), eq(communitySpaces.status, 'active')))
      await tx
        .update(spaceMemberships)
        .set({ status: 'left', endedAt: now, updatedAt: now })
        .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.status, 'pending')))
      await tx
        .update(spaceInvitations)
        .set({ revokedAt: now })
        .where(and(eq(spaceInvitations.spaceId, spaceId), isNull(spaceInvitations.revokedAt), isNull(spaceInvitations.usedAt)))
      await tx.insert(auditEvents).values({ actorId: null, action: 'community.space_archive', targetType: 'community_space', targetId: spaceId, metadata: { cause: 'no_successor', reason: 'account_deleted' } })
      c.add('spaces_archived', 1)
    }
  }
  c.add('space_memberships', (await tx.delete(spaceMemberships).where(eq(spaceMemberships.userId, userId)).returning({ id: spaceMemberships.id })).length)
  c.add(
    'space_invitations',
    (await tx.delete(spaceInvitations).where(or(eq(spaceInvitations.createdBy, userId), eq(spaceInvitations.usedBy, userId))).returning({ id: spaceInvitations.id })).length,
  )
  c.add('official_page_requests', (await tx.delete(officialPageRequests).where(eq(officialPageRequests.requesterId, userId)).returning({ id: officialPageRequests.id })).length)
  // 운영자가 학생회 요청으로 표시한 기록의 표시자만 지웁니다(요청은 남의 것).
  await tx.update(officialPageRequests).set({ sourceMarkedBy: null }).where(eq(officialPageRequests.sourceMarkedBy, userId))
}

const truncateToMinute = (date: Date) => new Date(Math.floor(date.getTime() / 60_000) * 60_000)

/** 신고·조치가 가리키는 케이스/노트 id(지우면 운영 기록이 깨지므로 묘비로 남김). */
async function referencedIds(tx: DbExecutor, ids: string[], kind: 'case' | 'note'): Promise<Set<string>> {
  const reportCol = kind === 'case' ? reports.caseStudyId : reports.seniorNoteId
  const actionCol = kind === 'case' ? moderationActions.caseStudyId : moderationActions.seniorNoteId
  const fromReports = await tx.select({ id: reportCol }).from(reports).where(inArray(reportCol, ids))
  const fromActions = await tx.select({ id: actionCol }).from(moderationActions).where(inArray(actionCol, ids))
  return new Set([...fromReports, ...fromActions].map((r) => r.id).filter((id): id is string => typeof id === 'string'))
}

/** 게시 중인 공개를 철회합니다(웹 withdrawInTx와 같은 결과, 감사 actor 없음). 게시 중이 아니면 false. */
async function withdrawForDeletion(tx: DbExecutor, publicationId: string, now: Date): Promise<boolean> {
  const [publication] = await tx.select().from(publications).where(eq(publications.id, publicationId)).limit(1).for('update')
  if (!publication || publication.status !== 'published') return false
  const accessEpoch = publication.accessEpoch + 1
  await tx
    .update(publications)
    .set({ status: 'withdrawn', accessEpoch, withdrawnAt: now, withdrawCause: 'consent_revoked', withdrawNote: null, updatedAt: now })
    .where(eq(publications.id, publication.id))
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
    .where(and(eq(publicationCandidates.publicationId, publication.id), inArray(publicationCandidates.status, ['awaiting_consent', 'ready'])))
  await tx.insert(outboxEvents).values({
    topic: PUBLICATION_WITHDRAWN_TOPIC,
    payload: {
      publicationId: publication.id,
      projectId: publication.projectId,
      releaseId: publication.currentReleaseId!,
      releaseNo,
      accessEpoch,
      cause: 'consent_revoked',
    } satisfies PublicationOutboxPayload,
    createdAt: now,
  })
  await tx.insert(auditEvents).values({
    actorId: null,
    action: 'publication.withdraw',
    targetType: 'publication',
    targetId: publication.id,
    projectId: publication.projectId,
    metadata: { cause: 'consent_revoked', releaseNo, accessEpoch, reason: 'account_deleted' },
  })
  return true
}

/** 업로드 의도를 지우고, 버전이 이어받지 않은 격리 파일을 지울 목록에 넣습니다. */
async function dropUploadIntents(tx: DbExecutor, where: ReturnType<typeof eq>, objectKeys: Set<ObjectKey>): Promise<number> {
  const intents = await tx.delete(uploadIntents).where(where).returning({ key: uploadIntents.quarantineKey })
  const keys = intents.map((i) => i.key).filter(isObjectKey)
  if (keys.length) {
    const kept = new Set((await tx.select({ key: artifactVersions.objectKey }).from(artifactVersions).where(inArray(artifactVersions.objectKey, keys))).map((r) => r.key))
    for (const key of keys) if (!kept.has(key)) objectKeys.add(key)
  }
  return intents.length
}

/** 팀 과제: 멤버십 removed, owner면 넘기기, 그 사람이 만든 대기 초대 취소, 그 사람의 업로드 의도 삭제. 기록은 남깁니다. */
async function leaveTeamProject(tx: DbExecutor, projectId: string, userId: string, c: Counter, objectKeys: Set<ObjectKey>, now: Date) {
  c.add(
    'memberships',
    (
      await tx
        .update(projectMembers)
        .set({ status: 'removed', updatedAt: now })
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId), ne(projectMembers.status, 'removed')))
        .returning({ id: projectMembers.id })
    ).length,
  )
  const [project] = await tx.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1)
  if (project?.ownerId === userId) {
    const [successor] = await tx
      .select({ id: projectMembers.id, userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), ne(projectMembers.userId, userId), eq(projectMembers.status, 'active')))
      .orderBy(sql`case ${projectMembers.role} when 'owner' then 0 when 'editor' then 1 when 'reviewer' then 2 else 3 end`, projectMembers.createdAt)
      .limit(1)
    if (successor) {
      await tx.update(projectMembers).set({ role: 'owner', updatedAt: now }).where(eq(projectMembers.id, successor.id))
      await tx.update(projects).set({ ownerId: successor.userId, version: sql`${projects.version} + 1`, updatedAt: now }).where(eq(projects.id, projectId))
      await tx.insert(auditEvents).values({
        actorId: null,
        action: 'project.transfer_ownership',
        targetType: 'project',
        targetId: projectId,
        projectId,
        metadata: { reason: 'account_deleted' },
      })
      c.add('ownership_transfers', 1)
    }
  }
  c.add(
    'invitations_revoked',
    (
      await tx
        .update(invitations)
        .set({ revokedAt: now })
        .where(and(eq(invitations.projectId, projectId), eq(invitations.createdBy, userId), isNull(invitations.usedAt), isNull(invitations.revokedAt)))
        .returning({ id: invitations.id })
    ).length,
  )
  c.add('upload_intents', await dropUploadIntents(tx, and(eq(uploadIntents.projectId, projectId), eq(uploadIntents.userId, userId))!, objectKeys))
}

/**
 * 혼자만 쓴 과제 전체 삭제. 외래 키 순서대로 지우고, 마지막으로 공개·후보·과제 행을 savepoint 안에서 지웁니다.
 * 다른 사람의 포크·신고·조치가 공개를 가리켜 지울 수 없으면 내용을 비운 묘비(제목 "삭제된 과제", 스냅샷 {})로 남깁니다.
 */
async function purgeSoloProject(tx: DbExecutor, projectId: string, userId: string, c: Counter, objectKeys: Set<ObjectKey>, now: Date) {
  const before = c.total() + objectKeys.size
  const artifactIds = idsOf(await tx.select({ id: artifacts.id }).from(artifacts).where(eq(artifacts.projectId, projectId)))
  const versions = artifactIds.length
    ? await tx.select({ id: artifactVersions.id, key: artifactVersions.objectKey }).from(artifactVersions).where(inArray(artifactVersions.artifactId, artifactIds))
    : []
  for (const v of versions) {
    if (isObjectKey(v.key)) objectKeys.add(v.key)
    objectKeys.add(cleanKeyFor(v.id))
  }
  const versionIds = idsOf(versions)

  // 역할 선언·확인·근거
  const claimIds = idsOf(await tx.select({ id: roleClaims.id }).from(roleClaims).where(eq(roleClaims.projectId, projectId)))
  if (claimIds.length) {
    const revIds = idsOf(await tx.select({ id: claimRevisions.id }).from(claimRevisions).where(inArray(claimRevisions.claimId, claimIds)))
    if (revIds.length) {
      await tx.delete(endorsements).where(inArray(endorsements.claimRevisionId, revIds))
      await tx.delete(claimEvidence).where(inArray(claimEvidence.claimRevisionId, revIds))
    }
    await tx.update(roleClaims).set({ currentRevisionId: null }).where(inArray(roleClaims.id, claimIds))
    if (revIds.length) await tx.delete(claimRevisions).where(inArray(claimRevisions.id, revIds))
    c.add('claims', (await tx.delete(roleClaims).where(inArray(roleClaims.id, claimIds)).returning({ id: roleClaims.id })).length)
  }
  c.add('tasks', (await tx.delete(tasks).where(eq(tasks.projectId, projectId)).returning({ id: tasks.id })).length)
  await tx.delete(weeklyCheckins).where(eq(weeklyCheckins.projectId, projectId))

  // 디스코드 연결
  const bindingIds = idsOf(await tx.select({ id: discordChannelBindings.id }).from(discordChannelBindings).where(eq(discordChannelBindings.projectId, projectId)))
  if (bindingIds.length) {
    await tx.delete(discordPinRequests).where(inArray(discordPinRequests.bindingId, bindingIds))
    await tx.delete(discordNotices).where(inArray(discordNotices.bindingId, bindingIds))
    await tx.delete(discordChannelBindings).where(inArray(discordChannelBindings.id, bindingIds))
  }
  await tx.delete(discordCodes).where(eq(discordCodes.projectId, projectId))

  // 빌드 로그
  const entryIds = idsOf(await tx.select({ id: logEntries.id }).from(logEntries).where(eq(logEntries.projectId, projectId)))
  if (entryIds.length) {
    const revIds = idsOf(await tx.select({ id: logRevisions.id }).from(logRevisions).where(inArray(logRevisions.logEntryId, entryIds)))
    if (revIds.length) await tx.delete(logRevisionEvidence).where(inArray(logRevisionEvidence.logRevisionId, revIds))
    await tx.update(logEntries).set({ currentRevisionId: null }).where(inArray(logEntries.id, entryIds))
    if (revIds.length) await tx.delete(logRevisions).where(inArray(logRevisions.id, revIds))
    c.add('logs', (await tx.delete(logEntries).where(inArray(logEntries.id, entryIds)).returning({ id: logEntries.id })).length)
  }

  // 마일스톤
  const milestoneIds = idsOf(await tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.projectId, projectId)))
  if (milestoneIds.length) {
    await tx.delete(milestoneSnapshots).where(inArray(milestoneSnapshots.milestoneId, milestoneIds))
    c.add('milestones', (await tx.delete(milestones).where(inArray(milestones.id, milestoneIds)).returning({ id: milestones.id })).length)
  }

  // 파일
  c.add('upload_intents', await dropUploadIntents(tx, eq(uploadIntents.projectId, projectId), objectKeys))
  if (versionIds.length) {
    // 다른 과제가 이 버전을 가리킬 수 없지만(같은 과제만), 혹시 남은 스냅샷·근거 연결도 함께 지웁니다.
    await tx.delete(milestoneSnapshots).where(inArray(milestoneSnapshots.artifactVersionId, versionIds))
    await tx.delete(logRevisionEvidence).where(inArray(logRevisionEvidence.artifactVersionId, versionIds))
    c.add('artifact_versions', (await tx.delete(artifactVersions).where(inArray(artifactVersions.id, versionIds)).returning({ id: artifactVersions.id })).length)
  }
  if (artifactIds.length) c.add('artifacts', (await tx.delete(artifacts).where(inArray(artifacts.id, artifactIds)).returning({ id: artifacts.id })).length)

  await tx.delete(invitations).where(eq(invitations.projectId, projectId))
  await tx.delete(embargoes).where(eq(embargoes.projectId, projectId))
  await tx.delete(planForks).where(eq(planForks.targetProjectId, projectId))
  await tx.update(auditEvents).set({ projectId: null }).where(eq(auditEvents.projectId, projectId))

  // 공개·후보와 과제 행
  const [publication] = await tx.select({ id: publications.id }).from(publications).where(eq(publications.projectId, projectId)).limit(1)
  const candidateIds = publication
    ? idsOf(await tx.select({ id: publicationCandidates.id }).from(publicationCandidates).where(eq(publicationCandidates.publicationId, publication.id)))
    : []
  if (publication) {
    await tx.delete(searchDocuments).where(eq(searchDocuments.publicationId, publication.id))
    await tx.delete(usefulnessSignals).where(eq(usefulnessSignals.publicationId, publication.id))
  }
  try {
    await tx.transaction(async (sp) => {
      if (publication) {
        if (candidateIds.length) {
          await sp.delete(consents).where(inArray(consents.candidateId, candidateIds))
          await sp.update(publications).set({ currentReleaseId: null }).where(eq(publications.id, publication.id))
          await sp.update(publicationCandidates).set({ derivedFromId: null }).where(inArray(publicationCandidates.id, candidateIds))
          await sp.delete(publicationCandidates).where(inArray(publicationCandidates.id, candidateIds))
        }
        await sp.delete(publications).where(eq(publications.id, publication.id))
      }
      await sp.delete(projectMembers).where(eq(projectMembers.projectId, projectId))
      await sp.delete(projects).where(eq(projects.id, projectId))
    })
    c.add('solo_projects', 1)
  } catch (error) {
    if (!isForeignKeyViolation(error)) throw error
    // 운영 기록·다른 사람의 포크가 가리킴: 내용을 비운 묘비로 남깁니다(공개 조회는 published가 아니므로 404).
    // 이미 묘비면 바뀌는 행이 없어 개수도 늘지 않습니다(재적용 idempotent).
    let changed = c.total() + objectKeys.size > before
    if (publication && candidateIds.length) {
      const scrubbed = await tx
        .update(publicationCandidates)
        .set({ snapshot: {}, manifest: {}, selection: {}, refs: {}, checks: [], subjectDigests: {}, termLabel: null })
        .where(and(inArray(publicationCandidates.id, candidateIds), sql`(${publicationCandidates.snapshot} <> '{}'::jsonb or ${publicationCandidates.selection} <> '{}'::jsonb or ${publicationCandidates.termLabel} is not null)`))
        .returning({ id: publicationCandidates.id })
      const notes = await tx
        .update(consents)
        .set({ note: null })
        .where(and(inArray(consents.candidateId, candidateIds), isNotNull(consents.note)))
        .returning({ id: consents.id })
      await tx.update(publications).set({ withdrawNote: null }).where(and(eq(publications.id, publication.id), isNotNull(publications.withdrawNote)))
      changed ||= scrubbed.length + notes.length > 0
    }
    const tomb = await tx
      .update(projects)
      .set({ title: TOMBSTONE_PROJECT_TITLE, summaryByStudent: null, goal: null, constraints: null, updatedAt: now })
      .where(
        and(
          eq(projects.id, projectId),
          sql`(${projects.title} <> ${TOMBSTONE_PROJECT_TITLE} or ${projects.summaryByStudent} is not null or ${projects.goal} is not null or ${projects.constraints} is not null)`,
        ),
      )
      .returning({ id: projects.id })
    const left = await tx
      .update(projectMembers)
      .set({ status: 'removed', updatedAt: now })
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId), ne(projectMembers.status, 'removed')))
      .returning({ id: projectMembers.id })
    if (changed || tomb.length + left.length > 0) {
      c.add('solo_projects', 1)
      c.add('tombstones', 1)
    }
  }
}

/**
 * 유예 기간이 지난 탈퇴 계정을 정리합니다(주기 작업 `account-purge`). 계정마다 트랜잭션 하나이며, 실패한 계정은 다음 주기에 다시 시도합니다.
 */
export async function purgeDueAccounts(
  db: DbExecutor,
  deps: PurgeDeps,
  options: { now: Date; graceDays: number; limit: number },
): Promise<TaskOutcome> {
  const cutoff = new Date(options.now.getTime() - options.graceDays * 24 * 60 * 60 * 1000)
  const due = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, 'deleted'), isNull(users.purgedAt), isNotNull(users.deletionRequestedAt), lte(users.deletionRequestedAt, cutoff)))
    .orderBy(users.deletionRequestedAt)
    .limit(options.limit)
  let affected = 0
  let failed = 0
  for (const { id } of due) {
    try {
      if (await purgeAccount(db, deps, id, { now: options.now, source: 'purge' })) affected++
    } catch (error) {
      failed++
      console.error(`[worker] account purge failed (${(error as Error).name})`)
    }
  }
  return { affected, batches: 1, ...(failed > 0 && { failed }) }
}
