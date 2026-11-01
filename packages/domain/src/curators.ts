/**
 * 학생 큐레이터 (E-03, PROOFU_EVOLUTION_PLAN §8.6, DELIVERY_PLAN §4.4 E-03, ADR 0048).
 *
 * 과목마다 그 과목을 마친 고학년·졸업생 1~2명이 개념 태그 병합 제안·과제 유형 요약·1차 신고 검토(의견만)·팀원 찾기 끄기를 맡습니다.
 * 공개 철회·가리기·계정 조치·작성자 확인·신고 처리는 운영자만 합니다.
 */
import type { ReportTargetType } from './moderation'

/** 정본 과목당 큐레이터 최대 수(§8.6 "1~2명"). */
export const COURSE_CURATOR_LIMIT = 2

/** 과제 유형 요약 최대 길이(글자). */
export const ASSIGNMENT_TYPE_SUMMARY_MAX = 1000

/** 병합 제안 이유·신고 의견 메모 최대 길이(글자). */
export const CURATOR_NOTE_MAX = 300

/**
 * 큐레이터가 1차 검토할 수 있는 신고 대상: 과목 허브에 걸린 공개 항목(선배 노트·막힘 Q&A·그 과목의 공개 사례와 그 안의 항목)과
 * E-04(ADR 0049) 막힘 Q&A 스레드의 글(그 공개 사례의 지금 release 과목).
 */
export const CURATOR_REVIEW_TARGETS = ['senior_note', 'course_qa', 'publication', 'publication_item', 'stuck_qa_post'] as const satisfies readonly ReportTargetType[]
export type CuratorReviewTarget = (typeof CURATOR_REVIEW_TARGETS)[number]

export const CURATOR_RECOMMENDATIONS = ['dismiss', 'hide'] as const
export type CuratorRecommendation = (typeof CURATOR_RECOMMENDATIONS)[number]

export const CONCEPT_TAG_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected'] as const
export type ConceptTagProposalStatus = (typeof CONCEPT_TAG_PROPOSAL_STATUSES)[number]

export function isCuratorReviewTarget(targetType: string): targetType is CuratorReviewTarget {
  return (CURATOR_REVIEW_TARGETS as readonly string[]).includes(targetType)
}

/**
 * 큐레이터 지정 자격(운영자가 지정할 때 확인). 과목을 마쳤고(끝난 학기 등록 또는 끝난 학기 과제 공간의 active 멤버) 그 과목 학교의 active 학교 메일 인증이 있어야 합니다.
 * 이미 지정된 사람은 `already_curator`, 과목에 2명이 차 있으면 `limit_reached`. 순서: 계정 → 이미 지정 → 한도 → 마침 → 인증.
 */
export type CuratorEligibility =
  | { ok: true }
  | { ok: false; error: 'inactive' | 'already_curator' | 'limit_reached' | 'not_finished' | 'not_verified' }

export function curatorEligibility(facts: {
  userActive: boolean
  alreadyCurator: boolean
  activeCurators: number
  finishedCourse: boolean
  verifiedForSchool: boolean
}): CuratorEligibility {
  if (!facts.userActive) return { ok: false, error: 'inactive' }
  if (facts.alreadyCurator) return { ok: false, error: 'already_curator' }
  if (facts.activeCurators >= COURSE_CURATOR_LIMIT) return { ok: false, error: 'limit_reached' }
  if (!facts.finishedCourse) return { ok: false, error: 'not_finished' }
  if (!facts.verifiedForSchool) return { ok: false, error: 'not_verified' }
  return { ok: true }
}
