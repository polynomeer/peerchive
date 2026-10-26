/**
 * 메일 발송 추상화(ADR 0006·0017).
 *
 * - `smtp`: 실제 발송. 공급자를 정하지 않고 표준 SMTP(nodemailer)만 씁니다. production에서 쓸 수 있는 유일한 transport입니다.
 * - `dev-console`: 개발 전용(링크를 서버 콘솔에 출력). production에서는 서버가 시작되지 않습니다.
 * - `memory`: 테스트 전용.
 *
 * 로그에는 수신 주소를 가려서만 남기고(a***@example.com) 본문·토큰·SMTP 접속 정보·서버 응답 원문은 남기지 않습니다.
 *
 * | 변수 | 내용 |
 * |---|---|
 * | PEERCHIVE_MAIL_TRANSPORT | `smtp` 또는 `dev-console`(없으면 NUXT_MAIL_TRANSPORT, 그것도 없으면 dev-console) |
 * | PEERCHIVE_SMTP_URL | `smtps://user:pass@host:465`(암묵적 TLS) 또는 `smtp://user:pass@host:587`(STARTTLS 필수). 사용자·암호는 URL 인코딩 |
 * | PEERCHIVE_SMTP_HOST / _PORT / _SECURE / _USER / _PASSWORD | URL 대신 나눠 쓸 때(SECURE=1이면 암묵적 TLS, 기본 포트 465, 아니면 587) |
 * | PEERCHIVE_SMTP_ALLOW_INSECURE | `1`이면 TLS 없는 SMTP 허용(로컬 Mailpit 전용). production에서는 시작하지 않음 |
 * | PEERCHIVE_MAIL_FROM | 보내는 주소(`no-reply@example.com` 또는 `Peerchive <no-reply@example.com>`) |
 * | PEERCHIVE_MAIL_REPLY_TO | 선택. 답장 받을 주소 |
 */
import { randomUUID } from 'node:crypto'
import { createTransport } from 'nodemailer'

export interface MailMessage {
  to: string
  subject: string
  text: string
  /** 선택. 같은 내용의 단순 HTML(없으면 text만 보냄). */
  html?: string
}

export interface MailTransport {
  readonly name: string
  send(message: MailMessage): Promise<void>
}

type Env = Readonly<Record<string, string | undefined>>

/** 로그에 주소를 그대로 남기지 않도록 가립니다(a***@example.com). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${email[0]}***${email.slice(at)}`
}

/**
 * 발송 실패. 메시지에는 nodemailer 오류 코드·SMTP 응답 코드·단계만 넣습니다. 서버 응답 원문에는 수신 주소가 들어 있을 수
 * 있으므로(예: `550 <x@y>: Recipient rejected`) 담지 않고, 원래 오류도 cause로 붙이지 않습니다.
 */
export class MailSendError extends Error {
  constructor(
    readonly code: string | null,
    readonly responseCode: number | null,
    readonly command: string | null,
  ) {
    super(`mail send failed (code=${code ?? 'unknown'}, responseCode=${responseCode ?? '-'}, command=${command ?? '-'})`)
    this.name = 'MailSendError'
  }
}

/** 로그·감사용 오류 요약(주소·본문 없음). */
export function describeMailError(error: unknown): { code: string; responseCode: number | null } {
  if (error instanceof MailSendError) return { code: error.code ?? 'unknown', responseCode: error.responseCode }
  return { code: (error as { name?: string } | null)?.name ?? 'unknown', responseCode: null }
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

// ── SMTP ────────────────────────────────────────────────────────────────

export interface SmtpConfig {
  host: string
  port: number
  /** true: 처음부터 TLS(보통 465). false: 평문으로 연결한 뒤 STARTTLS(보통 587). */
  secure: boolean
  /** false면 STARTTLS 없이도 보냄(로컬 시험 서버 전용, production 거부). */
  requireTls: boolean
  auth: { user: string; pass: string } | null
  from: { name: string | null; address: string }
  replyTo: string | null
}

/** 단순한 주소 검사(공백·꺾쇠·제어 문자 없음, @ 하나, 점 있는 도메인). 실제 수신 가능 여부는 서버가 판단합니다. */
const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$|^\d{1,3}(?:\.\d{1,3}){3}$/i

function parseFrom(value: string): SmtpConfig['from'] {
  const named = /^([^<>\r\n"]+?)\s*<([^<>\s]+)>$/.exec(value)
  const name = named ? named[1]!.trim() : null
  const address = named ? named[2]! : value
  if (!ADDRESS.test(address)) throw new Error('PEERCHIVE_MAIL_FROM is not a valid address')
  return { name: name || null, address }
}

function parsePort(value: string, name: string): number {
  const port = Number(value)
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${name} is invalid`)
  return port
}

/**
 * SMTP 설정을 읽고 검사합니다(접속은 하지 않음). 오류 메시지에는 변수 이름만 넣고 값(특히 암호)은 넣지 않습니다.
 * production에서는 TLS(암묵적 TLS 또는 STARTTLS 필수)만 허용합니다.
 */
export function parseSmtpConfig(env: Env, options: { production: boolean }): SmtpConfig {
  const value = (name: string) => env[name]?.trim() || ''
  const url = value('PEERCHIVE_SMTP_URL')
  const host = value('PEERCHIVE_SMTP_HOST')
  if (url && host) throw new Error('Set either PEERCHIVE_SMTP_URL or PEERCHIVE_SMTP_HOST, not both')
  if (!url && !host) throw new Error('SMTP mail transport is not configured: set PEERCHIVE_SMTP_URL (or PEERCHIVE_SMTP_HOST)')

  let parsed: Pick<SmtpConfig, 'host' | 'port' | 'secure' | 'auth'>
  if (url) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new Error('PEERCHIVE_SMTP_URL is not a valid URL')
    }
    if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('PEERCHIVE_SMTP_URL must start with smtp:// or smtps://')
    if ((u.pathname && u.pathname !== '/') || u.search || u.hash) {
      throw new Error('PEERCHIVE_SMTP_URL must not have a path or query (use the PEERCHIVE_SMTP_* variables for options)')
    }
    const secure = u.protocol === 'smtps:'
    let user: string, pass: string
    try {
      user = decodeURIComponent(u.username)
      pass = decodeURIComponent(u.password)
    } catch {
      throw new Error('PEERCHIVE_SMTP_URL has an invalid user or password encoding')
    }
    if (!!user !== !!pass) throw new Error('PEERCHIVE_SMTP_URL must have both user and password, or neither')
    const hostname = u.hostname.replace(/^\[|\]$/g, '')
    if (!hostname) throw new Error('PEERCHIVE_SMTP_URL has no host')
    parsed = {
      host: hostname,
      port: u.port ? parsePort(u.port, 'PEERCHIVE_SMTP_URL port') : secure ? 465 : 587,
      secure,
      auth: user ? { user, pass } : null,
    }
  } else {
    if (!HOST.test(host)) throw new Error('PEERCHIVE_SMTP_HOST is invalid')
    const secureFlag = value('PEERCHIVE_SMTP_SECURE')
    if (secureFlag && secureFlag !== '1' && secureFlag !== '0') throw new Error('PEERCHIVE_SMTP_SECURE must be 1 or 0')
    const secure = secureFlag === '1'
    const user = value('PEERCHIVE_SMTP_USER')
    // 암호는 앞뒤 공백도 값일 수 있으므로 trim하지 않습니다.
    const pass = env.PEERCHIVE_SMTP_PASSWORD ?? ''
    if (!!user !== !!pass) throw new Error('Set both PEERCHIVE_SMTP_USER and PEERCHIVE_SMTP_PASSWORD, or neither')
    parsed = {
      host,
      port: value('PEERCHIVE_SMTP_PORT') ? parsePort(value('PEERCHIVE_SMTP_PORT'), 'PEERCHIVE_SMTP_PORT') : secure ? 465 : 587,
      secure,
      auth: user ? { user, pass } : null,
    }
  }

  const insecureFlag = value('PEERCHIVE_SMTP_ALLOW_INSECURE')
  if (insecureFlag && insecureFlag !== '1' && insecureFlag !== '0') throw new Error('PEERCHIVE_SMTP_ALLOW_INSECURE must be 1 or 0')
  const allowInsecure = insecureFlag === '1'
  if (allowInsecure && options.production) {
    throw new Error('PEERCHIVE_SMTP_ALLOW_INSECURE is not allowed in production (SMTP must use TLS)')
  }

  const fromValue = value('PEERCHIVE_MAIL_FROM')
  if (!fromValue) throw new Error('SMTP mail transport is not configured: set PEERCHIVE_MAIL_FROM')
  const replyTo = value('PEERCHIVE_MAIL_REPLY_TO') || null
  if (replyTo && !ADDRESS.test(replyTo)) throw new Error('PEERCHIVE_MAIL_REPLY_TO is not a valid address')

  return { ...parsed, requireTls: !allowInsecure, from: parseFrom(fromValue), replyTo }
}

export interface SmtpTransportOptions {
  log?: (line: string) => void
  now?: () => Date
}

/**
 * SMTP transport. 연결 풀 없이 메일마다 연결하고 닫습니다(매직링크는 드물고, 오래 열린 연결의 끊김을 다룰 필요가 없음).
 * 연결 10초·인사 10초·유휴 20초 시간 제한. 인증서 검증은 끌 수 없고 TLS 1.2 이상만 씁니다.
 */
export function createSmtpTransport(config: SmtpConfig, options: SmtpTransportOptions = {}): MailTransport {
  const log = options.log ?? ((line: string) => console.info(line))
  const now = options.now ?? (() => new Date())
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && config.requireTls,
    ...(config.auth && { auth: { user: config.auth.user, pass: config.auth.pass } }),
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    pool: false,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // nodemailer 자체 로그는 끕니다(SMTP 대화에 주소·본문이 들어 있음).
    logger: false,
    debug: false,
    // 첨부·내장 리소스를 파일·URL에서 읽지 않습니다(쓰지 않는 기능).
    disableFileAccess: true,
    disableUrlAccess: true,
  })
  const domain = config.from.address.slice(config.from.address.lastIndexOf('@') + 1)

  return {
    name: 'smtp',
    async send(message) {
      try {
        await transporter.sendMail({
          from: config.from.name ? { name: config.from.name, address: config.from.address } : config.from.address,
          to: message.to,
          ...(config.replyTo && { replyTo: config.replyTo }),
          subject: message.subject,
          text: message.text,
          ...(message.html && { html: message.html }),
          messageId: `<${randomUUID()}@${domain}>`,
          date: now(),
          headers: {
            // 자동 발송 메일임을 알려 자동 응답(부재 중 등)이 돌아오지 않게 합니다(RFC 3834).
            'Auto-Submitted': 'auto-generated',
            'X-Auto-Response-Suppress': 'All',
          },
        })
      } catch (error) {
        const e = error as { code?: unknown; responseCode?: unknown; command?: unknown } | null
        throw new MailSendError(
          typeof e?.code === 'string' ? e.code : null,
          typeof e?.responseCode === 'number' ? e.responseCode : null,
          // 명령 이름만(예: 'RCPT TO'의 주소 부분은 빼고 앞 단어만).
          typeof e?.command === 'string' ? (e.command.split(/\s|:/)[0] ?? null) : null,
        )
      }
      log(`[mail:smtp] sent to=${maskEmail(message.to)}`)
    },
  }
}

/**
 * 설정값으로 transport를 고릅니다. production에서는 올바른 smtp만 허용하고, 그 밖에는 예외를 던져
 * 서버 시작을 막습니다(server/plugins/mail.ts).
 */
export function resolveMailTransport(options: { transport: string; production: boolean; env?: Env }): MailTransport {
  const name = options.transport.trim() || 'dev-console'
  if (name === 'dev-console') {
    if (options.production) {
      throw new Error(
        'Mail transport "dev-console" is not allowed in production. Set PEERCHIVE_MAIL_TRANSPORT=smtp with PEERCHIVE_SMTP_URL and PEERCHIVE_MAIL_FROM.',
      )
    }
    return createDevConsoleTransport()
  }
  if (name === 'smtp') return createSmtpTransport(parseSmtpConfig(options.env ?? {}, { production: options.production }))
  // 잘못 넣은 값(예: URL)이 로그에 그대로 남지 않도록 이름 형식일 때만 보여 줍니다.
  throw new Error(`Unknown mail transport: ${/^[a-z0-9-]{1,32}$/.test(name) ? name : '(invalid value)'}`)
}
