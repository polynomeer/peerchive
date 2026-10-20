/**
 * 봇 예약 알림: 주간 체크인 알림(일 20:00)과 주간 기여 요약(화 10:00) (T-09, PROOFU_EVOLUTION_PLAN §6.4·§7, ADR 0009).
 *
 * 일정은 봇이 1분마다 `notices/claim`을 부를 때 서버가 정합니다(dueNotices, 서울 시각). 알림 행은
 * (채널 연결, 종류, ISO 주)마다 unique라 봇이 몇 번 물어도, 서버가 여러 대여도 한 주에 한 번만 만들어집니다.
 * - 가져간 알림은 5분 동안 다른 요청에 주지 않고(claimed_at 임대), 봇이 보낸 뒤 ack하면 끝납니다.
 *   ack 전에 봇이 죽으면 5분 뒤 다시 줍니다(최대 5번, 그 뒤 포기). 그래서 드물게 두 번 게시될 수 있습니다(최소 한 번 전달).
 * - 주간 요약은 owner가 그 채널 연결에서 켠 경우만(summary_enabled). 본문은 formatWeeklySummary(장부와 같은 범위)이고,
 *   프로젝트 owner의 권한으로 장부를 읽습니다(owner가 없으면 건너뜀).
 * - 같은 요청에서 만료된 📌 승인 요청을 닫고 내용을 지웁니다(48시간 + 최대 1분).
 */
import { z } from 'zod'
import { type DueNotice, dueNotices, isoWeekRange } from '@peerchive/domain'
import {
  and,
  asc,
  discordChannelBindings,
  discordNotices,
  eq,
  inArray,
  isNull,
  lt,
  or,
  projects,
  sql,
  type DbExecutor,
} from '@peerchive/db'
import type { AckNoticeResponse, ClaimNoticesResponse } from '@peerchive/bot-protocol'
import { ServiceError } from '../errors'
import { getContribution } from '../contribution/ledger'
import { formatWeeklySummary } from '../contribution/weekly-summary'
import { parseInput } from '../validation'
import { projectUrl } from './bindings'
import { expirePinRequests } from './capture'

export const NOTICE_LEASE_MS = 5 * 60 * 1000
export const NOTICE_MAX_ATTEMPTS = 5
const NOTICE_BATCH = 20
/** 디스코드 메시지 한도(2000자)보다 조금 작게. */
export const DISCORD_MESSAGE_MAX = 1900

export function reminderContent(projectTitle: string, url: string): string {
  return [
    `📝 [${projectTitle}] 이번 주 체크인(60초)을 남겨 주세요.`,
    '이번 주 투입 시간 · 체감 난이도 · 가장 중요한 진전이나 막힘 한 줄만 묻습니다. 월요일 12시 마감이에요.',
    url,
    '체크인은 팀 안에서만 보이고, 통계 공유는 따로 동의할 때만 씁니다.',
  ].join('\n')
}

export function fitDiscordMessage(text: string, moreUrl: string): string {
  if (text.length <= DISCORD_MESSAGE_MAX) return text
  const tail = `\n… 전체 보기: ${moreUrl}`
  return `${text.slice(0, DISCORD_MESSAGE_MAX - tail.length)}${tail}`
}

async function noticeContent(
  db: DbExecutor,
  project: { id: string; title: string; ownerId: string },
  due: DueNotice,
  siteOrigin: string,
  now: Date,
): Promise<string | null> {
  if (due.kind === 'checkin_reminder') {
    return reminderContent(project.title, projectUrl(siteOrigin, project.id, '#checkin'))
  }
  const range = isoWeekRange(due.isoWeek)
  if (!range) return null
  try {
    const data = await getContribution(db, { userId: project.ownerId }, project.id, range, now)
    const report = `${siteOrigin}/projects/${project.id}/report?from=${range.from}&to=${range.to}`
    return fitDiscordMessage(formatWeeklySummary(data), report)
  } catch (error) {
    // owner가 나갔거나 프로젝트를 읽을 수 없으면 요약을 만들지 않습니다.
    if (error instanceof ServiceError && error.code === 'NOT_FOUND') return null
    throw error
  }
}

/** 지금 보낼 알림 행을 (없으면) 만듭니다. 이미 있는 (연결, 종류, 주)는 건드리지 않습니다. 새로 만든 개수. */
export async function scheduleDueNotices(db: DbExecutor, siteOrigin: string, now = new Date()): Promise<number> {
  let created = 0
  for (const due of dueNotices(now)) {
    const rows = await db
      .select({ binding: discordChannelBindings, project: { id: projects.id, title: projects.title, ownerId: projects.ownerId } })
      .from(discordChannelBindings)
      .innerJoin(projects, eq(projects.id, discordChannelBindings.projectId))
      .leftJoin(
        discordNotices,
        and(
          eq(discordNotices.bindingId, discordChannelBindings.id),
          eq(discordNotices.kind, due.kind),
          eq(discordNotices.isoWeek, due.isoWeek),
        ),
      )
      .where(
        and(
          isNull(discordChannelBindings.unboundAt),
          isNull(discordNotices.id),
          due.kind === 'weekly_summary' ? eq(discordChannelBindings.summaryEnabled, true) : undefined,
        ),
      )
      .orderBy(asc(discordChannelBindings.createdAt))
    for (const row of rows) {
      const content = await noticeContent(db, row.project, due, siteOrigin, now)
      if (!content) continue
      const inserted = await db
        .insert(discordNotices)
        .values({ bindingId: row.binding.id, kind: due.kind, isoWeek: due.isoWeek, content, createdAt: now })
        .onConflictDoNothing({ target: [discordNotices.bindingId, discordNotices.kind, discordNotices.isoWeek] })
        .returning({ id: discordNotices.id })
      created += inserted.length
    }
  }
  return created
}

/** 봇이 보낼 알림을 가져갑니다(일정 확인 → 만료 요청 정리 → 임대). */
export async function claimNotices(db: DbExecutor, siteOrigin: string, now = new Date()): Promise<ClaimNoticesResponse> {
  await expirePinRequests(db, now)
  await scheduleDueNotices(db, siteOrigin, now)
  return db.transaction(async (tx) => {
    // 여러 번 실패한 알림은 포기합니다.
    await tx
      .update(discordNotices)
      .set({ deliveredAt: now, failedReason: 'gave_up' })
      .where(
        and(
          isNull(discordNotices.deliveredAt),
          sql`${discordNotices.attempts} >= ${NOTICE_MAX_ATTEMPTS}`,
          or(isNull(discordNotices.claimedAt), lt(discordNotices.claimedAt, new Date(now.getTime() - NOTICE_LEASE_MS))),
        ),
      )
    const rows = await tx
      .select({ notice: discordNotices, channelId: discordChannelBindings.channelId })
      .from(discordNotices)
      .innerJoin(discordChannelBindings, eq(discordChannelBindings.id, discordNotices.bindingId))
      .where(
        and(
          isNull(discordNotices.deliveredAt),
          isNull(discordChannelBindings.unboundAt),
          or(isNull(discordNotices.claimedAt), lt(discordNotices.claimedAt, new Date(now.getTime() - NOTICE_LEASE_MS))),
        ),
      )
      .orderBy(asc(discordNotices.createdAt), asc(discordNotices.id))
      .limit(NOTICE_BATCH)
      .for('update', { of: discordNotices, skipLocked: true })
    if (rows.length === 0) return { notices: [] }
    await tx
      .update(discordNotices)
      .set({ claimedAt: now, attempts: sql`${discordNotices.attempts} + 1` })
      .where(
        inArray(
          discordNotices.id,
          rows.map((row) => row.notice.id),
        ),
      )
    return {
      notices: rows.map((row) => ({
        id: row.notice.id,
        channelId: row.channelId,
        kind: row.notice.kind,
        isoWeek: row.notice.isoWeek,
        content: row.notice.content,
      })),
    }
  })
}

const ackSchema = z.object({
  id: z.uuid({ error: 'invalid' }),
  delivered: z.boolean({ error: 'required' }),
  discordMessageId: z.string().regex(/^\d{5,25}$/, { error: 'invalid' }).nullish(),
})

/** 보낸 결과. 보냈으면 끝, 못 보냈으면 임대를 풀어 다음에 다시(시도 한도까지). */
export async function ackNotice(db: DbExecutor, rawInput: unknown, now = new Date()): Promise<AckNoticeResponse> {
  const input = parseInput(ackSchema, rawInput)
  const rows = input.delivered
    ? await db
        .update(discordNotices)
        .set({ deliveredAt: now, discordMessageId: input.discordMessageId ?? null, failedReason: null })
        .where(and(eq(discordNotices.id, input.id), isNull(discordNotices.deliveredAt)))
        .returning({ id: discordNotices.id })
    : await db
        .update(discordNotices)
        .set({
          claimedAt: null,
          failedReason: 'unreachable',
          deliveredAt: sql`case when ${discordNotices.attempts} >= ${NOTICE_MAX_ATTEMPTS} then ${now.toISOString()}::timestamptz else null end`,
        })
        .where(and(eq(discordNotices.id, input.id), isNull(discordNotices.deliveredAt)))
        .returning({ id: discordNotices.id })
  return { status: rows.length === 1 ? 'ok' : 'not_found' }
}
