/**
 * 동문회·OB 방의 모임 운영 도구: 일정·참석 응답·공지 읽음·투표·앨범 (A-02, PROOFU_EVOLUTION_PLAN §8.9.9, SYSTEM_DESIGN §6.7.2 Event·EventRsvp·
 * NoticeRead·Poll·Album, §8.4, DELIVERY_PLAN §4.3·§5.3 W, ADR 0039).
 *
 * - **일정**: 방장·운영진(admin)만 만들고 고칩니다. 반복은 단순 규칙(none·weekly·monthly) + 끝나는 날(`repeatUntil`, 서울 날짜)만 두고,
 *   회차는 저장하지 않고 규칙에서 계산합니다(`eventOccurrences`). 회차는 시작 시각의 **서울 날짜**(`occurrenceDate`, YYYY-MM-DD)로 구분합니다.
 *   - weekly: 시작 시각에서 7일씩. monthly: 서울 기준 같은 날짜(그 날짜가 없는 달은 건너뜀, 예: 31일).
 *   - 한 일정의 회차는 최대 `ROOM_EVENT_MAX_OCCURRENCES`개, 끝나는 날은 시작 날짜에서 366일 안.
 * - **참석 응답**: 회차마다 (일정, 회차 날짜, 사람) 하나. 참석·불참·미정, 그 회차가 시작하기 전까지만 바꿀 수 있습니다.
 * - **투표**: 방장·운영진이 만들고 active 멤버가 한 번만 투표합니다(바꾸지 않음). 결과는 선택지별 개수만(누가 무엇을 골랐는지는 아무에게도 없음).
 * - **앨범**: 이미지(PNG·JPEG·WebP)만, 10MB까지. 파일 검사·메타데이터 제거(ADR 0007)를 통과한 사진만 멤버에게 짧은 서명 URL로.
 *
 * 런타임 의존성 없음.
 */
import { type BoardTemplate, type SpaceRole, ROOM_DEFAULT_BOARDS } from './community'
import { seoulDate } from './contribution'
import { checkOneLine } from './room-profiles'

/** alumni 방의 기본 게시판: 사용자 방 기본(게시판) + 운영진 공지(읽음 수, 쓰기는 모더레이터 이상). */
export const ALUMNI_ROOM_DEFAULT_BOARDS: readonly BoardTemplate[] = [...ROOM_DEFAULT_BOARDS, { kind: 'notice', title: '공지', writeRole: 'moderator' }]

// ── 권한 ──────────────────────────────────────────────────────────────────

/** 일정·투표를 만들고 고치는 역할(방장·운영진, §8.4 "일정 생성: 방장·admin"). 모더레이터·멤버는 응답·투표만. */
export function canManageRoomGatherings(role: SpaceRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/** 앨범 사진을 지울 수 있는지: 올린 본인, 또는 방장·운영진. */
export function canDeleteAlbumPhoto(role: SpaceRole | null | undefined, isUploader: boolean): boolean {
  return isUploader || canManageRoomGatherings(role)
}

// ── 서울 날짜(seoulDate는 contribution.ts, 한국은 일광 절약 시간이 없어 고정 +9시간) ──

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** YYYY-MM-DD가 실제 날짜인지. */
export function isDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const m = DATE_RE.exec(value)
  if (!m) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`)

// ── 일정 ──────────────────────────────────────────────────────────────────

export const ROOM_EVENT_RECURRENCES = ['none', 'weekly', 'monthly'] as const
export type RoomEventRecurrence = (typeof ROOM_EVENT_RECURRENCES)[number]
export const ROOM_EVENT_RECURRENCE_LABELS: Readonly<Record<RoomEventRecurrence, string>> = { none: '한 번', weekly: '매주', monthly: '매월' }

export const ROOM_EVENT_STATUSES = ['scheduled', 'cancelled'] as const
export type RoomEventStatus = (typeof ROOM_EVENT_STATUSES)[number]

export const RSVP_RESPONSES = ['going', 'not_going', 'maybe'] as const
export type RsvpResponse = (typeof RSVP_RESPONSES)[number]
export const RSVP_RESPONSE_LABELS: Readonly<Record<RsvpResponse, string>> = { going: '참석', not_going: '불참', maybe: '미정' }

export const ROOM_EVENT_TITLE_MAX = 80
export const ROOM_EVENT_LOCATION_MAX = 100
export const ROOM_EVENT_DESCRIPTION_MAX = 1000
/** 한 일정의 최대 회차 수(매주 1년 = 53회). */
export const ROOM_EVENT_MAX_OCCURRENCES = 60
/** 반복이 끝나는 날은 시작 날짜에서 이 일수 안. */
export const ROOM_EVENT_REPEAT_MAX_DAYS = 366
/** 한 회차의 최대 길이(끝 시각 - 시작 시각). */
export const ROOM_EVENT_MAX_DURATION_MS = 7 * DAY_MS
/** 만들 때 시작 시각의 범위: 지금보다 하루 전 ~ 2년 뒤. */
export const ROOM_EVENT_START_PAST_MS = DAY_MS
export const ROOM_EVENT_START_FUTURE_MS = 731 * DAY_MS
/** 방 하나에 예정된(취소되지 않은) 일정 수 한도. */
export const ROOM_EVENT_LIMIT_PER_ROOM = 100

export interface RoomEventSchedule {
  startsAt: Date
  endsAt: Date | null
  recurrence: RoomEventRecurrence
  /** 반복이 끝나는 서울 날짜(포함). none이면 null. */
  repeatUntil: string | null
}

export interface RoomEventOccurrence {
  /** 회차를 가리키는 서울 날짜(응답의 occurrence_date). */
  date: string
  startsAt: Date
  endsAt: Date | null
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate()
}

/**
 * 규칙에서 회차를 계산합니다(시작 순). `from`이 있으면 그 시각 이후에 끝나는(끝 시각이 없으면 시작하는) 회차만, `limit`개까지.
 * monthly는 서울 기준 같은 날짜·같은 시각이고, 그 날짜가 없는 달은 건너뜁니다.
 */
export function eventOccurrences(schedule: RoomEventSchedule, options: { from?: Date; limit?: number } = {}): RoomEventOccurrence[] {
  const limit = Math.min(options.limit ?? ROOM_EVENT_MAX_OCCURRENCES, ROOM_EVENT_MAX_OCCURRENCES)
  const duration = schedule.endsAt ? schedule.endsAt.getTime() - schedule.startsAt.getTime() : null
  const until = schedule.recurrence === 'none' || !schedule.repeatUntil ? null : dateMs(schedule.repeatUntil)
  const out: RoomEventOccurrence[] = []
  const push = (startMs: number) => {
    const startsAt = new Date(startMs)
    const endsAt = duration === null ? null : new Date(startMs + duration)
    const cut = (endsAt ?? startsAt).getTime()
    if (options.from && cut <= options.from.getTime()) return
    out.push({ date: seoulDate(startsAt), startsAt, endsAt })
  }
  const first = schedule.startsAt.getTime()
  if (schedule.recurrence === 'none' || until === null) {
    push(first)
    return out.slice(0, limit)
  }
  // 회차 수 한도는 계산한 전체 회차 기준입니다(from으로 거른 뒤가 아님): 같은 규칙은 언제나 같은 회차 집합.
  let produced = 0
  if (schedule.recurrence === 'weekly') {
    for (let i = 0; produced < ROOM_EVENT_MAX_OCCURRENCES && out.length < limit; i++) {
      const start = first + i * 7 * DAY_MS
      if (dateMs(seoulDate(new Date(start))) > until) break
      produced++
      push(start)
    }
    return out
  }
  // monthly: 서울 시각 기준으로 연·월만 올립니다.
  const local = new Date(first + SEOUL_OFFSET_MS)
  const day = local.getUTCDate()
  const timeOfDay = first + SEOUL_OFFSET_MS - Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), day)
  for (let i = 0; produced < ROOM_EVENT_MAX_OCCURRENCES && out.length < limit && i < 12 * 3; i++) {
    const year = local.getUTCFullYear() + Math.floor((local.getUTCMonth() + i) / 12)
    const month0 = (local.getUTCMonth() + i) % 12
    if (Date.UTC(year, month0, 1) > until) break
    if (day > daysInMonth(year, month0)) continue
    const localMidnight = Date.UTC(year, month0, day)
    if (localMidnight > until) break
    produced++
    push(localMidnight + timeOfDay - SEOUL_OFFSET_MS)
  }
  return out
}

/** 그 날짜의 회차(없으면 null). 응답할 때 회차가 규칙에 있는지 확인합니다. */
export function findOccurrence(schedule: RoomEventSchedule, date: unknown): RoomEventOccurrence | null {
  if (!isDateString(date)) return null
  return eventOccurrences(schedule).find((o) => o.date === date) ?? null
}

/** 그 회차에 응답(새로·바꾸기)할 수 있는지: 예정된 일정이고 회차가 아직 시작하지 않음. */
export function canRespondToOccurrence(status: RoomEventStatus, occurrence: RoomEventOccurrence, now: Date): boolean {
  return status === 'scheduled' && now.getTime() < occurrence.startsAt.getTime()
}

export interface RoomEventValue {
  title: string
  description: string | null
  locationText: string | null
  startsAt: Date
  endsAt: Date | null
  recurrence: RoomEventRecurrence
  repeatUntil: string | null
}

export type RoomEventCheck = { ok: true; value: RoomEventValue } | { ok: false; fields: Record<string, string> }

function parseInstant(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.length > 40) return null
  // 시간대가 있는 ISO 8601만(브라우저 지역 시각을 서버가 추측하지 않음).
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * 일정 입력 검사(만들기). 제목 필수(한 줄, 80자), 설명 1000자, 장소 한 줄 100자, 시작 시각은 시간대가 있는 ISO 8601이고 지금 ± 범위 안,
 * 끝 시각은 시작보다 뒤이고 7일 안, 반복이면 끝나는 날(YYYY-MM-DD) 필수·시작 날짜 이후·366일 안, 반복이 아니면 끝나는 날 없음.
 */
export function checkRoomEventInput(
  raw: { title?: unknown; description?: unknown; locationText?: unknown; startsAt?: unknown; endsAt?: unknown; recurrence?: unknown; repeatUntil?: unknown },
  now: Date,
): RoomEventCheck {
  const fields: Record<string, string> = {}
  const title = checkOneLine(raw.title, ROOM_EVENT_TITLE_MAX)
  if (!title.ok) fields.title = title.reason
  else if (title.value === null) fields.title = 'required'
  const description = checkRoomText(raw.description, ROOM_EVENT_DESCRIPTION_MAX)
  if (!description.ok) fields.description = description.reason
  const location = checkOneLine(raw.locationText, ROOM_EVENT_LOCATION_MAX)
  if (!location.ok) fields.locationText = location.reason
  const startsAt = raw.startsAt === undefined || raw.startsAt === null ? null : parseInstant(raw.startsAt)
  if (raw.startsAt === undefined || raw.startsAt === null) fields.startsAt = 'required'
  else if (!startsAt) fields.startsAt = 'invalid'
  else if (startsAt.getTime() < now.getTime() - ROOM_EVENT_START_PAST_MS || startsAt.getTime() > now.getTime() + ROOM_EVENT_START_FUTURE_MS) fields.startsAt = 'out_of_range'
  let endsAt: Date | null = null
  if (raw.endsAt !== undefined && raw.endsAt !== null && raw.endsAt !== '') {
    endsAt = parseInstant(raw.endsAt)
    if (!endsAt) fields.endsAt = 'invalid'
    else if (startsAt && (endsAt.getTime() <= startsAt.getTime() || endsAt.getTime() - startsAt.getTime() > ROOM_EVENT_MAX_DURATION_MS)) fields.endsAt = 'out_of_range'
  }
  const recurrence = raw.recurrence === undefined || raw.recurrence === null ? 'none' : raw.recurrence
  if (typeof recurrence !== 'string' || !(ROOM_EVENT_RECURRENCES as readonly string[]).includes(recurrence)) fields.recurrence = 'invalid'
  let repeatUntil: string | null = null
  if (recurrence === 'none') {
    if (raw.repeatUntil !== undefined && raw.repeatUntil !== null && raw.repeatUntil !== '') fields.repeatUntil = 'not_allowed'
  } else if (!fields.recurrence) {
    if (raw.repeatUntil === undefined || raw.repeatUntil === null || raw.repeatUntil === '') fields.repeatUntil = 'required'
    else if (!isDateString(raw.repeatUntil)) fields.repeatUntil = 'invalid'
    else if (startsAt) {
      const startDay = dateMs(seoulDate(startsAt))
      const untilDay = dateMs(raw.repeatUntil)
      if (untilDay < startDay || untilDay - startDay > ROOM_EVENT_REPEAT_MAX_DAYS * DAY_MS) fields.repeatUntil = 'out_of_range'
      else repeatUntil = raw.repeatUntil
    }
  }
  if (Object.keys(fields).length || !title.ok || !startsAt || !description.ok || !location.ok) return { ok: false, fields }
  return {
    ok: true,
    value: {
      title: title.value!,
      description: description.value,
      locationText: location.value,
      startsAt,
      endsAt,
      recurrence: recurrence as RoomEventRecurrence,
      repeatUntil,
    },
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** 여러 줄 글(설명): 줄바꿈 허용, 앞뒤 공백 제거, 길이. 빈 값·null은 null. */
export function checkRoomText(raw: unknown, max: number): { ok: true; value: string | null } | { ok: false; reason: 'invalid' | 'too_long' } {
  if (raw === null || raw === undefined) return { ok: true, value: null }
  if (typeof raw !== 'string' || CONTROL.test(raw)) return { ok: false, reason: 'invalid' }
  const value = raw.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (!value) return { ok: true, value: null }
  if ([...value].length > max) return { ok: false, reason: 'too_long' }
  return { ok: true, value }
}

// ── 투표 ──────────────────────────────────────────────────────────────────

export const ROOM_POLL_QUESTION_MAX = 120
export const ROOM_POLL_OPTION_MAX = 50
export const ROOM_POLL_OPTIONS_MIN = 2
export const ROOM_POLL_OPTIONS_MAX = 10
/** 마감 시각: 지금부터 5분 ~ 90일 뒤. */
export const ROOM_POLL_MIN_OPEN_MS = 5 * 60 * 1000
export const ROOM_POLL_MAX_OPEN_MS = 90 * DAY_MS
/** 방 하나에 열린 투표 수 한도. */
export const ROOM_POLL_OPEN_LIMIT = 20

export interface RoomPollValue {
  question: string
  options: string[]
  closesAt: Date
}

export type RoomPollCheck = { ok: true; value: RoomPollValue } | { ok: false; fields: Record<string, string> }

/** 투표 입력 검사. 질문 필수(한 줄, 120자), 선택지 2~10개(한 줄, 50자, 같은 값 없음), 마감 시각은 지금 + 5분 ~ 90일. */
export function checkRoomPollInput(raw: { question?: unknown; options?: unknown; closesAt?: unknown }, now: Date): RoomPollCheck {
  const fields: Record<string, string> = {}
  const question = checkOneLine(raw.question, ROOM_POLL_QUESTION_MAX)
  if (!question.ok) fields.question = question.reason
  else if (question.value === null) fields.question = 'required'
  const options: string[] = []
  if (!Array.isArray(raw.options)) fields.options = raw.options === undefined ? 'required' : 'invalid'
  else if (raw.options.length < ROOM_POLL_OPTIONS_MIN || raw.options.length > ROOM_POLL_OPTIONS_MAX) fields.options = 'count'
  else {
    for (const o of raw.options) {
      const c = checkOneLine(o, ROOM_POLL_OPTION_MAX)
      if (!c.ok) {
        fields.options = c.reason
        break
      }
      if (c.value === null) {
        fields.options = 'invalid'
        break
      }
      options.push(c.value)
    }
    if (!fields.options && new Set(options).size !== options.length) fields.options = 'duplicate'
  }
  const closesAt = raw.closesAt === undefined || raw.closesAt === null ? null : parseInstant(raw.closesAt)
  if (raw.closesAt === undefined || raw.closesAt === null) fields.closesAt = 'required'
  else if (!closesAt) fields.closesAt = 'invalid'
  else if (closesAt.getTime() < now.getTime() + ROOM_POLL_MIN_OPEN_MS || closesAt.getTime() > now.getTime() + ROOM_POLL_MAX_OPEN_MS) fields.closesAt = 'out_of_range'
  if (Object.keys(fields).length || !question.ok || !closesAt) return { ok: false, fields }
  return { ok: true, value: { question: question.value!, options, closesAt } }
}

/** 투표를 받는지: 마감 시각 전. */
export function isPollOpen(poll: { closesAt: Date }, now: Date): boolean {
  return now.getTime() < poll.closesAt.getTime()
}

// ── 공지 읽음 ─────────────────────────────────────────────────────────────

/** 읽음을 세는 글: alumni 방(플래그 켜짐)의 공지 게시판 글. 그 밖의 글에는 읽음 행을 만들지 않습니다. */
export function tracksNoticeReads(effectiveTemplate: 'general' | 'alumni', boardKind: string): boolean {
  return effectiveTemplate === 'alumni' && boardKind === 'notice'
}

// ── 앨범 ──────────────────────────────────────────────────────────────────

export const ALBUM_PHOTO_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type AlbumPhotoMediaType = (typeof ALBUM_PHOTO_MEDIA_TYPES)[number]
const ALBUM_PHOTO_EXTENSIONS: Readonly<Record<AlbumPhotoMediaType, readonly string[]>> = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/webp': ['webp'],
}
/** 사진 한 장 10MB. */
export const ALBUM_PHOTO_MAX_BYTES = 10 * 1024 * 1024
/** 방 하나에 사진 300장(검사 대기·통과 포함, 격리·실패는 세지 않음). */
export const ALBUM_ROOM_PHOTO_LIMIT = 300
/** 한 사람이 한 방에 사진 60장. */
export const ALBUM_MEMBER_PHOTO_LIMIT = 60
/** 올리기 요청: 사용자·시간당 30장. */
export const ALBUM_UPLOAD_RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 }
/** 사진 서명 URL 유효 시간(그 사람에게만 맞는 서명). */
export const ALBUM_PHOTO_URL_TTL_MS = 5 * 60 * 1000
export const ALBUM_CAPTION_MAX = 100

export type AlbumPhotoUploadCheck =
  | { ok: true; mediaType: AlbumPhotoMediaType; extension: string; byteSize: number }
  | { ok: false; field: 'declaredType' | 'fileName' | 'byteSize'; reason: 'unsupported_type' | 'extension_mismatch' | 'too_large' | 'invalid' }

/** 앨범 사진 업로드 선언 검사. 원래 파일 이름은 확장자만 보고 저장하지 않습니다(이름에 사람 이름·장소가 들어 있는 경우가 많음). */
export function checkAlbumPhotoUpload(input: { declaredType: unknown; fileName: unknown; byteSize: unknown }): AlbumPhotoUploadCheck {
  const type = input.declaredType
  if (typeof type !== 'string' || !(ALBUM_PHOTO_MEDIA_TYPES as readonly string[]).includes(type)) return { ok: false, field: 'declaredType', reason: 'unsupported_type' }
  const mediaType = type as AlbumPhotoMediaType
  if (typeof input.fileName !== 'string' || input.fileName.length > 255) return { ok: false, field: 'fileName', reason: 'invalid' }
  const base = input.fileName.split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
  if (!ALBUM_PHOTO_EXTENSIONS[mediaType].includes(extension)) return { ok: false, field: 'fileName', reason: 'extension_mismatch' }
  const size = input.byteSize
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) return { ok: false, field: 'byteSize', reason: 'invalid' }
  if (size > ALBUM_PHOTO_MAX_BYTES) return { ok: false, field: 'byteSize', reason: 'too_large' }
  return { ok: true, mediaType, extension, byteSize: size }
}
