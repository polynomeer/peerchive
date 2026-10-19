/**
 * DB 기반 고정 창 rate limit. 여러 서버 인스턴스가 같은 DB를 쓰면 함께 적용됩니다.
 * 정확한 슬라이딩 창이 아니라 창 경계에서 최대 2배까지 허용될 수 있습니다(초기 pilot 규모에서 허용).
 */
import { sql, rateLimitBuckets, type DbExecutor } from '@peerchive/db'
import { sha256Hex } from './tokens'

export interface RateLimitRule {
  /** 창 안에서 허용하는 최대 횟수. */
  limit: number
  windowMs: number
}

/**
 * 카운터를 1 올리고 허용 여부를 돌려줍니다. key의 식별자 부분은 해시해서 저장합니다
 * (이메일·IP 원문을 DB에 남기지 않음).
 */
export async function hitRateLimit(
  db: DbExecutor,
  scope: string,
  identifier: string,
  rule: RateLimitRule,
  now: Date,
): Promise<boolean> {
  const windowStart = new Date(Math.floor(now.getTime() / rule.windowMs) * rule.windowMs)
  const key = `${scope}:${sha256Hex(identifier)}`
  const [row] = await db
    .insert(rateLimitBuckets)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.key, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count })
  return (row?.count ?? Number.POSITIVE_INFINITY) <= rule.limit
}
