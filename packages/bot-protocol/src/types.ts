/**
 * 내부 API(`/api/internal/discord/*`) 요청·응답 타입. 봇과 웹 서버가 같은 타입을 씁니다(ADR 0009).
 *
 * - 모든 요청은 POST + JSON 본문 + HMAC 서명입니다(signature.ts).
 * - 업무 결과는 HTTP 200의 `status`로 돌려줍니다(봇이 그에 맞는 안내 문장을 고름). 서명 실패는 401,
 *   요청 형식 오류는 422, 내부 API가 꺼져 있으면 503입니다.
 * - 디스코드 id(snowflake)는 숫자 문자열입니다. 메시지 본문은 📌 수집에서만 보내며, 서버는 로그를 만들거나
 *   승인 대기 중일 때만 그 내용을 둡니다.
 * - 예외: AI 회의 요약(E-13, ADR 0058)은 팀 전원이 동의한 회의 채널의 최근 메시지를 한 번에 보냅니다. 서버는 그 원문을 메모리에서만
 *   다루고(AI에 보내 초안을 만든 뒤 버림) DB·로그 어디에도 저장하지 않습니다. 이 경로만 본문 상한이 256KB입니다.
 */

export const INTERNAL_PATHS = {
  link: '/api/internal/discord/link',
  bind: '/api/internal/discord/bind',
  log: '/api/internal/discord/logs',
  pin: '/api/internal/discord/pins',
  pinDecision: '/api/internal/discord/pin-decisions',
  claimNotices: '/api/internal/discord/notices/claim',
  ackNotice: '/api/internal/discord/notices/ack',
  meetingCheck: '/api/internal/discord/meeting-summaries/check',
  meetingSummary: '/api/internal/discord/meeting-summaries',
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

// ── AI 회의 요약(E-13, ADR 0058) ──

/**
 * 회의 요약 요청 본문 상한(바이트). 다른 내부 API는 64KB입니다. 메시지 최대 200개·본문 합계 40,000자(한글은 UTF-8 3바이트)에 JSON 틀을 더하면
 * 64KB를 넘을 수 있어 이 경로만 올립니다. 나눠 보내기(chunking)는 서버가 조각을 모아 두어야 해(원문 저장) 쓰지 않습니다.
 * 봇은 보내기 전에 직렬화한 크기를 재고 오래된 메시지부터 덜어 이 안에 맞춥니다.
 */
export const MEETING_SUMMARY_MAX_BODY_BYTES = 256 * 1024

/** 회의 요약 한 번에 보내는 메시지 한도(서버가 검증, 봇이 맞춰 보냄). */
export const MEETING_LIMITS = {
  /** 메시지 수. */
  maxMessages: 200,
  /** 메시지 하나의 길이(봇은 이만큼 잘라 보냄. 서버는 4000자까지 받고 프롬프트에는 2000자). */
  messageChars: 2000,
  /** 본문 합계(문자). */
  totalChars: 40_000,
  /** 시간 범위 선택지(시간). */
  windowHours: [1, 2, 3, 6, 12, 24],
  defaultWindowHours: 2,
  defaultMessages: 100,
} as const

/** 요약 전에 확인(메시지를 읽기 전에): AI 설정·채널 연결·계정 연결·쓰기 권한·회의 채널 동의·승인 대기 초안 수. */
export interface MeetingCheckRequest {
  guildId: string
  channelId: string
  discordUserId: string
}

export type MeetingRefusal =
  /** 서버에 AI가 설정되어 있지 않음(PEERCHIVE_AI_ENABLED·키 없음). */
  | 'ai_disabled'
  | 'not_bound'
  | 'not_linked'
  /** 과제의 owner/editor가 아님. */
  | 'not_writer'
  /** 이 채널이 회의 채널로 제안되지 않음. */
  | 'not_meeting_channel'
  /** 팀원 전원이 동의하지 않음(철회·새 멤버 포함). */
  | 'no_consent'
  /** 승인 대기 초안이 너무 많음. */
  | 'drafts_pending'

export interface MeetingCheckResponse {
  status: 'ready' | MeetingRefusal
  /**
   * ready일 때: 이 채널에서 메시지를 보낼 수 있는 디스코드 사용자 id(연결 계정 + 지금 active 멤버 = 모두 동의한 팀원).
   * 봇은 이 밖의 작성자 메시지를 보내지 않고 개수만 셉니다(서버도 다시 걸러 냄).
   */
  memberDiscordIds?: string[]
  /** no_consent일 때 아직 동의하지 않은 멤버 수. */
  missingConsents?: number
  projectUrl?: string
}

export interface MeetingMessage {
  /** 디스코드 메시지 작성자 id. 봇 메시지·팀 밖 참여자 메시지는 보내지 않습니다. */
  authorId: string
  /** 본문 원문(멘션 `<@id>`는 서버가 표지로 바꿈). 첨부는 보내지 않고 개수만. */
  content: string
  attachmentCount: number
  /** 메시지 시각(ISO). 순서·회의 날짜에만 씁니다. */
  createdAt: string
}

export interface MeetingSummaryRequest {
  /** 디스코드 interaction id. 같은 요청을 다시 보내도 초안은 하나입니다. */
  interactionId: string
  guildId: string
  channelId: string
  discordUserId: string
  /** 고른 시간 범위의 시작·끝(ISO). */
  windowStart: string
  windowEnd: string
  /** 오래된 것부터. 최대 200개, 본문 합계 40,000자. */
  messages: MeetingMessage[]
  /** 봇이 건너뛴 봇 메시지 수(정보용). */
  skippedBotMessages?: number
  /** 봇이 보내지 않고 뺀 팀 밖 참여자 메시지 수(초안에 "팀 밖 참여자 메시지 N개 제외"로 남김). */
  excludedMessages?: number
}

export interface MeetingSummaryResponse {
  status:
    | 'drafted'
    | 'duplicate'
    | 'empty'
    | 'rate_limited'
    /** AI가 거절함(`stop_reason: refusal`). */
    | 'ai_declined'
    /** AI 공급자 오류·시간 초과. */
    | 'ai_unavailable'
    | MeetingRefusal
  /** drafted·duplicate일 때 초안을 볼 과제 화면 주소. */
  draftUrl?: string
  missingConsents?: number
  projectUrl?: string
}
