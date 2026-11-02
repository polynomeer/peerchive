/**
 * `/summarize`(E-13, ADR 0058) 봇 흐름: 가짜 디스코드 어댑터 + 가짜 서버(서명 검증). 네트워크 없음.
 * 확인 단계에서 거절되면 메시지를 읽지 않는지, 읽은 메시지를 어떻게 정리해 한 번 보내는지, 크기 상한을 지키는지 봅니다.
 */
import { describe, expect, it } from 'vitest'
import { MEETING_LIMITS, MEETING_SUMMARY_MAX_BODY_BYTES } from '@peerchive/bot-protocol'
import { createPeerchiveApi } from '../src/api-client'
import { COMMAND_DEFINITIONS, parseCommand } from '../src/commands'
import type { FetchedMessage } from '../src/gateway'
import { createHandlers, meetingPayload, wireGateway } from '../src/handlers'
import { FakeGateway, FakeServer, SECRET, SITE } from './fakes'

const USER = '111111'
const OTHER = '222222'
/** 연결하지 않은(팀 밖) 참여자. */
const OUTSIDER = '333333'
const BOT = '999999'
const CHANNEL = '555555'
const GUILD = '444444'
const NOW = new Date('2026-10-20T05:00:00Z')
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000)

let seq = 0
const msg = (overrides: Partial<FetchedMessage> = {}): FetchedMessage => ({
  id: String(810000 + ++seq),
  authorId: USER,
  authorIsBot: false,
  isSystem: false,
  content: '회의 내용',
  attachmentCount: 0,
  createdAt: minutesAgo(10),
  ...overrides,
})

function setup() {
  const server = new FakeServer()
  server.linked.add(OTHER)
  const gateway = new FakeGateway()
  const api = createPeerchiveApi({ baseUrl: SITE, secret: SECRET, fetch: server.fetch })
  const handlers = createHandlers(api, { siteUrl: SITE, log: () => {}, now: () => NOW })
  wireGateway(gateway, handlers)
  const run = (options: Record<string, string> = {}, interactionId = '700100') =>
    gateway.command!({ interactionId, guildId: GUILD, channelId: CHANNEL, userId: USER, name: 'summarize', subcommand: null, options })
  return { server, gateway, run }
}

describe('/summarize command definition and parsing', () => {
  it('registers a guild-only command with window choices and a bounded count', () => {
    const def = COMMAND_DEFINITIONS.find((c) => c.name === 'summarize')!
    expect(def.contexts).toEqual([0])
    expect(def.options[0]).toMatchObject({ name: 'window', required: false })
    expect(def.options[0].choices.map((c) => c.value)).toEqual(['1', '2', '3', '6', '12', '24'])
    expect(def.options[1]).toMatchObject({ name: 'count', type: 4, min_value: 1, max_value: 200 })
  })

  it('defaults to 2 hours and 100 messages and clamps bad values', () => {
    expect(parseCommand('summarize', null, {})).toEqual({ kind: 'summarize', windowHours: 2, count: 100 })
    expect(parseCommand('summarize', null, { window: '6', count: '30' })).toEqual({ kind: 'summarize', windowHours: 6, count: 30 })
    expect(parseCommand('summarize', null, { window: '5', count: '9999' })).toEqual({ kind: 'summarize', windowHours: 2, count: 200 })
    expect(parseCommand('summarize', null, { count: 'x' })).toMatchObject({ count: 100 })
  })
})

describe('/summarize through the fake gateway', () => {
  it('when the server refuses (AI off, no consent, …) it explains and never reads or sends messages', async () => {
    for (const [status, text] of [
      ['ai_disabled', 'AI 기능이 켜져 있지 않아'],
      ['no_consent', '팀원 전원이 이 채널의 회의 요약에 동의하지 않았어요(아직 2명)'],
      ['not_meeting_channel', '회의 채널로 지정되지 않았어요'],
      ['not_linked', '/peerchive link'],
      ['not_bound', '연결되어 있지 않아요'],
      ['not_writer', '편집 권한'],
      ['drafts_pending', '승인을 기다리는'],
    ] as const) {
      const ctx = setup()
      ctx.gateway.channelMessages.set(CHANNEL, [msg({ content: '비밀 회의 내용' })])
      ctx.server.meetingCheckStatus = status
      const reply = await ctx.run()
      expect(reply, status).toEqual({ type: 'message', content: expect.stringContaining(text) })
      expect(ctx.gateway.fetches, status).toEqual([])
      expect(ctx.server.summaries, status).toEqual([])
      expect(ctx.server.calls.map((c) => c.path), status).toEqual(['/api/internal/discord/meeting-summaries/check'])
    }
  })

  it('reads the chosen window once, drops bot/system and non-member messages (count only), keeps attachment counts and raw mentions, and sends one signed request', async () => {
    const ctx = setup()
    ctx.gateway.channelMessages.set(CHANNEL, [
      msg({ content: '아주 예전 이야기', createdAt: minutesAgo(400) }),
      msg({ content: '<@222222> 로그인 API 언제까지 돼요?', createdAt: minutesAgo(50) }),
      msg({ authorId: BOT, authorIsBot: true, content: '🔔 체크인 알림', createdAt: minutesAgo(40) }),
      msg({ authorId: OTHER, content: '금요일까지 할게요', attachmentCount: 2, createdAt: minutesAgo(30) }),
      msg({ authorId: OUTSIDER, content: '팀 밖 사람의 비밀 OUTSIDER-MARK', attachmentCount: 3, createdAt: minutesAgo(25) }),
      msg({ isSystem: true, content: '', createdAt: minutesAgo(20) }),
      msg({ authorId: OTHER, content: '', attachmentCount: 1, createdAt: minutesAgo(10) }),
    ])
    const reply = await ctx.run({ window: '2', count: '50' })
    expect(reply).toEqual({ type: 'message', content: expect.stringContaining('🗣️ 회의 로그 초안을 만들었어요') })
    expect(ctx.gateway.fetches).toEqual([{ channelId: CHANNEL, since: minutesAgo(120), limit: 50 }])
    expect(ctx.server.summaries).toHaveLength(1)
    const sent = ctx.server.summaries[0]!
    expect(sent).toMatchObject({
      interactionId: '700100',
      guildId: GUILD,
      channelId: CHANNEL,
      discordUserId: USER,
      windowStart: minutesAgo(120).toISOString(),
      windowEnd: NOW.toISOString(),
      skippedBotMessages: 2,
      excludedMessages: 1,
    })
    expect(sent.messages).toEqual([
      { authorId: USER, content: '<@222222> 로그인 API 언제까지 돼요?', attachmentCount: 0, createdAt: minutesAgo(50).toISOString() },
      { authorId: OTHER, content: '금요일까지 할게요', attachmentCount: 2, createdAt: minutesAgo(30).toISOString() },
      { authorId: OTHER, content: '', attachmentCount: 1, createdAt: minutesAgo(10).toISOString() },
    ])
    expect(JSON.stringify(sent)).not.toContain('체크인 알림')
    expect(JSON.stringify(sent)).not.toContain('아주 예전 이야기')
    expect(JSON.stringify(sent)).not.toContain('OUTSIDER-MARK')
    expect(JSON.stringify(sent)).not.toContain(OUTSIDER)
  })

  it('replies without sending when nothing is left, and explains a missing Read Message History permission', async () => {
    const ctx = setup()
    ctx.gateway.channelMessages.set(CHANNEL, [msg({ authorId: BOT, authorIsBot: true })])
    expect(await ctx.run()).toEqual({ type: 'message', content: expect.stringContaining('요약할 메시지가 없어요') })
    ctx.gateway.unreachableChannels.add(CHANNEL)
    expect(await ctx.run({}, '700101')).toEqual({ type: 'message', content: expect.stringContaining('Read Message History') })
    expect(ctx.server.summaries).toEqual([])
  })

  it('does not retry the summary request on a 5xx (no double AI call)', async () => {
    const ctx = setup()
    ctx.gateway.channelMessages.set(CHANNEL, [msg()])
    // 확인은 통과시키고(첫 응답), 요약 응답만 잃어버리도록 확인 뒤에 설정합니다.
    const originalFetch = ctx.server.fetch
    ctx.server.fetch = async (url, init) => {
      if (url.endsWith('/meeting-summaries')) ctx.server.dropResponses = 1
      return originalFetch(url, init)
    }
    const api = createPeerchiveApi({ baseUrl: SITE, secret: SECRET, fetch: ctx.server.fetch })
    const handlers = createHandlers(api, { siteUrl: SITE, log: () => {}, now: () => NOW })
    const reply = await handlers.handleCommand(
      { interactionId: '700102', guildId: GUILD, channelId: CHANNEL, userId: USER, name: 'summarize', subcommand: null, options: {} },
      ctx.gateway,
    )
    expect(reply).toEqual({ type: 'message', content: expect.stringContaining('Peerchive에 연결할 수 없어요') })
    expect(ctx.server.calls.filter((c) => c.path.endsWith('/meeting-summaries'))).toHaveLength(1)
  })
})

describe('meetingPayload limits', () => {
  it('sends nothing but a count for authors outside the member list (empty list → nothing sent)', () => {
    const base0 = { interactionId: '1', guildId: GUILD, channelId: CHANNEL, discordUserId: USER, windowStart: minutesAgo(60).toISOString(), windowEnd: NOW.toISOString() }
    const fetched = [msg({ content: '팀원' }), msg({ authorId: OUTSIDER, content: '밖' }), msg({ authorId: OUTSIDER, content: '' , attachmentCount: 1 })]
    expect(meetingPayload(fetched, base0, [USER])).toMatchObject({ messages: [{ authorId: USER, content: '팀원' }], excludedMessages: 2 })
    expect(meetingPayload(fetched, base0, [])).toMatchObject({ messages: [], excludedMessages: 3 })
  })

  const base = { interactionId: '1', guildId: GUILD, channelId: CHANNEL, discordUserId: USER, windowStart: minutesAgo(60).toISOString(), windowEnd: NOW.toISOString() }

  it('cuts each message to 2000 chars, keeps at most 200 and drops the oldest first to fit 40,000 chars', () => {
    const many = Array.from({ length: 250 }, (_v, i) => msg({ content: `${i}:${'가'.repeat(400)}`, createdAt: new Date(NOW.getTime() - (250 - i) * 1000) }))
    const payload = meetingPayload(many, base, [USER])
    expect(payload.messages.length).toBeLessThanOrEqual(MEETING_LIMITS.maxMessages)
    expect(payload.messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MEETING_LIMITS.totalChars)
    // 가장 최근 메시지가 남습니다.
    expect(payload.messages.at(-1)!.content.startsWith('249:')).toBe(true)
    expect(payload.messages[0]!.content.startsWith('0:')).toBe(false)

    const long = meetingPayload([msg({ content: 'x'.repeat(3900) })], base, [USER])
    expect(long.messages[0]!.content).toHaveLength(MEETING_LIMITS.messageChars)
  })

  it('stays under the 256KB body cap even for pathological content (escaped control characters)', () => {
    // 제어 문자는 JSON에서 6바이트(\\u0001)라, 본문 합계 40,000자 안이어도 19자리 작성자 id와 함께면 256KB에 닿습니다.
    const nasty = Array.from({ length: 200 }, (_v, i) => msg({ authorId: '1234567890123456789', content: '\u0001'.repeat(200), createdAt: new Date(NOW.getTime() - (200 - i) * 1000) }))
    const payload = meetingPayload(nasty, base, ['1234567890123456789'])
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(MEETING_SUMMARY_MAX_BODY_BYTES)
    expect(payload.messages.length).toBeGreaterThan(0)
    expect(payload.messages.length).toBeLessThan(200)
  })
})
