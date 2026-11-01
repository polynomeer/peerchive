/**
 * 케이스 스터디·포트폴리오 판 화면 도우미(T-14). 상태는 색이 아니라 글자로 보여 줍니다.
 */
import {
  CASE_JOB_TARGETS,
  CASE_JOB_TARGET_LABELS,
  CASE_SECTION_LABELS,
  COMPETENCY_LIMIT,
  COMPETENCY_PRESETS,
  FEATURED_CASE_LIMIT,
  INTERVIEW_NOTE_MAX,
  INTERVIEW_PUBLIC_HEADING,
  JOB_TARGET_PRESETS,
  REFLECTION_LABEL,
  SKILL_LIMIT,
  citationLabel,
  type CaseSnapshot,
} from '@peerchive/domain'
import type { CaseCitationRef, CaseStudyStatus, CaseUnavailableReason, PublicSnapshot } from '~~/shared/types/api'

export {
  CASE_JOB_TARGETS,
  CASE_JOB_TARGET_LABELS,
  CASE_SECTION_LABELS,
  COMPETENCY_LIMIT,
  COMPETENCY_PRESETS,
  FEATURED_CASE_LIMIT,
  INTERVIEW_NOTE_MAX,
  INTERVIEW_PUBLIC_HEADING,
  JOB_TARGET_PRESETS,
  REFLECTION_LABEL,
  SKILL_LIMIT,
}

export const CASE_STATUS_LABELS: Record<CaseStudyStatus, string> = {
  draft: '초안 · 공개 전',
  published: '게시됨(포트폴리오에 넣을 수 있음)',
  unavailable: '볼 수 없음',
}

export const CASE_UNAVAILABLE_LABELS: Record<CaseUnavailableReason, string> = {
  withdrawn: '원본 공개 사례가 철회되었습니다',
  replaced: '원본 공개 사례가 새 버전으로 바뀌었습니다',
  blocked: '원본 공개 사례를 지금은 볼 수 없습니다',
}

export const REVEAL_SELF_WARNING =
  '이 공개 사례에서 당신은 익명("팀원 A" 같은 표시)으로 나옵니다. 케이스 스터디를 만들면 당신의 공개 프로필과 이 사례가 연결되어, 사례 속 익명 표시가 당신이라는 것을 누구나 알 수 있게 됩니다. 다른 팀원의 표시는 바뀌지 않습니다.'

export const PORTFOLIO_ERROR_MESSAGES: Record<string, string> = {
  unauthenticated: '로그인이 필요합니다.',
  not_found: '찾을 수 없습니다. 공개가 철회되었을 수 있습니다.',
  version_conflict: '그 사이 케이스가 바뀌었습니다. 새로 불러온 뒤 다시 시도하세요.',
  unavailable: '원본 사례를 더 이상 볼 수 없어 고치거나 게시할 수 없습니다. 지금 공개 버전으로 다시 만드세요.',
  hidden: '운영 조치로 숨겨진 케이스 스터디는 다시 게시할 수 없습니다. 안내의 이의제기를 이용하세요.',
  uncited_sentences: '출처가 없는 문장이 있습니다. 표시된 문장에 출처를 붙이거나 지우세요("본인 회고"는 한계·회고에서만 출처 없이 둘 수 있습니다).',
  checks_unconfirmed: '공개 전 점검 경고가 있습니다. 내용을 확인한 뒤 "확인하고 게시"를 누르세요.',
  empty: '문장이 하나도 없습니다.',
  not_published: '게시 중인 케이스가 아닙니다.',
  limit_reached: '케이스 스터디를 더 만들 수 없습니다.',
  rate_limited: '잠시 뒤 다시 시도하세요(요청이 너무 많습니다).',
}

export function portfolioErrorMessage(code: string): string {
  return PORTFOLIO_ERROR_MESSAGES[code] ?? '요청을 처리하지 못했습니다. 잠시 뒤 다시 시도하세요.'
}

export const PORTFOLIO_FIELD_MESSAGES: Record<string, string> = {
  not_member: '이 공개 사례에 팀원으로 들어 있지 않습니다.',
  confirm_required: '익명 표시를 내 프로필과 연결한다는 확인이 필요합니다.',
  not_found: '스냅샷에 없는 출처이거나 찾을 수 없습니다.',
  stale_release: '다른 공개 버전의 출처입니다.',
  not_allowed: '"본인 회고"는 한계·회고 구역에서만 쓸 수 있습니다.',
  not_published: '게시한 케이스 스터디만 고를 수 있습니다(원본 사례도 지금 공개 중이어야 합니다).',
  not_featured: '대표 케이스로 고른 사례의 근거만 넣을 수 있습니다.',
  not_cited: '그 케이스가 인용한 항목만 근거로 고를 수 있습니다.',
  duplicate: '같은 이름이 두 번 들어 있습니다.',
  anonymous_study: '익명 스터디 방의 기록은 포트폴리오(케이스 스터디)에 연결할 수 없습니다.',
}

export const fieldText = (code: string | undefined) => (code ? (PORTFOLIO_FIELD_MESSAGES[code] ?? fieldMessage(code)) : undefined)

export interface CitationOption extends CaseCitationRef {
  label: string
}

/** 고정 release 스냅샷에서 고를 수 있는 출처(요약·로그·선언·마일스톤·파일). */
export function citationOptions(snapshot: PublicSnapshot, releaseVersion: number): CitationOption[] {
  const snap = snapshot as unknown as CaseSnapshot
  const refs: Array<Pick<CaseCitationRef, 'kind' | 'key'>> = [
    { kind: 'summary', key: 'summary' },
    ...snapshot.logs.map((l) => ({ kind: 'log' as const, key: l.key })),
    ...snapshot.claims.map((c) => ({ kind: 'claim' as const, key: c.key })),
    ...snapshot.milestones.map((m) => ({ kind: 'milestone' as const, key: m.key })),
    ...snapshot.artifacts.map((a) => ({ kind: 'artifact' as const, key: a.artifactVersionId })),
  ]
  return refs.flatMap((r) => {
    const label = citationLabel(snap, r)
    return label ? [{ ...r, releaseVersion, label }] : []
  })
}

export const citationId = (c: Pick<CaseCitationRef, 'kind' | 'key'>) => `${c.kind}:${c.key}`
