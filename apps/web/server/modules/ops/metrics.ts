/**
 * 운영자용 pilot 지표(T-16, DELIVERY_PLAN §6, ADR 0016). `GET /api/v1/operator/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 * 분석 이벤트만 읽고(비공개 작업 테이블 없음), 계산은 @peerchive/domain computePilotMetrics, 5 미만은 null입니다.
 * 기간은 서울 날짜(양 끝 포함), 기본은 오늘까지 28일, 최대 366일.
 * S-07(DELIVERY_PLAN §6.2, ADR 0036): `profile` 칸은 공개 프로필·팔로우 지표(@peerchive/domain computeProfileMetrics). 사람 행동은 이벤트, 신고·조치·
 * 주인 확인·지금 팔로우 수·팔로워 수 표시 설정은 운영 기록에서 개수로만 셉니다(사람·페르소나 id를 응답에 싣지 않음). 모든 칸 5 미만 null.
 */
import { z } from 'zod'
import { ANALYTICS_MIN_GROUP, type ProfileReportFact, computePilotMetrics, computeProfileMetrics } from '@peerchive/domain'
import {
  analyticsEvents,
  and,
  eq,
  follows,
  gte,
  inArray,
  isNull,
  lt,
  moderationActions,
  personaOwnerLookups,
  personas,
  profiles,
  reports,
  sql,
  users,
  type DbExecutor,
} from '@peerchive/db'
import { requireOperator } from '../catalog/operators'
import { type Actor, invalid } from '../errors'
import { parseInput } from '../validation'
import type { OperatorMetricsDto } from '../../../shared/types/api'

const DAY_MS = 86_400_000
const SEOUL_MS = 9 * 60 * 60 * 1000
const date = z.string({ error: 'invalid' }).regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'invalid' }).optional()
const querySchema = z.object({ from: date, to: date })

/** 서울 날짜의 0시(UTC 시각). */
const seoulMidnight = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - SEOUL_MS)
const seoulToday = (now: Date) => new Date(now.getTime() + SEOUL_MS).toISOString().slice(0, 10)


/** `from`·`to`(서울 날짜, 양 끝 포함) → [from, to) UTC 시각. 기본 오늘까지 28일, 최대 366일. 커뮤니티 지표(C-10)도 같은 규칙을 씁니다. */
export function parseMetricsRange(rawQuery: unknown, now: Date): { from: Date; to: Date } {
  const query = parseInput(querySchema, rawQuery)
  const toDay = query.to ?? seoulToday(now)
  const to = new Date(seoulMidnight(toDay).getTime() + DAY_MS)
  const from = query.from ? seoulMidnight(query.from) : new Date(to.getTime() - 28 * DAY_MS)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw invalid({ from: 'invalid' })
  if (from >= to) throw invalid({ to: 'before_from' })
  if (to.getTime() - from.getTime() > 366 * DAY_MS) throw invalid({ to: 'too_long' })
  return { from, to }
}

export async function getOperatorMetrics(db: DbExecutor, actor: Actor, rawQuery: unknown, now = new Date()): Promise<OperatorMetricsDto> {
  await requireOperator(db, actor)
  const { from, to } = parseMetricsRange(rawQuery, now)
  const rows = await db
    .select({
      name: analyticsEvents.name,
      occurredAt: analyticsEvents.occurredAt,
      actorHash: analyticsEvents.actorHash,
      projectHash: analyticsEvents.projectHash,
      props: analyticsEvents.props,
    })
    .from(analyticsEvents)
    .where(and(gte(analyticsEvents.occurredAt, new Date(from.getTime() - 28 * DAY_MS)), lt(analyticsEvents.occurredAt, new Date(to.getTime() + 7 * DAY_MS))))
  const metrics = computePilotMetrics(rows, { from, to, now }, ANALYTICS_MIN_GROUP)
  const inRange = rows.filter((r) => r.occurredAt >= from && r.occurredAt < to)
  const profile = computeProfileMetrics({ events: inRange, ...(await profileFacts(db, from, to)) }, ANALYTICS_MIN_GROUP)
  return {
    ...metrics,
    profile,
    generatedAt: now.toISOString(),
    notes: [
      `${ANALYTICS_MIN_GROUP} 미만인 값은 가렸습니다(null).`,
      '수집을 거부한 사람의 활동은 들어가지 않습니다.',
      '사례 전환은 기간 안에 공개 후보를 만든 과제 중 게시한 비율입니다("공개 허용이 확인된 종료 과제"의 근사).',
      '기록 1회 작성 시간은 이벤트로 잴 수 없어 비워 둡니다(인터뷰·관찰).',
      '공개 프로필·팔로우: 팔로우 → 기록 활용은 피드에서 항목을 연 사람 중 같은 기간에 도움됐어요·포크를 남긴 비율(근사), 피드 구성은 연 항목 기준입니다. 페르소나·팔로우 이벤트는 시 단위 시각입니다.',
    ],
  }
}

/** 공개 프로필·팔로우 지표의 운영 기록(개수·종류만). */
async function profileFacts(db: DbExecutor, from: Date, to: Date) {
  const reportRows = await db
    .select({
      targetType: reports.targetType,
      reason: reports.reason,
      // 신고된 페르소나의 종류(글·링크는 그 페르소나). 지워졌으면 null. 실명 프로필(이전 profile 대상)은 real.
      personaKind: sql<'real' | 'display' | null>`case ${reports.targetType}::text
        when 'profile' then 'real'
        when 'persona' then (select p.kind::text from personas p where p.id = ${reports.personaId})
        when 'profile_post' then (select p.kind::text from profile_posts pp join personas p on p.id = pp.persona_id where pp.id = ${reports.profilePostId})
        when 'social_link' then (select p.kind::text from social_links sl join personas p on p.id = sl.persona_id where sl.id = ${reports.socialLinkId})
      end`,
      confirmed: sql<boolean>`coalesce(${moderationActions.kind}::text not in ('none') and ${moderationActions.reversedAt} is null, false)`,
    })
    .from(reports)
    .leftJoin(moderationActions, eq(moderationActions.id, reports.actionId))
    .where(and(inArray(reports.targetType, ['persona', 'profile_post', 'social_link', 'profile']), gte(reports.createdAt, from), lt(reports.createdAt, to)))
  const [followRow] = await db.select({ n: sql<number>`count(*)::int` }).from(follows).where(eq(follows.status, 'active'))
  const personaRows = await db
    .select({ kind: personas.kind, shown: personas.showFollowerCount, n: sql<number>`count(*)::int` })
    .from(personas)
    .innerJoin(profiles, eq(profiles.personaId, personas.id))
    .innerJoin(users, eq(users.id, personas.userId))
    .where(and(eq(personas.status, 'active'), eq(users.status, 'active'), isNull(profiles.hiddenAt)))
    .groupBy(personas.kind, personas.showFollowerCount)
  const [lookupRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(personaOwnerLookups)
    .where(and(gte(personaOwnerLookups.createdAt, from), lt(personaOwnerLookups.createdAt, to)))
  const count = (pred: (r: (typeof personaRows)[number]) => boolean) => personaRows.filter(pred).reduce((n, r) => n + r.n, 0)
  return {
    reports: reportRows.map((r) => ({ ...r, targetType: r.targetType as ProfileReportFact['targetType'], confirmed: !!r.confirmed })),
    activeFollows: followRow?.n ?? 0,
    personas: { real: count((r) => r.kind === 'real'), display: count((r) => r.kind === 'display'), followerCountShown: count((r) => r.shown) },
    ownerLookups: lookupRow?.n ?? 0,
  }
}
