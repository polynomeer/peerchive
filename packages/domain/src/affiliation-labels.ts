/**
 * 토픽·소속 표시 익명·소속 표시 임계값 (A-05, PROOFU_EVOLUTION_PLAN §4.4 1단계·§8.9.10, SYSTEM_DESIGN §6.7.2 "토픽과 소속 표시 익명"·§8.4·§9.2,
 * DELIVERY_PLAN §4.3 A-05·§5.3 Y, ADR 0042).
 *
 * - 토픽 글·댓글(이름 표시 `affiliated_anonymous`)에는 이름 대신 **작성 시점에 고정한 소속 표시** 하나가 붙습니다: `○○대 · 졸업생`(기관 + 신분),
 *   `부트캠프 수료생`(기관 종류 + 신분), 또는 없음(표시 안 함). 학과·기수·입학연도는 어떤 경우에도 넣지 않습니다(이 파일의 함수는 그 값을 받지도 않음).
 * - **임계값(두 단계)**: 작성자가 기관 이름을 골라도 그 (기관, 신분)의 인증 회원이 AFFILIATION_LABEL_THRESHOLD(50) 미만이면 기관 종류로 넓히고,
 *   넓힌 범주(기관 종류, 신분 — 모든 기관 합계)의 인증 회원도 50 미만이면 소속을 표시하지 않습니다(none). 기관 종류를 고른 경우도 범주가 50 미만이면 none.
 *   작은 집단에서 소속 표시가 익명을 깨뜨리지 않게 하는 장치로, n ≥ 5 익명 집계 원칙(제품 기획 §6.4)을 개인 글에 확장한 것입니다.
 *   작성자가 고른 범위보다 좁게 표시하는 경우는 없습니다(DB check도 같음).
 * - 넓혀졌는지(`broadened`)는 작성자 본인에게만 알립니다(글쓰기 화면 미리보기·내 글 응답). 다른 사람의 응답에는 문자열만 실리고, 회원 수는 누구에게도
 *   보내지 않습니다.
 * - 셈하는 회원(`countsTowardLabelThreshold`): 그 기관(정본)·그 신분(범주 단계는 그 기관 종류의 모든 기관·그 신분)의 **active이고 인증된(verified_at)** 소속 + **active 계정**. 사람 단위로 한 번.
 *   pending·만료·철회 소속, 정지·탈퇴 계정, 다른 신분은 세지 않습니다.
 *
 * 런타임 의존성 없음.
 */
import { INSTITUTION_KIND_LABELS, type InstitutionKindValue, standingLabelFor } from './institutions'

/** 소속 표시 범위: 넓어지는 순서(institution → institution_kind → none). DB enum affiliation_label_scope와 같은 값. */
export const AFFILIATION_LABEL_SCOPES = ['institution', 'institution_kind', 'none'] as const
export type AffiliationLabelScope = (typeof AFFILIATION_LABEL_SCOPES)[number]
export const AFFILIATION_LABEL_SCOPE_LABELS: Readonly<Record<AffiliationLabelScope, string>> = {
  institution: '학교·기관 이름',
  institution_kind: '학교·기관 유형만',
  none: '표시 안 함',
}
/** 작성자가 고르지 않으면 기관 이름(설계 "표시할 소속 범위는 작성자가 고릅니다" — 기본은 가장 좁은 것, 임계값이 넓힘). */
export const DEFAULT_AFFILIATION_LABEL_SCOPE: AffiliationLabelScope = 'institution'

/** 기관 이름을 보여 줄 수 있는 최소 인증 회원 수(초기안 50, 설정값 — SYSTEM_DESIGN §6.7.2 "임계값(초기안 50, 설정값)"). */
export const AFFILIATION_LABEL_THRESHOLD = 50

/** 토픽 분류(SYSTEM_DESIGN §6.7.2 topic_category). DB enum topic_category와 같은 값. */
export const TOPIC_CATEGORIES = ['career', 'grad_school', 'startup', 'military', 'campus_life', 'role'] as const
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number]
export const TOPIC_CATEGORY_LABELS: Readonly<Record<TopicCategory, string>> = {
  career: '취준',
  grad_school: '대학원',
  startup: '창업',
  military: '군대·예비역',
  campus_life: '학교생활',
  role: '직무',
}

export type AffiliationStandingValue = 'student' | 'alumni'

const SCOPE_RANK: Readonly<Record<AffiliationLabelScope, number>> = { institution: 0, institution_kind: 1, none: 2 }

/** 표시 범위를 넓히는 것뿐인지(같거나 더 넓음: institution → institution_kind → none). DB check `*_label_scope_check`와 같은 규칙. */
export function isBroaderOrEqualScope(applied: AffiliationLabelScope, requested: AffiliationLabelScope): boolean {
  return SCOPE_RANK[applied] >= SCOPE_RANK[requested]
}

export function isAffiliationLabelScope(value: unknown): value is AffiliationLabelScope {
  return typeof value === 'string' && (AFFILIATION_LABEL_SCOPES as readonly string[]).includes(value)
}

/** 기관 이름 표시: `○○대 · 졸업생`, `○○부트캠프 · 수료생`. 기관 이름은 정본(병합을 따라감), 신분 글자는 standingLabelFor. */
export function institutionAffiliationLabel(institutionName: string, kind: InstitutionKindValue, standing: AffiliationStandingValue): string {
  return `${institutionName.normalize('NFC').replace(/\s+/g, ' ').trim()} · ${standingLabelFor(kind, standing)}`
}

/** 기관 종류 표시: `대학 재학생`·`대학 졸업생`·`부트캠프 수강생`·`부트캠프 수료생`·`교육 프로그램 수료생`·`동아리 연합 수료생`. */
export function kindAffiliationLabel(kind: InstitutionKindValue, standing: AffiliationStandingValue): string {
  return `${INSTITUTION_KIND_LABELS[kind]} ${standingLabelFor(kind, standing)}`
}

export interface AffiliationLabelInput {
  requested: AffiliationLabelScope
  institution: { name: string; kind: InstitutionKindValue }
  standing: AffiliationStandingValue
  /** 작성 시점에 센 그 (기관, 신분)의 인증 회원 수(countsTowardLabelThreshold). 응답에 싣지 않습니다. */
  verifiedMembers: number
  /** 작성 시점에 센 넓힌 범주(기관 종류, 신분 — 모든 정본 기관 합계)의 인증 회원 수. 같은 셈 규칙, 응답에 싣지 않습니다. */
  categoryMembers: number
  threshold?: number
}

export interface AffiliationLabelDecision {
  applied: AffiliationLabelScope
  /** 고정할 문자열. 표시 안 함이면 null. */
  label: string | null
  /** 고른 범위보다 넓게 바뀌었는지(작성자 본인에게만 알림). */
  broadened: boolean
}

/**
 * 작성 시점에 고정할 소속 표시(두 단계 임계값):
 * - 표시 안 함 → 없음.
 * - 기관 이름 → (기관, 신분) 회원 수가 임계값 이상이면 기관 이름, 아니면 범주(기관 종류, 신분) 회원 수가 임계값 이상이면 종류 글자, 아니면 없음.
 * - 기관 종류 → 범주 회원 수가 임계값 이상이면 종류 글자, 아니면 없음.
 * 고른 범위와 다르면 broadened(작성자에게만 알림). 임계값이 0 이하이거나 정수가 아니면 기본값을 씁니다(설정 실수로 작은 집단이 드러나지 않게).
 */
export function decideAffiliationLabel(input: AffiliationLabelInput): AffiliationLabelDecision {
  const threshold = Number.isInteger(input.threshold) && (input.threshold ?? 0) > 0 ? input.threshold! : AFFILIATION_LABEL_THRESHOLD
  const requested = input.requested
  let applied: AffiliationLabelScope = 'none'
  if (requested === 'institution' && input.verifiedMembers >= threshold) applied = 'institution'
  else if (requested !== 'none' && input.categoryMembers >= threshold) applied = 'institution_kind'
  const label =
    applied === 'institution'
      ? institutionAffiliationLabel(input.institution.name, input.institution.kind, input.standing)
      : applied === 'institution_kind'
        ? kindAffiliationLabel(input.institution.kind, input.standing)
        : null
  return { applied, label, broadened: applied !== requested }
}

/** 임계값 판정에 세는 소속 행인지(서버 SQL `verifiedMemberCount`와 같은 조건). 신분이 같고 정본 기관이 같은지는 호출자가 거릅니다. */
export function countsTowardLabelThreshold(row: {
  status: 'pending' | 'active' | 'revoked' | 'expired'
  verifiedAt: Date | null
  accountStatus: 'active' | 'suspended' | 'deleted'
}): boolean {
  return row.status === 'active' && row.verifiedAt !== null && row.accountStatus === 'active'
}

/** 글쓰기 화면 안내(작성자 본인에게만): 넓혀졌을 때의 문장. 회원 수는 싣지 않습니다. */
export const AFFILIATION_LABEL_BROADENED_NOTE =
  '이 소속(또는 학교·기관 유형)의 인증 회원이 아직 적어, 익명을 지키려고 더 넓게 표시하거나 소속을 표시하지 않습니다. 이 안내는 나에게만 보입니다.'
