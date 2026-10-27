/**
 * 페르소나·표시명 ↔ 실명 연결 플래그 (S-01, PROOFU_EVOLUTION_PLAN §4.4·§10.7, SYSTEM_DESIGN §6.7.1 Persona·IdentityLink·§8.3·§9.2,
 * DELIVERY_PLAN §4.2 S-01·§5.2 R, ADR 0028).
 *
 * 공개 프로필·팔로우·피드를 소유할 social 모듈의 첫 파일입니다. 이 모듈은 커뮤니티 글 테이블을 읽지 않습니다(§8.3, S-02가 lint로 굳힘).
 *
 * - 계정당 `real` 하나(프로필 온보딩 `PATCH /me/profile`이 만듦)·`display` 하나(`POST /personas`)까지. handle은 두 종류가 같은 전역 공간에서
 *   유일하고(DB unique `personas_handle_key`) 예약어를 거부합니다. 겹치면 어느 종류와 겹쳤는지 밝히지 않고 422 `handle: taken`.
 * - 표시명 페르소나를 만들면 같은 트랜잭션에서 연결 행(identity_links, visible = false)이 생깁니다. `PUT /me/identity-link {visible}`로만 바꾸고
 *   감사 이벤트에는 플래그만 남깁니다(handle·이름 없음).
 * - **공개 경로**(`resolvePublicPersona` + `linkedPersonaFor`): handle로 페르소나 하나를 찾고, 상대 페르소나는 `canSeeIdentityLink`가 true이고
 *   상대도 지금 공개 상태일 때만 `{kind, handle, displayName}`으로 붙입니다. false면 상대 페르소나 행을 읽지도 않습니다.
 * - 다른 사람의 페르소나는 존재 여부를 드러내지 않도록 404입니다.
 */
import { z } from 'zod'
import { and, asc, eq, identityLinks, isNull, personas, profiles, users, type DbExecutor } from '@peerchive/db'
import { type IdentityLinkViewer, type PersonaKind, canSeeIdentityLink, isLookupHandle, otherPersonaKind } from '@peerchive/domain'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound, sqlState } from '../errors'
import { parseInput } from '../validation'
import { displayNameSchema, handleSchema, profileFields, profileFieldsSchema } from '../identity/profile-input'
import type { MyPersonaDto, MyPersonasDto, PublicLinkedPersonaDto } from '../../../shared/types/api'

type PersonaRow = typeof personas.$inferSelect
type ProfileRow = typeof profiles.$inferSelect

/** 페르소나의 공개 이름: real은 계정 표시 이름(users.display_name), display는 페르소나의 표시명. */
export function personaDisplayName(persona: Pick<PersonaRow, 'kind' | 'displayName'>, accountDisplayName: string): string {
  return persona.kind === 'real' ? accountDisplayName : (persona.displayName ?? '')
}

/** 공개 경로에 보일 수 있는 페르소나 조건: 페르소나 active + 계정 active + 프로필 행 있음(내부 조인) + 운영 조치로 숨기지 않음. */
const publiclyVisible = () => and(eq(personas.status, 'active'), eq(users.status, 'active'), isNull(profiles.hiddenAt))

export interface PublicPersona {
  persona: PersonaRow
  profile: ProfileRow
  /** 공개 이름(personaDisplayName). */
  displayName: string
}

/** handle(실명·표시명 어느 쪽이든)로 공개 페르소나를 찾습니다. 없거나 비공개 상태면 404. */
export async function resolvePublicPersona(db: DbExecutor, rawHandle: unknown): Promise<PublicPersona> {
  const handle = typeof rawHandle === 'string' ? rawHandle.trim().toLowerCase() : ''
  if (!isLookupHandle(handle)) throw notFound()
  const [row] = await db
    .select({ persona: personas, profile: profiles, accountName: users.displayName })
    .from(personas)
    .innerJoin(profiles, eq(profiles.personaId, personas.id))
    .innerJoin(users, eq(users.id, personas.userId))
    .where(and(eq(personas.handle, handle), publiclyVisible()))
    .limit(1)
  if (!row) throw notFound()
  return { persona: row.persona, profile: row.profile, displayName: personaDisplayName(row.persona, row.accountName) }
}

/**
 * 공개 DTO에 붙일 상대 페르소나 링크. `canSeeIdentityLink`가 false이면 상대 페르소나를 조회하지 않고 null입니다.
 * 켜져 있어도 상대가 지금 공개 상태가 아니면(숨김·비활성) null — 404가 날 링크를 걸지 않습니다.
 */
export async function linkedPersonaFor(db: DbExecutor, persona: Pick<PersonaRow, 'id' | 'userId' | 'kind'>, viewer: IdentityLinkViewer): Promise<PublicLinkedPersonaDto | null> {
  const [link] = await db.select().from(identityLinks).where(eq(identityLinks.userId, persona.userId)).limit(1)
  if (!link || !canSeeIdentityLink(link, viewer)) return null
  const otherId = persona.kind === 'real' ? link.displayPersonaId : link.realPersonaId
  if (otherId === persona.id) return null
  const [other] = await db
    .select({ persona: personas, accountName: users.displayName })
    .from(personas)
    .innerJoin(profiles, eq(profiles.personaId, personas.id))
    .innerJoin(users, eq(users.id, personas.userId))
    .where(and(eq(personas.id, otherId), eq(personas.kind, otherPersonaKind(persona.kind)), publiclyVisible()))
    .limit(1)
  if (!other) return null
  return { kind: other.persona.kind, handle: other.persona.handle, displayName: personaDisplayName(other.persona, other.accountName) }
}

// ── 본인 화면 ────────────────────────────────────────────────────────────

const privacySchema = {
  accountPrivacy: z.enum(['public', 'private'], { error: 'invalid' }).optional(),
  showFollowerCount: z.boolean({ error: 'invalid' }).optional(),
}

export const createPersonaSchema = profileFieldsSchema.extend({
  kind: z.literal('display', { error: 'invalid' }).default('display'),
  handle: handleSchema,
  displayName: displayNameSchema,
  ...privacySchema,
})

export const updatePersonaSchema = profileFieldsSchema.extend({
  handle: handleSchema.optional(),
  displayName: displayNameSchema.optional(),
  ...privacySchema,
})

type ProfileInputFields = z.output<typeof profileFieldsSchema>

function profileChanges(input: ProfileInputFields) {
  return {
    ...(input.headline !== undefined && { headline: input.headline }),
    ...(input.jobTargets !== undefined && { jobTargets: input.jobTargets }),
    ...(input.schoolLabel !== undefined && { schoolLabel: input.schoolLabel }),
    ...(input.gradTerm !== undefined && { gradTerm: input.gradTerm }),
    ...(input.contactPolicy !== undefined && { contactPolicy: input.contactPolicy }),
    ...(input.openToWork !== undefined && { openToWork: input.openToWork }),
    ...(input.showAffiliationBadge !== undefined && { showAffiliationBadge: input.showAffiliationBadge }),
  }
}

async function activeAccount(db: DbExecutor, actor: Actor, lock = false) {
  const query = db
    .select({ displayName: users.displayName })
    .from(users)
    .where(and(eq(users.id, actor.userId), eq(users.status, 'active')))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

/** GET /me/personas — 내 페르소나(실명 먼저)와 연결 플래그. */
export async function listMyPersonas(db: DbExecutor, actor: Actor): Promise<MyPersonasDto> {
  const account = await activeAccount(db, actor)
  const rows = await db
    .select({ persona: personas, profile: profiles })
    .from(personas)
    .leftJoin(profiles, eq(profiles.personaId, personas.id))
    .where(eq(personas.userId, actor.userId))
    .orderBy(asc(personas.kind))
  const [link] = await db.select().from(identityLinks).where(eq(identityLinks.userId, actor.userId)).limit(1)
  return {
    personas: rows.map((r): MyPersonaDto => ({
      id: r.persona.id,
      kind: r.persona.kind,
      handle: r.persona.handle,
      displayName: personaDisplayName(r.persona, account.displayName),
      accountPrivacy: r.persona.accountPrivacy,
      showFollowerCount: r.persona.showFollowerCount,
      profileHidden: r.profile?.hiddenAt != null,
      profile: r.profile ? profileFields(r.profile) : null,
    })),
    identityLink: link ? { visible: link.visible, changedAt: link.changedAt.toISOString() } : null,
  }
}

async function myPersona(db: DbExecutor, actor: Actor, personaId: string): Promise<MyPersonaDto> {
  const dto = (await listMyPersonas(db, actor)).personas.find((p) => p.id === personaId)
  if (!dto) throw notFound()
  return dto
}

/**
 * POST /personas — 표시명 페르소나 만들기(201). real 페르소나(프로필)가 먼저 있어야 합니다(409 `real_persona_required`).
 * 계정당 하나(409 `persona_exists`), handle 422(`too_short`·`invalid_format`·`reserved`·`taken`), 이름 422. 연결 행은 visible = false로 함께 생깁니다.
 */
export async function createDisplayPersona(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<MyPersonaDto> {
  const input = parseInput(createPersonaSchema, rawInput)
  let personaId = ''
  try {
    await db.transaction(async (tx) => {
      await activeAccount(tx, actor, true)
      const mine = await tx.select({ id: personas.id, kind: personas.kind }).from(personas).where(eq(personas.userId, actor.userId))
      const real = mine.find((p) => p.kind === 'real')
      // 판만 있던 사용자의 자리표시 real 페르소나(프로필 없음)는 아직 프로필이 아니므로 먼저 프로필을 만들게 합니다.
      const [realProfile] = real ? await tx.select({ id: profiles.personaId }).from(profiles).where(eq(profiles.personaId, real.id)).limit(1) : []
      if (!real || !realProfile) throw conflict('real_persona_required')
      if (mine.some((p) => p.kind === 'display')) throw conflict('persona_exists')
      const [created] = await tx
        .insert(personas)
        .values({
          userId: actor.userId,
          kind: 'display',
          handle: input.handle,
          displayName: input.displayName,
          ...(input.accountPrivacy !== undefined && { accountPrivacy: input.accountPrivacy }),
          ...(input.showFollowerCount !== undefined && { showFollowerCount: input.showFollowerCount }),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: personas.id })
      personaId = created!.id
      // 표시명 프로필은 user_id가 null입니다: 내부 조회의 `profiles.user_id = users.id` 조인이 이 행을 집지 않습니다.
      await tx.insert(profiles).values({ personaId, personaKind: 'display', userId: null, handle: input.handle, ...profileChanges(input), createdAt: now, updatedAt: now })
      await tx.insert(identityLinks).values({ userId: actor.userId, realPersonaId: real.id, displayPersonaId: personaId, visible: false, changedAt: now })
      await recordAudit(tx, { actorId: actor.userId, action: 'persona.create', targetType: 'persona', targetId: personaId, metadata: { kind: 'display' } })
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw invalid({ handle: 'taken' })
    throw error
  }
  return myPersona(db, actor, personaId)
}

/**
 * PATCH /personas/:id — 내 페르소나 수정(handle·표시명·프로필 필드·공개 설정). 남의 페르소나·없는 id는 404.
 * 실명 페르소나의 이름은 계정 표시 이름이라 여기서 바꾸지 않습니다(422 `displayName: not_editable`, `PATCH /me/profile`을 씀).
 * 감사에는 바뀐 필드 이름만 남깁니다(값 없음).
 */
export async function updatePersona(db: DbExecutor, actor: Actor, rawId: unknown, rawInput: unknown, now = new Date()): Promise<MyPersonaDto> {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  const personaId = id.data.toLowerCase()
  const input = parseInput(updatePersonaSchema, rawInput)
  try {
    await db.transaction(async (tx) => {
      await activeAccount(tx, actor, true)
      const [persona] = await tx
        .select()
        .from(personas)
        .where(and(eq(personas.id, personaId), eq(personas.userId, actor.userId)))
        .limit(1)
        .for('update')
      if (!persona) throw notFound()
      if (persona.kind === 'real' && input.displayName !== undefined) throw invalid({ displayName: 'not_editable' })
      const personaChanges = {
        ...(input.handle !== undefined && input.handle !== persona.handle && { handle: input.handle }),
        ...(input.displayName !== undefined && { displayName: input.displayName }),
        ...(input.accountPrivacy !== undefined && { accountPrivacy: input.accountPrivacy }),
        ...(input.showFollowerCount !== undefined && { showFollowerCount: input.showFollowerCount }),
      }
      const fields = profileChanges(input)
      const changed = [...Object.keys(personaChanges), ...Object.keys(fields)].sort()
      if (changed.length === 0) return
      // handle은 페르소나 행만 바꿉니다. profiles.handle은 외래 키 ON UPDATE CASCADE로 따라옵니다.
      if (Object.keys(personaChanges).length) await tx.update(personas).set({ ...personaChanges, updatedAt: now }).where(eq(personas.id, persona.id))
      if (Object.keys(fields).length) {
        const updated = await tx.update(profiles).set({ ...fields, updatedAt: now }).where(eq(profiles.personaId, persona.id)).returning({ id: profiles.personaId })
        if (updated.length === 0) throw conflict('profile_required')
      }
      await recordAudit(tx, { actorId: actor.userId, action: 'persona.update', targetType: 'persona', targetId: persona.id, metadata: { kind: persona.kind, fields: changed.join(',') } })
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw invalid({ handle: 'taken' })
    throw error
  }
  return myPersona(db, actor, personaId)
}

/**
 * PUT /me/identity-link {visible} — 표시명 ↔ 실명 연결 표시를 켜고 끕니다. 표시명 페르소나가 없으면 409 `no_display_persona`.
 * 바뀌지 않으면 아무것도 쓰지 않습니다. 감사 `persona.identity_link_update`에는 `{visible}` 플래그만(handle·이름·페르소나 id 없음).
 * 공개 경로는 요청마다 이 행을 읽으므로 끄면 다음 요청부터 링크가 사라집니다.
 */
export async function setIdentityLink(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<MyPersonasDto> {
  const input = parseInput(z.object({ visible: z.boolean({ error: 'invalid' }) }), rawInput)
  await db.transaction(async (tx) => {
    await activeAccount(tx, actor, true)
    const [link] = await tx.select().from(identityLinks).where(eq(identityLinks.userId, actor.userId)).limit(1).for('update')
    if (!link) throw conflict('no_display_persona')
    if (link.visible === input.visible) return
    await tx.update(identityLinks).set({ visible: input.visible, changedAt: now }).where(eq(identityLinks.userId, actor.userId))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'persona.identity_link_update',
      targetType: 'identity_link',
      targetId: actor.userId,
      metadata: { visible: input.visible },
    })
  })
  return listMyPersonas(db, actor)
}

/** 판·화면이 쓰는 내 페르소나 하나(없으면 null). kind만 주면 그 종류. */
export async function findMyPersona(
  db: DbExecutor,
  actor: Actor,
  by: { id: string } | { kind: PersonaKind },
): Promise<PersonaRow | null> {
  const where = 'id' in by ? eq(personas.id, by.id) : eq(personas.kind, by.kind)
  const [row] = await db.select().from(personas).where(and(eq(personas.userId, actor.userId), where)).limit(1)
  return row ?? null
}
