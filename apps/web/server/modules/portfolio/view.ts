/**
 * 공개 포트폴리오 보기 만들기 (T-14, PROOFU_EVOLUTION_PLAN §10.1·§10.3·§10.4·§11, ADR 0014). 공개 프로필과 판 미리보기가 함께 씁니다.
 *
 * 출처(이것 말고는 읽지 않음):
 * - 판의 사용자 글(한 줄 소개·역량 이름·자기 선언 스킬),
 * - 대표 케이스 스터디의 문장(사용자 글 + 스냅샷에서 만든 초안) — **케이스가 게시 중이고 고정 release를 지금 제공할 수 있을 때만**
 *   (`servableReleaseSql`, 같은 쿼리). 아니면 글 없이 "원본 사례를 더 이상 볼 수 없습니다",
 * - 인용 표시·위치와 매트릭스 개수 — 그 release의 저장된 스냅샷.
 * 내부 id(케이스·release·사용자)는 싣지 않고, 대표 케이스는 순서 기반 앵커(`case-1`…)로 가리킵니다.
 * "이 지원자에게 물어보면 좋은 질문"(E-06, ADR 0050)은 `askQuestions` 옵션을 켠 호출(실명 페르소나의 공개 프로필·판 미리보기)에서만,
 * 볼 수 있는 케이스의 공개로 고른 질문 글만 싣습니다(답변 메모는 읽지 않음).
 */
import {
  CASE_JOB_TARGET_LABELS,
  CASE_SECTION_LABELS,
  type CaseCitation,
  type MatrixColumnInput,
  HIDDEN_ITEM_PLACEHOLDER,
  INTERVIEW_QUESTION_CATEGORY_LABELS,
  canLinkReleaseToPortfolio,
  citationLabel,
  citationPath,
  citesHiddenItem,
  computeCompetencyMatrix,
  hiddenItemSet,
  isItemHidden,
} from '@peerchive/domain'
import { caseStudies, inArray, type DbExecutor } from '@peerchive/db'
import { publicInterviewQuestions } from './interview-prep'
import { asCaseSnapshot, type CaseStudyWithRelease, loadCaseStudiesWithRelease, loadSections } from './release-scope'
import type { PortfolioViewDto, PublicCaseStudyDto, PublicCitationDto } from '../../../shared/types/api'

export const CASE_UNAVAILABLE_MESSAGE = '원본 사례를 더 이상 볼 수 없습니다'
export const CASE_HIDDEN_MESSAGE = '지금은 볼 수 없는 케이스 스터디입니다'

/** 판의 내용(저장된 판 또는 미리보기 입력). */
export interface EditionModel {
  userId: string
  headline: string | null
  /** 순서대로의 대표 케이스 id. */
  featured: readonly string[]
  competencies: ReadonlyArray<{ label: string; preset: string | null }>
  evidence: ReadonlyArray<{ competencyIndex: number; caseStudyId: string; kind: CaseCitation['kind']; key: string }>
  skillsDeclared: readonly string[]
}

export const featuredAnchor = (index: number) => `case-${index + 1}`

/**
 * 이 사용자의 케이스 중 공개 경로에 실을 수 있는 것(게시 중 + 고정 release 제공 가능 + 운영 조치로 숨기지 않음, T-15).
 * 익명 스터디 방의 기록(C-08)은 만들기·게시가 막혀 있지만, 공개 프로필·포트폴리오에는 여기서 한 번 더 거릅니다.
 */
export const isPubliclyVisible = (row: CaseStudyWithRelease) =>
  row.caseStudy.status === 'published' && row.servable && row.caseStudy.hiddenAt === null && canLinkReleaseToPortfolio(row.snapshot)

export interface PortfolioViewOptions {
  /** 면접 준비 팩의 공개 질문을 실을지(E-06). 실명 페르소나의 공개 프로필·판 미리보기만 켭니다. */
  askQuestions?: boolean
}

export async function buildPortfolioView(db: DbExecutor, model: EditionModel, now: Date, options: PortfolioViewOptions = {}): Promise<PortfolioViewDto> {
  const rows = model.featured.length
    ? (await loadCaseStudiesWithRelease(db, inArray(caseStudies.id, [...model.featured]), now)).filter((r) => r.caseStudy.userId === model.userId)
    : []
  const byId = new Map(rows.map((r) => [r.caseStudy.id, r]))
  const visible = rows.filter(isPubliclyVisible)
  const sections = await loadSections(db, visible.map((r) => r.caseStudy))
  const asked = options.askQuestions ? await publicInterviewQuestions(db, visible, sections) : new Map<string, never[]>()

  const hiddenBy = new Map(rows.map((r) => [r.caseStudy.id, hiddenItemSet(r.hidden)]))
  const isHidden = (row: CaseStudyWithRelease, c: Pick<CaseCitation, 'kind' | 'key'>) =>
    isItemHidden(hiddenBy.get(row.caseStudy.id) ?? new Set(), c.kind, c.key)
  const citation = (row: CaseStudyWithRelease, c: Pick<CaseCitation, 'kind' | 'key'>): PublicCitationDto | null => {
    // 운영 조치로 가린 항목은 글·위치를 싣지 않습니다(T-15).
    if (isHidden(row, c)) return null
    const label = citationLabel(asCaseSnapshot(row.snapshot), c)
    return label ? { label, path: citationPath(row.slug, c) } : null
  }

  const featured: PublicCaseStudyDto[] = model.featured.map((id, index) => {
    const anchor = featuredAnchor(index)
    const row = byId.get(id)
    if (!row || !isPubliclyVisible(row)) {
      return { anchor, available: false, message: row && !row.servable ? CASE_UNAVAILABLE_MESSAGE : CASE_HIDDEN_MESSAGE }
    }
    const cs = row.caseStudy
    return {
      anchor,
      available: true,
      title: cs.title,
      jobTarget: cs.jobTarget,
      jobTargetLabel: CASE_JOB_TARGET_LABELS[cs.jobTarget],
      path: `/p/${row.slug}`,
      releaseVersion: cs.releaseVersion,
      termLabel: row.termLabel,
      selfLabel: row.snapshot.members.find((m) => m.key === cs.memberKey)?.label ?? '팀원',
      generator: cs.generator === 'ai' ? 'ai' : 'template',
      sections: (sections.get(cs.id) ?? [])
        .filter((s) => s.sentences.length > 0)
        .map((s) => ({
          key: s.key,
          label: CASE_SECTION_LABELS[s.key],
          // 가린 항목을 인용한 문장은 글 전체를 자리 표시로 바꿉니다(초안 문장이 스냅샷 글을 담고 있으므로, T-15).
          sentences: s.sentences.map((sentence) =>
            citesHiddenItem(sentence.citations, hiddenBy.get(cs.id) ?? new Set())
              ? { text: HIDDEN_ITEM_PLACEHOLDER, reflection: false, citations: [], moderated: true }
              : {
                  text: sentence.text,
                  reflection: sentence.kind === 'reflection',
                  citations: sentence.citations.map((c) => citation(row, c)).filter((c): c is PublicCitationDto => c !== null),
                },
          ),
        })),
      askQuestions: (asked.get(cs.id) ?? []).map((q) => ({
        text: q.text,
        categoryLabel: INTERVIEW_QUESTION_CATEGORY_LABELS[q.category],
        source: q.source ? citation(row, q.source) : null,
      })),
    }
  })

  const columns: MatrixColumnInput[] = model.featured.map((id, index) => {
    const row = byId.get(id)
    const available = !!row && isPubliclyVisible(row)
    return { ref: featuredAnchor(index), available, snapshot: available ? asCaseSnapshot(row!.snapshot) : null }
  })
  const columnOf = new Map(model.featured.map((id, index) => [id, featuredAnchor(index)]))
  const matrixRows = computeCompetencyMatrix(
    columns,
    model.competencies.map((c, i) => ({
      label: c.label,
      preset: c.preset,
      evidence: model.evidence
        .filter((e) => e.competencyIndex === i && columnOf.has(e.caseStudyId))
        .filter((e) => {
          const row = byId.get(e.caseStudyId)
          return !row || !isHidden(row, e)
        })
        .map((e) => ({ column: columnOf.get(e.caseStudyId)!, citations: [{ kind: e.kind, key: e.key }] })),
    })),
  )
  const rowByColumn = new Map(model.featured.map((id, index) => [featuredAnchor(index), byId.get(id)]))
  return {
    headline: model.headline,
    featured,
    matrix: {
      columns: featured.map((f) => ({ ref: f.anchor, title: f.available ? f.title : '볼 수 없는 사례', available: f.available })),
      rows: matrixRows.map((r) => ({
        label: r.label,
        evidenceBacked: r.evidenceBacked,
        cells: r.cells.map((cell) => {
          const row = rowByColumn.get(cell.column)
          return {
            column: cell.column,
            available: cell.available,
            counts: cell.counts.map((c) => ({ category: c.category, label: c.label, count: c.count })),
            text: cell.text,
            evidence: row && cell.available ? cell.citations.map((c) => citation(row, c)).filter((c): c is PublicCitationDto => c !== null) : [],
          }
        }),
      })),
    },
    evidenceBackedCompetencies: matrixRows.filter((r) => r.evidenceBacked).map((r) => r.label),
    skillsDeclared: [...model.skillsDeclared],
  }
}
