/**
 * 포트폴리오 판 제한 공유 링크 (E-07, DELIVERY_PLAN §4.4, SYSTEM_DESIGN §6.5 ShareGrant·§8 restricted-share, ADR 0051).
 *
 * - 링크는 **판 하나**를 가리키는 bearer 토큰입니다. CSPRNG 32바이트(256비트) base64url을 만든 응답에서 한 번만 돌려주고, DB에는 SHA-256 hex만
 *   둡니다(매직링크와 같은 규칙, security/tokens). 조회는 해시로 직접 하므로 공격자가 해시 값을 고를 수 없어 타이밍 오라클이 되지 않습니다.
 * - 만료는 1~90일(기본 30일), 철회는 revoked_at. 기록하는 열람 정보는 **횟수(view_count)뿐**입니다(IP·브라우저·시각 없음).
 * - 공유 페이지(`/s/<token>`, 공개 API `GET /api/v1/public/share/:token`)는 요청마다 다시 판정합니다:
 *   링크(철회 안 됨·만료 전) → 판이 **지금 판**(새 판이 생기면 그 판의 링크는 404, 이전 판은 공개하지 않는다는 T-14 규칙) → 페르소나·계정 active,
 *   프로필 숨김 아님(공개 프로필과 같은 조건) → 대표 케이스는 공개 프로필과 같은 `buildPortfolioView`(게시 중 + release 제공 가능 + 숨김 아님 +
 *   엠바고 아님). 그래서 링크가 보여 주는 것은 그 판의 익명 공개 보기와 같거나 더 좁습니다(공개 범위를 넓히지 않음).
 * - 공유 DTO는 공개 프로필보다 좁습니다: 프로필 기본 필드 + 판의 포트폴리오 보기만. 타임라인·후배 기여·과제 수행 목록(S-03)·팔로우 수(S-04)·
 *   소셜 링크·학교 인증 배지·상대 페르소나 링크(S-01)는 싣지 않습니다. 표시명 페르소나의 판은 표시명 이름·글만(대표 케이스 없음).
 * - 토큰은 bearer라 차단(S-04)과 무관합니다: 공개 경로라 세션을 읽지 않으므로 로그아웃한 방문자와 같은 응답입니다(공개 프로필과 같음).
 * - 감사: 만들기·철회·지우기에 링크 id·판 id·만료 일수·이름 유무만. 토큰·해시·이름 글은 넣지 않습니다. 열람은 감사·분석에 남기지 않습니다.
 */
import { z } from 'zod'
import { and, desc, eq, gt, isNull, personas, portfolioEditions, portfolioShareLinks, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, notFound, rateLimited } from '../errors'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { generateToken, looksLikeToken, sha256Hex } from '../security/tokens'
import { parseInput } from '../validation'
import { toPublicProfileDto } from '../identity/profile-input'
import { resolvePublicPersonaById } from '../social/personas'
import { editionModelOf } from './editions'
import { CONTACT_POLICY_TEXT } from './public-profile'
import { buildPortfolioView } from './view'
import type { CreatedShareLinkDto, ShareLinkDto, ShareLinkStatus, SharedPortfolioDto } from '../../../shared/types/api'

const DAY_MS = 24 * 60 * 60 * 1000
export const SHARE_LINK_MAX_DAYS = 90
export const SHARE_LINK_DEFAULT_DAYS = 30
export const SHARE_LINK_LABEL_MAX = 60
/** 사용자마다 지금 열 수 있는 링크 수 한도. */
export const SHARE_LINK_ACTIVE_LIMIT = 20
/** 목록에 보이는 링크 수(최근 순). 철회·만료된 링크는 지울 수 있습니다. */
export const SHARE_LINK_LIST_LIMIT = 100
export const SHARE_LINK_CREATE_RATE_LIMIT: RateLimitRule = { limit: 30, windowMs: 60 * 60 * 1000 }
/** 공유 페이지 열람(IP마다). 토큰 추측·긁기를 늦춥니다. */
export const SHARE_LINK_VIEW_RATE_LIMIT: RateLimitRule = { limit: 60, windowMs: 60 * 1000 }
export const SHARE_PAGE_PREFIX = '/s/'

export const shareLinkInputSchema = z.object({
  label: z
    .string({ error: 'invalid' })
    .nullish()
    .transform((v) => (v ?? '').replace(/\s+/g, ' ').trim() || null)
    .pipe(z.string().max(SHARE_LINK_LABEL_MAX, { error: 'too_long' }).nullable()),
  expiresInDays: z
    .number({ error: 'invalid' })
    .int({ error: 'invalid' })
    .min(1, { error: 'too_small' })
    .max(SHARE_LINK_MAX_DAYS, { error: 'too_large' })
    .default(SHARE_LINK_DEFAULT_DAYS),
})

type LinkRow = typeof portfolioShareLinks.$inferSelect
type EditionRow = typeof portfolioEditions.$inferSelect
type PersonaRef = { kind: 'real' | 'display'; handle: string }

export function shareLinkStatus(link: Pick<LinkRow, 'revokedAt' | 'expiresAt'>, edition: Pick<EditionRow, 'status'>, now: Date): ShareLinkStatus {
  if (link.revokedAt) return 'revoked'
  if (link.expiresAt.getTime() <= now.getTime()) return 'expired'
  if (edition.status !== 'current') return 'superseded'
  return 'active'
}

function toDto(link: LinkRow, edition: Pick<EditionRow, 'id' | 'version' | 'status'>, persona: PersonaRef, now: Date): ShareLinkDto {
  return {
    id: link.id,
    edition: { id: edition.id, version: edition.version, personaKind: persona.kind, personaHandle: persona.handle },
    label: link.label,
    status: shareLinkStatus(link, edition, now),
    expiresAt: link.expiresAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    viewCount: link.viewCount,
    createdAt: link.createdAt.toISOString(),
  }
}

const parseId = (raw: unknown): string | null => {
  const r = z.uuid().safeParse(raw)
  return r.success ? r.data.toLowerCase() : null
}

/** 내 판(+ 페르소나). 남의 판·없는 판은 404. */
async function myEdition(db: DbExecutor, actor: Actor, rawId: unknown) {
  const id = parseId(rawId)
  if (!id) throw notFound()
  const [row] = await db
    .select({ edition: portfolioEditions, persona: { kind: personas.kind, handle: personas.handle } })
    .from(portfolioEditions)
    .innerJoin(personas, eq(personas.id, portfolioEditions.personaId))
    .where(and(eq(portfolioEditions.id, id), eq(portfolioEditions.userId, actor.userId)))
    .limit(1)
  if (!row) throw notFound()
  return row
}

/** 내 링크(+ 판·페르소나). 남의 링크·없는 링크는 404. */
async function myLink(db: DbExecutor, actor: Actor, rawId: unknown, lock = false) {
  const id = parseId(rawId)
  if (!id) throw notFound()
  const query = db
    .select({ link: portfolioShareLinks, edition: portfolioEditions, persona: { kind: personas.kind, handle: personas.handle } })
    .from(portfolioShareLinks)
    .innerJoin(portfolioEditions, eq(portfolioEditions.id, portfolioShareLinks.editionId))
    .innerJoin(personas, eq(personas.id, portfolioEditions.personaId))
    .where(and(eq(portfolioShareLinks.id, id), eq(portfolioShareLinks.userId, actor.userId)))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: portfolioShareLinks }) : await query
  if (!row) throw notFound()
  return row
}

/**
 * POST /portfolio-editions/:id/share-links {label?, expiresInDays?} — 201 + 링크와 원문 토큰(이 응답에서만).
 * 404(내 판 아님), 409 `edition_superseded`(지금 판이 아님)·`limit_reached`(열린 링크 20개), 422, 429.
 */
export async function createShareLink(db: DbExecutor, actor: Actor, rawEditionId: unknown, rawInput: unknown, now = new Date()): Promise<CreatedShareLinkDto> {
  const input = parseInput(shareLinkInputSchema, rawInput)
  return db.transaction(async (tx) => {
    const { edition, persona } = await myEdition(tx, actor, rawEditionId)
    if (!(await hitRateLimit(tx, 'share_link_create', actor.userId, SHARE_LINK_CREATE_RATE_LIMIT, now))) throw rateLimited()
    if (edition.status !== 'current') throw conflict('edition_superseded')
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`share-links:${actor.userId}`}))`)
    const [{ active } = { active: 0 }] = await tx
      .select({ active: sql<number>`count(*)::int` })
      .from(portfolioShareLinks)
      .innerJoin(portfolioEditions, eq(portfolioEditions.id, portfolioShareLinks.editionId))
      .where(
        and(
          eq(portfolioShareLinks.userId, actor.userId),
          isNull(portfolioShareLinks.revokedAt),
          gt(portfolioShareLinks.expiresAt, now),
          eq(portfolioEditions.status, 'current'),
        ),
      )
    if (active >= SHARE_LINK_ACTIVE_LIMIT) throw conflict('limit_reached', { limit: SHARE_LINK_ACTIVE_LIMIT })
    const token = generateToken(32)
    const [link] = await tx
      .insert(portfolioShareLinks)
      .values({
        userId: actor.userId,
        editionId: edition.id,
        tokenHash: sha256Hex(token),
        label: input.label,
        expiresAt: new Date(now.getTime() + input.expiresInDays * DAY_MS),
        createdAt: now,
      })
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'share_link.create',
      targetType: 'share_link',
      targetId: link!.id,
      metadata: { editionId: edition.id, personaKind: persona.kind, expiresInDays: input.expiresInDays, labeled: input.label !== null },
    })
    return { ...toDto(link!, edition, persona, now), token, path: `${SHARE_PAGE_PREFIX}${token}` }
  })
}

/** GET /me/share-links — 내 링크(최근 순, 100개). 상태·열람 횟수. 토큰은 다시 볼 수 없습니다. */
export async function listMyShareLinks(db: DbExecutor, actor: Actor, now = new Date()): Promise<ShareLinkDto[]> {
  const rows = await db
    .select({ link: portfolioShareLinks, edition: portfolioEditions, persona: { kind: personas.kind, handle: personas.handle } })
    .from(portfolioShareLinks)
    .innerJoin(portfolioEditions, eq(portfolioEditions.id, portfolioShareLinks.editionId))
    .innerJoin(personas, eq(personas.id, portfolioEditions.personaId))
    .where(eq(portfolioShareLinks.userId, actor.userId))
    .orderBy(desc(portfolioShareLinks.createdAt), desc(portfolioShareLinks.id))
    .limit(SHARE_LINK_LIST_LIMIT)
  return rows.map((r) => toDto(r.link, r.edition, r.persona, now))
}

/** POST /me/share-links/:id/revoke — 철회(다음 요청부터 404). 이미 철회했으면 그대로 200(감사 기록 없음). 남의 링크 404. */
export async function revokeShareLink(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<ShareLinkDto> {
  return db.transaction(async (tx) => {
    const { link, edition, persona } = await myLink(tx, actor, rawId, true)
    if (link.revokedAt) return toDto(link, edition, persona, now)
    const [updated] = await tx.update(portfolioShareLinks).set({ revokedAt: now }).where(eq(portfolioShareLinks.id, link.id)).returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'share_link.revoke',
      targetType: 'share_link',
      targetId: link.id,
      metadata: { editionId: edition.id, viewCount: link.viewCount },
    })
    return toDto(updated!, edition, persona, now)
  })
}

/** DELETE /me/share-links/:id — 열 수 없는 링크(철회·만료·지난 판)만 목록에서 지웁니다(행 삭제). 열린 링크는 409 `share_link_active`(먼저 철회). */
export async function deleteShareLink(db: DbExecutor, actor: Actor, rawId: unknown, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const { link, edition } = await myLink(tx, actor, rawId, true)
    if (shareLinkStatus(link, edition, now) === 'active') throw conflict('share_link_active')
    await tx.delete(portfolioShareLinks).where(eq(portfolioShareLinks.id, link.id))
    await recordAudit(tx, { actorId: actor.userId, action: 'share_link.delete', targetType: 'share_link', targetId: link.id, metadata: { editionId: edition.id } })
  })
}

/**
 * 공유 페이지 데이터(`GET /api/v1/public/share/:token`, 로그인 불필요). 형식이 틀리거나, 없거나, 철회·만료됐거나, 판이 지금 판이 아니거나,
 * 페르소나·계정·프로필이 공개 상태가 아니면 모두 같은 404입니다(어느 경우인지 밝히지 않음). 열면 열람 횟수만 1 올립니다.
 */
export async function getSharedPortfolio(db: DbExecutor, rawToken: unknown, now = new Date()): Promise<SharedPortfolioDto> {
  if (!looksLikeToken(rawToken)) throw notFound()
  const [row] = await db
    .select({ link: portfolioShareLinks, edition: portfolioEditions })
    .from(portfolioShareLinks)
    .innerJoin(portfolioEditions, eq(portfolioEditions.id, portfolioShareLinks.editionId))
    .where(eq(portfolioShareLinks.tokenHash, sha256Hex(rawToken)))
    .limit(1)
  if (!row || shareLinkStatus(row.link, row.edition, now) !== 'active') throw notFound()
  const { link, edition } = row
  const { persona, profile, displayName } = await resolvePublicPersonaById(db, edition.personaId)
  if (persona.userId !== link.userId) throw notFound()
  const isReal = persona.kind === 'real'
  const model = await editionModelOf(db, edition)
  // 공개 프로필과 같은 규칙: 표시명 판은 대표 케이스를 읽을 때도 비우고, "물어보면 좋은 질문"은 실명 판에서만(E-06).
  const view = await buildPortfolioView(db, isReal ? model : { ...model, featured: [], evidence: [] }, now, { askQuestions: isReal })
  const base = toPublicProfileDto({ displayName }, profile)
  // 열람 횟수만(누가·언제는 남기지 않음). 같은 요청 안에서 철회가 커밋됐으면 올리지 않습니다.
  await db
    .update(portfolioShareLinks)
    .set({ viewCount: sql`${portfolioShareLinks.viewCount} + 1` })
    .where(and(eq(portfolioShareLinks.id, link.id), isNull(portfolioShareLinks.revokedAt)))
  return {
    handle: base.handle,
    displayName: base.displayName,
    kind: persona.kind,
    jobTargets: base.jobTargets,
    schoolLabel: base.schoolLabel,
    gradTerm: base.gradTerm,
    contactText: CONTACT_POLICY_TEXT[base.contactPolicy],
    openToWork: base.openToWork,
    ...view,
    headline: view.headline ?? base.headline,
    edition: { version: edition.version, createdAt: edition.createdAt.toISOString() },
    expiresAt: link.expiresAt.toISOString(),
  }
}
