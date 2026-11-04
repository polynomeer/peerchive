/**
 * 방 멤버 목록의 멤버 참조(ADR 0060 D-01 보완).
 *
 * 표시명·익명 방의 멤버 목록에서 이름만 가리면 부족합니다. 같은 사람과 과제나 실명 방을 함께 쓰는 방장·운영진이 그쪽 응답의 사용자 id와 맞춰 보면
 * 표시명이 누구인지 알 수 있습니다. 그래서 이런 방에서는 다른 사람의 사용자 id도 내보내지 않습니다(같은 위협을 막는 projects/member-refs.ts와 같은 방식).
 *
 * - 출력: `rm_` + HMAC-SHA256(PEERCHIVE_MEMBER_REF_PEPPER, `space-member-ref:v1:<방 id>:<사용자 id>`) 앞 16자. 방마다 다르고 저장하지 않습니다.
 *   본인 id는 그대로 둡니다(화면의 "나" 판정이 `me.id`와 비교).
 * - 입력: 이런 방의 관리 경로는 이 키 또는 본인 id만 받습니다. 다른 사람의 실제 id는 404입니다(아는 id로 그 사람이 멤버인지 떠보지 못하게).
 * - 실명 방은 사용자 id 그대로입니다.
 */
import { createHmac } from 'node:crypto'
import { eq, spaceMemberships, type DbExecutor } from '@peerchive/db'
import { memberRefPepper } from '../projects/member-refs'

const SPACE_MEMBER_REF_PATTERN = /^rm_[0-9a-f]{16}$/

export function spaceMemberRefKey(spaceId: string, userId: string, pepper = memberRefPepper()): string {
  const digest = createHmac('sha256', pepper).update(`space-member-ref:v1:${spaceId.toLowerCase()}:${userId.toLowerCase()}`).digest('hex')
  return `rm_${digest.slice(0, 16)}`
}

/** 키 → 그 방 멤버십의 사용자 id. 모양이 다르거나 그 방 멤버십에 없으면 null. */
export async function resolveSpaceMemberRef(db: DbExecutor, spaceId: string, ref: string): Promise<string | null> {
  const value = ref.trim().toLowerCase()
  if (!SPACE_MEMBER_REF_PATTERN.test(value)) return null
  const pepper = memberRefPepper()
  const rows = await db.select({ userId: spaceMemberships.userId }).from(spaceMemberships).where(eq(spaceMemberships.spaceId, spaceId))
  return rows.find((r) => spaceMemberRefKey(spaceId, r.userId, pepper) === value)?.userId ?? null
}
