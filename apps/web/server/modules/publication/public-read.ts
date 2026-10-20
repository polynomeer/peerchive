/**
 * 익명 공개 조회 (T-12, SYSTEM_DESIGN §1-1·§1-4·§9·§10·§11, ADR 0012).
 *
 * - 공개 경로는 저장된 release 스냅샷(publication_candidates.snapshot)만 내줍니다. 비공개 작업 테이블(로그·선언·마일스톤 등)을
 *   읽지 않고, 스냅샷을 다시 만들지도 않습니다. 정책 판정에 필요한 행(공개·release 상태, 엠바고, 파일 검사 상태)만 읽습니다.
 * - 요청마다 DB에서 상태를 읽습니다(캐시 없음). 철회·대체·엠바고가 커밋되는 순간 다음 요청부터 404입니다. worker가 늦거나 죽어도 같습니다.
 * - 내줄 수 없는 모든 경우는 같은 404입니다(없음·철회·대체·엠바고·준비 중을 구분하지 않음).
 */
import type { Readable } from 'node:stream'
import {
  type PublicReadState,
  canServePublicArtifact,
  canServePublicRelease,
  isAllowedMediaType,
  isMetadataReady,
} from '@peerchive/domain'
import { ObjectNotFoundError, isObjectKey, type ObjectStorage } from '@peerchive/files'
import {
  and,
  artifactVersions,
  artifacts,
  courses,
  eq,
  planForks,
  publicationCandidates,
  publications,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import { getProjectEmbargo } from '../embargo/embargo'
import { notFound } from '../errors'
import { isUuid } from '../projects/access'
import type { PublicPublicationDto, PublicSnapshot } from '../../../shared/types/api'

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

type PublicationRow = typeof publications.$inferSelect
type CandidateRow = typeof publicationCandidates.$inferSelect

interface ServedRelease {
  publication: PublicationRow
  release: CandidateRow
  snapshot: PublicSnapshot
  state: PublicReadState
}

/** slug의 지금 release를 내줄 수 있으면 돌려주고, 아니면 null. 매 요청 DB를 읽습니다. 플랜 포크·신호(T-13)도 이 판정을 씁니다. */
export async function loadServedRelease(db: DbExecutor, slug: unknown, now: Date): Promise<ServedRelease | null> {
  if (typeof slug !== 'string' || slug.length < 3 || slug.length > 60 || !SLUG_PATTERN.test(slug)) return null
  const [row] = await db
    .select({ publication: publications, release: publicationCandidates })
    .from(publications)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, publications.currentReleaseId))
    .where(eq(publications.slug, slug))
    .limit(1)
  if (!row) return null
  const embargo = await getProjectEmbargo(db, row.publication.projectId, now)
  const state: PublicReadState = {
    publicationStatus: row.publication.status,
    releaseStatus: row.release.status,
    isCurrentRelease: row.release.publicationId === row.publication.id && row.release.id === row.publication.currentReleaseId,
    embargoActive: embargo.active,
  }
  if (!canServePublicRelease(state) || row.release.releaseNo === null || !row.release.publishedAt) return null
  return { ...row, snapshot: row.release.snapshot as unknown as PublicSnapshot, state }
}

/** GET /public/publications/:slug — 지금 release의 저장된 스냅샷 그대로 + 공개 메타데이터. 그 밖에는 404. */
export async function getPublicPublication(db: DbExecutor, slug: unknown, now = new Date()): Promise<PublicPublicationDto> {
  const served = await loadServedRelease(db, slug, now)
  if (!served) throw notFound()
  const { publication, release, snapshot } = served
  let courseId: string | null = null
  if (release.courseId) {
    const [course] = await db.select({ id: courses.id, mergedInto: courses.mergedInto }).from(courses).where(eq(courses.id, release.courseId)).limit(1)
    courseId = course ? (course.mergedInto ?? course.id) : null
  }
  const [{ forks } = { forks: 0 }] = await db
    .select({ forks: sql<number>`count(*)::int` })
    .from(planForks)
    .where(eq(planForks.sourcePublicationId, publication.id))
  return {
    slug: publication.slug,
    level: release.level,
    version: release.releaseNo!,
    publishedAt: release.publishedAt!.toISOString(),
    firstPublishedAt: (publication.firstPublishedAt ?? release.publishedAt!).toISOString(),
    snapshot,
    courseId,
    forkCount: forks,
  }
}

export interface PublicArtifactContent {
  stream: Readable
  mediaType: string
  bytes: number
  /** 스냅샷의 공개 표시 이름(원래 파일 이름이 아님: 익명 팀원 이름·경로가 들어 있지 않음). */
  fileName: string
  /** access_epoch·공개 버전·내려주는 내용(메타데이터 제거본)의 해시를 넣은 ETag. 철회·새 버전이면 바뀝니다. */
  etag: string
}

/**
 * GET /public/publications/:slug/artifacts/:versionId — 지금 release 스냅샷에 들어 있고 지금도 clean인 파일만.
 * 같은 프로젝트의 clean 파일이라도 스냅샷에 없으면, 이전 release에만 있던 파일이면 404입니다.
 * 메타데이터를 지우기 전(backfill 전) 이미지도 404입니다. 내용·크기·ETag는 메타데이터를 지운 clean 객체의 값입니다.
 */
export async function openPublicArtifact(
  db: DbExecutor,
  storage: ObjectStorage,
  slug: unknown,
  versionId: unknown,
  now = new Date(),
): Promise<PublicArtifactContent> {
  if (!isUuid(versionId)) throw notFound()
  const id = versionId.toLowerCase()
  const served = await loadServedRelease(db, slug, now)
  if (!served) throw notFound()
  const { publication, release, snapshot, state } = served
  const entry = snapshot.artifacts.find((a) => a.artifactVersionId === id)
  const [row] = entry
    ? await db
        .select({ version: artifactVersions })
        .from(artifactVersions)
        .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
        .where(and(eq(artifactVersions.id, id), eq(artifacts.projectId, publication.projectId)))
        .limit(1)
    : []
  const version = row?.version
  const decision = canServePublicArtifact(state, { inCurrentSnapshot: !!entry && !!version, scanStatus: version?.scanStatus ?? null })
  if (!decision || !entry || !version) throw notFound()
  // 메타데이터를 지우기 전(backfill 전) 이미지는 공개로 내주지 않습니다(같은 404).
  if (!isMetadataReady(version)) throw notFound()
  // clean인데 판별 형식이 없거나 키가 격리 영역이면 내려주지 않습니다(방어, 비공개 경로와 같음).
  if (!version.mediaType || !isAllowedMediaType(version.mediaType) || !version.objectKey.startsWith('clean/')) throw notFound()
  if (!isObjectKey(version.objectKey)) throw notFound()
  let stream: Readable
  try {
    stream = await storage.get(version.objectKey)
  } catch (error) {
    if (error instanceof ObjectNotFoundError) throw notFound()
    throw error
  }
  return {
    stream,
    mediaType: version.mediaType,
    bytes: version.strippedBytes ?? version.bytes,
    fileName: entry.displayName,
    etag: `"pe${publication.accessEpoch}-r${release.releaseNo}-${(version.strippedSha256 ?? version.sha256).slice(0, 16)}"`,
  }
}
