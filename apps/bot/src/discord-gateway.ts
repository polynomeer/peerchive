/**
 * discord.js gateway 어댑터(실제 디스코드 연결). 업무 처리는 handlers.ts에 있고 여기서는 이벤트 변환·응답만 합니다.
 *
 * 필요한 intents: Guilds, GuildMessages, GuildMessageReactions, MessageContent(특권 intent — 📌 메시지 본문을 읽기 위해).
 * 봇은 메시지 생성 이벤트를 듣지 않습니다. 본문은 📌이 달린 메시지를 그때 한 번 읽을 뿐 저장하지 않습니다(서버로 전달만).
 * `/summarize`(E-13)는 서버가 팀 전원 동의를 확인한 뒤에만 그 채널의 최근 메시지를 REST로 읽습니다(Read Message History 권한 필요).
 *
 * 주의: 이 파일은 실제 디스코드 애플리케이션 없이 타입 검사만 했습니다(ADR 0009 한계). 동작 확인은 apps/bot/README.md 참고.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  Partials,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js'
import type {
  ButtonEvent,
  ButtonSpec,
  CommandEvent,
  DiscordGateway,
  FetchedMessage,
  InteractionReply,
  ModalSubmitEvent,
  ReactionEvent,
} from './gateway'

/** 3초 안에 응답해야 하므로, 처리가 길어지면 먼저 "생각 중"(ephemeral defer)으로 응답합니다. */
const DEFER_AFTER_MS = 2000
const NO_MENTIONS = { parse: [] as never[] }

type RepliableInteraction = ChatInputCommandInteraction | ModalSubmitInteraction | ButtonInteraction

const BUTTON_STYLES: Record<ButtonSpec['style'], ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger: ButtonStyle.Danger,
}

function buttonRow(buttons: ButtonSpec[]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((b) => new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(BUTTON_STYLES[b.style])),
  )
}

async function respond(interaction: RepliableInteraction, pending: Promise<InteractionReply>): Promise<void> {
  const timeout = Symbol('timeout')
  const first = await Promise.race([pending, new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), DEFER_AFTER_MS))])
  if (first === timeout) {
    if (interaction.isButton()) await interaction.deferUpdate()
    else await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const reply = await pending
    if (reply.type === 'modal') throw new Error('modal reply must be immediate')
    await interaction.editReply({ content: reply.content, components: [], allowedMentions: NO_MENTIONS })
    return
  }
  const reply = first
  if (reply.type === 'modal') {
    if (!interaction.isChatInputCommand()) throw new Error('modal can only answer a slash command')
    const modal = new ModalBuilder().setCustomId(reply.customId).setTitle(reply.title)
    for (const field of reply.fields) {
      const input = new TextInputBuilder()
        .setCustomId(field.customId)
        .setLabel(field.label)
        .setStyle(field.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph)
        .setRequired(field.required)
        .setMaxLength(field.maxLength)
      if (field.value) input.setValue(field.value.slice(0, field.maxLength))
      if (field.placeholder) input.setPlaceholder(field.placeholder)
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
    }
    await interaction.showModal(modal)
    return
  }
  if (reply.type === 'update' && interaction.isButton()) {
    await interaction.update({ content: reply.content, components: [], allowedMentions: NO_MENTIONS })
    return
  }
  await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral, allowedMentions: NO_MENTIONS })
}

export function createDiscordGateway(token: string, log: (line: string) => void = console.error): DiscordGateway {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
    // 봇이 켜지기 전 메시지에 달린 반응도 받도록 partial을 켭니다.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  })

  let onCommand: ((e: CommandEvent) => Promise<InteractionReply>) | undefined
  let onModal: ((e: ModalSubmitEvent) => Promise<InteractionReply>) | undefined
  let onButton: ((e: ButtonEvent) => Promise<InteractionReply>) | undefined
  let onReaction: ((e: ReactionEvent) => Promise<void>) | undefined

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand() && onCommand) {
        const sub = interaction.options.getSubcommand(false)
        const data = sub ? (interaction.options.data[0]?.options ?? []) : interaction.options.data
        const options: Record<string, string | undefined> = {}
        for (const opt of data) {
          if (typeof opt.value === 'string') options[opt.name] = opt.value
          else if (typeof opt.value === 'number') options[opt.name] = String(opt.value)
        }
        const channel = interaction.channel
        await respond(
          interaction,
          onCommand({
            interactionId: interaction.id,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            userId: interaction.user.id,
            name: interaction.commandName,
            subcommand: sub,
            options,
            channelName: channel && 'name' in channel && typeof channel.name === 'string' ? channel.name : null,
          }),
        )
      } else if (interaction.isModalSubmit() && onModal) {
        const fields: Record<string, string> = {}
        for (const [customId, component] of interaction.fields.fields) {
          const value = (component as { value?: unknown }).value
          if (typeof value === 'string') fields[customId] = value
        }
        await respond(
          interaction,
          onModal({
            interactionId: interaction.id,
            guildId: interaction.guildId,
            channelId: interaction.channelId ?? '',
            userId: interaction.user.id,
            customId: interaction.customId,
            fields,
          }),
        )
      } else if (interaction.isButton() && onButton) {
        await respond(interaction, onButton({ interactionId: interaction.id, userId: interaction.user.id, customId: interaction.customId }))
      }
    } catch (error) {
      log(`[bot] interaction failed: ${(error as Error).message}`)
    }
  })

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (!onReaction) return
    try {
      const full = reaction.partial ? await reaction.fetch() : reaction
      if (full.emoji.name !== '📌') return
      const message = full.message.partial ? await full.message.fetch() : full.message
      await onReaction({
        emoji: full.emoji.name,
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        messageAuthorId: message.author.id,
        messageAuthorIsBot: message.author.bot,
        reactorId: user.id,
        reactorIsBot: !!user.bot,
        content: message.content,
        attachmentCount: message.attachments.size,
        messageUrl: message.url,
      })
    } catch (error) {
      log(`[bot] reaction failed: ${(error as Error).message}`)
    }
  })

  return {
    onCommand: (handler) => void (onCommand = handler),
    onModalSubmit: (handler) => void (onModal = handler),
    onButton: (handler) => void (onButton = handler),
    onReactionAdd: (handler) => void (onReaction = handler),
    async sendDirectMessage(userId, message) {
      try {
        const user = await client.users.fetch(userId)
        await user.send({
          content: message.content,
          components: message.buttons?.length ? [buttonRow(message.buttons)] : [],
          allowedMentions: NO_MENTIONS,
        })
        return true
      } catch {
        return false
      }
    },
    async postChannelMessage(channelId, content) {
      try {
        const channel = await client.channels.fetch(channelId)
        if (!channel?.isSendable()) return null
        const sent = await channel.send({ content, allowedMentions: NO_MENTIONS })
        return sent.id
      } catch {
        return null
      }
    },
    async fetchRecentMessages(channelId, { since, limit }) {
      try {
        const channel = await client.channels.fetch(channelId)
        if (!channel || !channel.isTextBased() || channel.isDMBased()) return null
        const out: FetchedMessage[] = []
        let before: string | undefined
        // REST는 한 번에 100개, 최신순입니다. since보다 오래된 메시지를 만나면 멈춥니다.
        while (out.length < limit) {
          const page = await channel.messages.fetch({ limit: Math.min(100, limit - out.length), ...(before && { before }), cache: false })
          let reachedOld = false
          for (const m of page.values()) {
            if (m.createdTimestamp < since.getTime()) {
              reachedOld = true
              break
            }
            out.push({
              id: m.id,
              authorId: m.author.id,
              authorIsBot: m.author.bot,
              isSystem: m.system,
              content: m.content,
              attachmentCount: m.attachments.size,
              createdAt: m.createdAt,
            })
            if (out.length >= limit) break
          }
          before = page.last()?.id
          if (reachedOld || page.size < 100 || !before) break
        }
        return out.reverse()
      } catch {
        return null
      }
    },
    async start() {
      await client.login(token)
    },
    async stop() {
      await client.destroy()
    },
  }
}
