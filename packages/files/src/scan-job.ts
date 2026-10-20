/**
 * 파일 검사 작업(ADR 0007). worker가 pg-boss 작업으로 실행하고, 테스트는 직접 부릅니다.
 *
 * 흐름: pending → scanning → clean | quarantined | failed
 * 1. 버전 행을 잠그고 scanning으로 바꿉니다(시도 횟수 +1). clean·quarantined면 아무것도 하지 않습니다(중복 실행 안전).
 * 2. 격리 키의 내용을 읽어 크기·SHA-256을 확인하고, signature 판별 → 선언 형식·확장자 대조 → 내장 콘텐츠 점검 →
 *    악성코드 검사 순서로 판정합니다.
 * 3. 통과하면 메타데이터를 처리합니다(strip-metadata.ts). 이미지는 EXIF/GPS/XMP/주석을 지운 바이트, PDF는 원래 바이트를
 *    `clean/<versionId>`에 쓰고(writeObject: 임시 키 → move) DB를 clean으로 바꾼 뒤 격리 원본을 지웁니다.
 *    - 원래 sha256·bytes는 그대로 둡니다(같은 내용 중복 판단·저장 한도). 내려주는 내용의 값은 stripped_sha256·stripped_bytes.
 *    - clean 키에 쓴 뒤 DB 갱신 전에 죽으면 격리 원본이 남아 있으므로 다시 실행하면 원본에서 같은 결과를 다시 씁니다(결정적).
 *      DB 갱신 뒤 격리 원본을 지우기 전에 죽으면 원본이 격리 키에 남습니다(내려주지 않음, 오래된 격리 파일 정리 작업 대상).
 *    - 이미지 구조가 깨져 메타데이터를 지울 수 없으면 `failed`(`metadata_strip_failed`)로 두고 아무것도 내려주지 않습니다.
 *    격리된 내용은 격리 키에 그대로 두고 내려주지 않습니다.
 * 4. 검사 자체의 오류는 마지막 시도가 아니면 scanning으로 둔 채 예외를 던져 큐의 재시도(backoff)에 맡기고,
 *    마지막 시도면 failed로 바꾼 뒤 던져 dead-letter로 보냅니다.
 */
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { decideFileType, nextScanStatus, type QuarantineReason, type ScanStatus } from '@peerchive/domain'
import { and, artifactVersions, eq, outboxEvents, type DbExecutor } from '@peerchive/db'
import type { MalwareScanner } from './scanner'
import { inspectContent, sniff, SNIFF_BYTES } from './sniff'
import { MetadataStripError, type MetadataProcessing, processMetadata } from './strip-metadata'
import {
  type ObjectKey,
  type ObjectStorage,
  ObjectNotFoundError,
  cleanKeyFor,
  isObjectKey,
  readAll,
  writeObject,
} from './storage'

/** pg-boss 큐 이름. outbox_events.topic에도 같은 값을 씁니다. */
export const ARTIFACT_SCAN_QUEUE = 'artifact-scan'

export interface ScanJobData {
  versionId: string
}

/** 검사 작업을 outbox에 남깁니다. 호출자의 트랜잭션 안에서 부르세요. */
export async function enqueueArtifactScan(db: DbExecutor, versionId: string): Promise<void> {
  await db.insert(outboxEvents).values({ topic: ARTIFACT_SCAN_QUEUE, payload: { versionId } satisfies ScanJobData })
}

export interface ScanDeps {
  storage: ObjectStorage
  scanner: MalwareScanner
  now?: () => Date
}

export type ScanOutcome =
  | { status: 'clean' }
  | { status: 'quarantined'; reason: QuarantineReason; signature?: string }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; current: ScanStatus | 'missing' }

/** 검사 자체가 실패한 사유(격리 사유와 구분). */
export type ScanFailureReason = 'scan_error' | 'object_missing' | 'integrity_mismatch' | 'metadata_strip_failed'

class ScanFailure extends Error {
  constructor(readonly reason: ScanFailureReason, cause?: unknown) {
    super(`scan failed: ${reason}`, { cause })
  }
}

type Verdict = { pass: true; mediaType: string } | { pass: false; reason: QuarantineReason; signature?: string }

async function judge(
  content: Buffer,
  version: { declaredType: string; fileName: string },
  scanner: MalwareScanner,
): Promise<Verdict> {
  const detected = sniff(content.subarray(0, SNIFF_BYTES))
  const decision = decideFileType(version.declaredType, version.fileName, detected)
  if (!decision.ok) return { pass: false, reason: decision.reason }
  const embedded = inspectContent(content, decision.mediaType)
  if (embedded) return { pass: false, reason: embedded }
  let verdict
  try {
    verdict = await scanner.scan(Readable.from([content]))
  } catch (error) {
    throw new ScanFailure('scan_error', error)
  }
  if (verdict.infected) return { pass: false, reason: 'malware', signature: verdict.signature }
  return { pass: true, mediaType: decision.mediaType }
}

/** 격리 키(또는 이미 옮긴 clean 키)의 내용을 읽습니다. */
async function readContent(storage: ObjectStorage, objectKey: string, versionId: string, maxBytes: number) {
  const cleanKey = cleanKeyFor(versionId)
  const keys: ObjectKey[] = isObjectKey(objectKey) ? [objectKey, cleanKey] : [cleanKey]
  for (const key of keys) {
    try {
      return { key, content: await readAll(await storage.get(key), maxBytes) }
    } catch (error) {
      if (!(error instanceof ObjectNotFoundError)) throw new ScanFailure('scan_error', error)
    }
  }
  throw new ScanFailure('object_missing')
}

export async function scanArtifactVersion(
  db: DbExecutor,
  deps: ScanDeps,
  versionId: string,
  options: { finalAttempt?: boolean } = {},
): Promise<ScanOutcome> {
  const now = deps.now ?? (() => new Date())

  // 1. scanning으로 표시(짧은 트랜잭션). 검사 자체는 트랜잭션 밖에서 합니다.
  const claimed = await db.transaction(async (tx) => {
    const [version] = await tx.select().from(artifactVersions).where(eq(artifactVersions.id, versionId)).for('update')
    if (!version) return { skipped: 'missing' as const, version: null }
    const next = nextScanStatus(version.scanStatus, 'start')
    if (!next) return { skipped: version.scanStatus, version: null }
    await tx
      .update(artifactVersions)
      .set({ scanStatus: next, scanAttempts: version.scanAttempts + 1, scanReason: null })
      .where(eq(artifactVersions.id, versionId))
    return { skipped: null, version }
  })
  if (!claimed.version) return { status: 'skipped', current: claimed.skipped ?? 'missing' }
  const { version } = claimed

  /** scanning인 행만 결과로 바꿉니다(다른 실행이 먼저 끝냈으면 그대로 둠). */
  const finish = (values: Partial<typeof artifactVersions.$inferInsert>) =>
    db
      .update(artifactVersions)
      .set(values)
      .where(and(eq(artifactVersions.id, versionId), eq(artifactVersions.scanStatus, 'scanning')))

  try {
    const { key, content } = await readContent(deps.storage, version.objectKey, version.id, version.bytes)
    if (content.length !== version.bytes || createHash('sha256').update(content).digest('hex') !== version.sha256) {
      throw new ScanFailure('integrity_mismatch')
    }
    const verdict = await judge(content, version, deps.scanner)

    if (!verdict.pass) {
      await finish({
        scanStatus: nextScanStatus('scanning', 'reject')!,
        scanReason: verdict.reason,
        scanEngine: deps.scanner.engine,
        scannedAt: now(),
      })
      return { status: 'quarantined', reason: verdict.reason, ...(verdict.signature && { signature: verdict.signature }) }
    }

    // 메타데이터 제거(이미지)·문서 속성 점검(PDF). 지울 수 없는 이미지는 원본을 내주지 않도록 failed로 둡니다.
    let processed: MetadataProcessing
    try {
      processed = processMetadata(content, verdict.mediaType)
    } catch (error) {
      if (!(error instanceof MetadataStripError)) throw error
      throw new ScanFailure('metadata_strip_failed', error)
    }

    const cleanKey = cleanKeyFor(version.id)
    const served = await writeObject(deps.storage, cleanKey, processed.content)
    await finish({
      scanStatus: nextScanStatus('scanning', 'pass')!,
      objectKey: cleanKey,
      mediaType: verdict.mediaType,
      scanEngine: deps.scanner.engine,
      scannedAt: now(),
      metadataStripped: processed.stripped,
      strippedSha256: served.sha256,
      strippedBytes: served.bytes,
      metadataFindings: processed.findings as unknown as Record<string, unknown>,
    })
    // 원본(메타데이터 포함)은 DB가 clean으로 바뀐 뒤에 지웁니다. 지우지 못해도 내려주지 않으며 정리 작업 대상입니다.
    if (key !== cleanKey) await deps.storage.delete(key).catch(() => {})
    return { status: 'clean' }
  } catch (error) {
    const reason: ScanFailureReason = error instanceof ScanFailure ? error.reason : 'scan_error'
    // 내용이 없거나 해시가 다르거나 메타데이터를 지울 수 없으면 다시 해도 같으므로 바로 실패로 둡니다.
    if (options.finalAttempt || reason !== 'scan_error') {
      await finish({ scanStatus: nextScanStatus('scanning', 'error')!, scanReason: reason, scanEngine: deps.scanner.engine })
      if (reason !== 'scan_error') return { status: 'failed', reason }
    }
    throw error
  }
}
