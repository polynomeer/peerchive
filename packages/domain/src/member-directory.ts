/**
 * 동문회·OB 방의 멤버 명부 동의 (A-03, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 DirectoryEntry·§8.4, DELIVERY_PLAN §4.3·§5.3 X, ADR 0040).
 *
 * - **동의한 멤버만 행이 있습니다.** 행을 만드는 요청 자체가 동의이고, 요청마다 `consent: true`를 명시해야 합니다(빠지면 422).
 * - 항목(기수·지금 하는 일·관심사·연락 방법)은 모두 선택이고 각각 비울 수 있습니다. 모두 비워도 “명부에 이름만 올림”으로 유효합니다.
 * - 연락 방법은 자유 글(한 줄, 길이 제한)이며 **방 멤버 모두에게 보입니다**(화면이 경고). 형식을 검사하지 않습니다.
 * - 이름은 방별 프로필 규칙(A-01)을 따릅니다: 실명 방은 실명, 표시명 방은 방별 이름. **익명 방에는 명부가 없습니다**(이름 없는 명부는 쓸모가
 *   없고, 소규모 방에서 기수·관심사·연락 방법만으로 익명이 깨지기 때문).
 * - 조회는 쪽 단위(최대 `DIRECTORY_PAGE_SIZE`개)만 있고 “전부 가져오기”·내보내기는 없습니다. 쪽 크기를 넘기거나 모르는 조회 값을 보내면 422.
 *
 * 런타임 의존성 없음.
 */
import type { NameMode } from './community'
import { ROOM_COHORT_LABEL_MAX, type SpaceTemplate, checkOneLine } from './room-profiles'

export const DIRECTORY_COHORT_LABEL_MAX = ROOM_COHORT_LABEL_MAX
export const DIRECTORY_CURRENT_WORK_MAX = 60
export const DIRECTORY_INTEREST_MAX = 20
export const DIRECTORY_INTERESTS_MAX = 5
export const DIRECTORY_CONTACT_METHOD_MAX = 100
/** 한 쪽의 최대(기본) 항목 수. 더 큰 쪽 크기는 422 `too_large`. */
export const DIRECTORY_PAGE_SIZE = 20
/** 쪽 번호 상한(오프셋이 끝없이 커지지 않게). */
export const DIRECTORY_MAX_PAGE = 500

/** 명부를 쓰는 방인지: alumni 템플릿이고 지금 효력이 있는 이름 표시 방식이 익명이 아님. */
export function directoryAvailable(template: SpaceTemplate, effectiveMode: NameMode): boolean {
  return template === 'alumni' && (effectiveMode === 'real' || effectiveMode === 'display')
}

export interface DirectoryEntryValue {
  cohortLabel: string | null
  currentWork: string | null
  interests: string[]
  contactMethod: string | null
}

export type DirectoryEntryCheck = { ok: true; value: DirectoryEntryValue } | { ok: false; fields: Record<string, string> }

/**
 * 명부 항목 입력 검사(전체 교체). `consent`는 `true`여야 합니다(`required`).
 * - cohortLabel·currentWork·contactMethod: 한 줄 글(빈 값·null은 비움), `invalid|too_long`.
 * - interests: 문자열 배열(null·없음은 빈 배열), 각 한 줄 1~20자, 최대 5개, 같은 값(대소문자 무시) 하나로. 형식이 틀리면 `invalid`, 많으면 `too_many`,
 *   긴 값이 있으면 `too_long`.
 */
export function checkDirectoryEntryInput(raw: { consent?: unknown; cohortLabel?: unknown; currentWork?: unknown; interests?: unknown; contactMethod?: unknown }): DirectoryEntryCheck {
  const fields: Record<string, string> = {}
  if (raw.consent !== true) fields.consent = 'required'
  const cohort = checkOneLine(raw.cohortLabel, DIRECTORY_COHORT_LABEL_MAX)
  if (!cohort.ok) fields.cohortLabel = cohort.reason
  const work = checkOneLine(raw.currentWork, DIRECTORY_CURRENT_WORK_MAX)
  if (!work.ok) fields.currentWork = work.reason
  const contact = checkOneLine(raw.contactMethod, DIRECTORY_CONTACT_METHOD_MAX)
  if (!contact.ok) fields.contactMethod = contact.reason
  const interests: string[] = []
  if (raw.interests !== undefined && raw.interests !== null) {
    if (!Array.isArray(raw.interests)) fields.interests = 'invalid'
    else {
      const seen = new Set<string>()
      for (const item of raw.interests) {
        const one = checkOneLine(item, DIRECTORY_INTEREST_MAX)
        if (!one.ok) {
          fields.interests = one.reason
          break
        }
        if (one.value === null) continue
        const key = one.value.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        interests.push(one.value)
      }
      if (!fields.interests && interests.length > DIRECTORY_INTERESTS_MAX) fields.interests = 'too_many'
    }
  }
  if (Object.keys(fields).length || !cohort.ok || !work.ok || !contact.ok) return { ok: false, fields }
  return { ok: true, value: { cohortLabel: cohort.value, currentWork: work.value, interests, contactMethod: contact.value } }
}

/** 비우지 않은 항목 수(감사 기록용 — 값은 남기지 않음). */
export function filledDirectoryFields(v: DirectoryEntryValue): number {
  return [v.cohortLabel, v.currentWork, v.contactMethod].filter((x) => x !== null).length + (v.interests.length ? 1 : 0)
}

export type DirectoryQueryCheck = { ok: true; page: number; pageSize: number } | { ok: false; fields: Record<string, string> }

const POSITIVE_INT = /^[1-9][0-9]{0,5}$/

/**
 * 명부 조회 값: `page`(1부터, 기본 1, 최대 `DIRECTORY_MAX_PAGE`)와 `pageSize`(1~20, 기본 20)만 받습니다.
 * 20을 넘는 쪽 크기는 `too_large`, 그 밖의 값(`all`·`limit`·`format` 등)은 `unknown`으로 422 — “전부 가져오기”나 다른 형식이 없음을 분명히 합니다.
 */
export function parseDirectoryQuery(query: Record<string, unknown> | null | undefined): DirectoryQueryCheck {
  const q = query ?? {}
  const fields: Record<string, string> = {}
  for (const key of Object.keys(q)) if (key !== 'page' && key !== 'pageSize') fields[key] = 'unknown'
  const one = (v: unknown) => (Array.isArray(v) ? null : v === undefined ? undefined : typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null)
  let page = 1
  const rawPage = one(q.page)
  if (rawPage !== undefined) {
    if (rawPage === null || !POSITIVE_INT.test(rawPage)) fields.page = 'invalid'
    else if (Number(rawPage) > DIRECTORY_MAX_PAGE) fields.page = 'too_large'
    else page = Number(rawPage)
  }
  let pageSize = DIRECTORY_PAGE_SIZE
  const rawSize = one(q.pageSize)
  if (rawSize !== undefined) {
    if (rawSize === null || !POSITIVE_INT.test(rawSize)) fields.pageSize = 'invalid'
    else if (Number(rawSize) > DIRECTORY_PAGE_SIZE) fields.pageSize = 'too_large'
    else pageSize = Number(rawSize)
  }
  if (Object.keys(fields).length) return { ok: false, fields }
  return { ok: true, page, pageSize }
}
