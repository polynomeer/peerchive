/**
 * 디스코드 연결 어댑터 경계(ADR 0009). 업무 처리(handlers.ts)는 이 인터페이스만 알고 discord.js를 모릅니다.
 * 실제 구현은 discord-gateway.ts(discord.js), 테스트는 가짜 구현을 씁니다.
 */

export interface CommandEvent {
  interactionId: string
  /** 서버 밖(DM)이면 null. */
  guildId: string | null
  channelId: string
  userId: string
  /** 'peerchive' 또는 'log'. */
  name: string
  /** `/peerchive link`의 'link'. */
  subcommand: string | null
  options: Record<string, string | undefined>
  /** 채널 이름(선택, bind 때 label로만 씀). */
  channelName?: string | null
}

export interface ModalSubmitEvent {
  interactionId: string
  guildId: string | null
  channelId: string
  userId: string
  customId: string
  fields: Record<string, string>
}

export interface ButtonEvent {
  interactionId: string
  userId: string
  customId: string
}

export interface ReactionEvent {
  emoji: string
  guildId: string | null
  channelId: string
  messageId: string
  messageAuthorId: string
  messageAuthorIsBot: boolean
  reactorId: string
  reactorIsBot: boolean
  content: string
  attachmentCount: number
  messageUrl: string | null
}

export interface ModalField {
  customId: string
  label: string
  style: 'short' | 'paragraph'
  required: boolean
  maxLength: number
  value?: string
  placeholder?: string
}

export interface ButtonSpec {
  customId: string
  label: string
  style: 'primary' | 'secondary' | 'danger'
}

/** 슬래시 명령·모달·버튼에 대한 응답. 메시지는 항상 본인에게만 보이는(ephemeral) 응답입니다. */
export type InteractionReply =
  | { type: 'message'; content: string }
  | { type: 'modal'; customId: string; title: string; fields: ModalField[] }
  /** 버튼이 달린 메시지(승인 요청 DM)를 이 내용으로 바꾸고 버튼을 없앱니다. */
  | { type: 'update'; content: string }

export interface DirectMessage {
  content: string
  buttons?: ButtonSpec[]
}

export interface DiscordGateway {
  onCommand(handler: (event: CommandEvent) => Promise<InteractionReply>): void
  onModalSubmit(handler: (event: ModalSubmitEvent) => Promise<InteractionReply>): void
  onButton(handler: (event: ButtonEvent) => Promise<InteractionReply>): void
  onReactionAdd(handler: (event: ReactionEvent) => Promise<void>): void
  /** DM을 보냅니다. 받는 사람이 DM을 막았으면 false. */
  sendDirectMessage(userId: string, message: DirectMessage): Promise<boolean>
  /** 채널에 글을 올리고 메시지 id를 돌려줍니다. 채널에 접근할 수 없으면 null. */
  postChannelMessage(channelId: string, content: string): Promise<string | null>
  start(): Promise<void>
  stop(): Promise<void>
}
