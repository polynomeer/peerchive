/**
 * 내 정보(비공개 DTO)·프로필 생성/수정·공개 프로필(공개 DTO).
 *
 * 공개 DTO는 허용 목록 방식으로 필드를 하나씩 골라 만듭니다. DB 행을 펼쳐(...row) 내보내지 않습니다.
 * private_email, 내부 user id, 계정 상태는 공개 DTO에 들어가지 않습니다.
 */
import { z } from 'zod'
import { and, eq, isNull, profiles, users, type DbExecutor } from '@peerchive/db'
import { isOperator } from '../catalog/operators'
import { type Actor, invalid, notFound, sqlState } from '../errors'
import { parseInput } from '../validation'
import type { MeDto, ProfileFields, PublicProfileDto } from '../../../shared/types/api'

export type { MeDto, ProfileFields, PublicProfileDto }

/** URL 경로·운영 용어와 겹치는 handle. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'app', 'assets', 'auth', 'courses',
  'edit', 'health', 'help', 'invitations', 'invite', 'login', 'logout', 'me', 'new', 'null', 'onboarding',
  'peerchive', 'profile', 'profiles', 'project', 'projects', 'proofu', 'root', 'schools', 'search',
  'settings', 'signup', 'static', 'support', 'system', 'u', 'undefined', 'user', 'users', 'www',
])

export const HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const optionalText = (max: number) =>
  z
    .string({ error: 'invalid' })
    .trim()
    .max(max, { error: 'too_long' })
    .nullish()
    .transform((value) => (value ? value : null))

export const profileInputSchema = z.object({
  handle: z
    .string({ error: 'invalid' })
    .trim()
    .toLowerCase()
    .min(3, { error: 'too_short' })
    .max(30, { error: 'too_long' })
    .regex(HANDLE_PATTERN, { error: 'invalid_format' })
    .refine((value) => !RESERVED_HANDLES.has(value), { error: 'reserved' })
    .optional(),
  displayName: z
    .string({ error: 'invalid' })
    .trim()
    .min(1, { error: 'required' })
    .max(50, { error: 'too_long' })
    .optional(),
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
    .nullish()
    .transform((value) => (value ? value : null)),
  contactPolicy: z.enum(['closed', 'on_request', 'open'], { error: 'invalid' }).optional(),
  openToWork: z.boolean({ error: 'invalid' }).optional(),
})
export type ProfileInput = z.input<typeof profileInputSchema>
/** 누구에게나 주는 공개 프로필 DTO. */
type ProfileRow = typeof profiles.$inferSelect

function profileFields(row: ProfileRow): ProfileFields {
  return {
    handle: row.handle,
    headline: row.headline,
    jobTargets: [...row.jobTargets],
    schoolLabel: row.schoolLabel,
    gradTerm: row.gradTerm,
    contactPolicy: row.contactPolicy,
    openToWork: row.openToWork,
  }
}

/** 허용 목록 변환. 필드를 추가할 때는 공개해도 되는지 먼저 확인하세요. */
export function toPublicProfileDto(user: { displayName: string }, row: ProfileRow): PublicProfileDto {
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

export async function getMe(db: DbExecutor, actor: Actor): Promise<MeDto> {
  const [row] = await db
    .select({ user: users, profile: profiles })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(eq(users.id, actor.userId), eq(users.status, 'active')))
    .limit(1)
  if (!row) throw notFound()
  return {
    id: row.user.id,
    email: row.user.privateEmail,
    displayName: row.user.displayName,
    createdAt: row.user.createdAt.toISOString(),
    profile: row.profile ? profileFields(row.profile) : null,
    operator: await isOperator(db, row.user.id),
    profileHidden: row.profile?.hiddenAt != null,
    analyticsOptOut: row.user.analyticsOptOut,
  }
}

/** 프로필이 없으면 만들고(handle·displayName 필수), 있으면 보낸 필드만 바꿉니다. */
export async function upsertProfile(db: DbExecutor, actor: Actor, rawInput: unknown): Promise<MeDto> {
  const input = parseInput(profileInputSchema, rawInput)
  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ displayName: users.displayName, hasProfile: profiles.userId })
        .from(users)
        .leftJoin(profiles, eq(profiles.userId, users.id))
        .where(and(eq(users.id, actor.userId), eq(users.status, 'active')))
        .for('update', { of: users })
        .limit(1)
      if (!current) throw notFound()

      if (!current.hasProfile) {
        const missing: Record<string, string> = {}
        if (!input.handle) missing.handle = 'required'
        if (!input.displayName && !current.displayName) missing.displayName = 'required'
        if (Object.keys(missing).length > 0) throw invalid(missing)
      }

      if (input.displayName !== undefined) {
        await tx
          .update(users)
          .set({ displayName: input.displayName, updatedAt: new Date() })
          .where(eq(users.id, actor.userId))
      }

      const fields = {
        ...(input.handle !== undefined && { handle: input.handle }),
        ...(input.headline !== undefined && { headline: input.headline }),
        ...(input.jobTargets !== undefined && { jobTargets: input.jobTargets }),
        ...(input.schoolLabel !== undefined && { schoolLabel: input.schoolLabel }),
        ...(input.gradTerm !== undefined && { gradTerm: input.gradTerm }),
        ...(input.contactPolicy !== undefined && { contactPolicy: input.contactPolicy }),
        ...(input.openToWork !== undefined && { openToWork: input.openToWork }),
      }
      if (!current.hasProfile) {
        await tx.insert(profiles).values({ userId: actor.userId, handle: input.handle!, ...fields })
      } else if (Object.keys(fields).length > 0) {
        await tx
          .update(profiles)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(profiles.userId, actor.userId))
      }
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw invalid({ handle: 'taken' })
    throw error
  }
  return getMe(db, actor)
}

/** 활성 사용자의 공개 프로필. 없거나 비활성이거나 운영 조치로 숨겼으면(T-15) 404. */
export async function getPublicProfile(db: DbExecutor, rawHandle: string): Promise<PublicProfileDto> {
  const handle = rawHandle.trim().toLowerCase()
  if (!HANDLE_PATTERN.test(handle) || handle.length > 30) throw notFound()
  const [row] = await db
    .select({ displayName: users.displayName, profile: profiles })
    .from(profiles)
    .innerJoin(users, eq(users.id, profiles.userId))
    .where(and(eq(profiles.handle, handle), eq(users.status, 'active'), isNull(profiles.hiddenAt)))
    .limit(1)
  if (!row) throw notFound()
  return toPublicProfileDto(row, row.profile)
}
