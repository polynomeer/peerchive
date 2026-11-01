/**
 * 동문회·OB 방의 투표 (A-02, PROOFU_EVOLUTION_PLAN §8.9.9 "장소·날짜 투표", SYSTEM_DESIGN §6.7.2 Poll·PollVote, ADR 0039).
 *
 * - P2 `alumni` 플래그 뒤, alumni 방의 active 멤버만(loadAlumniRoom, 아니면 404).
 * - 방장·운영진(admin)이 만들고(질문·선택지 2~10개·마감 시각) 일찍 마감할 수 있습니다. 모더레이터·멤버는 403.
 * - 멤버는 마감 전 한 번만 투표합니다(바꾸지 않음): 두 번째 투표 409 `already_voted`, 마감 뒤 409 `poll_closed`.
 * - **결과는 선택지별 개수만**: 누가 무엇을 골랐는지는 방장·운영진·운영자를 포함해 누구에게도 내보내지 않습니다. 응답에는 내 선택(`myVote`)만.
 * - 방을 나가거나 내보내지거나 탈퇴하면 그 사람의 표를 지웁니다(집계도 줄어듦, 마감한 투표 포함 — ADR 0039).
 * - 감사 기록에는 id·개수만(질문·선택지·누가 무엇을 골랐는지 없음). 투표 자체는 감사 기록을 남기지 않습니다(누가 투표했는지도 남기지 않음).
 */
import { ROOM_POLL_OPEN_LIMIT, canManageRoomGatherings, checkRoomPollInput, isPollOpen } from '@peerchive/domain'
import { and, desc, eq, gt, inArray, roomPollVotes, roomPolls, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, invalid, notFound, rateLimited, sqlState } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import { type AlumniRoom, assertRoomWritable, countAll, loadAlumniRoom, uuidOr404 } from './alumni-room'
import type { RoomPollDto, RoomPollsDto } from '../../../shared/types/api'

type PollRow = typeof roomPolls.$inferSelect

export const POLL_CREATE_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 }
const POLL_LIST_LIMIT = 50

function manageable(room: AlumniRoom): boolean {
  return room.ctx.space.row.status === 'active' && canManageRoomGatherings(room.ctx.membership?.role)
}

async function toPollDtos(db: DbExecutor, room: AlumniRoom, rows: PollRow[], viewerId: string, now: Date): Promise<RoomPollDto[]> {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  // 집계만 읽습니다(사람별 행을 응답 쪽으로 가져오지 않음). 나간 사람의 표는 나갈 때 지워집니다.
  const counts = await db
    .select({ pollId: roomPollVotes.pollId, optionIndex: roomPollVotes.optionIndex, n: countAll })
    .from(roomPollVotes)
    .where(inArray(roomPollVotes.pollId, ids))
    .groupBy(roomPollVotes.pollId, roomPollVotes.optionIndex)
  const mine = await db
    .select({ pollId: roomPollVotes.pollId, optionIndex: roomPollVotes.optionIndex })
    .from(roomPollVotes)
    .where(and(inArray(roomPollVotes.pollId, ids), eq(roomPollVotes.userId, viewerId)))
  const countMap = new Map(counts.map((c) => [`${c.pollId}:${c.optionIndex}`, c.n]))
  const mineMap = new Map(mine.map((m) => [m.pollId, m.optionIndex]))
  const writable = room.ctx.space.row.status === 'active' && !room.ctx.viewer.writeRestriction
  return rows.map((row) => {
    const options = row.options.map((label, index) => ({ index, label, count: countMap.get(`${row.id}:${index}`) ?? 0 }))
    const open = isPollOpen(row, now)
    const myVote = mineMap.get(row.id) ?? null
    return {
      id: row.id,
      question: row.question,
      options,
      totalVotes: options.reduce((a, o) => a + o.count, 0),
      closesAt: row.closesAt.toISOString(),
      open,
      myVote,
      canVote: open && myVote === null && writable,
      canClose: open && manageable(room),
      createdAt: row.createdAt.toISOString(),
    }
  })
}

/** GET /community/spaces/:slug/polls — 방 멤버만. 최근 투표 50개(열린 것 먼저), 선택지별 개수와 내 선택. */
export async function listRoomPolls(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<RoomPollsDto> {
  const room = await loadAlumniRoom(db, actor, ref, false, now)
  const rows = await db
    .select()
    .from(roomPolls)
    .where(eq(roomPolls.spaceId, room.ctx.space.row.id))
    .orderBy(desc(roomPolls.createdAt), desc(roomPolls.id))
    .limit(POLL_LIST_LIMIT)
  const dtos = await toPollDtos(db, room, rows, actor.userId, now)
  return {
    canManage: manageable(room),
    writable: room.ctx.space.row.status === 'active',
    polls: [...dtos.filter((p) => p.open), ...dtos.filter((p) => !p.open)],
  }
}

async function loadPoll(db: DbExecutor, spaceId: string, pollId: unknown, lock: boolean): Promise<PollRow> {
  const id = uuidOr404(pollId)
  const query = db
    .select()
    .from(roomPolls)
    .where(and(eq(roomPolls.id, id), eq(roomPolls.spaceId, spaceId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

async function pollDto(db: DbExecutor, room: AlumniRoom, row: PollRow, viewerId: string, now: Date): Promise<RoomPollDto> {
  return (await toPollDtos(db, room, [row], viewerId, now))[0]!
}

/** POST /community/spaces/:slug/polls {question, options[], closesAt} — 방장·운영진만(403). 201. 409 `space_not_active`·`too_many_polls`, 422, 429. */
export async function createRoomPoll(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<RoomPollDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx)
    if (!canManageRoomGatherings(room.ctx.membership?.role)) throw forbidden()
    const checked = checkRoomPollInput(raw, now)
    if (!checked.ok) throw invalid(checked.fields)
    if (!(await hitRateLimit(tx, 'room_poll_create', actor.userId, POLL_CREATE_RATE_LIMIT, now))) throw rateLimited()
    const [{ n }] = (await tx
      .select({ n: countAll })
      .from(roomPolls)
      .where(and(eq(roomPolls.spaceId, room.ctx.space.row.id), gt(roomPolls.closesAt, now)))) as [{ n: number }]
    if (n >= ROOM_POLL_OPEN_LIMIT) throw conflict('too_many_polls')
    const [row] = await tx
      .insert(roomPolls)
      .values({ spaceId: room.ctx.space.row.id, question: checked.value.question, options: checked.value.options, closesAt: checked.value.closesAt, createdBy: actor.userId, createdAt: now })
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.room_poll_create',
      targetType: 'community_space',
      targetId: room.ctx.space.row.id,
      metadata: { pollId: row!.id, options: checked.value.options.length },
    })
    return pollDto(tx, room, row!, actor.userId, now)
  })
}

/**
 * POST /community/spaces/:slug/polls/:id/votes {optionIndex} — 방 active 멤버, 마감 전 한 번만. 201 + 투표(집계).
 * 409 `already_voted`·`poll_closed`·`space_not_active`, 403 `write_restricted`, 422 `optionIndex`.
 */
export async function voteOnPoll(db: DbExecutor, actor: Actor, ref: unknown, pollId: unknown, rawInput: unknown, now = new Date()): Promise<RoomPollDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  try {
    return await db.transaction(async (tx) => {
      const room = await loadAlumniRoom(tx, actor, ref, false, now)
      assertRoomWritable(room.ctx)
      const poll = await loadPoll(tx, room.ctx.space.row.id, pollId, true)
      const index = raw.optionIndex
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= poll.options.length) {
        throw invalid({ optionIndex: index === undefined ? 'required' : 'invalid' })
      }
      if (!isPollOpen(poll, now)) throw conflict('poll_closed')
      const inserted = await tx
        .insert(roomPollVotes)
        .values({ pollId: poll.id, userId: actor.userId, optionIndex: index, createdAt: now })
        .onConflictDoNothing()
        .returning({ pollId: roomPollVotes.pollId })
      if (inserted.length === 0) throw conflict('already_voted')
      return pollDto(tx, room, poll, actor.userId, now)
    })
  } catch (error) {
    if (sqlState(error) === '23505') throw conflict('already_voted')
    throw error
  }
}

/** POST /community/spaces/:slug/polls/:id/close — 방장·운영진이 일찍 마감(마감 시각 = 지금). 이미 마감이면 그대로(멱등). */
export async function closeRoomPoll(db: DbExecutor, actor: Actor, ref: unknown, pollId: unknown, now = new Date()): Promise<RoomPollDto> {
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx, { restricted: false })
    if (!canManageRoomGatherings(room.ctx.membership?.role)) throw forbidden()
    const poll = await loadPoll(tx, room.ctx.space.row.id, pollId, true)
    if (!isPollOpen(poll, now)) return pollDto(tx, room, poll, actor.userId, now)
    const [row] = await tx.update(roomPolls).set({ closesAt: now }).where(eq(roomPolls.id, poll.id)).returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.room_poll_close', targetType: 'community_space', targetId: room.ctx.space.row.id, metadata: { pollId: poll.id } })
    return pollDto(tx, room, row!, actor.userId, now)
  })
}
