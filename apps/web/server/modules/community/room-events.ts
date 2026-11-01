/**
 * 동문회·OB 방의 일정·회차별 참석 응답 (A-02, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 Event·EventRsvp·§8.4, DELIVERY_PLAN §5.3 W, ADR 0039).
 *
 * - P2 `alumni` 플래그 뒤, alumni 방의 active 멤버만(loadAlumniRoom, 아니면 404).
 * - 일정은 방장·운영진(admin)만 만들고(제목·설명·장소만) 고치고 취소합니다. 모더레이터·멤버는 403. 시각·반복 규칙은 만든 뒤 바꾸지 않습니다
 *   (응답이 가리키는 회차가 바뀌지 않게 — 바꾸려면 취소하고 새로 만듦).
 * - 반복: none·weekly·monthly + 끝나는 서울 날짜. 회차는 규칙에서 계산하고 서울 날짜로 가리킵니다(@peerchive/domain eventOccurrences).
 * - 응답: 회차마다 (일정, 회차 날짜, 사람) 하나(PK). 다시 보내면 바꾸기, null이면 지우기. 회차가 시작한 뒤·취소된 일정은 409.
 * - 응답자 목록: 방 active 멤버만. 이름은 방별 프로필 이름 규칙(실명 방은 실명, 표시명 방은 방별 이름), 익명 방은 수만.
 * - 감사 기록에는 id·종류·플래그만(제목·장소 값 없음). 알림은 없습니다.
 */
import {
  RSVP_RESPONSES,
  ROOM_EVENT_DESCRIPTION_MAX,
  ROOM_EVENT_LIMIT_PER_ROOM,
  ROOM_EVENT_LOCATION_MAX,
  ROOM_EVENT_TITLE_MAX,
  type RoomEventSchedule,
  type RsvpResponse,
  canManageRoomGatherings,
  canRespondToOccurrence,
  checkOneLine,
  checkRoomEventInput,
  checkRoomText,
  eventOccurrences,
  findOccurrence,
} from '@peerchive/domain'
import { and, asc, desc, eq, inArray, roomEventRsvps, roomEvents, sql, type DbExecutor } from '@peerchive/db'
import { recordAudit } from '../audit/audit'
import { type Actor, conflict, forbidden, invalid, notFound, rateLimited } from '../errors'
import { hitRateLimit } from '../security/rate-limit'
import { type AlumniRoom, assertRoomWritable, countAll, loadAlumniRoom, roomMemberNames, uuidOr404 } from './alumni-room'
import type { RoomEventDto, RoomEventOccurrenceDto, RoomEventRespondentsDto, RoomEventsDto } from '../../../shared/types/api'

type EventRow = typeof roomEvents.$inferSelect

/** 응답 한도(사용자·시간당 120번 — 반복 일정의 여러 회차를 한 번에 고르는 정도). */
export const RSVP_RATE_LIMIT = { limit: 120, windowMs: 60 * 60 * 1000 }
/** 일정 만들기 한도(사용자·시간당 20개). */
export const EVENT_CREATE_RATE_LIMIT = { limit: 20, windowMs: 60 * 60 * 1000 }
/** 목록의 일정 수. */
const EVENT_LIST_LIMIT = ROOM_EVENT_LIMIT_PER_ROOM
const UPCOMING_PER_EVENT = 4

const scheduleOf = (row: EventRow): RoomEventSchedule => ({
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  recurrence: row.recurrence,
  repeatUntil: row.repeatUntil,
})

const emptyCounts = (): Record<RsvpResponse, number> => ({ going: 0, not_going: 0, maybe: 0 })

async function toEventDtos(db: DbExecutor, rows: EventRow[], viewerId: string, now: Date): Promise<RoomEventDto[]> {
  if (rows.length === 0) return []
  const counts = await db
    .select({ eventId: roomEventRsvps.eventId, date: roomEventRsvps.occurrenceDate, response: roomEventRsvps.response, n: countAll })
    .from(roomEventRsvps)
    .where(inArray(roomEventRsvps.eventId, rows.map((r) => r.id)))
    .groupBy(roomEventRsvps.eventId, roomEventRsvps.occurrenceDate, roomEventRsvps.response)
  const mine = await db
    .select({ eventId: roomEventRsvps.eventId, date: roomEventRsvps.occurrenceDate, response: roomEventRsvps.response })
    .from(roomEventRsvps)
    .where(and(inArray(roomEventRsvps.eventId, rows.map((r) => r.id)), eq(roomEventRsvps.userId, viewerId)))
  const key = (eventId: string, date: string) => `${eventId}:${date}`
  const countMap = new Map<string, Record<RsvpResponse, number>>()
  for (const c of counts) {
    const k = key(c.eventId, c.date)
    const m = countMap.get(k) ?? emptyCounts()
    m[c.response] = c.n
    countMap.set(k, m)
  }
  const mineMap = new Map(mine.map((m) => [key(m.eventId, m.date), m.response]))
  return rows.map((row) => {
    const schedule = scheduleOf(row)
    let occurrences = eventOccurrences(schedule, { from: now, limit: UPCOMING_PER_EVENT })
    const ended = occurrences.length === 0
    if (ended) occurrences = eventOccurrences(schedule).slice(-1)
    const occ: RoomEventOccurrenceDto[] = occurrences.map((o) => ({
      date: o.date,
      startsAt: o.startsAt.toISOString(),
      endsAt: o.endsAt?.toISOString() ?? null,
      counts: countMap.get(key(row.id, o.date)) ?? emptyCounts(),
      myResponse: mineMap.get(key(row.id, o.date)) ?? null,
      canRespond: canRespondToOccurrence(row.status, o, now),
    }))
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      locationText: row.locationText,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt?.toISOString() ?? null,
      recurrence: row.recurrence,
      repeatUntil: row.repeatUntil,
      status: row.status,
      ended,
      occurrences: occ,
      createdAt: row.createdAt.toISOString(),
    }
  })
}

/** 정렬: 예정된 일정의 다음 회차 순 → 끝난·취소된 일정은 뒤(최근 것부터). */
function sortEvents(dtos: RoomEventDto[]): RoomEventDto[] {
  const rank = (e: RoomEventDto) => (e.status === 'scheduled' && !e.ended ? 0 : 1)
  const at = (e: RoomEventDto) => Date.parse(e.occurrences[0]?.startsAt ?? e.startsAt)
  return [...dtos].sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? at(a) - at(b) : at(b) - at(a)) || (a.id < b.id ? -1 : 1))
}

function manageable(room: AlumniRoom): boolean {
  return room.ctx.space.row.status === 'active' && canManageRoomGatherings(room.ctx.membership?.role)
}

/** GET /community/spaces/:slug/events — 방 멤버만. 일정과 다가오는 회차(응답 수·내 응답). */
export async function listRoomEvents(db: DbExecutor, actor: Actor, ref: unknown, now = new Date()): Promise<RoomEventsDto> {
  const room = await loadAlumniRoom(db, actor, ref, false, now)
  const rows = await db
    .select()
    .from(roomEvents)
    .where(eq(roomEvents.spaceId, room.ctx.space.row.id))
    // 최근 것부터 가져와 정렬합니다(오래된 일정이 많아도 새 일정이 빠지지 않게).
    .orderBy(desc(roomEvents.startsAt), desc(roomEvents.id))
    .limit(EVENT_LIST_LIMIT * 2)
  return {
    canManage: manageable(room),
    writable: room.ctx.space.row.status === 'active',
    namesHidden: room.mode === 'anonymous',
    events: sortEvents(await toEventDtos(db, rows, actor.userId, now)),
  }
}

async function loadEvent(db: DbExecutor, spaceId: string, eventId: unknown, lock: boolean): Promise<EventRow> {
  const id = uuidOr404(eventId)
  const query = db
    .select()
    .from(roomEvents)
    .where(and(eq(roomEvents.id, id), eq(roomEvents.spaceId, spaceId)))
    .limit(1)
  const [row] = lock ? await query.for('update') : await query
  if (!row) throw notFound()
  return row
}

async function eventDto(db: DbExecutor, row: EventRow, viewerId: string, now: Date): Promise<RoomEventDto> {
  return (await toEventDtos(db, [row], viewerId, now))[0]!
}

/**
 * POST /community/spaces/:slug/events {title, description?, locationText?, startsAt, endsAt?, recurrence?, repeatUntil?} — 방장·운영진만(그 밖 403).
 * 201. 409 `space_not_active`·`too_many_events`, 422(제목·시각·반복 규칙), 429.
 */
export async function createRoomEvent(db: DbExecutor, actor: Actor, ref: unknown, rawInput: unknown, now = new Date()): Promise<RoomEventDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx)
    if (!canManageRoomGatherings(room.ctx.membership?.role)) throw forbidden()
    const checked = checkRoomEventInput(raw, now)
    if (!checked.ok) throw invalid(checked.fields)
    if (!(await hitRateLimit(tx, 'room_event_create', actor.userId, EVENT_CREATE_RATE_LIMIT, now))) throw rateLimited()
    const [{ n }] = (await tx
      .select({ n: countAll })
      .from(roomEvents)
      .where(and(eq(roomEvents.spaceId, room.ctx.space.row.id), eq(roomEvents.status, 'scheduled')))) as [{ n: number }]
    if (n >= ROOM_EVENT_LIMIT_PER_ROOM) throw conflict('too_many_events')
    const v = checked.value
    const [row] = await tx
      .insert(roomEvents)
      .values({
        spaceId: room.ctx.space.row.id,
        title: v.title,
        description: v.description,
        locationText: v.locationText,
        startsAt: v.startsAt,
        endsAt: v.endsAt,
        recurrence: v.recurrence,
        repeatUntil: v.repeatUntil,
        createdBy: actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.room_event_create',
      targetType: 'community_space',
      targetId: room.ctx.space.row.id,
      metadata: { eventId: row!.id, recurrence: v.recurrence },
    })
    return eventDto(tx, row!, actor.userId, now)
  })
}

/** PATCH /community/spaces/:slug/events/:id {title?, description?, locationText?} — 방장·운영진만. 시각·반복은 바꾸지 않습니다(422 `schedule_fixed`). */
export async function updateRoomEvent(db: DbExecutor, actor: Actor, ref: unknown, eventId: unknown, rawInput: unknown, now = new Date()): Promise<RoomEventDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx)
    if (!canManageRoomGatherings(room.ctx.membership?.role)) throw forbidden()
    const row = await loadEvent(tx, room.ctx.space.row.id, eventId, true)
    if (row.status !== 'scheduled') throw conflict('event_cancelled')
    const fields: Record<string, string> = {}
    for (const k of ['startsAt', 'endsAt', 'recurrence', 'repeatUntil']) if (k in raw) fields[k] = 'schedule_fixed'
    const set: Partial<typeof roomEvents.$inferInsert> = {}
    if ('title' in raw) {
      const t = checkOneLine(raw.title, ROOM_EVENT_TITLE_MAX)
      if (!t.ok) fields.title = t.reason
      else if (t.value === null) fields.title = 'required'
      else set.title = t.value
    }
    if ('description' in raw) {
      const d = checkRoomText(raw.description, ROOM_EVENT_DESCRIPTION_MAX)
      if (!d.ok) fields.description = d.reason
      else set.description = d.value
    }
    if ('locationText' in raw) {
      const l = checkOneLine(raw.locationText, ROOM_EVENT_LOCATION_MAX)
      if (!l.ok) fields.locationText = l.reason
      else set.locationText = l.value
    }
    if (Object.keys(fields).length) throw invalid(fields)
    const [updated] = await tx
      .update(roomEvents)
      .set({ ...set, updatedAt: now })
      .where(eq(roomEvents.id, row.id))
      .returning()
    await recordAudit(tx, {
      actorId: actor.userId,
      action: 'community.room_event_update',
      targetType: 'community_space',
      targetId: room.ctx.space.row.id,
      metadata: { eventId: row.id, fields: Object.keys(set).length },
    })
    return eventDto(tx, updated!, actor.userId, now)
  })
}

/** POST /community/spaces/:slug/events/:id/cancel — 방장·운영진만. 멱등(이미 취소면 그대로). 응답은 남기되 더 받지 않습니다. */
export async function cancelRoomEvent(db: DbExecutor, actor: Actor, ref: unknown, eventId: unknown, now = new Date()): Promise<RoomEventDto> {
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx, { restricted: false })
    if (!canManageRoomGatherings(room.ctx.membership?.role)) throw forbidden()
    const row = await loadEvent(tx, room.ctx.space.row.id, eventId, true)
    if (row.status === 'cancelled') return eventDto(tx, row, actor.userId, now)
    const [updated] = await tx
      .update(roomEvents)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(eq(roomEvents.id, row.id))
      .returning()
    await recordAudit(tx, { actorId: actor.userId, action: 'community.room_event_cancel', targetType: 'community_space', targetId: room.ctx.space.row.id, metadata: { eventId: row.id } })
    return eventDto(tx, updated!, actor.userId, now)
  })
}

/**
 * PUT /community/spaces/:slug/events/:id/rsvp {date, response: going|not_going|maybe|null} — 방 active 멤버. 회차마다 하나(다시 보내면 바꾸기,
 * null이면 지우기). 404(일정·회차 날짜가 규칙에 없음), 409 `event_cancelled`·`occurrence_started`·`space_not_active`, 422 `response`, 429.
 */
export async function respondToEvent(db: DbExecutor, actor: Actor, ref: unknown, eventId: unknown, rawInput: unknown, now = new Date()): Promise<RoomEventDto> {
  const raw = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>
  return db.transaction(async (tx) => {
    const room = await loadAlumniRoom(tx, actor, ref, true, now)
    assertRoomWritable(room.ctx)
    const row = await loadEvent(tx, room.ctx.space.row.id, eventId, true)
    const occurrence = findOccurrence(scheduleOf(row), raw.date)
    if (!occurrence) throw notFound()
    const response = raw.response
    if (response !== null && (typeof response !== 'string' || !(RSVP_RESPONSES as readonly string[]).includes(response))) throw invalid({ response: response === undefined ? 'required' : 'invalid' })
    if (row.status === 'cancelled') throw conflict('event_cancelled')
    if (!canRespondToOccurrence(row.status, occurrence, now)) throw conflict('occurrence_started')
    if (!(await hitRateLimit(tx, 'room_event_rsvp', actor.userId, RSVP_RATE_LIMIT, now))) throw rateLimited()
    const where = and(eq(roomEventRsvps.eventId, row.id), eq(roomEventRsvps.occurrenceDate, occurrence.date), eq(roomEventRsvps.userId, actor.userId))
    if (response === null) {
      await tx.delete(roomEventRsvps).where(where)
    } else {
      await tx
        .insert(roomEventRsvps)
        .values({ eventId: row.id, occurrenceDate: occurrence.date, userId: actor.userId, response: response as RsvpResponse, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [roomEventRsvps.eventId, roomEventRsvps.occurrenceDate, roomEventRsvps.userId],
          set: { response: response as RsvpResponse, updatedAt: now },
        })
    }
    return eventDto(tx, row, actor.userId, now)
  })
}

/**
 * GET /community/spaces/:slug/events/:id/rsvps?date= — 그 회차의 응답자 목록. 방 active 멤버만(아니면 404). 응답자 중 지금 active 멤버만 셉니다.
 * 이름은 방 안 이름(실명 방 실명, 표시명 방 방별 이름), 익명 방은 수만(`namesHidden`). 사람 id는 싣지 않습니다.
 */
export async function listEventRespondents(db: DbExecutor, actor: Actor, ref: unknown, eventId: unknown, query: { date?: unknown }, now = new Date()): Promise<RoomEventRespondentsDto> {
  const room = await loadAlumniRoom(db, actor, ref, false, now)
  const row = await loadEvent(db, room.ctx.space.row.id, eventId, false)
  const occurrence = findOccurrence(scheduleOf(row), query.date)
  if (!occurrence) throw notFound()
  const rows = await db
    .select({ userId: roomEventRsvps.userId, response: roomEventRsvps.response })
    .from(roomEventRsvps)
    .where(
      and(
        eq(roomEventRsvps.eventId, row.id),
        eq(roomEventRsvps.occurrenceDate, occurrence.date),
        // 나간 사람의 응답은 지워지지만, 혹시 남아 있어도 active 멤버만 셉니다.
        sql`exists (select 1 from space_memberships m where m.space_id = ${room.ctx.space.row.id} and m.user_id = ${roomEventRsvps.userId} and m.status = 'active')`,
      ),
    )
    .orderBy(asc(roomEventRsvps.createdAt))
  const hidden = room.mode === 'anonymous'
  const names = await roomMemberNames(db, room.ctx.space.row.id, room.mode, rows.map((r) => r.userId))
  const groups = { going: { count: 0, names: [] as string[] }, not_going: { count: 0, names: [] as string[] }, maybe: { count: 0, names: [] as string[] } }
  for (const r of rows) {
    groups[r.response].count++
    if (!hidden) groups[r.response].names.push(names.get(r.userId)!)
  }
  for (const g of Object.values(groups)) g.names.sort((a, b) => a.localeCompare(b, 'ko'))
  return { eventId: row.id, date: occurrence.date, namesHidden: hidden, groups }
}
