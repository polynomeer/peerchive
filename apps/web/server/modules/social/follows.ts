/**
 * 팔로우·비공개 계정 (S-04, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 Follow·§8.3·§9.2, DELIVERY_PLAN §4.2 S-04·§5.2 T·R, ADR 0033).
 *
 * social 모듈입니다: 커뮤니티 글 테이블·커뮤니티 모듈을 import하지 않습니다(S-02 경계 테스트). 읽는 표(follows·blocks·personas·profiles·users의
 * 공개 열)는 social DB 역할에 준 것뿐입니다(migration 0029).
 *
 * - **페르소나 → 페르소나**: 팔로우 주체 페르소나는 요청자가 고릅니다(`as`). 같은 사용자의 페르소나끼리는 409 `own_persona`(DB check도 막음).
 *   판정은 @peerchive/domain `decideFollow`(= `canFollow`)가 합니다. 비로그인은 라우트가 401.
 * - 공개 계정은 바로 active, 비공개 계정은 pending → 주인이 승인. 비공개 → 공개 전환은 대기 요청을 자동 승인하지 않습니다
 *   (`POST /personas/:id/follow-requests {action}`으로 모두 승인·모두 거절, 아무것도 안 하면 그대로).
 * - 거절·팔로워 삭제·언팔로우는 행 삭제입니다. **어떤 알림·outbox·감사 행도 만들지 않습니다**(상대에게 알리지 않음, 일상 팔로우는 감사 대상 아님).
 * - **목록**은 페르소나의 handle·이름·종류만 싣습니다. 연결(identity_links)을 읽지 않으므로 표시명으로 팔로우하면 표시명만 보입니다. 공개 상태가
 *   아닌 페르소나(비활성·계정 비활성·운영 숨김)와, **보는 사람에게 차단으로 숨겨진 페르소나**는 목록에서 뺍니다.
 * - 팔로워 수는 `show_follower_count`가 켜졌을 때만(본인은 늘) 키가 있습니다. 끄면 공개 응답에 키 자체가 없습니다.
 * - 남의 페르소나·남의 요청·없는 id는 404입니다. 차단당한 사용자에게는 그 페르소나의 프로필·목록·관계 정보가 모두 404입니다.
 */
import { z } from 'zod'
import { and, asc, blocks, desc, eq, follows, inArray, mutes, personas, profiles, sql, users, type DbExecutor, type SQL } from '@peerchive/db'
import { FOLLOW_RATE_LIMIT, type FollowStatus, canViewPersona, decideFollow, showsFollowCounts } from '@peerchive/domain'
import { type Actor, conflict, invalid, notFound, rateLimited, sqlState } from '../errors'
import { emitSocialAnalytics } from '../analytics/analytics'
import { hitRateLimit } from '../security/rate-limit'
import { personaDisplayName, resolvePublicPersona } from './personas'
import { counterpartVisible, notHiddenFrom } from './relations'
import { canViewItem, personaViewerFor } from './visibility'
import type {
  FollowCountsDto,
  FollowListDto,
  FollowPersonaDto,
  FollowResultDto,
  MyFollowEntryDto,
  MyFollowsDto,
  ProfileSocialDto,
  ViewerPersonaRelationDto,
} from '../../../shared/types/api'

type PersonaRow = typeof personas.$inferSelect


type Direction = 'followers' | 'following'

interface EntryRow {
  id: string
  kind: PersonaRow['kind']
  handle: string
  personaDisplayName: string | null
  accountName: string
  at: Date
}

/**
 * 한 페르소나의 팔로우 행과 상대 페르소나. followers면 상대 = 팔로우하는 쪽, following이면 받는 쪽. 상대는 공개 상태이고 보는 사람에게 숨겨지지
 * 않은 것만. 페르소나 행의 handle·이름·종류만 읽습니다(연결·같은 사용자의 다른 페르소나는 읽지 않음).
 */
async function followEntries(db: DbExecutor, personaId: string, direction: Direction, status: FollowStatus, viewerUserId: string | null): Promise<EntryRow[]> {
  const mine = direction === 'followers' ? follows.followeePersonaId : follows.followerPersonaId
  const other = direction === 'followers' ? follows.followerPersonaId : follows.followeePersonaId
  const otherUser = direction === 'followers' ? follows.followerUserId : follows.followeeUserId
  const at = status === 'active' ? sql<Date>`coalesce(${follows.approvedAt}, ${follows.createdAt})` : sql<Date>`${follows.createdAt}`
  return db
    .select({
      id: follows.id,
      kind: personas.kind,
      handle: personas.handle,
      personaDisplayName: personas.displayName,
      accountName: users.displayName,
      at: sql<Date>`${at}`.mapWith((v: string | Date) => (v instanceof Date ? v : new Date(v))),
    })
    .from(follows)
    .innerJoin(personas, eq(personas.id, other))
    .innerJoin(users, eq(users.id, personas.userId))
    .innerJoin(profiles, eq(profiles.personaId, personas.id))
    .where(and(eq(mine, personaId), eq(follows.status, status), counterpartVisible(), notHiddenFrom(other, otherUser, viewerUserId)))
    .orderBy(desc(at), asc(personas.handle))
    .limit(500)
}

const toPersonaDto = (r: EntryRow): FollowPersonaDto => ({
  kind: r.kind,
  handle: r.handle,
  displayName: personaDisplayName({ kind: r.kind, displayName: r.personaDisplayName }, r.accountName),
})
const toEntryDto = (r: EntryRow): MyFollowEntryDto => ({ id: r.id, ...toPersonaDto(r), at: r.at.toISOString() })

// ── 개수 ─────────────────────────────────────────────────────────────────

/** active 팔로워·팔로잉 수(상대가 공개 상태인 것만). 보는 사람과 무관합니다. */
export async function followCounts(db: DbExecutor, personaId: string): Promise<FollowCountsDto> {
  const count = async (mine: typeof follows.followeePersonaId | typeof follows.followerPersonaId, other: typeof follows.followeePersonaId | typeof follows.followerPersonaId) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(follows)
      .innerJoin(personas, eq(personas.id, other))
      .innerJoin(users, eq(users.id, personas.userId))
      .innerJoin(profiles, eq(profiles.personaId, personas.id))
      .where(and(eq(mine, personaId), eq(follows.status, 'active'), counterpartVisible()))
    return row?.n ?? 0
  }
  return { followers: await count(follows.followeePersonaId, follows.followerPersonaId), following: await count(follows.followerPersonaId, follows.followeePersonaId) }
}

/**
 * 공개 DTO(비로그인 판정)에 붙일 개수: `show_follower_count`가 켜졌을 때만 `{followCounts}`, 끄면 빈 객체(키 자체가 없음).
 */
export async function publicFollowCounts(db: DbExecutor, persona: Pick<PersonaRow, 'id' | 'showFollowerCount'>): Promise<{ followCounts?: FollowCountsDto }> {
  if (!showsFollowCounts(persona, { isOwner: false })) return {}
  return { followCounts: await followCounts(db, persona.id) }
}

// ── 공개: 팔로우 목록·관계 ───────────────────────────────────────────────

/**
 * GET /profiles/:handle/followers·following — `follow_lists` 공개 범위(public·private, 비공개 계정은 승인한 팔로워까지)를 보는 사람 기준으로 판정.
 * 차단당한 사용자·없는 handle 404, 볼 수 없으면 `{entries: null}`. 같은 사용자의 다른 페르소나·연결은 어느 경우에도 싣지 않습니다.
 */
export async function getFollowList(db: DbExecutor, actor: Actor | null, rawHandle: unknown, direction: Direction): Promise<FollowListDto> {
  const { persona } = await resolvePublicPersona(db, rawHandle)
  const viewer = await personaViewerFor(db, persona, actor)
  if (!canViewPersona(persona, viewer)) throw notFound()
  if (!(await canViewItem(db, persona, 'follow_lists', viewer))) return { entries: null }
  return { entries: (await followEntries(db, persona.id, direction, 'active', actor?.userId ?? null)).map(toPersonaDto) }
}

/** 내 페르소나(공개 프로필이 있는 것)와 이 대상의 팔로우·차단 상태. */
async function viewerRelations(db: DbExecutor, actor: Actor, target: Pick<PersonaRow, 'id'>): Promise<ViewerPersonaRelationDto[]> {
  const mine = await db
    .select({ persona: personas, accountName: users.displayName })
    .from(personas)
    .innerJoin(users, eq(users.id, personas.userId))
    .innerJoin(profiles, eq(profiles.personaId, personas.id))
    .where(and(eq(personas.userId, actor.userId), eq(personas.status, 'active')))
    .orderBy(asc(personas.kind))
  if (mine.length === 0) return []
  const ids = mine.map((m) => m.persona.id)
  const followRows = await db
    .select({ follower: follows.followerPersonaId, status: follows.status })
    .from(follows)
    .where(and(inArray(follows.followerPersonaId, ids), eq(follows.followeePersonaId, target.id)))
  const blockRows = await db
    .select({ id: blocks.id, origin: blocks.originPersonaId, scope: blocks.scope })
    .from(blocks)
    .where(and(eq(blocks.blockerUserId, actor.userId), eq(blocks.blockedPersonaId, target.id)))
  const blocksByOrigin = new Map(blockRows.map((b) => [b.origin, b]))
  return mine.map(({ persona, accountName }) => {
    const block = blocksByOrigin.get(persona.id)
    return {
      personaId: persona.id,
      kind: persona.kind,
      handle: persona.handle,
      displayName: personaDisplayName(persona, accountName),
      follow: followRows.find((f) => f.follower === persona.id)?.status ?? 'none',
      block: block ? { id: block.id, scope: block.scope } : null,
    }
  })
}

/**
 * GET /profiles/:handle/social — 세션을 읽는 관계 정보(no-store, 화면이 SSR 뒤 브라우저에서만 부름). 차단당한 사용자·없는 handle 404.
 * 개수는 공개 DTO와 같은 규칙(끄면 키 없음, 본인은 늘). 로그인한 다른 사람에게는 내 페르소나별 팔로우·차단 상태와 뮤트 id.
 */
export async function getProfileSocial(db: DbExecutor, actor: Actor | null, rawHandle: unknown): Promise<ProfileSocialDto> {
  const { persona } = await resolvePublicPersona(db, rawHandle)
  const viewer = await personaViewerFor(db, persona, actor)
  if (!canViewPersona(persona, viewer)) throw notFound()
  const dto: ProfileSocialDto = {
    accountPrivacy: persona.accountPrivacy,
    followListsVisible: await canViewItem(db, persona, 'follow_lists', viewer),
    isOwner: viewer.isOwner,
    viewer: null,
  }
  if (showsFollowCounts(persona, viewer)) dto.followCounts = await followCounts(db, persona.id)
  if (actor && !viewer.isOwner) {
    const [muted] = await db
      .select({ id: mutes.id })
      .from(mutes)
      .where(and(eq(mutes.muterUserId, actor.userId), eq(mutes.mutedPersonaId, persona.id)))
      .limit(1)
    dto.viewer = { personas: await viewerRelations(db, actor, persona), muteId: muted?.id ?? null }
  }
  return dto
}

// ── 팔로우·언팔로우 ──────────────────────────────────────────────────────

/** origin(S-07 분석용): 추천 목록에서 누른 팔로우면 `suggestion`(그 밖의 값·없음은 profile). */
const followInput = z.object({ as: z.unknown(), origin: z.unknown().optional() })

/** 내 페르소나(팔로우 주체·차단 주체). id 형식이 아니거나 내 것이 아니면 null. */
export async function myActingPersona(db: DbExecutor, actor: Actor, rawId: unknown): Promise<(PersonaRow & { hasProfile: boolean }) | null> {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) return null
  const [row] = await db
    .select({ persona: personas, profileId: profiles.personaId })
    .from(personas)
    .leftJoin(profiles, eq(profiles.personaId, personas.id))
    .where(and(eq(personas.id, id.data.toLowerCase()), eq(personas.userId, actor.userId)))
    .limit(1)
  return row ? { ...row.persona, hasProfile: row.profileId !== null } : null
}

/** 내가 바로 이 페르소나를 차단해 두었는지(내가 아는 사실만: 상대의 다른 페르소나 차단으로는 막지 않음, ADR 0033). */
async function blockedByMe(db: DbExecutor, actor: Actor, targetPersonaId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: blocks.id })
    .from(blocks)
    .where(and(eq(blocks.blockerUserId, actor.userId), eq(blocks.blockedPersonaId, targetPersonaId)))
    .limit(1)
  return !!row
}

/**
 * POST /profiles/:handle/follow {as: 내 페르소나 id} — 팔로우(공개 계정 active) 또는 요청(비공개 계정 pending). 이미 있으면 그 상태를 그대로 줍니다.
 * 404: 없는 handle·차단당함. 422 `as: invalid`(내 페르소나가 아님)·409 `profile_required`(주체 페르소나에 프로필 없음)·409 `own_persona`·
 * 409 `blocked_by_you`(이 페르소나를 내가 차단함). 새 행을 만들 때만 한도(`FOLLOW_RATE_LIMIT`)를 셉니다(429). 알림·감사 없음.
 */
export async function followProfile(db: DbExecutor, actor: Actor, rawHandle: unknown, rawInput: unknown, now = new Date()): Promise<FollowResultDto> {
  const input = followInput.safeParse(rawInput ?? {})
  const asId = input.success ? input.data.as : undefined
  const origin = input.success && input.data.origin === 'suggestion' ? 'suggestion' : 'profile'
  try {
    return await db.transaction(async (tx) => {
      const { persona: target } = await resolvePublicPersona(tx, rawHandle)
      const viewer = await personaViewerFor(tx, target, actor)
      const acting = await myActingPersona(tx, actor, asId)
      const decision = decideFollow({
        signedIn: true,
        acting,
        target,
        sameUser: target.userId === actor.userId,
        targetHidden: viewer.blocked,
        blockedByActor: await blockedByMe(tx, actor, target.id),
      })
      if (!decision.ok) {
        // signed_out은 라우트가 먼저 401로 끊습니다.
        if (decision.reason === 'not_found' || decision.reason === 'signed_out') throw notFound()
        if (decision.reason === 'acting_persona') throw invalid({ as: 'invalid' })
        throw conflict(decision.reason)
      }
      if (!acting!.hasProfile) throw conflict('profile_required')
      const [existing] = await tx
        .select({ status: follows.status })
        .from(follows)
        .where(and(eq(follows.followerPersonaId, acting!.id), eq(follows.followeePersonaId, target.id)))
        .limit(1)
      if (existing) return { status: existing.status }
      if (!(await hitRateLimit(tx, 'follow_create', actor.userId, FOLLOW_RATE_LIMIT, now))) throw rateLimited()
      await tx.insert(follows).values({
        followerPersonaId: acting!.id,
        followerUserId: actor.userId,
        followeePersonaId: target.id,
        followeeUserId: target.userId,
        status: decision.status,
        createdAt: now,
        approvedAt: decision.status === 'active' ? now : null,
      })
      // §6.2 follow_requested: 대상 페르소나 종류·대기 여부·출처만(페르소나 id·상대방 키 없음, ADR 0036).
      await emitSocialAnalytics(tx, {
        name: 'follow_requested',
        actorId: actor.userId,
        props: { targetKind: target.kind, pending: decision.status === 'pending', origin },
        now,
      })
      return { status: decision.status }
    })
  } catch (error) {
    // DB check(follows_not_self_check)는 애플리케이션 판정의 뒷받침입니다.
    if (sqlState(error) === '23514') throw conflict('own_persona')
    throw error
  }
}

/**
 * DELETE /profiles/:handle/follow?as=<내 페르소나 id> — 언팔로우·보낸 요청 취소(행 삭제, 알림 없음). 없으면 그대로 `{status: 'none'}`.
 * 차단당했거나 없는 handle 404, 내 페르소나가 아니면 422 `as: invalid`.
 */
export async function unfollowProfile(db: DbExecutor, actor: Actor, rawHandle: unknown, rawAs: unknown): Promise<FollowResultDto> {
  const { persona: target } = await resolvePublicPersona(db, rawHandle)
  const viewer = await personaViewerFor(db, target, actor)
  if (!canViewPersona(target, viewer)) throw notFound()
  const acting = await myActingPersona(db, actor, rawAs)
  if (!acting) throw invalid({ as: 'invalid' })
  await db.delete(follows).where(and(eq(follows.followerPersonaId, acting.id), eq(follows.followeePersonaId, target.id)))
  return { status: 'none' }
}

// ── 본인: 팔로우 관리 ────────────────────────────────────────────────────

async function myPersonaOr404(db: DbExecutor, actor: Actor, rawId: unknown): Promise<PersonaRow> {
  const persona = await myActingPersona(db, actor, rawId)
  if (!persona) throw notFound()
  return persona
}

/** GET /personas/:id/follows — 내 페르소나의 팔로워·팔로잉·받은 요청·보낸 요청. 남의 것·없는 id 404. */
export async function getMyFollows(db: DbExecutor, actor: Actor, rawId: unknown): Promise<MyFollowsDto> {
  const persona = await myPersonaOr404(db, actor, rawId)
  const [followers, following, incoming, outgoing] = [
    await followEntries(db, persona.id, 'followers', 'active', actor.userId),
    await followEntries(db, persona.id, 'following', 'active', actor.userId),
    await followEntries(db, persona.id, 'followers', 'pending', actor.userId),
    await followEntries(db, persona.id, 'following', 'pending', actor.userId),
  ]
  return {
    personaId: persona.id,
    kind: persona.kind,
    handle: persona.handle,
    accountPrivacy: persona.accountPrivacy,
    showFollowerCount: persona.showFollowerCount,
    followers: followers.map(toEntryDto),
    following: following.map(toEntryDto),
    incoming: incoming.map(toEntryDto),
    outgoing: outgoing.map(toEntryDto),
  }
}

/** 내가 받은(followee가 내 페르소나인) 팔로우 행. 없거나 남의 것이면 404. */
async function receivedFollowOr404(db: DbExecutor, actor: Actor, rawId: unknown, status?: FollowStatus) {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  const where: SQL[] = [eq(follows.id, id.data.toLowerCase()), eq(follows.followeeUserId, actor.userId)]
  if (status) where.push(eq(follows.status, status))
  const [row] = await db.select().from(follows).where(and(...where)).limit(1).for('update')
  if (!row) throw notFound()
  return row
}

/** POST /follow-requests/:id/approve — 받은 대기 요청 승인(active, approved_at). 남의 것·없는 id·이미 처리된 요청 404. 알림 없음. */
export async function approveFollowRequest(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<FollowResultDto> {
  return db.transaction(async (tx) => {
    const row = await receivedFollowOr404(tx, actor, rawId, 'pending')
    await tx.update(follows).set({ status: 'active', approvedAt: now }).where(eq(follows.id, row.id))
    await emitSocialAnalytics(tx, { name: 'follow_approved', actorId: actor.userId, props: { bulk: false }, now })
    return { status: 'active' as const }
  })
}

/** POST /follow-requests/:id/reject — 받은 대기 요청 거절(행 삭제, 상대에게 알리지 않음). 남의 것·없는 id 404. */
export async function rejectFollowRequest(db: DbExecutor, actor: Actor, rawId: unknown): Promise<FollowResultDto> {
  return db.transaction(async (tx) => {
    const row = await receivedFollowOr404(tx, actor, rawId, 'pending')
    await tx.delete(follows).where(eq(follows.id, row.id))
    return { status: 'none' as const }
  })
}

/**
 * DELETE /followers/:id — 팔로워 삭제(팔로우 행 id, 행 삭제, 상대에게 알리지 않음). 남의 것·없는 id 404.
 * 설계 초안의 `:personaId` 대신 팔로우 행 id를 씁니다: 다른 사람의 페르소나 id를 어떤 응답에도 싣지 않기 위해서입니다(ADR 0033).
 */
export async function removeFollower(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<FollowResultDto> {
  return db.transaction(async (tx) => {
    const row = await receivedFollowOr404(tx, actor, rawId)
    await tx.delete(follows).where(eq(follows.id, row.id))
    // 승인된 팔로워를 지운 것만(대기 요청 거절은 rejectFollowRequest). 상대방 키 없음(§6.2).
    if (row.status === 'active') await emitSocialAnalytics(tx, { name: 'follower_removed', actorId: actor.userId, now })
    return { status: 'none' as const }
  })
}

const resolveInput = z.object({ action: z.enum(['approve_all', 'reject_all'], { error: 'invalid' }) })

/**
 * POST /personas/:id/follow-requests {action: approve_all | reject_all} — 대기 요청을 한꺼번에 처리합니다. 비공개 → 공개로 바꿀 때 화면이 묻는
 * 선택지이며("그대로 두기"는 이 API를 부르지 않음), 계정 공개 설정과 관계없이 언제든 쓸 수 있습니다. 내 화면에 보이는 요청(상대가 공개 상태이고
 * 나에게 숨겨지지 않은 것)만 처리합니다. 남의 것 404, 잘못된 action 422.
 */
export async function resolvePendingRequests(db: DbExecutor, actor: Actor, rawId: unknown, rawInput: unknown, now = new Date()): Promise<MyFollowsDto> {
  await myPersonaOr404(db, actor, rawId)
  const parsed = resolveInput.safeParse(rawInput ?? {})
  if (!parsed.success) throw invalid({ action: (rawInput as { action?: unknown } | null)?.action === undefined ? 'required' : 'invalid' })
  await db.transaction(async (tx) => {
    const persona = await myPersonaOr404(tx, actor, rawId)
    const ids = (await followEntries(tx, persona.id, 'followers', 'pending', actor.userId)).map((r) => r.id)
    if (ids.length === 0) return
    const where = and(inArray(follows.id, ids), eq(follows.status, 'pending'), eq(follows.followeePersonaId, persona.id))
    if (parsed.data.action === 'approve_all') {
      const approved = await tx.update(follows).set({ status: 'active', approvedAt: now }).where(where).returning({ id: follows.id })
      for (const _ of approved) await emitSocialAnalytics(tx, { name: 'follow_approved', actorId: actor.userId, props: { bulk: true }, now })
    } else await tx.delete(follows).where(where)
  })
  return getMyFollows(db, actor, rawId)
}
