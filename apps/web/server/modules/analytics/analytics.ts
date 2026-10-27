/**
 * pilot 분석 이벤트 기록(T-16, DELIVERY_PLAN §6, ADR 0016).
 *
 * - 서비스가 업무 변경과 **같은 트랜잭션**에서 `emitAnalytics(tx, …)`를 부릅니다(행 하나 insert라 싸고, 업무가 되돌려지면 이벤트도 사라짐).
 * - 주체·프로젝트는 원문 id 대신 HMAC-SHA256(분석 pepper, id)만 저장합니다. pepper가 없으면(production에서 미설정·약한 값) 기록하지 않습니다.
 * - props는 @peerchive/domain의 허용 목록(sanitizeAnalyticsProps)만 통과합니다. 목록 밖이면 이벤트 전체를 버리고 키 이름만 경고합니다.
 * - 익명 커뮤니티 글·댓글(C-04)은 `unlinked`로 사용자 키 없이 기록합니다.
 * - 수집 거부(users.analytics_opt_out)한 사람은 기록하지 않습니다. 거부하면 그 사람의 지난 이벤트도 지웁니다(setAnalyticsOptOut).
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { type AnalyticsEventName, sanitizeAnalyticsProps } from '@peerchive/domain'
import {
  ANALYTICS_PEPPER_ENV,
  analyticsEvents,
  and,
  eq,
  hashSubject,
  pepperKeyId,
  resolvePepper,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { type Actor, notFound } from '../errors'
import { parseInput } from '../validation'

type Env = Readonly<Record<string, string | undefined>>

let envOverride: Env | null = null
/** 테스트용: 환경 변수 대신 쓸 값(null이면 process.env). */
export function setAnalyticsEnvForTesting(env: Env | null): void {
  envOverride = env
}

/** 실행 시 환경(빌드 도구가 process.env.NODE_ENV를 상수로 바꾸므로 대괄호 접근). */
function currentEnv(): Env {
  if (envOverride) return envOverride
  const env = (globalThis.process?.env ?? {}) as Env
  return { NODE_ENV: env['NODE_ENV'], [ANALYTICS_PEPPER_ENV]: env[ANALYTICS_PEPPER_ENV] }
}

export function analyticsPepper(): string | null {
  return resolvePepper(currentEnv(), ANALYTICS_PEPPER_ENV)
}

export interface AnalyticsInput {
  name: AnalyticsEventName
  actorId: string
  /**
   * 사용자 키 없이 기록(C-04 익명 글·댓글, SYSTEM_DESIGN §6.7 "익명 글과 프로필의 분리"). 수집 거부·계정 상태는 그대로 확인하고, actor_hash에는
   * 이벤트마다 새 무작위 값의 HMAC을 넣어 같은 사람의 다른 이벤트와 이어지지 않게 합니다(탈퇴 정리로 지울 수 없지만 사람과 이어지지 않음).
   */
  unlinked?: boolean
  projectId?: string | null
  props?: Readonly<Record<string, unknown>>
  now?: Date
}

/** 이벤트 하나 기록. 기록했으면 true(수집 거부·pepper 없음·허용 목록 위반이면 false). 예외를 던지지 않는 쪽을 기본으로 합니다. */
export async function emitAnalytics(db: DbExecutor, input: AnalyticsInput): Promise<boolean> {
  const pepper = analyticsPepper()
  if (!pepper) return false
  const checked = sanitizeAnalyticsProps(input.name, input.props ?? {})
  if (!checked.ok) {
    console.warn(`[analytics] dropped ${input.name}: props not allowed (${checked.violations.join(',')})`)
    return false
  }
  const [user] = await db.select({ optOut: users.analyticsOptOut, status: users.status }).from(users).where(eq(users.id, input.actorId)).limit(1)
  if (!user || user.optOut || user.status !== 'active') return false
  await db.insert(analyticsEvents).values({
    name: input.name,
    actorHash: hashSubject(pepper, input.unlinked ? `unlinked:${randomUUID()}` : input.actorId),
    projectHash: input.projectId && !input.unlinked ? hashSubject(pepper, input.projectId) : null,
    hashKeyId: pepperKeyId(pepper),
    props: checked.props,
    ...(input.now && { occurredAt: input.now }),
  })
  return true
}

const preferenceSchema = z.object({ analyticsOptOut: z.boolean({ error: 'invalid' }) })

/** PATCH /me/preferences {analyticsOptOut}. 거부로 바꾸면 그 사람의 지난 이벤트(지금 pepper 기준)도 지웁니다. */
export async function setAnalyticsOptOut(db: DbExecutor, actor: Actor, rawInput: unknown): Promise<{ analyticsOptOut: boolean; deletedEvents: number }> {
  const input = parseInput(preferenceSchema, rawInput)
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ analyticsOptOut: input.analyticsOptOut, updatedAt: new Date() })
      .where(and(eq(users.id, actor.userId), eq(users.status, 'active')))
      .returning({ id: users.id })
    if (updated.length === 0) throw notFound()
    let deletedEvents = 0
    const pepper = analyticsPepper()
    if (input.analyticsOptOut && pepper) {
      deletedEvents = (
        await tx.delete(analyticsEvents).where(eq(analyticsEvents.actorHash, hashSubject(pepper, actor.userId))).returning({ id: analyticsEvents.id })
      ).length
    }
    return { analyticsOptOut: input.analyticsOptOut, deletedEvents }
  })
}
