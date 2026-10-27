/**
 * T-16 탈퇴 계정 정리·삭제 장부·재적용(실제 PostgreSQL, rollback). 저장소는 임시 디렉터리입니다.
 * 행은 직접 넣습니다(각 기능의 규칙은 웹 테스트가 봄). 이 테스트가 만든 사용자·과제의 행만 확인합니다.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  affiliationCodes,
  analyticsEvents,
  and,
  artifactVersions,
  artifacts,
  authAccounts,
  caseStudies,
  claimRevisions,
  boards,
  communityAuthorLookups,
  identityLinks,
  communityComments,
  communityNotices,
  communityPosts,
  communityReactions,
  communitySanctionRequests,
  communitySanctions,
  communitySpaces,
  moderationActions,
  operators,
  opsTimeEntries,
  recruitmentApplications,
  recruitments,
  reports,
  threadAliases,
  consents,
  createDb,
  deletionLedger,
  endorsements,
  eq,
  or,
  hashSubject,
  institutionAffiliations,
  integrations,
  logEntries,
  logRevisions,
  magicLinkTokens,
  nameModeChanges,
  officialPageRequests,
  outboxEvents,
  planForks,
  personaActivities,
  profilePosts,
  personas,
  follows,
  blocks,
  mutes,
  socialLinks,
  visibilitySettings,
  portfolioEditions,
  profiles,
  projectListings,
  projectMembers,
  projects,
  publicationCandidates,
  publications,
  roleClaims,
  seniorNotes,
  sessions,
  spaceInvitations,
  spaceMemberships,
  sql,
  studyRecords,
  usefulnessSignals,
  users,
  weeklyCheckins,
  courses,
  schools,
  type Database,
  type DbExecutor,
} from '@peerchive/db'
import { cleanKeyFor, createFilesystemStorage, type ObjectStorage } from '@peerchive/files'
import { exportLedger, formatLedgerLines, reapplyDeletions } from '../src/ops/ledger'
import { DELETED_DISPLAY_NAME, purgeAccount, purgeDueAccounts, purgedEmailFor } from '../src/ops/purge'

const url = process.env.DATABASE_URL
class Rollback extends Error {}
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2027-03-10T03:00:00Z')
const id = () => crypto.randomUUID()
const DELETION_PEPPER = 'test-deletion-pepper-0123456789abcdef'
const ANALYTICS_PEPPER = 'test-analytics-pepper-0123456789abcdef'

describe.skipIf(!url)('account purge and deletion ledger (PostgreSQL)', () => {
  const db: Database | undefined = url ? createDb(url, { max: 2 }) : undefined
  let root: string
  let storage: ObjectStorage
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-purge-'))
    storage = createFilesystemStorage(root)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  afterAll(async () => {
    await db?.$client.end()
  })
  const deps = () => ({ storage, deletionPepper: DELETION_PEPPER, analyticsPepper: ANALYTICS_PEPPER })

  async function rollback(fn: (tx: DbExecutor) => Promise<void>) {
    const error = await db!
      .transaction(async (tx) => {
        await fn(tx)
        throw new Rollback()
      })
      .catch((e: unknown) => e)
    // 실패한 단언은 그대로 보여 줍니다.
    if (!(error instanceof Rollback)) throw error
  }

  async function user(tx: DbExecutor, name: string, status: 'active' | 'deleted' = 'active') {
    const email = `${name.toLowerCase()}+${id()}@example.test`
    const [row] = await tx.insert(users).values({ displayName: name, privateEmail: email, status }).returning()
    return { id: row!.id, email, name }
  }

  async function project(tx: DbExecutor, ownerId: string, title: string, members: Array<{ userId: string; role: 'editor' | 'viewer' }> = []) {
    const [p] = await tx.insert(projects).values({ ownerId, title, kind: members.length ? 'team' : 'individual' }).returning()
    await tx.insert(projectMembers).values([{ projectId: p!.id, userId: ownerId, role: 'owner' }, ...members.map((m) => ({ projectId: p!.id, ...m }))])
    return p!
  }

  async function log(tx: DbExecutor, projectId: string, authorId: string, body: string) {
    const [entry] = await tx.insert(logEntries).values({ projectId, authorId, tag: 'progress' }).returning()
    const [rev] = await tx.insert(logRevisions).values({ logEntryId: entry!.id, revisionNo: 1, tag: 'progress', body }).returning()
    await tx.update(logEntries).set({ currentRevisionId: rev!.id }).where(eq(logEntries.id, entry!.id))
    return entry!
  }

  async function file(tx: DbExecutor, projectId: string, uploaderId: string) {
    const [artifact] = await tx.insert(artifacts).values({ projectId, uploaderId, title: '최종보고서.pdf' }).returning()
    const versionId = id()
    const key = cleanKeyFor(versionId)
    await storage.put(key, Readable.from([Buffer.from('%PDF-1.4 private')]), { maxBytes: 100 })
    await tx.insert(artifactVersions).values({
      id: versionId,
      artifactId: artifact!.id,
      versionNo: 1,
      uploaderId,
      fileName: '최종보고서.pdf',
      declaredType: 'application/pdf',
      bytes: 16,
      sha256: 'd'.repeat(64),
      objectKey: key,
      scanStatus: 'clean',
    })
    return { artifactId: artifact!.id, versionId, key }
  }

  async function claim(tx: DbExecutor, projectId: string, userId: string, text: string) {
    const [c] = await tx.insert(roleClaims).values({ projectId, userId }).returning()
    const [rev] = await tx.insert(claimRevisions).values({ claimId: c!.id, revisionNo: 1, text }).returning()
    await tx.update(roleClaims).set({ currentRevisionId: rev!.id }).where(eq(roleClaims.id, c!.id))
    return { claimId: c!.id, revisionId: rev!.id }
  }

  async function publish(tx: DbExecutor, projectId: string, createdBy: string, subjects: string[]) {
    const [publication] = await tx
      .insert(publications)
      .values({ projectId, slug: `case-${id().slice(0, 8)}`, level: 'summary', status: 'published', accessEpoch: 1, createdBy })
      .returning()
    const [release] = await tx
      .insert(publicationCandidates)
      .values({
        publicationId: publication!.id,
        projectId,
        version: 1,
        level: 'summary',
        status: 'published',
        snapshot: { title: '공개 제목', members: [{ key: 'm_a', label: '팀원 A' }] },
        manifest: { v: 1 },
        manifestHash: 'e'.repeat(64),
        selection: {},
        createdBy,
        releaseNo: 1,
        publishedAt: new Date(NOW.getTime() - 20 * DAY),
      })
      .returning()
    await tx.update(publications).set({ currentReleaseId: release!.id }).where(eq(publications.id, publication!.id))
    for (const subject of subjects) {
      await tx.insert(consents).values({ candidateId: release!.id, manifestHash: 'e'.repeat(64), subjectUserId: subject, status: 'granted', decidedAt: NOW, note: '좋아요' })
    }
    return { publication: publication!, release: release! }
  }

  /** U(탈퇴), T(팀원), X(외부 사용자). U의 혼자 과제 둘(하나는 X가 포크), 팀 과제 하나(U가 owner), 노트·케이스·판·개인 자료. */
  async function world(tx: DbExecutor) {
    const U = await user(tx, '김탈퇴', 'deleted')
    await tx.update(users).set({ deletionRequestedAt: new Date('2000-01-01T00:00:00Z') }).where(eq(users.id, U.id))
    const T = await user(tx, '이팀원')
    const X = await user(tx, '박외부')
    // 실명 페르소나 + 프로필, 표시명 페르소나 + 프로필(user_id 없음) + 연결 플래그(S-01).
    const realHandle = `u-${id().slice(0, 8)}`
    const [realPersona] = await tx.insert(personas).values({ userId: U.id, kind: 'real', handle: realHandle }).returning()
    await tx.insert(profiles).values({ personaId: realPersona!.id, personaKind: 'real', userId: U.id, handle: realHandle, headline: '백엔드 지망' })
    const displayHandle = `d-${id().slice(0, 8)}`
    const [displayPersona] = await tx.insert(personas).values({ userId: U.id, kind: 'display', handle: displayHandle, displayName: '밤의개발자' }).returning()
    await tx.insert(profiles).values({ personaId: displayPersona!.id, personaKind: 'display', userId: null, handle: displayHandle, headline: '표시명 소개' })
    await tx.insert(identityLinks).values({ userId: U.id, realPersonaId: realPersona!.id, displayPersonaId: displayPersona!.id, visible: true })
    await tx.insert(sessions).values({ id: `s-${id()}`, secretHash: 'h', userId: U.id, expiresAt: new Date(NOW.getTime() + DAY) })
    await tx.insert(authAccounts).values({ userId: U.id, provider: 'email', providerAccountId: U.email })
    await tx.insert(magicLinkTokens).values({ email: U.email, tokenHash: `t-${id()}`, expiresAt: NOW })
    await tx.insert(integrations).values({ userId: U.id, provider: 'discord', externalId: `${Date.now()}${Math.floor(Math.random() * 1e6)}` })
    await tx.insert(analyticsEvents).values({ name: 'project_created', actorHash: hashSubject(ANALYTICS_PEPPER, U.id), hashKeyId: '0123abcd', props: {} })

    // 혼자 과제 1: 외부 참조 없음 → 전체 삭제
    const solo = await project(tx, U.id, '나만의 비밀 과제')
    const soloLog = await log(tx, solo.id, U.id, '비공개 로그 본문 SENTINEL')
    const soloFile = await file(tx, solo.id, U.id)
    await claim(tx, solo.id, U.id, '내가 다 했음')
    const soloPub = await publish(tx, solo.id, U.id, [U.id])

    // 혼자 과제 2: 공개 + X의 포크 → 묘비
    const forkedSolo = await project(tx, U.id, '포크된 과제')
    await log(tx, forkedSolo.id, U.id, '포크된 과제 로그')
    const forkedPub = await publish(tx, forkedSolo.id, U.id, [U.id])
    const xProject = await project(tx, X.id, '포크로 만든 과제')
    await tx.insert(planForks).values({
      sourcePublicationId: forkedPub.publication.id,
      sourceReleaseId: forkedPub.release.id,
      releaseVersion: 1,
      targetProjectId: xProject.id,
      forkedBy: X.id,
    })

    // 팀 과제: U가 owner, T가 editor
    const team = await project(tx, U.id, '팀 캡스톤', [{ userId: T.id, role: 'editor' }])
    // 항목별 공개 범위·과제 수행 목록(S-03): U의 실명 페르소나가 혼자 과제·팀 과제를 올려 둠.
    await tx.insert(visibilitySettings).values({ personaId: realPersona!.id, itemKind: 'project_list', audience: 'public' })
    for (const p of [solo, team]) {
      const [m] = await tx.select({ id: projectMembers.id }).from(projectMembers).where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, U.id)))
      await tx.insert(projectListings).values({ projectMemberId: m!.id, personaId: realPersona!.id, userId: U.id })
    }
    // 팔로우·차단·뮤트(S-04): T·X의 실명 페르소나와 U의 두 페르소나 사이. X ↔ T 사이 행은 U와 무관해 남아야 합니다.
    const [tPersona] = await tx.insert(personas).values({ userId: T.id, kind: 'real', handle: `t-${id().slice(0, 8)}` }).returning()
    const [xPersona] = await tx.insert(personas).values({ userId: X.id, kind: 'real', handle: `x-${id().slice(0, 8)}` }).returning()
    await tx.insert(follows).values([
      { followerPersonaId: displayPersona!.id, followerUserId: U.id, followeePersonaId: tPersona!.id, followeeUserId: T.id, status: 'active', approvedAt: NOW },
      { followerPersonaId: xPersona!.id, followerUserId: X.id, followeePersonaId: realPersona!.id, followeeUserId: U.id, status: 'pending' },
      { followerPersonaId: xPersona!.id, followerUserId: X.id, followeePersonaId: tPersona!.id, followeeUserId: T.id, status: 'active', approvedAt: NOW },
    ])
    await tx.insert(blocks).values([
      { blockerUserId: U.id, blockedUserId: X.id, originPersonaId: displayPersona!.id, blockedPersonaId: xPersona!.id },
      { blockerUserId: T.id, blockedUserId: U.id, originPersonaId: tPersona!.id, blockedPersonaId: realPersona!.id, scope: 'all_personas' },
    ])
    await tx.insert(mutes).values([
      { muterUserId: U.id, mutedPersonaId: tPersona!.id, mutedUserId: T.id },
      { muterUserId: X.id, mutedPersonaId: displayPersona!.id, mutedUserId: U.id },
      { muterUserId: X.id, mutedPersonaId: tPersona!.id, mutedUserId: T.id },
    ])
    // 소셜 링크(S-06): U의 두 페르소나에 하나씩, T에 하나(남아야 함).
    await tx.insert(socialLinks).values([
      { personaId: realPersona!.id, userId: U.id, provider: 'github', url: 'https://github.com/u-real' },
      { personaId: displayPersona!.id, userId: U.id, provider: 'blog', url: 'https://u-display.example.com/', verification: 'verified', verifiedAt: NOW },
      { personaId: tPersona!.id, userId: T.id, provider: 'github', url: 'https://github.com/t' },
    ])
    const uTeamLog = await log(tx, team.id, U.id, 'U가 쓴 팀 로그')
    const tTeamLog = await log(tx, team.id, T.id, 'T가 쓴 팀 로그')
    const teamFile = await file(tx, team.id, U.id)
    const uClaim = await claim(tx, team.id, U.id, 'API 설계')
    const tClaim = await claim(tx, team.id, T.id, '화면 구현')
    await tx.insert(endorsements).values([
      { claimRevisionId: uClaim.revisionId, endorserId: T.id, status: 'confirmed' },
      { claimRevisionId: tClaim.revisionId, endorserId: U.id, status: 'confirmed', note: '내 개인적인 메모' },
    ])
    await tx.insert(weeklyCheckins).values({ projectId: team.id, userId: U.id, isoWeek: '2027-W09', timeBucket: 'lt5h', difficulty: 3, note: '이번 주 힘들었음' })
    const teamPub = await publish(tx, team.id, U.id, [U.id, T.id])

    // 과목 허브·포트폴리오
    const [school] = await tx.insert(schools).values({ name: `학교 ${id()}`, nameKey: `school-${id()}` }).returning()
    const [course] = await tx.insert(courses).values({ schoolId: school!.id, title: '자료구조', titleKey: `ds-${id()}` }).returning()
    const [note] = await tx
      .insert(seniorNotes)
      .values({ courseId: course!.id, authorId: U.id, displayMode: 'name', displayNameSnapshot: U.name, answers: { firstWeek: '노트 본문' }, noAnswersConfirmed: true, status: 'published', publishedAt: NOW })
      .returning()
    await tx.insert(usefulnessSignals).values({ userId: X.id, targetKind: 'senior_note', seniorNoteId: note!.id, kind: 'helped' })
    await tx.insert(usefulnessSignals).values({ userId: U.id, targetKind: 'stuck_item', publicationId: teamPub.publication.id, itemKey: 'l_x', kind: 'me_too' })
    const [caseStudy] = await tx
      .insert(caseStudies)
      .values({ userId: U.id, publicationId: teamPub.publication.id, releaseId: teamPub.release.id, releaseVersion: 1, memberKey: 'm_a', selfAnonymous: false, jobTarget: 'backend', title: '내 케이스' })
      .returning()
    await tx.insert(portfolioEditions).values([
      { userId: U.id, personaId: realPersona!.id, version: 1, headline: '포트폴리오' },
      { userId: U.id, personaId: displayPersona!.id, version: 1, headline: '표시명 판' },
    ])
    // 학교 메일 인증(C-01): active 하나 + 코드가 남은 pending 하나. T의 인증은 그대로 남아야 합니다.
    const hex = () => id().replace(/-/g, '').repeat(2)
    const [school2] = await tx.insert(schools).values({ name: `학교 ${id()}`, nameKey: `school-${id()}` }).returning()
    const [activeAff, pendingAff, tAff] = await tx
      .insert(institutionAffiliations)
      .values([
        { userId: U.id, schoolId: school!.id, emailHash: hex(), emailDomain: 'u.ac.kr', standing: 'alumni', departmentLabel: '비밀학과', status: 'active', verifiedAt: NOW },
        { userId: U.id, schoolId: school2!.id, emailHash: hex(), emailDomain: 'u.ac.kr', standing: 'student', status: 'pending' },
        { userId: T.id, schoolId: school!.id, emailHash: hex(), emailDomain: 'u.ac.kr', standing: 'student', status: 'active', verifiedAt: NOW },
      ])
      .returning()
    await tx.insert(affiliationCodes).values([
      { affiliationId: activeAff!.id, codeHash: hex(), expiresAt: NOW, usedAt: NOW },
      { affiliationId: pendingAff!.id, codeHash: hex(), expiresAt: NOW },
    ])
    return {
      tAffiliationId: tAff!.id, displayPersonaId: displayPersona!.id, tPersonaId: tPersona!.id, U, T, X, solo, soloLog, soloFile, soloPub, forkedSolo, forkedPub, xProject, team, uTeamLog, tTeamLog, teamFile, teamPub, note: note!, caseStudy: caseStudy! }
  }

  const count = async (tx: DbExecutor, table: Parameters<DbExecutor['select']>[0] extends never ? never : any, where: any) =>
    ((await tx.select({ n: sql<number>`count(*)::int` }).from(table).where(where)) as Array<{ n: number }>)[0]!.n

  it('purges personal data and solo projects, keeps team history pseudonymized, withdraws live releases, and writes a ledger without personal data', async () => {
    await rollback(async (tx) => {
      const w = await world(tx)
      const counts = await purgeAccount(tx, deps(), w.U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({
        account: 1,
        profile: 2,
        personas: 2,
        identity_links: 1,
        visibility_settings: 1,
        project_listings: 2,
        follows: 2,
        blocks: 2,
        mutes: 2,
        social_links: 2,
        sessions: 1,
        auth_accounts: 1,
        magic_link_tokens: 1,
        integrations: 1,
        checkins: 1,
        signals: 1,
        analytics_events: 1,
        senior_notes: 1,
        case_studies: 1,
        portfolio_editions: 2,
        institution_affiliations: 2,
        affiliation_codes: 2,
        notes_scrubbed: 4,
        publications_withdrawn: 3,
        memberships: 1,
        ownership_transfers: 1,
        solo_projects: 2,
        tombstones: 1,
      })

      // 사용자 행: 가명 처리(팀 기록이 가리킴).
      const [u] = await tx.select().from(users).where(eq(users.id, w.U.id))
      expect(u).toMatchObject({ displayName: DELETED_DISPLAY_NAME, privateEmail: purgedEmailFor(w.U.id), status: 'deleted', analyticsOptOut: true })
      expect(u!.purgedAt).toEqual(NOW)
      for (const [table, where] of [
        [profiles, eq(profiles.userId, w.U.id)],
        [profiles, eq(profiles.personaId, w.displayPersonaId)],
        [personas, eq(personas.userId, w.U.id)],
        [identityLinks, eq(identityLinks.userId, w.U.id)],
        [projectListings, eq(projectListings.userId, w.U.id)],
        [follows, or(eq(follows.followerUserId, w.U.id), eq(follows.followeeUserId, w.U.id))],
        [blocks, or(eq(blocks.blockerUserId, w.U.id), eq(blocks.blockedUserId, w.U.id))],
        [mutes, or(eq(mutes.muterUserId, w.U.id), eq(mutes.mutedUserId, w.U.id))],
        [socialLinks, eq(socialLinks.userId, w.U.id)],
        [sessions, eq(sessions.userId, w.U.id)],
        [authAccounts, eq(authAccounts.userId, w.U.id)],
        [magicLinkTokens, eq(magicLinkTokens.email, w.U.email)],
        [integrations, eq(integrations.userId, w.U.id)],
        [weeklyCheckins, eq(weeklyCheckins.userId, w.U.id)],
        [seniorNotes, eq(seniorNotes.authorId, w.U.id)],
        [usefulnessSignals, eq(usefulnessSignals.seniorNoteId, w.note.id)],
        [caseStudies, eq(caseStudies.userId, w.U.id)],
        [portfolioEditions, eq(portfolioEditions.userId, w.U.id)],
        [analyticsEvents, eq(analyticsEvents.actorHash, hashSubject(ANALYTICS_PEPPER, w.U.id))],
        [institutionAffiliations, eq(institutionAffiliations.userId, w.U.id)],
      ] as const) {
        expect(await count(tx, table, where)).toBe(0)
      }
      expect(await count(tx, institutionAffiliations, eq(institutionAffiliations.id, w.tAffiliationId))).toBe(1)
      // U와 무관한 X → T 팔로우·X의 T 뮤트는 그대로.
      expect(await count(tx, follows, eq(follows.followeePersonaId, w.tPersonaId))).toBe(1)
      expect(await count(tx, mutes, eq(mutes.mutedPersonaId, w.tPersonaId))).toBe(1)
      expect(await count(tx, socialLinks, eq(socialLinks.personaId, w.tPersonaId))).toBe(1)

      // 혼자 과제 1: 행·파일 모두 없음.
      expect(await count(tx, projects, eq(projects.id, w.solo.id))).toBe(0)
      expect(await count(tx, logEntries, eq(logEntries.id, w.soloLog.id))).toBe(0)
      expect(await count(tx, publications, eq(publications.id, w.soloPub.publication.id))).toBe(0)
      expect(await storage.head(w.soloFile.key)).toBeNull()
      // 혼자 과제 2: X의 포크가 가리키므로 내용을 비운 묘비. X의 포크와 X의 과제는 그대로.
      const [forked] = await tx.select().from(projects).where(eq(projects.id, w.forkedSolo.id))
      expect(forked!.title).toBe('삭제된 과제')
      expect(await count(tx, logEntries, eq(logEntries.projectId, w.forkedSolo.id))).toBe(0)
      const [tomb] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, w.forkedPub.release.id))
      expect(tomb!.snapshot).toEqual({})
      const [forkedPublication] = await tx.select().from(publications).where(eq(publications.id, w.forkedPub.publication.id))
      expect(forkedPublication!.status).toBe('withdrawn')
      expect(await count(tx, planForks, eq(planForks.targetProjectId, w.xProject.id))).toBe(1)

      // 팀 과제: 기록 유지, owner는 T로, U는 removed, U가 남의 확인에 쓴 메모만 지움, 팀 파일 유지.
      const [team] = await tx.select().from(projects).where(eq(projects.id, w.team.id))
      expect(team!.ownerId).toBe(w.T.id)
      const members = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, w.team.id))
      expect(members.find((m) => m.userId === w.U.id)!.status).toBe('removed')
      expect(members.find((m) => m.userId === w.T.id)!.role).toBe('owner')
      expect(await count(tx, logEntries, eq(logEntries.id, w.uTeamLog.id))).toBe(1)
      expect(await count(tx, logEntries, eq(logEntries.id, w.tTeamLog.id))).toBe(1)
      expect(await count(tx, roleClaims, eq(roleClaims.userId, w.U.id))).toBe(1)
      const [uEndorsement] = await tx.select().from(endorsements).where(eq(endorsements.endorserId, w.U.id))
      expect(uEndorsement).toMatchObject({ status: 'confirmed', note: null })
      expect(await storage.head(w.teamFile.key)).not.toBeNull()
      expect(await count(tx, artifacts, eq(artifacts.id, w.teamFile.artifactId))).toBe(1)

      // 지금 release 철회(동의 철회와 같은 결과) + outbox, T의 동의는 그대로.
      const [teamPublication] = await tx.select().from(publications).where(eq(publications.id, w.teamPub.publication.id))
      expect(teamPublication).toMatchObject({ status: 'withdrawn', withdrawCause: 'consent_revoked', accessEpoch: 2 })
      const teamConsents = await tx.select().from(consents).where(eq(consents.candidateId, w.teamPub.release.id))
      expect(teamConsents.find((c) => c.subjectUserId === w.U.id)).toMatchObject({ status: 'revoked', note: null })
      expect(teamConsents.find((c) => c.subjectUserId === w.T.id)).toMatchObject({ status: 'granted', note: '좋아요' })
      expect(
        await count(tx, outboxEvents, and(eq(outboxEvents.topic, 'publication.withdrawn'), sql`${outboxEvents.payload}->>'publicationId' = ${w.teamPub.publication.id}`)),
      ).toBe(1)

      // 장부: 개수만, HMAC 대상, 개인정보 없음.
      const ledger = await tx.select().from(deletionLedger).where(eq(deletionLedger.subjectHash, hashSubject(DELETION_PEPPER, w.U.id)))
      expect(ledger.length).toBe(Object.keys(counts!).length)
      expect(ledger.every((r) => r.source === 'purge' && r.purgedAt.getTime() === NOW.getTime())).toBe(true)
      const text = JSON.stringify(ledger)
      for (const secret of [w.U.id, w.U.email, w.U.name, w.T.id, w.solo.id, w.team.id, '나만의 비밀 과제', 'SENTINEL', w.soloFile.versionId]) {
        expect(text).not.toContain(secret)
      }

      // 다시 정리해도 지울 것이 없고 장부도 그대로(idempotent).
      expect(await purgeAccount(tx, deps(), w.U.id, { now: NOW, source: 'reapply' })).toEqual({})
      expect(await count(tx, deletionLedger, eq(deletionLedger.subjectHash, hashSubject(DELETION_PEPPER, w.U.id)))).toBe(ledger.length)
    })
  })

  it('purges community memberships, invitations and official-page requests, passing room ownership on (C-02)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴방장', 'deleted')
      const A = await user(tx, '오래된운영진')
      const M = await user(tx, '멤버')
      const [school] = await tx.insert(schools).values({ name: `정리대${id().slice(0, 8)}`, nameKey: `정리대${id().slice(0, 8)}` }).returning()
      const slug = () => id().replace(/-/g, '').slice(0, 10)
      const [withHeirs] = await tx.insert(communitySpaces).values({ kind: 'user_room', name: '승계 방', slug: slug(), currentNameMode: 'display', createdBy: U.id }).returning()
      const [alone] = await tx.insert(communitySpaces).values({ kind: 'user_room', name: '혼자 방', slug: slug(), currentNameMode: 'display', createdBy: U.id }).returning()
      const t = (d: number) => new Date(NOW.getTime() - d * DAY)
      await tx.insert(spaceMemberships).values([
        { spaceId: withHeirs!.id, userId: U.id, role: 'owner', status: 'active', joinedAt: t(30) },
        { spaceId: withHeirs!.id, userId: M.id, role: 'member', status: 'active', joinedAt: t(20) },
        { spaceId: withHeirs!.id, userId: A.id, role: 'admin', status: 'active', joinedAt: t(10) },
        { spaceId: alone!.id, userId: U.id, role: 'owner', status: 'active', joinedAt: t(5) },
        { spaceId: alone!.id, userId: M.id, role: 'member', status: 'pending', requestedAt: t(1) },
      ])
      await tx.insert(spaceInvitations).values([
        { spaceId: withHeirs!.id, tokenHash: 'a'.repeat(64), createdBy: U.id, expiresAt: NOW },
        { spaceId: withHeirs!.id, tokenHash: 'b'.repeat(64), createdBy: A.id, expiresAt: NOW },
      ])
      await tx.insert(officialPageRequests).values({ schoolId: school!.id, requesterId: U.id })
      await tx.insert(officialPageRequests).values({ schoolId: school!.id, requesterId: A.id, source: 'student_council', sourceMarkedBy: U.id })

      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ space_owner_transfers: 1, spaces_archived: 1, space_memberships: 2, space_invitations: 1, official_page_requests: 1 })
      // 가장 오래된 admin이 방장(멤버가 더 먼저 들어왔어도 admin 우선)
      const heirs = await tx.select().from(spaceMemberships).where(eq(spaceMemberships.spaceId, withHeirs!.id))
      expect(heirs.map((m) => [m.userId, m.role, m.status]).sort()).toEqual([[A.id, 'owner', 'active'], [M.id, 'member', 'active']].sort())
      const [archived] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, alone!.id))
      expect(archived).toMatchObject({ status: 'archived' })
      expect((await tx.select().from(spaceMemberships).where(eq(spaceMemberships.spaceId, alone!.id))).map((m) => m.status)).toEqual(['left'])
      expect(await count(tx, spaceMemberships, eq(spaceMemberships.userId, U.id))).toBe(0)
      expect(await count(tx, spaceInvitations, eq(spaceInvitations.createdBy, U.id))).toBe(0)
      expect(await count(tx, officialPageRequests, eq(officialPageRequests.requesterId, U.id))).toBe(0)
      const [kept] = await tx.select().from(officialPageRequests).where(eq(officialPageRequests.requesterId, A.id))
      expect(kept).toMatchObject({ source: 'student_council', sourceMarkedBy: null })
      const ledger = await tx.select().from(deletionLedger).where(eq(deletionLedger.subjectHash, hashSubject(DELETION_PEPPER, U.id)))
      expect(ledger.map((l) => l.entityKind)).toEqual(expect.arrayContaining(['space_memberships', 'space_invitations', 'official_page_requests', 'spaces_archived']))
      // 공간 행은 가명 처리된 사용자를 가리킨 채 남음
      expect(await count(tx, communitySpaces, eq(communitySpaces.createdBy, U.id))).toBe(2)
      expect(await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'reapply' })).toEqual({})
    })
  })

  it('study records follow the room: the purged owner\'s successor becomes project owner, records stay pseudonymized; a solo record is deleted with its link (C-08)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴스터디장', 'deleted')
      const M = await user(tx, '스터디멤버')
      const slug = () => id().replace(/-/g, '').slice(0, 10)
      const t = (d: number) => new Date(NOW.getTime() - d * DAY)
      const [room] = await tx.insert(communitySpaces).values({ kind: 'study_room', name: '스터디', slug: slug(), currentNameMode: 'display', joinPolicy: 'invite', discovery: 'unlisted', createdBy: U.id }).returning()
      const [soloRoom] = await tx.insert(communitySpaces).values({ kind: 'study_room', name: '혼자 스터디', slug: slug(), currentNameMode: 'anonymous', joinPolicy: 'invite', discovery: 'unlisted', createdBy: U.id }).returning()
      await tx.insert(spaceMemberships).values([
        { spaceId: room!.id, userId: U.id, role: 'owner', status: 'active', joinedAt: t(30) },
        { spaceId: room!.id, userId: M.id, role: 'member', status: 'active', joinedAt: t(20) },
        { spaceId: soloRoom!.id, userId: U.id, role: 'owner', status: 'active', joinedAt: t(10) },
      ])
      const [record] = await tx.insert(projects).values({ ownerId: U.id, title: '스터디 기록', kind: 'study', studyNameMode: 'display' }).returning()
      await tx.insert(projectMembers).values([
        { projectId: record!.id, userId: U.id, role: 'owner' },
        { projectId: record!.id, userId: M.id, role: 'editor' },
      ])
      const [solo] = await tx.insert(projects).values({ ownerId: U.id, title: '혼자 스터디 기록', kind: 'study', studyNameMode: 'anonymous' }).returning()
      await tx.insert(projectMembers).values({ projectId: solo!.id, userId: U.id, role: 'owner' })
      await tx.insert(studyRecords).values([
        { spaceId: room!.id, projectId: record!.id, enabledBy: U.id },
        { spaceId: soloRoom!.id, projectId: solo!.id, enabledBy: U.id },
      ])
      const kept = await log(tx, record!.id, U.id, '1주차 정리')
      await log(tx, solo!.id, U.id, '혼자 정리')

      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ space_owner_transfers: 1, spaces_archived: 1, study_record_syncs: 2, solo_projects: 1 })
      // 방장 승계(M) → 과제 owner도 M, 탈퇴한 사람의 과제 멤버십은 removed, 기록은 남음(작성자는 가명 처리된 users 행)
      const [p] = await tx.select().from(projects).where(eq(projects.id, record!.id))
      expect(p!.ownerId).toBe(M.id)
      const members = await tx.select().from(projectMembers).where(eq(projectMembers.projectId, record!.id))
      expect(members.map((m) => [m.userId, m.role, m.status]).sort()).toEqual([[M.id, 'owner', 'active'], [U.id, 'editor', 'removed']].sort())
      expect(await count(tx, logEntries, eq(logEntries.id, kept.id))).toBe(1)
      const [pseudo] = await tx.select().from(users).where(eq(users.id, U.id))
      expect(pseudo!.displayName).toBe(DELETED_DISPLAY_NAME)
      expect(await count(tx, studyRecords, eq(studyRecords.projectId, record!.id))).toBe(1)
      // 혼자였던 기록: 과제와 방 연결을 함께 지움(방은 보관됨)
      expect(await count(tx, projects, eq(projects.id, solo!.id))).toBe(0)
      expect(await count(tx, studyRecords, eq(studyRecords.spaceId, soloRoom!.id))).toBe(0)
      const [archived] = await tx.select().from(communitySpaces).where(eq(communitySpaces.id, soloRoom!.id))
      expect(archived!.status).toBe('archived')
      expect(await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'reapply' })).toEqual({})
    })
  })

  it('purges received community notices and the real name; name-mode history stays with requester/canceller nulled (C-03)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴방장', 'deleted')
      const M = await user(tx, '남는멤버')
      await tx.update(users).set({ realName: '김탈퇴' }).where(eq(users.id, U.id))
      const [room] = await tx
        .insert(communitySpaces)
        .values({ kind: 'user_room', name: '이력 방', slug: id().replace(/-/g, '').slice(0, 10), currentNameMode: 'real', createdBy: U.id })
        .returning()
      await tx.insert(spaceMemberships).values([
        { spaceId: room!.id, userId: U.id, role: 'owner', status: 'active', joinedAt: new Date(NOW.getTime() - 30 * DAY) },
        { spaceId: room!.id, userId: M.id, role: 'member', status: 'active', joinedAt: new Date(NOW.getTime() - 20 * DAY) },
      ])
      const requestedAt = new Date(NOW.getTime() - 20 * DAY)
      const [applied] = await tx
        .insert(nameModeChanges)
        .values({ spaceId: room!.id, fromMode: 'anonymous', toMode: 'real', requestedBy: U.id, requestedAt, effectiveAt: new Date(requestedAt.getTime() + 7 * DAY), status: 'applied', appliedAt: NOW })
        .returning()
      const [cancelled] = await tx
        .insert(nameModeChanges)
        .values({ spaceId: room!.id, fromMode: 'real', toMode: 'display', requestedBy: M.id, requestedAt, effectiveAt: new Date(requestedAt.getTime() + 7 * DAY), status: 'cancelled', cancelledAt: NOW, cancelledBy: U.id })
        .returning()
      const payload = { fromMode: 'anonymous', toMode: 'real', effectiveAt: applied!.effectiveAt.toISOString() }
      await tx.insert(communityNotices).values([
        { userId: U.id, spaceId: room!.id, kind: 'name_mode_applied', nameModeChangeId: applied!.id, payload },
        { userId: M.id, spaceId: room!.id, kind: 'name_mode_applied', nameModeChangeId: applied!.id, payload },
      ])

      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ community_notices: 1, name_mode_change_actors: 2, account: 1 })
      expect(await count(tx, communityNotices, eq(communityNotices.userId, U.id))).toBe(0)
      expect(await count(tx, communityNotices, eq(communityNotices.userId, M.id))).toBe(1)
      const history = await tx.select().from(nameModeChanges).where(eq(nameModeChanges.spaceId, room!.id))
      expect(history).toHaveLength(2)
      expect(history.find((h) => h.id === applied!.id)).toMatchObject({ requestedBy: null, status: 'applied' })
      expect(history.find((h) => h.id === cancelled!.id)).toMatchObject({ requestedBy: M.id, cancelledBy: null, status: 'cancelled' })
      const [row] = await tx.select().from(users).where(eq(users.id, U.id))
      expect(row).toMatchObject({ realName: null, displayName: DELETED_DISPLAY_NAME })
      expect(await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'reapply' })).toEqual({})
    })
  })

  it('purges community posts and comments: rows and thread numbers stay, text is cleared, reactions go (C-04)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴글쓴이', 'deleted')
      const M = await user(tx, '남는멤버')
      const [room] = await tx
        .insert(communitySpaces)
        .values({ kind: 'user_room', name: '글 방', slug: id().replace(/-/g, '').slice(0, 10), currentNameMode: 'anonymous', createdBy: M.id })
        .returning()
      const [board] = await tx.insert(boards).values({ spaceId: room!.id, kind: 'general', title: '게시판', position: 0 }).returning()
      const [anon] = await tx
        .insert(communityPosts)
        .values({ boardId: board!.id, spaceId: room!.id, authorId: U.id, nameMode: 'anonymous', title: '익명 글', body: '지울 본문' })
        .returning()
      const [named] = await tx
        .insert(communityPosts)
        .values({ boardId: board!.id, spaceId: room!.id, authorId: U.id, nameMode: 'display', title: '표시명 글', body: '지울 본문', status: 'hidden' })
        .returning()
      const [other] = await tx
        .insert(communityPosts)
        .values({ boardId: board!.id, spaceId: room!.id, authorId: M.id, nameMode: 'anonymous', title: '남의 글', body: '남는 본문' })
        .returning()
      await tx.insert(threadAliases).values([
        { postId: anon!.id, userId: U.id, aliasNo: 0 },
        { postId: anon!.id, userId: M.id, aliasNo: 1 },
        { postId: other!.id, userId: M.id, aliasNo: 0 },
        { postId: other!.id, userId: U.id, aliasNo: 1 },
      ])
      const [uComment] = await tx.insert(communityComments).values({ postId: other!.id, authorId: U.id, nameMode: 'anonymous', body: '지울 댓글' }).returning()
      const [mComment] = await tx.insert(communityComments).values({ postId: anon!.id, authorId: M.id, nameMode: 'anonymous', body: '남는 댓글' }).returning()
      await tx.insert(communityReactions).values([
        { postId: other!.id, userId: U.id },
        { commentId: mComment!.id, userId: U.id },
        { postId: anon!.id, userId: M.id },
        { commentId: uComment!.id, userId: M.id },
      ])

      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ community_posts: 2, community_comments: 1, community_reactions: 4 })
      const posts = await tx.select().from(communityPosts).where(eq(communityPosts.authorId, U.id))
      expect(posts.map((p) => ({ status: p.status, title: p.title, body: p.body, nameMode: p.nameMode })).sort((a, b) => a.nameMode.localeCompare(b.nameMode))).toEqual([
        { status: 'deleted_by_author', title: '', body: '', nameMode: 'anonymous' },
        { status: 'deleted_by_author', title: '', body: '', nameMode: 'display' },
      ])
      expect((await tx.select().from(communityComments).where(eq(communityComments.id, uComment!.id)))[0]).toMatchObject({ status: 'deleted_by_author', body: '' })
      // 남의 글·댓글은 그대로, 스레드 번호는 모두 남음(다른 참여자의 번호가 바뀌지 않게)
      expect((await tx.select().from(communityPosts).where(eq(communityPosts.id, other!.id)))[0]).toMatchObject({ body: '남는 본문', status: 'published' })
      expect((await tx.select().from(communityComments).where(eq(communityComments.id, mComment!.id)))[0]).toMatchObject({ body: '남는 댓글' })
      expect(await count(tx, threadAliases, eq(threadAliases.userId, U.id))).toBe(2)
      expect(await count(tx, communityReactions, eq(communityReactions.userId, U.id))).toBe(0)
      expect(await count(tx, communityReactions, eq(communityReactions.userId, M.id))).toBe(0)
      // 지워도 다시 돌리면 바꿀 것이 없음
      expect(await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'reapply' })).toEqual({})
    })
  })

  it('clears the write-time persona of the user\'s posts/comments and deletes persona activities before the personas (S-02)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴실명글쓴이', 'deleted')
      const M = await user(tx, '방장')
      const [real] = await tx.insert(personas).values({ userId: U.id, kind: 'real', handle: `s02-${id().slice(0, 8)}` }).returning()
      const [room] = await tx
        .insert(communitySpaces)
        .values({ kind: 'user_room', name: '실명 방', slug: id().replace(/-/g, '').slice(0, 10), currentNameMode: 'real', createdBy: M.id })
        .returning()
      const [board] = await tx.insert(boards).values({ spaceId: room!.id, kind: 'general', title: '게시판', position: 0 }).returning()
      const [post] = await tx
        .insert(communityPosts)
        .values({ boardId: board!.id, spaceId: room!.id, authorId: U.id, nameMode: 'real', personaId: real!.id, title: '실명 글', body: '본문' })
        .returning()
      await tx.insert(communityComments).values({ postId: post!.id, authorId: U.id, nameMode: 'real', personaId: real!.id, body: '실명 댓글' })
      await tx.insert(personaActivities).values({ personaId: real!.id, sourceType: 'community_post', sourceId: post!.id, itemKind: 'posts' })
      // S-05(ADR 0035): 프로필 글(게시 중·지운 글)과 그 활동도 지웁니다.
      const [profilePost] = await tx.insert(profilePosts).values({ personaId: real!.id, userId: U.id, body: '프로필 글' }).returning()
      await tx.insert(profilePosts).values({ personaId: real!.id, userId: U.id, body: '', status: 'deleted', deletedAt: NOW })
      await tx.insert(personaActivities).values({ personaId: real!.id, sourceType: 'profile_post', sourceId: profilePost!.id, itemKind: 'posts' })

      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ personas: 1, persona_activities: 2, profile_posts: 2, community_persona_refs: 2, community_posts: 1, community_comments: 1 })
      expect(await count(tx, profilePosts, eq(profilePosts.userId, U.id))).toBe(0)
      expect(await count(tx, personas, eq(personas.userId, U.id))).toBe(0)
      expect(await count(tx, personaActivities, eq(personaActivities.sourceId, post!.id))).toBe(0)
      expect((await tx.select().from(communityPosts).where(eq(communityPosts.id, post!.id)))[0]).toMatchObject({ personaId: null, status: 'deleted_by_author', nameMode: 'real' })
      expect((await tx.select().from(communityComments).where(eq(communityComments.postId, post!.id)))[0]).toMatchObject({ personaId: null })
    })
  })

  it('purges sanctions about the user, nulls the looked-up author on lookup records, scrubs their sanction-request details (C-06)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴제재대상', 'deleted')
      const O = await user(tx, '운영자')
      await tx.insert(operators).values({ userId: O.id })
      const M = await user(tx, '방장')
      const [room] = await tx
        .insert(communitySpaces)
        .values({ kind: 'user_room', name: '제재 방', slug: id().replace(/-/g, '').slice(0, 10), currentNameMode: 'anonymous', createdBy: M.id })
        .returning()
      const [board] = await tx.insert(boards).values({ spaceId: room!.id, kind: 'general', title: '게시판', position: 0 }).returning()
      const [post] = await tx.insert(communityPosts).values({ boardId: board!.id, spaceId: room!.id, authorId: U.id, nameMode: 'anonymous', title: '글', body: '본문' }).returning()
      const [mPost] = await tx.insert(communityPosts).values({ boardId: board!.id, spaceId: room!.id, authorId: M.id, nameMode: 'anonymous', title: '방장 글', body: '본문' }).returning()
      const [request] = await tx
        .insert(communitySanctionRequests)
        .values({ spaceId: room!.id, requestedBy: M.id, postId: post!.id, targetKey: `community_post:${post!.id}`, reason: 'harassment', details: '반복 비방' })
        .returning()
      // 탈퇴자 U가 운영진으로서 남의 글에 쓴 요청(설명만 지움)
      const [uRequest] = await tx
        .insert(communitySanctionRequests)
        .values({ spaceId: room!.id, requestedBy: U.id, postId: mPost!.id, targetKey: `community_post:${mPost!.id}`, reason: 'spam', details: '탈퇴자가 쓴 설명' })
        .returning()
      const [lookup] = await tx
        .insert(communityAuthorLookups)
        .values({ operatorId: O.id, targetType: 'post', postId: post!.id, authorId: U.id, reason: '요청 검토', requestId: request!.id })
        .returning()
      const [action] = await tx
        .insert(moderationActions)
        .values({ kind: 'sanction', outcome: 'resolved', targetType: 'community_post', targetKey: `community_post:${post!.id}`, communityPostId: post!.id, internalNote: '메모', publicReason: '사유', notifyOwner: true, createdBy: O.id })
        .returning()
      await tx.insert(communitySanctions).values({ userId: U.id, scope: 'space', spaceId: room!.id, level: 'write_suspended', until: new Date(NOW.getTime() + 7 * DAY), actionId: action!.id, lookupId: lookup!.id, requestId: request!.id, issuedBy: O.id })

      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ community_sanctions: 1, community_author_lookup_subjects: 1, sanction_request_details: 1 })
      expect(await count(tx, communitySanctions, eq(communitySanctions.userId, U.id))).toBe(0)
      // 확인 기록(운영자의 접근 기록)은 남고 확인된 작성자 칸만 비움. 짝인 운영 조치 행도 남음.
      expect((await tx.select().from(communityAuthorLookups).where(eq(communityAuthorLookups.id, lookup!.id)))[0]).toMatchObject({ authorId: null, operatorId: O.id, reason: '요청 검토' })
      expect(await count(tx, moderationActions, eq(moderationActions.id, action!.id))).toBe(1)
      // 남이 쓴 요청은 그대로, 탈퇴자가 쓴 요청은 설명만 지움
      expect((await tx.select().from(communitySanctionRequests).where(eq(communitySanctionRequests.id, request!.id)))[0]).toMatchObject({ details: '반복 비방' })
      expect((await tx.select().from(communitySanctionRequests).where(eq(communitySanctionRequests.id, uRequest!.id)))[0]).toMatchObject({ details: null, requestedBy: U.id })
      expect(await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'reapply' })).toEqual({})
    })
  })

  it('pseudonymizes a purged operator\'s weekly ops time: notes cleared, minutes kept for weekly totals (C-10)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴운영자', 'deleted')
      const O = await user(tx, '남은운영자')
      await tx.insert(operators).values([{ userId: U.id }, { userId: O.id }])
      await tx.insert(opsTimeEntries).values([
        { operatorId: U.id, week: '2027-W09', reportsMinutes: 90, curationMinutes: 15, note: '탈퇴자 메모 SENTINEL' },
        { operatorId: U.id, week: '2027-W10', otherMinutes: 30 },
        { operatorId: O.id, week: '2027-W09', reportsMinutes: 60, note: '남은 사람 메모' },
      ])
      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ notes_scrubbed: 1 })
      const rows = await tx.select().from(opsTimeEntries).where(eq(opsTimeEntries.operatorId, U.id))
      expect(rows.map((r) => [r.week, r.reportsMinutes, r.curationMinutes, r.otherMinutes, r.note]).sort()).toEqual([
        ['2027-W09', 90, 15, 0, null],
        ['2027-W10', 0, 0, 30, null],
      ])
      expect(JSON.stringify(rows)).not.toContain('SENTINEL')
      expect((await tx.select().from(opsTimeEntries).where(eq(opsTimeEntries.operatorId, O.id)))[0]!.note).toBe('남은 사람 메모')
      // 다시 정리해도 바뀌는 것이 없음
      expect(await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'reapply' })).toEqual({})
    })
  })

  it('purges recruitments: applications go (scrubbed if a report points at them), own open recruitments are cancelled with notices, texts cleared (C-07)', async () => {
    await rollback(async (tx) => {
      const U = await user(tx, '탈퇴모집자', 'deleted')
      const A = await user(tx, '지원자')
      const B = await user(tx, '다른모집자')
      const [school] = await tx.insert(schools).values({ name: `모집대${id().slice(0, 8)}`, nameKey: `모집대${id().slice(0, 8)}` }).returning()
      const [course] = await tx.insert(courses).values({ schoolId: school!.id, title: '운영체제', titleKey: `os${id().slice(0, 8)}` }).returning()
      // U가 올린 모집 둘(모집 중·마감), B가 올린 모집에 U가 낸 지원 둘(하나는 신고됨)
      const [open] = await tx.insert(recruitments).values({ kind: 'study', courseId: course!.id, title: '탈퇴자 스터디 모집', description: '소개', capacity: 3, roomNameMode: 'display', createdBy: U.id }).returning()
      const [closed] = await tx
        .insert(recruitments)
        .values({ kind: 'study', courseId: course!.id, title: '마감된 모집', description: '소개', capacity: 3, roomNameMode: 'display', createdBy: U.id, status: 'closed', closedAt: NOW })
        .returning()
      await tx.insert(recruitmentApplications).values({ recruitmentId: open!.id, applicantId: A.id, message: '지원합니다' })
      const [other] = await tx.insert(recruitments).values({ kind: 'team', courseId: course!.id, title: 'B 모집', capacity: 2, createdBy: B.id }).returning()
      const [other2] = await tx.insert(recruitments).values({ kind: 'team', courseId: course!.id, title: 'B 모집 2', capacity: 2, createdBy: B.id }).returning()
      const [plain] = await tx.insert(recruitmentApplications).values({ recruitmentId: other!.id, applicantId: U.id, message: '탈퇴자 메시지', profileHandle: 'quit-user' }).returning()
      const [reported] = await tx.insert(recruitmentApplications).values({ recruitmentId: other2!.id, applicantId: U.id, message: '신고된 메시지', caseSlugs: ['some-case'] }).returning()
      await tx.insert(reports).values({ reporterId: B.id, targetType: 'community_application', targetKey: `community_application:${reported!.id}`, communityApplicationId: reported!.id, reason: 'spam' })

      const counts = await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'purge' })
      expect(counts).toMatchObject({ recruitment_applications: 2, recruitments_cancelled: 1, recruitment_texts: 2 })
      expect(await count(tx, recruitmentApplications, eq(recruitmentApplications.id, plain!.id))).toBe(0)
      expect((await tx.select().from(recruitmentApplications).where(eq(recruitmentApplications.id, reported!.id)))[0]).toMatchObject({
        message: '',
        profileHandle: null,
        caseSlugs: [],
        status: 'withdrawn',
      })
      const mine = await tx.select().from(recruitments).where(eq(recruitments.createdBy, U.id))
      expect(mine.map((r) => [r.id === open!.id ? 'open' : 'closed', r.status, r.title, r.description]).sort()).toEqual(
        [
          ['closed', 'closed', '', ''],
          ['open', 'cancelled', '', ''],
        ].sort(),
      )
      // 모집 중이던 모집의 지원자에게 취소 알림(종류만)
      const notices = await tx.select().from(communityNotices).where(eq(communityNotices.userId, A.id))
      expect(notices.map((n) => [n.kind, n.recruitmentId, n.payload])).toEqual([['recruitment_cancelled', open!.id, { recruitmentKind: 'study' }]])
      const ledger = await tx.select().from(deletionLedger).where(eq(deletionLedger.subjectHash, hashSubject(DELETION_PEPPER, U.id)))
      expect(ledger.map((l) => l.entityKind)).toEqual(expect.arrayContaining(['recruitment_applications', 'recruitments_cancelled', 'recruitment_texts']))
      expect(await count(tx, recruitments, eq(recruitments.id, closed!.id))).toBe(1)
      expect(await purgeAccount(tx, deps(), U.id, { now: NOW, source: 'reapply' })).toEqual({})
    })
  })

  it('purges only accounts past the grace period and never active ones', async () => {
    await rollback(async (tx) => {
      const w = await world(tx)
      const recent = await user(tx, '최근탈퇴', 'deleted')
      await tx.update(users).set({ deletionRequestedAt: new Date(NOW.getTime() - DAY) }).where(eq(users.id, recent.id))
      const outcome = await purgeDueAccounts(tx, deps(), { now: NOW, graceDays: 7, limit: 50 })
      expect(outcome.affected).toBeGreaterThanOrEqual(1)
      const [u] = await tx.select().from(users).where(eq(users.id, w.U.id))
      const [r] = await tx.select().from(users).where(eq(users.id, recent.id))
      expect(u!.purgedAt).not.toBeNull()
      expect(r!.purgedAt).toBeNull()
      expect(await purgeAccount(tx, deps(), w.T.id, { now: NOW, source: 'purge' })).toBeNull()
      const [t] = await tx.select().from(users).where(eq(users.id, w.T.id))
      expect(t!.displayName).toBe('이팀원')
    })
  })

  it('re-applies deletions after a restore (from an exported ledger), idempotently', async () => {
    await rollback(async (tx) => {
      const w = await world(tx)
      await purgeAccount(tx, deps(), w.U.id, { now: NOW, source: 'purge' })
      const subject = hashSubject(DELETION_PEPPER, w.U.id)
      const entries = (await exportLedger(tx)).filter((e) => e.subjectHash === subject)
      expect(formatLedgerLines(entries)).not.toContain(w.U.id)

      // 오래된 백업을 복구한 것처럼: 계정이 active로, 프로필·세션·혼자 과제가 다시 나타남. 복구된 DB의 장부에는 이 항목이 없음.
      await tx.delete(deletionLedger).where(eq(deletionLedger.subjectHash, subject))
      await tx.update(users).set({ status: 'active', displayName: w.U.name, privateEmail: w.U.email, purgedAt: null }).where(eq(users.id, w.U.id))
      const restoredHandle = `u-${id().slice(0, 8)}`
      const [restored] = await tx.insert(personas).values({ userId: w.U.id, kind: 'real', handle: restoredHandle }).returning()
      await tx.insert(profiles).values({ personaId: restored!.id, personaKind: 'real', userId: w.U.id, handle: restoredHandle })
      await tx.insert(sessions).values({ id: `s-${id()}`, secretHash: 'h', userId: w.U.id, expiresAt: new Date(NOW.getTime() + DAY) })
      const reappeared = await project(tx, w.U.id, '복구로 다시 나타난 과제')
      await log(tx, reappeared.id, w.U.id, '다시 나타난 로그')

      const dry = await reapplyDeletions(tx, deps(), { entries, now: NOW, dryRun: true })
      expect(dry).toMatchObject({ subjects: 1, matched: 1, repurged: 0, imported: 0 })
      expect(await count(tx, profiles, eq(profiles.userId, w.U.id))).toBe(1)

      const first = await reapplyDeletions(tx, deps(), { entries, now: NOW })
      expect(first).toMatchObject({ subjects: 1, matched: 1, repurged: 1, imported: entries.length })
      expect(first.counts).toMatchObject({ account: 1, profile: 1, sessions: 1, solo_projects: 1 })
      expect(await count(tx, profiles, eq(profiles.userId, w.U.id))).toBe(0)
      expect(await count(tx, projects, eq(projects.id, reappeared.id))).toBe(0)
      const [u] = await tx.select().from(users).where(eq(users.id, w.U.id))
      expect(u).toMatchObject({ status: 'deleted', displayName: DELETED_DISPLAY_NAME })
      const reapplyRows = await tx.select().from(deletionLedger).where(and(eq(deletionLedger.subjectHash, subject), eq(deletionLedger.source, 'reapply')))
      expect(reapplyRows.length).toBeGreaterThan(0)

      // 두 번째 재적용: 바뀌는 것 없음, 장부 행도 늘지 않음.
      const before = await count(tx, deletionLedger, eq(deletionLedger.subjectHash, subject))
      const second = await reapplyDeletions(tx, deps(), { entries, now: NOW })
      expect(second).toMatchObject({ matched: 1, repurged: 0, imported: 0, counts: {} })
      expect(await count(tx, deletionLedger, eq(deletionLedger.subjectHash, subject))).toBe(before)
      // 다른 pepper로는 아무도 맞추지 못합니다.
      expect((await reapplyDeletions(tx, { ...deps(), deletionPepper: `${DELETION_PEPPER}-other` }, { entries, now: NOW, dryRun: true })).matched).toBe(0)
    })
  })
})
