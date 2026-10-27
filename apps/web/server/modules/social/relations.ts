/**
 * 팔로우·차단 관계 조회(S-04, SYSTEM_DESIGN §6.7.1 Follow·Block·§8.3, ADR 0033). 판정 규칙은 @peerchive/domain(`blockHides`·`canFollow`)이고,
 * 이 파일은 그 판정에 필요한 행만 읽는 낮은 층입니다(visibility·follows·blocks가 함께 씀).
 *
 * - **숨김**: 페르소나 P가 사용자 V에게 숨겨졌다 = P의 주인이 V를 차단했고, 그 차단의 범위가 P를 덮음(origin이 P이거나 `all_personas`).
 *   차단은 사용자 단위(보는 사람의 세션 사용자)이므로 V가 어느 페르소나로 로그인해 있든 같습니다.
 * - 이 파일은 social 모듈입니다: 커뮤니티 테이블을 import하지 않습니다(S-02 경계 테스트).
 */
import { and, blocks, eq, follows, inArray, isNull, or, personas, profiles, sql, users, type DbExecutor, type SQL } from '@peerchive/db'

/** 페르소나(id, 주인)가 그 사용자에게 차단으로 숨겨졌는지. */
export async function isHiddenFrom(db: DbExecutor, persona: { id: string; userId: string }, viewerUserId: string): Promise<boolean> {
  if (persona.userId === viewerUserId) return false
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(blocks)
    .where(
      and(
        eq(blocks.blockerUserId, persona.userId),
        eq(blocks.blockedUserId, viewerUserId),
        or(eq(blocks.originPersonaId, persona.id), eq(blocks.scope, 'all_personas')),
      ),
    )
    .limit(1)
  return !!row
}

/**
 * SQL 조건: (personaId, userId) 열이 가리키는 페르소나가 그 사용자에게 숨겨지지 **않았음**. 팔로우 목록·개수에서 보는 사람에게 숨겨진 페르소나를 뺄 때 씁니다.
 */
type ColumnRef = Parameters<typeof eq>[0]

export function notHiddenFrom(personaId: ColumnRef, userId: ColumnRef, viewerUserId: string | null): SQL {
  if (!viewerUserId) return sql`true`
  return sql`not exists (select 1 from ${blocks} b where b.blocker_user_id = ${userId} and b.blocked_user_id = ${viewerUserId}
    and (b.origin_persona_id = ${personaId} or b.scope = 'all_personas'))`
}

/** 그 사용자가(어느 페르소나로든) 이 페르소나의 승인된(active) 팔로워인지. */
export async function isApprovedFollower(db: DbExecutor, followeePersonaId: string, viewerUserId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(follows)
    .where(and(eq(follows.followeePersonaId, followeePersonaId), eq(follows.followerUserId, viewerUserId), eq(follows.status, 'active')))
    .limit(1)
  return !!row
}

/**
 * 팔로우 목록에 보일 수 있는 상대 페르소나(personas·users·profiles를 내부 조인한 쿼리에서): 페르소나 active + 계정 active + 운영 숨김 아님
 * (`resolvePublicPersona`와 같은 조건).
 */
export const counterpartVisible = () => and(eq(personas.status, 'active'), eq(users.status, 'active'), isNull(profiles.hiddenAt))

/**
 * 내 페르소나마다 받은 대기 팔로우 요청 수(`GET /me/personas`의 `pendingFollowRequests`). 팔로우 관리 화면의 받은 요청 목록과 같은 조건
 * (요청한 페르소나가 공개 상태이고 나에게 숨겨지지 않음).
 */
export async function pendingRequestCounts(db: DbExecutor, ownerUserId: string, personaIds: string[]): Promise<Map<string, number>> {
  if (personaIds.length === 0) return new Map()
  const rows = await db
    .select({ personaId: follows.followeePersonaId, n: sql<number>`count(*)::int` })
    .from(follows)
    .innerJoin(personas, eq(personas.id, follows.followerPersonaId))
    .innerJoin(users, eq(users.id, personas.userId))
    .innerJoin(profiles, eq(profiles.personaId, personas.id))
    .where(
      and(
        inArray(follows.followeePersonaId, personaIds),
        eq(follows.status, 'pending'),
        counterpartVisible(),
        notHiddenFrom(follows.followerPersonaId, follows.followerUserId, ownerUserId),
      ),
    )
    .groupBy(follows.followeePersonaId)
  return new Map(rows.map((r) => [r.personaId, r.n]))
}
