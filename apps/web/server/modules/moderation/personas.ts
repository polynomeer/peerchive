/**
 * 페르소나·프로필 글·소셜 링크 신고의 운영자 화면과 주인 확인 (S-07, SYSTEM_DESIGN §8.3 표 "표시명 ↔ 실명 연결 보기 — 운영자: 신고 처리 시 감사 기록과
 * 함께", ADR 0028·0036).
 *
 * - **운영자 화면은 신고된 페르소나 자신만**: handle·이름·한 줄 소개 등 그 페르소나의 공개 프로필 필드와 그 페르소나의 소셜 링크(숨긴 것 포함), 신고된
 *   글·링크 하나. 같은 사람의 다른 페르소나·연결(identity_links)·계정 id·이메일은 읽지도 싣지도 않습니다. 표시명 페르소나 신고가 운영 화면에서 실명
 *   handle과 이어지지 않습니다.
 * - **주인 확인**(`POST /operator/persona-owner-lookups {reportId, reason}`): 계정 단위 조치(정지 — RUNBOOK 운영 절차)가 필요할 때만, 페르소나·프로필 글·
 *   소셜 링크 신고 하나에 대해 사유(1~1000자)를 적어야 합니다. 한 트랜잭션에서 확인 기록(사유는 여기에만) + 감사 `persona.owner_lookup`(행위자 운영자,
 *   대상 페르소나 id, metadata는 `lookupId`·`reportId`뿐) 뒤 201로 주인 계정 id·상태·그 사람의 페르소나 전부·연결 공개 여부·걸린 숨김 조치 수를 돌려줍니다.
 *   결과는 이 응답에만 있고 신고 상세·목록 어디에도 다시 나오지 않습니다. 커뮤니티 작성자 확인(C-06, ADR 0023)과 같은 모양입니다.
 * - 운영자 시간당 확인 한도(`PERSONA_OWNER_LOOKUP_RATE_LIMIT`, 429): 한꺼번에 많은 페르소나를 풀어 보는 일을 막습니다.
 */
import { z } from 'zod'
import { MODERATION_NOTE_MAX } from '@peerchive/domain'
import {
  and,
  eq,
  identityLinks,
  inArray,
  isNull,
  moderationActions,
  or,
  personaOwnerLookups,
  personas,
  profilePosts,
  profiles,
  reports,
  socialLinks,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { requireOperator } from '../catalog/operators'
import { type Actor, conflict, invalid, notFound, rateLimited } from '../errors'
import { type RateLimitRule, hitRateLimit } from '../security/rate-limit'
import { personaDisplayName } from '../social/personas'
import { parseInput } from '../validation'
import type { OperatorPersonaRefDto, OperatorTargetContentDto, PersonaOwnerLookupResultDto } from '../../../shared/types/api'

type ReportRow = typeof reports.$inferSelect

export const PERSONA_OWNER_LOOKUP_RATE_LIMIT: RateLimitRule = { limit: 20, windowMs: 60 * 60 * 1000 }

const PERSONA_TARGETS = ['persona', 'profile_post', 'social_link'] as const

/** 신고가 가리키는 페르소나 id(글·링크는 그 글·링크의 페르소나). 대상이 탈퇴 정리로 지워졌으면 null. */
async function reportedPersonaId(db: DbExecutor, report: Pick<ReportRow, 'targetType' | 'personaId' | 'profilePostId' | 'socialLinkId'>): Promise<string | null> {
  if (report.targetType === 'persona') return report.personaId
  if (report.targetType === 'profile_post' && report.profilePostId) {
    const [row] = await db.select({ personaId: profilePosts.personaId }).from(profilePosts).where(eq(profilePosts.id, report.profilePostId)).limit(1)
    return row?.personaId ?? null
  }
  if (report.targetType === 'social_link' && report.socialLinkId) {
    const [row] = await db.select({ personaId: socialLinks.personaId }).from(socialLinks).where(eq(socialLinks.id, report.socialLinkId)).limit(1)
    return row?.personaId ?? null
  }
  return null
}

/** 그 페르소나 자신의 이름표(다른 페르소나·연결을 읽지 않음). */
async function personaRef(db: DbExecutor, personaId: string): Promise<(OperatorPersonaRefDto & { profile: typeof profiles.$inferSelect | null }) | null> {
  const [row] = await db
    .select({ persona: personas, profile: profiles, accountName: users.displayName })
    .from(personas)
    .innerJoin(users, eq(users.id, personas.userId))
    .leftJoin(profiles, eq(profiles.personaId, personas.id))
    .where(eq(personas.id, personaId))
    .limit(1)
  if (!row) return null
  return {
    kind: row.persona.kind,
    handle: row.persona.handle,
    displayName: personaDisplayName(row.persona, row.accountName),
    hidden: row.profile?.hiddenAt != null,
    profile: row.profile,
  }
}

const unavailable = (message: string) => ({ content: { kind: 'unavailable' as const, message }, publicPath: null, servedNow: false })

/** 운영자 신고 상세의 내용(페르소나·프로필 글·소셜 링크). 지금 행을 읽습니다(내용 복사 없음 — 탈퇴 정리 뒤에는 "찾을 수 없음"). */
export async function personaReportContent(
  db: DbExecutor,
  report: ReportRow,
): Promise<{ content: OperatorTargetContentDto; publicPath: string | null; servedNow: boolean }> {
  const personaId = await reportedPersonaId(db, report)
  const ref = personaId ? await personaRef(db, personaId) : null
  if (!ref) return unavailable('대상을 찾을 수 없습니다(탈퇴 정리로 지워졌을 수 있습니다).')
  const { profile, ...persona } = ref
  const [account] = await db
    .select({ status: users.status, personaStatus: personas.status })
    .from(personas)
    .innerJoin(users, eq(users.id, personas.userId))
    .where(eq(personas.id, personaId!))
    .limit(1)
  const personaPublic = !!profile && !persona.hidden && account?.status === 'active' && account.personaStatus === 'active'
  const profilePath = personaPublic ? `/u/${persona.handle}` : null
  if (report.targetType === 'persona') {
    const links = await db
      .select({ provider: socialLinks.provider, url: socialLinks.url, verification: socialLinks.verification, hiddenAt: socialLinks.hiddenAt })
      .from(socialLinks)
      .where(eq(socialLinks.personaId, personaId!))
    return {
      content: {
        kind: 'persona',
        persona: {
          ...persona,
          headline: profile?.headline ?? null,
          jobTargets: profile?.jobTargets ?? [],
          schoolLabel: profile?.schoolLabel ?? null,
          gradTerm: profile?.gradTerm ?? null,
          socialLinks: links.map((l) => ({ provider: l.provider, url: l.url, verified: l.verification === 'verified', hidden: l.hiddenAt !== null })),
        },
      },
      publicPath: profilePath,
      servedNow: personaPublic,
    }
  }
  if (report.targetType === 'profile_post') {
    const [post] = await db.select().from(profilePosts).where(eq(profilePosts.id, report.profilePostId!)).limit(1)
    if (!post) return unavailable('프로필 글을 찾을 수 없습니다.')
    return {
      content: { kind: 'profile_post', persona, post: { body: post.body, status: post.status, createdAt: post.createdAt.toISOString() } },
      publicPath: profilePath,
      servedNow: personaPublic && post.status === 'published',
    }
  }
  const [link] = await db.select().from(socialLinks).where(eq(socialLinks.id, report.socialLinkId!)).limit(1)
  if (!link) return unavailable('소셜 링크를 찾을 수 없습니다(본인이 지웠을 수 있습니다).')
  return {
    content: { kind: 'social_link', persona, link: { provider: link.provider, url: link.url, verification: link.verification, hidden: link.hiddenAt !== null } },
    publicPath: profilePath,
    servedNow: personaPublic && link.hiddenAt === null,
  }
}

// ── 주인 확인 ─────────────────────────────────────────────────────────────

const requiredOr = (code: string) => (issue: { input?: unknown }) => (issue.input === undefined ? 'required' : code)

export const personaOwnerLookupSchema = z.object({
  reportId: z.uuid({ error: requiredOr('invalid') }).transform((v) => v.toLowerCase()),
  reason: z
    .string({ error: requiredOr('invalid') })
    .trim()
    .min(1, { error: 'required' })
    .max(MODERATION_NOTE_MAX, { error: 'too_long' }),
})

/**
 * POST /operator/persona-owner-lookups {reportId, reason} — 201. 운영자만(403), 없는 신고 404, 페르소나·프로필 글·소셜 링크 신고가 아니면 422
 * `reportId: not_persona_target`, 사유 없음 422, 대상이 탈퇴 정리로 지워졌으면 409 `target_unavailable`(기록 없음), 한도 429.
 */
export async function lookupPersonaOwner(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<PersonaOwnerLookupResultDto> {
  await requireOperator(db, actor)
  const input = parseInput(personaOwnerLookupSchema, rawInput)
  return db.transaction(async (tx) => {
    const [report] = await tx.select().from(reports).where(eq(reports.id, input.reportId)).limit(1)
    if (!report) throw notFound()
    if (!(PERSONA_TARGETS as readonly string[]).includes(report.targetType)) throw invalid({ reportId: 'not_persona_target' })
    const personaId = await reportedPersonaId(tx, report)
    const [persona] = personaId ? await tx.select({ id: personas.id, userId: personas.userId }).from(personas).where(eq(personas.id, personaId)).limit(1) : []
    // 탈퇴 정리로 대상이 지워졌으면 확인할 주인이 없습니다(기록도 남기지 않음).
    if (!persona) throw conflict('target_unavailable')
    if (!(await hitRateLimit(tx, 'persona_owner_lookup', actor.userId, PERSONA_OWNER_LOOKUP_RATE_LIMIT, now))) throw rateLimited()
    const [lookup] = await tx
      .insert(personaOwnerLookups)
      .values({ operatorId: actor.userId, reportId: report.id, personaId: persona.id, ownerUserId: persona.userId, reason: input.reason, createdAt: now })
      .returning({ id: personaOwnerLookups.id })
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'persona.owner_lookup',
      targetType: 'persona',
      targetId: persona.id,
      metadata: { lookupId: lookup!.id, reportId: report.id },
    })
    const [account] = await tx.select({ status: users.status }).from(users).where(eq(users.id, persona.userId)).limit(1)
    const own = await tx.select({ id: personas.id }).from(personas).where(eq(personas.userId, persona.userId))
    const refs = (await Promise.all(own.map((p) => personaRef(tx, p.id)))).filter((r): r is NonNullable<typeof r> => !!r).map(({ profile: _p, ...r }) => r)
    const [link] = await tx.select({ visible: identityLinks.visible }).from(identityLinks).where(eq(identityLinks.userId, persona.userId)).limit(1)
    const ownIds = own.map((p) => p.id)
    const [active] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(moderationActions)
      .where(
        and(
          isNull(moderationActions.reversedAt),
          or(
            eq(moderationActions.profileUserId, persona.userId),
            ownIds.length ? inArray(moderationActions.personaId, ownIds) : sql`false`,
            sql`${moderationActions.profilePostId} in (select id from ${profilePosts} where user_id = ${persona.userId})`,
            sql`${moderationActions.socialLinkId} in (select id from ${socialLinks} where user_id = ${persona.userId})`,
          ),
        ),
      )
    return {
      lookupId: lookup!.id,
      owner: {
        userId: persona.userId,
        accountStatus: account?.status ?? 'deleted',
        personas: refs,
        linkVisible: link?.visible ?? false,
        activeActions: active?.n ?? 0,
      },
    }
  })
}
