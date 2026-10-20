/**
 * T-12 게시·철회·동의 철회·익명 공개 조회 통합 테스트(실제 PostgreSQL). DATABASE_URL이 없으면 건너뜁니다.
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 프로젝트·공개의 행만 봅니다(개발 DB에 남은 행과 무관, slug는 무작위).
 * 공개 조회는 같은 트랜잭션(tx)으로 읽어 "커밋 즉시(worker 없이) 막힘"을 확인하고, HTTP 계층(h3)도 tx로 조립해 헤더·쿠키·503을 봅니다.
 */
import { Readable } from 'node:stream'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp, createRouter, toWebHandler } from 'h3'
import type { ObjectStorage } from '@peerchive/files'
import {
  PUBLICATION_PUBLISHED_TOPIC,
  PUBLICATION_WITHDRAWN_TOPIC,
  and,
  artifactVersions,
  artifacts,
  auditEvents,
  consents,
  eq,
  outboxEvents,
  publicationCandidates,
  publications,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { createClaim } from '../server/modules/contribution/claims'
import { addProjectEmbargo } from '../server/modules/embargo/embargo'
import { createLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import {
  createCandidate,
  decideConsent,
  excludeDeclined,
  getCandidate,
  getPublicationState,
} from '../server/modules/publication/candidates'
import {
  createPublicArtifactHandler,
  createPublicKillSwitch,
  createPublicPublicationHandler,
  isPublicApiPath,
  isPublicPagePath,
  publicIndexingAllowed,
  publicReadsDisabled,
} from '../server/modules/publication/public-http'
import { getPublicPublication, openPublicArtifact } from '../server/modules/publication/public-read'
import { isPublicPagePath as isPublicPageForApp } from '../shared/utils/public-paths'
import {
  listMyPublishedConsents,
  publishCandidate,
  revokeConsent,
  withdrawPublication,
} from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const ORIGINS = { privateOrigins: ['http://localhost:3000'] }
const slug = () => `case-${crypto.randomUUID().slice(0, 8)}`
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

/** 저장소 대역: clean 키면 고정 내용을 돌려줍니다(파일 내용 자체는 T-05 테스트가 봄). */
const storage = {
  driver: 'test',
  get: async () => Readable.from([PNG]),
} as unknown as ObjectStorage

async function team(db: DbExecutor, names: string[]) {
  const owner = await createUser(db, { displayName: '김소유' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' }, T0)
  const ids: string[] = []
  for (const name of names) {
    const user = await createUser(db, { displayName: name })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role: 'editor' }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    ids.push(user.id)
  }
  return { owner: owner.id, ownerEmail: owner.email, project, ids }
}

async function fileVersion(db: DbExecutor, projectId: string, uploaderId: string, fileName = 'proto.png') {
  const [artifact] = await db.insert(artifacts).values({ projectId, uploaderId, title: fileName }).returning()
  const [version] = await db
    .insert(artifactVersions)
    .values({
      artifactId: artifact!.id,
      versionNo: 1,
      uploaderId,
      fileName,
      declaredType: 'image/png',
      mediaType: 'image/png',
      bytes: PNG.length,
      sha256: crypto.randomUUID().replaceAll('-', '').padEnd(64, '0'),
      objectKey: `clean/${crypto.randomUUID()}`,
      scanStatus: 'clean',
      // 검사 작업이 메타데이터를 지운 이미지(ADR 0007). 지우기 전 이미지는 metadata.integration.test.ts가 봅니다.
      metadataStripped: true,
    })
    .returning()
  return version!
}

const grant = (db: DbExecutor, userId: string, candidate: { id: string; manifestHash: string }, n: number) =>
  decideConsent(db, { userId }, candidate.id, { decision: 'granted', manifestHash: candidate.manifestHash }, at(n))

/** owner + editor 팀, 각자 로그 하나, editor가 올린 파일 하나로 전체 공개 후보를 만들고 둘 다 동의(ready). */
async function readyCandidate(db: DbExecutor, options: { slug?: string } = {}) {
  const { owner, ownerEmail, project, ids } = await team(db, ['이편집'])
  const [editor] = ids as [string]
  const ownerLog = (await createLog(db, { userId: owner }, project.id, { tag: 'progress', body: '파서 완성' }, at(1))).log
  const editorLog = (await createLog(db, { userId: editor }, project.id, { tag: 'progress', body: '파이프 구현' }, at(2))).log
  const file = await fileVersion(db, project.id, editor, 'pipe-diagram.png')
  const input = {
    level: 'full',
    title: '셸 구현 과제',
    summary: '파이프와 리다이렉션을 구현했다.',
    slug: options.slug ?? slug(),
    logIds: [ownerLog.id, editorLog.id],
    artifactVersionIds: [file.id],
    exposure: { [owner]: 'name' },
    consentSelf: true,
  }
  const candidate = await createCandidate(db, { userId: owner }, project.id, input, at(10), ORIGINS)
  const ready = await grant(db, editor, candidate, 11)
  expect(ready.status).toBe('ready')
  return { owner, ownerEmail, editor, project, file, input, candidate: ready, ownerLog, editorLog }
}

const outboxFor = (db: DbExecutor, topic: string, publicationId: string) =>
  db
    .select()
    .from(outboxEvents)
    .where(and(eq(outboxEvents.topic, topic), sql`${outboxEvents.payload}->>'publicationId' = ${publicationId}`))

describe('public route helpers', () => {
  it('recognizes public API/page paths and env flags', () => {
    expect(isPublicApiPath('/api/v1/public/publications/x')).toBe(true)
    expect(isPublicApiPath('/api/v1/publications/x/withdraw')).toBe(false)
    expect(isPublicApiPath('/api/v1/publicx')).toBe(false)
    expect(isPublicPagePath('/p/case-1')).toBe(true)
    expect(isPublicPagePath('/projects/1')).toBe(false)
    // 화면(auth 플러그인)과 서버가 같은 규칙: /p/**에서는 SSR이 로그인 상태를 가져오지 않습니다.
    expect(isPublicPageForApp).toBe(isPublicPagePath)
    expect(isPublicPagePath('/projects/p/1')).toBe(false)
    expect(isPublicPagePath('/pricing')).toBe(false)
    for (const v of ['1', 'true', 'YES', ' on ']) expect(publicReadsDisabled({ PEERCHIVE_PUBLIC_READS_DISABLED: v })).toBe(true)
    for (const v of [undefined, '', '0', 'false', 'no']) expect(publicReadsDisabled({ PEERCHIVE_PUBLIC_READS_DISABLED: v })).toBe(false)
    expect(publicIndexingAllowed({})).toBe(false)
    expect(publicIndexingAllowed({ PEERCHIVE_PUBLIC_INDEXING: '1' })).toBe(true)
  })
})

describe.skipIf(!databaseUrl)('publish, withdraw and public reads (PostgreSQL)', () => {
  afterAll(closeTestDb)

  it('publishes a ready candidate as release v1 and serves exactly the stored snapshot anonymously', async () => {
    await withRollback(async (tx) => {
      const { owner, ownerEmail, editor, project, file, candidate } = await readyCandidate(tx)
      const before = await getPublicationState(tx, { userId: owner }, project.id, at(12))
      expect(before.candidate).toMatchObject({ id: candidate.id, canPublish: true, releaseNo: null })
      expect((await getCandidate(tx, { userId: editor }, candidate.id, at(12))).canPublish).toBe(false)
      // 게시 전에는 익명 조회 404.
      await expectServiceError(getPublicPublication(tx, candidate.slug, at(12)), 'NOT_FOUND')

      const result = await publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash, idempotencyKey: 'k-1' }, at(13))
      expect(result).toMatchObject({
        idempotent: false,
        release: { candidateId: candidate.id, version: 1, candidateVersion: 1, status: 'published', publishedAt: at(13).toISOString() },
        publication: {
          status: 'published',
          accessEpoch: 1,
          currentRelease: { candidateId: candidate.id, version: 1 },
          publicPath: `/p/${candidate.slug}`,
          firstPublishedAt: at(13).toISOString(),
          slugLocked: true,
        },
      })
      const [row] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidate.id))
      expect(row).toMatchObject({ status: 'published', releaseNo: 1 })
      expect(await outboxFor(tx, PUBLICATION_PUBLISHED_TOPIC, result.publication.id)).toEqual([
        expect.objectContaining({
          payload: { publicationId: result.publication.id, projectId: project.id, releaseId: candidate.id, releaseNo: 1, accessEpoch: 1, replacedReleaseId: null },
        }),
      ])
      const audits = await tx.select().from(auditEvents).where(and(eq(auditEvents.action, 'publication.publish'), eq(auditEvents.targetId, result.publication.id)))
      expect(audits).toHaveLength(1)

      // 공개 조회: 저장된 스냅샷 그대로 + 공개 메타데이터만. 내부 id·이메일 없음.
      const pub = await getPublicPublication(tx, candidate.slug, at(14))
      expect(Object.keys(pub).sort()).toEqual(['courseId', 'firstPublishedAt', 'forkCount', 'level', 'publishedAt', 'slug', 'snapshot', 'version'])
      // 과목이 없는 과제: 과목 허브 연결 없음, 포크 없음(T-13).
      expect(pub).toMatchObject({ courseId: null, forkCount: 0 })
      expect(pub).toMatchObject({ slug: candidate.slug, level: 'full', version: 1, publishedAt: at(13).toISOString() })
      expect(pub.snapshot).toEqual(row!.snapshot)
      const text = JSON.stringify(pub)
      for (const secret of [owner, editor, project.id, candidate.id, result.publication.id, ownerEmail]) expect(text).not.toContain(secret)

      const content = await openPublicArtifact(tx, storage, candidate.slug, file.id, at(14))
      expect(content).toMatchObject({ mediaType: 'image/png', bytes: PNG.length, fileName: 'pipe-diagram.png' })
      expect(content.etag).toMatch(/^"pe1-r1-[0-9a-f]{16}"$/)
      // 대문자 id·잘못된 slug·없는 slug.
      await expect(openPublicArtifact(tx, storage, candidate.slug, file.id.toUpperCase(), at(14))).resolves.toBeTruthy()
      await expectServiceError(getPublicPublication(tx, 'Bad Slug', at(14)), 'NOT_FOUND')
      await expectServiceError(getPublicPublication(tx, `${candidate.slug}-x`, at(14)), 'NOT_FOUND')

      // 재시도: 같은 후보·해시면 아무것도 바꾸지 않고 같은 결과.
      const again = await publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash, idempotencyKey: 'k-2' }, at(15))
      expect(again).toMatchObject({ idempotent: true, release: { version: 1 }, publication: { accessEpoch: 1 } })
      expect(await outboxFor(tx, PUBLICATION_PUBLISHED_TOPIC, result.publication.id)).toHaveLength(1)
      await expectServiceError(
        publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: 'a'.repeat(64) }, at(15)),
        'CONFLICT',
        'stale_manifest',
      )

      const state = await getPublicationState(tx, { userId: owner }, project.id, at(16))
      expect(state).toMatchObject({ canManage: true, publication: { status: 'published' }, candidate: { id: candidate.id, releaseNo: 1, canPublish: false } })
      expect(state.releases.map((r) => [r.version, r.status])).toEqual([[1, 'published']])
      expect(await listMyPublishedConsents(tx, { userId: editor })).toEqual([
        expect.objectContaining({ publicationId: result.publication.id, slug: candidate.slug, version: 1, publicPath: `/p/${candidate.slug}` }),
      ])
    })
  })

  it('refuses to publish when any condition fails, re-checked inside the transaction', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project, file, candidate, input } = await readyCandidate(tx)
      const stranger = (await createUser(tx)).id
      const publish = (userId: string, c = candidate, n = 20) => publishCandidate(tx, { userId }, c.id, { manifestHash: c.manifestHash }, at(n))

      // 권한: editor 403, 비멤버 404, 없는 id 404, 형식 422.
      await expectServiceError(publish(editor), 'FORBIDDEN')
      await expectServiceError(publish(stranger), 'NOT_FOUND')
      await expectServiceError(publishCandidate(tx, { userId: owner }, crypto.randomUUID(), { manifestHash: candidate.manifestHash }, at(20)), 'NOT_FOUND')
      await expectServiceError(publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: 'xyz' }, at(20)), 'VALIDATION')
      // 낡은 해시.
      const stale = await expectServiceError(
        publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: 'b'.repeat(64) }, at(20)),
        'CONFLICT',
        'stale_manifest',
      )
      expect(stale.details).toEqual({ currentManifestHash: candidate.manifestHash })

      // ready 뒤에 파일이 격리되면(검사 재시도 등) 게시 때 다시 검사해 막습니다.
      await tx.update(artifactVersions).set({ scanStatus: 'quarantined' }).where(eq(artifactVersions.id, file.id))
      const notClean = await expectServiceError(publish(owner), 'CONFLICT', 'publish_blocked')
      expect(notClean.details).toMatchObject({ blockers: [{ kind: 'file_not_clean', artifactVersionId: file.id, scanStatus: 'quarantined' }] })
      await tx.update(artifactVersions).set({ scanStatus: 'clean' }).where(eq(artifactVersions.id, file.id))

      // 동의 거절·철회 상태(어떤 경로로든)면 막습니다.
      await decideConsent(tx, { userId: editor }, candidate.id, { decision: 'declined', manifestHash: candidate.manifestHash }, at(21))
      const declined = await expectServiceError(publish(owner, candidate, 22), 'CONFLICT', 'publish_blocked')
      expect(declined.details).toMatchObject({ blockers: [{ kind: 'consent_missing', userId: editor, status: 'declined' }] })
      await tx.update(consents).set({ status: 'revoked', decidedAt: at(22) }).where(and(eq(consents.candidateId, candidate.id), eq(consents.subjectUserId, editor)))
      const revoked = await expectServiceError(publish(owner, candidate, 23), 'CONFLICT', 'publish_blocked')
      expect(revoked.details).toMatchObject({ blockers: [{ kind: 'consent_missing', userId: editor, status: 'revoked' }] })
      await grant(tx, editor, candidate, 24)

      // 동의한 당사자가 탈퇴하면 그 동의는 유효하지 않습니다.
      await tx.update(users).set({ status: 'deleted', deletionRequestedAt: at(24) }).where(eq(users.id, editor))
      const inactive = await expectServiceError(publish(owner, candidate, 25), 'CONFLICT', 'publish_blocked')
      expect(inactive.details).toMatchObject({ blockers: [{ kind: 'subject_inactive', userId: editor }] })
      expect((await getCandidate(tx, { userId: owner }, candidate.id, at(25))).blockers).toEqual([{ kind: 'subject_inactive', userId: editor }])
      await tx.update(users).set({ status: 'active', deletionRequestedAt: null }).where(eq(users.id, editor))

      // ready 뒤에 엠바고가 걸리면 409 embargo_active.
      const until = new Date('2027-03-01T00:00:00Z')
      await addProjectEmbargo(tx, { userId: owner }, project.id, { until: until.toISOString(), reason: '재수강 학기' }, at(26))
      const embargo = await expectServiceError(publish(owner, candidate, 27), 'CONFLICT', 'embargo_active')
      expect(embargo.details).toEqual({ until: until.toISOString() })
      await tx.execute(sql`update embargoes set revoked_at = now() where project_id = ${project.id}`)

      // 새 후보가 생기면 이전 후보는 대체되어 게시할 수 없습니다.
      const next = await createCandidate(tx, { userId: owner }, project.id, { ...input, title: '셸 구현 과제(수정)' }, at(28), ORIGINS)
      const superseded = await expectServiceError(publish(owner, candidate, 29), 'CONFLICT', 'superseded')
      expect(superseded.details).toEqual({ currentCandidateId: next.id })
      // 새 후보는 아직 동의 대기라 막힙니다(editor 동의 필요).
      const pending = await expectServiceError(publish(owner, next, 30), 'CONFLICT', 'publish_blocked')
      expect(pending.details).toMatchObject({ candidateStatus: 'awaiting_consent', blockers: [{ kind: 'consent_missing', userId: editor, status: 'pending' }] })

      // 실패한 시도는 아무것도 남기지 않습니다.
      const [pub] = await tx.select().from(publications).where(eq(publications.projectId, project.id))
      expect(pub).toMatchObject({ status: 'awaiting_consent', currentReleaseId: null, accessEpoch: 0, firstPublishedAt: null })
      expect(await outboxFor(tx, PUBLICATION_PUBLISHED_TOPIC, pub!.id)).toEqual([])
      await expectServiceError(getPublicPublication(tx, candidate.slug, at(30)), 'NOT_FOUND')

      // 모두 고치면 게시됩니다.
      await grant(tx, editor, next, 31)
      await expect(publish(owner, next, 32)).resolves.toMatchObject({ release: { version: 1, candidateVersion: 2 } })
    })
  })

  it('owner withdrawal blocks the public JSON and files immediately (same transaction, no worker) and bumps access_epoch', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, file, candidate } = await readyCandidate(tx)
      const { publication } = await publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash }, at(13))
      await expect(getPublicPublication(tx, candidate.slug, at(14))).resolves.toMatchObject({ version: 1 })
      await expect(openPublicArtifact(tx, storage, candidate.slug, file.id, at(14))).resolves.toBeTruthy()

      await expectServiceError(withdrawPublication(tx, { userId: editor }, publication.id, {}, at(15)), 'FORBIDDEN')
      await expectServiceError(withdrawPublication(tx, { userId: (await createUser(tx)).id }, publication.id, {}, at(15)), 'NOT_FOUND')
      await expectServiceError(withdrawPublication(tx, { userId: owner }, publication.id, { reason: 'x'.repeat(301) }, at(15)), 'VALIDATION')
      const withdrawn = await withdrawPublication(tx, { userId: owner }, publication.id, { reason: '오류 발견' }, at(15))
      expect(withdrawn).toMatchObject({
        status: 'withdrawn',
        accessEpoch: 2,
        currentRelease: null,
        publicPath: null,
        withdrawCause: 'owner',
        withdrawNote: '오류 발견',
        withdrawnAt: at(15).toISOString(),
      })
      // 같은 트랜잭션 안의 다음 조회부터 404(캐시·worker 없음).
      await expectServiceError(getPublicPublication(tx, candidate.slug, at(15)), 'NOT_FOUND')
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, file.id, at(15)), 'NOT_FOUND')
      expect(await outboxFor(tx, PUBLICATION_WITHDRAWN_TOPIC, publication.id)).toEqual([
        expect.objectContaining({
          payload: { publicationId: publication.id, projectId: candidate.projectId, releaseId: candidate.id, releaseNo: 1, accessEpoch: 2, cause: 'owner' },
        }),
      ])
      const [release] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidate.id))
      expect(release).toMatchObject({ status: 'withdrawn', withdrawnAt: at(15) })
      expect(await listMyPublishedConsents(tx, { userId: editor })).toEqual([])

      // 다시 철회해도 그대로(200), 철회된 release는 다시 게시할 수 없습니다.
      await expect(withdrawPublication(tx, { userId: owner }, publication.id, {}, at(16))).resolves.toMatchObject({ status: 'withdrawn', accessEpoch: 2 })
      await expectServiceError(
        publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash }, at(16)),
        'CONFLICT',
        'superseded',
      )
      // 게시한 적 없는 공개의 철회는 409.
      const other = await readyCandidate(tx)
      await expectServiceError(withdrawPublication(tx, { userId: other.owner }, (await getPublicationState(tx, { userId: other.owner }, other.project.id, at(17))).publication!.id, {}, at(17)), 'CONFLICT', 'not_published')
    })
  })

  it('a subject revoking consent withdraws the release; the owner republishes without them and old files stop being served', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project, file, candidate, ownerLog } = await readyCandidate(tx)
      const ownerFile = await fileVersion(tx, project.id, owner, 'final-report.png')
      const viewer = await createUser(tx, { displayName: '최열람' })
      const { token } = await createInvitation(tx, { userId: owner }, project.id, { role: 'viewer' }, T0)
      await acceptInvitation(tx, { userId: viewer.id }, { token }, T0)
      const { publication } = await publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash }, at(13))

      // 당사자가 아닌 멤버 403, 비멤버 404, 없는 공개 404.
      await expectServiceError(revokeConsent(tx, { userId: viewer.id }, publication.id, {}, at(14)), 'FORBIDDEN', 'not_subject')
      await expectServiceError(revokeConsent(tx, { userId: (await createUser(tx)).id }, publication.id, {}, at(14)), 'NOT_FOUND')
      await expectServiceError(revokeConsent(tx, { userId: editor }, crypto.randomUUID(), {}, at(14)), 'NOT_FOUND')

      const revoked = await revokeConsent(tx, { userId: editor }, publication.id, { note: '제 파일은 빼 주세요' }, at(14))
      expect(revoked).toEqual({ publicationId: publication.id, publicationStatus: 'withdrawn', consentStatus: 'revoked' })
      await expectServiceError(getPublicPublication(tx, candidate.slug, at(14)), 'NOT_FOUND')
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, file.id, at(14)), 'NOT_FOUND')
      const [pubRow] = await tx.select().from(publications).where(eq(publications.id, publication.id))
      expect(pubRow).toMatchObject({ status: 'withdrawn', accessEpoch: 2, withdrawCause: 'consent_revoked', withdrawNote: null })
      expect(await outboxFor(tx, PUBLICATION_WITHDRAWN_TOPIC, publication.id)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ cause: 'consent_revoked', accessEpoch: 2 }) }),
      ])
      // 다시 철회해도 그대로.
      await expect(revokeConsent(tx, { userId: editor }, publication.id, {}, at(15))).resolves.toMatchObject({ publicationStatus: 'withdrawn' })
      const [consentRow] = await tx.select().from(consents).where(and(eq(consents.candidateId, candidate.id), eq(consents.subjectUserId, editor)))
      expect(consentRow).toMatchObject({ status: 'revoked', note: '제 파일은 빼 주세요' })

      // owner는 철회한 사람을 뺀 새 후보를 만듭니다(철회된 지금 release에서). 자기 부분이 그대로인 owner 동의는 이어받습니다.
      const state = await getPublicationState(tx, { userId: owner }, project.id, at(16))
      expect(state.candidate).toMatchObject({ id: candidate.id, status: 'withdrawn', canExcludeDeclined: true, canPublish: false })
      await expectServiceError(excludeDeclined(tx, { userId: editor }, candidate.id, {}, at(16)), 'FORBIDDEN')
      const v2 = await excludeDeclined(tx, { userId: owner }, candidate.id, {}, at(16), ORIGINS)
      expect(v2).toMatchObject({ status: 'ready', derivedFromId: candidate.id, version: 2, publicationStatus: 'ready' })
      expect(v2.selection.excludedUserIds).toEqual([editor])
      expect(v2.selection.logIds).toEqual([ownerLog.id])
      expect(v2.subjects).toEqual([expect.objectContaining({ userId: owner, status: 'granted', carried: true })])

      const second = await publishCandidate(tx, { userId: owner }, v2.id, { manifestHash: v2.manifestHash }, at(17))
      expect(second).toMatchObject({ release: { version: 2, candidateVersion: 2 }, publication: { accessEpoch: 3, status: 'published' } })
      const pub = await getPublicPublication(tx, candidate.slug, at(18))
      expect(pub).toMatchObject({ version: 2, firstPublishedAt: at(13).toISOString(), publishedAt: at(17).toISOString() })
      expect(JSON.stringify(pub)).not.toContain('파이프 구현')
      // 이전 release에만 있던 파일, 스냅샷에 없는 같은 프로젝트의 clean 파일은 모두 404.
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, file.id, at(18)), 'NOT_FOUND')
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, ownerFile.id, at(18)), 'NOT_FOUND')
      const history = (await getPublicationState(tx, { userId: owner }, project.id, at(18))).releases
      expect(history.map((r) => [r.version, r.status])).toEqual([
        [2, 'published'],
        [1, 'withdrawn'],
      ])
    })
  })

  it('a new version can be prepared while published; publishing it replaces the old release and its files', async () => {
    await withRollback(async (tx) => {
      const { owner, editor, project, file, candidate, input } = await readyCandidate(tx)
      await publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash }, at(13))
      const newFile = await fileVersion(tx, project.id, owner, 'final.png')

      // 주소는 고정(422 locked), 공개 상태는 published 그대로이고 v1이 계속 보입니다.
      const locked = await expectServiceError(
        createCandidate(tx, { userId: owner }, project.id, { ...input, slug: slug() }, at(14), ORIGINS),
        'VALIDATION',
      )
      expect(locked.fields).toEqual({ slug: 'locked' })
      const next = await createCandidate(
        tx,
        { userId: owner },
        project.id,
        { ...input, title: '셸 구현 과제 v2', artifactVersionIds: [newFile.id], level: 'full' },
        at(15),
        ORIGINS,
      )
      expect(next).toMatchObject({ status: 'awaiting_consent', publicationStatus: 'published', version: 2 })
      await expect(getPublicPublication(tx, candidate.slug, at(15))).resolves.toMatchObject({ version: 1, snapshot: { title: '셸 구현 과제' } })
      const ready = await grant(tx, editor, next, 16)
      expect(ready).toMatchObject({ status: 'ready', publicationStatus: 'published', canPublish: false })
      expect((await getCandidate(tx, { userId: owner }, next.id, at(16))).canPublish).toBe(true)

      const result = await publishCandidate(tx, { userId: owner }, next.id, { manifestHash: next.manifestHash }, at(17))
      expect(result).toMatchObject({ release: { version: 2 }, publication: { accessEpoch: 2, currentRelease: { candidateId: next.id, version: 2 } } })
      const [old] = await tx.select().from(publicationCandidates).where(eq(publicationCandidates.id, candidate.id))
      expect(old).toMatchObject({ status: 'replaced', replacedAt: at(17) })
      expect((await outboxFor(tx, PUBLICATION_PUBLISHED_TOPIC, result.publication.id)).map((r) => r.payload.replacedReleaseId)).toEqual([null, candidate.id])

      await expect(getPublicPublication(tx, candidate.slug, at(18))).resolves.toMatchObject({ version: 2, snapshot: { title: '셸 구현 과제 v2' } })
      await expect(openPublicArtifact(tx, storage, candidate.slug, newFile.id, at(18))).resolves.toMatchObject({ etag: expect.stringMatching(/^"pe2-r2-/) })
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, file.id, at(18)), 'NOT_FOUND')
      // 대체된 release는 다시 게시할 수 없습니다.
      await expectServiceError(publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash }, at(19)), 'CONFLICT', 'superseded')
    })
  })

  it('serves no file outside the current snapshot, nothing during a later embargo, and summary releases have no files', async () => {
    await withRollback(async (tx) => {
      const { owner, project, file, candidate } = await readyCandidate(tx)
      const notSelected = await fileVersion(tx, project.id, owner, 'not-selected.png')
      const other = await readyCandidate(tx)
      await publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash }, at(13))
      await publishCandidate(tx, { userId: other.owner }, other.candidate.id, { manifestHash: other.candidate.manifestHash }, at(13))

      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, notSelected.id, at(14)), 'NOT_FOUND')
      // 다른 공개의 파일을 이 slug로 열 수 없습니다.
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, other.file.id, at(14)), 'NOT_FOUND')
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, 'not-a-uuid', at(14)), 'NOT_FOUND')
      // 스냅샷에 있어도 지금 clean이 아니면 404.
      await tx.update(artifactVersions).set({ scanStatus: 'quarantined' }).where(eq(artifactVersions.id, file.id))
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, file.id, at(14)), 'NOT_FOUND')
      await tx.update(artifactVersions).set({ scanStatus: 'clean' }).where(eq(artifactVersions.id, file.id))
      await expect(openPublicArtifact(tx, storage, candidate.slug, file.id, at(14))).resolves.toBeTruthy()

      // 게시 뒤에 걸린 엠바고도 공개 조회를 막습니다.
      await addProjectEmbargo(tx, { userId: owner }, project.id, { until: '2027-03-01T00:00:00Z', reason: '재수강' }, at(15))
      await expectServiceError(getPublicPublication(tx, candidate.slug, at(16)), 'NOT_FOUND')
      await expectServiceError(openPublicArtifact(tx, storage, candidate.slug, file.id, at(16)), 'NOT_FOUND')
      await expect(getPublicPublication(tx, other.candidate.slug, at(16))).resolves.toBeTruthy()
    })
  })

  it('HTTP: anonymous JSON and files with security headers and no cookies; kill switch 503 without touching the DB', async () => {
    await withRollback(async (tx) => {
      const { owner, file, candidate } = await readyCandidate(tx)
      await publishCandidate(tx, { userId: owner }, candidate.id, { manifestHash: candidate.manifestHash }, at(13))
      const env: Record<string, string | undefined> = {}
      let dbCalls = 0
      const getDb = () => {
        dbCalls++
        return tx
      }
      const router = createRouter()
        .get('/api/v1/public/publications/:slug', createPublicPublicationHandler({ getDb, getEnv: () => env, now: () => at(14) }))
        .get(
          '/api/v1/public/publications/:slug/artifacts/:versionId',
          createPublicArtifactHandler({ getDb, getEnv: () => env, getStorage: () => storage, now: () => at(14) }),
        )
      const app = createApp()
      app.use(createPublicKillSwitch(() => env))
      app.use(router)
      const handler = toWebHandler(app)
      // 로그인 쿠키가 있어도 같은 응답이고 쿠키를 쓰지 않습니다(이 경로는 세션 미들웨어가 건너뜀).
      const get = (path: string) => handler(new Request(`http://localhost:3000${path}`, { headers: { cookie: 'peerchive_session=whatever' } }))

      const json = await get(`/api/v1/public/publications/${candidate.slug}`)
      expect(json.status).toBe(200)
      expect(json.headers.get('set-cookie')).toBeNull()
      expect(json.headers.get('cache-control')).toBe('no-store')
      expect(json.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(json.headers.get('x-content-type-options')).toBe('nosniff')
      const body = (await json.json()) as { version: number; snapshot: { title: string } }
      expect(body).toMatchObject({ version: 1, snapshot: { title: '셸 구현 과제' } })

      const fileRes = await get(`/api/v1/public/publications/${candidate.slug}/artifacts/${file.id}`)
      expect(fileRes.status).toBe(200)
      expect(Object.fromEntries(['content-type', 'x-content-type-options', 'content-security-policy', 'cache-control', 'cross-origin-resource-policy', 'x-robots-tag'].map((h) => [h, fileRes.headers.get(h)]))).toEqual({
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-origin',
        'x-robots-tag': 'noindex, nofollow',
      })
      expect(fileRes.headers.get('content-disposition')).toContain('inline')
      expect(fileRes.headers.get('content-disposition')).toContain('pipe-diagram.png')
      expect(fileRes.headers.get('etag')).toMatch(/^"pe1-r1-/)
      expect(fileRes.headers.get('set-cookie')).toBeNull()
      expect(Buffer.from(await fileRes.arrayBuffer())).toEqual(PNG)

      const missing = await get(`/api/v1/public/publications/${candidate.slug}/artifacts/${crypto.randomUUID()}`)
      expect(missing.status).toBe(404)
      expect(missing.headers.get('cache-control')).toBe('no-store')
      expect((await get('/api/v1/public/publications/no-such-case')).status).toBe(404)

      // 색인 허용 설정이면 JSON의 noindex를 뺍니다(파일은 항상 noindex).
      env.PEERCHIVE_PUBLIC_INDEXING = '1'
      expect((await get(`/api/v1/public/publications/${candidate.slug}`)).headers.get('x-robots-tag')).toBeNull()
      delete env.PEERCHIVE_PUBLIC_INDEXING

      // 운영 스위치: DB를 건드리지 않고 503.
      env.PEERCHIVE_PUBLIC_READS_DISABLED = '1'
      const callsBefore = dbCalls
      for (const path of [`/api/v1/public/publications/${candidate.slug}`, `/api/v1/public/publications/${candidate.slug}/artifacts/${file.id}`]) {
        const res = await get(path)
        expect(res.status).toBe(503)
        expect(res.headers.get('cache-control')).toBe('no-store')
        expect(res.headers.get('retry-after')).toBe('300')
        expect(res.headers.get('set-cookie')).toBeNull()
        expect(JSON.stringify(await res.json())).toContain('public_reads_disabled')
      }
      expect(dbCalls).toBe(callsBefore)
      // 미들웨어가 없어도 handler가 막습니다.
      const bare = toWebHandler(createApp().use(router))
      expect((await bare(new Request(`http://localhost:3000/api/v1/public/publications/${candidate.slug}`))).status).toBe(503)
      delete env.PEERCHIVE_PUBLIC_READS_DISABLED
      expect((await get(`/api/v1/public/publications/${candidate.slug}`)).status).toBe(200)
    })
  })

  it('claims from a revoking subject are excluded too, and other subjects keep their grants only when their part is unchanged', async () => {
    await withRollback(async (tx) => {
      const { owner, project, ids } = await team(tx, ['이선언', '정동의'])
      const [claimant, keeper] = ids as [string, string]
      const ownerLog = (await createLog(tx, { userId: owner }, project.id, { tag: 'progress', body: '설계' }, at(1))).log
      const keeperLog = (await createLog(tx, { userId: keeper }, project.id, { tag: 'progress', body: '테스트' }, at(2))).log
      const claim = await createClaim(tx, { userId: claimant }, project.id, { text: '프런트엔드 담당' }, at(3))
      const candidate = await createCandidate(
        tx,
        { userId: owner },
        project.id,
        {
          level: 'summary',
          title: '요약 공개',
          summary: '요약',
          slug: slug(),
          logIds: [ownerLog.id, keeperLog.id],
          claimIds: [claim.id],
          // 이름으로 표시하면 한 사람을 빼도 다른 사람의 표시가 바뀌지 않습니다(익명이면 "팀원 A/B" 순서가 바뀌어 다시 동의해야 할 수 있음).
          exposure: { [owner]: 'name', [claimant]: 'name', [keeper]: 'name' },
          consentSelf: true,
        },
        at(10),
        ORIGINS,
      )
      await grant(tx, claimant, candidate, 11)
      const ready = await grant(tx, keeper, candidate, 12)
      const { publication } = await publishCandidate(tx, { userId: owner }, ready.id, { manifestHash: ready.manifestHash }, at(13))
      expect((await getPublicPublication(tx, ready.slug, at(13))).snapshot.artifacts).toEqual([])

      await revokeConsent(tx, { userId: claimant }, publication.id, {}, at(14))
      const v2 = await excludeDeclined(tx, { userId: owner }, ready.id, {}, at(15), ORIGINS)
      expect(v2.selection.claimIds).toEqual([])
      const byUser = Object.fromEntries(v2.subjects.map((s) => [s.userId, s]))
      expect(byUser[claimant]).toBeUndefined()
      expect(byUser[keeper]).toMatchObject({ status: 'granted', carried: true })
      expect(byUser[owner]).toMatchObject({ status: 'granted', carried: true })
      expect(v2.status).toBe('ready')
    })
  })
})
