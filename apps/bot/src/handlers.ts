/**
 * 봇 업무 흐름(ADR 0009). 디스코드 이벤트 → 내부 API 호출 → 안내 문장. 규칙(권한·검증·중복 방지)은 웹 서버가 정합니다.
 *
 * - 슬래시 명령·모달·버튼 응답은 모두 본인에게만 보입니다(ephemeral). 실패는 일반 안내만 합니다.
 * - `/log 결정|검증`은 필수 필드를 모달로 받습니다. 모달 제출의 interaction id로 중복을 막습니다.
 * - 📌: 봇 메시지·봇 반응·DM 채널은 무시합니다. 연결되지 않은 채널(not_bound)이면 아무 말도 하지 않습니다.
 *   남의 메시지면 작성자에게 승인/거절 버튼이 달린 DM을 보냅니다.
 * - 예약 알림: tick()이 서버에서 보낼 알림을 받아 채널에 올리고 결과를 ack합니다.
 */
import type { DiscordLogTag } from '@peerchive/bot-protocol'
import { ApiUnavailableError, type PeerchiveApi } from './api-client'
import {
  PIN_EMOJI,
  modalCustomId,
  parseCommand,
  parseModalCustomId,
  parsePinButtonId,
  pinButtonId,
} from './commands'
import type {
  ButtonEvent,
  CommandEvent,
  DiscordGateway,
  InteractionReply,
  ModalField,
  ModalSubmitEvent,
  ReactionEvent,
} from './gateway'
import {
  GENERIC_ERROR,
  HELP,
  approvalRequestMessage,
  bindMessage,
  decisionMessage,
  linkMessage,
  logMessage,
  pinReactorMessage,
} from './messages'

export interface HandlerOptions {
  siteUrl: string
  log?: (message: string) => void
}

const message = (content: string): InteractionReply => ({ type: 'message', content })

const INVALID_COMMAND: Record<string, string> = {
  unknown_command: '알 수 없는 명령이에요. `/peerchive help`를 확인해 주세요.',
  missing_code: '코드를 입력해 주세요.',
  unknown_tag: '태그를 골라 주세요: 진행·막힘·해결·결정·회의·검증·회고',
  empty_text: '내용을 입력해 주세요.',
  text_too_long: '내용은 2000자까지 쓸 수 있어요.',
}

/** ⚖️결정·✅검증 모달 필드. 처음 입력한 내용은 본문 칸에 미리 채웁니다. */
export function modalFields(tag: 'decision' | 'validation', text: string): ModalField[] {
  const body: ModalField = { customId: 'text', label: '내용', style: 'paragraph', required: false, maxLength: 2000, value: text }
  if (tag === 'decision') {
    return [
      body,
      { customId: 'options', label: '선택지 (한 줄에 하나, 2개 이상)', style: 'paragraph', required: true, maxLength: 1200 },
      { customId: 'criteria', label: '기준', style: 'paragraph', required: true, maxLength: 1000 },
      { customId: 'choice', label: '선택', style: 'short', required: true, maxLength: 200 },
    ]
  }
  return [
    body,
    { customId: 'target', label: '검증 대상', style: 'paragraph', required: true, maxLength: 1000 },
    { customId: 'conditions', label: '조건', style: 'paragraph', required: true, maxLength: 1000 },
    { customId: 'result', label: '결과', style: 'paragraph', required: true, maxLength: 1000 },
  ]
}

export function createHandlers(api: PeerchiveApi, options: HandlerOptions) {
  const log = options.log ?? ((line: string) => console.warn(line))

  /** API 장애는 일반 안내로 바꿉니다(그 밖의 예외는 그대로). */
  async function guarded<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof ApiUnavailableError) {
        log(`[bot] ${error.message}`)
        return fallback
      }
      throw error
    }
  }

  async function submitLog(
    event: { interactionId: string; guildId: string; channelId: string; userId: string },
    tag: DiscordLogTag,
    text: string,
    extra: { timeBucket?: string | null; fields?: Record<string, string> | null },
  ): Promise<InteractionReply> {
    const res = await api.log({
      interactionId: event.interactionId,
      guildId: event.guildId,
      channelId: event.channelId,
      discordUserId: event.userId,
      tag,
      text,
      timeBucket: (extra.timeBucket as never) ?? null,
      fields: extra.fields ?? null,
    })
    return message(logMessage(res, tag, options.siteUrl))
  }

  async function handleCommand(event: CommandEvent): Promise<InteractionReply> {
    const parsed = parseCommand(event.name, event.subcommand, event.options)
    if (parsed.kind === 'invalid') return message(INVALID_COMMAND[parsed.reason] ?? GENERIC_ERROR)
    if (parsed.kind === 'help') return message(HELP)
    if (parsed.kind === 'link') {
      return guarded(async () => message(linkMessage(await api.link({ discordUserId: event.userId, code: parsed.code }))), message(GENERIC_ERROR))
    }
    if (!event.guildId) return message('서버 채널에서만 쓸 수 있는 명령이에요.')
    const guildId = event.guildId
    if (parsed.kind === 'bind') {
      return guarded(
        async () =>
          message(
            bindMessage(
              await api.bind({
                discordUserId: event.userId,
                guildId,
                channelId: event.channelId,
                code: parsed.code,
                label: event.channelName ? `#${event.channelName}`.slice(0, 100) : null,
              }),
              options.siteUrl,
            ),
          ),
        message(GENERIC_ERROR),
      )
    }
    if (parsed.tag === 'decision' || parsed.tag === 'validation') {
      return {
        type: 'modal',
        customId: modalCustomId(parsed.tag),
        title: parsed.tag === 'decision' ? '⚖️ 결정 로그' : '✅ 검증 로그',
        fields: modalFields(parsed.tag, parsed.text),
      }
    }
    return guarded(
      () => submitLog({ ...event, guildId }, parsed.tag, parsed.text, { timeBucket: parsed.timeBucket }),
      message(GENERIC_ERROR),
    )
  }

  async function handleModalSubmit(event: ModalSubmitEvent): Promise<InteractionReply> {
    const tag = parseModalCustomId(event.customId)
    if (!tag || !event.guildId) return message(GENERIC_ERROR)
    const { text = '', ...fields } = event.fields
    return guarded(
      () => submitLog({ ...event, guildId: event.guildId! }, tag, text, { fields }),
      message(GENERIC_ERROR),
    )
  }

  async function handleButton(event: ButtonEvent): Promise<InteractionReply> {
    const parsed = parsePinButtonId(event.customId)
    if (!parsed) return message(GENERIC_ERROR)
    return guarded(
      async () =>
        ({
          type: 'update',
          content: decisionMessage(
            await api.decidePin({ requestId: parsed.requestId, discordUserId: event.userId, decision: parsed.decision }),
          ),
        }) as InteractionReply,
      message(GENERIC_ERROR),
    )
  }

  async function handleReaction(event: ReactionEvent, gateway: Pick<DiscordGateway, 'sendDirectMessage'>): Promise<void> {
    if (event.emoji !== PIN_EMOJI || !event.guildId || event.reactorIsBot || event.messageAuthorIsBot) return
    const res = await guarded(
      () =>
        api.pin({
          guildId: event.guildId!,
          channelId: event.channelId,
          messageId: event.messageId,
          messageAuthorId: event.messageAuthorId,
          reactorId: event.reactorId,
          content: event.content,
          attachmentCount: event.attachmentCount,
          messageUrl: event.messageUrl,
        }),
      null,
    )
    if (!res) return
    if (res.status === 'approval_requested' && res.approval) {
      const sent = await gateway.sendDirectMessage(res.approval.authorDiscordId, {
        content: approvalRequestMessage(res.approval),
        buttons: [
          { customId: pinButtonId('approve', res.approval.requestId), label: '승인', style: 'primary' },
          { customId: pinButtonId('reject', res.approval.requestId), label: '거절', style: 'secondary' },
        ],
      })
      if (!sent) {
        await gateway.sendDirectMessage(event.reactorId, {
          content: '📌 작성자에게 DM을 보낼 수 없어 승인 요청을 전하지 못했어요(작성자의 DM 설정). 48시간 뒤 요청은 사라져요.',
        })
        return
      }
    }
    const text = pinReactorMessage(res, options.siteUrl)
    if (text) await gateway.sendDirectMessage(event.reactorId, { content: text })
  }

  /** 예약 알림 한 번 처리. 올린 개수. */
  async function tick(gateway: Pick<DiscordGateway, 'postChannelMessage'>): Promise<number> {
    const claimed = await guarded(() => api.claimNotices(), { notices: [] })
    let posted = 0
    for (const notice of claimed.notices) {
      const messageId = await gateway.postChannelMessage(notice.channelId, notice.content)
      if (messageId) posted++
      await guarded(
        () => api.ackNotice({ id: notice.id, delivered: !!messageId, discordMessageId: messageId }),
        { status: 'not_found' as const },
      )
    }
    return posted
  }

  return { handleCommand, handleModalSubmit, handleButton, handleReaction, tick }
}

export type BotHandlers = ReturnType<typeof createHandlers>

/** 어댑터에 handler를 연결합니다. */
export function wireGateway(gateway: DiscordGateway, handlers: BotHandlers): void {
  gateway.onCommand((event) => handlers.handleCommand(event))
  gateway.onModalSubmit((event) => handlers.handleModalSubmit(event))
  gateway.onButton((event) => handlers.handleButton(event))
  gateway.onReactionAdd((event) => handlers.handleReaction(event, gateway))
}
