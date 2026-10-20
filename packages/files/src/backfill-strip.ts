/**
 * 메타데이터 제거 backfill(ADR 0007 "메타데이터 제거"). 이 기능이 생기기 전에 clean이 된 버전을 한 번 처리합니다.
 *
 * - 대상: clean인 이미지 중 `metadata_stripped = false`, clean인 PDF 중 `metadata_findings`가 없는 것.
 * - 이미지: clean 키에서 읽어 메타데이터를 지우고 같은 키를 writeObject(임시 키 → move, 원자적 교체)로 바꾼 뒤 DB에 표시합니다.
 *   PDF: 내용은 그대로 두고 문서 속성 점검 결과와 내려주는 내용의 해시·크기만 기록합니다.
 * - 멱등: 이미 처리한 행은 다시 고르지 않고, DB 갱신은 "아직 처리 전인 clean 행"에만 합니다. 내용을 바꾼 뒤 DB 갱신 전에 죽었다면
 *   다음 실행에서 읽은 내용이 이미 지운 결과와 같으므로(제거는 결정적·idempotent) 그대로 기록합니다.
 * - 원래 내용도, 지운 결과도 아닌 내용(해시 불일치)과 구조가 깨진 이미지는 바꾸지 않고 실패로 보고합니다. 그런 버전은 계속
 *   `metadata_stripped = false`라 공개 후보·공개 조회에서 빠집니다.
 * - 실행: `pnpm --filter worker backfill-strip [--dry-run] [--batch=100]`(apps/README.md).
 */
import { createHash } from 'node:crypto'
import { MAX_FILE_BYTES } from '@peerchive/domain'
import { and, artifactVersions, asc, eq, gt, inArray, isNull, or, type DbExecutor } from '@peerchive/db'
import { ObjectNotFoundError, type ObjectStorage, isObjectKey, readAll, writeObject } from './storage'
import { MetadataStripError, processMetadata } from './strip-metadata'

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

export type BackfillOutcome =
  | { versionId: string; status: 'stripped' | 'unchanged' | 'pdf_checked' | 'would_update' }
  | { versionId: string; status: 'failed'; reason: 'object_missing' | 'integrity_mismatch' | 'metadata_strip_failed' | 'invalid_key' }
  | { versionId: string; status: 'skipped' }

export interface BackfillSummary {
  outcomes: BackfillOutcome[]
}

const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex')

/** 처리할 clean 버전(id 순). after 다음부터 batch개. */
function pendingVersions(db: DbExecutor, after: string | null, batch: number) {
  return db
    .select()
    .from(artifactVersions)
    .where(
      and(
        eq(artifactVersions.scanStatus, 'clean'),
        or(
          and(inArray(artifactVersions.mediaType, IMAGE_TYPES), eq(artifactVersions.metadataStripped, false)),
          and(eq(artifactVersions.mediaType, 'application/pdf'), isNull(artifactVersions.metadataFindings)),
        ),
        after ? gt(artifactVersions.id, after) : undefined,
      ),
    )
    .orderBy(asc(artifactVersions.id))
    .limit(batch)
}

type VersionRow = typeof artifactVersions.$inferSelect

/** 버전 하나 처리. */
export async function backfillVersion(
  db: DbExecutor,
  storage: ObjectStorage,
  version: VersionRow,
  options: { dryRun?: boolean } = {},
): Promise<BackfillOutcome> {
  const versionId = version.id
  if (!isObjectKey(version.objectKey) || !version.objectKey.startsWith('clean/') || !version.mediaType) {
    return { versionId, status: 'failed', reason: 'invalid_key' }
  }
  let content: Buffer
  try {
    content = await readAll(await storage.get(version.objectKey), MAX_FILE_BYTES)
  } catch (error) {
    if (error instanceof ObjectNotFoundError) return { versionId, status: 'failed', reason: 'object_missing' }
    throw error
  }
  let processed
  try {
    processed = processMetadata(content, version.mediaType)
  } catch (error) {
    if (error instanceof MetadataStripError) return { versionId, status: 'failed', reason: 'metadata_strip_failed' }
    throw error
  }
  const changed = !processed.content.equals(content)
  // 원래 내용이거나, 이미 지운 결과(지난 실행이 내용만 바꾸고 죽은 경우)여야 합니다.
  if (sha256(content) !== version.sha256 && changed) return { versionId, status: 'failed', reason: 'integrity_mismatch' }
  if (options.dryRun) return { versionId, status: 'would_update' }

  const served = changed
    ? await writeObject(storage, version.objectKey, processed.content)
    : { sha256: sha256(content), bytes: content.length }
  const pdf = version.mediaType === 'application/pdf'
  const [updated] = await db
    .update(artifactVersions)
    .set({
      metadataStripped: processed.stripped,
      strippedSha256: served.sha256,
      strippedBytes: served.bytes,
      metadataFindings: processed.findings as unknown as Record<string, unknown>,
    })
    .where(
      and(
        eq(artifactVersions.id, versionId),
        eq(artifactVersions.scanStatus, 'clean'),
        pdf ? isNull(artifactVersions.metadataFindings) : eq(artifactVersions.metadataStripped, false),
      ),
    )
    .returning({ id: artifactVersions.id })
  if (!updated) return { versionId, status: 'skipped' }
  return { versionId, status: pdf ? 'pdf_checked' : changed ? 'stripped' : 'unchanged' }
}

/**
 * 처리 전인 clean 버전을 모두 처리합니다(id 순, batch개씩). 실패한 버전은 건너뛰고 다음으로 갑니다(다음 실행에서 다시 시도).
 * onOutcome으로 진행 상황을 받을 수 있습니다(로그에는 버전 id와 결과 코드만).
 */
export async function backfillMetadataStrip(
  db: DbExecutor,
  storage: ObjectStorage,
  options: { dryRun?: boolean; batch?: number; onOutcome?: (outcome: BackfillOutcome) => void } = {},
): Promise<BackfillSummary> {
  const batch = options.batch ?? 100
  const outcomes: BackfillOutcome[] = []
  let after: string | null = null
  for (;;) {
    const rows = await pendingVersions(db, after, batch)
    if (rows.length === 0) break
    for (const row of rows) {
      const outcome = await backfillVersion(db, storage, row, options)
      outcomes.push(outcome)
      options.onOutcome?.(outcome)
    }
    after = rows[rows.length - 1]!.id
  }
  return { outcomes }
}
