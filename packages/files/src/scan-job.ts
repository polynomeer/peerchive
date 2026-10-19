/**
 * 파일 검사 작업(ADR 0007). worker가 pg-boss 작업으로 실행하고, 테스트는 직접 부릅니다.
 *
 * 흐름: pending → scanning → clean | quarantined | failed
 * 1. 버전 행을 잠그고 scanning으로 바꿉니다(시도 횟수 +1). clean·quarantined면 아무것도 하지 않습니다(중복 실행 안전).
 * 2. 격리 키의 내용을 읽어 크기·SHA-256을 확인하고, signature 판별 → 선언 형식·확장자 대조 → 내장 콘텐츠 점검 →
 *    악성코드 검사 순서로 판정합니다.
 * 3. 통과하면 내용을 `clean/<versionId>`로 옮긴 뒤 DB를 clean으로 바꿉니다. 옮긴 뒤 DB 갱신 전에 죽어도
 *    다시 실행하면 clean 키에서 읽어 같은 결과로 끝납니다. 격리된 내용은 격리 키에 그대로 두고 내려주지 않습니다.
 * 4. 검사 자체의 오류는 마지막 시도가 아니면 scanning으로 둔 채 예외를 던져 큐의 재시도(backoff)에 맡기고,
 *    마지막 시도면 failed로 바꾼 뒤 던져 dead-letter로 보냅니다.
 */
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { decideFileType, nextScanStatus, type QuarantineReason, type ScanStatus } from '@peerchive/domain'
import { and, artifactVersions, eq, outboxEvents, type DbExecutor } from '@peerchive/db'
import type { MalwareScanner } from './scanner'
import { inspectContent, sniff, SNIFF_BYTES } from './sniff'
import {
  type ObjectKey,
  type ObjectStorage,
  ObjectNotFoundError,
  cleanKeyFor,
  isObjectKey,
  readAll,
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
export type ScanFailureReason = 'scan_error' | 'object_missing' | 'integrity_mismatch'

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

    const cleanKey = cleanKeyFor(version.id)
    if (key !== cleanKey) await deps.storage.move(key, cleanKey)
    await finish({
      scanStatus: nextScanStatus('scanning', 'pass')!,
      objectKey: cleanKey,
      mediaType: verdict.mediaType,
      scanEngine: deps.scanner.engine,
      scannedAt: now(),
    })
    return { status: 'clean' }
  } catch (error) {
    const reason: ScanFailureReason = error instanceof ScanFailure ? error.reason : 'scan_error'
    // 내용이 없거나 해시가 다르면 다시 해도 같으므로 바로 실패로 둡니다.
    if (options.finalAttempt || reason !== 'scan_error') {
      await finish({ scanStatus: nextScanStatus('scanning', 'error')!, scanReason: reason, scanEngine: deps.scanner.engine })
      if (reason !== 'scan_error') return { status: 'failed', reason }
    }
    throw error
  }
}
