/**
 * T-11 공개 후보·점검·미리보기·동의 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 프로젝트·후보의 행만 봅니다(개발 DB에 남은 행과 무관, slug는 무작위).
 */
import { afterAll, describe, expect, it } from 'vitest'
import {
  artifactVersions,
  artifacts,
  consents,
  eq,
  milestones,
  publicationCandidates,
  publications,
  tasks,
  users,
  weeklyCheckins,
  type DbExecutor,
} from '@peerchive/db'
import { createCourse, createCourseTerm, createSchool } from '../server/modules/catalog/catalog'
import { createClaim, setEndorsement } from '../server/modules/contribution/claims'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { createLog } from '../server/modules/logs/logs'
import { addSnapshot, createMilestone } from '../server/modules/milestones/milestones'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { leaveProject } from '../server/modules/projects/members'
import { createProject, updateProject } from '../server/modules/projects/projects'
import {
  createCandidate,
  decideConsent,
  excludeDeclined,
  getCandidate,
  getPublicationState,
  listMyConsentRequests,
  previewCandidate,
} from '../server/modules/publication/candidates'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const slug = () => `case-${crypto.randomUUID().slice(0, 8)}`
const SENTINEL = 'SENTINEL_db_9c1e'

type Role = 'editor' | 'reviewer' | 'viewer'

async function team(db: DbExecutor, members: Array<{ role: Role; name: string }>) {
  const owner = await createUser(db, { displayName: '김소유' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' }, T0)
  const ids: string[] = []
  for (const { role, name } of members) {
    const user = await createUser(db, { displayName: name })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    ids.push(user.id)
  }
  return { owner: owner.id, project, ids }
}

async function fileVersion(db: DbExecutor, projectId: string, uploaderId: string, scanStatus: 'pending' | 'clean' | 'quarantined', fileName = 'report.pdf') {
  const [artifact] = await db.insert(artifacts).values({ projectId, uploaderId, title: fileName }).returning()
  const [version] = await db
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
      scanStatus,
    })
    .returning()
  return version!
}

const log = async (db: DbExecutor, userId: string, projectId: string, input: Record<string, unknown>, n = 0) =>
  (await createLog(db, { userId }, projectId, input, at(n))).log

const progress = (body: string) => ({ tag: 'progress', body })

describe.skipIf(!databaseUrl)('publication candidates and consents (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('only active owner/editor create candidates; reviewer/viewer 403, non-members 404 everywhere', async () => {
    await withRollback(async (tx) => {
      const { owner, project, ids } = await team(tx, [
        { role: 'editor', name: '이편집' },
        { role: 'reviewer', name: '박리뷰' },
        { role: 'viewer', name: '최열람' },
      ])
      const [editor, reviewer, viewer] = ids
      const stranger = (await createUser(tx)).id
      const input = { level: 'summary', title: '공개 제목', summary: '요약', slug: slug() }
      await expectServiceError(createCandidate(tx, { userId: reviewer! }, project.id, input, at(10)), 'FORBIDDEN')
      await expectServiceError(createCandidate(tx, { userId: viewer! }, project.id, input, at(10)), 'FORBIDDEN')
      await expectServiceError(createCandidate(tx, { userId: stranger }, project.id, input, at(10)), 'NOT_FOUND')
      await expectServiceError(createCandidate(tx, { userId: stranger }, crypto.randomUUID(), input, at(10)), 'NOT_FOUND')

      const candidate = await createCandidate(tx, { userId: editor! }, project.id, input, at(10), ORIGINS)
      expect(candidate).toMatchObject({ status: 'awaiting_consent', level: 'summary', version: 1, publicationStatus: 'awaiting_consent' })
      // 만든 사람(제목·요약 작성자)만 당사자이고, 명시적으로 동의하지 않았으므로 pending.
      expect(candidate.subjects.map((s) => [s.userId, s.status, s.scope])).toEqual([[editor, 'pending', ['title_summary']]])

      // 멤버는 읽기 가능(reviewer/viewer 포함), 비멤버는 후보·미리보기·상태 모두 404.
      await expect(getCandidate(tx, { userId: viewer! }, candidate.id, at(11))).resolves.toMatchObject({ id: candidate.id, canDecide: false })
      await expect(previewCandidate(tx, { userId: reviewer! }, candidate.id)).resolves.toMatchObject({ candidateId: candidate.id })
      await expectServiceError(getCandidate(tx, { userId: stranger }, candidate.id, at(11)), 'NOT_FOUND')
      await expectServiceError(previewCandidate(tx, { userId: stranger }, candidate.id), 'NOT_FOUND')
      await expectServiceError(previewCandidate(tx, { userId: stranger }, 'not-a-uuid'), 'NOT_FOUND')
      await expectServiceError(getPublicationState(tx, { userId: stranger }, project.id, at(11)), 'NOT_FOUND')
      await expectServiceError(
        decideConsent(tx, { userId: stranger }, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(11)),
        'NOT_FOUND',
      )
      // 당사자가 아닌 멤버의 결정은 403.
      await expectServiceError(
        decideConsent(tx, { userId: owner }, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(11)),
        'FORBIDDEN',
        'not_subject',
      )
      const state = await getPublicationState(tx, { userId: viewer! }, project.id, at(11))
      expect(state).toMatchObject({ canPrepare: false, publication: { status: 'awaiting_consent', level: 'summary' }, candidate: { id: candidate.id } })
    })
  })

  it('refuses during embargo (409 embargo_active + until) and accepts a past term, keeping only course labels', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx, [])
      const until = new Date('2027-03-01T00:00:00Z')
      const other = await team(tx, [])
      await addProjectEmbargo(tx, { userId: other.owner }, other.project.id, { until: until.toISOString(), reason: '학기 진행 중' }, T0)
      const blocked = await expectServiceError(
        createCandidate(tx, { userId: other.owner }, other.project.id, { level: 'summary', title: 't', summary: 's', slug: slug() }, at(1)),
        'CONFLICT',
        'embargo_active',
      )
      expect(blocked.details).toEqual({ until: until.toISOString() })

      // 지난 학기(2025 2학기)에 연결한 과제는 엠바고가 없습니다. 스냅샷에는 학교·과목·학기 이름만.
      const t = crypto.randomUUID().slice(0, 6).replace(/[^a-z]/g, 'q')
      const school = await createSchool(tx, { userId: owner }, { name: `한빛${t}대학교` }, T0)
      const course = await createCourse(tx, { userId: owner }, school.id, { title: `운영체제${t}`, code: `CSE-${t}` }, T0)
      const { term } = await createCourseTerm(tx, { userId: owner }, course.id, { year: 2025, semester: 'fall' }, T0)
      await updateProject(tx, { userId: owner }, project.id, { expectedVersion: project.version, courseTermId: term.id }, T0)
      const candidate = await createCandidate(tx, { userId: owner }, project.id, { level: 'summary', title: 't', summary: 's', slug: slug() }, at(2))
      const preview = await previewCandidate(tx, { userId: owner }, candidate.id)
      expect(preview.snapshot.course).toEqual({ school: school.name, course: course.title, code: `CSE-${t}`, year: 2025, semester: 'fall' })
      expect(JSON.stringify(preview)).not.toContain(term.id)
      expect(JSON.stringify(preview)).not.toContain(school.id)
    })
  })

  it('validates selection: files only at full level and only clean; same project; slug reserved/taken', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx, [])
      const other = await team(tx, [])
      const clean = await fileVersion(tx, project.id, owner, 'clean')
      const pending = await fileVersion(tx, project.id, owner, 'pending')
      const quarantined = await fileVersion(tx, project.id, owner, 'quarantined')
      const foreign = await fileVersion(tx, other.project.id, other.owner, 'clean')
      const base = { title: '제목', summary: '요약', slug: slug() }
      const fields = async (input: Record<string, unknown>) =>
        (await expectServiceError(createCandidate(tx, { userId: owner }, project.id, { ...base, ...input }, at(1)), 'VALIDATION')).fields

      expect(await fields({ level: 'summary', artifactVersionIds: [clean.id] })).toEqual({ artifactVersionIds: 'not_allowed' })
      expect(await fields({ level: 'full', artifactVersionIds: [clean.id, pending.id] })).toEqual({ artifactVersionIds: 'not_clean' })
      expect(await fields({ level: 'full', artifactVersionIds: [quarantined.id] })).toEqual({ artifactVersionIds: 'not_clean' })
      expect(await fields({ level: 'full', artifactVersionIds: [foreign.id] })).toEqual({ artifactVersionIds: 'not_found' })
      expect(await fields({ level: 'full', logIds: [crypto.randomUUID()] })).toEqual({ logIds: 'not_found' })
      expect(await fields({ level: 'full', exposure: { [other.owner]: 'name' } })).toEqual({ exposure: 'not_member' })
      expect(await fields({ level: 'full', usageTerms: { [clean.id]: { kind: 'license', spdx: 'WTFPL' } } })).toMatchObject({
        [`usageTerms.${clean.id}.spdx`]: 'invalid',
      })
      expect(await fields({ level: 'full', slug: 'projects' })).toEqual({ slug: 'reserved' })
      expect(await fields({ level: 'full', slug: 'Bad Slug' })).toEqual({ slug: 'invalid_format' })
      expect(await fields({ level: 'full', title: 'x'.repeat(81), summary: '' })).toEqual({ title: 'too_long', summary: 'required' })

      const taken = slug()
      await createCandidate(tx, { userId: other.owner }, other.project.id, { ...base, level: 'summary', slug: taken }, at(1))
      expect(await fields({ level: 'summary', slug: taken })).toEqual({ slug: 'taken' })

      const ok = await createCandidate(
        tx,
        { userId: owner },
        project.id,
        { ...base, level: 'full', artifactVersionIds: [clean.id], usageTerms: { [clean.id]: { kind: 'license', spdx: 'CC-BY-4.0' } } },
        at(2),
      )
      expect((await previewCandidate(tx, { userId: owner }, ok.id)).snapshot.artifacts).toEqual([
        { artifactVersionId: clean.id, displayName: 'report.pdf', mediaType: 'application/pdf', bytes: 10, usage: { kind: 'license', spdx: 'CC-BY-4.0' } },
      ])
    })
  })

  it('computes consent subjects (authors, meeting attendees, claimants incl. left members, uploaders); self-consent only when explicit', async () => {
    await withRollback(async (tx) => {
      const { owner, project, ids } = await team(tx, [
        { role: 'editor', name: '이편집' },
        { role: 'reviewer', name: '박리뷰' },
        { role: 'viewer', name: '최열람' },
        { role: 'editor', name: '정무관' },
      ])
      const [editor, reviewer, viewer, bystander] = ids
      const a = await log(tx, owner, project.id, progress('A가 쓴 로그'), 1)
      const b = await log(tx, editor!, project.id, { tag: 'stuck', body: '', payload: { symptom: 'CORS', keywords: [], attempts: [], timeBucket: 'lt2h' } }, 2)
      const meeting = await log(tx, owner, project.id, { tag: 'meeting', body: '회의', payload: { attendees: [owner, viewer] } }, 3)
      await log(tx, bystander!, project.id, progress('선택하지 않은 로그'), 4)
      const claim = await createClaim(tx, { userId: reviewer! }, project.id, { text: '코드 리뷰 담당' }, at(5))
      await leaveProject(tx, { userId: reviewer! }, project.id)
      const file = await fileVersion(tx, project.id, editor!, 'clean')

      const input = {
        level: 'full',
        title: '공개 제목',
        summary: '요약',
        slug: slug(),
        logIds: [a.id, b.id, meeting.id],
        claimIds: [claim.id],
        artifactVersionIds: [file.id],
        exposure: { [owner]: 'name', [editor!]: 'name' },
      }
      const first = await createCandidate(tx, { userId: owner }, project.id, input, at(10), ORIGINS)
      const byUser = Object.fromEntries(first.subjects.map((s) => [s.userId, s]))
      expect(Object.keys(byUser).sort()).toEqual([owner, editor, reviewer, viewer].sort())
      expect(byUser[owner]).toMatchObject({ scope: ['logs', 'meetings', 'name', 'title_summary'], status: 'pending', active: true, exposure: 'name' })
      expect(byUser[editor!]).toMatchObject({ scope: ['artifacts', 'logs', 'name'], status: 'pending', exposure: 'name' })
      expect(byUser[reviewer!]).toMatchObject({ scope: ['anonymous_label', 'claims'], active: false, exposure: 'anonymous' })
      expect(byUser[viewer!]).toMatchObject({ scope: ['anonymous_label', 'meetings'], active: true })
      expect(byUser[bystander!]).toBeUndefined()
      expect(first.blockers.filter((x) => x.kind === 'consent_missing')).toHaveLength(4)

      // 나간 멤버(당사자)도 후보·미리보기를 보고, 동의 요청 목록에서 찾고, 결정할 수 있습니다.
      const requests = await listMyConsentRequests(tx, { userId: reviewer! })
      expect(requests).toEqual([
        expect.objectContaining({ candidateId: first.id, projectId: project.id, projectTitle: '캡스톤 디자인', publicTitle: '공개 제목', scope: ['anonymous_label', 'claims'], previewUrl: `/consents?candidate=${first.id}` }),
      ])
      await expect(previewCandidate(tx, { userId: reviewer! }, first.id)).resolves.toMatchObject({ manifestHash: first.manifestHash })
      const asLeft = await decideConsent(tx, { userId: reviewer! }, first.id, { decision: 'granted', manifestHash: first.manifestHash }, at(11))
      expect(asLeft.myConsent).toBe('granted')
      expect(asLeft.checks.every((c) => c.fixUrl === null)).toBe(true)
      expect(await listMyConsentRequests(tx, { userId: reviewer! })).toEqual([])

      // 명시적으로 체크하면 만든 사람의 동의가 granted. 이전 후보는 superseded가 되고 그 결정은 409.
      const second = await createCandidate(tx, { userId: owner }, project.id, { ...input, consentSelf: true }, at(12), ORIGINS)
      expect(second.version).toBe(2)
      expect(second.subjects.find((s) => s.userId === owner)).toMatchObject({ status: 'granted', carried: false })
      // 새 후보에서는 이전 동의를 이어받지 않습니다(manifest 변경 → 다시 요청).
      expect(second.subjects.find((s) => s.userId === reviewer)).toMatchObject({ status: 'pending' })
      const old = await getCandidate(tx, { userId: owner }, first.id, at(13))
      expect(old).toMatchObject({ status: 'superseded', blockers: [{ kind: 'superseded' }], canDecide: false })
      const superseded = await expectServiceError(
        decideConsent(tx, { userId: editor! }, first.id, { decision: 'granted', manifestHash: first.manifestHash }, at(13)),
        'CONFLICT',
        'superseded',
      )
      expect(superseded.details).toEqual({ currentCandidateId: second.id })
      expect((await listMyConsentRequests(tx, { userId: editor! })).map((r) => r.candidateId)).toEqual([second.id])
    })
  })

  it('binds consent to the manifest hash, reaches ready only with every condition, and reopens when one breaks', async () => {
    await withRollback(async (tx) => {
      const { owner, project, ids } = await team(tx, [{ role: 'editor', name: '이편집' }])
      const [editor] = ids
      const a = await log(tx, owner, project.id, progress('A의 진행'), 1)
      const file = await fileVersion(tx, project.id, editor!, 'clean')
      const input = { level: 'full', title: '제목', summary: '요약', slug: slug(), logIds: [a.id], artifactVersionIds: [file.id], consentSelf: true }
      const candidate = await createCandidate(tx, { userId: owner }, project.id, input, at(10), ORIGINS)
      expect(candidate.manifestHash).toMatch(/^[0-9a-f]{64}$/)
      expect(candidate.status).toBe('awaiting_consent')
      expect(candidate.blockers).toEqual([{ kind: 'consent_missing', userId: editor, status: 'pending' }])

      const stale = await expectServiceError(
        decideConsent(tx, { userId: editor! }, candidate.id, { decision: 'granted', manifestHash: 'f'.repeat(64) }, at(11)),
        'CONFLICT',
        'stale_manifest',
      )
      expect(stale.details).toEqual({ currentManifestHash: candidate.manifestHash })
      await expectServiceError(decideConsent(tx, { userId: editor! }, candidate.id, { decision: 'maybe', manifestHash: candidate.manifestHash }, at(11)), 'VALIDATION')

      const ready = await decideConsent(tx, { userId: editor! }, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(12))
      expect(ready).toMatchObject({ status: 'ready', publicationStatus: 'ready', blockers: [], readyAt: at(12).toISOString() })

      // 결정을 바꾸면(거절) ready가 풀립니다.
      const reopened = await decideConsent(tx, { userId: editor! }, candidate.id, { decision: 'declined', manifestHash: candidate.manifestHash, note: '파일은 빼 주세요' }, at(13))
      // 결정한 editor에게는 미동의자 제외 버튼이 없고(owner만), owner에게는 있습니다.
      expect(reopened).toMatchObject({ status: 'awaiting_consent', publicationStatus: 'awaiting_consent', readyAt: null, canExcludeDeclined: false })
      expect((await getCandidate(tx, { userId: owner }, candidate.id, at(13))).canExcludeDeclined).toBe(true)
      expect(reopened.blockers).toEqual([{ kind: 'consent_missing', userId: editor, status: 'declined' }])
      expect(reopened.subjects.find((s) => s.userId === editor)).toMatchObject({ status: 'declined', note: '파일은 빼 주세요' })

      // 다시 동의 → ready. 그 뒤 파일 상태가 바뀌면(검사 재시도 등) 조회 때 다시 계산해 awaiting_consent로.
      await decideConsent(tx, { userId: editor! }, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(14))
      await tx.update(artifactVersions).set({ scanStatus: 'quarantined' }).where(eq(artifactVersions.id, file.id))
      const afterScan = await getCandidate(tx, { userId: owner }, candidate.id, at(15))
      expect(afterScan).toMatchObject({ status: 'awaiting_consent', publicationStatus: 'awaiting_consent' })
      expect(afterScan.blockers).toEqual([{ kind: 'file_not_clean', artifactVersionId: file.id, scanStatus: 'quarantined' }])
      await tx.update(artifactVersions).set({ scanStatus: 'clean' }).where(eq(artifactVersions.id, file.id))
      expect((await getCandidate(tx, { userId: owner }, candidate.id, at(16))).status).toBe('ready')

      // ready에서 새 후보를 만들면 이전 후보는 대체되고 공개는 다시 동의 대기.
      const revised = await createCandidate(tx, { userId: owner }, project.id, { ...input, title: '제목 수정' }, at(17), ORIGINS)
      expect(revised.manifestHash).not.toBe(candidate.manifestHash)
      expect(revised).toMatchObject({ status: 'awaiting_consent', publicationStatus: 'awaiting_consent', version: 2 })
      const [oldRow] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidate.id))
      expect(oldRow).toMatchObject({ status: 'superseded', readyAt: null })

      // 같은 선택을 다시 만들면 같은 해시(결정적).
      const again = await createCandidate(tx, { userId: owner }, project.id, { ...input, title: '제목 수정' }, at(18), ORIGINS)
      expect(again.manifestHash).toBe(revised.manifestHash)
    })
  })

  it('exclude-declined removes the decliner, changes the hash, and carries only grants whose own part is unchanged', async () => {
    await withRollback(async (tx) => {
      const { owner, project, ids } = await team(tx, [
        { role: 'editor', name: '이거절' },
        { role: 'editor', name: '정동의' },
      ])
      const [decliner, keeper] = ids
      const aLog = await log(tx, owner, project.id, progress('A 진행'), 1)
      const dLog = await log(tx, decliner!, project.id, progress('거절한 사람의 로그'), 2)
      const kLog = await log(tx, keeper!, project.id, progress('동의한 사람의 로그'), 3)
      const meeting = await log(tx, owner, project.id, { tag: 'meeting', body: '회의', payload: { attendees: [owner, decliner] } }, 4)
      const dFile = await fileVersion(tx, project.id, decliner!, 'clean', 'decliner.pdf')
      const dClaim = await createClaim(tx, { userId: decliner! }, project.id, { text: '프런트엔드' }, at(5))
      const input = {
        level: 'full',
        title: '제목',
        summary: '요약',
        slug: slug(),
        logIds: [aLog.id, dLog.id, kLog.id, meeting.id],
        claimIds: [dClaim.id],
        artifactVersionIds: [dFile.id],
        exposure: { [owner]: 'name', [decliner!]: 'name', [keeper!]: 'name' },
        consentSelf: true,
      }
      const first = await createCandidate(tx, { userId: owner }, project.id, input, at(10), ORIGINS)
      await decideConsent(tx, { userId: keeper! }, first.id, { decision: 'granted', manifestHash: first.manifestHash }, at(11))
      await expectServiceError(excludeDeclined(tx, { userId: owner }, first.id, {}, at(11)), 'CONFLICT', 'no_declined')
      await decideConsent(tx, { userId: decliner! }, first.id, { decision: 'declined', manifestHash: first.manifestHash }, at(12))

      await expectServiceError(excludeDeclined(tx, { userId: keeper! }, first.id, {}, at(13)), 'FORBIDDEN')
      await expectServiceError(excludeDeclined(tx, { userId: (await createUser(tx)).id }, first.id, {}, at(13)), 'NOT_FOUND')
      const next = await excludeDeclined(tx, { userId: owner }, first.id, {}, at(13), ORIGINS)
      expect(next).toMatchObject({ version: 2, derivedFromId: first.id, status: 'awaiting_consent' })
      expect(next.manifestHash).not.toBe(first.manifestHash)
      expect(next.selection.excludedUserIds).toEqual([decliner])
      expect(next.selection.logIds.sort()).toEqual([aLog.id, kLog.id, meeting.id].sort())
      expect(next.selection.claimIds).toEqual([])
      expect(next.selection.artifactVersionIds).toEqual([])

      const preview = await previewCandidate(tx, { userId: owner }, next.id)
      const text = JSON.stringify(preview.snapshot)
      expect(text).not.toContain('이거절')
      expect(text).not.toContain('거절한 사람의 로그')
      expect(text).not.toContain('프런트엔드')
      expect(text).not.toContain(dFile.id)
      expect(preview.snapshot.members.map((m) => m.label).sort()).toEqual(['김소유', '정동의'])
      const meetingOut = preview.snapshot.logs.find((l) => l.tag === 'meeting')!
      expect(meetingOut.payload.attendees).toHaveLength(1)

      // 당사자: 거절한 사람은 빠짐. 동의한 사람은 자기 부분이 같아 이어받음, 만든 사람은 회의 로그가 바뀌어 다시 요청.
      const byUser = Object.fromEntries(next.subjects.map((s) => [s.userId, s]))
      expect(byUser[decliner!]).toBeUndefined()
      expect(byUser[keeper!]).toMatchObject({ status: 'granted', carried: true })
      expect(byUser[owner]).toMatchObject({ status: 'pending', carried: false })
      const [carriedRow] = await tx.select().from(consents).where(eq(consents.candidateId, next.id))
      expect(carriedRow?.manifestHash).toBe(next.manifestHash)

      // 거절한 사람은 이전 후보에 결정할 수 없고(대체됨) 새 후보의 당사자도 아닙니다(멤버라서 볼 수는 있음).
      await expectServiceError(
        decideConsent(tx, { userId: decliner! }, first.id, { decision: 'granted', manifestHash: first.manifestHash }, at(14)),
        'CONFLICT',
        'superseded',
      )
      await expectServiceError(
        decideConsent(tx, { userId: decliner! }, next.id, { decision: 'granted', manifestHash: next.manifestHash }, at(14)),
        'FORBIDDEN',
        'not_subject',
      )
      await expectServiceError(excludeDeclined(tx, { userId: owner }, first.id, {}, at(14)), 'CONFLICT', 'superseded')

      const ready = await decideConsent(tx, { userId: owner }, next.id, { decision: 'granted', manifestHash: next.manifestHash }, at(15))
      expect(ready.status).toBe('ready')
    })
  })

  it('runs pre-publication checks on what will be public and stores warnings with locations', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await team(tx, [])
      const phoneLog = await log(tx, owner, project.id, progress('조원 연락처 010-1234-5678로 공유'), 1)
      const clean = await log(tx, owner, project.id, progress('2026-10-20 회의에서 범위를 줄였다'), 2)
      const answer = await fileVersion(tx, project.id, owner, 'clean', 'hw3-solution.pdf')
      const candidate = await createCandidate(
        tx,
        { userId: owner },
        project.id,
        { level: 'full', title: '제목', summary: '문의 kim.student@univ.ac.kr', slug: slug(), logIds: [phoneLog.id, clean.id], artifactVersionIds: [answer.id] },
        at(10),
        ORIGINS,
      )
      expect(candidate.checks).toEqual(
        expect.arrayContaining([
          { rule: 'email', location: { kind: 'summary', field: 'summary' }, sample: expect.any(String), fixUrl: null },
          {
            rule: 'phone',
            location: { kind: 'log', key: expect.stringMatching(/^l_/), field: 'body' },
            sample: '010-****-**78',
            fixUrl: `/projects/${project.id}#log-${phoneLog.id}`,
          },
          { rule: 'answer_file', location: { kind: 'artifact', key: answer.id, field: 'displayName' }, sample: 'hw3-solution.pdf', fixUrl: `/projects/${project.id}#artifacts-heading` },
        ]),
      )
      expect(candidate.checks).toHaveLength(3)
      expect(JSON.stringify(candidate.checks)).not.toContain('1234-5678')
      // 경고는 막지 않습니다.
      expect(candidate.status).toBe('awaiting_consent')
    })
  })

  it('preview returns exactly the stored snapshot, built only from selected revisions, with no private data', async () => {
    await withRollback(async (tx) => {
      const { owner, project, ids } = await team(tx, [{ role: 'editor', name: '이편집' }])
      const [editor] = ids
      await tx.update(users).set({ displayName: '김소유' }).where(eq(users.id, owner))
      const selected = await log(tx, owner, project.id, progress('공개할 첫 revision'), 1)
      await log(tx, owner, project.id, progress(`${SENTINEL} 선택하지 않은 로그`), 2)
      const milestone = await createMilestone(tx, { userId: owner }, project.id, { title: '중간발표', note: `${SENTINEL} 메모` }, at(3))
      const snapFile = await fileVersion(tx, project.id, editor!, 'clean', 'proto.png')
      await addSnapshot(tx, { userId: owner }, milestone.id, { artifactVersionId: snapFile.id, note: `${SENTINEL} 스냅샷 메모` }, at(4))
      const claim = await createClaim(tx, { userId: owner }, project.id, { text: 'API 담당', evidence: [{ kind: 'log', id: selected.id }] }, at(5))
      await setEndorsement(tx, { userId: editor! }, claim.revisionId, { status: 'disputed', note: `${SENTINEL} 확인 메모` }, at(6))
      await tx.insert(tasks).values({ projectId: project.id, title: '할 일', note: `${SENTINEL} 할 일 메모`, position: 1, createdBy: owner })
      await tx.insert(weeklyCheckins).values({ projectId: project.id, userId: owner, isoWeek: '2026-W45', timeBucket: 'lt2h', difficulty: 3, note: `${SENTINEL} 체크인` })
      await tx.update(artifactVersions).set({ scanReason: SENTINEL, objectKey: `clean/${SENTINEL}` }).where(eq(artifactVersions.id, snapFile.id))
      await tx.update(artifacts).set({ usageTerms: SENTINEL }).where(eq(artifacts.id, snapFile.artifactId))

      const candidate = await createCandidate(
        tx,
        { userId: owner },
        project.id,
        { level: 'full', title: '제목', summary: '요약', slug: slug(), logIds: [selected.id], milestoneIds: [milestone.id], claimIds: [claim.id], exposure: { [owner]: 'name' } },
        at(10),
        ORIGINS,
      )
      // 후보를 만든 뒤 로그를 고쳐도 스냅샷은 그때 revision 그대로.
      const { reviseLog } = await import('../server/modules/logs/logs')
      await reviseLog(tx, { userId: owner }, selected.id, { expectedRevision: 1, tag: 'progress', body: `${SENTINEL} 고친 revision` }, at(11))

      const preview = await previewCandidate(tx, { userId: editor! }, candidate.id)
      const [row] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidate.id))
      expect(preview.snapshot).toEqual(row!.snapshot)
      expect(preview.manifestHash).toBe(row!.manifestHash)
      const serialized = JSON.stringify(preview)
      expect(serialized).not.toContain(SENTINEL)
      for (const id of [owner, editor!, project.id, selected.id, milestone.id, claim.id]) expect(serialized, id).not.toContain(id)
      const [ownerRow] = await tx.select().from(users).where(eq(users.id, owner))
      expect(serialized).not.toContain(ownerRow!.privateEmail)
      expect(preview.snapshot.logs.map((l) => l.body)).toEqual(['공개할 첫 revision'])
      expect(preview.snapshot.claims[0]).toMatchObject({ status: 'disputed', disputedCount: 1, evidence: [{ kind: 'log', log: preview.snapshot.logs[0]!.key }] })
      expect(preview.snapshot.milestones[0]).toMatchObject({ title: '중간발표', snapshots: [{ artifactVersionId: snapFile.id }] })
      // 스냅샷 파일을 올린 editor는 당사자(익명).
      expect(candidate.subjects.find((s) => s.userId === editor)).toMatchObject({ scope: ['anonymous_label', 'artifacts'] })

      // 마일스톤이 바뀌어도 저장된 스냅샷은 그대로이고, 다시 만들면 해시가 달라집니다.
      await tx.update(milestones).set({ title: '중간발표(수정)', version: 2 }).where(eq(milestones.id, milestone.id))
      expect((await previewCandidate(tx, { userId: owner }, candidate.id)).snapshot).toEqual(row!.snapshot)
      const [pub] = await tx.select().from(publications).where(eq(publications.projectId, project.id))
      expect(pub).toMatchObject({ currentReleaseId: null, status: 'awaiting_consent' })
    })
  })
})
