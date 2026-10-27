/**
 * 소셜 링크·되돌림 링크 확인 요청 (S-06, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 SocialLink·§8.3·§9.2·§10, DELIVERY_PLAN §4.2 S-06·§5.2 V,
 * ADR 0034).
 *
 * social 모듈입니다: 커뮤니티 글 테이블·커뮤니티 모듈을 import하지 않습니다(S-02 경계 테스트).
 *
 * - **링크는 페르소나마다 따로**이고 한 링크는 한 페르소나에만 속합니다. 같은 사용자의 다른 페르소나에 같은 주소는 409 `used_by_other_persona`
 *   (DB 유일 키 (user_id, url)도 같음). 공개 프로필은 그 페르소나의 링크만 싣고, 연결(identity_links)을 켜도 상대 페르소나의 링크를 붙이지 않습니다.
 * - 페르소나당 `SOCIAL_LINK_LIMIT`(8)개, 주소 규칙은 @peerchive/domain `parseSocialLinkUrl`(https만·IP·내부 이름·사용자 정보 없음·300자).
 * - **웹 서버는 링크 주소에 접속하지 않습니다**(§10). 확인 요청은 outbox `social_link.verify`만 남기고, worker의 링크 수집기(SSRF 방어)가 가져와
 *   상태를 바꿉니다. 확인 요청은 사용자당·링크당 한도가 있습니다(429).
 * - 소셜 링크는 프로필 기본 정보입니다(§8.3 표 첫 줄): 공개 범위 항목이 없고 공개 프로필에 늘 실립니다. 차단당한 사용자에게는 세션 경로가
 *   페르소나 자체를 404로 감춥니다(ADR 0033). 공개 DTO에는 서비스·주소·확인 여부만(확인 끊김·결과·시각은 본인에게만).
 * - 감사: `social_link.add`·`social_link.remove`·`social_link.verify_request`에 id·페르소나 종류·서비스·상태만 남기고 **주소는 남기지 않습니다**.
 */
import { z } from 'zod'
import { SOCIAL_LINK_VERIFY_TOPIC, and, asc, eq, outboxEvents, personas, profiles, socialLinks, sql, type DbExecutor } from '@peerchive/db'
import {
  SOCIAL_LINK_CREATE_RATE_LIMIT,
  SOCIAL_LINK_LIMIT,
  SOCIAL_LINK_PROVIDERS,
  SOCIAL_LINK_VERIFY_LINK_RATE_LIMIT,
  SOCIAL_LINK_VERIFY_USER_RATE_LIMIT,
  parseSocialLinkUrl,
  personaProfileUrl,
} from '@peerchive/domain'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, invalid, notFound, rateLimited, sqlState } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import type { MySocialLinkDto, MySocialLinksDto, PublicSocialLinkDto } from '../../../shared/types/api'

type SocialLinkRow = typeof socialLinks.$inferSelect

export function toMySocialLinkDto(row: SocialLinkRow): MySocialLinkDto {
  const requested = row.verifyRequestedAt
  return {
    id: row.id,
    provider: row.provider,
    url: row.url,
    verification: row.verification,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheckResult: row.lastCheckResult,
    verifyPending: requested !== null && (row.lastCheckedAt === null || row.lastCheckedAt < requested),
    createdAt: row.createdAt.toISOString(),
  }
}

/** 내 페르소나(본인 것만, 아니면 404). lock이면 행을 잠가 개수 한도 경합을 막습니다. */
async function myPersonaOr404(db: DbExecutor, actor: Actor, rawId: unknown, lock = false) {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  const query = db
    .select()
    .from(personas)
    .where(and(eq(personas.id, id.data.toLowerCase()), eq(personas.userId, actor.userId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

const listLinks = (db: DbExecutor, personaId: string) =>
  db.select().from(socialLinks).where(eq(socialLinks.personaId, personaId)).orderBy(asc(socialLinks.createdAt), asc(socialLinks.id))

/** GET /personas/:id/social-links — 내 페르소나의 링크·한도·넣어야 할 프로필 주소(본인만, 아니면 404). */
export async function listMySocialLinks(db: DbExecutor, actor: Actor, rawPersonaId: unknown, siteOrigin: string): Promise<MySocialLinksDto> {
  const persona = await myPersonaOr404(db, actor, rawPersonaId)
  const rows = await listLinks(db, persona.id)
  return { links: rows.map(toMySocialLinkDto), limit: SOCIAL_LINK_LIMIT, backLinkUrl: personaProfileUrl(siteOrigin, persona.handle) }
}

const addInput = z.object({
  provider: z.enum(SOCIAL_LINK_PROVIDERS, { error: 'invalid' }),
  url: z.unknown(),
})

/**
 * POST /personas/:id/social-links {provider, url} — 링크 추가(201, 확인 전 상태). 404: 남의 페르소나·없는 id. 422: `provider: invalid`,
 * `url: invalid | too_long | scheme | credentials | port | ip_literal | host | provider_mismatch`. 409: `profile_required`(공개 프로필이 없는 페르소나),
 * `limit_reached`(8개), `duplicate`(이 페르소나에 이미 있음), `used_by_other_persona`(내 다른 페르소나에 있음). 429: 추가 한도(사용자당 하루 30건).
 */
export async function addSocialLink(db: DbExecutor, actor: Actor, rawPersonaId: unknown, rawInput: unknown, now = new Date()): Promise<MySocialLinkDto> {
  const parsed = addInput.safeParse(rawInput ?? {})
  if (!parsed.success) throw invalid({ provider: 'invalid' })
  const checked = parseSocialLinkUrl(parsed.data.url, parsed.data.provider)
  if (!checked.ok) throw invalid({ url: checked.reason })
  try {
    return await db.transaction(async (tx) => {
      const persona = await myPersonaOr404(tx, actor, rawPersonaId, true)
      const [profile] = await tx.select({ id: profiles.personaId }).from(profiles).where(eq(profiles.personaId, persona.id)).limit(1)
      if (!profile) throw conflict('profile_required')
      const [same] = await tx
        .select({ personaId: socialLinks.personaId })
        .from(socialLinks)
        .where(and(eq(socialLinks.userId, actor.userId), eq(socialLinks.url, checked.url)))
        .limit(1)
      if (same) throw conflict(same.personaId === persona.id ? 'duplicate' : 'used_by_other_persona')
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(socialLinks)
        .where(eq(socialLinks.personaId, persona.id))
      if (n >= SOCIAL_LINK_LIMIT) throw conflict('limit_reached', { limit: SOCIAL_LINK_LIMIT })
      if (!(await hitRateLimit(tx, 'social_link_create', actor.userId, SOCIAL_LINK_CREATE_RATE_LIMIT, now))) throw rateLimited()
      const [row] = await tx
        .insert(socialLinks)
        .values({ personaId: persona.id, userId: actor.userId, provider: parsed.data.provider, url: checked.url, createdAt: now })
        .returning()
      await recordAudit(tx, {
        actorId: actor.userId,
        action: 'social_link.add',
        targetType: 'social_link',
        targetId: row!.id,
        metadata: { personaId: persona.id, personaKind: persona.kind, provider: row!.provider },
      })
      return toMySocialLinkDto(row!)
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('duplicate')
    throw error
  }
}

/** 내 링크와 그 페르소나(본인 것만, 아니면 404). */
async function myLinkOr404(db: DbExecutor, actor: Actor, rawId: unknown, lock = false) {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  const query = db
    .select({ link: socialLinks, persona: personas })
    .from(socialLinks)
    .innerJoin(personas, eq(personas.id, socialLinks.personaId))
    .where(and(eq(socialLinks.id, id.data.toLowerCase()), eq(socialLinks.userId, actor.userId)))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: socialLinks }) : await query
  if (!row) throw notFound()
  return row
}

/** DELETE /social-links/:id — 내 링크 삭제. 남의 것·없는 id 404. 감사 `social_link.remove`(주소 없음). */
export async function removeSocialLink(db: DbExecutor, actor: Actor, rawId: unknown): Promise<{ removed: true }> {
  return db.transaction(async (tx) => {
    const { link, persona } = await myLinkOr404(tx, actor, rawId, true)
    await tx.delete(socialLinks).where(eq(socialLinks.id, link.id))
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'social_link.remove',
      targetType: 'social_link',
      targetId: link.id,
      metadata: { personaId: persona.id, personaKind: persona.kind, provider: link.provider, verification: link.verification },
    })
    return { removed: true as const }
  })
}

/**
 * POST /social-links/:id/verify — 되돌림 링크 확인 요청(202). 웹은 접속하지 않고 outbox `social_link.verify`만 남깁니다(worker가 가져와 상태를 바꿈).
 * 404: 남의 것·없는 id. 409 `persona_inactive`. 429: 사용자당 시간당 20건, 링크당 시간당 3건. 감사 `social_link.verify_request`(주소 없음).
 */
export async function requestSocialLinkVerification(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<MySocialLinkDto> {
  return db.transaction(async (tx) => {
    const { link, persona } = await myLinkOr404(tx, actor, rawId, true)
    if (persona.status !== 'active') throw conflict('persona_inactive')
    if (!(await hitRateLimit(tx, 'social_link_verify_user', actor.userId, SOCIAL_LINK_VERIFY_USER_RATE_LIMIT, now))) throw rateLimited()
    if (!(await hitRateLimit(tx, 'social_link_verify_link', link.id, SOCIAL_LINK_VERIFY_LINK_RATE_LIMIT, now))) throw rateLimited()
    const [row] = await tx.update(socialLinks).set({ verifyRequestedAt: now }).where(eq(socialLinks.id, link.id)).returning()
    await tx.insert(outboxEvents).values({ topic: SOCIAL_LINK_VERIFY_TOPIC, payload: { socialLinkId: link.id }, createdAt: now })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'social_link.verify_request',
      targetType: 'social_link',
      targetId: link.id,
      metadata: { personaId: persona.id, personaKind: persona.kind, provider: link.provider, verification: link.verification },
    })
    return toMySocialLinkDto(row!)
  })
}

/**
 * 공개 프로필의 소셜 링크(그 페르소나의 것만, 추가 순). 서비스·주소·확인 여부만 싣습니다. 공개 경로·세션 경로 모두 이 함수입니다
 * (프로필 기본 정보라 보는 사람별 차이가 없음 — 차단당한 사용자는 페르소나 자체가 404).
 */
export async function publicSocialLinks(db: DbExecutor, personaId: string): Promise<PublicSocialLinkDto[]> {
  const rows = await db
    .select({ provider: socialLinks.provider, url: socialLinks.url, verification: socialLinks.verification })
    .from(socialLinks)
    .where(eq(socialLinks.personaId, personaId))
    .orderBy(asc(socialLinks.createdAt), asc(socialLinks.id))
  return rows.map((r) => ({ provider: r.provider, url: r.url, verified: r.verification === 'verified' }))
}
