/**
 * SMTP 메일 transport 통합 테스트(ADR 0017).
 * - Mailpit(로컬 SMTP 시험 서버)이 있을 때만: PEERCHIVE_TEST_MAILPIT_SMTP_URL(예 smtp://127.0.0.1:1025)과
 *   PEERCHIVE_TEST_MAILPIT_API_URL(예 http://127.0.0.1:8025). `docker compose -f ops/docker-compose.yml --profile mailpit up -d --wait mailpit`.
 * - 매직링크 요청 전체 흐름(토큰 저장·발송 실패 처리)은 DATABASE_URL도 있을 때만.
 * 테스트마다 새 수신 주소를 써서 Mailpit에 남은 다른 메일과 섞이지 않습니다.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, auditEvents, eq, sql } from '@peerchive/db'
import { createSmtpTransport, parseSmtpConfig, type MailTransport } from '../server/modules/identity/mail'
import { requestMagicLink, verifyMagicLink } from '../server/modules/identity/magic-link'
import { closeTestDb, databaseUrl, uniqueEmail, withRollback } from './helpers'

const smtpUrl = process.env.PEERCHIVE_TEST_MAILPIT_SMTP_URL?.trim()
const apiUrl = process.env.PEERCHIVE_TEST_MAILPIT_API_URL?.trim()

function loopbackOnly(url: string): string {
  const host = new URL(url).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('Mailpit test URLs must be loopback addresses')
  return url
}

/** 콘솔 출력(log/info/warn/error)을 모읍니다. 토큰·주소가 새지 않았는지 확인할 때 씁니다. */
function captureConsole() {
  const lines: string[] = []
  const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }),
  )
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()) }
}

interface MailpitSummary {
  ID: string
}
interface MailpitMessage {
  ID: string
  Subject: string
  Text: string
  HTML: string
  To: Array<{ Address: string }>
  From: { Name: string; Address: string }
  MessageID: string
}

/** 받는 주소로 Mailpit에서 메일을 찾습니다(도착까지 잠깐 기다림). */
async function fetchMail(to: string): Promise<{ message: MailpitMessage; headers: Record<string, string[]> }> {
  const base = loopbackOnly(apiUrl!)
  for (let attempt = 0; attempt < 50; attempt++) {
    const search = (await (await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as {
      messages: MailpitSummary[]
    }
    const first = search.messages[0]
    if (first) {
      const message = (await (await fetch(`${base}/api/v1/message/${first.ID}`)).json()) as MailpitMessage
      const headers = (await (await fetch(`${base}/api/v1/message/${first.ID}/headers`)).json()) as Record<string, string[]>
      return { message, headers }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('mail did not arrive in Mailpit')
}

function mailpitTransport(log?: (line: string) => void): MailTransport {
  const config = parseSmtpConfig(
    {
      PEERCHIVE_SMTP_URL: loopbackOnly(smtpUrl!),
      // Mailpit은 TLS 없는 로컬 SMTP라 개발 전용 허용 표시가 필요합니다(production에서는 거부).
      PEERCHIVE_SMTP_ALLOW_INSECURE: '1',
      PEERCHIVE_MAIL_FROM: 'Peerchive <no-reply@peerchive.example.test>',
      PEERCHIVE_MAIL_REPLY_TO: 'help@peerchive.example.test',
    },
    { production: false },
  )
  return createSmtpTransport(config, log ? { log } : {})
}

const ORIGIN = 'http://localhost:3000'
const verifyUrl = (token: string) => `${ORIGIN}/auth/verify#token=${encodeURIComponent(token)}`

describe.skipIf(!smtpUrl || !apiUrl)('smtp transport (Mailpit)', () => {
  it('delivers a Korean text + HTML magic link mail with transactional headers and logs only the masked recipient', async () => {
    const to = uniqueEmail('smtp')
    const logs: string[] = []
    const transport = mailpitTransport((line) => logs.push(line))
    await transport.send({ to, subject: '시험 메일', text: '본문 token=SECRET-TOKEN-VALUE', html: '<p>본문</p>' })

    const { message, headers } = await fetchMail(to)
    expect(message.Subject).toBe('시험 메일')
    expect(message.From).toEqual({ Name: 'Peerchive', Address: 'no-reply@peerchive.example.test' })
    expect(message.To.map((t) => t.Address)).toEqual([to])
    expect(message.Text.trim()).toBe('본문 token=SECRET-TOKEN-VALUE')
    expect(message.HTML).toContain('<p>본문</p>')
    expect(message.MessageID).toMatch(/^[0-9a-f-]{36}@peerchive\.example\.test$/)
    expect(headers['Auto-Submitted']).toEqual(['auto-generated'])
    expect(headers['Reply-To']?.[0]).toContain('help@peerchive.example.test')
    expect(headers['Date']?.[0]).toBeTruthy()

    expect(logs).toEqual([`[mail:smtp] sent to=${to[0]}***@example.test`])
    expect(logs.join('\n')).not.toContain('SECRET-TOKEN-VALUE')
  })
})

describe.skipIf(!smtpUrl || !apiUrl || !databaseUrl)('magic link over smtp (Mailpit + PostgreSQL)', () => {
  let console_: ReturnType<typeof captureConsole>
  beforeEach(() => {
    console_ = captureConsole()
  })
  afterEach(() => console_.restore())
  afterAll(closeTestDb)

  it('sends the /auth/verify#token= link, the received token logs in, and no token reaches the logs', async () => {
    await withRollback(async (tx) => {
      const email = uniqueEmail('magic')
      const result = await requestMagicLink(tx, { email, ip: crypto.randomUUID(), mail: mailpitTransport(), buildVerifyUrl: verifyUrl })
      expect(result).toBe('accepted')

      const { message } = await fetchMail(email.toLowerCase())
      expect(message.Subject).toBe('Peerchive 로그인 링크')
      const links = message.Text.match(/https?:\/\/\S+/g) ?? []
      expect(links).toHaveLength(1)
      const link = links[0]!
      expect(link).toMatch(/^http:\/\/localhost:3000\/auth\/verify#token=[A-Za-z0-9_-]{43}$/)
      expect(message.HTML).toContain(`href="${link}"`)

      const token = decodeURIComponent(link.split('#token=')[1]!)
      expect((await verifyMagicLink(tx, { token })).ok).toBe(true)
      const logged = console_.lines.join('\n')
      expect(logged).not.toContain(token)
      expect(logged).not.toContain(email.toLowerCase())
    })
  })
})

describe.skipIf(!databaseUrl)('magic link mail failure (PostgreSQL)', () => {
  let console_: ReturnType<typeof captureConsole>
  beforeEach(() => {
    console_ = captureConsole()
  })
  afterEach(() => console_.restore())
  afterAll(closeTestDb)

  it('still answers accepted, logs a redacted error and records an audit line without the address', async () => {
    await withRollback(async (tx) => {
      const email = uniqueEmail('fail')
      // 아무도 듣지 않는 포트로 보내 실제 SMTP 실패를 만듭니다.
      const broken = createSmtpTransport(
        parseSmtpConfig(
          { PEERCHIVE_SMTP_URL: 'smtp://127.0.0.1:9', PEERCHIVE_SMTP_ALLOW_INSECURE: '1', PEERCHIVE_MAIL_FROM: 'no-reply@peerchive.example.test' },
          { production: false },
        ),
      )
      let sentToken = ''
      const result = await requestMagicLink(tx, {
        email,
        ip: crypto.randomUUID(),
        mail: broken,
        buildVerifyUrl: (token) => {
          sentToken = token
          return verifyUrl(token)
        },
      })
      expect(result).toBe('accepted')
      const logged = console_.lines.join('\n')
      expect(logged).toMatch(/\[auth\] magic link mail failed \(transport=smtp, code=E[A-Z]+/)
      expect(logged).not.toContain(email.toLowerCase())
      expect(logged).not.toContain(sentToken)

      const rows = await tx
        .select()
        .from(auditEvents)
        // 이 트랜잭션에서 쓴 행만(트랜잭션 안의 now()는 시작 시각으로 고정).
        .where(and(eq(auditEvents.action, 'mail.send_failed'), sql`${auditEvents.at} = now()`))
      expect(rows).toHaveLength(1)
      const mine = rows[0]!
      expect(mine).toMatchObject({ actorId: null, targetType: 'mail', targetId: null })
      expect(mine.metadata).toMatchObject({ purpose: 'magic_link', transport: 'smtp' })
      expect(JSON.stringify(mine.metadata)).not.toContain('@')
    })
  })
})
