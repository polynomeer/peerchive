/**
 * worker가 내는 분석 이벤트(웹 emitAnalytics와 같은 규칙: 허용 목록·수집 거부·active 계정·HMAC, ADR 0016).
 * pepper가 없거나(개발 외 미설정) 사람이 없으면(탈퇴 정리) 건너뜁니다. 기록했으면 true.
 * S-07(ADR 0036): 공개 프로필·팔로우 이벤트는 `social: true`로 시각을 시 단위로 내립니다(웹 emitSocialAnalytics와 같음).
 */
import { type AnalyticsEventName, sanitizeAnalyticsProps, socialEventTime } from '@peerchive/domain'
import { analyticsEvents, eq, hashSubject, pepperKeyId, users, type DbExecutor } from '@peerchive/db'

export interface WorkerAnalyticsInput {
  name: AnalyticsEventName
  actorId: string | null
  props?: Readonly<Record<string, unknown>>
  now: Date
  social?: boolean
}

export async function emitWorkerAnalytics(db: DbExecutor, pepper: string | null | undefined, input: WorkerAnalyticsInput): Promise<boolean> {
  if (!pepper || !input.actorId) return false
  const checked = sanitizeAnalyticsProps(input.name, input.props ?? {})
  if (!checked.ok) {
    console.warn(`[worker] analytics dropped ${input.name}: props not allowed (${checked.violations.join(',')})`)
    return false
  }
  const [user] = await db.select({ optOut: users.analyticsOptOut, status: users.status }).from(users).where(eq(users.id, input.actorId)).limit(1)
  if (!user || user.optOut || user.status !== 'active') return false
  await db.insert(analyticsEvents).values({
    name: input.name,
    actorHash: hashSubject(pepper, input.actorId),
    hashKeyId: pepperKeyId(pepper),
    props: checked.props,
    occurredAt: input.social ? socialEventTime(input.now) : input.now,
  })
  return true
}
