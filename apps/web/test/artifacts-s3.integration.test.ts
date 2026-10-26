/**
 * S3 호환 저장소로 업로드 → 검사 → clean → 내려받기 전체 흐름(ADR 0007·0017). PostgreSQL과 로컬 MinIO가 모두 있을 때만 실행합니다
 * (DATABASE_URL, PEERCHIVE_TEST_S3_*: packages/files/test/s3-testing.ts).
 * 저장소·검사기는 worker와 같은 설정 함수(loadWorkerConfig)로 만들고, 검사는 worker의 작업 처리 함수(handleScanJob)로 돌립니다.
 * 테스트마다 무작위 prefix를 쓰고 끝나면 지웁니다. DB는 rollback.
 */
import { Readable } from 'node:stream'
import { crc32 } from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { artifactVersions, eq, type DbExecutor } from '@peerchive/db'
import { type ObjectStorage, cleanKeyFor, readAll } from '@peerchive/files'
import { loadWorkerConfig, type WorkerConfig } from '../../worker/src/config'
import { handleScanJob } from '../../worker/src/scan-worker'
import { completeUpload, createUploadIntent, openArtifactContent, receiveUpload } from '../server/modules/artifacts/artifacts'
import { deepHealth } from '../server/modules/ops/health'
import { createProject } from '../server/modules/projects/projects'
import { ensureTestBucket, listRawNames, removeTestPrefix, s3TestConfig, s3TestEnabled, s3TestEnv } from '../../../packages/files/test/s3-testing'
import { closeTestDb, createUser, databaseUrl, expectServiceError, withRollback } from './helpers'

const T0 = new Date('2026-11-02T09:00:00Z')

/** PNG 청크 하나(길이·종류·데이터·CRC). */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
/** IHDR 뒤에 위치 정보가 든 tEXt 청크를 끼운 PNG. 검사 작업이 이 청크를 지워야 합니다. */
const PNG_WITH_TEXT = Buffer.concat([PNG.subarray(0, 33), chunk('tEXt', Buffer.from('Location\0GPS37.5665N126.9780E', 'latin1')), PNG.subarray(33)])
const HTML_AS_PNG = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>')

describe.skipIf(!databaseUrl || !s3TestEnabled)('artifact flow on S3-compatible storage (PostgreSQL + MinIO)', () => {
  const s3 = s3TestEnabled ? s3TestConfig() : null
  let config: WorkerConfig
  let storage: ObjectStorage

  beforeAll(async () => {
    await ensureTestBucket(s3!)
    config = loadWorkerConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl!, ...s3TestEnv(s3!) })
    storage = config.storage
  })
  afterEach(async () => {
    await removeTestPrefix(s3!)
  })
  afterAll(async () => {
    ;(storage as ObjectStorage & { destroy?: () => void })?.destroy?.()
    await closeTestDb()
  })

  async function upload(db: DbExecutor, userId: string, projectId: string, content: Buffer, fileName = 'screen.png') {
    const actor = { userId }
    const { intent } = await createUploadIntent(db, actor, projectId, { fileName, declaredType: 'image/png', byteSize: content.length }, T0)
    await receiveUpload(db, storage, actor, intent.intentId, Readable.from([content]), { contentLength: content.length }, T0)
    return completeUpload(db, storage, actor, intent.intentId, T0)
  }

  it('worker config resolves the s3 driver and the signature-only scanner outside production', () => {
    expect(config.storage.driver).toBe('s3')
    expect(config.scanner.engine).toBe('signature-only')
  })

  it('upload → worker scan → clean (metadata stripped) → member download, quarantine object removed', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const stranger = await createUser(tx)
      const project = await createProject(tx, { userId: owner.id }, { title: 'S3 흐름', kind: 'individual' })
      const { artifact, version } = await upload(tx, owner.id, project.id, PNG_WITH_TEXT)
      const [row] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id))
      expect(row!.objectKey).toMatch(/^quarantine\//)
      expect(await listRawNames(s3!)).toEqual([row!.objectKey])

      // 검사 전에는 404.
      await expectServiceError(openArtifactContent(tx, storage, { userId: owner.id }, artifact.id, version.id), 'NOT_FOUND')

      await handleScanJob(tx, { storage, scanner: config.scanner }, { id: crypto.randomUUID(), data: { versionId: version.id }, retryCount: 0 })
      const [scanned] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id))
      expect(scanned).toMatchObject({ scanStatus: 'clean', objectKey: cleanKeyFor(version.id), mediaType: 'image/png', metadataStripped: true })
      expect(scanned!.strippedBytes).toBe(PNG.length)
      // 버킷에는 clean 키 하나만 남습니다(격리 원본·임시 키 없음).
      expect(await listRawNames(s3!)).toEqual([cleanKeyFor(version.id)])

      const content = await openArtifactContent(tx, storage, { userId: owner.id }, artifact.id, version.id)
      expect(content).toMatchObject({ mediaType: 'image/png', bytes: PNG.length, sha256: scanned!.strippedSha256 })
      const body = await readAll(content.stream)
      expect(body.equals(PNG)).toBe(true)
      expect(body.includes(Buffer.from('GPS37'))).toBe(false)
      await expectServiceError(openArtifactContent(tx, storage, { userId: stranger.id }, artifact.id, version.id), 'NOT_FOUND')
    })
  })

  it('disguised HTML stays in quarantine on S3 and is never served', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const project = await createProject(tx, { userId: owner.id }, { title: 'S3 격리', kind: 'individual' })
      const { artifact, version } = await upload(tx, owner.id, project.id, HTML_AS_PNG, 'cat.png')
      await handleScanJob(tx, { storage, scanner: config.scanner }, { id: crypto.randomUUID(), data: { versionId: version.id }, retryCount: 0 })
      const [row] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, version.id))
      expect(row).toMatchObject({ scanStatus: 'quarantined', scanReason: 'disallowed_type' })
      expect(await listRawNames(s3!)).toEqual([row!.objectKey])
      await expectServiceError(openArtifactContent(tx, storage, { userId: owner.id }, artifact.id, version.id), 'NOT_FOUND')
    })
  })

  it('an oversized body is rejected with 413 and nothing is stored', async () => {
    await withRollback(async (tx) => {
      const owner = await createUser(tx)
      const project = await createProject(tx, { userId: owner.id }, { title: 'S3 한도', kind: 'individual' })
      const actor = { userId: owner.id }
      const { intent } = await createUploadIntent(tx, actor, project.id, { fileName: 'a.png', declaredType: 'image/png', byteSize: PNG.length }, T0)
      await expectServiceError(
        receiveUpload(tx, storage, actor, intent.intentId, Readable.from([PNG, PNG]), {}, T0),
        'PAYLOAD_TOO_LARGE',
      )
      expect(await listRawNames(s3!)).toEqual([])
    })
  })

  it('the deep health probe writes, reads and deletes on S3 without leaving anything', async () => {
    await withRollback(async (tx) => {
      const health = await deepHealth({ db: tx, storage, now: new Date(), graceDays: 7, flags: { maintenance: false, publicReadsDisabled: false } })
      expect(health.storage).toMatchObject({ status: 'ok', driver: 's3' })
      expect(await listRawNames(s3!)).toEqual([])
    })
  })
})
