/**
 * 커뮤니티 알림(C-03, ADR 0020): 이름 표시 방식 변경의 예약·취소·적용을 공간의 active 멤버에게 화면 안에서 알립니다(메일·푸시 없음).
 * C-04(ADR 0022): 내 글의 새 댓글(`post_commented`, 글·사람마다 읽기 전까지 한 행, payload는 개수만)도 같은 목록에 나옵니다(posts.ts가 넣음).
 * C-06(ADR 0023): 내 글·댓글의 임시 숨김(`item_auto_hidden`)·복원(`item_restored`, payload는 대상 종류만)도 같은 목록입니다(moderation.ts가 넣음).
 * C-07(ADR 0024): 모집 선정(초대 받기)·선정되지 않음·모집 취소(payload는 모집 종류만, 공간 없이 recruitment_id)도 같은 목록입니다(recruitments.ts가 넣음).
 *
 * - 받는 사람: 알림을 만드는 순간 그 공간의 active 멤버이면서 계정이 active인 사람(나감·내보냄·승인 대기·탈퇴 요청 제외). 나중에 들어온 사람은
 *   알림 대신 공간 화면의 배너로 봅니다.
 * - payload: 허용 목록(@peerchive/domain sanitizeNoticePayload)만. 공간 이름은 저장하지 않고, 읽을 때 지금 읽을 수 있는 공간일 때만 붙입니다.
 * - 같은 변경·종류·사람에는 한 행(부분 unique)이라 worker 재시도에도 중복이 없습니다. worker의 적용 알림도 같은 SQL 모양을 씁니다
 *   (apps/worker/src/ops/name-modes.ts — worker는 웹 모듈을 import할 수 없음).
 * - 운영 조치 안내(moderation/notices.ts)와는 별개입니다: 그쪽은 조치 행에서 계산하는 당사자 안내이고, 이쪽은 멤버 전원에게 보내는 공간 소식입니다.
 */
import { z } from 'zod'
import {
  type NameModeNoticeKind,
  type NameModeNoticePayload,
  canReadSpace,
  itemReviewNoticeText,
  recruitmentNoticeText,
  sanitizeRecruitmentNoticePayload,
  sanitizeItemReviewPayload,
  sanitizeNoticePayload,
  sanitizePostNoticePayload,
} from '@peerchive/domain'
import { and, communityNotices, communitySpaces, desc, eq, inArray, isNull, spaceMemberships, sql, type DbExecutor } from '@peerchive/db'
import type { Actor } from '../errors'
import { parseInput } from '../validation'
import { loadSpacesWhere, loadViewer, spaceFacts } from './access'
import type { CommunityNoticeDto, CommunityNoticesDto } from '../../../shared/types/api'

/** 공간의 지금 active 멤버(계정도 active)에게 알림 한 줄씩. 넣은 수. 허용 목록을 통과하지 못하면 아무것도 넣지 않고 예외(코드 오류). */
export async function notifyActiveMembers(
  tx: DbExecutor,
  input: { spaceId: string; changeId: string; kind: NameModeNoticeKind; payload: NameModeNoticePayload; now: Date },
): Promise<number> {
  const payload = sanitizeNoticePayload(input.kind, input.payload as unknown as Record<string, unknown>)
  if (!payload) throw new Error(`community notice payload not allowed: ${input.kind}`)
  const rows = await tx.execute<{ id: string }>(sql`
    insert into community_notices (user_id, space_id, kind, name_mode_change_id, payload, created_at)
    select sm.user_id, sm.space_id, ${input.kind}, ${input.changeId}, ${JSON.stringify(payload)}::jsonb, ${input.now.toISOString()}::timestamptz
    from space_memberships sm join users u on u.id = sm.user_id
    where sm.space_id = ${input.spaceId} and sm.status = 'active' and u.status = 'active'
    on conflict (name_mode_change_id, kind, user_id) where name_mode_change_id is not null do nothing
    returning id`)
  return rows.length
}

export async function unreadNoticeCount(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(communityNotices)
    .where(and(eq(communityNotices.userId, userId), isNull(communityNotices.readAt)))
  return row?.n ?? 0
}

/** GET /community/notices — 내 알림 최근 50개 + 읽지 않은 수. 지금 읽을 수 없는 공간(나감·내보냄·인증 해제)은 이름·주소를 싣지 않습니다. */
export async function listMyCommunityNotices(db: DbExecutor, actor: Actor): Promise<CommunityNoticesDto> {
  const rows = await db
    .select()
    .from(communityNotices)
    .where(eq(communityNotices.userId, actor.userId))
    .orderBy(desc(communityNotices.createdAt), desc(communityNotices.id))
    .limit(50)
  const spaceIds = [...new Set(rows.map((r) => r.spaceId).filter((id): id is string => id !== null))]
  const readable = new Map<string, { slug: string; name: string }>()
  if (spaceIds.length) {
    const viewer = await loadViewer(db, actor)
    const spaces = await loadSpacesWhere(db, and(inArray(communitySpaces.id, spaceIds)))
    const memberships = await db
      .select({ spaceId: spaceMemberships.spaceId, role: spaceMemberships.role, status: spaceMemberships.status })
      .from(spaceMemberships)
      .where(and(eq(spaceMemberships.userId, actor.userId), inArray(spaceMemberships.spaceId, spaceIds)))
    const mine = new Map(memberships.map((m) => [m.spaceId, { role: m.role, status: m.status }]))
    for (const s of spaces) {
      // 멤버 수는 읽기 판정에 쓰지 않습니다(멤버십·학교 인증만 봄).
      if (canReadSpace(viewer, spaceFacts(s, 0), mine.get(s.row.id) ?? null)) readable.set(s.row.id, { slug: s.row.slug, name: s.row.name })
    }
  }
  const items: CommunityNoticeDto[] = []
  for (const r of rows) {
    if (r.kind === 'recruitment_invited' || r.kind === 'recruitment_not_selected' || r.kind === 'recruitment_cancelled') {
      // 모집 알림(C-07): 모집 종류와 고정 문장만(제목·모집자·이유 없음). 모집 주소는 화면이 열 때 다시 판정합니다(볼 수 없으면 404).
      const payload = sanitizeRecruitmentNoticePayload(r.payload)
      if (!payload || !r.recruitmentId) continue
      items.push({
        id: r.id,
        kind: r.kind,
        space: null,
        recruitmentId: r.recruitmentId,
        recruitmentKind: payload.recruitmentKind,
        text: recruitmentNoticeText(r.kind, payload),
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })
      continue
    }
    const space = r.spaceId ? (readable.get(r.spaceId) ?? null) : null
    if (r.kind === 'item_auto_hidden' || r.kind === 'item_restored') {
      const payload = sanitizeItemReviewPayload(r.payload)
      if (!payload) continue
      items.push({
        id: r.id,
        kind: r.kind,
        space,
        postId: space ? r.postId : null,
        target: payload.target,
        text: itemReviewNoticeText(r.kind, payload),
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })
      continue
    }
    if (r.kind === 'post_commented') {
      // 새 댓글(C-04): 개수만. 댓글 쓴 사람·내용은 저장하지 않습니다. 지금 읽을 수 없는 공간이면 글 주소도 싣지 않습니다.
      const payload = sanitizePostNoticePayload(r.payload)
      if (!payload) continue
      items.push({ id: r.id, kind: r.kind, space, postId: space ? r.postId : null, count: payload.count, createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null })
      continue
    }
    const payload = sanitizeNoticePayload(r.kind, r.payload)
    if (!payload) continue
    items.push({
      id: r.id,
      kind: r.kind,
      space,
      fromMode: payload.fromMode,
      toMode: payload.toMode,
      effectiveAt: payload.effectiveAt,
      joinPolicyAdjusted: payload.joinPolicyAdjusted ?? false,
      createdAt: r.createdAt.toISOString(),
      readAt: r.readAt?.toISOString() ?? null,
    })
  }
  return { items, unread: await unreadNoticeCount(db, actor.userId) }
}

export const markReadSchema = z
  .object({
    ids: z.array(z.uuid({ error: 'invalid' }).transform((v) => v.toLowerCase()), { error: 'invalid' }).max(100, { error: 'too_many' }).optional(),
    all: z.literal(true, { error: 'invalid' }).optional(),
  })
  .refine((v) => !!v.ids !== !!v.all, { error: 'required', path: ['ids'] })

/** POST /community/notices/read {ids: uuid[]} | {all: true} — 내 알림만 읽음으로. 남의 id는 조용히 무시합니다. */
export async function markCommunityNoticesRead(db: DbExecutor, actor: Actor, rawInput: unknown, now = new Date()): Promise<{ updated: number; unread: number }> {
  const input = parseInput(markReadSchema, rawInput)
  const where = and(
    eq(communityNotices.userId, actor.userId),
    isNull(communityNotices.readAt),
    input.ids ? (input.ids.length ? inArray(communityNotices.id, input.ids) : sql`false`) : undefined,
  )
  const updated = await db.update(communityNotices).set({ readAt: now }).where(where).returning({ id: communityNotices.id })
  return { updated: updated.length, unread: await unreadNoticeCount(db, actor.userId) }
}
