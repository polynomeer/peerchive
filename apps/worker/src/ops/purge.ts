/**
 * 탈퇴 계정 정리(purge)와 삭제 장부(T-16, SYSTEM_DESIGN §1-7·§6.6·§11, ADR 0016).
 *
 * 탈퇴 요청(T-02)은 계정을 deleted로 바꾸고 세션을 끊기만 합니다. 유예 기간(기본 7일)이 지나면 이 작업이 한 트랜잭션에서 정리합니다.
 *
 * 지우는 것(그 사람만의 자료): 프로필(실명·표시명 페르소나·연결 플래그 포함, S-01, 페르소나의 소셜 링크 S-06), 세션, 로그인 수단, 그 주소의 매직링크 토큰, 외부 연동(디스코드 id), 학교 메일 인증·인증 코드(C-01), 기수 승인·수료증 확인과 파일(I-01), 기관 운영진 지정(I-02), 학생 큐레이터 지정(E-03; 병합 제안·신고 의견·과제 유형 요약은 남기고 그 사람 칸만 비움),
 * 커뮤니티 멤버십·그 사람이 만들거나 쓴 공간 초대·공식 페이지 개설 요청(C-02, 방장이었으면 먼저 승계: 가장 오래된 admin → 멤버, 없으면 방 보관),
 * 동문회·OB 방의 참석 응답·공지 읽음·투표 표·올린 앨범 사진과 파일(A-02)·멤버 명부 동의 행(A-03), 공감 라운지 글에 붙인 미디어 행과 파일(A-04), 받은 커뮤니티 알림과 선택 실명(C-03; 이름 표시 방식 변경 이력 행은 공간의 기록이라 남기고 예약·취소한 사람만 null), 커뮤니티 글·댓글의 제목·본문
 * (C-04; 행·스레드 익명 번호는 남기고 "작성자가 삭제한 글"로)과 공감, 그 사람에게 내려진 커뮤니티 이용 제한 행(C-06; 짝인 운영 조치 행은 운영 기록으로 남음)·
 * 작성자 확인 기록의 확인된 작성자 칸(기록 자체는 운영자의 접근 기록이라 남김)·그 사람이 쓴 제재 요청 설명, 디스코드 코드·📌 요청,
 * 주간 체크인(모든 과제), 이번 학기 과목 등록(E-01)·과목 허브 알림 신청·닫음(E-02), 유용성 신호, 막힘 Q&A 스레드(E-04; 그 사람의 질문·답변은 본문을 비워
 * "작성자가 지운 글"로 — 행·스레드 익명 번호는 남김, 도움됐어요 행은 지움, 그 사람이 켠 질문 허용은 끄고 작성자 칸을 비움), 선배 노트(철회 + 삭제), 케이스 스터디·포트폴리오 판, 분석 이벤트, 업로드 의도,
 * **혼자만 쓴 과제 전체**(다른 사람이 멤버였던 적 없는 과제: 로그·할 일·마일스톤·선언·체크인·디스코드 연결·파일과 저장소 파일·공개·후보).
 *
 * 남기는 것(팀 기록): 다른 사람이 멤버였던 과제의 로그·역할 선언·파일·할 일은 지우지 않습니다(조용히 지우면 팀 이력과 동료의 확인·근거가
 * 깨짐). 작성자 표시는 users 행의 이름을 "탈퇴한 사용자"로 바꿔 가명 처리하고, 그 사람이 남의 기록에 쓴 메모 글(확인 메모·동의 메모·
 * 신고 설명·이의제기 글·운영 시간 메모(C-10))은 지웁니다. 운영자였으면 주간 운영 시간의 분은 남깁니다(합계 지표). 멤버십은 removed, owner였으면 남은 active 멤버(editor → reviewer → viewer, 먼저 들어온 순)에게 넘깁니다.
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
  archiveTransferConsents,
  archiveTransfers,
  courseQaItems,
  courseHubNotices,
  stuckQaCards,
  stuckQaHelpful,
  stuckQaPosts,
  courseRegistrations,
  affiliationCodes,
  analyticsEvents,
  and,
  appeals,
  artifactVersions,
  artifacts,
  auditEvents,
  blocks,
  authAccounts,
  caseSentences,
  caseStudies,
  interviewPrepEntries,
  portfolioShareLinks,
  certificateChecks,
  claimEvidence,
  cohortApprovals,
  institutionStaff,
  courseCurators,
  conceptTagMergeProposals,
  curatorReportRecommendations,
  courseTypeSummaries,
  communityAuthorLookups,
  communityComments,
  communityNotices,
  communityPosts,
  communityReactions,
  communitySanctionRequests,
  communitySanctions,
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
  identityLinks,
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
  nameModeChanges,
  ne,
  officialPageRequests,
  operators,
  opsTimeEntries,
  recruitmentApplications,
  recruitments,
  or,
  outboxEvents,
  personaActivities,
  personaOwnerLookups,
  personas,
  profilePosts,
  planForks,
  portfolioEditions,
  portfolioItems,
  profiles,
  follows,
  mutes,
  socialLinks,
  projectListings,
  projectMembers,
  projects,
  publicationCandidates,
  publications,
  reports,
  roleClaims,
  searchDocuments,
  seniorNotes,
  completionRetros,
  sessions,
  directoryEntries,
  noticeReads,
  communityPostMedia,
  roomAlbumPhotos,
  roomEventRsvps,
  roomEvents,
  roomPollVotes,
  roomPolls,
  roomProfileCohortChanges,
  roomProfiles,
  spaceInvitations,
  spaceMemberships,
  sql,
  studyRecords,
  tasks,
  uploadIntents,
  usefulnessSignals,
  users,
  visibilitySettings,
  weeklyCheckins,
  type DbExecutor,
  type PublicationOutboxPayload,
} from '@peerchive/db'
import { chooseOwnerSuccessor, planStudyRecordSync } from '@peerchive/domain'
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
    // 프로필·페르소나(S-01, ADR 0028): 실명·표시명 프로필 모두(표시명 프로필은 user_id가 null이라 페르소나로 찾음)와 연결 플래그.
    // 페르소나 행은 포트폴리오 판(외래 키)을 지운 뒤 3)에서 지웁니다.
    const personaIds = idsOf(await tx.select({ id: personas.id }).from(personas).where(eq(personas.userId, userId)))
    c.add('identity_links', (await tx.delete(identityLinks).where(eq(identityLinks.userId, userId)).returning({ id: identityLinks.userId })).length)
    if (personaIds.length) c.add('profile', (await tx.delete(profiles).where(inArray(profiles.personaId, personaIds)).returning({ id: profiles.personaId })).length)
    c.add('integrations', (await tx.delete(integrations).where(eq(integrations.userId, userId)).returning({ id: integrations.id })).length)
    // 학교 메일 인증(C-01): 코드 → 소속 순서(외래 키). 이력(학교·도메인·인증 시각)도 그 사람만의 자료라 남기지 않습니다.
    const affiliationIds = idsOf(await tx.select({ id: institutionAffiliations.id }).from(institutionAffiliations).where(eq(institutionAffiliations.userId, userId)))
    // 기관 인증 수단(I-01, ADR 0037): 그 사람이 남긴 기수 승인(남의 요청에 한 것 포함 — 이미 인증된 상대의 소속은 그대로)과 그 사람 요청이 받은 승인,
    // 수료증 확인 행과 남은 파일(파일은 커밋 직전에 지움). 기수·초대 코드 행은 기관의 기록이라 남깁니다(만든 사람 칸은 가명 처리된 users).
    c.add(
      'cohort_approvals',
      (
        await tx
          .delete(cohortApprovals)
          .where(
            or(
              eq(cohortApprovals.approverUserId, userId),
              affiliationIds.length ? inArray(cohortApprovals.affiliationId, affiliationIds) : sql`false`,
              affiliationIds.length ? inArray(cohortApprovals.approverAffiliationId, affiliationIds) : sql`false`,
            ),
          )
          .returning({ id: cohortApprovals.affiliationId })
      ).length,
    )
    // 기관 운영진 지정(I-02, ADR 0044): 그 사람의 지정 행(열린 것·해제된 것). 그 사람이 운영자로서 남을 지정·해제한 칸은 가명 처리된 users를 가리킵니다.
    c.add('institution_staff', (await tx.delete(institutionStaff).where(eq(institutionStaff.userId, userId)).returning({ id: institutionStaff.id })).length)
    // 학생 큐레이터(E-03, ADR 0048): 지정 행(열린 것·해제된 것, 포트폴리오 표시 선택 포함)은 지웁니다 — 권한·공개 프로필 표시가 함께 사라집니다.
    // 남이 보는 기록(병합 제안·신고 의견·과제 유형 요약)은 과목·운영 기록이라 남기고 그 사람 칸만 비웁니다.
    c.add('course_curators', (await tx.delete(courseCurators).where(eq(courseCurators.userId, userId)).returning({ id: courseCurators.id })).length)
    c.add(
      'curator_actor_refs',
      (await tx.update(conceptTagMergeProposals).set({ proposedBy: null }).where(eq(conceptTagMergeProposals.proposedBy, userId)).returning({ id: conceptTagMergeProposals.id })).length +
        (await tx.update(curatorReportRecommendations).set({ curatorId: null }).where(eq(curatorReportRecommendations.curatorId, userId)).returning({ id: curatorReportRecommendations.id })).length +
        (await tx.update(courseTypeSummaries).set({ updatedBy: null }).where(eq(courseTypeSummaries.updatedBy, userId)).returning({ id: courseTypeSummaries.courseId })).length,
    )
    const certificates = await tx.delete(certificateChecks).where(eq(certificateChecks.userId, userId)).returning({ key: certificateChecks.objectKey })
    c.add('certificate_checks', certificates.length)
    let certificateObjects = 0
    for (const { key } of certificates) {
      if (key && isObjectKey(key)) {
        objectKeys.add(key)
        certificateObjects++
      }
    }
    c.add('certificate_files', certificateObjects)
    // 앨범 사진(A-02, ADR 0039): 방을 나가도 남지만 탈퇴하면 그 사람이 올린 사진 행과 파일을 지웁니다(파일은 커밋 직전).
    const photos = await tx.delete(roomAlbumPhotos).where(eq(roomAlbumPhotos.uploaderId, userId)).returning({ key: roomAlbumPhotos.objectKey })
    c.add('room_album_photos', photos.length)
    // 앨범 사진·라운지 미디어 파일 수(artifact_objects에서 뺌).
    let communityMediaObjects = 0
    for (const { key } of photos) {
      if (isObjectKey(key) && !objectKeys.has(key)) {
        objectKeys.add(key)
        communityMediaObjects++
      }
    }
    // 공감 라운지 미디어(A-04, ADR 0041): 그 사람이 붙인 미디어 행과 파일을 지웁니다(글은 아래에서 "작성자가 삭제한 글"이 됨, 파일은 커밋 직전).
    const media = await tx.delete(communityPostMedia).where(eq(communityPostMedia.uploaderId, userId)).returning({ key: communityPostMedia.objectKey })
    c.add('community_post_media', media.length)
    for (const { key } of media) {
      if (isObjectKey(key) && !objectKeys.has(key)) {
        objectKeys.add(key)
        communityMediaObjects++
      }
    }
    if (affiliationIds.length) {
      // 소속 표시 익명(A-05, ADR 0042) 글·댓글이 가리키는 소속 id(운영자 전용 열)를 먼저 비웁니다(고정 열 트리거는 비우기만 허용).
      // 표시 문자열은 작성 시점 값으로 남지만 그 글·댓글은 아래 purgeCommunity가 작성자 삭제로 바꿔 화면에 나오지 않습니다.
      await tx.update(communityPosts).set({ affiliationId: null }).where(inArray(communityPosts.affiliationId, affiliationIds))
      await tx.update(communityComments).set({ affiliationId: null }).where(inArray(communityComments.affiliationId, affiliationIds))
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
    // 이번 학기 과목 등록(E-01): 본인만 보던 행이라 남길 이유가 없습니다(학기 종료 알림 시각 포함).
    c.add('course_registrations', (await tx.delete(courseRegistrations).where(eq(courseRegistrations.userId, userId)).returning({ id: courseRegistrations.id })).length)
    // 과목 허브 알림 신청·닫음(E-02): 본인만 보던 행.
    c.add('course_hub_notices', (await tx.delete(courseHubNotices).where(eq(courseHubNotices.userId, userId)).returning({ id: courseHubNotices.id })).length)
    c.add('signals', (await tx.delete(usefulnessSignals).where(eq(usefulnessSignals.userId, userId)).returning({ id: usefulnessSignals.id })).length)
    // 막힘 Q&A 스레드(E-04, ADR 0049): 글은 본문을 비워 "작성자가 지운 글"로(번호·자리는 남겨 스레드의 다른 번호가 바뀌지 않게), 도움됐어요는 지우고,
    // 막힘 로그 작성자로 켠 질문 허용은 끕니다(작성자 칸 비움). 번호 행(stuck_qa_aliases)·스레드의 asker_id는 가명 처리된 users를 가리킨 채 남습니다.
    c.add(
      'stuck_qa_posts',
      (
        await tx
          .update(stuckQaPosts)
          .set({ status: 'withdrawn', body: '', countAsContribution: false, withdrawnAt: sql`coalesce(${stuckQaPosts.withdrawnAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
          .where(and(eq(stuckQaPosts.authorId, userId), ne(stuckQaPosts.status, 'withdrawn')))
          .returning({ id: stuckQaPosts.id })
      ).length,
    )
    c.add('stuck_qa_helpful', (await tx.delete(stuckQaHelpful).where(eq(stuckQaHelpful.userId, userId)).returning({ id: stuckQaHelpful.id })).length)
    c.add(
      'stuck_qa_cards',
      (await tx.update(stuckQaCards).set({ authorId: null, questionsAllowed: false, updatedAt: now }).where(eq(stuckQaCards.authorId, userId)).returning({ id: stuckQaCards.id })).length,
    )
    if (deps.analyticsPepper) {
      const actorHash = hashSubject(deps.analyticsPepper, userId)
      c.add('analytics_events', (await tx.delete(analyticsEvents).where(eq(analyticsEvents.actorHash, actorHash)).returning({ id: analyticsEvents.id })).length)
    }

    // 3) 포트폴리오 판·케이스 스터디.
    // E-06(ADR 0050): 면접 준비 팩 항목(비공개 답변 메모·공개 선택)은 그 사람만의 것이라 모두 지웁니다(공개 행보다 먼저).
    c.add('interview_prep_entries', (await tx.delete(interviewPrepEntries).where(eq(interviewPrepEntries.userId, userId)).returning({ id: interviewPrepEntries.id })).length)
    // E-07(ADR 0051): 제한 공유 링크(토큰 해시·이름·열람 횟수)는 판보다 먼저 지웁니다. 지운 뒤에는 그 링크가 모두 404입니다.
    c.add('portfolio_share_links', (await tx.delete(portfolioShareLinks).where(eq(portfolioShareLinks.userId, userId)).returning({ id: portfolioShareLinks.id })).length)
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
    // S-04(ADR 0033): 뮤트는 페르소나 없이도 걸 수 있어(건 사람은 사용자 단위) 페르소나 유무와 관계없이 지웁니다.
    c.add(
      'mutes',
      (await tx.delete(mutes).where(or(eq(mutes.muterUserId, userId), eq(mutes.mutedUserId, userId))).returning({ id: mutes.id })).length,
    )
    if (personaIds.length) {
      // S-02(ADR 0029): 페르소나 활동은 지우고, 글·댓글에 고정한 작성 시점 페르소나는 비웁니다(고정 열 트리거가 null로 비우는 것만 허용).
      // 글·댓글 행 자체는 위 커뮤니티 정리 규칙대로 남습니다(표시명·실명 글은 읽을 때 "탈퇴한 사용자").
      c.add('persona_activities', (await tx.delete(personaActivities).where(inArray(personaActivities.personaId, personaIds)).returning({ id: personaActivities.id })).length)
      // S-05(ADR 0035): 프로필 글(그 사람만의 글, 지운 글 포함). 활동을 먼저 지웠으므로 거두기 트리거가 할 일은 없습니다.
      c.add('profile_posts', (await tx.delete(profilePosts).where(eq(profilePosts.userId, userId)).returning({ id: profilePosts.id })).length)
      // S-03(ADR 0031): 항목별 공개 범위와 과제 수행 목록 행(그 사람의 선택일 뿐이라 남기지 않음). 과제·멤버십은 아래 규칙대로.
      c.add('visibility_settings', (await tx.delete(visibilitySettings).where(inArray(visibilitySettings.personaId, personaIds)).returning({ id: visibilitySettings.personaId })).length)
      c.add('project_listings', (await tx.delete(projectListings).where(inArray(projectListings.personaId, personaIds)).returning({ id: projectListings.personaId })).length)
      // S-04(ADR 0033): 이 사람의 페르소나가 들어간 팔로우(양쪽)·차단(건 것·당한 것). 관계 행이라 남기지 않고, 상대에게 알리지 않습니다.
      // 사용자 사본 열은 복합 외래 키로 페르소나의 주인과 같음이 보장됩니다.
      c.add('follows', (await tx.delete(follows).where(or(eq(follows.followerUserId, userId), eq(follows.followeeUserId, userId))).returning({ id: follows.id })).length)
      c.add('blocks', (await tx.delete(blocks).where(or(eq(blocks.blockerUserId, userId), eq(blocks.blockedUserId, userId))).returning({ id: blocks.id })).length)
      // S-06(ADR 0034): 소셜 링크(페르소나마다, 사용자 사본 열은 복합 외래 키로 주인과 같음).
      c.add('social_links', (await tx.delete(socialLinks).where(eq(socialLinks.userId, userId)).returning({ id: socialLinks.id })).length)
      const postRefs = await tx.update(communityPosts).set({ personaId: null }).where(inArray(communityPosts.personaId, personaIds)).returning({ id: communityPosts.id })
      const commentRefs = await tx
        .update(communityComments)
        .set({ personaId: null })
        .where(inArray(communityComments.personaId, personaIds))
        .returning({ id: communityComments.id })
      c.add('community_persona_refs', postRefs.length + commentRefs.length)
      // S-07(ADR 0036): 운영자의 페르소나 주인 확인 기록은 접근 기록이라 남기고, 확인된 주인 칸만 비웁니다(community_author_lookups와 같은 규칙).
      // 신고·조치 행의 페르소나·글·링크 열은 외래 키가 없어 지워진 대상을 가리킨 채 남습니다(운영 화면은 "찾을 수 없음").
      c.add(
        'persona_owner_lookup_subjects',
        (await tx.update(personaOwnerLookups).set({ ownerUserId: null }).where(eq(personaOwnerLookups.ownerUserId, userId)).returning({ id: personaOwnerLookups.id })).length,
      )
      c.add('personas', (await tx.delete(personas).where(inArray(personas.id, personaIds)).returning({ id: personas.id })).length)
    }
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
          // A-06: 복사한 소속 표시도 비우고 방식은 익명으로(소속 표시 방식은 문자열이 있어야 함, check).
          .set({
            answers: {},
            displayMode: 'anonymous',
            displayNameSnapshot: null,
            affiliationLabel: null,
            termLabel: null,
            totalTimeBucket: null,
            status: 'withdrawn',
            withdrawnAt: now,
            updatedAt: now,
          })
          .where(inArray(seniorNotes.id, [...referenced]))
      }
      c.add('senior_notes', noteIds.length)
    }

    // 4-1) 수료 회고(A-06, ADR 0043): 삭제(신고·조치가 가리키면 글·이름·기수를 비운 익명 철회 행으로 남김 — 고정 열 트리거가 비우기만 허용).
    const retroIds = idsOf(await tx.select({ id: completionRetros.id }).from(completionRetros).where(eq(completionRetros.authorId, userId)))
    if (retroIds.length) {
      const fromReports = await tx.select({ id: reports.completionRetroId }).from(reports).where(inArray(reports.completionRetroId, retroIds))
      const fromActions = await tx.select({ id: moderationActions.completionRetroId }).from(moderationActions).where(inArray(moderationActions.completionRetroId, retroIds))
      const referenced = new Set([...fromReports, ...fromActions].map((r) => r.id).filter((id): id is string => typeof id === 'string'))
      const deletable = retroIds.filter((id) => !referenced.has(id))
      if (deletable.length) await tx.delete(completionRetros).where(inArray(completionRetros.id, deletable))
      if (referenced.size) {
        await tx
          .update(completionRetros)
          .set({ answers: {}, displayMode: 'anonymous', displayNameSnapshot: null, cohortLabel: null, cohortId: null, status: 'withdrawn', withdrawnAt: now, updatedAt: now })
          .where(inArray(completionRetros.id, [...referenced]))
      }
      c.add('completion_retros', retroIds.length)
    }

    // 5) 남의 기록에 쓴 메모 글.
    let notes = 0
    notes += (await tx.update(endorsements).set({ note: null }).where(and(eq(endorsements.endorserId, userId), isNotNull(endorsements.note))).returning({ id: endorsements.id })).length
    notes += (await tx.update(consents).set({ note: null }).where(and(eq(consents.subjectUserId, userId), isNotNull(consents.note))).returning({ id: consents.id })).length
    notes += (await tx.update(reports).set({ details: null }).where(and(eq(reports.reporterId, userId), isNotNull(reports.details))).returning({ id: reports.id })).length
    notes += (await tx.update(appeals).set({ message: SCRUBBED_TEXT }).where(and(eq(appeals.appellantId, userId), ne(appeals.message, SCRUBBED_TEXT))).returning({ id: appeals.id })).length
    // 운영자 주간 운영 시간(C-10, ADR 0027): 메모만 지우고 분은 남깁니다(주·분야별 합계가 바뀌지 않게, 행은 가명 처리된 users를 가리킴).
    notes += (await tx.update(opsTimeEntries).set({ note: null, updatedAt: now }).where(and(eq(opsTimeEntries.operatorId, userId), isNotNull(opsTimeEntries.note))).returning({ id: opsTimeEntries.id })).length
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
    const pseudonymized =
      user.purgedAt === null || user.displayName !== DELETED_DISPLAY_NAME || user.privateEmail !== purgedEmailFor(userId) || user.status !== 'deleted' || user.realName !== null
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
          realName: null,
          updatedAt: now,
        })
        .where(eq(users.id, userId))
      c.add('account', 1)
    }
    c.add('artifact_objects', objectKeys.size - certificateObjects - communityMediaObjects)

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

/** 스터디 기록 과제 멤버십을 방 멤버십에 맞춥니다(웹 syncStudyRecordInTx와 같은 계획 함수). 바뀐 것이 있으면 true. */
async function syncStudyRecord(tx: DbExecutor, spaceId: string, projectId: string, now: Date): Promise<boolean> {
  const [space] = await tx.select({ status: communitySpaces.status }).from(communitySpaces).where(eq(communitySpaces.id, spaceId)).limit(1)
  const [project] = await tx.select({ ownerId: projects.ownerId }).from(projects).where(eq(projects.id, projectId)).limit(1).for('update')
  if (!space || !project) return false
  const roomMembers = await tx
    .select({ userId: spaceMemberships.userId, role: spaceMemberships.role, status: spaceMemberships.status })
    .from(spaceMemberships)
    .where(eq(spaceMemberships.spaceId, spaceId))
  const recordMembers = await tx
    .select({ userId: projectMembers.userId, role: projectMembers.role, status: projectMembers.status })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
  const plan = planStudyRecordSync(roomMembers, recordMembers, space.status)
  for (const u of plan.updates) {
    await tx.update(projectMembers).set({ role: u.role, status: u.status, updatedAt: now }).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, u.userId)))
  }
  if (plan.inserts.length) {
    await tx.insert(projectMembers).values(plan.inserts.map((i) => ({ projectId, userId: i.userId, role: i.role, status: 'active' as const, createdAt: now, updatedAt: now })))
  }
  const ownerChanged = plan.ownerId !== null && plan.ownerId !== project.ownerId
  if (ownerChanged) await tx.update(projects).set({ ownerId: plan.ownerId!, version: sql`${projects.version} + 1`, updatedAt: now }).where(eq(projects.id, projectId))
  const changed = plan.inserts.length + plan.updates.length > 0 || ownerChanged
  if (changed) {
    await tx.insert(auditEvents).values({
      actorId: null,
      action: 'project.study_sync',
      targetType: 'project',
      targetId: projectId,
      projectId,
      metadata: { inserted: plan.inserts.length, updated: plan.updates.length, ownerChanged, reason: 'account_deleted' },
    })
  }
  return changed
}

/** 커뮤니티 멤버십·초대·개설 요청 정리. 그 사람이 active owner인 방은 승계(없으면 보관)합니다. */
async function purgeCommunity(tx: DbExecutor, userId: string, c: Counter, now: Date): Promise<void> {
  // 모집·지원(C-07, ADR 0024)을 초대 삭제(아래·과제 정리)보다 먼저: 지원 행이 초대를 가리키므로.
  await purgeRecruitments(tx, userId, c, now)
  await purgeArchiveTransfers(tx, userId, c, now)
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
  // 스터디 기록(C-08, ADR 0026): 멤버십을 지우기 전에 그 사람이 있던 방 중 기록이 켜진 방을 모아 두고, 지운 뒤 과제 멤버십을 웹과 같은 계획 함수로 맞춥니다
  // (그 사람은 removed, 승계한 새 방장은 과제 owner). 그 뒤 과제 정리(6단계)는 이미 넘어간 owner를 그대로 둡니다.
  const recordSpaces = await tx
    .select({ spaceId: studyRecords.spaceId, projectId: studyRecords.projectId })
    .from(studyRecords)
    .innerJoin(spaceMemberships, eq(spaceMemberships.spaceId, studyRecords.spaceId))
    .where(eq(spaceMemberships.userId, userId))
  c.add('space_memberships', (await tx.delete(spaceMemberships).where(eq(spaceMemberships.userId, userId)).returning({ id: spaceMemberships.id })).length)
  for (const record of recordSpaces.sort((a, b) => (a.spaceId < b.spaceId ? -1 : 1))) {
    if (await syncStudyRecord(tx, record.spaceId, record.projectId, now)) c.add('study_record_syncs', 1)
  }
  c.add(
    'space_invitations',
    (await tx.delete(spaceInvitations).where(or(eq(spaceInvitations.createdBy, userId), eq(spaceInvitations.usedBy, userId))).returning({ id: spaceInvitations.id })).length,
  )
  c.add('official_page_requests', (await tx.delete(officialPageRequests).where(eq(officialPageRequests.requesterId, userId)).returning({ id: officialPageRequests.id })).length)
  // 운영자가 학생회 요청으로 표시한 기록의 표시자만 지웁니다(요청은 남의 것).
  await tx.update(officialPageRequests).set({ sourceMarkedBy: null }).where(eq(officialPageRequests.sourceMarkedBy, userId))
  // 이름 표시 방식(C-03): 받은 알림은 지우고, 변경 이력(공간의 기록, 멤버가 봄)은 남기되 예약·취소한 사람만 비웁니다.
  c.add('community_notices', (await tx.delete(communityNotices).where(eq(communityNotices.userId, userId)).returning({ id: communityNotices.id })).length)
  const requested = await tx.update(nameModeChanges).set({ requestedBy: null }).where(eq(nameModeChanges.requestedBy, userId)).returning({ id: nameModeChanges.id })
  const cancelled = await tx.update(nameModeChanges).set({ cancelledBy: null }).where(eq(nameModeChanges.cancelledBy, userId)).returning({ id: nameModeChanges.id })
  c.add('name_mode_change_actors', requested.length + cancelled.length)
  // 동문회·OB 방(A-01, ADR 0038): 방별 프로필과 그 사람에 대한 기수 이력(그 사람의 자기 신고 정보)은 지우고,
  // 그 사람이 방장·운영진으로서 바꾼 남의 기수 이력은 남기되 바꾼 사람 칸만 비웁니다(이름 표시 방식 변경 이력과 같은 규칙).
  c.add('room_profiles', (await tx.delete(roomProfiles).where(eq(roomProfiles.userId, userId)).returning({ id: roomProfiles.id })).length)
  c.add(
    'room_profile_cohort_changes',
    (await tx.delete(roomProfileCohortChanges).where(eq(roomProfileCohortChanges.subjectUserId, userId)).returning({ id: roomProfileCohortChanges.id })).length,
  )
  c.add(
    'room_profile_cohort_actors',
    (await tx.update(roomProfileCohortChanges).set({ changedBy: null }).where(eq(roomProfileCohortChanges.changedBy, userId)).returning({ id: roomProfileCohortChanges.id })).length,
  )
  // 동문회·OB 방 모임 도구(A-02, ADR 0039): 그 사람의 참석 응답·공지 읽음 표시·투표 표는 지웁니다(읽음 수·투표 집계도 그만큼 줄어듦).
  // 그 사람이 방장·운영진으로 만든 일정·투표는 방의 기록이라 남기고 만든 사람 칸만 비웁니다. 앨범 사진은 위(파일과 함께)에서 지웁니다.
  c.add('room_event_rsvps', (await tx.delete(roomEventRsvps).where(eq(roomEventRsvps.userId, userId)).returning({ id: roomEventRsvps.eventId })).length)
  c.add('notice_reads', (await tx.delete(noticeReads).where(eq(noticeReads.userId, userId)).returning({ id: noticeReads.postId })).length)
  c.add('room_poll_votes', (await tx.delete(roomPollVotes).where(eq(roomPollVotes.userId, userId)).returning({ id: roomPollVotes.pollId })).length)
  // 멤버 명부(A-03, ADR 0040): 그 사람의 모든 방 명부 행을 지웁니다.
  c.add('directory_entries', (await tx.delete(directoryEntries).where(eq(directoryEntries.userId, userId)).returning({ id: directoryEntries.spaceId })).length)
  const eventActors = await tx.update(roomEvents).set({ createdBy: null }).where(eq(roomEvents.createdBy, userId)).returning({ id: roomEvents.id })
  const pollActors = await tx.update(roomPolls).set({ createdBy: null }).where(eq(roomPolls.createdBy, userId)).returning({ id: roomPolls.id })
  c.add('room_gathering_actors', eventActors.length + pollActors.length)
  // 글·댓글(C-04, ADR 0022): 행은 남기고(스레드 익명 번호·답글·운영 기록이 이어지게) 제목·본문을 비워 "작성자가 삭제한 글"로 바꿉니다.
  // 표시명·실명 글의 작성자는 읽을 때 "탈퇴한 사용자", 익명 글은 그대로 스레드 번호(탈퇴 여부를 드러내지 않음). 스레드 익명 번호 행은 남깁니다
  // (가명 처리된 users 행을 가리킴, 다른 참여자의 번호가 바뀌지 않게). 그 사람의 공감과 지운 글·댓글에 달린 공감은 지웁니다.
  const posts = await tx
    .update(communityPosts)
    .set({ status: 'deleted_by_author', title: '', body: '', deletedAt: sql`coalesce(${communityPosts.deletedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
    .where(and(eq(communityPosts.authorId, userId), or(ne(communityPosts.status, 'deleted_by_author'), ne(communityPosts.body, ''))))
    .returning({ id: communityPosts.id })
  c.add('community_posts', posts.length)
  const comments = await tx
    .update(communityComments)
    .set({ status: 'deleted_by_author', body: '', deletedAt: sql`coalesce(${communityComments.deletedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
    .where(and(eq(communityComments.authorId, userId), or(ne(communityComments.status, 'deleted_by_author'), ne(communityComments.body, ''))))
    .returning({ id: communityComments.id })
  c.add('community_comments', comments.length)
  const reactions = await tx
    .delete(communityReactions)
    .where(
      or(
        eq(communityReactions.userId, userId),
        posts.length ? inArray(communityReactions.postId, idsOf(posts)) : sql`false`,
        comments.length ? inArray(communityReactions.commentId, idsOf(comments)) : sql`false`,
      ),
    )
    .returning({ id: communityReactions.id })
  c.add('community_reactions', reactions.length)
  // 이용 제한·작성자 확인·제재 요청(C-06, ADR 0023): 그 사람에게 내려진 제재 행은 지우고(짝인 운영 조치 행·이의제기는 운영 기록으로 남음),
  // 작성자 확인 기록은 운영자의 접근 기록이라 남기되 확인된 작성자 칸만 비웁니다. 그 사람이 운영진으로서 쓴 제재 요청은 설명 글만 지웁니다.
  // 그 사람이 운영자로서 남긴 확인·발급 기록의 행위자 칸은 가명 처리된 users 행을 그대로 가리킵니다(감사와 같음).
  c.add('community_sanctions', (await tx.delete(communitySanctions).where(eq(communitySanctions.userId, userId)).returning({ id: communitySanctions.id })).length)
  c.add(
    'community_author_lookup_subjects',
    (await tx.update(communityAuthorLookups).set({ authorId: null }).where(eq(communityAuthorLookups.authorId, userId)).returning({ id: communityAuthorLookups.id })).length,
  )
  c.add(
    'sanction_request_details',
    (
      await tx
        .update(communitySanctionRequests)
        .set({ details: null })
        .where(and(eq(communitySanctionRequests.requestedBy, userId), isNotNull(communitySanctionRequests.details)))
        .returning({ id: communitySanctionRequests.id })
    ).length,
  )
}

/**
 * 모집·지원 정리(C-07, ADR 0024).
 * - 그 사람의 지원: 지웁니다. 신고·운영 조치가 가리키면 메시지·첨부를 비우고 지원 취소로 남깁니다(운영 기록이 깨지지 않게).
 * - 그 사람이 올린 모집: 모집 중이면 취소하고 검토 중·선정된 지원자에게 취소 알림(웹 cancelRecruitment와 같은 알림 행), 모든 모집 글의 제목·소개를
 *   비웁니다(행은 남김, created_by는 가명 처리된 users 행). 그 모집의 지원 행이 가리키던 초대(모집자 이름으로 발급)는 연결만 끊습니다
 *   (초대 행은 과제·공간 정리에서 지우거나 취소).
 */
async function purgeRecruitments(tx: DbExecutor, userId: string, c: Counter, now: Date): Promise<void> {
  const mineApps = await tx.select({ id: recruitmentApplications.id }).from(recruitmentApplications).where(eq(recruitmentApplications.applicantId, userId))
  if (mineApps.length) {
    const ids = idsOf(mineApps)
    const referenced = await tx
      .select({ id: reports.communityApplicationId })
      .from(reports)
      .where(inArray(reports.communityApplicationId, ids))
      .union(tx.select({ id: moderationActions.communityApplicationId }).from(moderationActions).where(inArray(moderationActions.communityApplicationId, ids)))
    const keep = new Set(referenced.map((r) => r.id).filter((id): id is string => !!id))
    const deletable = ids.filter((id) => !keep.has(id))
    let changed = 0
    if (deletable.length) changed += (await tx.delete(recruitmentApplications).where(inArray(recruitmentApplications.id, deletable)).returning({ id: recruitmentApplications.id })).length
    if (keep.size) {
      // 이미 비운 행은 다시 세지 않습니다(재적용 idempotent).
      const scrubbed = await tx
        .update(recruitmentApplications)
        .set({
          message: '',
          profileHandle: null,
          caseSlugs: [],
          status: 'withdrawn',
          decidedAt: sql`coalesce(${recruitmentApplications.decidedAt}, ${now.toISOString()}::timestamptz)`,
          projectInvitationId: null,
          spaceInvitationId: null,
          updatedAt: now,
        })
        .where(
          and(
            inArray(recruitmentApplications.id, [...keep]),
            or(
              ne(recruitmentApplications.message, ''),
              isNotNull(recruitmentApplications.profileHandle),
              sql`cardinality(${recruitmentApplications.caseSlugs}) > 0`,
              ne(recruitmentApplications.status, 'withdrawn'),
              isNotNull(recruitmentApplications.projectInvitationId),
              isNotNull(recruitmentApplications.spaceInvitationId),
            ),
          ),
        )
        .returning({ id: recruitmentApplications.id })
      changed += scrubbed.length
    }
    c.add('recruitment_applications', changed)
  }
  const created = await tx.select({ id: recruitments.id, kind: recruitments.kind, status: recruitments.status, title: recruitments.title }).from(recruitments).where(eq(recruitments.createdBy, userId))
  if (created.length === 0) return
  const createdIds = idsOf(created)
  await tx
    .update(recruitmentApplications)
    .set({ projectInvitationId: null, spaceInvitationId: null })
    .where(and(inArray(recruitmentApplications.recruitmentId, createdIds), or(isNotNull(recruitmentApplications.projectInvitationId), isNotNull(recruitmentApplications.spaceInvitationId))))
  const open = created.filter((r) => r.status === 'open')
  for (const r of open) {
    // 웹 모집 취소와 같은 알림(종류만, 모집·사람·종류마다 한 행). 계정이 active인 지원자에게만.
    await tx.execute(sql`
      insert into community_notices (user_id, space_id, recruitment_id, kind, payload, created_at)
      select ra.applicant_id, null, ${r.id}, 'recruitment_cancelled', ${JSON.stringify({ recruitmentKind: r.kind })}::jsonb, ${now.toISOString()}::timestamptz
      from recruitment_applications ra join users u on u.id = ra.applicant_id
      where ra.recruitment_id = ${r.id} and ra.status in ('pending', 'accepted') and u.status = 'active'
      on conflict (recruitment_id, kind, user_id) where recruitment_id is not null do nothing`)
  }
  if (open.length) {
    await tx.update(recruitments).set({ status: 'cancelled', closedAt: now, updatedAt: now }).where(inArray(recruitments.id, idsOf(open)))
    c.add('recruitments_cancelled', open.length)
  }
  const cleared = await tx
    .update(recruitments)
    .set({ title: '', description: '', updatedAt: now })
    .where(and(inArray(recruitments.id, createdIds), or(ne(recruitments.title, ''), ne(recruitments.description, ''))))
    .returning({ id: recruitments.id })
  c.add('recruitment_texts', cleared.length)
}

/**
 * 아카이브로 옮기기·막힘 Q&A 정리(C-09, ADR 0025).
 * - 그 사람이 요청했거나 동의해야 하는 진행 중 요청: account_deleted로 취소하고 스냅샷 글을 지움(남은 당사자에게 취소 알림, 웹 cancelInTx와 같은 알림 행).
 * - 그 사람이 **요청한** 옮기기 행(모든 상태)은 동의 행·알림과 함께 지웁니다(그 사람의 요청 기록이고, 복사본인 과제 로그·선배 노트 초안이
 *   아래 정리에서 지워질 때 외래 키가 막지 않게). 막힘 Q&A 복사본은 transfer_id(외래 키 없음)만 남습니다.
 * - 남의 요청에 남은 그 사람의 동의 행: 고른 이름(display_label)만 비움(행·상태는 요청의 기록이라 남김).
 * - 그 사람이 질문했거나 답한 막힘 Q&A: 철회(withdrawn, account_deleted) + 질문·답변 글을 모두 비우고, 그 사람 칸은 null·이름은 "탈퇴한 사용자"로.
 *   상대의 글만 남겨 두면 대화가 성립하지 않고 탈퇴한 사람의 질문·답변 맥락이 남으므로 항목 전체를 내립니다(상대는 철회됨으로 봄).
 *   검색 문서·신호는 같은 트랜잭션에서 지웁니다(공개 읽기는 이미 status로 막힘). 신고·조치가 가리킬 수 있어 행은 남깁니다.
 */
async function purgeArchiveTransfers(tx: DbExecutor, userId: string, c: Counter, now: Date): Promise<void> {
  const involved = await tx
    .select({ id: archiveTransfers.id, spaceId: archiveTransfers.spaceId, target: archiveTransfers.target })
    .from(archiveTransfers)
    .where(
      and(
        eq(archiveTransfers.status, 'awaiting_consent'),
        or(
          eq(archiveTransfers.initiatorId, userId),
          sql`exists (select 1 from ${archiveTransferConsents} atc where atc.transfer_id = ${archiveTransfers.id} and atc.user_id = ${userId})`,
        ),
      ),
    )
    .for('update')
  for (const t of involved) {
    await tx
      .update(archiveTransfers)
      .set({ status: 'cancelled', cancelReason: 'account_deleted', cancelledAt: now, snapshot: null, updatedAt: now })
      .where(eq(archiveTransfers.id, t.id))
    await tx.execute(sql`
      insert into community_notices (user_id, space_id, kind, archive_transfer_id, payload, created_at)
      select atc.user_id, ${t.spaceId}, 'archive_transfer_cancelled', ${t.id}, ${JSON.stringify({ target: t.target })}::jsonb, ${now.toISOString()}::timestamptz
      from archive_transfer_consents atc join users u on u.id = atc.user_id
      where atc.transfer_id = ${t.id} and atc.user_id <> ${userId} and u.status = 'active'
      on conflict (archive_transfer_id, kind, user_id) where archive_transfer_id is not null do nothing`)
  }
  c.add('archive_transfers_cancelled', involved.length)
  const mine = idsOf(await tx.select({ id: archiveTransfers.id }).from(archiveTransfers).where(eq(archiveTransfers.initiatorId, userId)))
  if (mine.length) {
    await tx.delete(communityNotices).where(inArray(communityNotices.archiveTransferId, mine))
    await tx.delete(archiveTransferConsents).where(inArray(archiveTransferConsents.transferId, mine))
    c.add('archive_transfers', (await tx.delete(archiveTransfers).where(inArray(archiveTransfers.id, mine)).returning({ id: archiveTransfers.id })).length)
  }
  c.add(
    'archive_transfer_consent_labels',
    (
      await tx
        .update(archiveTransferConsents)
        .set({ displayLabel: null })
        .where(and(eq(archiveTransferConsents.userId, userId), isNotNull(archiveTransferConsents.displayLabel)))
        .returning({ id: archiveTransferConsents.id })
    ).length,
  )
  const qa = await tx
    .select({ id: courseQaItems.id, askerId: courseQaItems.askerId, answererId: courseQaItems.answererId })
    .from(courseQaItems)
    .where(or(eq(courseQaItems.askerId, userId), eq(courseQaItems.answererId, userId)))
    .for('update')
  if (qa.length === 0) return
  const ids = idsOf(qa)
  await tx.delete(searchDocuments).where(inArray(searchDocuments.courseQaItemId, ids))
  await tx.delete(usefulnessSignals).where(inArray(usefulnessSignals.courseQaItemId, ids))
  for (const item of qa) {
    const asker = item.askerId === userId
    const answerer = item.answererId === userId
    await tx
      .update(courseQaItems)
      .set({
        status: 'withdrawn',
        withdrawnAt: sql`coalesce(${courseQaItems.withdrawnAt}, ${now.toISOString()}::timestamptz)`,
        withdrawnBy: sql`coalesce(${courseQaItems.withdrawnBy}, 'account_deleted')`,
        questionTitle: '',
        questionBody: '',
        answerBody: '',
        ...(asker && { askerId: null, askerLabel: WITHDRAWN_QA_LABEL, askerAnonymous: true }),
        ...(answerer && { answererId: null, answererLabel: WITHDRAWN_QA_LABEL, answererAnonymous: true }),
        updatedAt: now,
      })
      .where(eq(courseQaItems.id, item.id))
  }
  c.add('course_qa_items', qa.length)
}

/** 탈퇴 정리한 막힘 Q&A의 그 사람 이름 자리. */
const WITHDRAWN_QA_LABEL = '탈퇴한 사용자'

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
      // 이미 나간 다른 멤버가 이 과제를 과제 수행 목록에 남겨 두었을 수 있습니다(읽을 때는 active가 아니라 안 보임): 멤버십보다 먼저 지웁니다.
      await sp
        .delete(projectListings)
        .where(inArray(projectListings.projectMemberId, sp.select({ id: projectMembers.id }).from(projectMembers).where(eq(projectMembers.projectId, projectId))))
      await sp.delete(projectMembers).where(eq(projectMembers.projectId, projectId))
      // 혼자 남았던 스터디 기록(C-08): 방(보관됨)과의 연결을 먼저 지웁니다.
      await sp.delete(studyRecords).where(eq(studyRecords.projectId, projectId))
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
