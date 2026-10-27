/**
 * 내 정보(비공개 DTO)·프로필 생성/수정·공개 프로필(공개 DTO).
 *
 * 공개 DTO는 허용 목록 방식으로 필드를 하나씩 골라 만듭니다. DB 행을 펼쳐(...row) 내보내지 않습니다.
 * private_email, 내부 user id, 계정 상태는 공개 DTO에 들어가지 않습니다.
 *
 * S-01(ADR 0028)부터 이 파일의 "프로필"은 **실명(real) 페르소나의 프로필**입니다. 프로필을 처음 만들면 같은 트랜잭션에서 real 페르소나를 만들고,
 * handle을 바꾸면 페르소나의 handle을 바꿉니다(profiles.handle은 외래 키 cascade로 따라옴). 표시명 페르소나는 social/personas.ts가 다룹니다.
 */
import { z } from 'zod'
import { and, eq, personas, profiles, users, type DbExecutor } from '@peerchive/db'
import { HANDLE_PATTERN, RESERVED_HANDLES, checkRealName } from '@peerchive/domain'
import { profileFields, profileInputSchema, toPublicProfileDto } from './profile-input'
import { recordAudit } from '../audit/audit'
import { isOperator } from '../catalog/operators'
import { type Actor, invalid, notFound, sqlState } from '../errors'
import { parseInput } from '../validation'
import { linkedPersonaFor, resolvePublicPersona } from '../social/personas'
import type { MeDto, ProfileFields, PublicProfileDto } from '../../../shared/types/api'

export type { MeDto, ProfileFields, PublicProfileDto }

/** handle 규칙은 두 종류 페르소나가 함께 씁니다(@peerchive/domain checkHandle). 기존 import 경로를 위해 다시 내보냅니다. */
export { HANDLE_PATTERN, RESERVED_HANDLES }
export { type ProfileInput, displayNameSchema, handleSchema, profileFields, profileFieldsSchema, profileInputSchema, toPublicProfileDto } from './profile-input'

export async function getMe(db: DbExecutor, actor: Actor): Promise<MeDto> {
  const [row] = await db
    .select({ user: users, profile: profiles })
    .from(users)
    // profiles.user_id는 실명 프로필에만 있으므로 이 조인은 real 페르소나의 프로필만 집습니다(ADR 0028).
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
    realName: row.user.realName,
  }
}

/**
 * PUT /me/real-name {realName: string | null} — 선택 실명(C-03, SYSTEM_DESIGN §6.7 "실명"). 신분 확인 없음. 실명 방식 커뮤니티 글·댓글의
 * 작성자 표시에만 쓰며 공개 프로필·검색·포트폴리오에는 나오지 않습니다. 빈 값·null은 지우기. 422 `realName: too_long|invalid`.
 * 감사에는 바뀌었는지(set/cleared)만 남기고 이름 글은 넣지 않습니다.
 */
export async function updateRealName(db: DbExecutor, actor: Actor, rawInput: unknown): Promise<MeDto> {
  const input = parseInput(z.object({ realName: z.unknown() }), rawInput)
  const checked = checkRealName(input.realName)
  if (!checked.ok) throw invalid({ realName: checked.reason })
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ realName: checked.value, updatedAt: new Date() })
      .where(and(eq(users.id, actor.userId), eq(users.status, 'active')))
      .returning({ id: users.id })
    if (updated.length === 0) throw notFound()
    await recordAudit(tx, { actorId: actor.userId, action: 'account.real_name_update', targetType: 'user', targetId: actor.userId, metadata: { set: checked.value !== null } })
  })
  return getMe(db, actor)
}

/**
 * 프로필(실명 페르소나)이 없으면 만들고(handle·displayName 필수), 있으면 보낸 필드만 바꿉니다.
 * - 처음 만들 때 real 페르소나를 같은 트랜잭션에서 만듭니다. 이미 있는 real 페르소나(판만 있던 사용자의 자리표시, migration 0026)는 handle을 고른 값으로 바꿔 씁니다.
 * - handle 변경은 personas.handle만 바꿉니다(profiles.handle은 외래 키 ON UPDATE CASCADE로 같은 문장에서 따라옴).
 * - handle은 표시명 페르소나와 같은 공간에서 유일합니다: 겹치면 422 `handle: taken`(어느 종류와 겹쳤는지 밝히지 않음).
 */
export async function upsertProfile(db: DbExecutor, actor: Actor, rawInput: unknown): Promise<MeDto> {
  const input = parseInput(profileInputSchema, rawInput)
  try {
    await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ displayName: users.displayName, hasProfile: profiles.personaId })
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
        ...(input.headline !== undefined && { headline: input.headline }),
        ...(input.jobTargets !== undefined && { jobTargets: input.jobTargets }),
        ...(input.schoolLabel !== undefined && { schoolLabel: input.schoolLabel }),
        ...(input.gradTerm !== undefined && { gradTerm: input.gradTerm }),
        ...(input.contactPolicy !== undefined && { contactPolicy: input.contactPolicy }),
        ...(input.openToWork !== undefined && { openToWork: input.openToWork }),
        ...(input.showAffiliationBadge !== undefined && { showAffiliationBadge: input.showAffiliationBadge }),
      }
      const [real] = await tx
        .select({ id: personas.id, handle: personas.handle })
        .from(personas)
        .where(and(eq(personas.userId, actor.userId), eq(personas.kind, 'real')))
        .limit(1)
      let personaId = real?.id
      if (!personaId) {
        const [created] = await tx
          .insert(personas)
          .values({ userId: actor.userId, kind: 'real', handle: input.handle! })
          .returning({ id: personas.id })
        personaId = created!.id
      } else if (input.handle !== undefined && input.handle !== real!.handle) {
        await tx.update(personas).set({ handle: input.handle, updatedAt: new Date() }).where(eq(personas.id, personaId))
      }
      if (!current.hasProfile) {
        await tx.insert(profiles).values({ personaId, personaKind: 'real', userId: actor.userId, handle: input.handle!, ...fields })
      } else if (Object.keys(fields).length > 0) {
        await tx
          .update(profiles)
          .set({ ...fields, updatedAt: new Date() })
          .where(eq(profiles.personaId, personaId))
      }
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw invalid({ handle: 'taken' })
    throw error
  }
  return getMe(db, actor)
}

/**
 * 활성 페르소나의 공개 프로필(실명·표시명 모두, S-01). 없거나 비활성이거나 운영 조치로 숨겼으면(T-15) 404.
 * 연결 플래그가 꺼져 있으면 상대 페르소나 정보가 없습니다(`linkedPersona: null`, canSeeIdentityLink).
 */
export async function getPublicProfile(db: DbExecutor, rawHandle: string): Promise<PublicProfileDto> {
  const found = await resolvePublicPersona(db, rawHandle)
  return {
    ...toPublicProfileDto({ displayName: found.displayName }, found.profile),
    kind: found.persona.kind,
    linkedPersona: await linkedPersonaFor(db, found.persona, { isOwner: false }),
  }
}
