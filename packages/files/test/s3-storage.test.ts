/**
 * S3 호환 driver(ADR 0017). 설정 검사는 항상 실행하고, 실제 저장소 테스트는 로컬 MinIO(PEERCHIVE_TEST_S3_*)가 있을 때만 실행합니다.
 * MinIO: `docker compose -f ops/docker-compose.yml --profile minio up -d --wait minio`(apps/README.md).
 */
import { Readable } from 'node:stream'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type ObjectStorage,
  type S3StorageConfig,
  S3_MAX_BUFFERED_PUT_BYTES,
  cleanKeyFor,
  createS3Storage,
  newQuarantineKey,
  parseS3StorageConfig,
  readAll,
  resolveObjectStorage,
} from '../src'
import { describeStorageContract } from './storage-contract'
import { ensureTestBucket, listRawNames, putRawObject, removeTestPrefix, s3TestConfig, s3TestEnabled, s3TestEnv } from './s3-testing'

const valid = {
  PEERCHIVE_STORAGE_DRIVER: 's3',
  PEERCHIVE_S3_ENDPOINT: 'https://objects.example.test',
  PEERCHIVE_S3_REGION: 'auto',
  PEERCHIVE_S3_BUCKET: 'peerchive-prod',
  PEERCHIVE_S3_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  PEERCHIVE_S3_SECRET_ACCESS_KEY: 'super-secret-value',
}

describe('s3 storage configuration', () => {
  it('parses a full configuration and normalizes endpoint and prefix', () => {
    expect(parseS3StorageConfig({ ...valid, PEERCHIVE_S3_PREFIX: '/peerchive/prod', PEERCHIVE_S3_FORCE_PATH_STYLE: '1' }, { production: true })).toEqual({
      endpoint: 'https://objects.example.test',
      region: 'auto',
      bucket: 'peerchive-prod',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'super-secret-value',
      forcePathStyle: true,
      prefix: 'peerchive/prod/',
    })
    // endpoint를 비우면 AWS 기본 endpoint(region 기준).
    const aws = parseS3StorageConfig({ ...valid, PEERCHIVE_S3_ENDPOINT: '', PEERCHIVE_S3_REGION: 'ap-northeast-2' }, { production: true })
    expect(aws.endpoint).toBeUndefined()
    expect(aws).toMatchObject({ prefix: '', forcePathStyle: false })
    expect(resolveObjectStorage(valid, { production: true }).driver).toBe('s3')
  })

  it('names missing variables without echoing any secret value', () => {
    const run = (env: Record<string, string>) => {
      try {
        parseS3StorageConfig(env, { production: true })
      } catch (error) {
        return (error as Error).message
      }
      return 'ok'
    }
    expect(run({ PEERCHIVE_STORAGE_DRIVER: 's3' })).toMatch(
      /PEERCHIVE_S3_REGION, PEERCHIVE_S3_BUCKET, PEERCHIVE_S3_ACCESS_KEY_ID, PEERCHIVE_S3_SECRET_ACCESS_KEY/,
    )
    expect(run({ ...valid, PEERCHIVE_S3_SECRET_ACCESS_KEY: ' ' })).toMatch(/PEERCHIVE_S3_SECRET_ACCESS_KEY/)
    for (const env of [
      { ...valid, PEERCHIVE_S3_ENDPOINT: 'https://user:super-secret-value@objects.example.test' },
      { ...valid, PEERCHIVE_S3_BUCKET: 'Bad_Bucket' },
    ]) {
      const message = run(env)
      expect(message).not.toBe('ok')
      expect(message).not.toContain('super-secret-value')
      expect(message).not.toContain('AKIDEXAMPLE')
    }
  })

  it('refuses plain http endpoints in production and malformed values everywhere', () => {
    const http = { ...valid, PEERCHIVE_S3_ENDPOINT: 'http://127.0.0.1:9000' }
    expect(() => parseS3StorageConfig(http, { production: true })).toThrow(/https in production/)
    expect(() => resolveObjectStorage(http, { production: true })).toThrow(/https in production/)
    expect(parseS3StorageConfig(http, { production: false }).endpoint).toBe('http://127.0.0.1:9000')
    for (const [name, value] of [
      ['PEERCHIVE_S3_ENDPOINT', 'ftp://objects.example.test'],
      ['PEERCHIVE_S3_ENDPOINT', 'https://objects.example.test/bucket'],
      ['PEERCHIVE_S3_ENDPOINT', 'https://objects.example.test/?x=1'],
      ['PEERCHIVE_S3_ENDPOINT', 'not a url'],
      ['PEERCHIVE_S3_BUCKET', 'ab'],
      ['PEERCHIVE_S3_BUCKET', 'a..b'],
      ['PEERCHIVE_S3_REGION', 'Seoul Region'],
      ['PEERCHIVE_S3_PREFIX', '../escape/'],
      ['PEERCHIVE_S3_PREFIX', 'Upper/'],
      ['PEERCHIVE_S3_PREFIX', 'a//b/'],
      ['PEERCHIVE_S3_FORCE_PATH_STYLE', 'yes'],
    ] as const) {
      expect(() => parseS3StorageConfig({ ...valid, [name]: value }, { production: false }), `${name}=${value}`).toThrow()
    }
  })

  it('refuses keys outside the server format before any network call', async () => {
    // 접속할 수 없는 endpoint라도 키 검사에서 먼저 거부합니다.
    const storage = createS3Storage({ ...parseS3StorageConfig({ ...valid, PEERCHIVE_S3_ENDPOINT: 'http://127.0.0.1:9' }, { production: false }) })
    await expect(storage.head('clean/../../x' as never)).rejects.toThrow(/invalid object key/)
    await expect(storage.put(newQuarantineKey(), Readable.from([]), { maxBytes: S3_MAX_BUFFERED_PUT_BYTES + 1 })).rejects.toThrow(
      /buffered put limit/,
    )
    storage.destroy()
  })
})

let bucketReady: Promise<void> | undefined
function harnessConfig(): S3StorageConfig {
  return s3TestConfig({ listPageSize: 2 })
}

describeStorageContract(
  's3 (MinIO)',
  async () => {
    const config = harnessConfig()
    bucketReady ??= ensureTestBucket(config)
    await bucketReady
    const storage = createS3Storage(config)
    return {
      storage,
      cleanup: async () => {
        storage.destroy()
        await removeTestPrefix(config)
      },
    }
  },
  { skip: !s3TestEnabled },
)

describe.skipIf(!s3TestEnabled)('s3 storage (MinIO) specifics', () => {
  let config: S3StorageConfig
  let storage: ObjectStorage & { destroy(): void }
  beforeAll(async () => {
    await ensureTestBucket(s3TestConfig())
  })
  afterEach(async () => {
    storage?.destroy()
    if (config) await removeTestPrefix(config)
  })

  it('stores objects under the configured prefix with the bare key and nothing else', async () => {
    config = s3TestConfig()
    storage = createS3Storage(config)
    const q = newQuarantineKey()
    const c = cleanKeyFor(crypto.randomUUID())
    await storage.put(q, Readable.from([Buffer.from('q')]), { maxBytes: 10 })
    await storage.put(c, Readable.from([Buffer.from('c')]), { maxBytes: 10 })
    expect(await listRawNames(config)).toEqual([c, q].sort())
    // 다른 prefix의 driver는 이 객체를 보지 못합니다.
    const neighbour = createS3Storage(s3TestConfig({ prefix: `test-${crypto.randomUUID()}/` }))
    expect(await neighbour.head(q)).toBeNull()
    const seen: string[] = []
    for await (const item of neighbour.list('quarantine')) seen.push(item.key)
    expect(seen).toEqual([])
    neighbour.destroy()
  })

  it('list skips objects that are not server-format keys and pages through many keys', async () => {
    config = s3TestConfig({ listPageSize: 3 })
    storage = createS3Storage(config)
    const keys = Array.from({ length: 8 }, () => newQuarantineKey())
    for (const key of keys) await storage.put(key, Readable.from([Buffer.from('x')]), { maxBytes: 1 })
    await putRawObject(config, 'quarantine/notes.txt', 'foreign')
    await putRawObject(config, `quarantine/${keys[0]!.slice(11)}/nested`, 'foreign')
    const seen: string[] = []
    for await (const item of storage.list('quarantine')) seen.push(item.key)
    expect(seen.sort()).toEqual([...keys].sort())
  })

  it('resolveObjectStorage builds the same driver from the shared web/worker environment', async () => {
    config = s3TestConfig()
    const resolved = resolveObjectStorage(s3TestEnv(config), { production: false }) as ObjectStorage & { destroy(): void }
    storage = resolved
    expect(resolved.driver).toBe('s3')
    const key = newQuarantineKey()
    await resolved.put(key, Readable.from([Buffer.from('shared')]), { maxBytes: 10 })
    expect((await readAll(await resolved.get(key))).toString()).toBe('shared')
  })
})
