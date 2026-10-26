/**
 * S3 호환 오브젝트 저장소 driver(AWS S3·Cloudflare R2·MinIO 등, ADR 0017).
 *
 * - 공급자를 정하지 않습니다. 표준 S3 API(PutObject·GetObject·HeadObject·CopyObject·DeleteObject·ListObjectsV2)만 씁니다.
 * - 키 규칙은 파일시스템 driver와 같습니다(`quarantine/<uuid>`·`clean/<uuid>`만, 다른 키는 모든 메서드가 거부).
 *   버킷 안의 실제 이름은 `<prefix><key>`이며 prefix는 설정으로만 정합니다(사용자 입력 아님).
 * - 버킷은 비공개여야 합니다. 이 driver는 공개 URL·서명 URL을 만들지 않고, 내용은 언제나 권한·검사 상태를 확인한
 *   서버 경로가 스트림으로 내려줍니다(서명 URL은 나중의 최적화, ADR 0017).
 * - put은 본문을 최대 maxBytes(검사 한도 20MB)까지 메모리에 모으며 SHA-256을 계산하고, 다 받은 뒤 한 번의 PutObject로 씁니다.
 *   한도를 넘으면 그 자리에서 읽기를 멈추고 아무것도 올리지 않으므로 지울 조각이 생기지 않습니다(multipart 미사용).
 *   같은 키 덮어쓰기는 `If-None-Match: *` 조건부 쓰기로 막고, 조건을 무시하는 구현에 대비해 쓰기 전에 head도 확인합니다.
 * - move는 copy 뒤 delete입니다(원자적이지 않음). copy 자체는 대상 키를 통째로 바꾸므로 읽는 쪽은 이전 내용 또는 새 내용만 봅니다.
 *   copy 뒤 delete 전에 죽으면 원본(격리 키)이 남지만, 격리 키는 내려주지 않고 주인 없는 격리 파일 정리 작업이 지웁니다.
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import {
  type ByteRange,
  type ObjectKey,
  type ObjectStorage,
  type PutResult,
  ObjectNotFoundError,
  ObjectTooLargeError,
  assertObjectKey,
  isObjectKey,
} from './storage'

/** 한 번에 메모리에 모을 수 있는 최대 크기. 업로드 한도(20MB)보다 크게, 그러나 무한하지 않게 둡니다. */
export const S3_MAX_BUFFERED_PUT_BYTES = 32 * 1024 * 1024

export interface S3StorageConfig {
  /** 생략하면 AWS 기본 endpoint(region 기준). R2·MinIO는 반드시 지정합니다. */
  endpoint?: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** MinIO 등 가상 호스트 방식을 쓰지 않는 서비스. */
  forcePathStyle: boolean
  /** 버킷 안의 접두어(비우거나 `/`로 끝남). 한 버킷을 여러 환경이 나눠 쓸 때. */
  prefix: string
  /** ListObjectsV2 한 페이지의 키 수(기본 1000). 테스트에서 페이지 넘김을 확인할 때 줄입니다. */
  listPageSize?: number
}

export class ObjectAlreadyExistsError extends Error {
  constructor() {
    super('object already exists')
    this.name = 'ObjectAlreadyExistsError'
  }
}

/** SDK 오류의 HTTP 상태(없으면 undefined). */
function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
}
const nameOf = (error: unknown) => (error as { name?: string } | null)?.name
const isNotFound = (error: unknown) =>
  statusOf(error) === 404 || nameOf(error) === 'NoSuchKey' || nameOf(error) === 'NotFound'

export function createS3Storage(config: S3StorageConfig): ObjectStorage & { destroy(): void } {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint && { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // 연결 5초, 소켓 유휴 30초. 재시도는 SDK 기본 방식으로 3회까지.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    maxAttempts: 3,
    // 일부 S3 호환 서비스가 새 기본 체크섬 헤더(CRC32 등)를 거부하므로 필요한 요청에만 붙입니다.
    // 내용 무결성은 우리가 계산한 SHA-256(DB 기록)과 검사 작업의 재확인으로 봅니다.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  const bucket = config.bucket
  const pageSize = config.listPageSize ?? 1000

  /** 키 → 버킷 안의 이름. 형식이 다르면 예외. */
  function nameFor(key: ObjectKey): string {
    assertObjectKey(key)
    return `${config.prefix}${key}`
  }

  async function exists(name: string): Promise<{ bytes: number } | null> {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: name }))
      return { bytes: head.ContentLength ?? 0 }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  return {
    driver: 's3',

    destroy() {
      client.destroy()
    },

    async put(key, body, { maxBytes }): Promise<PutResult> {
      const name = nameFor(key)
      if (maxBytes > S3_MAX_BUFFERED_PUT_BYTES) throw new Error('s3 storage: maxBytes exceeds the buffered put limit')
      const hash = createHash('sha256')
      const chunks: Buffer[] = []
      let bytes = 0
      // 한도를 넘으면 for-await를 빠져나가며 원본 스트림을 닫습니다(아무것도 올리지 않음).
      for await (const chunk of body) {
        bytes += chunk.byteLength
        if (bytes > maxBytes) throw new ObjectTooLargeError(maxBytes)
        const buffer = Buffer.from(chunk)
        hash.update(buffer)
        chunks.push(buffer)
      }
      if (await exists(name)) throw new ObjectAlreadyExistsError()
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: name,
            Body: Buffer.concat(chunks, bytes),
            ContentLength: bytes,
            ContentType: 'application/octet-stream',
            // 같은 키가 이미 있으면 412로 실패합니다(키는 일회성).
            IfNoneMatch: '*',
          }),
        )
      } catch (error) {
        if (statusOf(error) === 412 || statusOf(error) === 409) throw new ObjectAlreadyExistsError()
        throw error
      }
      return { bytes, sha256: hash.digest('hex') }
    },

    async get(key, range?: ByteRange): Promise<Readable> {
      const name = nameFor(key)
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: name,
            ...(range && { Range: `bytes=${range.start}-${range.end ?? ''}` }),
          }),
        )
        const stream = response.Body
        if (!(stream instanceof Readable)) throw new Error('s3 storage: unexpected response body')
        return stream
      } catch (error) {
        if (isNotFound(error)) throw new ObjectNotFoundError()
        // 범위가 내용 밖이면(빈 파일 등) 파일시스템 driver처럼 빈 스트림.
        if (statusOf(error) === 416) return Readable.from([])
        throw error
      }
    },

    async head(key) {
      return exists(nameFor(key))
    },

    async copy(from, to) {
      const source = nameFor(from)
      const target = nameFor(to)
      try {
        // 키·prefix 문자는 [a-z0-9._/-]뿐이라(설정 검사) URL 인코딩할 것이 없습니다.
        await client.send(new CopyObjectCommand({ Bucket: bucket, Key: target, CopySource: `${bucket}/${source}` }))
      } catch (error) {
        if (isNotFound(error)) throw new ObjectNotFoundError()
        throw error
      }
    },

    async move(from, to) {
      const source = nameFor(from)
      const target = nameFor(to)
      try {
        await client.send(new CopyObjectCommand({ Bucket: bucket, Key: target, CopySource: `${bucket}/${source}` }))
      } catch (error) {
        if (!isNotFound(error)) throw error
        // 원본이 없으면 이미 옮겨진 경우(재실행)인지 확인합니다.
        if (!(await exists(target))) throw new ObjectNotFoundError()
        return
      }
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: source }))
    },

    async delete(key) {
      // S3 DeleteObject는 없는 키에도 성공(204)합니다.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: nameFor(key) }))
    },

    async *list(prefix) {
      const base = `${config.prefix}${prefix}/`
      let token: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: base, MaxKeys: pageSize, ContinuationToken: token }),
        )
        for (const item of page.Contents ?? []) {
          if (!item.Key) continue
          const key = item.Key.slice(config.prefix.length)
          // 서버 형식이 아닌 키(사람이 올린 파일 등)는 건너뜁니다.
          if (!isObjectKey(key)) continue
          yield { key, modifiedAt: item.LastModified ?? new Date(0) }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
    },
  }
}
