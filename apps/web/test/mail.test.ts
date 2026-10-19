import { describe, expect, it } from 'vitest'
import { createDevConsoleTransport, maskEmail, resolveMailTransport } from '../server/modules/identity/mail'

describe('mail transport', () => {
  it('refuses the dev-console transport in production', () => {
    expect(() => resolveMailTransport({ transport: 'dev-console', production: true })).toThrow(/not allowed in production/)
    expect(() => resolveMailTransport({ transport: '', production: true })).toThrow(/not allowed in production/)
  })

  it('uses the dev-console transport outside production and rejects unknown names', () => {
    expect(resolveMailTransport({ transport: 'dev-console', production: false }).name).toBe('dev-console')
    expect(() => resolveMailTransport({ transport: 'smtp', production: false })).toThrow(/Unknown mail transport/)
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
