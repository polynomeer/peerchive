/**
 * AI 회의 요약 규칙 (E-13, PROOFU_EVOLUTION_PLAN §6.5·§15, DELIVERY_PLAN §4.4, ADR 0058).
 *
 * - 팀이 동의한 회의 채널에서만: owner가 연결된 디스코드 채널을 "회의 채널"로 제안하고, 그 과제의 active 멤버 **전원**이 웹에서
 *   동의해야 요약할 수 있습니다. 한 명이라도 동의하지 않았거나 철회했거나, 나중에 들어온 멤버가 아직 동의하지 않았으면 요약하지 않습니다
 *   (`meetingConsentState` — 동의는 "지금 active 멤버 전원"으로 매번 계산하므로 새 멤버는 자동으로 미동의 상태입니다).
 * - 디스코드 메시지 원문은 서버 메모리에서만 다룹니다. **동의한 팀원(연결 계정 + 지금 active 멤버)이 쓴 메시지만** AI에 보내고, 팀 밖 사람의
 *   메시지는 개수만 셉니다. 멘션은 표지로 바꿉니다: 팀원은 `[M1]`, 팀 밖 사람은 번호 없는 `[외부]`(여러 사람을 서로 구분·연결하지 못하게).
 *   첨부는 개수만 셉니다(`normalizeDiscordContent`). AI는 사람을 표지로만 부르고, 서버가 그 표지를 Peerchive 표시 이름(멤버) 또는
 *   "외부 참여자"로 되돌립니다(`replaceMeetingLabels`).
 * - 초안은 팀원(owner/editor) 승인 후에만 🗣️ 회의 로그가 됩니다(`meetingDraftToLogInput`이 로그 작성 입력의 기본값을 만듭니다).
 */

/** 한 번에 요약할 수 있는 최대 메시지 수(봇 명령의 `count` 상한). */
export const AI_MEETING_MAX_MESSAGES = 200
/** 기본 메시지 수. */
export const AI_MEETING_DEFAULT_MESSAGES = 100
/** 메시지 하나의 최대 길이(디스코드 일반 한도 2000자, Nitro 4000자는 잘라서 받음). */
export const AI_MEETING_MESSAGE_MAX = 2000
/** 한 번에 보내는 메시지 본문 합계 상한(문자). 봇이 오래된 메시지부터 덜어 맞춥니다. */
export const AI_MEETING_TOTAL_CHARS = 40_000
/** 고를 수 있는 시간 범위(시간). */
export const AI_MEETING_WINDOW_HOURS = [1, 2, 3, 6, 12, 24] as const
export const AI_MEETING_DEFAULT_WINDOW_HOURS = 2
/** 과제마다 하루(UTC) 요약 요청 상한(@peerchive/ai의 사용자·전체 상한과 별도). */
export const AI_MEETING_PROJECT_DAILY_LIMIT = 5
/** 과제마다 승인 대기 초안 상한(넘으면 먼저 처리해야 새로 요약). */
export const AI_MEETING_PENDING_DRAFTS_MAX = 3
/** 승인 대기 초안 보존: 만든 지 7일. */
export const AI_MEETING_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 요약 본문 상한(로그 본문 5000자 안에 열린 질문·표시 줄을 더할 자리를 남김). */
export const AI_MEETING_SUMMARY_MAX = 2000
/** 결정·후속 할 일·열린 질문 개수 상한(회의 로그 payload 한도 20개와 같음). */
export const AI_MEETING_ITEMS_MAX = 20
/** 결정·후속 할 일 한 줄 상한(회의 로그 payload 500자). */
export const AI_MEETING_ITEM_MAX = 500
/** 할 일 제목 상한(tasks.ts TITLE_MAX와 같음). */
export const AI_MEETING_TASK_TITLE_MAX = 120

// ── 동의 ────────────────────────────────────────────────────────────────

export interface MeetingConsentState {
  /** 지금 active 멤버 전원이 동의했는지(멤버가 0명이면 false). */
  allAgreed: boolean
  /** 아직 동의하지 않은 active 멤버 id. */
  missing: string[]
}

/**
 * 동의 상태: 동의 행은 "이 사람이 동의함"일 뿐이고, 요약 가능 여부는 **지금** active 멤버 전원이 동의했는지로 매번 계산합니다.
 * 나간 멤버의 예전 동의는 세지 않고(행도 나갈 때 지움), 새로 들어온 멤버는 동의하기 전까지 `missing`에 들어갑니다.
 */
export function meetingConsentState(activeMemberIds: readonly string[], consentedIds: readonly string[]): MeetingConsentState {
  const agreed = new Set(consentedIds)
  const missing = [...new Set(activeMemberIds)].filter((id) => !agreed.has(id))
  return { allAgreed: activeMemberIds.length > 0 && missing.length === 0, missing }
}

// ── 메시지 정리 ─────────────────────────────────────────────────────────

/** 프롬프트에서 사람을 가리키는 표지. 멤버는 `[M1]`, 팀 밖 사람은 번호 없는 `[외부]`(멘션에만 나오며, 사람끼리 구분하지 않음). */
export const memberLabel = (n: number) => `[M${n}]`
export const EXTERNAL_LABEL = '[외부]'

const USER_MENTION = /<@!?(\d{5,25})>/g
const ROLE_MENTION = /<@&\d{5,25}>/g
const CHANNEL_MENTION = /<#\d{5,25}>/g
const CUSTOM_EMOJI = /<a?:([A-Za-z0-9_]{1,32}):\d{5,25}>/g
const TIMESTAMP_TAG = /<t:(\d{1,13})(?::[tTdDfFR])?>/g

/**
 * 디스코드 메시지 본문을 프롬프트용으로 정리합니다(서버 메모리에서만, 저장하지 않음).
 * - 사용자 멘션 `<@123>` → `labelFor(id)`(멤버 `[M1]`·팀 밖 `[외부]` — 디스코드 이름은 쓰지 않음).
 * - 역할·채널 멘션 → `@역할`·`#채널`, 사용자 정의 이모지 → `:이름:`, 시각 태그 → `(시각)`.
 * - 제어 문자를 지우고, 앞뒤 공백을 다듬고, `max`자로 자릅니다.
 */
export function normalizeDiscordContent(content: string, labelFor: (discordUserId: string) => string, max = AI_MEETING_MESSAGE_MAX): string {
  const text = content
    .replace(USER_MENTION, (_m, id: string) => labelFor(id))
    .replace(ROLE_MENTION, '@역할')
    .replace(CHANNEL_MENTION, '#채널')
    .replace(CUSTOM_EMOJI, (_m, name: string) => `:${name}:`)
    .replace(TIMESTAMP_TAG, '(시각)')
    // 탭·줄바꿈만 남기고 제어 문자를 지웁니다.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 본문에서 멘션된 사용자 id(순서대로, 중복 없음). */
export function mentionedUserIds(content: string): string[] {
  const ids: string[] = []
  for (const match of content.matchAll(USER_MENTION)) if (match[1] && !ids.includes(match[1])) ids.push(match[1])
  return ids
}

// 모델이 번호를 붙여 낸 외부 표지(`[외부2]`)도 번호 없이 "외부 참여자"로 되돌립니다.
const LABEL_PATTERN = /\[(M|외부)(\d{0,3})\]/g

/**
 * AI 출력의 표지를 사람이 읽는 이름으로 되돌립니다. 멤버 표지는 `memberName(n)`(없으면 "팀원"), 외부 표지는 번호 없이 "외부 참여자".
 * 표지 밖의 글은 그대로 둡니다.
 */
export function replaceMeetingLabels(text: string, memberName: (n: number) => string | null): string {
  return text.replace(LABEL_PATTERN, (m, kind: string, n: string) => {
    if (kind !== 'M') return '외부 참여자'
    return n ? (memberName(Number(n)) ?? '팀원') : m
  })
}

/** 표지 하나(`[M2]`·`M2`·`[외부]`)를 해석합니다. 아니면 null. 외부 표지는 사람을 가리키지 않습니다(담당자 없음). */
export function parseMeetingLabel(value: string | null | undefined): { kind: 'member'; n: number } | { kind: 'external' } | null {
  const text = (value ?? '').trim()
  const member = /^\[?M(\d{1,3})\]?$/.exec(text)
  if (member) return { kind: 'member', n: Number(member[1]) }
  return /^\[?외부\d{0,3}\]?$/.test(text) ? { kind: 'external' } : null
}

// ── 초안 → 로그 ─────────────────────────────────────────────────────────

export interface MeetingFollowUp {
  text: string
  /** 담당 멤버(사용자 id). 외부 참여자·미정이면 null. */
  ownerId: string | null
  /** 기한(YYYY-MM-DD). 회의에서 말하지 않았으면 null. */
  due: string | null
}

export interface MeetingDraftContent {
  summary: string
  decisions: string[]
  followUps: MeetingFollowUp[]
  openQuestions: string[]
  /** 말한 멤버(사용자 id). */
  attendees: string[]
  /** 보내지 않고 뺀 팀 밖 참여자(연결 안 함·멤버 아님) 메시지 수. */
  excludedMessages: number
  attachmentsOmitted: number
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** 후속 할 일 한 줄(회의 로그 payload.followUps 문자열): "할 일 — 담당 이름, 기한 YYYY-MM-DD". */
export function followUpLine(item: MeetingFollowUp, nameOf: (userId: string) => string | null): string {
  const extra = [item.ownerId ? `담당 ${nameOf(item.ownerId) ?? '팀원'}` : null, item.due ? `기한 ${item.due}` : null].filter(Boolean)
  return cut(extra.length ? `${item.text} — ${extra.join(', ')}` : item.text, AI_MEETING_ITEM_MAX)
}

/**
 * 초안 → 🗣️ 회의 로그 작성 입력의 기본값(승인 화면이 이것을 채워 보여 주고, 사람이 고친 값으로 승인합니다).
 * 본문 = 요약 + 열린 질문 + "팀 밖 참여자 메시지 N개 제외" + "첨부 N개 생략". payload = 참석자·결정·후속 할 일(로그 한도 안).
 */
export function meetingDraftToLogInput(draft: MeetingDraftContent, nameOf: (userId: string) => string | null): { body: string; payload: { attendees: string[]; decisions: string[]; followUps: string[] } } {
  const parts = [draft.summary.trim()]
  if (draft.openQuestions.length > 0) parts.push(['열린 질문', ...draft.openQuestions.map((q) => `- ${q}`)].join('\n'))
  const notes = [
    draft.excludedMessages > 0 ? `팀 밖 참여자 메시지 ${draft.excludedMessages}개 제외` : null,
    draft.attachmentsOmitted > 0 ? `첨부 ${draft.attachmentsOmitted}개 생략` : null,
  ].filter(Boolean)
  if (notes.length > 0) parts.push(notes.join(' · '))
  return {
    body: cut(parts.filter(Boolean).join('\n\n'), 5000),
    payload: {
      attendees: [...new Set(draft.attendees)].slice(0, AI_MEETING_ITEMS_MAX),
      decisions: draft.decisions.slice(0, AI_MEETING_ITEMS_MAX).map((d) => cut(d, AI_MEETING_ITEM_MAX)),
      followUps: draft.followUps.slice(0, AI_MEETING_ITEMS_MAX).map((f) => followUpLine(f, nameOf)),
    },
  }
}

/** 실제 달력 날짜인 YYYY-MM-DD면 그대로, 아니면 null(모델이 낸 기한 확인용). */
export function validDueDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null
}
