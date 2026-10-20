/**
 * 메타데이터 제거 통합 테스트(실제 PostgreSQL + 임시 디렉터리 저장소, ADR 0007 "메타데이터 제거"). DATABASE_URL이 없으면 건너뜁니다.
 * - 검사 작업이 이미지 메타데이터를 지운 바이트를 clean 키에 쓰고 플래그·해시·크기·findings를 기록하는지
 * - 비공개·공개 내용 경로가 지운 바이트를 내주는지
 * - 이 기능 전에 clean이 된(지우기 전) 이미지가 공개 후보(422)·공개 조회(404)에서 빠지고, backfill 뒤 쓸 수 있게 되는지
 * 각 테스트는 rollback 트랜잭션 안에서 자기가 만든 행만 봅니다(backfill 결과도 자기 버전만 확인).
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { artifactVersions, eq, type DbExecutor } from '@peerchive/db'
import {
  type ObjectStorage,
  backfillMetadataStrip,
  cleanKeyFor,
  createFilesystemStorage,
  createSignatureOnlyScanner,
  readAll,
  scanArtifactVersion,
  writeObject,
} from '@peerchive/files'
import { completeUpload, createUploadIntent, getArtifact, openArtifactContent, receiveUpload } from '../server/modules/artifacts/artifacts'
import { createLog } from '../server/modules/logs/logs'
import { createProject } from '../server/modules/projects/projects'
import { createCandidate } from '../server/modules/publication/candidates'
import { openPublicArtifact } from '../server/modules/publication/public-read'
import { publishCandidate } from '../server/modules/publication/releases'
import { closeTestDb, createUser, databaseUrl, expectServiceError, minutes, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')
const at = (n: number) => new Date(T0.getTime() + minutes(n))
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

// ── 표본: GPS·방향(6)이 든 EXIF를 붙인 1×1 JPEG ────────────────────────────

const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
)
const GPS_MARK = 'GPS37.5665N126.9780E'

function exifApp1(): Buffer {
  const tiff = Buffer.alloc(80)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(2, 8) // IFD0 항목 2개
  tiff.writeUInt16LE(0x0112, 10) // Orientation = 6
  tiff.writeUInt16LE(3, 12)
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(6, 18)
  tiff.writeUInt16LE(0x8825, 22) // GPS IFD → 40
  tiff.writeUInt16LE(4, 24)
  tiff.writeUInt32LE(1, 26)
  tiff.writeUInt32LE(40, 30)
  tiff.writeUInt32LE(0, 34)
  tiff.writeUInt16LE(1, 40) // GPS IFD: 위도 문자열(표식)
  tiff.writeUInt16LE(0x0002, 42)
  tiff.writeUInt16LE(2, 44)
  tiff.writeUInt32LE(GPS_MARK.length, 46)
  tiff.writeUInt32LE(60, 50)
  tiff.writeUInt32LE(0, 54) // 다음 IFD 없음
  tiff.write(GPS_MARK, 60, 'latin1')
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const head = Buffer.alloc(4)
  head.writeUInt16BE(0xffe1, 0)
  head.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([head, payload])
}

const JPEG_GPS = Buffer.concat([JPEG_1x1.subarray(0, 20), exifApp1(), JPEG_1x1.subarray(20), Buffer.from([0x12, 0xff, 0xd9])])
const PDF_AUTHOR = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n2 0 obj<</Author (Kim Student)/Producer (Writer)>>endobj\ntrailer<</Root 1 0 R/Info 2 0 R>>\n%%EOF',
  'latin1',
)

let root: string
let storage: ObjectStorage
const scanner = createSignatureOnlyScanner()

async function upload(db: DbExecutor, userId: string, projectId: string, content: Buffer, fileName: string, declaredType: string) {
  const actor = { userId }
  const { intent } = await createUploadIntent(db, actor, projectId, { fileName, declaredType, byteSize: content.length }, T0)
  await receiveUpload(db, storage, actor, intent.intentId, Readable.from([content]), { contentLength: content.length }, T0)
  return completeUpload(db, storage, actor, intent.intentId, T0)
}

const rowOf = async (db: DbExecutor, id: string) => (await db.select().from(artifactVersions).where(eq(artifactVersions.id, id)))[0]!

describe.skipIf(!databaseUrl)('image metadata stripping (PostgreSQL)', () => {
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'peerchive-strip-'))
    storage = createFilesystemStorage(root)
  })
  afterAll(async () => {
    await closeTestDb()
    await rm(root, { recursive: true, force: true })
  })

  it('scan writes the stripped JPEG to clean storage, records flags/hash/size and deletes the quarantined original', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const project = await createProject(tx, { userId: owner.id }, { title: '사진 과제', kind: 'team' }, T0)
      const { artifact, version } = await upload(tx, owner.id, project.id, JPEG_GPS, 'photo.jpg', 'image/jpeg')
      const quarantineKey = (await rowOf(tx, version.id)).objectKey as `quarantine/${string}`

      expect(await scanArtifactVersion(tx, { storage, scanner }, version.id)).toEqual({ status: 'clean' })
      const row = await rowOf(tx, version.id)
      const stored = await readAll(await storage.get(cleanKeyFor(version.id)))
      expect(stored.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false)
      expect(stored.length).toBeLessThan(JPEG_GPS.length)
      expect(row).toMatchObject({
        scanStatus: 'clean',
        bytes: JPEG_GPS.length,
        sha256: sha256(JPEG_GPS), // 원래 해시(중복 판단용)는 그대로
        metadataStripped: true,
        strippedSha256: sha256(stored),
        strippedBytes: stored.length,
        metadataFindings: { format: 'jpeg', removed: ['exif', 'gps'], orientation: 6 },
      })
      expect(await storage.head(quarantineKey)).toBeNull()
      // 방향만 든 APP1이 남습니다.
      expect(stored.includes(Buffer.from('Exif\0\0II', 'latin1'))).toBe(true)

      const content = await openArtifactContent(tx, storage, { userId: owner.id }, artifact.id, version.id)
      expect(content).toMatchObject({ mediaType: 'image/jpeg', bytes: stored.length, sha256: sha256(stored) })
      expect((await readAll(content.stream)).equals(stored)).toBe(true)
      expect((await getArtifact(tx, { userId: owner.id }, artifact.id)).latestVersion).toMatchObject({
        metadataStripped: true,
        pdfAuthorMetadata: false,
      })
    })
  })

  it('PDFs are served unchanged with author findings (masked); broken images fail without a clean object', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const project = await createProject(tx, { userId: owner.id }, { title: '보고서 과제', kind: 'team' }, T0)
      const pdf = await upload(tx, owner.id, project.id, PDF_AUTHOR, 'report.pdf', 'application/pdf')
      expect(await scanArtifactVersion(tx, { storage, scanner }, pdf.version.id)).toEqual({ status: 'clean' })
      const row = await rowOf(tx, pdf.version.id)
      expect(row).toMatchObject({
        metadataStripped: false,
        strippedSha256: sha256(PDF_AUTHOR),
        strippedBytes: PDF_AUTHOR.length,
        metadataFindings: { format: 'pdf', fields: [{ field: 'Author', sample: 'K** *******' }, { field: 'Producer', sample: 'W*****' }] },
      })
      expect(JSON.stringify(row.metadataFindings)).not.toContain('Student')
      expect((await readAll(await storage.get(cleanKeyFor(pdf.version.id)))).equals(PDF_AUTHOR)).toBe(true)
      expect((await getArtifact(tx, { userId: owner.id }, pdf.artifact.id)).latestVersion).toMatchObject({
        metadataStripped: false,
        pdfAuthorMetadata: true,
      })

      // 공개 전 점검: 작성자 정보가 있는 PDF는 pdf_metadata 경고(가린 표본만).
      const log = (await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '보고서 작성' }, at(1))).log
      const candidate = await createCandidate(
        tx,
        { userId: owner.id },
        project.id,
        {
          level: 'full',
          title: '보고서 과제',
          summary: '보고서를 썼다.',
          slug: `pdf-${crypto.randomUUID().slice(0, 8)}`,
          logIds: [log.id],
          artifactVersionIds: [pdf.version.id],
          exposure: { [owner.id]: 'name' },
          consentSelf: true,
        },
        at(2),
      )
      expect(candidate.checks.filter((c) => c.rule === 'pdf_metadata')).toEqual([
        {
          rule: 'pdf_metadata',
          location: { kind: 'artifact', key: pdf.version.id, field: 'metadata' },
          sample: 'Author: K** *******',
          fixUrl: `/projects/${project.id}#artifacts-heading`,
        },
      ])

      const broken = JPEG_GPS.subarray(0, 30) // EXIF 세그먼트 중간에서 잘림
      const bad = await upload(tx, owner.id, project.id, broken, 'cut.jpg', 'image/jpeg')
      expect(await scanArtifactVersion(tx, { storage, scanner }, bad.version.id)).toEqual({ status: 'failed', reason: 'metadata_strip_failed' })
      expect(await rowOf(tx, bad.version.id)).toMatchObject({ scanStatus: 'failed', scanReason: 'metadata_strip_failed', metadataStripped: false })
      expect(await storage.head(cleanKeyFor(bad.version.id))).toBeNull()
      await expectServiceError(openArtifactContent(tx, storage, { userId: owner.id }, bad.artifact.id, bad.version.id), 'NOT_FOUND')
    })
  })

  it('a legacy (unstripped) image is excluded from candidates (422) and public reads (404) until the backfill strips it', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx, { displayName: '김소유' })
      const project = await createProject(tx, { userId: owner.id }, { title: '사진 과제', kind: 'team' }, T0)
      const { version } = await upload(tx, owner.id, project.id, JPEG_GPS, 'photo.jpg', 'image/jpeg')
      await scanArtifactVersion(tx, { storage, scanner }, version.id)
      const log = (await createLog(tx, { userId: owner.id }, project.id, { tag: 'progress', body: '촬영 완료' }, at(1))).log
      const input = {
        level: 'full',
        title: '사진 과제',
        summary: '사진을 찍었다.',
        slug: `strip-${crypto.randomUUID().slice(0, 8)}`,
        logIds: [log.id],
        artifactVersionIds: [version.id],
        exposure: { [owner.id]: 'name' },
        consentSelf: true,
      }
      const candidate = await createCandidate(tx, { userId: owner.id }, project.id, input, at(2))
      expect(candidate.status).toBe('ready')
      await publishCandidate(tx, { userId: owner.id }, candidate.id, { manifestHash: candidate.manifestHash }, at(3))
      const stripped = await readAll((await openPublicArtifact(tx, storage, input.slug, version.id, at(4))).stream)

      // 이 기능 전에 clean이 된 상태로 되돌립니다: clean 키에 원본, 플래그 없음.
      await writeObject(storage, cleanKeyFor(version.id), JPEG_GPS)
      await tx
        .update(artifactVersions)
        .set({ metadataStripped: false, strippedSha256: null, strippedBytes: null, metadataFindings: null })
        .where(eq(artifactVersions.id, version.id))

      await expectServiceError(openPublicArtifact(tx, storage, input.slug, version.id, at(5)), 'NOT_FOUND')
      const refused = await expectServiceError(createCandidate(tx, { userId: owner.id }, project.id, input, at(5)), 'VALIDATION')
      expect(refused.fields).toEqual({ artifactVersionIds: 'metadata_not_stripped' })
      // 비공개 작업 공간(올린 팀)에는 그대로 보입니다.
      const privateContent = await openArtifactContent(tx, storage, { userId: owner.id }, version.artifactId, version.id)
      expect(privateContent.bytes).toBe(JPEG_GPS.length)
      privateContent.stream.destroy()

      const dry = await backfillMetadataStrip(tx, storage, { dryRun: true })
      expect(dry.outcomes.filter((o) => o.versionId === version.id)).toEqual([{ versionId: version.id, status: 'would_update' }])
      expect(await rowOf(tx, version.id)).toMatchObject({ metadataStripped: false })

      const first = await backfillMetadataStrip(tx, storage, { batch: 2 })
      expect(first.outcomes.filter((o) => o.versionId === version.id)).toEqual([{ versionId: version.id, status: 'stripped' }])
      expect(await rowOf(tx, version.id)).toMatchObject({
        metadataStripped: true,
        strippedSha256: sha256(stripped),
        strippedBytes: stripped.length,
        sha256: sha256(JPEG_GPS),
        metadataFindings: { format: 'jpeg', removed: ['exif', 'gps'], orientation: 6 },
      })
      // 다시 실행해도 이 버전은 고르지 않습니다(멱등).
      const second = await backfillMetadataStrip(tx, storage)
      expect(second.outcomes.some((o) => o.versionId === version.id)).toBe(false)

      const served = await openPublicArtifact(tx, storage, input.slug, version.id, at(6))
      const body = await readAll(served.stream)
      expect(body.equals(stripped)).toBe(true)
      expect(body.includes(Buffer.from(GPS_MARK, 'latin1'))).toBe(false)
      expect(served.bytes).toBe(stripped.length)
      expect(served.etag).toContain(sha256(stripped).slice(0, 16))
      const again = await createCandidate(tx, { userId: owner.id }, project.id, { ...input }, at(7))
      expect(again.status).toBe('ready')
    })
  })

  it('backfill resumes after a crash between replacing the object and recording it', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const project = await createProject(tx, { userId: owner.id }, { title: '사진 과제', kind: 'team' }, T0)
      const { version } = await upload(tx, owner.id, project.id, JPEG_GPS, 'photo.jpg', 'image/jpeg')
      await scanArtifactVersion(tx, { storage, scanner }, version.id)
      const stripped = await readAll(await storage.get(cleanKeyFor(version.id)))
      // 내용은 이미 지운 것으로 바뀌었지만 DB에는 기록되지 않은 상태.
      await tx
        .update(artifactVersions)
        .set({ metadataStripped: false, strippedSha256: null, strippedBytes: null, metadataFindings: null })
        .where(eq(artifactVersions.id, version.id))
      const { outcomes } = await backfillMetadataStrip(tx, storage)
      expect(outcomes.filter((o) => o.versionId === version.id)).toEqual([{ versionId: version.id, status: 'unchanged' }])
      expect(await rowOf(tx, version.id)).toMatchObject({ metadataStripped: true, strippedSha256: sha256(stripped) })

      // 원본도 지운 결과도 아닌 내용이면 바꾸지 않고 실패로 보고합니다.
      await tx.update(artifactVersions).set({ metadataStripped: false }).where(eq(artifactVersions.id, version.id))
      await writeObject(storage, cleanKeyFor(version.id), Buffer.concat([JPEG_1x1.subarray(0, 20), exifApp1(), JPEG_1x1.subarray(20)]))
      const retry = await backfillMetadataStrip(tx, storage)
      expect(retry.outcomes.filter((o) => o.versionId === version.id)).toEqual([
        { versionId: version.id, status: 'failed', reason: 'integrity_mismatch' },
      ])
      expect(await rowOf(tx, version.id)).toMatchObject({ metadataStripped: false })
    })
  })
})
