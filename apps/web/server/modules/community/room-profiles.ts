/**
 * 동문회·OB 방의 방별 프로필·신분 배지·기수 이력 (A-01, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 RoomProfile, DELIVERY_PLAN §4.3, ADR 0038).
 *
 * - 모든 경로는 P2 `alumni` 플래그 뒤에 있습니다(requireFeature, 꺼져 있으면 404). 플래그가 꺼지면 이미 만든 alumni 방은 일반 방처럼 보이고
 *   (effectiveTemplate), 글·댓글에도 방별 이름·배지를 붙이지 않습니다.
 * - 방 멤버만(loadReadableSpace → canReadSpace, 아니면 404). 운영자도 멤버가 아니면 404. alumni 방이 아니면 404, 지금 효력이 있는 방식이
 *   익명이면 409 `room_profiles_unavailable`.
 * - 응답에는 사람 id·핸들·프로필 링크가 없습니다. 프로필은 방 안에서만 쓰는 `room_profiles.id`로 가리킵니다.
 * - real 방: 이름은 실명 고정(방별 이름 422 `name_fixed`). display 방: 방별 이름 필수. 계정 표시 이름(users.display_name)은 읽지 않습니다(ADR 0030).
 * - 기수: 본인 또는 방장·운영진(admin)이 바꾸고, 바뀔 때마다 이력을 남깁니다. 이력은 방장·운영진과 본인만(아니면 403).
 * - 방을 나가거나 내보내지면 같은 트랜잭션에서 그 사람의 방별 프로필과 기수 이력을 지웁니다(deleteRoomProfileInTx). 탈퇴는 worker purge.
 * - 이 모듈은 커뮤니티 모듈 안에 있고 social 모듈·공개 경로는 import하지 않습니다(S-02 경계 테스트가 확인).
 * - 감사 기록에는 id·종류·플래그만(이름·기수·소개 값 없음).
 */
import {
  REAL_NAME_MISSING_LABEL,
  ROOM_COHORT_LABEL_MAX,
  ROOM_PROFILE_NAME_MISSING_LABEL,
  type RoomStoredBadge,
  type SpaceTemplate,
  canEditMemberCohort,
  canViewCohortHistory,
  checkOneLine,
  checkRoomProfileInput,
  displayBadges,
  roomProfilesAvailable,
} from '@peerchive/domain'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  institutionAffiliations,
  roomProfileCohortChanges,
  roomProfiles,
  schools,
  spaceMemberships,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, invalid, notFound, rateLimited } from '../errors'
import { isFeatureOn, requireFeature } from '../features'
import { isUuid } from '../projects/access'
import { hitRateLimit } from '../security/rate-limit'
import { type LoadedSpace, type SpaceContext, loadReadableSpace, writeRestricted } from './access'
import { loadScheduledChange, nameModeNow } from './name-modes'
import type { RoomProfileCohortChangeDto, RoomProfileDto, RoomProfileTagDto, RoomProfilesDto } from '../../../shared/types/api'

type ProfileRow = typeof roomProfiles.$inferSelect

/** 방별 프로필 저장 한도(사용자·시간당 30번). */
export const ROOM_PROFILE_UPDATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 }

/** 플래그가 꺼져 있으면 alumni 방도 general로 봅니다(기존 방은 그대로 동작). */
export function effectiveTemplate(row: { template: SpaceTemplate }): SpaceTemplate {
  return row.template === 'alumni' && isFeatureOn('alumni') ? 'alumni' : 'general'
}

interface ProfileSpace {
  ctx: SpaceContext
  mode: 'real' | 'display'
}

/** 플래그 → 읽을 수 있는 공간(멤버) → alumni 템플릿 → 익명이 아닌 방. */
async function loadProfileSpace(db: DbExecutor, actor: Actor, ref: unknown, lock: boolean, now: Date): Promise<ProfileSpace> {
  requireFeature('alumni')
  const ctx = await loadReadableSpace(db, actor, ref, lock, now)
  if (ctx.space.row.template !== 'alumni') throw notFound()
  const { mode } = nameModeNow(ctx.space.row.currentNameMode, await loadScheduledChange(db, ctx.space.row.id), now)
  if (!roomProfilesAvailable(ctx.space.row.template, mode) || (mode !== 'real' && mode !== 'display')) throw conflict('room_profiles_unavailable')
  return { ctx, mode }
}

function assertWritable(ctx: SpaceContext): void {
  if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
  if (ctx.viewer.writeRestriction) throw writeRestricted(ctx.viewer.writeRestriction)
}

/** 학교를 연결한 방에서 그 학교 active 졸업생 인증이 있는 사람(졸업생 배지의 인증 표시). 학교 무관 방은 빈 집합. */
async function verifiedAlumni(db: DbExecutor, space: LoadedSpace, userIds: string[]): Promise<Set<string>> {
  if (!space.schoolId || userIds.length === 0) return new Set()
  const rows = await db
    .select({ userId: institutionAffiliations.userId })
    .from(institutionAffiliations)
    .innerJoin(schools, eq(schools.id, institutionAffiliations.schoolId))
    .where(
      and(
        inArray(institutionAffiliations.userId, userIds),
        eq(institutionAffiliations.status, 'active'),
        eq(institutionAffiliations.standing, 'alumni'),
        sql`coalesce(${schools.mergedInto}, ${schools.id}) = ${space.schoolId}`,
      ),
    )
  return new Set(rows.map((r) => r.userId))
}

function tagOf(row: Pick<ProfileRow, 'badges' | 'cohortLabel' | 'userId'>, verified: Set<string>): RoomProfileTagDto {
  const badges = displayBadges(row.badges, row.cohortLabel)
  return { badges, cohortLabel: row.cohortLabel, alumniVerified: badges.includes('alumni') && verified.has(row.userId) }
}

/** active 멤버의 방별 프로필(+ 실명 방이면 실명). */
async function loadProfiles(db: DbExecutor, spaceId: string, userIds?: string[]) {
  return db
    .select({ profile: roomProfiles, realName: users.realName })
    .from(roomProfiles)
    .innerJoin(spaceMemberships, and(eq(spaceMemberships.spaceId, roomProfiles.spaceId), eq(spaceMemberships.userId, roomProfiles.userId)))
    .innerJoin(users, eq(users.id, roomProfiles.userId))
    .where(
      and(
        eq(roomProfiles.spaceId, spaceId),
        eq(spaceMemberships.status, 'active'),
        eq(users.status, 'active'),
        userIds ? (userIds.length ? inArray(roomProfiles.userId, userIds) : sql`false`) : undefined,
      ),
    )
    .orderBy(asc(roomProfiles.cohortLabel), asc(roomProfiles.createdAt), asc(roomProfiles.id))
}

function nameOf(mode: 'real' | 'display', row: { profile: ProfileRow; realName: string | null }): string {
  if (mode === 'real') return row.realName?.trim() || REAL_NAME_MISSING_LABEL
  return row.profile.displayName ?? ROOM_PROFILE_NAME_MISSING_LABEL
}

function toDto(mode: 'real' | 'display', row: { profile: ProfileRow; realName: string | null }, viewerId: string, verified: Set<string>): RoomProfileDto {
  return {
    id: row.profile.id,
    name: nameOf(mode, row),
    ...tagOf(row.profile, verified),
    bio: row.profile.bio,
    mine: row.profile.userId === viewerId,
    updatedAt: row.profile.updatedAt.toISOString(),
  }
}

/** GET /community/spaces/:slug/room-profiles — 방 멤버만. 내 프로필(편집용 값 포함)과 active 멤버의 프로필 목록. */
export async function listRoomProfiles(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<RoomProfilesDto> {
  const { ctx, mode } = await loadProfileSpace(db, actor, ref, false, now)
  const rows = await loadProfiles(db, ctx.space.row.id)
  const verified = await verifiedAlumni(db, ctx.space, rows.map((r) => r.profile.userId))
  const profiles = rows.map((r) => toDto(mode, r, actor.userId, verified))
  const mineRow = rows.find((r) => r.profile.userId === actor.userId)
  return {
    nameMode: mode,
    canEditCohort: ctx.space.row.status === 'active' && canEditMemberCohort(ctx.membership?.role),
    writable: ctx.space.row.status === 'active',
    mine: mineRow
      ? { ...toDto(mode, mineRow, actor.userId, verified), displayName: mineRow.profile.displayName, storedBadges: mineRow.profile.badges as RoomStoredBadge[] }
      : null,
    profiles,
  }
}

async function recordCohortChange(tx: DbExecutor, spaceId: string, subjectUserId: string, changedBy: string, from: string | null, to: string | null, now: Date) {
  if (from === to) return false
  await tx.insert(roomProfileCohortChanges).values({ spaceId, subjectUserId, changedBy, fromLabel: from, toLabel: to, createdAt: now })
  return true
}

/**
 * PUT /community/spaces/:slug/room-profile {displayName?, badges?, cohortLabel?, bio?} — 내 방별 프로필 만들기·바꾸기(전체 교체).
 * 409 `space_not_active`·`room_profiles_unavailable`, 403 `write_restricted`, 422(`displayName: required|name_fixed|too_long|invalid`,
 * `badges: invalid|conflict`, `cohortLabel`, `bio`), 429.
 */
export async function putMyRoomProfile(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<RoomProfilesDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  const slug = await db.transaction(async (tx) => {
    const { ctx, mode } = await loadProfileSpace(tx, actor, ref, true, now)
    assertWritable(ctx)
    const checked = checkRoomProfileInput(raw, mode)
    if (!checked.ok) throw invalid(checked.fields)
    if (!(await hitRateLimit(tx, 'room_profile_update', actor.userId, ROOM_PROFILE_UPDATE_LIMIT, now))) throw rateLimited()
    const v = checked.value
    const [existing] = await tx
      .select()
      .from(roomProfiles)
      .where(and(eq(roomProfiles.spaceId, ctx.space.row.id), eq(roomProfiles.userId, actor.userId)))
      .limit(1)
      .for('update')
    // real 방에서 저장해도 display 방에서 정한 방별 이름은 지우지 않습니다(방식이 다시 바뀌면 그대로 씀). 실명 방에서는 읽지 않습니다.
    const displayName = mode === 'real' ? (existing?.displayName ?? null) : v.displayName
    if (existing) {
      await tx
        .update(roomProfiles)
        .set({ displayName, badges: v.badges, cohortLabel: v.cohortLabel, bio: v.bio, updatedAt: now })
        .where(eq(roomProfiles.id, existing.id))
    } else {
      await tx.insert(roomProfiles).values({ spaceId: ctx.space.row.id, userId: actor.userId, displayName, badges: v.badges, cohortLabel: v.cohortLabel, bio: v.bio, createdAt: now, updatedAt: now })
    }
    const cohortChanged = await recordCohortChange(tx, ctx.space.row.id, actor.userId, actor.userId, existing?.cohortLabel ?? null, v.cohortLabel, now)
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.room_profile_update',
      targetType: 'community_space',
      targetId: ctx.space.row.id,
      metadata: { created: !existing, cohortChanged, badges: v.badges.length },
    })
    return ctx.space.row.slug
  })
  return listRoomProfiles(db, actor, slug, now)
}

/** DELETE /community/spaces/:slug/room-profile — 내 방별 프로필과 내 기수 이력을 지웁니다. 없으면 그대로(멱등). 보관된 방에서도 지울 수 있습니다. */
export async function deleteMyRoomProfile(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<RoomProfilesDto> {
  const slug = await db.transaction(async (tx) => {
    requireFeature('alumni')
    const ctx = await loadReadableSpace(tx, actor, ref, true, now)
    if (ctx.space.row.template !== 'alumni') throw notFound()
    const removed = await deleteRoomProfileInTx(tx, ctx.space.row.id, actor.userId)
    if (removed) await recordAudit(tx, { actorId: actor.userId, action: 'community.room_profile_delete', targetType: 'community_space', targetId: ctx.space.row.id, metadata: { cause: 'self' } })
    return ctx.space.row.slug
  })
  return listRoomProfiles(db, actor, slug, now)
}

async function loadTargetProfile(db: DbExecutor, spaceId: string, profileId: unknown, lock: boolean): Promise<ProfileRow> {
  if (!isUuid(profileId)) throw notFound()
  const query = db
    .select()
    .from(roomProfiles)
    .where(and(eq(roomProfiles.id, profileId.toLowerCase()), eq(roomProfiles.spaceId, spaceId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  // 나간 사람의 프로필은 지워지지만, 혹시 남아 있어도 active 멤버가 아니면 없는 것으로 봅니다.
  const [m] = await db
    .select({ status: spaceMemberships.status })
    .from(spaceMemberships)
    .where(and(eq(spaceMemberships.spaceId, spaceId), eq(spaceMemberships.userId, row.userId)))
    .limit(1)
  if (m?.status !== 'active') throw notFound()
  return row
}

/**
 * PUT /community/spaces/:slug/room-profiles/:id/cohort {cohortLabel} — 방장·운영진이 멤버의 기수를 고칩니다(null이면 비움). 이력을 남깁니다.
 * 방 멤버가 아니면 404, 방장·운영진이 아니면 403, 다른 방의 프로필이면 404.
 */
export async function setMemberCohort(db: DbExecutor, actor: Actor, ref: unknown, profileId: unknown, rawInput: unknown, now = new Date()): Promise<RoomProfileDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const { ctx, mode } = await loadProfileSpace(tx, actor, ref, true, now)
    if (ctx.space.row.status !== 'active') throw conflict('space_not_active', { status: ctx.space.row.status })
    if (!canEditMemberCohort(ctx.membership?.role)) throw forbidden()
    if (!('cohortLabel' in raw)) throw invalid({ cohortLabel: 'required' })
    const cohort = checkOneLine(raw.cohortLabel, ROOM_COHORT_LABEL_MAX)
    if (!cohort.ok) throw invalid({ cohortLabel: cohort.reason })
    const target = await loadTargetProfile(tx, ctx.space.row.id, profileId, true)
    const changed = await recordCohortChange(tx, ctx.space.row.id, target.userId, actor.userId, target.cohortLabel, cohort.value, now)
    if (changed) {
      await tx.update(roomProfiles).set({ cohortLabel: cohort.value, updatedAt: now }).where(eq(roomProfiles.id, target.id))
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'community.room_profile_cohort_edit',
        targetType: 'community_space',
        targetId: ctx.space.row.id,
        metadata: { profileId: target.id, self: target.userId === actor.userId, cleared: cohort.value === null },
      })
    }
    const [row] = await loadProfiles(tx, ctx.space.row.id, [target.userId])
    return toDto(mode, row!, actor.userId, await verifiedAlumni(tx, ctx.space, [target.userId]))
  })
}

/** GET /community/spaces/:slug/room-profiles/:id/cohort-history — 방장·운영진과 본인만(아니면 403). 최근 것부터 최대 50개. */
export async function listCohortHistory(db: DbExecutor, actor: Actor, ref: unknown, profileId: unknown, now = new Date()): Promise<RoomProfileCohortChangeDto[]> {
  const { ctx, mode } = await loadProfileSpace(db, actor, ref, false, now)
  const target = await loadTargetProfile(db, ctx.space.row.id, profileId, false)
  if (!canViewCohortHistory(ctx.membership?.role, target.userId === actor.userId)) throw forbidden()
  const rows = await db
    .select()
    .from(roomProfileCohortChanges)
    .where(and(eq(roomProfileCohortChanges.spaceId, ctx.space.row.id), eq(roomProfileCohortChanges.subjectUserId, target.userId)))
    .orderBy(desc(roomProfileCohortChanges.createdAt), desc(roomProfileCohortChanges.id))
    .limit(50)
  const changerIds = [...new Set(rows.map((r) => r.changedBy).filter((id): id is string => !!id))]
  const changers = new Map((await loadProfiles(db, ctx.space.row.id, changerIds)).map((r) => [r.profile.userId, nameOf(mode, r)]))
  return rows.map((r) => ({
    id: r.id,
    fromLabel: r.fromLabel,
    toLabel: r.toLabel,
    changedBy: r.changedBy === null ? 'unknown' : r.changedBy === target.userId ? 'subject' : 'manager',
    changedByName: r.changedBy ? (changers.get(r.changedBy) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
  }))
}

/** 방을 나가거나 내보내질 때(같은 트랜잭션): 그 사람의 방별 프로필과 그 사람에 대한 기수 이력을 지웁니다. 지운 프로필이 있으면 true. */
export async function deleteRoomProfileInTx(tx: DbExecutor, spaceId: string, userId: string): Promise<boolean> {
  await tx.delete(roomProfileCohortChanges).where(and(eq(roomProfileCohortChanges.spaceId, spaceId), eq(roomProfileCohortChanges.subjectUserId, userId)))
  const removed = await tx
    .delete(roomProfiles)
    .where(and(eq(roomProfiles.spaceId, spaceId), eq(roomProfiles.userId, userId)))
    .returning({ id: roomProfiles.id })
  return removed.length > 0
}

/** 글·댓글 작성자 표시용(posts.ts): 방 안에서만 쓰는 방별 이름·배지. 플래그가 꺼졌거나 alumni 방이 아니거나 지금 익명 방이면 빈 Map. */
export interface RoomAuthorProfile {
  displayName: string | null
  tag: RoomProfileTagDto
}

export async function roomAuthorProfiles(db: DbExecutor, space: LoadedSpace, userIds: string[], now: Date): Promise<Map<string, RoomAuthorProfile>> {
  if (userIds.length === 0 || effectiveTemplate(space.row) !== 'alumni') return new Map()
  const { mode } = nameModeNow(space.row.currentNameMode, await loadScheduledChange(db, space.row.id), now)
  if (!roomProfilesAvailable('alumni', mode)) return new Map()
  const rows = await loadProfiles(db, space.row.id, [...new Set(userIds)])
  const verified = await verifiedAlumni(db, space, rows.map((r) => r.profile.userId))
  return new Map(rows.map((r) => [r.profile.userId, { displayName: r.profile.displayName, tag: tagOf(r.profile, verified) }]))
}
