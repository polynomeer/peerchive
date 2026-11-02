/**
 * 익명 스터디 기록의 사용자 id 가명화(ADR 0026 부록) 통합 테스트.
 *
 * - 누출 검사: 익명 스터디 기록(방장 A, 멤버 B·C)에서 B가 A와 익명이 아닌 팀 과제를 함께 쓰고(거기서는 A가 B의 실제 id·이름을 봄),
 *   A로 기록의 **모든** 과제 경로(아래 ROUTES — 라우트 트리에서 자동으로 나열해 분류하지 않은 경로가 있으면 실패)를 부른 응답·오류에
 *   B·C의 실제 사용자 id·handle·이메일·이름이 없음을 확인합니다.
 * - 입력: 할 일 담당자·회의 참석자·공개 노출 방식·로그 작성자 필터가 가명 키를 받아 실제 id로 저장하고, 모르는 키·다른 사람의 실제 id는 422.
 * - 익명이 아닌 스터디 기록·일반 과제는 그대로(실제 id 입출력).
 * 각 DB 테스트는 rollback 트랜잭션 안에서 자기가 만든 데이터만 봅니다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join, relative } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFakeAiProvider } from '@peerchive/ai'
import { artifactVersions, artifacts, eq, logEntries, logRevisions, publicationCandidates, tasks, type DbExecutor } from '@peerchive/db'
import { type ObjectStorage, createFilesystemStorage } from '@peerchive/files'
import {
  completeUpload,
  createUploadIntent,
  getArtifact,
  listArtifacts,
  openArtifactContent,
  receiveUpload,
  retryArtifactScan,
} from '../server/modules/artifacts/artifacts'
import { saveMyCheckin, getMyCheckin, listCheckins, myCheckinStatus } from '../server/modules/checkins/checkins'
import { setAiProviderForTesting } from '../server/modules/ai/ai'
import {
  answerAiRetro,
  approveAiRetroDraft,
  discardAiRetroDraft,
  discardAiRetroSession,
  getAiRetroState,
  setAiRetroOptIn,
  startAiRetroSession,
} from '../server/modules/ai/retro-interview'
import { createCourse, createSchool } from '../server/modules/catalog/catalog'
import { acceptSpaceInvitation, createSpaceInvitation } from '../server/modules/community/invitations'
import { createStudyRoomInternal } from '../server/modules/community/spaces'
import { enableStudyRecord } from '../server/modules/community/study-records'
import { createClaim, listClaimRevisions, listClaims, reviseClaim, setEndorsement, withdrawEndorsement } from '../server/modules/contribution/claims'
import { getContribution, recordReportExport } from '../server/modules/contribution/ledger'
import { createBindCode, listBindings, unbindChannel, updateBinding } from '../server/modules/discord/bindings'
import type { GithubClient } from '../server/modules/github/client'
import type { GithubAppConfig } from '../server/modules/github/config'
import { getProjectGithub, linkRepository, startInstall, unlinkRepository } from '../server/modules/github/connect'
import { listGithubCandidates } from '../server/modules/github/items'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { ServiceError } from '../server/modules/errors'
import { createLogComment, deleteLogComment, editLogComment, listLogComments, setLogCommentHidden } from '../server/modules/logs/comments'
import { createLog, getLog, listLogRevisions, listLogs, reviseLog } from '../server/modules/logs/logs'
import {
  addSnapshot,
  applyMilestoneTemplate,
  createMilestone,
  deleteMilestone,
  listMilestones,
  reorderMilestones,
  removeSnapshot,
  updateMilestone,
} from '../server/modules/milestones/milestones'
import { acceptInvitation, createInvitation, listInvitations, revokeInvitation } from '../server/modules/projects/invitations'
import { changeMemberRole, leaveProject, listMembers, removeMember, transferOwnership } from '../server/modules/projects/members'
import { MEMBER_REF_PATTERN, memberRefConfigProblems, memberRefKey, setMemberRefEnvForTesting } from '../server/modules/projects/member-refs'
import { createProject, getProject, listMyProjects, updateProject } from '../server/modules/projects/projects'
import {
  createCandidate,
  decideConsent,
  excludeDeclined,
  getCandidate,
  getPublicationState,
  listMyConsentRequests,
  previewCandidate,
} from '../server/modules/publication/candidates'
import { listMyPublishedConsents, publishCandidate, revokeConsent, withdrawPublication } from '../server/modules/publication/releases'
import { completeTask, convertTask, createTask, deleteTask, listTasks, reorderTasks, updateTask } from '../server/modules/tasks/tasks'
import type { LogDto } from '../shared/types/api'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, verifiedAffiliation, withRollback } from './helpers'

const T0 = new Date('2026-11-06T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const rand = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const UNKNOWN_KEY = 'sm_0123456789abcdef'

// ── 라우트 분류 ──────────────────────────────────────────────────────────

const API = join(path.dirname(fileURLToPath(import.meta.url)), '../server/api/v1')
/** 과제(기록)에 속한 데이터를 돌려주거나 받는 라우트 트리. 새 파일이 생기면 ROUTES에 분류해야 이 테스트가 통과합니다. */
const ROUTE_DIRS = ['projects', 'logs', 'log-comments', 'tasks', 'artifacts', 'claims', 'claim-revisions', 'milestones', 'candidates', 'uploads', 'publications', 'discord-bindings']
/** 과제 밖이지만 과제 데이터(동의 요청·체크인·공개 동의)를 싣는 /me 경로. */
const EXTRA_ROUTES = ['me/consent-requests.get.ts', 'me/checkins.get.ts', 'me/publication-consents.get.ts']

/** 라우트 파일 → 그 handler가 부르는 서비스 함수. 누출 검사가 모두 부릅니다(빠진 것이 있으면 실패). */
const ROUTES: Record<string, string> = {
  'projects/index.get.ts': 'listMyProjects',
  'projects/index.post.ts': 'createProject',
  'projects/[id]/index.get.ts': 'getProject',
  'projects/[id]/index.patch.ts': 'updateProject',
  'projects/[id]/leave.post.ts': 'leaveProject',
  'projects/[id]/transfer-ownership.post.ts': 'transferOwnership',
  'projects/[id]/embargoes.post.ts': 'addProjectEmbargo',
  'projects/[id]/report-exports.post.ts': 'recordReportExport',
  'projects/[id]/contribution.get.ts': 'getContribution',
  'projects/[id]/publication.get.ts': 'getPublicationState',
  'projects/[id]/publication-candidates/index.post.ts': 'createCandidate',
  'projects/[id]/members/index.get.ts': 'listMembers',
  'projects/[id]/members/[userId].patch.ts': 'changeMemberRole',
  'projects/[id]/members/[userId].delete.ts': 'removeMember',
  'projects/[id]/invitations/index.get.ts': 'listInvitations',
  'projects/[id]/invitations/index.post.ts': 'createInvitation',
  'projects/[id]/invitations/[invitationId].delete.ts': 'revokeInvitation',
  'projects/[id]/logs/index.get.ts': 'listLogs',
  'projects/[id]/logs/index.post.ts': 'createLog',
  'projects/[id]/tasks/index.get.ts': 'listTasks',
  'projects/[id]/tasks/index.post.ts': 'createTask',
  'projects/[id]/tasks/order.put.ts': 'reorderTasks',
  'projects/[id]/milestones/index.get.ts': 'listMilestones',
  'projects/[id]/milestones/index.post.ts': 'createMilestone',
  'projects/[id]/milestones/order.put.ts': 'reorderMilestones',
  'projects/[id]/milestones/apply-template.post.ts': 'applyMilestoneTemplate',
  'projects/[id]/artifacts/index.get.ts': 'listArtifacts',
  'projects/[id]/artifacts/upload-intents.post.ts': 'createUploadIntent',
  'projects/[id]/claims/index.get.ts': 'listClaims',
  'projects/[id]/claims/index.post.ts': 'createClaim',
  'projects/[id]/checkins/index.get.ts': 'listCheckins',
  'projects/[id]/checkins/me.get.ts': 'getMyCheckin',
  'projects/[id]/checkins/me.put.ts': 'saveMyCheckin',
  'projects/[id]/discord/bind-code.post.ts': 'createBindCode',
  'projects/[id]/discord/bindings.get.ts': 'listBindings',
  'projects/[id]/github/index.get.ts': 'getProjectGithub',
  'projects/[id]/github/index.delete.ts': 'unlinkRepository',
  'projects/[id]/github/install.post.ts': 'startInstall',
  'projects/[id]/github/link.post.ts': 'linkRepository',
  'projects/[id]/github/items.get.ts': 'listGithubCandidates',
  // E-12 AI 회고 인터뷰(ADR 0057): 본인 상태·초안만, 승인 로그는 로그처럼 멤버 참조로 가립니다.
  'projects/[id]/ai-retro/index.get.ts': 'getAiRetroState',
  'projects/[id]/ai-retro/opt-in.put.ts': 'setAiRetroOptIn',
  'projects/[id]/ai-retro/session.post.ts': 'startAiRetroSession',
  'projects/[id]/ai-retro/session.delete.ts': 'discardAiRetroSession',
  'projects/[id]/ai-retro/answers.post.ts': 'answerAiRetro',
  'projects/[id]/ai-retro/drafts/[draftId]/approve.post.ts': 'approveAiRetroDraft',
  'projects/[id]/ai-retro/drafts/[draftId].delete.ts': 'discardAiRetroDraft',
  'logs/[id]/index.get.ts': 'getLog',
  'logs/[id]/revisions/index.get.ts': 'listLogRevisions',
  'logs/[id]/revisions/index.post.ts': 'reviseLog',
  // E-10 피드백 댓글(ADR 0054): 작성자는 로그처럼 멤버 참조로 가립니다.
  'logs/[id]/comments/index.get.ts': 'listLogComments',
  'logs/[id]/comments/index.post.ts': 'createLogComment',
  'log-comments/[id]/index.patch.ts': 'editLogComment',
  'log-comments/[id]/index.delete.ts': 'deleteLogComment',
  'log-comments/[id]/hidden.put.ts': 'setLogCommentHidden',
  'tasks/[id]/index.patch.ts': 'updateTask',
  'tasks/[id]/index.delete.ts': 'deleteTask',
  'tasks/[id]/complete.post.ts': 'completeTask',
  'tasks/[id]/convert.post.ts': 'convertTask',
  'artifacts/[id]/index.get.ts': 'getArtifact',
  'artifacts/[id]/versions/[versionId]/content.get.ts': 'openArtifactContent',
  'artifacts/[id]/versions/[versionId]/rescan.post.ts': 'retryArtifactScan',
  'uploads/[intentId]/index.put.ts': 'receiveUpload',
  'uploads/[intentId]/complete.post.ts': 'completeUpload',
  'claims/[id]/revisions/index.get.ts': 'listClaimRevisions',
  'claims/[id]/revisions/index.post.ts': 'reviseClaim',
  'claim-revisions/[id]/endorsement.put.ts': 'setEndorsement',
  'claim-revisions/[id]/endorsement.delete.ts': 'withdrawEndorsement',
  'milestones/[id]/index.patch.ts': 'updateMilestone',
  'milestones/[id]/index.delete.ts': 'deleteMilestone',
  'milestones/[id]/snapshots/index.post.ts': 'addSnapshot',
  'milestones/[id]/snapshots/[artifactVersionId].delete.ts': 'removeSnapshot',
  'candidates/[id]/index.get.ts': 'getCandidate',
  'candidates/[id]/preview.get.ts': 'previewCandidate',
  'candidates/[id]/consents.post.ts': 'decideConsent',
  'candidates/[id]/exclude-declined.post.ts': 'excludeDeclined',
  'candidates/[id]/publish.post.ts': 'publishCandidate',
  'publications/[id]/withdraw.post.ts': 'withdrawPublication',
  'publications/[id]/consents/revoke.post.ts': 'revokeConsent',
  'discord-bindings/[id].patch.ts': 'updateBinding',
  'discord-bindings/[id].delete.ts': 'unbindChannel',
  'me/consent-requests.get.ts': 'listMyConsentRequests',
  'me/checkins.get.ts': 'myCheckinStatus',
  'me/publication-consents.get.ts': 'listMyPublishedConsents',
}

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? routeFiles(full) : [relative(API, full)]
  })
}

describe('study member refs: route classification and keys (no DB)', () => {
  it('every project-scoped route is classified and calls the classified service', () => {
    const found = [...ROUTE_DIRS.flatMap((d) => routeFiles(join(API, d))), ...EXTRA_ROUTES].sort()
    expect(found, 'add new project routes to ROUTES in this test (and to the leak walk below)').toEqual(Object.keys(ROUTES).sort())
    for (const [file, fn] of Object.entries(ROUTES)) expect(readFileSync(join(API, file), 'utf8'), file).toContain(`${fn}(`)
  })

  it('keys are per project, viewer-independent, never uuids, and depend on the pepper', () => {
    const p1 = crypto.randomUUID()
    const p2 = crypto.randomUUID()
    const u = crypto.randomUUID()
    const k = memberRefKey('pepper-one-0123456789abcdef0123456789', p1, u)
    expect(k).toMatch(MEMBER_REF_PATTERN)
    expect(memberRefKey('pepper-one-0123456789abcdef0123456789', p1, u.toUpperCase())).toBe(k)
    expect(memberRefKey('pepper-one-0123456789abcdef0123456789', p2, u)).not.toBe(k)
    expect(memberRefKey('pepper-two-0123456789abcdef0123456789', p1, u)).not.toBe(k)
    expect(k).not.toContain(u.slice(0, 8))
  })

  it('production requires a strong PEERCHIVE_MEMBER_REF_PEPPER', () => {
    expect(memberRefConfigProblems({ NODE_ENV: 'development' })).toEqual([])
    expect(memberRefConfigProblems({ NODE_ENV: 'production' })).toHaveLength(1)
    expect(memberRefConfigProblems({ NODE_ENV: 'production', PEERCHIVE_MEMBER_REF_PEPPER: 'change-me-change-me-change-me-change-me' })).toHaveLength(1)
    expect(memberRefConfigProblems({ NODE_ENV: 'production', PEERCHIVE_MEMBER_REF_PEPPER: 'f'.repeat(64) })).toEqual([])
  })
})

// ── DB fixture ───────────────────────────────────────────────────────────

interface Person {
  userId: string
  email: string
  handle: string
  displayName: string
}

async function person(tx: DbExecutor, schoolId: string, displayName: string): Promise<Person> {
  const handle = `h${rand()}`
  const u = await createUser(tx, { displayName, handle })
  await verifiedAffiliation(tx, u.id, schoolId)
  return { userId: u.id, email: u.email, handle, displayName }
}

/** 학교·과목·스터디 방(방장 A + 초대 수락한 B·C)과 켠 기록, A·B가 함께 쓰는 일반 팀 과제. */
async function world(tx: DbExecutor, mode: 'anonymous' | 'display' = 'anonymous') {
  const t = rand()
  const founder = { userId: (await createUser(tx)).id }
  const school = await createSchool(tx, founder, { name: `가명대${t}학교`, confirmNew: true }, T0)
  const course = await createCourse(tx, founder, school.id, { title: `알고리즘${t}`, code: `AL-${t}`, confirmNew: true }, T0)
  const a = await person(tx, school.id, `ALPHA에이${t}`)
  const b = await person(tx, school.id, `BRAVO비밀${t}`)
  const c = await person(tx, school.id, `CHARLIE씨${t}`)
  const room = await createStudyRoomInternal(tx, { ownerId: a.userId, name: `가명 스터디 ${t}`, schoolId: school.id, nameMode: mode, linkedCourseId: course.id }, T0)
  for (const [p, n] of [[b, 1], [c, 1]] as const) {
    const { token } = await createSpaceInvitation(tx, a, room.slug, at(n))
    await acceptSpaceInvitation(tx, p, { token }, at(n))
  }
  const projectId = (await enableStudyRecord(tx, a, room.slug, {}, at(2))).projectId!
  // 익명이 아닌 팀 과제: 여기서는 A가 B의 실제 id·이름을 봅니다(맞춰 보기의 위협).
  const team = await createProject(tx, a, { title: `팀 과제 ${t}`, kind: 'team' }, T0)
  const { token } = await createInvitation(tx, a, team.id, { role: 'editor' }, T0)
  await acceptInvitation(tx, b, { token }, T0)
  return { school, course, room, a, b, c, projectId, teamId: team.id }
}

async function cleanFile(tx: DbExecutor, projectId: string, uploaderId: string, fileName = 'notes.pdf') {
  const [artifact] = await tx.insert(artifacts).values({ projectId, uploaderId, title: fileName }).returning()
  const [version] = await tx
    .insert(artifactVersions)
    .values({
      artifactId: artifact!.id,
      versionNo: 1,
      uploaderId,
      fileName,
      declaredType: 'application/pdf',
      mediaType: 'application/pdf',
      bytes: 10,
      sha256: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
      objectKey: `clean/${crypto.randomUUID()}`,
      scanStatus: 'clean',
      metadataStripped: true,
    })
    .returning()
  return { artifact: artifact!, version: version! }
}

function secretsOf(p: Person): string[] {
  return [p.userId, p.userId.toUpperCase(), p.email, p.handle, p.displayName]
}

let root: string
let storage: ObjectStorage

describe.skipIf(!databaseUrl)('study member refs (PostgreSQL)', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-member-refs-'))
    storage = createFilesystemStorage(root)
  })
  afterAll(async () => {
    await closeTestDb()
    await rm(root, { recursive: true, force: true })
    setMemberRefEnvForTesting(null)
  })

  it('no project route leaks another member’s real id, handle, email or name in an anonymous study record', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const { a, b, c, projectId } = w
      const A = { userId: a.userId }

      // 위협 확인: 함께 쓰는 일반 과제에서는 A가 B의 실제 id와 이름을 봄.
      const teamMembers = await listMembers(tx, A, w.teamId)
      expect(teamMembers.find((m) => m.userId === b.userId)?.displayName).toBe(b.displayName)

      // B·C의 키(멤버 목록에서) — 응답에는 이 키만 나와야 함
      const members = await listMembers(tx, A, projectId)
      expect(members.map((m) => m.userId)).toContain(a.userId)
      const others = members.filter((m) => m.userId !== a.userId)
      expect(others).toHaveLength(2)
      for (const m of others) {
        expect(m.userId).toMatch(MEMBER_REF_PATTERN)
        expect(m.joinedAt).toBeNull()
        expect(m.displayName).toMatch(/^스터디 멤버 \d$/)
      }
      // 어느 키가 B인지는 B의 로그로 확인(테스트만 아는 대응)
      const bLog = (await createLog(tx, b, projectId, { tag: 'stuck', body: '', payload: { symptom: '재귀 깊이 초과', keywords: ['재귀'], attempts: ['메모'], timeBucket: 'lt2h', answerCheck: true }, links: [] }, at(3))).log
      const realKeyB = (await getLog(tx, A, bLog.id)).author.userId
      const keyC = others.map((m) => m.userId).find((k) => k !== realKeyB)!
      expect(realKeyB).toMatch(MEMBER_REF_PATTERN)

      // ── 기록 채우기(B·C가 만든 데이터) ──
      await createLog(tx, c, projectId, { tag: 'solution', body: '반복으로 바꿈', payload: { method: '스택으로 바꿈', notAnswerConfirmed: true }, links: [], resolvesEntryId: bLog.id }, at(4))
      const bProgress = (await createLog(tx, b, projectId, { tag: 'progress', body: '그래프 정리', links: [] }, at(4))).log
      const bFile = await cleanFile(tx, projectId, b.userId)
      const bTask = await createTask(tx, b, projectId, { title: 'B가 만든 할 일' }, at(4))
      await completeTask(tx, b, bTask.id, { expectedVersion: bTask.version }, at(4))
      const bClaim = await createClaim(tx, b, projectId, { text: '그래프 담당', evidence: [{ kind: 'log', id: bProgress.id }] }, at(5))
      await setEndorsement(tx, c, bClaim.revisionId, { status: 'confirmed' }, at(5))
      await saveMyCheckin(tx, b, projectId, { timeBucket: 'lt5h', difficulty: 3, note: '괜찮음' }, at(5))

      // ── A로 모든 경로 ──
      const exercised = new Set<string>()
      const bodies: Array<[string, string]> = []
      const hit = async <T>(route: string, run: () => Promise<T>): Promise<T | undefined> => {
        expect(ROUTES[route], route).toBeDefined()
        exercised.add(route)
        try {
          const result = await run()
          const shown = result && typeof result === 'object' && 'stream' in result ? { ...(result as object), stream: null } : result
          bodies.push([route, JSON.stringify(shown ?? null)])
          return result
        } catch (error) {
          if (!(error instanceof ServiceError)) throw error
          bodies.push([route, JSON.stringify({ code: error.code, reason: error.reason, fields: error.fields, details: error.details })])
          return undefined
        }
      }

      await hit('projects/index.get.ts', () => listMyProjects(tx, A))
      await hit('projects/index.post.ts', () => createProject(tx, A, { title: '다른 과제', kind: 'individual' }, at(6)))
      const project = await hit('projects/[id]/index.get.ts', () => getProject(tx, A, projectId, at(6)))
      await hit('projects/[id]/index.patch.ts', () => updateProject(tx, A, projectId, { expectedVersion: project!.version, title: '스터디 기록 2' }, at(6)))
      await hit('projects/[id]/members/index.get.ts', () => listMembers(tx, A, projectId))
      await hit('projects/[id]/members/[userId].patch.ts', () => changeMemberRole(tx, A, projectId, realKeyB, { role: 'viewer' }))
      await hit('projects/[id]/members/[userId].delete.ts', () => removeMember(tx, A, projectId, realKeyB))
      await hit('projects/[id]/transfer-ownership.post.ts', () => transferOwnership(tx, A, projectId, { userId: realKeyB }))
      await hit('projects/[id]/invitations/index.get.ts', () => listInvitations(tx, A, projectId, at(6)))
      await hit('projects/[id]/invitations/index.post.ts', () => createInvitation(tx, A, projectId, { role: 'editor' }, at(6)))
      await hit('projects/[id]/invitations/[invitationId].delete.ts', () => revokeInvitation(tx, A, projectId, crypto.randomUUID(), at(6)))

      // 로그: 회의 참석자는 가명 키로 입력, DB에는 실제 id
      const meeting = (await hit('projects/[id]/logs/index.post.ts', () =>
        createLog(tx, A, projectId, { tag: 'meeting', body: '주간 회의', payload: { attendees: [realKeyB, keyC, a.userId], decisions: ['다음 주 DP'], followUps: [] }, links: [] }, at(7)),
      ))!.log
      expect((meeting.payload as { attendees: string[] }).attendees.sort()).toEqual([realKeyB, keyC, a.userId].sort())
      const [stored] = await tx.select({ payload: logRevisions.payload }).from(logEntries).innerJoin(logRevisions, eq(logRevisions.id, logEntries.currentRevisionId)).where(eq(logEntries.id, meeting.id))
      expect((stored!.payload.attendees as string[]).sort()).toEqual([a.userId, b.userId, c.userId].sort())
      await hit('projects/[id]/logs/index.get.ts', () => listLogs(tx, A, projectId, {}))
      const byB = (await listLogs(tx, A, projectId, { author: realKeyB })).items
      expect(byB.map((l) => l.id).sort()).toEqual([bLog.id, bProgress.id].sort())
      await hit('logs/[id]/index.get.ts', () => getLog(tx, A, bLog.id))
      await hit('logs/[id]/revisions/index.get.ts', () => listLogRevisions(tx, A, meeting.id))
      // 응답 payload를 그대로 다시 보내는 수정(키 → 실제 id 왕복)
      const revised = (await hit('logs/[id]/revisions/index.post.ts', () =>
        reviseLog(tx, A, meeting.id, { tag: 'meeting', expectedRevision: 1, body: '주간 회의(수정)', payload: meeting.payload }, at(8)),
      )) as LogDto
      expect(revised.revisionNo).toBe(2)
      expect(revised.payload).toEqual(meeting.payload)

      // 피드백 댓글(E-10): B·C가 쓴 댓글의 작성자는 가명 키(본인 것은 그대로)
      const bComment = await createLogComment(tx, b, bLog.id, { body: 'B의 피드백' }, at(8))
      await createLogComment(tx, c, bLog.id, { body: 'C의 피드백' }, at(8))
      const thread = (await hit('logs/[id]/comments/index.get.ts', () => listLogComments(tx, A, bLog.id)))!
      expect(thread.items.map((x) => x.author?.userId).sort()).toEqual([realKeyB, keyC].sort())
      const myComment = (await hit('logs/[id]/comments/index.post.ts', () => createLogComment(tx, A, bLog.id, { body: 'A의 피드백' }, at(8))))!
      expect(myComment.author?.userId).toBe(a.userId)
      await hit('log-comments/[id]/index.patch.ts', () => editLogComment(tx, A, myComment.id, { body: 'A의 피드백(수정)' }, at(8)))
      await hit('log-comments/[id]/hidden.put.ts', () => setLogCommentHidden(tx, A, bComment.id, { hidden: true }, at(8)))
      await hit('log-comments/[id]/index.delete.ts', () => deleteLogComment(tx, A, myComment.id, at(8)))

      // 할 일: 담당자 가명 키
      const task = (await hit('projects/[id]/tasks/index.post.ts', () => createTask(tx, A, projectId, { title: '정리', assigneeId: realKeyB }, at(8))))!
      expect(task.assignee?.userId).toBe(realKeyB)
      expect((await tx.select({ assigneeId: tasks.assigneeId }).from(tasks).where(eq(tasks.id, task.id)))[0]!.assigneeId).toBe(b.userId)
      await hit('projects/[id]/tasks/index.get.ts', () => listTasks(tx, A, projectId, {}))
      const updatedTask = (await hit('tasks/[id]/index.patch.ts', () => updateTask(tx, A, task.id, { expectedVersion: task.version, assigneeId: keyC }, at(9))))!
      expect(updatedTask.assignee?.userId).toBe(keyC)
      await hit('projects/[id]/tasks/order.put.ts', () => reorderTasks(tx, A, projectId, { status: 'todo', taskIds: [task.id] }))
      await hit('tasks/[id]/complete.post.ts', () => completeTask(tx, A, task.id, { expectedVersion: updatedTask.version }, at(9)))
      await hit('tasks/[id]/convert.post.ts', () => convertTask(tx, A, task.id, { tag: 'progress', body: '정리 끝' }, at(9)))
      const spare = await createTask(tx, A, projectId, { title: '지울 일' }, at(9))
      await hit('tasks/[id]/index.delete.ts', () => deleteTask(tx, A, spare.id))

      // 마일스톤·스냅샷(B의 파일)
      const ms = (await hit('projects/[id]/milestones/index.post.ts', () => createMilestone(tx, A, projectId, { title: '1차 점검' }, at(10))))!
      await hit('projects/[id]/milestones/apply-template.post.ts', () => applyMilestoneTemplate(tx, A, projectId, at(10)))
      await hit('projects/[id]/milestones/index.get.ts', () => listMilestones(tx, A, projectId))
      await hit('projects/[id]/milestones/order.put.ts', () => reorderMilestones(tx, A, projectId, { milestoneIds: [ms.id] }))
      await hit('milestones/[id]/snapshots/index.post.ts', () => addSnapshot(tx, A, ms.id, { artifactVersionId: bFile.version.id }, at(10)))
      await hit('milestones/[id]/index.patch.ts', () => updateMilestone(tx, A, ms.id, { expectedVersion: ms.version, note: '점검' }, at(10)))
      await hit('milestones/[id]/snapshots/[artifactVersionId].delete.ts', () => removeSnapshot(tx, A, ms.id, bFile.version.id))
      await hit('milestones/[id]/index.delete.ts', () => deleteMilestone(tx, A, ms.id))

      // 파일: B의 산출물, A가 같은 산출물에 새 버전 업로드(완료 응답에 B의 버전도 실림)
      await hit('projects/[id]/artifacts/index.get.ts', () => listArtifacts(tx, A, projectId))
      await hit('artifacts/[id]/index.get.ts', () => getArtifact(tx, A, bFile.artifact.id))
      await hit('artifacts/[id]/versions/[versionId]/content.get.ts', () => openArtifactContent(tx, storage, A, bFile.artifact.id, bFile.version.id))
      await hit('artifacts/[id]/versions/[versionId]/rescan.post.ts', () => retryArtifactScan(tx, A, bFile.artifact.id, bFile.version.id))
      const intent = (await hit('projects/[id]/artifacts/upload-intents.post.ts', () =>
        createUploadIntent(tx, A, projectId, { fileName: 'screen.png', declaredType: 'image/png', byteSize: PNG.length, artifactId: bFile.artifact.id }, at(11)),
      ))!.intent
      await hit('uploads/[intentId]/index.put.ts', () => receiveUpload(tx, storage, A, intent.intentId, Readable.from([PNG]), { contentLength: PNG.length }, at(11)))
      const completed = (await hit('uploads/[intentId]/complete.post.ts', () => completeUpload(tx, storage, A, intent.intentId, at(11))))!
      expect(completed.artifact.versions.map((v) => v.uploader.userId).sort()).toEqual([a.userId, realKeyB].sort())

      // 역할 선언·확인
      await hit('projects/[id]/claims/index.get.ts', () => listClaims(tx, A, projectId))
      await hit('claims/[id]/revisions/index.get.ts', () => listClaimRevisions(tx, A, bClaim.id))
      await hit('claim-revisions/[id]/endorsement.put.ts', () => setEndorsement(tx, A, bClaim.revisionId, { status: 'confirmed' }, at(12)))
      const listed = (await listClaims(tx, A, projectId)).find((cl) => cl.id === bClaim.id)!
      expect(listed.author.userId).toBe(realKeyB)
      expect(listed.endorsements.map((e) => e.endorser.userId).sort()).toEqual([a.userId, keyC].sort())
      expect(listed.myEndorsement).toBe('confirmed')
      await hit('claim-revisions/[id]/endorsement.delete.ts', () => withdrawEndorsement(tx, A, bClaim.revisionId))
      const mine = (await hit('projects/[id]/claims/index.post.ts', () => createClaim(tx, A, projectId, { text: '회의 진행', evidence: [{ kind: 'log', id: meeting.id }] }, at(12))))!
      await hit('claims/[id]/revisions/index.post.ts', () => reviseClaim(tx, A, mine.id, { expectedRevision: 1, text: '회의 진행·정리' }, at(12)))

      // 체크인·장부·내보내기
      await hit('projects/[id]/checkins/index.get.ts', () => listCheckins(tx, A, projectId, {}, at(12)))
      await hit('projects/[id]/checkins/me.get.ts', () => getMyCheckin(tx, A, projectId, {}, at(12)))
      await hit('projects/[id]/checkins/me.put.ts', () => saveMyCheckin(tx, A, projectId, { timeBucket: 'lt2h', difficulty: 2, promote: { tag: 'progress' }, note: '정리함' }, at(12)))
      await hit('me/checkins.get.ts', () => myCheckinStatus(tx, A, at(12)))
      const ledger = (await hit('projects/[id]/contribution.get.ts', () => getContribution(tx, A, projectId, { from: '2026-11-02', to: '2026-11-08' }, at(13))))!
      const bRow = ledger.members.find((m) => m.member.userId === realKeyB)!
      expect(bRow.claims.map((cl) => cl.id)).toContain(bClaim.id)
      expect(bRow.meetingsAttended).toBe(1)
      expect(ledger.unresolvedStuck).toEqual([])
      await hit('projects/[id]/report-exports.post.ts', () => recordReportExport(tx, A, projectId, { from: '2026-11-02', to: '2026-11-08' }, at(13)))

      // 디스코드(멤버 데이터 없음)
      await hit('projects/[id]/discord/bind-code.post.ts', () => createBindCode(tx, A, projectId, at(13)))
      await hit('projects/[id]/discord/bindings.get.ts', () => listBindings(tx, A, projectId))
      await hit('discord-bindings/[id].patch.ts', () => updateBinding(tx, A, crypto.randomUUID(), { summaryEnabled: false }))
      await hit('discord-bindings/[id].delete.ts', () => unbindChannel(tx, A, crypto.randomUUID(), at(13)))

      // GitHub(E-11): 스터디 기록은 GitHub 연결을 쓰지 않아 모든 경로가 404입니다(GitHub API는 부르지 않음).
      const githubCtx = { config: {} as GithubAppConfig, client: {} as GithubClient, siteOrigin: 'http://localhost:3100', now: at(13) }
      await hit('projects/[id]/github/index.get.ts', () => getProjectGithub(tx, A, projectId, at(13)))
      await hit('projects/[id]/github/install.post.ts', () => startInstall(tx, A, projectId, githubCtx))
      await hit('projects/[id]/github/link.post.ts', () => linkRepository(tx, A, projectId, { repoId: 1 }, githubCtx))
      await hit('projects/[id]/github/items.get.ts', () => listGithubCandidates(tx, A, projectId))
      await hit('projects/[id]/github/index.delete.ts', () => unlinkRepository(tx, A, projectId, githubCtx))

      // AI 회고 인터뷰(E-12): 가짜 공급자로 켜고 → 시작 → 일찍 정리 → 초안 승인·버리기 → 세션 버리기. 응답은 본인 것뿐입니다.
      const fakeAi = createFakeAiProvider()
      fakeAi.respond = (call) =>
        call.feature === 'retro_interview.drafts'
          ? { data: { drafts: ['progress', 'retro', 'retro'].map((tag) => ({ tag, body: `${tag} 초안`, stuck: null, decision: null, validation: null })) } }
          : { data: { finish: false, next_question: '다음?' } }
      setAiProviderForTesting(fakeAi)
      try {
        await hit('projects/[id]/ai-retro/opt-in.put.ts', () => setAiRetroOptIn(tx, A, projectId, { enabled: true }, at(13)))
        await hit('projects/[id]/ai-retro/session.post.ts', () => startAiRetroSession(tx, A, projectId, at(13)))
        const drafted = (await hit('projects/[id]/ai-retro/answers.post.ts', () => answerAiRetro(tx, A, projectId, { questionNo: 1, answer: '정리', finish: true }, at(13))))!
        await hit('projects/[id]/ai-retro/index.get.ts', () => getAiRetroState(tx, A, projectId, at(13)))
        await hit('projects/[id]/ai-retro/drafts/[draftId]/approve.post.ts', () => approveAiRetroDraft(tx, A, projectId, drafted.drafts[0]!.id, {}, at(13)))
        await hit('projects/[id]/ai-retro/drafts/[draftId].delete.ts', () => discardAiRetroDraft(tx, A, projectId, drafted.drafts[1]!.id, at(13)))
        await hit('projects/[id]/ai-retro/session.delete.ts', () => discardAiRetroSession(tx, A, projectId, at(13)))
        // 기록의 다른 멤버 이름·id는 AI에도 보내지 않습니다.
        for (const secret of [b.userId, c.userId, b.displayName, c.displayName]) expect(fakeAi.sentText()).not.toContain(secret)
      } finally {
        setAiProviderForTesting(undefined)
      }

      // 공개: 선택지 → 후보(노출 방식 키) → B 거절 → 게시 막힘(당사자 키) → 미동의자 제외 → 동의 → 게시 → 동의 철회 → 철회
      const state = (await hit('projects/[id]/publication.get.ts', () => getPublicationState(tx, A, projectId, at(14))))!
      expect(state.options.members.map((m) => m.userId).sort()).toEqual([a.userId, realKeyB, keyC].sort())
      const candidate = (await hit('projects/[id]/publication-candidates/index.post.ts', () =>
        createCandidate(
          tx,
          A,
          projectId,
          { level: 'summary', title: '가명 스터디 회고', summary: '요약', slug: `refs-${rand().slice(0, 8)}`, logIds: [bLog.id, bProgress.id, meeting.id], claimIds: [bClaim.id], exposure: { [realKeyB]: 'anonymous', [keyC]: 'anonymous' } },
          at(14),
          ORIGINS,
        ),
      ))!
      expect(Object.keys(candidate.selection.exposure).sort()).toEqual([realKeyB, keyC].sort())
      const [storedCandidate] = await tx.select({ selection: publicationCandidates.selection }).from(publicationCandidates).where(eq(publicationCandidates.id, candidate.id))
      expect(Object.keys((storedCandidate!.selection as { exposure: Record<string, string> }).exposure).sort()).toEqual([b.userId, c.userId].sort())
      expect(candidate.subjects.map((s) => s.userId).sort()).toEqual([a.userId, realKeyB, keyC].sort())
      await hit('candidates/[id]/preview.get.ts', () => previewCandidate(tx, A, candidate.id))
      await decideConsent(tx, b, candidate.id, { decision: 'declined', manifestHash: candidate.manifestHash }, at(15))
      await hit('candidates/[id]/consents.post.ts', () => decideConsent(tx, A, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(15)))
      const seen = (await hit('candidates/[id]/index.get.ts', () => getCandidate(tx, A, candidate.id, at(15))))!
      expect(seen.blockers.filter((x) => 'userId' in x).map((x) => (x as { userId: string }).userId).sort()).toEqual([realKeyB, keyC].sort())
      const blocked = await expectServiceError(publishCandidate(tx, A, candidate.id, { manifestHash: candidate.manifestHash }, at(15)), 'CONFLICT', 'publish_blocked')
      expect(JSON.stringify(blocked.details)).toContain(realKeyB)
      await hit('candidates/[id]/publish.post.ts', () => publishCandidate(tx, A, candidate.id, { manifestHash: candidate.manifestHash }, at(15)))
      const derived = (await hit('candidates/[id]/exclude-declined.post.ts', () => excludeDeclined(tx, A, candidate.id, { consentSelf: true }, at(16), ORIGINS)))!
      expect(derived.selection.excludedUserIds).toEqual([realKeyB])
      for (const p of [b, c]) await decideConsent(tx, p, derived.id, { decision: 'granted', manifestHash: derived.manifestHash }, at(16))
      await hit('candidates/[id]/publish.post.ts', () => publishCandidate(tx, A, derived.id, { manifestHash: derived.manifestHash }, at(17)))
      await hit('me/consent-requests.get.ts', () => listMyConsentRequests(tx, A))
      await hit('me/publication-consents.get.ts', () => listMyPublishedConsents(tx, A))
      await hit('projects/[id]/publication.get.ts', () => getPublicationState(tx, A, projectId, at(17)))
      await hit('publications/[id]/consents/revoke.post.ts', () => revokeConsent(tx, A, derived.publicationId, {}, at(18)))
      await hit('publications/[id]/withdraw.post.ts', () => withdrawPublication(tx, A, derived.publicationId, { reason: '정리' }, at(18)))
      await hit('projects/[id]/embargoes.post.ts', () => addProjectEmbargo(tx, A, projectId, { until: at(60 * 24).toISOString(), reason: '학기 중' }, at(19)))
      await hit('projects/[id]/leave.post.ts', () => leaveProject(tx, A, projectId))

      // 모든 분류 경로를 불렀고, 어느 응답에도 B·C의 실제 id·handle·이메일·이름이 없음
      expect(Object.keys(ROUTES).filter((route) => !exercised.has(route))).toEqual([])
      const secrets = [...secretsOf(b), ...secretsOf(c)]
      const leaks = bodies.flatMap(([route, body]) => secrets.filter((secret) => body.includes(secret)).map((secret) => `${route}: ${secretsOf(b).includes(secret) ? 'B' : 'C'} ${[b.displayName, c.displayName].includes(secret) ? 'name' : 'identifier'}`))
      expect(leaks).toEqual([])
      // 가명 키는 실제로 실려 있음(검사가 비어 있지 않음)
      expect(bodies.filter(([, body]) => body.includes(realKeyB)).length).toBeGreaterThan(10)
    })
  })

  it('member inputs reject unknown keys and other members’ real ids with 422; keys differ per project and from the team project', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx)
      const { a, b, projectId } = w
      const A = { userId: a.userId }
      const keys = (await listMembers(tx, A, projectId)).map((m) => m.userId).filter((k) => k !== a.userId)

      for (const bad of [UNKNOWN_KEY, b.userId]) {
        const e1 = await expectServiceError(createTask(tx, A, projectId, { title: 'x', assigneeId: bad }, at(3)), 'VALIDATION')
        expect(e1.fields).toEqual({ assigneeId: 'not_member' })
        const e2 = await expectServiceError(
          createLog(tx, A, projectId, { tag: 'meeting', body: '회의', payload: { attendees: [bad], decisions: [], followUps: [] }, links: [] }, at(3)),
          'VALIDATION',
        )
        expect(e2.fields).toEqual({ 'payload.attendees': 'not_member' })
        const e3 = await expectServiceError(
          createCandidate(tx, A, projectId, { level: 'summary', title: '공개', summary: '요약', slug: `x-${rand().slice(0, 8)}`, exposure: { [bad]: 'anonymous' } }, at(3), ORIGINS),
          'VALIDATION',
        )
        expect(e3.fields).toEqual({ exposure: 'not_member' })
        const e4 = await expectServiceError(listLogs(tx, A, projectId, { author: bad }), 'VALIDATION')
        expect(e4.fields).toEqual({ author: 'not_member' })
      }
      // 이름 노출은 키와 무관하게 먼저 anonymous_study
      const e5 = await expectServiceError(
        createCandidate(tx, A, projectId, { level: 'summary', title: '공개', summary: '요약', slug: `x-${rand().slice(0, 8)}`, exposure: { [keys[0]!]: 'name' } }, at(3), ORIGINS),
        'VALIDATION',
      )
      expect(e5.fields).toEqual({ exposure: 'anonymous_study' })
      // 본인 id는 그대로 받음
      expect((await createTask(tx, A, projectId, { title: '내 일', assigneeId: a.userId }, at(3))).assignee?.userId).toBe(a.userId)
      // 보는 사람과 무관: B와 C가 보는 A의 키가 같음(A 본인에게는 실제 id)
      const aLog = (await createLog(tx, A, projectId, { tag: 'progress', body: '정리', links: [] }, at(3))).log
      const keyFromB = (await getLog(tx, b, aLog.id)).author.userId
      expect(keyFromB).toMatch(MEMBER_REF_PATTERN)
      expect((await getLog(tx, w.c, aLog.id)).author.userId).toBe(keyFromB)
      expect((await getLog(tx, A, aLog.id)).author.userId).toBe(a.userId)
      // 일반 팀 과제의 같은 사람은 실제 id, 가명 키는 422
      expect((await listMembers(tx, A, w.teamId)).map((m) => m.userId)).toContain(b.userId)
      expect((await createTask(tx, A, w.teamId, { title: '팀 일', assigneeId: b.userId }, at(4))).assignee?.userId).toBe(b.userId)
      const e6 = await expectServiceError(createTask(tx, A, w.teamId, { title: '팀 일', assigneeId: keys[0]! }, at(4)), 'VALIDATION')
      expect(e6.fields).toEqual({ assigneeId: 'not_member' })
    })
  })

  it('non-anonymous study records keep real ids and names', async () => {
    await withRollback(async (tx) => {
      const w = await world(tx, 'display')
      const members = await listMembers(tx, w.a, w.projectId)
      expect(members.map((m) => m.userId).sort()).toEqual([w.a.userId, w.b.userId, w.c.userId].sort())
      expect(members.every((m) => m.joinedAt !== null)).toBe(true)
      expect(members.find((m) => m.userId === w.b.userId)?.displayName).toBe(w.b.displayName)
      const task = await createTask(tx, w.a, w.projectId, { title: '할 일', assigneeId: w.b.userId }, at(3))
      expect(task.assignee).toMatchObject({ userId: w.b.userId, displayName: w.b.displayName })
      const log = (await createLog(tx, w.a, w.projectId, { tag: 'meeting', body: '회의', payload: { attendees: [w.b.userId], decisions: [], followUps: [] }, links: [] }, at(3))).log
      expect((log.payload as { attendees: string[] }).attendees).toEqual([w.b.userId])
      await expectServiceError(createTask(tx, w.a, w.projectId, { title: 'x', assigneeId: UNKNOWN_KEY }, at(3)), 'VALIDATION')
    })
  })
})
