import { beforeEach, describe, expect, it } from 'vitest'
import { HEADER_NONCE } from '@peerchive/bot-protocol'
import { createPeerchiveApi } from '../src/api-client'
import { createHandlers, wireGateway } from '../src/handlers'
import { FakeGateway, FakeServer, SECRET, SITE } from './fakes'

const AUTHOR = '111111'
const OTHER = '222222'
const UNLINKED = '333333'
const CHANNEL = '555555'
const GUILD = '444444'

function setup() {
  const server = new FakeServer()
  server.linked.add(OTHER)
  const gateway = new FakeGateway()
  const api = createPeerchiveApi({ baseUrl: SITE, secret: SECRET, fetch: server.fetch })
  const handlers = createHandlers(api, { siteUrl: SITE, log: () => {} })
  wireGateway(gateway, handlers)
  return { server, gateway, handlers }
}

const command = (options: Record<string, string>, overrides: Partial<Parameters<NonNullable<FakeGateway['command']>>[0]> = {}) => ({
  interactionId: '700001',
  guildId: GUILD,
  channelId: CHANNEL,
  userId: AUTHOR,
  name: 'log',
  subcommand: null,
  options,
  ...overrides,
})

const reaction = (overrides: Record<string, unknown> = {}) => ({
  emoji: '📌',
  guildId: GUILD,
  channelId: CHANNEL,
  messageId: '800001',
  messageAuthorId: AUTHOR,
  messageAuthorIsBot: false,
  reactorId: AUTHOR,
  reactorIsBot: false,
  content: 'CORS 에러를 프록시로 우회함',
  attachmentCount: 0,
  messageUrl: null,
  ...overrides,
})

describe('/log through the fake gateway', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('creates one stuck log and answers ephemerally with the link', async () => {
    const reply = await ctx.gateway.command!(command({ tag: 'stuck', text: 'CORS 에러' }))
    expect(reply).toEqual({ type: 'message', content: expect.stringContaining('🧱 막힘 로그를 남겼어요') })
    expect(ctx.server.logs.size).toBe(1)
    expect(ctx.server.calls[0]).toMatchObject({ body: { tag: 'stuck', text: 'CORS 에러', interactionId: '700001', timeBucket: null } })
  })

  it('keeps a single log when the response is lost and the client retries (same interaction id, new nonce)', async () => {
    ctx.server.dropResponses = 1
    const reply = await ctx.gateway.command!(command({ tag: 'progress', text: '로그인 화면 완성' }))
    expect(ctx.server.calls).toHaveLength(2)
    expect(ctx.server.calls[0]!.body).toEqual(ctx.server.calls[1]!.body)
    expect(ctx.server.logs.size).toBe(1)
    expect(reply.type === 'message' && reply.content).toContain('이미 저장된 요청')
    // Discord가 같은 interaction을 다시 보내도 하나.
    await ctx.gateway.command!(command({ tag: 'progress', text: '로그인 화면 완성' }))
    expect(ctx.server.logs.size).toBe(1)
  })

  it('opens a modal for decisions and reports validation errors from the server', async () => {
    const reply = await ctx.gateway.command!(command({ tag: 'decision', text: 'DB 선택' }))
    expect(reply).toMatchObject({ type: 'modal', customId: 'pc:log:decision' })
    expect(reply.type === 'modal' && reply.fields.map((f) => f.customId)).toEqual(['text', 'options', 'criteria', 'choice'])
    expect(reply.type === 'modal' && reply.fields[0]!.value).toBe('DB 선택')
    expect(ctx.server.calls).toHaveLength(0)

    const bad = await ctx.gateway.modal!({
      interactionId: '700002',
      guildId: GUILD,
      channelId: CHANNEL,
      userId: AUTHOR,
      customId: 'pc:log:decision',
      fields: { text: 'DB 선택', options: 'PostgreSQL', criteria: '팀 경험', choice: 'PostgreSQL' },
    })
    expect(bad.type === 'message' && bad.content).toContain('선택지(2개 이상, 한 줄에 하나): 더 필요')
    expect(bad.type === 'message' && bad.content).toContain(`${SITE}/projects/p1`)
    expect(ctx.server.logs.size).toBe(0)

    const ok = await ctx.gateway.modal!({
      interactionId: '700003',
      guildId: GUILD,
      channelId: CHANNEL,
      userId: AUTHOR,
      customId: 'pc:log:decision',
      fields: { text: 'DB 선택', options: 'PostgreSQL\nMongoDB', criteria: '팀 경험', choice: 'PostgreSQL' },
    })
    expect(ok.type === 'message' && ok.content).toContain('⚖️ 결정 로그를 남겼어요')
    expect(ctx.server.calls.at(-1)!.body).toMatchObject({ interactionId: '700003', text: 'DB 선택', fields: { choice: 'PostgreSQL' } })
  })

  it('guides solution to the web and unlinked or unbound users without storing anything', async () => {
    const web = await ctx.gateway.command!(command({ tag: 'solution', text: '프록시 설정' }))
    expect(web.type === 'message' && web.content).toContain('웹에서 남겨 주세요')
    const unlinked = await ctx.gateway.command!(command({ tag: 'progress', text: 'x' }, { userId: UNLINKED, interactionId: '700010' }))
    expect(unlinked.type === 'message' && unlinked.content).toContain('/peerchive link')
    const unbound = await ctx.gateway.command!(command({ tag: 'progress', text: 'x' }, { channelId: '999999', interactionId: '700011' }))
    expect(unbound.type === 'message' && unbound.content).toContain('연결되어 있지 않아요')
    expect(ctx.server.logs.size).toBe(0)
  })

  it('validates input before calling the server', async () => {
    const noTag = await ctx.gateway.command!(command({ tag: 'unknown', text: 'x' }))
    expect(noTag.type === 'message' && noTag.content).toContain('태그를 골라')
    const empty = await ctx.gateway.command!(command({ tag: 'progress', text: '   ' }))
    expect(empty.type === 'message' && empty.content).toContain('내용을 입력')
    const dm = await ctx.gateway.command!(command({ tag: 'progress', text: 'x' }, { guildId: null }))
    expect(dm.type === 'message' && dm.content).toContain('서버 채널에서만')
    expect(ctx.server.calls).toHaveLength(0)
  })

  it('answers with a generic message when the API is down', async () => {
    const down = createHandlers(
      createPeerchiveApi({ baseUrl: SITE, secret: SECRET, fetch: async () => ({ status: 503, json: async () => ({}) }) }),
      { siteUrl: SITE, log: () => {} },
    )
    const reply = await down.handleCommand(command({ tag: 'progress', text: 'x' }))
    expect(reply).toEqual({ type: 'message', content: expect.stringContaining('잠시 뒤 다시') })
  })

  it('links accounts and binds channels via /peerchive', async () => {
    const link = await ctx.gateway.command!(command({ code: 'abcd-efgh-jk' }, { name: 'peerchive', subcommand: 'link' }))
    expect(ctx.server.calls[0]).toMatchObject({ body: { discordUserId: AUTHOR, code: 'abcd-efgh-jk' } })
    expect(link.type === 'message' && link.content).toContain('코드가 맞지 않거나')
    const ok = await ctx.gateway.command!(command({ code: 'ABCDEFGHJK' }, { name: 'peerchive', subcommand: 'link' }))
    expect(ok.type === 'message' && ok.content).toContain('연결했어요')
    const bind = await ctx.gateway.command!(
      command({ code: 'ZZZZZZZZZZ' }, { name: 'peerchive', subcommand: 'bind', channelName: '로그' }),
    )
    expect(ctx.server.calls.at(-1)!.body).toMatchObject({ guildId: GUILD, channelId: CHANNEL, label: '#로그' })
    expect(bind.type === 'message' && bind.content).toContain('「캡스톤」에 연결했어요')
  })
})

describe('📌 reactions', () => {
  let ctx: ReturnType<typeof setup>
  beforeEach(() => {
    ctx = setup()
  })

  it('turns my own pinned message into a log once and tells me by DM', async () => {
    await ctx.gateway.reaction!(reaction())
    await ctx.gateway.reaction!(reaction())
    expect(ctx.server.logs.size).toBe(1)
    expect(ctx.gateway.dms.map((d) => d.userId)).toEqual([AUTHOR, AUTHOR])
    expect(ctx.gateway.dms[0]!.message.content).toContain('🔨 진행 로그로 남겼어요')
    expect(ctx.gateway.dms[1]!.message.content).toContain('이미 로그로')
  })

  it("asks the author before saving someone else's message; approve creates the log", async () => {
    await ctx.gateway.reaction!(reaction({ reactorId: OTHER }))
    expect(ctx.server.logs.size).toBe(0)
    const toAuthor = ctx.gateway.dms.find((d) => d.userId === AUTHOR)!
    expect(toAuthor.message.content).toContain('옮기자고 했어요')
    expect(toAuthor.message.buttons?.map((b) => b.label)).toEqual(['승인', '거절'])
    expect(ctx.gateway.dms.find((d) => d.userId === OTHER)!.message.content).toContain('작성자가 승인해야')

    const approveId = toAuthor.message.buttons![0]!.customId
    // 다른 사람이 버튼을 눌러도 처리되지 않습니다.
    const stranger = await ctx.gateway.button!({ interactionId: '1', userId: OTHER, customId: approveId })
    expect(stranger).toEqual({ type: 'update', content: '찾을 수 없는 요청이에요.' })
    expect(ctx.server.logs.size).toBe(0)

    const approved = await ctx.gateway.button!({ interactionId: '2', userId: AUTHOR, customId: approveId })
    expect(approved.type === 'update' && approved.content).toContain('승인했어요')
    expect(ctx.server.logs.size).toBe(1)
  })

  it('reject stores nothing', async () => {
    await ctx.gateway.reaction!(reaction({ reactorId: OTHER, messageId: '800002' }))
    const rejectId = ctx.gateway.dms.find((d) => d.userId === AUTHOR)!.message.buttons![1]!.customId
    const rejected = await ctx.gateway.button!({ interactionId: '3', userId: AUTHOR, customId: rejectId })
    expect(rejected).toEqual({ type: 'update', content: '거절했어요. 아무것도 저장하지 않았어요.' })
    expect(ctx.server.logs.size).toBe(0)
  })

  it('tells the requester when the author cannot receive DMs', async () => {
    ctx.gateway.blockedDms.add(AUTHOR)
    await ctx.gateway.reaction!(reaction({ reactorId: OTHER, messageId: '800003' }))
    expect(ctx.gateway.dms).toHaveLength(1)
    expect(ctx.gateway.dms[0]).toMatchObject({ userId: OTHER, message: { content: expect.stringContaining('DM을 보낼 수 없어') } })
  })

  it('ignores other emoji, bots, DMs and unbound channels; guides unlinked reactors', async () => {
    await ctx.gateway.reaction!(reaction({ emoji: '👍' }))
    await ctx.gateway.reaction!(reaction({ reactorIsBot: true }))
    await ctx.gateway.reaction!(reaction({ messageAuthorIsBot: true }))
    await ctx.gateway.reaction!(reaction({ guildId: null }))
    expect(ctx.server.calls).toHaveLength(0)
    await ctx.gateway.reaction!(reaction({ channelId: '999999' }))
    expect(ctx.gateway.dms).toHaveLength(0)
    await ctx.gateway.reaction!(reaction({ reactorId: UNLINKED }))
    expect(ctx.gateway.dms).toEqual([{ userId: UNLINKED, message: { content: expect.stringContaining('/peerchive link') } }])
    expect(ctx.server.logs.size).toBe(0)
  })
})

describe('scheduled notices', () => {
  it('posts claimed notices and acks them; unreachable channels are acked as not delivered', async () => {
    const { server, gateway, handlers } = setup()
    server.notices = [
      { id: 'n1', channelId: CHANNEL, kind: 'checkin_reminder', isoWeek: '2026-W43', content: '📝 체크인' },
      { id: 'n2', channelId: '999999', kind: 'checkin_reminder', isoWeek: '2026-W43', content: '📝 체크인' },
    ]
    gateway.unreachableChannels.add('999999')
    expect(await handlers.tick(gateway)).toBe(1)
    expect(gateway.posts).toEqual([{ channelId: CHANNEL, content: '📝 체크인' }])
    const acks = server.calls.filter((c) => c.path.endsWith('/ack')).map((c) => c.body)
    expect(acks).toEqual([
      { id: 'n1', delivered: true, discordMessageId: '900001' },
      { id: 'n2', delivered: false, discordMessageId: null },
    ])
    // 다음 tick에는 보낸 알림이 다시 오지 않습니다.
    expect(await handlers.tick(gateway)).toBe(0)
    expect(gateway.posts).toHaveLength(1)
  })
})

describe('request signing', () => {
  it('signs every request with a fresh nonce that the server accepts once', async () => {
    const { server } = setup()
    const seen: string[] = []
    const api = createPeerchiveApi({
      baseUrl: SITE,
      secret: SECRET,
      fetch: async (url, init) => {
        seen.push(init.headers[HEADER_NONCE]!)
        return server.fetch(url, init)
      },
    })
    await api.claimNotices()
    await api.claimNotices()
    expect(new Set(seen).size).toBe(2)
    const wrong = createPeerchiveApi({ baseUrl: SITE, secret: `${SECRET}-wrong`, fetch: server.fetch })
    await expect(wrong.claimNotices()).rejects.toMatchObject({ name: 'ApiUnavailableError', status: 401 })
  })
})
