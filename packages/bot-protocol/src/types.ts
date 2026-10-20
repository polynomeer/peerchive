/**
 * 내부 API(`/api/internal/discord/*`) 요청·응답 타입. 봇과 웹 서버가 같은 타입을 씁니다(ADR 0009).
 *
 * - 모든 요청은 POST + JSON 본문 + HMAC 서명입니다(signature.ts).
 * - 업무 결과는 HTTP 200의 `status`로 돌려줍니다(봇이 그에 맞는 안내 문장을 고름). 서명 실패는 401,
 *   요청 형식 오류는 422, 내부 API가 꺼져 있으면 503입니다.
 * - 디스코드 id(snowflake)는 숫자 문자열입니다. 메시지 본문은 📌 수집에서만 보내며, 서버는 로그를 만들거나
 *   승인 대기 중일 때만 그 내용을 둡니다.
 */

export const INTERNAL_PATHS = {
  link: '/api/internal/discord/link',
  bind: '/api/internal/discord/bind',
  log: '/api/internal/discord/logs',
  pin: '/api/internal/discord/pins',
  pinDecision: '/api/internal/discord/pin-decisions',
  claimNotices: '/api/internal/discord/notices/claim',
  ackNotice: '/api/internal/discord/notices/ack',
} as const

/** `/log`로 받는 태그(서버 enum 값). 한국어 선택지는 봇의 commands.ts에 있습니다. */
export type DiscordLogTag = 'progress' | 'stuck' | 'solution' | 'decision' | 'meeting' | 'validation' | 'retro'
export type DiscordTimeBucket = 'lt30m' | 'lt2h' | 'half_day' | 'day_plus'

// ── 계정 연결 ──

export interface LinkRequest {
  discordUserId: string
  code: string
}
export interface LinkResponse {
  /** relinked: 이 Peerchive 계정에 연결돼 있던 다른 디스코드 계정을 이 계정으로 바꿈. */
  status: 'linked' | 'relinked' | 'already_linked' | 'invalid_code' | 'discord_account_in_use' | 'rate_limited'
}

// ── 채널 연결 ──

export interface BindRequest {
  discordUserId: string
  guildId: string
  channelId: string
  code: string
  /** 표시용 채널 이름(선택). 저장하지 않아도 동작합니다. */
  label?: string | null
}
export interface BindResponse {
  status: 'bound' | 'already_bound' | 'invalid_code' | 'not_linked' | 'not_owner' | 'channel_taken' | 'rate_limited'
  projectTitle?: string
  projectUrl?: string
}

// ── /log ──

export interface LogRequest {
  /** 디스코드 interaction id. 서버가 이 값으로 clientId를 만들어 재전송해도 로그를 하나만 만듭니다. */
  interactionId: string
  guildId: string
  channelId: string
  discordUserId: string
  tag: DiscordLogTag
  text: string
  /** 🧱막힘의 막힌 시간(선택, 없으면 lt30m). */
  timeBucket?: DiscordTimeBucket | null
  /** 모달로 받은 태그별 필드(⚖️결정: options(줄마다 하나)·criteria·choice, ✅검증: target·conditions·result). */
  fields?: Record<string, string> | null
}
export interface LogResponse {
  status: 'created' | 'duplicate' | 'not_bound' | 'not_linked' | 'not_writer' | 'invalid' | 'web_only'
  logUrl?: string
  projectUrl?: string
  /** invalid일 때 필드별 오류 코드(빌드 로그 검증 그대로, 예: `payload.options: too_few`). */
  fields?: Record<string, string>
}

// ── 📌 반응 ──

export interface PinRequest {
  guildId: string
  channelId: string
  messageId: string
  messageAuthorId: string
  reactorId: string
  content: string
  attachmentCount: number
  messageUrl?: string | null
}
export interface PinResponse {
  status:
    | 'created'
    | 'duplicate'
    | 'approval_requested'
    | 'already_requested'
    | 'already_decided'
    | 'not_bound'
    | 'not_linked'
    | 'not_member'
    | 'author_unavailable'
    | 'empty'
  logUrl?: string
  /** approval_requested일 때: 작성자에게 보낼 승인 요청. */
  approval?: {
    requestId: string
    authorDiscordId: string
    expiresAt: string
    /** 작성자에게 보여 줄 메시지 앞부분(최대 200자). */
    preview: string
    projectTitle: string
  }
}

export interface PinDecisionRequest {
  requestId: string
  /** 버튼을 누른 디스코드 사용자. 메시지 작성자와 같아야 합니다. */
  discordUserId: string
  decision: 'approve' | 'reject'
}
export interface PinDecisionResponse {
  status: 'approved' | 'rejected' | 'expired' | 'not_found' | 'already_decided' | 'author_unavailable'
  logUrl?: string
}

// ── 예약 알림(체크인 알림·주간 요약) ──

export type NoticeKind = 'checkin_reminder' | 'weekly_summary'

export interface ClaimNoticesResponse {
  notices: Array<{ id: string; channelId: string; kind: NoticeKind; isoWeek: string; content: string }>
}
export interface AckNoticeRequest {
  id: string
  delivered: boolean
  discordMessageId?: string | null
}
export interface AckNoticeResponse {
  status: 'ok' | 'not_found'
}
