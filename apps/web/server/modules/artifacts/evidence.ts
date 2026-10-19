/**
 * 빌드 로그 revision의 파일 근거(T-05, SYSTEM_DESIGN §6 LogRevision ↔ ArtifactVersion).
 *
 * - 근거는 같은 프로젝트의 산출물 버전만, revision당 최대 10개입니다.
 * - 없거나 다른 프로젝트의 버전은 똑같이 422 `{evidenceVersionIds: 'not_found'}`(존재를 드러내지 않음).
 * - 검사 중(pending/scanning)인 버전은 붙일 수 있고, 격리·실패 버전은 새로 붙일 수 없습니다(`not_attachable`).
 *   이전 revision에서 이어받은 근거는 다시 검사하지 않습니다(붙인 뒤 격리될 수 있으며, 그 상태로 표시만 함).
 * - revision처럼 추가만 하는 표(log_revision_evidence)에 revision별로 저장합니다.
 */
import { canAttachAsEvidence } from '@peerchive/domain'
import {
  and,
  artifactVersions,
  artifacts,
  asc,
  eq,
  inArray,
  logRevisionEvidence,
  type DbExecutor,
} from '@peerchive/db'
import { invalid } from '../errors'
import { contentUrlFor } from './artifacts'
import type { EvidenceDto } from '../../../shared/types/api'

/** 새 근거 목록 검사. previousIds(이전 revision의 근거)에 있던 버전은 상태를 다시 보지 않습니다. */
export async function checkEvidence(
  db: DbExecutor,
  projectId: string,
  ids: readonly string[],
  previousIds: readonly string[] = [],
): Promise<void> {
  if (ids.length === 0) return
  const rows = await db
    .select({ id: artifactVersions.id, scanStatus: artifactVersions.scanStatus })
    .from(artifactVersions)
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(and(inArray(artifactVersions.id, [...ids]), eq(artifacts.projectId, projectId)))
  const byId = new Map(rows.map((row) => [row.id, row.scanStatus]))
  for (const id of ids) {
    const status = byId.get(id)
    if (!status) throw invalid({ evidenceVersionIds: 'not_found' })
    if (!previousIds.includes(id) && !canAttachAsEvidence(status)) throw invalid({ evidenceVersionIds: 'not_attachable' })
  }
}

export async function insertEvidence(db: DbExecutor, revisionId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  await db
    .insert(logRevisionEvidence)
    .values(ids.map((artifactVersionId, position) => ({ logRevisionId: revisionId, artifactVersionId, position })))
}

/** revision별 근거 버전 id(첨부 순서). */
export async function evidenceIdsByRevision(db: DbExecutor, revisionIds: readonly string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (revisionIds.length === 0) return result
  const rows = await db
    .select({ revisionId: logRevisionEvidence.logRevisionId, versionId: logRevisionEvidence.artifactVersionId })
    .from(logRevisionEvidence)
    .where(inArray(logRevisionEvidence.logRevisionId, [...revisionIds]))
    .orderBy(asc(logRevisionEvidence.logRevisionId), asc(logRevisionEvidence.position))
  for (const row of rows) result.set(row.revisionId, [...(result.get(row.revisionId) ?? []), row.versionId])
  return result
}

/** revision별 근거 DTO(첨부 순서). 로그 DTO를 만들 때 한 번에 읽습니다. */
export async function evidenceByRevision(db: DbExecutor, revisionIds: readonly string[]): Promise<Map<string, EvidenceDto[]>> {
  const result = new Map<string, EvidenceDto[]>()
  if (revisionIds.length === 0) return result
  const rows = await db
    .select({
      revisionId: logRevisionEvidence.logRevisionId,
      version: artifactVersions,
      title: artifacts.title,
    })
    .from(logRevisionEvidence)
    .innerJoin(artifactVersions, eq(artifactVersions.id, logRevisionEvidence.artifactVersionId))
    .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
    .where(inArray(logRevisionEvidence.logRevisionId, [...revisionIds]))
    .orderBy(asc(logRevisionEvidence.logRevisionId), asc(logRevisionEvidence.position))
  for (const { revisionId, version, title } of rows) {
    const dto: EvidenceDto = {
      versionId: version.id,
      artifactId: version.artifactId,
      title,
      fileName: version.fileName,
      versionNo: version.versionNo,
      mediaType: version.mediaType,
      scanStatus: version.scanStatus,
      contentUrl: version.scanStatus === 'clean' ? contentUrlFor(version.artifactId, version.id) : null,
    }
    result.set(revisionId, [...(result.get(revisionId) ?? []), dto])
  }
  return result
}
