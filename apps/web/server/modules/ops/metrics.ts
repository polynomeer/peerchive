/**
 * 운영자용 pilot 지표(T-16, DELIVERY_PLAN §6, ADR 0016). `GET /api/v1/operator/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 * 분석 이벤트만 읽고(비공개 작업 테이블 없음), 계산은 @peerchive/domain computePilotMetrics, 5 미만은 null입니다.
 * 기간은 서울 날짜(양 끝 포함), 기본은 오늘까지 28일, 최대 366일.
 */
import { z } from 'zod'
import { ANALYTICS_MIN_GROUP, computePilotMetrics } from '@peerchive/domain'
import { analyticsEvents, and, gte, lt, type DbExecutor } from '@peerchive/db'
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
  return {
    ...metrics,
    generatedAt: now.toISOString(),
    notes: [
      `${ANALYTICS_MIN_GROUP} 미만인 값은 가렸습니다(null).`,
      '수집을 거부한 사람의 활동은 들어가지 않습니다.',
      '사례 전환은 기간 안에 공개 후보를 만든 과제 중 게시한 비율입니다("공개 허용이 확인된 종료 과제"의 근사).',
      '기록 1회 작성 시간은 이벤트로 잴 수 없어 비워 둡니다(인터뷰·관찰).',
    ],
  }
}
