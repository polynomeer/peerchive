/**
 * 테스트용 가짜 디스코드 어댑터와 가짜 Peerchive 서버(내부 API의 핵심 규칙만 흉내).
 * 실제 규칙 검증은 apps/web의 통합 테스트가 맡고, 여기서는 봇 흐름(명령 해석·응답·DM·재시도)을 봅니다.
 */
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  type LogRequest,
  type MeetingCheckResponse,
  type MeetingSummaryRequest,
  type PinRequest,
  verifySignature,
} from '@peerchive/bot-protocol'
import type { FetchLike } from '../src/api-client'
import type {
  ButtonEvent,
  CommandEvent,
  DirectMessage,
  DiscordGateway,
  FetchedMessage,
  InteractionReply,
  ModalSubmitEvent,
  ReactionEvent,
} from '../src/gateway'

export class FakeGateway implements DiscordGateway {
  command?: (e: CommandEvent) => Promise<InteractionReply>
  modal?: (e: ModalSubmitEvent) => Promise<InteractionReply>
  button?: (e: ButtonEvent) => Promise<InteractionReply>
  reaction?: (e: ReactionEvent) => Promise<void>
  dms: Array<{ userId: string; message: DirectMessage }> = []
  posts: Array<{ channelId: string; content: string }> = []
  blockedDms = new Set<string>()
  unreachableChannels = new Set<string>()
  /** 채널별 메시지(회의 요약). 읽은 요청을 `fetches`에 남깁니다. */
  channelMessages = new Map<string, FetchedMessage[]>()
  fetches: Array<{ channelId: string; since: Date; limit: number }> = []

  onCommand(handler: (e: CommandEvent) => Promise<InteractionReply>) {
    this.command = handler
  }
  onModalSubmit(handler: (e: ModalSubmitEvent) => Promise<InteractionReply>) {
    this.modal = handler
  }
  onButton(handler: (e: ButtonEvent) => Promise<InteractionReply>) {
    this.button = handler
  }
  onReactionAdd(handler: (e: ReactionEvent) => Promise<void>) {
    this.reaction = handler
  }
  async sendDirectMessage(userId: string, message: DirectMessage) {
    if (this.blockedDms.has(userId)) return false
    this.dms.push({ userId, message })
    return true
  }
  async postChannelMessage(channelId: string, content: string) {
    if (this.unreachableChannels.has(channelId)) return null
    this.posts.push({ channelId, content })
    return String(900000 + this.posts.length)
  }
  async fetchRecentMessages(channelId: string, options: { since: Date; limit: number }) {
    this.fetches.push({ channelId, ...options })
    if (this.unreachableChannels.has(channelId)) return null
    const all = (this.channelMessages.get(channelId) ?? []).filter((m) => m.createdAt.getTime() >= options.since.getTime())
    return all.slice(-options.limit)
  }
  async start() {}
  async stop() {}
}

export const SECRET = 'test-secret-9f8e7d6c5b4a39281706f5e4d3c2b1a0'
export const SITE = 'http://localhost:3100'

/** 서명을 검증하고 nonce 재사용을 거부하는 가짜 서버. 로그는 interaction/message id마다 하나. */
export class FakeServer {
  nonces = new Set<string>()
  logs = new Map<string, { tag: string; text: string; author: string }>()
  calls: Array<{ path: string; body: unknown }> = []
  /** 다음 n번의 응답을 (처리한 뒤) 500으로 잃어버립니다. */
  dropResponses = 0
  linked = new Set<string>(['111111'])
  bound = new Set<string>(['555555'])
  pending = new Map<string, { author: string; messageId: string }>()
  /** 회의 요약 확인 결과(기본 ready)·요약 결과(기본 drafted). */
  meetingCheckStatus: MeetingCheckResponse['status'] = 'ready'
  summaries: MeetingSummaryRequest[] = []
  notices: Array<{ id: string; channelId: string; kind: 'checkin_reminder'; isoWeek: string; content: string; delivered?: boolean }> = []

  fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname
    const check = verifySignature(
      SECRET,
      {
        timestamp: init.headers[HEADER_TIMESTAMP],
        nonce: init.headers[HEADER_NONCE],
        signature: init.headers[HEADER_SIGNATURE],
      },
      { method: init.method, path, body: init.body },
    )
    if (!check.ok || this.nonces.has(check.nonce)) return { status: 401, json: async () => ({}) }
    this.nonces.add(check.nonce)
    const body = JSON.parse(init.body) as Record<string, unknown>
    this.calls.push({ path, body })
    const result = this.handle(path, body)
    if (this.dropResponses > 0) {
      this.dropResponses--
      return { status: 502, json: async () => ({}) }
    }
    return { status: 200, json: async () => result }
  }

  private handle(path: string, body: Record<string, unknown>): unknown {
    if (path.endsWith('/logs')) {
      const req = body as unknown as LogRequest
      if (!this.bound.has(req.channelId)) return { status: 'not_bound' }
      if (!this.linked.has(req.discordUserId)) return { status: 'not_linked' }
      if (req.tag === 'solution') return { status: 'web_only', projectUrl: `${SITE}/projects/p1` }
      if (req.tag === 'decision' && (req.fields?.options ?? '').split('\n').filter(Boolean).length < 2) {
        return { status: 'invalid', fields: { 'payload.options': 'too_few' }, projectUrl: `${SITE}/projects/p1` }
      }
      const key = `i:${req.interactionId}`
      const created = !this.logs.has(key)
      if (created) this.logs.set(key, { tag: req.tag, text: req.text, author: req.discordUserId })
      return { status: created ? 'created' : 'duplicate', logUrl: `${SITE}/projects/p1#log-${req.interactionId}` }
    }
    if (path.endsWith('/pins')) {
      const req = body as unknown as PinRequest
      if (!this.bound.has(req.channelId)) return { status: 'not_bound' }
      if (!this.linked.has(req.reactorId)) return { status: 'not_linked' }
      if (req.reactorId === req.messageAuthorId) {
        const key = `m:${req.messageId}`
        const created = !this.logs.has(key)
        if (created) this.logs.set(key, { tag: 'progress', text: req.content, author: req.messageAuthorId })
        return { status: created ? 'created' : 'duplicate', logUrl: `${SITE}/projects/p1#log-m${req.messageId}` }
      }
      if (!this.linked.has(req.messageAuthorId)) return { status: 'author_unavailable' }
      const requestId = `00000000-0000-4000-8000-${req.messageId.padStart(12, '0')}`
      this.pending.set(requestId, { author: req.messageAuthorId, messageId: req.messageId })
      return {
        status: 'approval_requested',
        approval: { requestId, authorDiscordId: req.messageAuthorId, expiresAt: '2026-10-22T03:00:00.000Z', preview: req.content, projectTitle: '캡스톤' },
      }
    }
    if (path.endsWith('/pin-decisions')) {
      const pending = this.pending.get(String(body.requestId))
      if (!pending || pending.author !== body.discordUserId) return { status: 'not_found' }
      this.pending.delete(String(body.requestId))
      if (body.decision === 'reject') return { status: 'rejected' }
      this.logs.set(`m:${pending.messageId}`, { tag: 'progress', text: '', author: pending.author })
      return { status: 'approved', logUrl: `${SITE}/projects/p1#log-x` }
    }
    if (path.endsWith('/meeting-summaries/check')) {
      return {
        status: this.meetingCheckStatus,
        ...(this.meetingCheckStatus === 'no_consent' && { missingConsents: 2 }),
        ...(this.meetingCheckStatus === 'ready' && { memberDiscordIds: [...this.linked].sort() }),
        projectUrl: `${SITE}/projects/p1#ai-meeting`,
      }
    }
    if (path.endsWith('/meeting-summaries')) {
      const req = body as unknown as MeetingSummaryRequest
      if (this.meetingCheckStatus !== 'ready') return { status: this.meetingCheckStatus }
      const duplicate = this.summaries.some((s) => s.interactionId === req.interactionId)
      if (!duplicate) this.summaries.push(req)
      return { status: duplicate ? 'duplicate' : 'drafted', draftUrl: `${SITE}/projects/p1#ai-meeting` }
    }
    if (path.endsWith('/link')) return { status: body.code === 'ABCDEFGHJK' ? 'linked' : 'invalid_code' }
    if (path.endsWith('/bind')) return { status: 'bound', projectTitle: '캡스톤', projectUrl: `${SITE}/projects/p1` }
    if (path.endsWith('/notices/claim')) return { notices: this.notices.filter((n) => !n.delivered) }
    if (path.endsWith('/notices/ack')) {
      const notice = this.notices.find((n) => n.id === body.id)
      if (notice && body.delivered) notice.delivered = true
      return { status: notice ? 'ok' : 'not_found' }
    }
    return {}
  }
}
