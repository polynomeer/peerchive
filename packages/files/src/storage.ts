/**
 * 비공개 오브젝트 저장소 추상화(ADR 0007).
 *
 * - 키는 서버가 만든 `quarantine/<uuid>`(검사 전 격리) 또는 `clean/<uuid>`(검사 통과)뿐입니다.
 *   원 파일명·사용자 입력으로 키를 만들지 않으며, 형식이 다른 키는 모든 메서드가 거부합니다.
 * - 저장소는 어떤 경우에도 정적으로 공개하지 않습니다. 내용은 권한·검사 상태를 확인한 API만 내려줍니다.
 * - 구현은 파일시스템 driver(fs-storage.ts, 로컬·단일 서버 pilot)와 S3 호환 driver(s3-storage.ts, ADR 0017)입니다.
 *   두 driver 모두 내용을 서버가 스트림으로 받고 내려줍니다. 서명 URL 직접 업로드·내려받기는 나중의 최적화입니다.
 */
import { Readable } from 'node:stream'

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
  /** 'filesystem' 또는 's3'. 로그·설정 점검용. */
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
  /**
   * 옮기기. 대상이 이미 있으면 원자적으로 덮어씁니다(읽는 쪽은 이전 내용 또는 새 내용 중 하나만 봄). 원본이 없고 대상이
   * 있으면 이미 옮긴 것으로 보고 성공합니다(재실행해도 같은 결과). 메타데이터를 지운 내용으로 clean 키를 바꿀 때 씁니다(writeObject).
   * s3 driver는 copy 뒤 delete라 잠시 원본과 대상이 함께 있을 수 있습니다(대상 교체 자체는 원자적, 남은 원본은 격리 키라
   * 내려주지 않고 정리 작업이 지움).
   */
  move(from: ObjectKey, to: ObjectKey): Promise<void>
  /** 지우기. 없어도 오류가 아닙니다. */
  delete(key: ObjectKey): Promise<void>
  /**
   * 접두어(quarantine/clean) 아래의 키와 마지막 수정 시각(T-16 주기 정리: 주인 없는 격리 파일 찾기). 서버 형식의 키만 돌려주고
   * 쓰는 중인 임시 파일은 건너뜁니다. 순서는 정하지 않습니다.
   */
  list(prefix: 'quarantine' | 'clean'): AsyncIterable<{ key: ObjectKey; modifiedAt: Date }>
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

/**
 * 메모리의 내용을 키에 씁니다. 새 격리 키에 먼저 쓴 뒤 move로 옮기므로, 같은 키에 이미 내용이 있어도(검사 재실행·backfill)
 * 중간 상태(없음·일부만 씀)가 보이지 않습니다. 실패하면 임시 키를 지웁니다. 돌려주는 크기·SHA-256은 쓴 내용의 값입니다.
 */
export async function writeObject(storage: ObjectStorage, key: ObjectKey, content: Buffer): Promise<PutResult> {
  const staging = newQuarantineKey()
  try {
    const result = await storage.put(staging, Readable.from([content]), { maxBytes: content.length })
    await storage.move(staging, key)
    return result
  } catch (error) {
    await storage.delete(staging).catch(() => {})
    throw error
  }
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
