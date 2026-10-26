/**
 * S3 호환 저장소(로컬 MinIO) 테스트 도우미. 환경 변수가 없으면 S3 테스트는 건너뜁니다.
 *
 * | 변수 | 예(로컬 전용) |
 * |---|---|
 * | PEERCHIVE_TEST_S3_ENDPOINT | http://127.0.0.1:9000 |
 * | PEERCHIVE_TEST_S3_ACCESS_KEY_ID / PEERCHIVE_TEST_S3_SECRET_ACCESS_KEY | .env.example의 MinIO 로컬 값 |
 * | PEERCHIVE_TEST_S3_BUCKET | peerchive-test(없으면 만듦) |
 *
 * 실수로 실제 버킷을 건드리지 않도록 endpoint는 루프백 주소만 받습니다. 테스트마다 무작위 prefix를 써서 서로 섞이지 않고,
 * 끝나면 그 prefix 아래를 모두 지웁니다.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import type { S3StorageConfig } from '../src'

const endpoint = process.env.PEERCHIVE_TEST_S3_ENDPOINT?.trim()

export const s3TestEnabled = !!endpoint

function loopbackOnly(url: string): string {
  const host = new URL(url).hostname
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    throw new Error('PEERCHIVE_TEST_S3_ENDPOINT must be a loopback address (local MinIO only)')
  }
  return url
}

/** 테스트 하나에 쓸 설정(무작위 prefix). */
export function s3TestConfig(overrides: Partial<S3StorageConfig> = {}): S3StorageConfig {
  if (!endpoint) throw new Error('PEERCHIVE_TEST_S3_ENDPOINT is not set')
  return {
    endpoint: loopbackOnly(endpoint),
    region: 'us-east-1',
    bucket: process.env.PEERCHIVE_TEST_S3_BUCKET?.trim() || 'peerchive-test',
    accessKeyId: process.env.PEERCHIVE_TEST_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.PEERCHIVE_TEST_S3_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: true,
    prefix: `test-${crypto.randomUUID()}/`,
    ...overrides,
  }
}

/** resolveObjectStorage에 넘길 환경 변수 모양(web·worker가 읽는 것과 같은 이름). */
export function s3TestEnv(config: S3StorageConfig): Record<string, string> {
  return {
    PEERCHIVE_STORAGE_DRIVER: 's3',
    PEERCHIVE_S3_ENDPOINT: config.endpoint ?? '',
    PEERCHIVE_S3_REGION: config.region,
    PEERCHIVE_S3_BUCKET: config.bucket,
    PEERCHIVE_S3_ACCESS_KEY_ID: config.accessKeyId,
    PEERCHIVE_S3_SECRET_ACCESS_KEY: config.secretAccessKey,
    PEERCHIVE_S3_FORCE_PATH_STYLE: config.forcePathStyle ? '1' : '0',
    PEERCHIVE_S3_PREFIX: config.prefix,
  }
}

function adminClient(config: S3StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  })
}

/** 테스트 버킷이 없으면 만듭니다(로컬 MinIO 전용). */
export async function ensureTestBucket(config: S3StorageConfig): Promise<void> {
  const client = adminClient(config)
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }))
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.bucket })).catch((error: unknown) => {
      if ((error as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw error
    })
  } finally {
    client.destroy()
  }
}

/** prefix 아래의 실제 객체 이름 전부(서버 형식이 아닌 것 포함). */
export async function listRawNames(config: S3StorageConfig): Promise<string[]> {
  const client = adminClient(config)
  const names: string[] = []
  try {
    let token: string | undefined
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix, ContinuationToken: token }))
      for (const item of page.Contents ?? []) if (item.Key) names.push(item.Key.slice(config.prefix.length))
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
  } finally {
    client.destroy()
  }
  return names.sort()
}

/** 서버 형식이 아닌 객체를 직접 넣습니다(list가 건너뛰는지 확인용). */
export async function putRawObject(config: S3StorageConfig, name: string, body: string): Promise<void> {
  const client = adminClient(config)
  try {
    await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}${name}`, Body: body }))
  } finally {
    client.destroy()
  }
}

/** prefix 아래를 모두 지웁니다. */
export async function removeTestPrefix(config: S3StorageConfig): Promise<void> {
  const names = await listRawNames(config)
  const client = adminClient(config)
  try {
    for (const name of names) await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: `${config.prefix}${name}` }))
  } finally {
    client.destroy()
  }
}
