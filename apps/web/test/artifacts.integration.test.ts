/**
 * T-05 파일 업로드·격리·검사·근거 통합 테스트(실제 PostgreSQL + 임시 디렉터리 저장소). DATABASE_URL이 없으면 건너뜁니다.
 * 검사 작업은 worker 대신 scanArtifactVersion을 직접 부릅니다.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { USER_QUOTA_BYTES } from '@peerchive/domain'
import {
  artifactVersions,
  artifacts,
  auditEvents,
  eq,
  outboxEvents,
  sql,
  uploadIntents,
  type DbExecutor,
} from '@peerchive/db'
import {
  type MalwareScanner,
  type ObjectStorage,
  cleanKeyFor,
  createFilesystemStorage,
  createSignatureOnlyScanner,
  readAll,
  scanArtifactVersion,
} from '@peerchive/files'
import {
  completeUpload,
  createUploadIntent,
  getArtifact,
  listArtifacts,
  openArtifactContent,
  receiveUpload,
  retryArtifactScan,
} from '../server/modules/artifacts/artifacts'
import { createLog, getLog, listLogRevisions, reviseLog } from '../server/modules/logs/logs'
import { acceptInvitation, createInvitation } from '../server/modules/projects/invitations'
import { createProject } from '../server/modules/projects/projects'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const PNG_2 = Buffer.concat([PNG, Buffer.from('추가 데이터')]) // 내용이 다른 PNG(뒤에 붙인 바이트)
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1')
const HTML_AS_PNG = Buffer.from('<!DOCTYPE html><html><body><script>alert(document.cookie)</script></body></html>')

let root: string
let storage: ObjectStorage
const scanner = createSignatureOnlyScanner()

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
}

async function teamWith(db: DbExecutor, ...roles: Array<'editor' | 'reviewer' | 'viewer'>) {
  const owner = await createUser(db, { displayName: '소유자' })
  const project = await createProject(db, { userId: owner.id }, { title: '캡스톤 디자인', kind: 'team' })
  const members = []
  for (const role of roles) {
    const user = await createUser(db, { displayName: role })
    const { token } = await createInvitation(db, { userId: owner.id }, project.id, { role }, T0)
    await acceptInvitation(db, { userId: user.id }, { token }, T0)
    members.push(user)
  }
  return { owner, project, members }
}

/** 의도 → 내용 → 완료. */
async function upload(
  db: DbExecutor,
  userId: string,
  projectId: string,
  content: Buffer,
  input: { fileName?: string; declaredType?: string; artifactId?: string } = {},
) {
  const actor = { userId }
  const { intent } = await createUploadIntent(
    db,
    actor,
    projectId,
    { fileName: 'screen.png', declaredType: 'image/png', byteSize: content.length, ...input },
    T0,
  )
  await receiveUpload(db, storage, actor, intent.intentId, Readable.from([content]), { contentLength: content.length }, T0)
  return { intent, ...(await completeUpload(db, storage, actor, intent.intentId, T0)) }
}

describe.skipIf(!databaseUrl)('artifact upload, scan and evidence (PostgreSQL)', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-artifacts-'))
    storage = createFilesystemStorage(root)
  })
  afterAll(async () => {
    await closeTestDb()
    await rm(root, { recursive: true, force: true })
  })

  it('only active owner/editor create upload intents; reviewer/viewer 403, non-members 404', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor', 'reviewer', 'viewer')
      const [editor, reviewer, viewer] = members
      const stranger = await createUser(tx)
      const input = { fileName: 'a.png', declaredType: 'image/png', byteSize: 10 }

      const { intent, created } = await createUploadIntent(tx, { userId: editor!.id }, project.id, input, T0)
      expect(created).toBe(true)
      expect(intent).toMatchObject({
        uploadUrl: `/api/v1/uploads/${intent.intentId}`,
        completeUrl: `/api/v1/uploads/${intent.intentId}/complete`,
        byteSize: 10,
        expiresAt: at(15).toISOString(),
        uploaded: false,
        completed: false,
      })
      expect(JSON.stringify(intent)).not.toContain('quarantine')
      await createUploadIntent(tx, { userId: owner.id }, project.id, input, T0)
      for (const user of [reviewer!, viewer!]) {
        await expectServiceError(createUploadIntent(tx, { userId: user.id }, project.id, input, T0), 'FORBIDDEN')
      }
      await expectServiceError(createUploadIntent(tx, { userId: stranger.id }, project.id, input, T0), 'NOT_FOUND')
      await expectServiceError(createUploadIntent(tx, { userId: owner.id }, crypto.randomUUID(), input, T0), 'NOT_FOUND')
    })
  })

  it('validates type, extension, size and target artifact; clientId replays the same intent', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const other = await teamWith(tx)
      const actor = { userId: owner.id }
      const bad = async (input: Record<string, unknown>) =>
        (await expectServiceError(createUploadIntent(tx, actor, project.id, input, T0), 'VALIDATION')).fields

      expect(await bad({ fileName: 'a.svg', declaredType: 'image/svg+xml', byteSize: 10 })).toEqual({ declaredType: 'unsupported_type' })
      expect(await bad({ fileName: 'a.html', declaredType: 'text/html', byteSize: 10 })).toEqual({ declaredType: 'unsupported_type' })
      expect(await bad({ fileName: 'a.zip', declaredType: 'application/zip', byteSize: 10 })).toEqual({ declaredType: 'unsupported_type' })
      expect(await bad({ fileName: 'a.png.exe', declaredType: 'image/png', byteSize: 10 })).toEqual({ fileName: 'extension_mismatch' })
      expect(await bad({ fileName: 'a.png', declaredType: 'image/png', byteSize: 20 * 1024 * 1024 + 1 })).toEqual({ byteSize: 'too_large' })
      expect(await bad({ fileName: 'a.png', declaredType: 'image/png', byteSize: 0 })).toEqual({ byteSize: 'empty' })
      expect(await bad({ fileName: '...', declaredType: 'image/png', byteSize: 1 })).toEqual({ fileName: 'required' })
      expect(await bad({})).toEqual({ fileName: 'required', declaredType: 'required', byteSize: 'required' })

      // 다른 프로젝트의 산출물에는 새 버전을 올릴 수 없습니다(없는 것과 같은 422).
      const { artifact: foreign } = await upload(tx, other.owner.id, other.project.id, PNG)
      expect(await bad({ fileName: 'a.png', declaredType: 'image/png', byteSize: 1, artifactId: foreign.id })).toEqual({
        artifactId: 'not_found',
      })

      // 파일 이름은 정리해서 저장합니다(경로·제어 문자 제거).
      const clientId = crypto.randomUUID()
      const first = await createUploadIntent(
        tx,
        actor,
        project.id,
        { fileName: '../../보고서\r\n.pdf', declaredType: 'application/pdf', byteSize: 5, clientId },
        T0,
      )
      const replay = await createUploadIntent(
        tx,
        actor,
        project.id,
        { fileName: 'other.png', declaredType: 'image/png', byteSize: 99, clientId },
        T0,
      )
      expect(replay).toEqual({ intent: first.intent, created: false })
      const [row] = await tx.select().from(uploadIntents).where(eq(uploadIntents.id, first.intent.intentId))
      expect(row).toMatchObject({ fileName: '보고서.pdf', byteSize: 5 })
      expect(row!.quarantineKey).toMatch(/^quarantine\/[0-9a-f-]{36}$/)
    })
  })

  it('aborts and cleans up when the body exceeds or falls short of the declared size; other users get 404', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const actor = { userId: owner.id }
      const before = await filesUnder(root)
      const { intent } = await createUploadIntent(
        tx,
        actor,
        project.id,
        { fileName: 'a.png', declaredType: 'image/png', byteSize: PNG.length },
        T0,
      )
      const id = intent.intentId

      // Content-Length가 다르면 읽기 전에 거부합니다.
      await expectServiceError(receiveUpload(tx, storage, actor, id, Readable.from([PNG]), { contentLength: PNG.length + 1 }, T0), 'PAYLOAD_TOO_LARGE')
      const short = await expectServiceError(
        receiveUpload(tx, storage, actor, id, Readable.from([PNG]), { contentLength: PNG.length - 1 }, T0),
        'VALIDATION',
      )
      expect(short.fields).toEqual({ byteSize: 'size_mismatch' })

      // 헤더 없이 실제로 더 보내면 한도에서 끊고, 덜 보내면 크기 불일치. 둘 다 받던 내용을 지웁니다.
      const big = Readable.from([PNG, Buffer.alloc(1024 * 1024)])
      await expectServiceError(receiveUpload(tx, storage, actor, id, big, {}, T0), 'PAYLOAD_TOO_LARGE')
      expect(await filesUnder(root)).toEqual(before)
      const fewer = await expectServiceError(receiveUpload(tx, storage, actor, id, Readable.from([PNG.subarray(0, 10)]), {}, T0), 'VALIDATION')
      expect(fewer.fields).toEqual({ byteSize: 'size_mismatch' })
      expect(await filesUnder(root)).toEqual(before)

      // 다른 사용자(같은 프로젝트 편집자 포함)는 남의 의도를 쓸 수 없습니다.
      await expectServiceError(receiveUpload(tx, storage, { userId: members[0]!.id }, id, Readable.from([PNG]), {}, T0), 'NOT_FOUND')
      await expectServiceError(completeUpload(tx, storage, { userId: members[0]!.id }, id, T0), 'NOT_FOUND')

      // 완료 전에 내용이 없으면 409, 실패 뒤 다시 보내면 성공, 두 번째 PUT은 409.
      await expectServiceError(completeUpload(tx, storage, actor, id, T0), 'CONFLICT', 'not_uploaded')
      const received = await receiveUpload(tx, storage, actor, id, Readable.from([PNG]), { contentLength: PNG.length }, T0)
      expect(received.uploaded).toBe(true)
      await expectServiceError(receiveUpload(tx, storage, actor, id, Readable.from([PNG]), {}, T0), 'CONFLICT', 'already_uploaded')

      // 만료된 의도는 410.
      const { intent: late } = await createUploadIntent(tx, actor, project.id, { fileName: 'b.png', declaredType: 'image/png', byteSize: PNG.length }, T0)
      await expectServiceError(receiveUpload(tx, storage, actor, late.intentId, Readable.from([PNG]), {}, at(16)), 'GONE')
    })
  })

  it('enforces the per-user quota (versions + open intents) with 422 quota_exceeded', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const actor = { userId: owner.id }
      const { artifact } = await upload(tx, owner.id, project.id, PNG)
      // 한도 근처까지 쓴 것처럼 기존 버전 크기를 늘립니다(실제 파일 없이 사용량만).
      await tx
        .update(artifactVersions)
        .set({ bytes: USER_QUOTA_BYTES - 15 * 1024 * 1024 })
        .where(eq(artifactVersions.artifactId, artifact.id))

      const input = { fileName: 'a.pdf', declaredType: 'application/pdf', byteSize: 10 * 1024 * 1024 }
      await createUploadIntent(tx, actor, project.id, input, T0) // 10MB 예약
      const over = await expectServiceError(createUploadIntent(tx, actor, project.id, input, T0), 'VALIDATION')
      expect(over.fields).toEqual({ byteSize: 'quota_exceeded' })
      // 만료된 의도의 예약은 세지 않습니다.
      await createUploadIntent(tx, actor, project.id, input, at(16))
    })
  })

  it('complete is idempotent, deduplicates identical content per artifact and queues one scan job per version', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'editor')
      const actor = { userId: owner.id }
      const first = await upload(tx, owner.id, project.id, PNG, { fileName: '화면 설계.png' })
      expect(first.created).toBe(true)
      expect(first.artifact).toMatchObject({ projectId: project.id, kind: 'file', title: '화면 설계.png', canUpload: true })
      expect(first.version).toMatchObject({
        versionNo: 1,
        fileName: '화면 설계.png',
        declaredType: 'image/png',
        mediaType: 'image/png',
        bytes: PNG.length,
        scanStatus: 'pending',
        contentUrl: null,
        uploader: { userId: owner.id, displayName: '소유자' },
      })
      expect(JSON.stringify(first)).not.toMatch(/quarantine|object_?key|sha256/i)

      const again = await completeUpload(tx, storage, actor, first.intent.intentId, at(1))
      expect(again).toMatchObject({ created: false, version: { id: first.version.id } })

      // 같은 산출물에 같은 내용 → 기존 버전, 다른 내용 → v2(편집자도 올릴 수 있음).
      const same = await upload(tx, members[0]!.id, project.id, PNG, { artifactId: first.artifact.id })
      expect(same).toMatchObject({ created: false, version: { id: first.version.id, versionNo: 1 } })
      const v2 = await upload(tx, members[0]!.id, project.id, PNG_2, { artifactId: first.artifact.id, fileName: '화면 설계 v2.png' })
      expect(v2).toMatchObject({ created: true, version: { versionNo: 2, fileName: '화면 설계 v2.png' } })
      expect(v2.artifact.versions.map((v) => v.versionNo)).toEqual([2, 1])
      expect(v2.artifact.latestVersion?.id).toBe(v2.version.id)

      // 다른 산출물이면 같은 내용이어도 따로 만듭니다.
      const separate = await upload(tx, owner.id, project.id, PNG)
      expect(separate.created).toBe(true)
      expect(separate.artifact.id).not.toBe(first.artifact.id)

      const jobs = await tx.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'versionId' in (${first.version.id}, ${v2.version.id})`)
      expect(jobs.map((j) => j.topic)).toEqual(['artifact-scan', 'artifact-scan'])
      const audits = await tx.select().from(auditEvents).where(eq(auditEvents.targetId, first.artifact.id))
      expect(audits.map((a) => a.action)).toEqual(['artifact.upload', 'artifact.upload'])
    })
  })

  it('scan → clean moves the object out of quarantine and enables member downloads only', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'viewer')
      const stranger = await createUser(tx)
      const other = await teamWith(tx)
      const { artifact, version } = await upload(tx, owner.id, project.id, PNG)
      const [row] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id))
      expect(await storage.head(row!.objectKey as `quarantine/${string}`)).toEqual({ bytes: PNG.length })

      // 검사 전에는 멤버도 내용을 받을 수 없습니다(404).
      await expectServiceError(openArtifactContent(tx, storage, { userId: owner.id }, artifact.id, version.id), 'NOT_FOUND')

      expect(await scanArtifactVersion(tx, { storage, scanner, now: () => at(2) }, version.id)).toEqual({ status: 'clean' })
      const [scanned] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id))
      expect(scanned).toMatchObject({
        scanStatus: 'clean',
        objectKey: cleanKeyFor(version.id),
        mediaType: 'image/png',
        scanEngine: 'signature-only',
        scanAttempts: 1,
        scannedAt: at(2),
      })
      expect(await storage.head(row!.objectKey as `quarantine/${string}`)).toBeNull()
      // 다시 실행해도 아무것도 바뀌지 않습니다.
      expect(await scanArtifactVersion(tx, { storage, scanner }, version.id)).toEqual({ status: 'skipped', current: 'clean' })

      for (const userId of [owner.id, members[0]!.id]) {
        const content = await openArtifactContent(tx, storage, { userId }, artifact.id, version.id)
        expect(content).toMatchObject({ mediaType: 'image/png', bytes: PNG.length, fileName: 'screen.png' })
        expect((await readAll(content.stream)).equals(PNG)).toBe(true)
      }
      const dto = await getArtifact(tx, { userId: members[0]!.id }, artifact.id)
      expect(dto.latestVersion).toMatchObject({ scanStatus: 'clean', contentUrl: `/api/v1/artifacts/${artifact.id}/versions/${version.id}/content` })
      expect(dto.canUpload).toBe(false)

      // 비멤버·다른 프로젝트 멤버·잘못 짝지은 id는 모두 404.
      await expectServiceError(openArtifactContent(tx, storage, { userId: stranger.id }, artifact.id, version.id), 'NOT_FOUND')
      await expectServiceError(openArtifactContent(tx, storage, { userId: other.owner.id }, artifact.id, version.id), 'NOT_FOUND')
      await expectServiceError(openArtifactContent(tx, storage, { userId: owner.id }, crypto.randomUUID(), version.id), 'NOT_FOUND')
      await expectServiceError(getArtifact(tx, { userId: stranger.id }, artifact.id), 'NOT_FOUND')
      await expectServiceError(listArtifacts(tx, { userId: stranger.id }, project.id), 'NOT_FOUND')
    })
  })

  it('HTML disguised as PNG is quarantined, kept isolated and never downloadable, even for members', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const { artifact, version } = await upload(tx, owner.id, project.id, HTML_AS_PNG, { fileName: 'cute-cat.png' })
      expect(version.mediaType).toBeNull() // 업로드 시 판별: 허용 형식 아님

      expect(await scanArtifactVersion(tx, { storage, scanner }, version.id)).toEqual({ status: 'quarantined', reason: 'disallowed_type' })
      const [row] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id))
      expect(row).toMatchObject({ scanStatus: 'quarantined', scanReason: 'disallowed_type', scanEngine: 'signature-only' })
      expect(row!.objectKey).toMatch(/^quarantine\//)
      expect(await storage.head(row!.objectKey as `quarantine/${string}`)).toEqual({ bytes: HTML_AS_PNG.length })
      expect(await storage.head(cleanKeyFor(version.id))).toBeNull()

      await expectServiceError(openArtifactContent(tx, storage, { userId: owner.id }, artifact.id, version.id), 'NOT_FOUND')
      const [listed] = await listArtifacts(tx, { userId: owner.id }, project.id)
      expect(listed!.latestVersion).toMatchObject({ scanStatus: 'quarantined', scanReason: 'disallowed_type', contentUrl: null })
      // 격리는 최종 상태이며 다시 시도할 수 없습니다.
      await expectServiceError(retryArtifactScan(tx, { userId: owner.id }, artifact.id, version.id), 'CONFLICT', 'not_failed')

      // 실제 PDF를 PNG라고 선언하면 형식 불일치로 격리합니다.
      const mismatch = await upload(tx, owner.id, project.id, PDF, { fileName: 'x.png' })
      expect(await scanArtifactVersion(tx, { storage, scanner }, mismatch.version.id)).toEqual({ status: 'quarantined', reason: 'type_mismatch' })
    })
  })

  it('scanner errors keep the version scanning until the final attempt, then failed; users can retry failed scans', async () => {
    await withRollback(async (tx) => {
      const { owner, project, members } = await teamWith(tx, 'viewer')
      const { artifact, version } = await upload(tx, owner.id, project.id, PDF, { fileName: '보고서.pdf', declaredType: 'application/pdf' })
      const broken: MalwareScanner = {
        engine: 'clamav',
        async scan() {
          throw new Error('clamd: connect ECONNREFUSED')
        },
      }
      await expect(scanArtifactVersion(tx, { storage, scanner: broken }, version.id)).rejects.toThrow(/scan failed/)
      const status = async () => (await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id)))[0]!
      expect(await status()).toMatchObject({ scanStatus: 'scanning', scanAttempts: 1 })
      await expect(scanArtifactVersion(tx, { storage, scanner: broken }, version.id, { finalAttempt: true })).rejects.toThrow()
      expect(await status()).toMatchObject({ scanStatus: 'failed', scanReason: 'scan_error', scanAttempts: 2 })

      await expectServiceError(retryArtifactScan(tx, { userId: members[0]!.id }, artifact.id, version.id), 'FORBIDDEN')
      const retried = await retryArtifactScan(tx, { userId: owner.id }, artifact.id, version.id)
      expect(retried.latestVersion).toMatchObject({ scanStatus: 'pending', scanReason: null })
      const jobs = await tx.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'versionId' = ${version.id}`)
      expect(jobs).toHaveLength(2)

      // EICAR 시험 문자열은 악성코드로 격리합니다(PDF 안에 넣어 형식 검사는 통과).
      const eicar = Buffer.concat([PDF, Buffer.from('\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1')])
      const infected = await upload(tx, owner.id, project.id, eicar, { fileName: 'e.pdf', declaredType: 'application/pdf' })
      expect(await scanArtifactVersion(tx, { storage, scanner }, infected.version.id)).toEqual({
        status: 'quarantined',
        reason: 'malware',
        signature: 'EICAR-Test-File',
      })
      expect(await scanArtifactVersion(tx, { storage, scanner }, version.id)).toEqual({ status: 'clean' })
    })
  })

  it('build log evidence: same-project versions only, pending allowed, quarantined rejected, carried over on revise', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const other = await teamWith(tx)
      const actor = { userId: owner.id }
      const clean = await upload(tx, owner.id, project.id, PNG, { fileName: '와이어프레임.png' })
      await scanArtifactVersion(tx, { storage, scanner }, clean.version.id)
      const pending = await upload(tx, owner.id, project.id, PDF, { fileName: '보고서.pdf', declaredType: 'application/pdf' })
      const bad = await upload(tx, owner.id, project.id, HTML_AS_PNG, { fileName: 'x.png' })
      await scanArtifactVersion(tx, { storage, scanner }, bad.version.id)
      const foreign = await upload(tx, other.owner.id, other.project.id, PNG)

      const { log } = await createLog(
        tx,
        actor,
        project.id,
        { tag: 'progress', body: '화면 설계 완료', evidenceVersionIds: [clean.version.id, pending.version.id, clean.version.id] },
        at(1),
      )
      expect(log.evidence).toEqual([
        {
          versionId: clean.version.id,
          artifactId: clean.artifact.id,
          title: '와이어프레임.png',
          fileName: '와이어프레임.png',
          versionNo: 1,
          mediaType: 'image/png',
          scanStatus: 'clean',
          contentUrl: `/api/v1/artifacts/${clean.artifact.id}/versions/${clean.version.id}/content`,
        },
        expect.objectContaining({ versionId: pending.version.id, scanStatus: 'pending', contentUrl: null }),
      ])

      const create = (ids: string[]) => createLog(tx, actor, project.id, { tag: 'progress', body: 'x', evidenceVersionIds: ids }, at(2))
      expect((await expectServiceError(create([foreign.version.id]), 'VALIDATION')).fields).toEqual({ evidenceVersionIds: 'not_found' })
      expect((await expectServiceError(create([crypto.randomUUID()]), 'VALIDATION')).fields).toEqual({ evidenceVersionIds: 'not_found' })
      expect((await expectServiceError(create([bad.version.id]), 'VALIDATION')).fields).toEqual({ evidenceVersionIds: 'not_attachable' })
      const tooMany = Array.from({ length: 11 }, () => crypto.randomUUID())
      expect((await expectServiceError(create(tooMany), 'VALIDATION')).fields).toEqual({ evidenceVersionIds: 'too_many' })

      // 수정: 생략하면 이어받고, 붙인 뒤 격리된 버전도 이어받은 근거로는 남습니다. null은 비웁니다.
      await tx.update(artifactVersions).set({ scanStatus: 'quarantined', scanReason: 'malware' }).where(eq(artifactVersions.id, pending.version.id))
      const r2 = await reviseLog(tx, actor, log.id, { expectedRevision: 1, body: '화면 설계 완료(정정)' }, at(3))
      expect(r2.evidence.map((e) => [e.versionId, e.scanStatus])).toEqual([
        [clean.version.id, 'clean'],
        [pending.version.id, 'quarantined'],
      ])
      // 격리된 버전을 새로 붙이는 것은 거부합니다(이전 revision에 없던 경우).
      const r3 = await reviseLog(tx, actor, log.id, { expectedRevision: 2, evidenceVersionIds: [clean.version.id] }, at(4))
      expect(r3.evidence.map((e) => e.versionId)).toEqual([clean.version.id])
      const readd = await expectServiceError(
        reviseLog(tx, actor, log.id, { expectedRevision: 3, evidenceVersionIds: [clean.version.id, pending.version.id] }, at(5)),
        'VALIDATION',
      )
      expect(readd.fields).toEqual({ evidenceVersionIds: 'not_attachable' })
      // 근거만 같으면 바뀐 것이 없습니다.
      const same = await expectServiceError(
        reviseLog(tx, actor, log.id, { expectedRevision: 3, evidenceVersionIds: [clean.version.id] }, at(5)),
        'VALIDATION',
      )
      expect(same.fields).toEqual({ _: 'no_changes' })
      const r4 = await reviseLog(tx, actor, log.id, { expectedRevision: 3, evidenceVersionIds: null }, at(6))
      expect(r4.evidence).toEqual([])

      const history = await listLogRevisions(tx, actor, log.id)
      expect(history.map((h) => h.evidenceVersionIds)).toEqual([
        [clean.version.id, pending.version.id],
        [clean.version.id, pending.version.id],
        [clean.version.id],
        [],
      ])
      expect((await getLog(tx, actor, log.id)).evidence).toEqual([])
    })
  })

  it('a version whose object vanished fails without retry; artifacts never point outside their project', async () => {
    await withRollback(async (tx) => {
      const { owner, project } = await teamWith(tx)
      const { version } = await upload(tx, owner.id, project.id, PNG)
      const [row] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id))
      await storage.delete(row!.objectKey as `quarantine/${string}`)
      expect(await scanArtifactVersion(tx, { storage, scanner }, version.id)).toEqual({ status: 'failed', reason: 'object_missing' })
      expect(await scanArtifactVersion(tx, { storage, scanner }, crypto.randomUUID())).toEqual({ status: 'skipped', current: 'missing' })
      const rows = await tx.select({ projectId: artifacts.projectId }).from(artifacts).where(eq(artifacts.id, version.artifactId))
      expect(rows).toEqual([{ projectId: project.id }])
    })
  })
})
