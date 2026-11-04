import { communitySpaces, eq, type DbExecutor } from '@peerchive/db'
import { loadScheduledChange, nameModeNow } from '../server/modules/community/name-modes'
import { spaceMemberRefKey } from '../server/modules/community/space-member-refs'

/** 멤버 목록이 그 사람을 가리키는 값(실명 방은 사용자 id, 표시명·익명 방은 방별 키). 관리 경로에 넘기는 값과 같습니다. */
export async function memberRef(tx: DbExecutor, slug: string, userId: string, now = new Date()): Promise<string> {
  const [space] = await tx.select().from(communitySpaces).where(eq(communitySpaces.slug, slug))
  const { mode } = nameModeNow(space!.currentNameMode, await loadScheduledChange(tx, space!.id), now)
  return mode === 'real' ? userId : spaceMemberRefKey(space!.id, userId)
}
