/**
 * 공개 요약·게시 이력 DTO(멤버·당사자용, T-12). 공개 조회(익명) 응답에는 쓰지 않습니다.
 */
import { and, desc, eq, isNotNull, publicationCandidates, publications, type DbExecutor } from '@peerchive/db'
import type { PublicSnapshot, PublicationSummaryDto, ReleaseSummaryDto } from '../../../shared/types/api'

type PublicationRow = typeof publications.$inferSelect
type CandidateRow = typeof publicationCandidates.$inferSelect

/** 공개 페이지 경로(사이트 안 상대 경로). */
export const publicPathFor = (slug: string) => `/p/${slug}`

export function toPublicationSummary(publication: PublicationRow, current: CandidateRow | null): PublicationSummaryDto {
  const live = publication.status === 'published' && current?.status === 'published' && current.id === publication.currentReleaseId
  return {
    id: publication.id,
    slug: publication.slug,
    level: publication.level,
    status: publication.status,
    accessEpoch: publication.accessEpoch,
    currentRelease:
      live && current.releaseNo !== null && current.publishedAt
        ? { candidateId: current.id, version: current.releaseNo, publishedAt: current.publishedAt.toISOString() }
        : null,
    firstPublishedAt: publication.firstPublishedAt?.toISOString() ?? null,
    withdrawnAt: publication.withdrawnAt?.toISOString() ?? null,
    withdrawCause: (publication.withdrawCause as PublicationSummaryDto['withdrawCause']) ?? null,
    withdrawNote: publication.withdrawNote,
    publicPath: live ? publicPathFor(publication.slug) : null,
    slugLocked: publication.firstPublishedAt !== null,
  }
}

export function toReleaseSummary(release: CandidateRow): ReleaseSummaryDto {
  if (release.releaseNo === null || !release.publishedAt) throw new Error('not a release')
  return {
    candidateId: release.id,
    version: release.releaseNo,
    candidateVersion: release.version,
    status: release.status,
    title: (release.snapshot as unknown as PublicSnapshot).title,
    level: release.level,
    publishedAt: release.publishedAt.toISOString(),
    replacedAt: release.replacedAt?.toISOString() ?? null,
    withdrawnAt: release.withdrawnAt?.toISOString() ?? null,
  }
}

/** 공개 요약(지금 release 행을 함께 읽음). */
export async function loadPublicationSummary(db: DbExecutor, publication: PublicationRow): Promise<PublicationSummaryDto> {
  const [current] = publication.currentReleaseId
    ? await db.select().from(publicationCandidates).where(eq(publicationCandidates.id, publication.currentReleaseId)).limit(1)
    : []
  return toPublicationSummary(publication, current ?? null)
}

/** 게시 이력(최근 것부터). */
export async function listReleases(db: DbExecutor, publicationId: string): Promise<ReleaseSummaryDto[]> {
  const rows = await db
    .select()
    .from(publicationCandidates)
    .where(and(eq(publicationCandidates.publicationId, publicationId), isNotNull(publicationCandidates.releaseNo)))
    .orderBy(desc(publicationCandidates.releaseNo))
  return rows.map(toReleaseSummary)
}
