/**
 * GitHub 근거 후보 조회(E-11, ADR 0056).
 *
 * - 과제 멤버(읽기 전용 포함)만 봅니다. 비공개 저장소의 커밋 제목도 이 경로로만 나가며 공개 DTO·검색·스냅샷·기여 장부 집계에는 쓰지 않습니다.
 * - 멤버마다 그 사람이 연결한 GitHub 계정이 작성한 후보만(최근 30개). 계정을 연결하지 않은 멤버는 빈 목록입니다.
 * - 후보는 **확정되지 않은 재료**입니다. 본인이 역할 선언 근거로 고르거나(claims.ts `{kind:'github', id}`) 로그 링크로 직접 붙일 때만 쓰입니다.
 */
import { and, asc, desc, eq, githubItems, inArray, integrations, isNull, profiles, projectMembers, users, type DbExecutor } from '@peerchive/db'
import { orderMembersByName } from '@peerchive/domain'
import { notFound, type Actor } from '../errors'
import { loadReadableProject } from '../projects/access'
import { activeLink } from './connect'
import type { GithubCandidatesDto, GithubItemDto } from '../../../shared/types/api'

export const CANDIDATES_PER_MEMBER = 30

type ItemRow = typeof githubItems.$inferSelect

export const itemRef = (row: Pick<ItemRow, 'kind' | 'sha' | 'number'>) => (row.kind === 'commit' ? (row.sha ?? '').slice(0, 7) : `#${row.number}`)

export function toItemDto(row: ItemRow): GithubItemDto {
  return {
    id: row.id,
    kind: row.kind,
    ref: itemRef(row),
    title: row.title,
    url: row.url,
    occurredAt: row.occurredAt.toISOString(),
    prState: row.prState,
  }
}

/** `mine`이면 요청자 자신만(선언 폼의 후보 목록). */
export async function listGithubCandidates(db: DbExecutor, actor: Actor, projectId: unknown, options: { mine?: boolean } = {}): Promise<GithubCandidatesDto> {
  const { project } = await loadReadableProject(db, actor, projectId)
  if (project.kind === 'study') throw notFound()
  const link = await activeLink(db, project.id)
  if (!link) return { linked: false, members: [] }
  const members = await db
    .select({
      userId: projectMembers.userId,
      displayName: users.displayName,
      handle: profiles.handle,
      githubId: integrations.externalId,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .leftJoin(profiles, eq(profiles.userId, projectMembers.userId))
    .leftJoin(
      integrations,
      and(eq(integrations.userId, projectMembers.userId), eq(integrations.provider, 'github'), isNull(integrations.revokedAt)),
    )
    .where(
      and(
        eq(projectMembers.projectId, project.id),
        eq(projectMembers.status, 'active'),
        options.mine ? eq(projectMembers.userId, actor.userId) : undefined,
      ),
    )
    .orderBy(asc(projectMembers.userId))
  const result = []
  for (const member of orderMembersByName(members)) {
    const items = member.githubId
      ? await db
          .select()
          .from(githubItems)
          .where(and(eq(githubItems.linkId, link.id), eq(githubItems.authorGithubId, Number(member.githubId))))
          .orderBy(desc(githubItems.occurredAt), desc(githubItems.id))
          .limit(CANDIDATES_PER_MEMBER)
      : []
    result.push({
      member: { userId: member.userId, displayName: member.displayName, handle: member.handle },
      identityLinked: !!member.githubId,
      items: items.map(toItemDto),
    })
  }
  return { linked: true, members: result }
}

/** 선언 근거로 고른 후보(지금 연결된 저장소의 같은 과제 후보이고 작성자가 그 회원의 GitHub 계정인 것만). */
export async function attachableGithubItems(db: DbExecutor, projectId: string, githubUserId: number | null, ids: readonly string[]): Promise<Map<string, ItemRow>> {
  if (ids.length === 0 || githubUserId === null) return new Map()
  const link = await activeLink(db, projectId)
  if (!link) return new Map()
  const rows = await db
    .select()
    .from(githubItems)
    .where(and(inArray(githubItems.id, [...ids]), eq(githubItems.linkId, link.id), eq(githubItems.projectId, projectId), eq(githubItems.authorGithubId, githubUserId)))
  return new Map(rows.map((row) => [row.id, row]))
}
