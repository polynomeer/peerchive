import { describe, expect, it } from 'vitest'
import {
  MailSendError,
  createDevConsoleTransport,
  createSmtpTransport,
  describeMailError,
  maskEmail,
  parseSmtpConfig,
  resolveMailTransport,
} from '../server/modules/identity/mail'
import { magicLinkMail } from '../server/modules/identity/magic-link'

const FROM = { PEERCHIVE_MAIL_FROM: 'Peerchive <no-reply@mail.example.test>' }

describe('mail transport', () => {
  it('refuses the dev-console transport in production', () => {
    expect(() => resolveMailTransport({ transport: 'dev-console', production: true })).toThrow(/not allowed in production/)
    expect(() => resolveMailTransport({ transport: '', production: true })).toThrow(/not allowed in production/)
  })

  it('uses the dev-console transport outside production and rejects unknown names', () => {
    expect(resolveMailTransport({ transport: 'dev-console', production: false }).name).toBe('dev-console')
    expect(() => resolveMailTransport({ transport: 'sendgrid', production: false })).toThrow(/Unknown mail transport/)
  })

  it('masks the recipient address in console output', async () => {
    const lines: string[] = []
    await createDevConsoleTransport((line) => lines.push(line)).send({
      to: 'student@example.test',
      subject: 's',
      text: 'body',
    })
    expect(lines.join('\n')).not.toContain('student@example.test')
    expect(lines.join('\n')).toContain('s***@example.test')
    expect(maskEmail('x')).toBe('***')
  })
})

describe('smtp configuration', () => {
  it('parses smtps:// (implicit TLS) and smtp:// (STARTTLS required) URLs with encoded credentials', () => {
    expect(parseSmtpConfig({ ...FROM, PEERCHIVE_SMTP_URL: 'smtps://mailer%40example.test:p%40ss%2Fword@smtp.example.test' }, { production: true })).toEqual({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      requireTls: true,
      auth: { user: 'mailer@example.test', pass: 'p@ss/word' },
      from: { name: 'Peerchive', address: 'no-reply@mail.example.test' },
      replyTo: null,
    })
    expect(parseSmtpConfig({ ...FROM, PEERCHIVE_SMTP_URL: 'smtp://u:p@smtp.example.test:2525' }, { production: true })).toMatchObject({
      port: 2525,
      secure: false,
      requireTls: true,
    })
    expect(
      parseSmtpConfig({ PEERCHIVE_MAIL_FROM: 'no-reply@mail.example.test', PEERCHIVE_MAIL_REPLY_TO: 'help@example.test', PEERCHIVE_SMTP_URL: 'smtp://relay.internal' }, { production: true }),
    ).toMatchObject({ port: 587, auth: null, from: { name: null, address: 'no-reply@mail.example.test' }, replyTo: 'help@example.test' })
  })

  it('parses the split host/port/secure/user/password variables', () => {
    expect(
      parseSmtpConfig(
        { ...FROM, PEERCHIVE_SMTP_HOST: 'smtp.example.test', PEERCHIVE_SMTP_SECURE: '1', PEERCHIVE_SMTP_USER: 'u', PEERCHIVE_SMTP_PASSWORD: ' p ' },
        { production: true },
      ),
    ).toMatchObject({ host: 'smtp.example.test', port: 465, secure: true, auth: { user: 'u', pass: ' p ' } })
    expect(parseSmtpConfig({ ...FROM, PEERCHIVE_SMTP_HOST: 'smtp.example.test', PEERCHIVE_SMTP_PORT: '587' }, { production: true })).toMatchObject({
      port: 587,
      secure: false,
      requireTls: true,
    })
  })

  it('allows plain SMTP only with the explicit insecure flag, never in production', () => {
    const local = { ...FROM, PEERCHIVE_SMTP_URL: 'smtp://127.0.0.1:1025', PEERCHIVE_SMTP_ALLOW_INSECURE: '1' }
    expect(parseSmtpConfig(local, { production: false }).requireTls).toBe(false)
    expect(() => parseSmtpConfig(local, { production: true })).toThrow(/not allowed in production/)
    expect(() => resolveMailTransport({ transport: 'smtp', production: true, env: local })).toThrow(/not allowed in production/)
    expect(resolveMailTransport({ transport: 'smtp', production: false, env: local }).name).toBe('smtp')
  })

  it('refuses missing or malformed settings without echoing secrets', () => {
    const cases: Array<Record<string, string>> = [
      {},
      { PEERCHIVE_SMTP_URL: 'smtps://u:p@smtp.example.test' }, // FROM 없음
      { ...FROM, PEERCHIVE_SMTP_URL: 'https://smtp.example.test' },
      { ...FROM, PEERCHIVE_SMTP_URL: 'smtps://u:hunter2-secret@smtp.example.test/path' },
      { ...FROM, PEERCHIVE_SMTP_URL: 'smtps://u:hunter2-secret@smtp.example.test?pool=true' },
      { ...FROM, PEERCHIVE_SMTP_URL: 'smtps://only-user@smtp.example.test' },
      { ...FROM, PEERCHIVE_SMTP_URL: 'smtps://smtp.example.test', PEERCHIVE_SMTP_HOST: 'smtp.example.test' },
      { ...FROM, PEERCHIVE_SMTP_HOST: 'smtp.example.test', PEERCHIVE_SMTP_PORT: '99999' },
      { ...FROM, PEERCHIVE_SMTP_HOST: 'bad host', PEERCHIVE_SMTP_PASSWORD: 'hunter2-secret' },
      { ...FROM, PEERCHIVE_SMTP_HOST: 'smtp.example.test', PEERCHIVE_SMTP_PASSWORD: 'hunter2-secret' },
      { ...FROM, PEERCHIVE_SMTP_HOST: 'smtp.example.test', PEERCHIVE_SMTP_SECURE: 'yes' },
      { ...FROM, PEERCHIVE_SMTP_URL: 'smtps://smtp.example.test', PEERCHIVE_SMTP_ALLOW_INSECURE: 'true' },
      { PEERCHIVE_MAIL_FROM: 'not an address', PEERCHIVE_SMTP_URL: 'smtps://smtp.example.test' },
      { PEERCHIVE_MAIL_FROM: 'Name <a@b.test>\r\nBcc: x@y.test', PEERCHIVE_SMTP_URL: 'smtps://smtp.example.test' },
      { ...FROM, PEERCHIVE_MAIL_REPLY_TO: 'a@b.test, c@d.test', PEERCHIVE_SMTP_URL: 'smtps://smtp.example.test' },
    ]
    for (const env of cases) {
      let message = 'ok'
      try {
        parseSmtpConfig(env, { production: true })
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, JSON.stringify(env)).not.toBe('ok')
      expect(message).not.toContain('hunter2-secret')
    }
    // production에서 transport 이름만 smtp이고 설정이 없으면 시작하지 않습니다.
    expect(() => resolveMailTransport({ transport: 'smtp', production: true, env: {} })).toThrow(/not configured/)
  })

  it('turns send failures into a sanitized error without server text or addresses', async () => {
    // 아무도 듣지 않는 포트: 연결 거부.
    const transport = createSmtpTransport(
      parseSmtpConfig({ ...FROM, PEERCHIVE_SMTP_URL: 'smtp://127.0.0.1:9', PEERCHIVE_SMTP_ALLOW_INSECURE: '1' }, { production: false }),
      { log: () => {} },
    )
    const error = await transport.send({ to: 'victim@example.test', subject: 's', text: 't' }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(MailSendError)
    expect(String((error as Error).message)).not.toContain('victim@example.test')
    expect((error as Error).cause).toBeUndefined()
    expect(describeMailError(error).code).toMatch(/^E[A-Z]+$/)
    expect(describeMailError(new Error('550 <victim@example.test> rejected'))).toEqual({ code: 'Error', responseCode: null })
  })
})

describe('magic link message', () => {
  it('keeps the fragment URL in both text and HTML and escapes HTML', () => {
    const url = 'https://peerchive.example.test/auth/verify#token=abc_DEF-123'
    const mail = magicLinkMail(url)
    expect(mail.subject).toBe('Peerchive 로그인 링크')
    expect(mail.text.split('\n')).toContain(url)
    expect(mail.text).toContain('15분 동안 한 번만')
    expect(mail.html).toContain(`href="${url}"`)
    expect(mail.html).toContain('lang="ko"')
    expect(magicLinkMail('https://x.test/auth/verify#token=a"<b>').html).not.toContain('"<b>')
  })
})
