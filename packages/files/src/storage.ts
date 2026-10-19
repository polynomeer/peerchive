/**
 * 비공개 오브젝트 저장소 추상화(ADR 0007).
 *
 * - 키는 서버가 만든 `quarantine/<uuid>`(검사 전 격리) 또는 `clean/<uuid>`(검사 통과)뿐입니다.
 *   원 파일명·사용자 입력으로 키를 만들지 않으며, 형식이 다른 키는 모든 메서드가 거부합니다.
 * - 저장소는 어떤 경우에도 정적으로 공개하지 않습니다. 내용은 권한·검사 상태를 확인한 API만 내려줍니다.
 * - 지금 구현은 파일시스템 driver(fs-storage.ts)뿐이고, 배포 전에 S3 호환(R2) driver를 같은 인터페이스로 추가합니다.
 *   그때 put은 짧은 서명 URL 업로드 + head 확인으로, get은 서명 URL 또는 프록시 스트림으로 바뀔 수 있습니다.
 */
import type { Readable } from 'node:stream'

export type ObjectKey = `quarantine/${string}` | `clean/${string}`

const KEY_PATTERN = /^(quarantine|clean)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 서버가 만든 형식의 키인지. 경로 조작(`..`, `/`, 절대 경로)은 이 검사에서 모두 걸립니다. */
export function isObjectKey(value: unknown): value is ObjectKey {
  return typeof value === 'string' && KEY_PATTERN.test(value)
}

/** 새 격리 키(무작위). 업로드 의도마다 하나씩 만듭니다. */
export function newQuarantineKey(): ObjectKey {
  return `quarantine/${crypto.randomUUID()}`
}

/** 검사를 통과한 버전의 키. 버전 id로 정해지므로 검사 작업을 다시 실행해도 같은 키입니다. */
export function cleanKeyFor(versionId: string): ObjectKey {
  const key = `clean/${versionId.toLowerCase()}`
  if (!isObjectKey(key)) throw new Error('cleanKeyFor: invalid version id')
  return key
}

export interface PutResult {
  bytes: number
  /** 받은 내용의 SHA-256(소문자 hex). */
  sha256: string
}

export interface ByteRange {
  start: number
  /** 포함(inclusive). 생략하면 끝까지. */
  end?: number
}

export interface ObjectStorage {
  /** 'filesystem' 등. 로그·설정 점검용. */
  readonly driver: string
  /**
   * 스트림을 키에 씁니다. maxBytes를 넘으면 중단하고 쓰던 내용을 지운 뒤 ObjectTooLargeError를 던집니다.
   * 같은 키가 이미 있으면 덮어쓰지 않고 오류입니다(키는 일회성).
   */
  put(key: ObjectKey, body: Readable | AsyncIterable<Uint8Array>, options: { maxBytes: number }): Promise<PutResult>
  /** 내용 스트림. 없으면 ObjectNotFoundError. */
  get(key: ObjectKey, range?: ByteRange): Promise<Readable>
  /** 크기. 없으면 null. */
  head(key: ObjectKey): Promise<{ bytes: number } | null>
  copy(from: ObjectKey, to: ObjectKey): Promise<void>
  /** 옮기기. 대상이 이미 있으면 원본만 지웁니다(재실행해도 같은 결과). */
  move(from: ObjectKey, to: ObjectKey): Promise<void>
  /** 지우기. 없어도 오류가 아닙니다. */
  delete(key: ObjectKey): Promise<void>
}

export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`object exceeds ${maxBytes} bytes`)
    this.name = 'ObjectTooLargeError'
  }
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super('object not found')
    this.name = 'ObjectNotFoundError'
  }
}

export class InvalidObjectKeyError extends Error {
  constructor() {
    super('invalid object key')
    this.name = 'InvalidObjectKeyError'
  }
}

export function assertObjectKey(key: unknown): asserts key is ObjectKey {
  if (!isObjectKey(key)) throw new InvalidObjectKeyError()
}

/** 스트림을 끝까지 읽어 Buffer로. 검사 작업은 파일당 최대 20MB라 메모리에 올립니다. */
export async function readAll(stream: AsyncIterable<Uint8Array>, maxBytes = Number.POSITIVE_INFINITY): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > maxBytes) throw new ObjectTooLargeError(maxBytes)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}
