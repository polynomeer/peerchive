/**
 * 프로필 입력 검증·DTO 변환(T-02, S-01부터 실명·표시명 페르소나 공통). identity/profiles.ts와 social/personas.ts가 함께 씁니다
 * (두 모듈이 서로를 import하지 않도록 따로 둡니다).
 *
 * 공개 DTO는 허용 목록 방식으로 필드를 하나씩 골라 만듭니다. DB 행을 펼쳐(...row) 내보내지 않습니다.
 */
import { z } from 'zod'
import type { profiles } from '@peerchive/db'
import { HANDLE_PATTERN, RESERVED_HANDLES } from '@peerchive/domain'
import type { ProfileFields, PublicProfileDto } from '../../../shared/types/api'

/**
 * 비울 수 있는 선택 글. 빈 글·null은 null(지우기), **키가 없으면 undefined**(바꾸지 않음). 바깥 optional이라 키가 없을 때 transform이 돌지 않습니다
 * (S-01 전에는 transform이 바깥에 있어 보내지 않은 한 줄 소개·학교·졸업 시기가 부분 수정 때 지워졌습니다).
 */
const optionalText = (max: number) =>
  z
    .string({ error: 'invalid' })
    .trim()
    .max(max, { error: 'too_long' })
    .nullable()
    .transform((value) => (value ? value : null))
    .optional()

/** handle 입력(정규화 + 3~30자·형식·예약어). 실명·표시명 페르소나가 같은 규칙을 씁니다. */
export const handleSchema = z
  .string({ error: 'invalid' })
  .trim()
  .toLowerCase()
  .min(3, { error: 'too_short' })
  .max(30, { error: 'too_long' })
  .regex(HANDLE_PATTERN, { error: 'invalid_format' })
  .refine((value) => !RESERVED_HANDLES.has(value), { error: 'reserved' })

export const displayNameSchema = z.string({ error: 'invalid' }).trim().min(1, { error: 'required' }).max(50, { error: 'too_long' })

/** 페르소나마다 따로인 프로필 필드(handle·이름 제외). 표시명 페르소나 입력도 이 모양을 씁니다. */
export const profileFieldsSchema = z.object({
  headline: optionalText(120),
  jobTargets: z
    .array(z.string({ error: 'invalid' }).trim().min(1, { error: 'required' }).max(40, { error: 'too_long' }), {
      error: 'invalid',
    })
    .max(10, { error: 'too_many' })
    .optional(),
  schoolLabel: optionalText(80),
  /** 졸업(예정) 시기 YYYY-MM. */
  gradTerm: z
    .string({ error: 'invalid' })
    .trim()
    .regex(/^(\d{4}-(0[1-9]|1[0-2]))?$/, { error: 'invalid_format' })
    .nullable()
    .transform((value) => (value ? value : null))
    .optional(),
  contactPolicy: z.enum(['closed', 'on_request', 'open'], { error: 'invalid' }).optional(),
  openToWork: z.boolean({ error: 'invalid' }).optional(),
  /** 공개 프로필에 학교 인증 배지를 보일지(C-01, 기본 false). */
  showAffiliationBadge: z.boolean({ error: 'invalid' }).optional(),
})

export const profileInputSchema = profileFieldsSchema.extend({
  handle: handleSchema.optional(),
  displayName: displayNameSchema.optional(),
})
export type ProfileInput = z.input<typeof profileInputSchema>
type ProfileRow = typeof profiles.$inferSelect

export function profileFields(row: ProfileRow): ProfileFields {
  return {
    handle: row.handle,
    headline: row.headline,
    jobTargets: [...row.jobTargets],
    schoolLabel: row.schoolLabel,
    gradTerm: row.gradTerm,
    contactPolicy: row.contactPolicy,
    openToWork: row.openToWork,
    showAffiliationBadge: row.showAffiliationBadge,
  }
}

/** 허용 목록 변환. 필드를 추가할 때는 공개해도 되는지 먼저 확인하세요. */
export function toPublicProfileDto(user: { displayName: string }, row: ProfileRow): Omit<PublicProfileDto, 'kind' | 'linkedPersona'> {
  return {
    handle: row.handle,
    displayName: user.displayName,
    headline: row.headline,
    jobTargets: [...row.jobTargets],
    schoolLabel: row.schoolLabel,
    gradTerm: row.gradTerm,
    contactPolicy: row.contactPolicy,
    openToWork: row.openToWork,
  }
}
