/**
 * 메일 발송 추상화. 지금 구현은 개발용 콘솔 transport와 테스트용 메모리 transport뿐입니다.
 * 실제 발송(SMTP·API) transport는 배포 전에 추가합니다. 그 전까지 production에서는 서버가 시작되지 않습니다.
 */

export interface MailMessage {
  to: string
  subject: string
  text: string
}

export interface MailTransport {
  readonly name: string
  send(message: MailMessage): Promise<void>
}

/** 로그에 주소를 그대로 남기지 않도록 가립니다(a***@example.com). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

/**
 * 개발 전용: 메일 본문(로그인 링크 포함)을 서버 콘솔에 출력합니다.
 * 토큰이 로그에 남는 유일한 경로이며 production에서는 resolveMailTransport가 거부합니다.
 */
export function createDevConsoleTransport(log: (line: string) => void = (line) => console.info(line)): MailTransport {
  return {
    name: 'dev-console',
    async send(message) {
      log(
        [
          '──── [dev-console mail] 개발용 메일 출력(production 금지) ────',
          `to: ${maskEmail(message.to)}`,
          `subject: ${message.subject}`,
          message.text,
          '──────────────────────────────────────────────',
        ].join('\n'),
      )
    },
  }
}

/** 테스트용. 보낸 메시지를 메모리에 쌓습니다. */
export function createMemoryTransport(): MailTransport & { messages: MailMessage[] } {
  const messages: MailMessage[] = []
  return {
    name: 'memory',
    messages,
    async send(message) {
      messages.push(message)
    },
  }
}

/**
 * 설정값으로 transport를 고릅니다. production에서 개발용 transport를 고르면 예외를 던져
 * 서버 시작을 막습니다(server/plugins/mail.ts).
 */
export function resolveMailTransport(options: { transport: string; production: boolean }): MailTransport {
  const name = options.transport || 'dev-console'
  if (name === 'dev-console') {
    if (options.production) {
      throw new Error(
        'Mail transport "dev-console" is not allowed in production. Configure a real mail transport (NUXT_MAIL_TRANSPORT).',
      )
    }
    return createDevConsoleTransport()
  }
  throw new Error(`Unknown mail transport: ${name}`)
}
