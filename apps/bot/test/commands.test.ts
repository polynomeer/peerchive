import { describe, expect, it } from 'vitest'
import {
  COMMAND_DEFINITIONS,
  TAG_CHOICES,
  parseCommand,
  parseModalCustomId,
  parsePinButtonId,
  parseTag,
  pinButtonId,
} from '../src/commands'
import { loadBotConfig } from '../src/config'

describe('command parsing', () => {
  it('parses /peerchive subcommands', () => {
    expect(parseCommand('peerchive', 'link', { code: ' ABCD-EFGH-JK ' })).toEqual({ kind: 'link', code: 'ABCD-EFGH-JK' })
    expect(parseCommand('peerchive', 'bind', { code: 'X' })).toEqual({ kind: 'bind', code: 'X' })
    expect(parseCommand('peerchive', 'link', {})).toEqual({ kind: 'invalid', reason: 'missing_code' })
    expect(parseCommand('peerchive', 'help', {})).toEqual({ kind: 'help' })
    expect(parseCommand('peerchive', 'nope', {})).toEqual({ kind: 'invalid', reason: 'unknown_command' })
    expect(parseCommand('other', null, {})).toEqual({ kind: 'invalid', reason: 'unknown_command' })
  })

  it('parses /log with enum values or Korean tag names', () => {
    expect(parseCommand('log', null, { tag: 'stuck', text: ' CORS 에러 ', time: 'lt2h' })).toEqual({
      kind: 'log',
      tag: 'stuck',
      text: 'CORS 에러',
      timeBucket: 'lt2h',
    })
    expect(parseTag('막힘')).toBe('stuck')
    expect(parseTag('🧱 막힘')).toBe('stuck')
    expect(parseTag('회고')).toBe('retro')
    expect(parseTag('blocked')).toBeNull()
    expect(parseCommand('log', null, { tag: 'progress', text: 'x', time: 'forever' })).toMatchObject({ timeBucket: null })
    expect(parseCommand('log', null, { tag: 'progress', text: 'x'.repeat(2001) })).toEqual({ kind: 'invalid', reason: 'text_too_long' })
  })

  it('round-trips custom ids and rejects tampered ones', () => {
    const id = '0b6f1e9c-1d2a-4f3b-8c4d-5e6f7a8b9c0d'
    expect(parsePinButtonId(pinButtonId('approve', id))).toEqual({ decision: 'approve', requestId: id })
    expect(parsePinButtonId('pc:pin:approve:not-a-uuid')).toBeNull()
    expect(parsePinButtonId(`pc:pin:delete:${id}`)).toBeNull()
    expect(parseModalCustomId('pc:log:decision')).toBe('decision')
    expect(parseModalCustomId('pc:log:progress')).toBeNull()
  })

  it('defines guild-only commands with all seven tag choices', () => {
    const log = COMMAND_DEFINITIONS.find((c) => c.name === 'log')!
    expect(log.options[0].choices.map((c) => c.value)).toEqual(TAG_CHOICES.map((c) => c.value))
    expect(TAG_CHOICES.map((c) => c.name.split(' ')[1])).toEqual(['진행', '막힘', '해결', '결정', '회의', '검증', '회고'])
    for (const command of COMMAND_DEFINITIONS) expect(command.contexts).toEqual([0])
  })
})

describe('bot config', () => {
  const strong = 'f3a9c1e07b5d42868a1e9c3b7d0f6a25e8b4c2d19f7a6e30'

  it('refuses to start in production without a strong secret or API URL', () => {
    const base = { DISCORD_BOT_TOKEN: 'token', PEERCHIVE_API_BASE_URL: 'https://peerchive.example' }
    expect(() => loadBotConfig({ ...base, PEERCHIVE_INTERNAL_SECRET: 'local-dev-only-change-me-0123456789abcdef' })).toThrow(
      /PEERCHIVE_INTERNAL_SECRET/,
    )
    expect(() => loadBotConfig({ DISCORD_BOT_TOKEN: 'token', PEERCHIVE_INTERNAL_SECRET: strong })).toThrow(/PEERCHIVE_API_BASE_URL/)
    expect(loadBotConfig({ ...base, PEERCHIVE_INTERNAL_SECRET: strong })).toMatchObject({
      production: true,
      apiBaseUrl: 'https://peerchive.example',
      siteUrl: 'https://peerchive.example',
    })
  })

  it('requires a token and a secret even in development', () => {
    expect(() => loadBotConfig({ NODE_ENV: 'development', PEERCHIVE_INTERNAL_SECRET: strong })).toThrow(/DISCORD_BOT_TOKEN/)
    expect(() => loadBotConfig({ NODE_ENV: 'development', DISCORD_BOT_TOKEN: 't' })).toThrow(/PEERCHIVE_INTERNAL_SECRET/)
    expect(
      loadBotConfig({ NODE_ENV: 'development', DISCORD_BOT_TOKEN: 't', PEERCHIVE_INTERNAL_SECRET: 'local-dev-only-change-me-0123456789abcdef' }),
    ).toMatchObject({ production: false, apiBaseUrl: 'http://localhost:3000' })
  })
})
