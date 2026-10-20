/**
 * 슬래시 명령 정의와 입력 해석. 등록 JSON은 디스코드 API 형식(application command)이며 discord.js 없이 만듭니다.
 *
 * - `/peerchive link 코드` · `/peerchive bind 코드` · `/peerchive help`
 * - `/log 태그 내용 [시간]` — 태그 선택지는 한국어(진행/막힘/해결/결정/회의/검증/회고), 값은 서버 enum.
 */
import type { DiscordLogTag, DiscordTimeBucket } from '@peerchive/bot-protocol'

export const PIN_EMOJI = '📌'
export const TEXT_MAX = 2000
export const CODE_MAX = 20

export const TAG_CHOICES: Array<{ name: string; value: DiscordLogTag }> = [
  { name: '🔨 진행', value: 'progress' },
  { name: '🧱 막힘', value: 'stuck' },
  { name: '💡 해결', value: 'solution' },
  { name: '⚖️ 결정', value: 'decision' },
  { name: '🗣️ 회의', value: 'meeting' },
  { name: '✅ 검증', value: 'validation' },
  { name: '🔁 회고', value: 'retro' },
]

export const TAG_LABELS = Object.fromEntries(TAG_CHOICES.map((c) => [c.value, c.name])) as Record<DiscordLogTag, string>

/** 사람이 직접 친 태그 이름도 받습니다(예: "막힘"). */
const TAG_ALIASES: Record<string, DiscordLogTag> = {
  진행: 'progress',
  막힘: 'stuck',
  해결: 'solution',
  결정: 'decision',
  회의: 'meeting',
  검증: 'validation',
  회고: 'retro',
}

export const TIME_CHOICES: Array<{ name: string; value: DiscordTimeBucket }> = [
  { name: '30분 미만', value: 'lt30m' },
  { name: '2시간 미만', value: 'lt2h' },
  { name: '반나절', value: 'half_day' },
  { name: '하루 이상', value: 'day_plus' },
]

const STRING = 3
const SUB_COMMAND = 1
/** 서버 채널에서만(길드 설치, 길드 컨텍스트). */
const GUILD_ONLY = { contexts: [0], integration_types: [0] }

export const COMMAND_DEFINITIONS = [
  {
    name: 'peerchive',
    description: 'Peerchive 계정·채널 연결',
    ...GUILD_ONLY,
    options: [
      {
        type: SUB_COMMAND,
        name: 'link',
        description: '내 디스코드 계정을 Peerchive 계정에 연결합니다(웹에서 만든 10분짜리 코드).',
        options: [{ type: STRING, name: 'code', description: '연결 코드', required: true, max_length: CODE_MAX }],
      },
      {
        type: SUB_COMMAND,
        name: 'bind',
        description: '이 채널을 Peerchive 과제에 연결합니다(owner가 웹에서 만든 코드).',
        options: [{ type: STRING, name: 'code', description: '채널 연결 코드', required: true, max_length: CODE_MAX }],
      },
      { type: SUB_COMMAND, name: 'help', description: '사용법' },
    ],
  },
  {
    name: 'log',
    description: '이 채널에 연결된 과제에 빌드 로그를 남깁니다.',
    ...GUILD_ONLY,
    options: [
      { type: STRING, name: 'tag', description: '태그', required: true, choices: TAG_CHOICES },
      { type: STRING, name: 'text', description: '내용', required: true, max_length: TEXT_MAX },
      { type: STRING, name: 'time', description: '막힌 시간(🧱 막힘, 선택)', required: false, choices: TIME_CHOICES },
    ],
  },
] as const

export type ParsedCommand =
  | { kind: 'link'; code: string }
  | { kind: 'bind'; code: string }
  | { kind: 'help' }
  | { kind: 'log'; tag: DiscordLogTag; text: string; timeBucket: DiscordTimeBucket | null }
  | { kind: 'invalid'; reason: 'unknown_command' | 'missing_code' | 'unknown_tag' | 'empty_text' | 'text_too_long' }

export function parseTag(value: string | undefined): DiscordLogTag | null {
  if (!value) return null
  const trimmed = value.trim()
  const byValue = TAG_CHOICES.find((c) => c.value === trimmed)
  return byValue?.value ?? TAG_ALIASES[trimmed.replace(/^[^\p{L}]+/u, '')] ?? null
}

export function parseCommand(name: string, subcommand: string | null, options: Record<string, string | undefined>): ParsedCommand {
  if (name === 'peerchive') {
    if (subcommand === 'help') return { kind: 'help' }
    if (subcommand === 'link' || subcommand === 'bind') {
      const code = options.code?.trim() ?? ''
      return code ? { kind: subcommand, code } : { kind: 'invalid', reason: 'missing_code' }
    }
    return { kind: 'invalid', reason: 'unknown_command' }
  }
  if (name === 'log') {
    const tag = parseTag(options.tag)
    if (!tag) return { kind: 'invalid', reason: 'unknown_tag' }
    const text = options.text?.trim() ?? ''
    if (!text) return { kind: 'invalid', reason: 'empty_text' }
    if (text.length > TEXT_MAX) return { kind: 'invalid', reason: 'text_too_long' }
    const timeBucket = TIME_CHOICES.find((c) => c.value === options.time)?.value ?? null
    return { kind: 'log', tag, text, timeBucket }
  }
  return { kind: 'invalid', reason: 'unknown_command' }
}

// ── 사용자 정의 id(customId) ──

export const MODAL_PREFIX = 'pc:log:'
export const PIN_BUTTON_PREFIX = 'pc:pin:'

export const modalCustomId = (tag: DiscordLogTag) => `${MODAL_PREFIX}${tag}`

export function parseModalCustomId(customId: string): DiscordLogTag | null {
  if (!customId.startsWith(MODAL_PREFIX)) return null
  const tag = customId.slice(MODAL_PREFIX.length)
  return tag === 'decision' || tag === 'validation' ? tag : null
}

export const pinButtonId = (decision: 'approve' | 'reject', requestId: string) => `${PIN_BUTTON_PREFIX}${decision}:${requestId}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parsePinButtonId(customId: string): { decision: 'approve' | 'reject'; requestId: string } | null {
  if (!customId.startsWith(PIN_BUTTON_PREFIX)) return null
  const [decision, requestId] = customId.slice(PIN_BUTTON_PREFIX.length).split(':')
  if ((decision !== 'approve' && decision !== 'reject') || !requestId || !UUID.test(requestId)) return null
  return { decision, requestId }
}
