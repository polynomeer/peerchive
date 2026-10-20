/**
 * 케이스 스터디가 고정한 release를 "지금 제공 가능한가"와 함께 읽는 도우미 (T-14, SYSTEM_DESIGN §1-1·§1-4·§11, ADR 0012·0013·0014).
 *
 * 케이스 스터디의 공개 여부는 행의 status만 믿지 않습니다. 매 요청 같은 쿼리에서 `servableReleaseSql`(공개 published + release published +
 * 지금 release + 엠바고 없음)로 고정한 release를 확인하므로, 철회·대체가 커밋되는 순간 케이스 내용이 공개 경로에서 사라집니다
 * (worker의 unavailable 표시는 남은 상태를 맞출 뿐입니다).
 */
import { CASE_SECTIONS, type CaseCitation, type CaseSectionDraft, type CaseSentenceKind, type CaseSnapshot, caseSectionOrder } from '@peerchive/domain'
import {
  asc,
  caseSentences,
  caseStudies,
  eq,
  inArray,
  projects,
  publicationCandidates,
  publications,
  sql,
  type DbExecutor,
  type SQL,
} from '@peerchive/db'
import { servableReleaseSql } from '../course-hub/public-scope'
import type { CaseUnavailableReason, PublicSnapshot } from '../../../shared/types/api'

export type CaseStudyRow = typeof caseStudies.$inferSelect

export interface CaseStudyWithRelease {
  caseStudy: CaseStudyRow
  slug: string
  releaseStatus: string
  termLabel: string | null
  releasePublishedAt: Date | null
  snapshot: PublicSnapshot
  /** 고정한 release를 지금 공개로 내줄 수 있는지(같은 쿼리에서 판정). */
  servable: boolean
}

/** 케이스 스터디 + 고정 release(스냅샷·제공 가능 여부). `where`로 고릅니다. */
export async function loadCaseStudiesWithRelease(
  db: DbExecutor,
  where: SQL | undefined,
  now: Date,
): Promise<CaseStudyWithRelease[]> {
  const rows = await db
    .select({
      caseStudy: caseStudies,
      slug: publications.slug,
      releaseStatus: publicationCandidates.status,
      termLabel: publicationCandidates.termLabel,
      releasePublishedAt: publicationCandidates.publishedAt,
      snapshot: publicationCandidates.snapshot,
      servable: sql<boolean>`${servableReleaseSql(now)}`,
    })
    .from(caseStudies)
    .innerJoin(publicationCandidates, eq(publicationCandidates.id, caseStudies.releaseId))
    .innerJoin(publications, eq(publications.id, caseStudies.publicationId))
    .innerJoin(projects, eq(projects.id, publications.projectId))
    .where(where)
  return rows.map((r) => ({ ...r, snapshot: r.snapshot as unknown as PublicSnapshot, servable: r.servable === true }))
}

/** 읽는 지금 기준 상태와 볼 수 없는 이유. 저장된 unavailable은 되돌리지 않습니다. */
export function effectiveStatus(row: CaseStudyWithRelease): { status: CaseStudyRow['status']; reason: CaseUnavailableReason | null } {
  if (row.caseStudy.status === 'unavailable') return { status: 'unavailable', reason: (row.caseStudy.unavailableReason as CaseUnavailableReason | null) ?? 'withdrawn' }
  if (row.servable) return { status: row.caseStudy.status, reason: null }
  if (row.releaseStatus === 'replaced') return { status: 'unavailable', reason: 'replaced' }
  if (row.releaseStatus === 'withdrawn') return { status: 'unavailable', reason: 'withdrawn' }
  return { status: 'unavailable', reason: 'blocked' }
}

/** 케이스들의 문장(구역 순서는 직무 순서, 구역 안은 position 순). */
export async function loadSections(db: DbExecutor, caseStudyRows: readonly CaseStudyRow[]): Promise<Map<string, CaseSectionDraft[]>> {
  const out = new Map<string, CaseSectionDraft[]>()
  if (caseStudyRows.length === 0) return out
  const rows = await db
    .select()
    .from(caseSentences)
    .where(inArray(caseSentences.caseStudyId, caseStudyRows.map((c) => c.id)))
    .orderBy(asc(caseSentences.caseStudyId), asc(caseSentences.section), asc(caseSentences.position))
  for (const cs of caseStudyRows) {
    const mine = rows.filter((r) => r.caseStudyId === cs.id)
    out.set(
      cs.id,
      caseSectionOrder(cs.jobTarget).map((key) => ({
        key,
        sentences: mine
          .filter((r) => r.section === key)
          .map((r) => ({
            text: r.text,
            kind: r.kind as CaseSentenceKind,
            citations: (r.citations as unknown as CaseCitation[]).map((c) => ({ releaseVersion: c.releaseVersion, kind: c.kind, key: c.key })),
          })),
      })),
    )
  }
  return out
}

/** 문장 전체를 바꿉니다(편집·초안 생성). */
export async function replaceSentences(tx: DbExecutor, caseStudyId: string, sections: readonly CaseSectionDraft[]): Promise<void> {
  await tx.delete(caseSentences).where(eq(caseSentences.caseStudyId, caseStudyId))
  const values = sections.flatMap((s) =>
    s.sentences.map((sentence, position) => ({
      caseStudyId,
      section: s.key,
      position,
      text: sentence.text,
      kind: sentence.kind,
      citations: sentence.citations.map((c) => ({ releaseVersion: c.releaseVersion, kind: c.kind, key: c.key })),
    })),
  )
  if (values.length > 0) await tx.insert(caseSentences).values(values)
}

export const asCaseSnapshot = (snapshot: PublicSnapshot): CaseSnapshot => snapshot as unknown as CaseSnapshot

export const isCaseSection = (value: string): boolean => (CASE_SECTIONS as readonly string[]).includes(value)
