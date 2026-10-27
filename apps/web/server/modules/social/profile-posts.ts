/**
 * 프로필 글 (S-05, PROOFU_EVOLUTION_PLAN §10.7, SYSTEM_DESIGN §6.7.1 ProfilePost·PersonaActivity, DELIVERY_PLAN §4.2 S-05, ADR 0035).
 *
 * social 모듈입니다: 커뮤니티 글 테이블·커뮤니티 모듈을 import하지 않습니다(S-02 경계 테스트).
 *
 * - 내 페르소나(실명·표시명 어느 쪽이든)의 프로필에 짧은 글(1~500자, @peerchive/domain normalizeProfilePostBody)을 씁니다. 남의 페르소나·없는 id는
 *   404, 공개 프로필이 없는 페르소나는 409 `profile_required`, 한도(`PROFILE_POST_RATE_LIMIT`) 초과 429.
 * - **미디어는 이번 범위가 아닙니다**(ADR 0035 후속): `mediaVersionIds`에 무엇이든 넣으면 422 `not_supported`. DB check도 빈 배열만 받습니다.
 * - 노출은 그 페르소나의 `posts` 공개 범위를 따릅니다(활동 목록·피드의 `canViewActivityKind`).
 * - **투영**: 프로필 글은 social이 소유한 원천이라 outbox를 거치지 않고 **같은 트랜잭션에서** 페르소나 활동으로 투영합니다(`projectPersonaActivity`,
 *   DB 트리거가 원본 행으로 다시 확인). 쓰자마자 내 프로필·팔로워 피드에 나타납니다.
 * - **지우기**는 status = deleted(본문 비움)이고, 상태가 바뀌는 같은 트랜잭션에서 DB 트리거가 활동의 withdrawn_at을 채웁니다(운영 숨김 hidden도 같음,
 *   S-07). 숨긴 글은 지울 수 없습니다(409 `hidden`, 운영 조치의 근거 보존).
 * - 감사 기록은 남기지 않습니다(일상 글쓰기, 팔로우와 같은 기준). 알림도 없습니다(ADR 0035: 알림 미룸).
 */
import { z } from 'zod'
import { and, eq, personas, profilePosts, profiles, type DbExecutor } from '@peerchive/db'
import { PROFILE_POST_RATE_LIMIT, normalizeProfilePostBody } from '@peerchive/domain'
import { type Actor, conflict, invalid, notFound, rateLimited } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import { projectPersonaActivity } from './activities'
import type { ProfilePostDto } from '../../../shared/types/api'

async function myPersona(db: DbExecutor, actor: Actor, rawId: unknown, lock = false) {
  const id = z.uuid().safeParse(rawId)
  if (!id.success) throw notFound()
  const query = db
    .select({ id: personas.id, userId: personas.userId, status: personas.status, profile: profiles.personaId })
    .from(personas)
    .leftJoin(profiles, eq(profiles.personaId, personas.id))
    .where(and(eq(personas.id, id.data.toLowerCase()), eq(personas.userId, actor.userId)))
    .limit(1)
  const [row] = lock ? await query.for('update', { of: personas }) : await query
  if (!row) throw notFound()
  return row
}

/** POST /personas/:id/posts {body} — 내 페르소나의 프로필 글. */
export async function createProfilePost(db: DbExecutor, actor: Actor, rawPersonaId: unknown, rawInput: unknown, now = new Date()): Promise<ProfilePostDto> {
  await myPersona(db, actor, rawPersonaId)
  const input = (rawInput ?? {}) as { body?: unknown; mediaVersionIds?: unknown }
  if (input.mediaVersionIds !== undefined && !(Array.isArray(input.mediaVersionIds) && input.mediaVersionIds.length === 0))
    throw invalid({ mediaVersionIds: 'not_supported' })
  const body = normalizeProfilePostBody(input.body)
  if (!body.ok) throw invalid({ body: body.reason })
  return db.transaction(async (tx) => {
    const persona = await myPersona(tx, actor, rawPersonaId, true)
    if (persona.status !== 'active') throw notFound()
    if (!persona.profile) throw conflict('profile_required')
    if (!(await hitRateLimit(tx, 'profile_post_create', actor.userId, PROFILE_POST_RATE_LIMIT, now))) throw rateLimited()
    const [row] = await tx
      .insert(profilePosts)
      .values({ personaId: persona.id, userId: actor.userId, body: body.body, status: 'published', createdAt: now })
      .returning()
    const projected = await projectPersonaActivity(tx, {
      personaId: persona.id,
      sourceId: row!.id,
      source: { type: 'profile_post', ownPersonaId: persona.id, published: true },
      occurredAt: now,
    })
    // 규칙상 늘 투영됩니다. 아니면 코드 오류이므로 글도 남기지 않습니다.
    if (!projected.projected) throw new Error(`profile post projection refused: ${projected.reason}`)
    return { id: row!.id, personaId: persona.id, body: row!.body, createdAt: row!.createdAt.toISOString() }
  })
}

/** DELETE /personas/:id/posts/:postId — 내 프로필 글 지우기(본문 비움, 이미 지웠으면 그대로 204). 숨긴 글 409 `hidden`. */
export async function deleteProfilePost(db: DbExecutor, actor: Actor, rawPersonaId: unknown, rawPostId: unknown, now = new Date()): Promise<void> {
  const postId = z.uuid().safeParse(rawPostId)
  if (!postId.success) throw notFound()
  await db.transaction(async (tx) => {
    const persona = await myPersona(tx, actor, rawPersonaId)
    const [post] = await tx
      .select({ id: profilePosts.id, status: profilePosts.status })
      .from(profilePosts)
      .where(and(eq(profilePosts.id, postId.data.toLowerCase()), eq(profilePosts.personaId, persona.id), eq(profilePosts.userId, actor.userId)))
      .limit(1)
      .for('update')
    if (!post) throw notFound()
    if (post.status === 'deleted') return
    if (post.status === 'hidden') throw conflict('hidden')
    // 상태 변경과 같은 트랜잭션에서 DB 트리거(profile_posts_persona_activity_sync)가 활동을 거둡니다.
    await tx.update(profilePosts).set({ status: 'deleted', body: '', deletedAt: now }).where(eq(profilePosts.id, post.id))
  })
}
