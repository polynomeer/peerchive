/**
 * 소셜 링크 되돌림 확인·재확인 (S-06, SYSTEM_DESIGN §6.7.1 SocialLink·§10, DELIVERY_PLAN §5.2 V, ADR 0034).
 *
 * - 확인 요청: 웹이 `POST /social-links/:id/verify`에서 outbox `social_link.verify {socialLinkId}`를 남기면, 전달기가 이 큐로 옮기고 아래 handler가
 *   링크 수집기(net/safe-fetch.ts)로 그 주소의 HTML을 가져와 페르소나 공개 프로필 주소(`<사이트 origin>/u/<handle>`)로 가는 링크가 있는지 봅니다.
 * - 재확인(운영 주기 작업 `ops.social-link-recheck`, 기본 매시 37분): verified 링크 중 마지막 확인에서 24시간이 지난 것을 한 번에 최대 100개,
 *   동시에 4개씩 다시 봅니다. 링크마다 대략 하루 한 번입니다.
 * - 결과는 @peerchive/domain `nextSocialLinkState` 하나로 정합니다: 링크 있음 → verified, 페이지를 받았는데 링크 없음(404·410 포함) → verified였으면
 *   lost, 가져오기 실패·접속 거부 → 상태 유지 + 연속 실패 +1(verified가 3번 연속이면 lost).
 * - 확인은 지금 행 기준입니다(주소·handle을 payload에 싣지 않음). 링크가 지워졌거나 페르소나·계정이 비활성이면 접속하지 않습니다.
 * - 사이트 origin(NUXT_SITE_ORIGIN 첫 항목)이 없으면 무엇이 "우리 프로필 주소"인지 모르므로 접속하지 않고 그대로 둡니다(경고 로그).
 * - 로그에는 링크 id·결과 코드만 남기고 주소는 남기지 않습니다.
 * - 계측(S-07, DELIVERY_PLAN §6.2 `social_link_verified`): verified가 아니던 링크가 verified가 된 순간 주인 사용자 키로 서비스 종류만 기록합니다
 *   (주소·페르소나 id 없음, 수집 거부 존중). 재확인으로 verified가 유지되는 것은 세지 않습니다.
 */
import type { PgBoss } from 'pg-boss'
import {
  SOCIAL_LINK_VERIFY_TOPIC,
  and,
  asc,
  eq,
  isNull,
  lt,
  or,
  personas,
  socialLinks,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import {
  SOCIAL_LINK_RECHECK_INTERVAL_MS,
  type SocialLinkCheckResult,
  type SocialLinkFetchOutcome,
  type SocialLinkVerification,
  nextSocialLinkState,
  pageLinksTo,
  personaProfileUrl,
} from '@peerchive/domain'
import { emitWorkerAnalytics } from './analytics'
import type { TaskOutcome } from './ops/cleanup'
import { type SafeFetchResult, safeFetchHtml } from './net/safe-fetch'

export interface SocialLinkCheckDeps {
  /** 사이트 첫 origin(되돌림 링크가 가리켜야 하는 곳). 없으면 확인하지 않음. */
  siteOrigin: string | null
  /** HTML 가져오기. 기본은 safeFetchHtml(테스트는 로컬 서버용 훅을 넣은 것). */
  fetchHtml?: (url: string) => Promise<SafeFetchResult>
  /** 분석 pepper(S-07 social_link_verified). 없으면 이벤트를 남기지 않습니다. */
  analyticsPepper?: string | null
}

export const SOCIAL_LINK_QUEUE_OPTIONS = { retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInSeconds: 60 } as const
export const SOCIAL_LINK_RECHECK_BATCH = 100
const RECHECK_CONCURRENCY = 4

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseSocialLinkPayload(data: unknown): { socialLinkId: string } | null {
  if (!data || typeof data !== 'object') return null
  const id = (data as Record<string, unknown>).socialLinkId
  return typeof id === 'string' && UUID.test(id) ? { socialLinkId: id.toLowerCase() } : null
}

/** 가져오기 결과 → 상태 전이 입력과 본인 화면용 결과 코드. */
export function classifyFetch(result: SafeFetchResult, profileUrl: string): { outcome: SocialLinkFetchOutcome; code: SocialLinkCheckResult } {
  if (result.ok) return pageLinksTo(result.body, result.url, profileUrl) ? { outcome: 'found', code: 'found' } : { outcome: 'missing', code: 'missing' }
  // 페이지가 없어졌다는 확실한 응답은 "링크 없음"과 같게 봅니다(일시 오류가 아님).
  if (result.error === 'http_status' && (result.status === 404 || result.status === 410)) return { outcome: 'missing', code: 'missing' }
  if (result.error === 'blocked') return { outcome: 'error', code: 'blocked' }
  return { outcome: 'error', code: 'fetch_failed' }
}

export interface SocialLinkCheck {
  id: string
  verification: SocialLinkVerification
  result: SocialLinkCheckResult
}

/** 링크 하나 확인. 링크가 없거나 확인하지 않으면 null. */
export async function checkSocialLink(db: DbExecutor, linkId: string, deps: SocialLinkCheckDeps, now = new Date()): Promise<SocialLinkCheck | null> {
  if (!deps.siteOrigin) {
    console.warn('[worker] social_link: NUXT_SITE_ORIGIN is not set; skipping verification')
    return null
  }
  const [row] = await db
    .select({ link: socialLinks, handle: personas.handle })
    .from(socialLinks)
    .innerJoin(personas, eq(personas.id, socialLinks.personaId))
    .innerJoin(users, eq(users.id, personas.userId))
    .where(and(eq(socialLinks.id, linkId), eq(personas.status, 'active'), eq(users.status, 'active')))
    .limit(1)
  if (!row) return null
  const { link } = row
  const fetched = await (deps.fetchHtml ?? ((url: string) => safeFetchHtml(url)))(link.url)
  const { outcome, code } = classifyFetch(fetched, personaProfileUrl(deps.siteOrigin, row.handle))
  const next = nextSocialLinkState({ verification: link.verification, failures: link.checkFailures }, outcome)
  const verifiedAt = next.verification !== 'verified' ? null : next.verifiedNow ? now : (link.verifiedAt ?? now)
  // 가져오는 동안 지워졌으면(또는 다른 주소로 바뀐 행이면) 아무것도 쓰지 않습니다.
  const updated = await db
    .update(socialLinks)
    .set({ verification: next.verification, verifiedAt, lastCheckedAt: now, lastCheckResult: code, checkFailures: next.failures })
    .where(and(eq(socialLinks.id, link.id), eq(socialLinks.url, link.url)))
    .returning({ id: socialLinks.id })
  if (updated.length === 0) return null
  if (next.verification === 'verified' && link.verification !== 'verified') {
    await emitWorkerAnalytics(db, deps.analyticsPepper, { name: 'social_link_verified', actorId: link.userId, props: { provider: link.provider }, now, social: true })
  }
  return { id: link.id, verification: next.verification, result: code }
}

/** verified 링크 중 재확인할 때가 된 것을 한 번에 limit개까지 다시 봅니다. affected = 확인한 링크 수, failed = 이번에 lost가 된 수. */
export async function recheckSocialLinks(
  db: DbExecutor,
  deps: SocialLinkCheckDeps,
  options: { now: Date; limit?: number },
): Promise<TaskOutcome & { lost: number }> {
  if (!deps.siteOrigin) return { affected: 0, batches: 0, lost: 0, halted: 'no_site_origin' }
  const due = new Date(options.now.getTime() - SOCIAL_LINK_RECHECK_INTERVAL_MS)
  const rows = await db
    .select({ id: socialLinks.id })
    .from(socialLinks)
    .innerJoin(personas, eq(personas.id, socialLinks.personaId))
    .innerJoin(users, eq(users.id, personas.userId))
    .where(
      and(
        eq(socialLinks.verification, 'verified'),
        or(isNull(socialLinks.lastCheckedAt), lt(socialLinks.lastCheckedAt, due)),
        eq(personas.status, 'active'),
        eq(users.status, 'active'),
      ),
    )
    .orderBy(sql`${socialLinks.lastCheckedAt} asc nulls first`, asc(socialLinks.id))
    .limit(options.limit ?? SOCIAL_LINK_RECHECK_BATCH)
  let affected = 0
  let lost = 0
  let failed = 0
  const queue = rows.map((r) => r.id)
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const checked = await checkSocialLink(db, id, deps, options.now)
        if (!checked) continue
        affected++
        if (checked.verification === 'lost') lost++
      } catch (error) {
        failed++
        console.error(`[worker] social_link recheck ${id} failed:`, (error as Error).name)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(RECHECK_CONCURRENCY, queue.length) }, worker))
  return { affected, batches: rows.length ? 1 : 0, lost, ...(failed && { failed }) }
}

export async function registerSocialLinkQueue(boss: PgBoss, db: DbExecutor, deps: SocialLinkCheckDeps): Promise<void> {
  await boss.createQueue(SOCIAL_LINK_VERIFY_TOPIC, SOCIAL_LINK_QUEUE_OPTIONS)
  await boss.updateQueue(SOCIAL_LINK_VERIFY_TOPIC, SOCIAL_LINK_QUEUE_OPTIONS)
  await boss.work<Record<string, unknown>>(SOCIAL_LINK_VERIFY_TOPIC, { batchSize: 1, pollingIntervalSeconds: 2 }, async ([job]) => {
    if (!job) return
    const payload = parseSocialLinkPayload(job.data)
    if (!payload) {
      console.error('[worker] social_link.verify: invalid payload')
      return
    }
    const checked = await checkSocialLink(db, payload.socialLinkId, deps)
    console.info(`[worker] social_link.verify ${job.id}: ${checked ? `${checked.verification}/${checked.result}` : 'skipped'}`)
  })
}
