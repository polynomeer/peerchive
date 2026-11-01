/**
 * pilot 분석 이벤트 기록(T-16, DELIVERY_PLAN §6, ADR 0016).
 *
 * - 서비스가 업무 변경과 **같은 트랜잭션**에서 `emitAnalytics(tx, …)`를 부릅니다(행 하나 insert라 싸고, 업무가 되돌려지면 이벤트도 사라짐).
 * - 주체·프로젝트는 원문 id 대신 HMAC-SHA256(분석 pepper, id)만 저장합니다. pepper가 없으면(production에서 미설정·약한 값) 기록하지 않습니다.
 * - props는 @peerchive/domain의 허용 목록(sanitizeAnalyticsProps)만 통과합니다. 목록 밖이면 이벤트 전체를 버리고 키 이름만 경고합니다.
 * - 익명 커뮤니티 글·댓글(C-04)은 `unlinked`로 사용자 키 없이(actor_hash null, C-10·ADR 0027) 기록합니다.
 * - 수집 거부(users.analytics_opt_out)한 사람은 기록하지 않습니다. 거부하면 그 사람의 지난 이벤트도 지웁니다(setAnalyticsOptOut).
 * - 공개 프로필·팔로우 이벤트(S-07, DELIVERY_PLAN §6.2, ADR 0036)는 `emitSocialAnalytics`로: 사용자 키는 붙이고, 페르소나 id·handle·상대방 키는
 *   허용 목록에 자리가 없으며, 시각은 시 단위로 내립니다(팔로우·차단 행의 정확한 시각과 맞춰 페르소나와 사용자 키를 잇기 어렵게).
 * - §6.2 P2 이벤트(A-07, ADR 0045)는 `emitP2Analytics`로: 같은 시 단위 시각, 프로젝트 키 없음. 익명 방의 일정·응답, 익명·소속 표시 익명 토픽 글,
 *   익명 수료 회고는 `unlinked`(사용자 키 없음)로 부릅니다. 방·글·기관·기수·페르소나 id는 허용 목록에 자리가 없습니다.
 */
import { z } from 'zod'
import { type AnalyticsEventName, sanitizeAnalyticsProps, socialEventTime } from '@peerchive/domain'
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
   * 사용자 키 없이 기록(C-04 익명 글·댓글, SYSTEM_DESIGN §6.7 "익명 글과 프로필의 분리", DELIVERY_PLAN §6.1). 수집 거부·계정 상태는 그대로 확인하고,
   * actor_hash·project_hash는 null입니다(C-10, ADR 0027: 이전의 이벤트마다 무작위 HMAC 대신 — 사람 단위 지표가 키 없는 이벤트를 사람으로 세지 않게).
   * 탈퇴 정리로 지울 수 없지만 사람과 이어지지 않습니다.
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
    actorHash: input.unlinked ? null : hashSubject(pepper, input.actorId),
    projectHash: input.projectId && !input.unlinked ? hashSubject(pepper, input.projectId) : null,
    hashKeyId: pepperKeyId(pepper),
    props: checked.props,
    ...(input.now && { occurredAt: input.now }),
  })
  return true
}

/** 공개 프로필·팔로우 이벤트(S-07): 사용자 키 + 시 단위 시각(socialEventTime). 프로젝트 키·사용자 키 없는 기록은 쓰지 않습니다. */
export function emitSocialAnalytics(db: DbExecutor, input: Omit<AnalyticsInput, 'unlinked' | 'projectId'>): Promise<boolean> {
  return emitAnalytics(db, { ...input, now: socialEventTime(input.now ?? new Date()) })
}

/** §6.2 P2 이벤트(A-07): 시 단위 시각(socialEventTime), 프로젝트 키 없음. 익명 내용이면 호출자가 unlinked를 켭니다. */
export function emitP2Analytics(db: DbExecutor, input: Omit<AnalyticsInput, 'projectId'>): Promise<boolean> {
  return emitAnalytics(db, { ...input, now: socialEventTime(input.now ?? new Date()) })
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
