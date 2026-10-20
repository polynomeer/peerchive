/**
 * 학교·과목·개설 학기·개념 태그·엠바고 규칙 (PROOFU_EVOLUTION_PLAN §8.1–§8.6, §9.2, SYSTEM_DESIGN §6.2, §7.2, T-10).
 *
 * - 학교·과목·태그 이름은 학생이 입력합니다("학생 작성"). 공식 인증 의미가 없고, 정규화는 삭제가 아니라 운영자 병합입니다.
 * - 교수 실명·평가 필드는 다루지 않습니다(§8.6).
 * - 학기 종료 시각(`ends_at`)은 사용자가 정하지 않고 서버가 학기에서 계산합니다(서울 날짜의 하루 끝).
 * - 엠바고는 학기 종료 전 공개를 막을 뿐이며, 끝났다고 자동 공개하지 않습니다(§9.2).
 *   프로젝트의 엠바고(`projects.embargo_until`)는 단조 증가합니다: 학기를 바꾸거나 떼어도 줄지 않고, 운영자만 낮춥니다.
 */
import { isEmbargoActive } from './publication'

export const SEMESTERS = ['spring', 'summer', 'fall', 'winter'] as const
export type Semester = (typeof SEMESTERS)[number]

export const SEMESTER_LABELS: Readonly<Record<Semester, string>> = {
  spring: '1학기',
  summer: '여름 계절학기',
  fall: '2학기',
  winter: '겨울 계절학기',
}

/** 검색 결과 최대 개수. */
export const CATALOG_SEARCH_LIMIT = 20
/** 이 유사도(pg_trgm similarity, 정규화 키 기준) 이상이면 "비슷한 이름이 이미 있음"으로 봅니다. */
export const CATALOG_SIMILARITY_THRESHOLD = 0.6
/** 검색에서 부분 일치 외에 유사도로 더 찾을 때의 하한(pg_trgm 기본값과 같음). */
export const CATALOG_SEARCH_SIMILARITY = 0.3
export const SCHOOL_NAME_MAX = 80
export const COURSE_TITLE_MAX = 100
export const COURSE_CODE_MAX = 30
export const TAG_SLUG_MAX = 40
export const TAG_LABEL_MAX = 40
/** 과목당 개념 태그 수. 병합으로 합쳐질 때는 넘을 수 있습니다(운영자 정리 대상). */
export const COURSE_TAG_LIMIT = 12

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000

/** 공백을 하나로 줄이고 앞뒤를 자른 표시용 문자열(NFC). */
export function normalizeLabel(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim()
}

/**
 * 중복 판정용 키: NFKC, 소문자, 글자·숫자·`+`·`#` 밖의 문자(공백·구두점) 제거.
 * "운영 체제"와 "운영체제", "OS"와 "os"가 같은 키이고, "C++"와 "C"는 다른 키입니다.
 * 이 키끼리 같으면 같은 이름, pg_trgm 유사도가 높으면 비슷한 이름으로 봅니다.
 */
export function labelKey(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, '')
}

/** 과목 코드 비교 키(대문자, 공백·하이픈 제거). 빈 값이면 null. */
export function codeKey(code: string | null | undefined): string | null {
  if (!code) return null
  const key = code.normalize('NFKC').toUpperCase().replace(/[\s\-_.]+/g, '')
  return key || null
}

export type TagSlugResult = { ok: true; slug: string } | { ok: false; error: 'required' | 'too_long' }

/**
 * 개념 태그 slug: 소문자, 한국어 허용, 공백 → 하이픈, 글자·숫자·하이픈만 남기고 하이픈은 하나로, 앞뒤 하이픈 제거, 40자 이하.
 * 예: "  Process  Scheduling " → "process-scheduling", "교착 상태(Deadlock)" → "교착-상태deadlock".
 */
export function normalizeTagSlug(value: string): TagSlugResult {
  const slug = value
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!slug) return { ok: false, error: 'required' }
  if ([...slug].length > TAG_SLUG_MAX) return { ok: false, error: 'too_long' }
  return { ok: true, slug }
}

/** 서울 날짜 (y, m(1–12), d)의 하루 끝(23:59:59.999 KST). */
function seoulEndOfDay(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - SEOUL_OFFSET_MS)
}

/**
 * 개설 학기의 종료 시각(엠바고 기준, 서울 하루 끝).
 * 1학기(spring) 6/30, 여름 계절학기 8/31, 2학기(fall) 12/31, 겨울 계절학기(winter) 다음 해 2월 말일(윤년이면 29일).
 * 학교마다 실제 종강일은 다르지만 사용자가 정하게 하면 엠바고를 피해 갈 수 있으므로 서버가 넉넉하게 정합니다.
 * 학교 일정이 더 늦으면 운영자가 고칩니다(감사 기록).
 */
export function semesterEndsAt(year: number, semester: Semester): Date {
  switch (semester) {
    case 'spring':
      return seoulEndOfDay(year, 6, 30)
    case 'summer':
      return seoulEndOfDay(year, 8, 31)
    case 'fall':
      return seoulEndOfDay(year, 12, 31)
    case 'winter': {
      // 다음 해 3월 0일 = 2월 말일.
      const lastFeb = new Date(Date.UTC(year + 1, 2, 0)).getUTCDate()
      return seoulEndOfDay(year + 1, 2, lastFeb)
    }
  }
}

/** 학기 연도 허용 범위: 30년 전부터 내년까지(지난 과제 되짚기 포함). */
export function isAllowedTermYear(year: number, now: Date): boolean {
  const current = new Date(now.getTime() + SEOUL_OFFSET_MS).getUTCFullYear()
  return Number.isInteger(year) && year >= current - 30 && year <= current + 1
}

const maxDate = (dates: ReadonlyArray<Date | null | undefined>): Date | null => {
  let best: Date | null = null
  for (const d of dates) if (d && (!best || d.getTime() > best.getTime())) best = d
  return best
}

/**
 * 프로젝트 엠바고의 단조 규칙: 학기를 연결하거나 바꿀 때 새 값 = max(기존 값, 새로 걸리는 시각들).
 * 줄어드는 일은 없습니다(옛 학기로 바꿔 엠바고를 피하는 우회 방지). 낮추기는 운영자 조치(`lowerEmbargo`)로만 합니다.
 */
export function raiseEmbargo(existing: Date | null, ...candidates: ReadonlyArray<Date | null | undefined>): Date | null {
  return maxDate([existing, ...candidates])
}

export type LowerEmbargoResult = { ok: true; until: Date | null } | { ok: false; error: 'not_lower' }

/** 운영자의 엠바고 낮추기. 지금 값보다 낮거나(null 포함) 같아야 합니다. 올리기는 일반 규칙(raise)으로 합니다. */
export function lowerEmbargo(existing: Date | null, next: Date | null): LowerEmbargoResult {
  if (next && (!existing || next.getTime() > existing.getTime())) return { ok: false, error: 'not_lower' }
  return { ok: true, until: next }
}

export type EmbargoSource = 'course_term_end' | 'course_term_embargo' | 'project_embargo'

export interface EmbargoInputs {
  /**
   * projects.embargo_until: 연결했던 학기들의 종료 시각 최댓값(단조). 운영자가 학기 종료를 늘리면 연결된 프로젝트의 값도
   * 함께 올라가고, 운영자가 프로젝트별로 낮췄다면 그 값입니다.
   */
  projectEmbargoUntil: Date | null
  /** 지금 연결된 학기에 걸린 명시적 엠바고들의 until. */
  courseTermEmbargoes?: ReadonlyArray<Date>
  /** 이 프로젝트에 걸린 명시적 엠바고들의 until. */
  projectEmbargoes?: ReadonlyArray<Date>
}

export interface EffectiveEmbargo {
  until: Date | null
  active: boolean
  /** until을 정한 출처. 같은 시각이면 학기 종료 > 학기 엠바고 > 프로젝트 엠바고 순으로 표시합니다. */
  source: EmbargoSource | null
}

/**
 * 프로젝트에 적용되는 엠바고 = max(프로젝트 엠바고 값(학기 종료에서 옴), 지금 학기의 학기 엠바고들, 프로젝트 엠바고들).
 * active는 `isEmbargoActive`(now < until)와 같습니다. 끝났어도 자동 공개하지 않습니다(§9.2).
 */
export function computeEffectiveEmbargo(inputs: EmbargoInputs, now: Date): EffectiveEmbargo {
  const candidates: Array<{ at: Date; source: EmbargoSource }> = []
  if (inputs.projectEmbargoUntil) candidates.push({ at: inputs.projectEmbargoUntil, source: 'course_term_end' })
  for (const at of inputs.courseTermEmbargoes ?? []) candidates.push({ at, source: 'course_term_embargo' })
  for (const at of inputs.projectEmbargoes ?? []) candidates.push({ at, source: 'project_embargo' })

  let best: { at: Date; source: EmbargoSource } | null = null
  for (const c of candidates) if (!best || c.at.getTime() > best.at.getTime()) best = c
  if (!best) return { until: null, active: false, source: null }
  return { until: best.at, active: isEmbargoActive({ now, embargoUntil: best.at }), source: best.source }
}

export interface MergeNode {
  id: string
  mergedInto: string | null
  /** 과목 병합일 때만: 소속 학교(병합 반영 후). */
  schoolId?: string
}

export type MergeCheck =
  | { ok: true }
  | { ok: false; error: 'self' | 'source_merged' | 'target_merged' | 'different_school' }

/**
 * 병합 전제 조건. 대상은 병합되지 않은(정본) 행이어야 하고, 원본도 아직 병합되지 않아야 합니다.
 * 병합할 때 원본을 가리키던 행도 대상으로 다시 가리키게 하므로(평탄화) 사슬과 순환이 생기지 않습니다.
 * 과목은 같은 학교끼리만 병합합니다(다른 학교면 학교를 먼저 병합).
 */
export function checkMerge(source: MergeNode, target: MergeNode): MergeCheck {
  if (source.id === target.id) return { ok: false, error: 'self' }
  if (source.mergedInto) return { ok: false, error: 'source_merged' }
  if (target.mergedInto) return { ok: false, error: 'target_merged' }
  if (source.schoolId !== undefined && source.schoolId !== target.schoolId) return { ok: false, error: 'different_school' }
  return { ok: true }
}
