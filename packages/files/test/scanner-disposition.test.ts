import { createServer, type Server } from 'node:net'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import {
  asciiFallbackName,
  contentDisposition,
  createClamdScanner,
  createSignatureOnlyScanner,
  encodeRfc5987,
  parseClamdReply,
  sanitizeFileName,
} from '../src'
import { EICAR, PNG_1x1 } from './samples'

describe('signature-only scanner', () => {
  it('reports only the EICAR test string', async () => {
    const scanner = createSignatureOnlyScanner()
    expect(scanner.engine).toBe('signature-only')
    expect(await scanner.scan(Readable.from([PNG_1x1]))).toEqual({ infected: false })
    expect(await scanner.scan(Readable.from([Buffer.from('prefix '), EICAR]))).toEqual({
      infected: true,
      signature: 'EICAR-Test-File',
    })
  })
})

describe('clamd INSTREAM adapter', () => {
  let server: Server | undefined
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())))

  /** INSTREAM 프로토콜을 해석하는 가짜 clamd. 받은 내용을 판정 함수에 넘깁니다. */
  async function fakeClamd(reply: (content: Buffer, command: string) => string | null): Promise<number> {
    server = createServer((socket) => {
      let buf = Buffer.alloc(0)
      let command: string | null = null
      const parts: Buffer[] = []
      socket.on('data', (data) => {
        buf = Buffer.concat([buf, data])
        if (command === null) {
          const end = buf.indexOf(0)
          if (end < 0) return
          command = buf.subarray(0, end).toString('latin1')
          buf = buf.subarray(end + 1)
          if (command === 'zPING') return void socket.end('PONG\0')
        }
        while (buf.length >= 4) {
          const size = buf.readUInt32BE(0)
          if (size === 0) {
            const text = reply(Buffer.concat(parts), command)
            if (text === null) return // 응답하지 않음(시간 초과 시험)
            return void socket.end(`${text}\0`)
          }
          if (buf.length < 4 + size) return
          parts.push(buf.subarray(4, 4 + size))
          buf = buf.subarray(4 + size)
        }
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    return address.port
  }

  it('streams content in length-prefixed chunks and parses OK / FOUND', async () => {
    const received: Buffer[] = []
    const port = await fakeClamd((content, command) => {
      expect(command).toBe('zINSTREAM')
      received.push(content)
      return content.includes(EICAR) ? 'stream: Win.Test.EICAR_HDB-1 FOUND' : 'stream: OK'
    })
    const scanner = createClamdScanner({ host: '127.0.0.1', port })
    const big = Buffer.alloc(200 * 1024, 7) // 여러 덩어리로 나뉘는 크기
    expect(await scanner.scan(Readable.from([big]))).toEqual({ infected: false })
    expect(received[0]!.equals(big)).toBe(true)
    expect(await scanner.scan(Readable.from([EICAR]))).toEqual({ infected: true, signature: 'Win.Test.EICAR_HDB-1' })
    await expect(scanner.ping()).resolves.toBeUndefined()
  })

  it('throws on clamd errors, timeouts and connection failures (so the job retries)', async () => {
    const port = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR')
    await expect(createClamdScanner({ host: '127.0.0.1', port }).scan(Readable.from([PNG_1x1]))).rejects.toThrow(/clamd/)
    await new Promise<void>((resolve) => server!.close(() => resolve()))

    const silent = await fakeClamd(() => null)
    await expect(
      createClamdScanner({ host: '127.0.0.1', port: silent, timeoutMs: 200 }).scan(Readable.from([PNG_1x1])),
    ).rejects.toThrow(/timeout/)
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined

    await expect(createClamdScanner({ host: '127.0.0.1', port: 1 }).scan(Readable.from([PNG_1x1]))).rejects.toThrow(/clamd/)
  })

  it('parses replies strictly', () => {
    expect(parseClamdReply('stream: OK')).toEqual({ infected: false })
    expect(parseClamdReply('1: stream: Eicar-Signature FOUND')).toEqual({ infected: true, signature: 'Eicar-Signature' })
    expect(() => parseClamdReply('stream: OK extra')).toThrow()
    expect(() => parseClamdReply('')).toThrow()
  })
})

describe('file names and Content-Disposition', () => {
  it('sanitizes names: path parts, control and bidi characters, quotes, length', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\me\\보고서.pdf')).toBe('보고서.pdf')
    expect(sanitizeFileName('a\r\nContent-Type: x.png')).toBe('aContent-Type_ x.png')
    expect(sanitizeFileName('photo\u202Egnp.exe')).toBe('photognp.exe')
    expect(sanitizeFileName('"quoted".png')).toBe('_quoted_.png')
    expect(sanitizeFileName('  .hidden.png ')).toBe('hidden.png')
    expect(sanitizeFileName('...')).toBeNull()
    expect(sanitizeFileName('\u0000')).toBeNull()
    const long = sanitizeFileName(`${'가'.repeat(300)}.png`)!
    expect(long.length).toBe(200)
    expect(long.endsWith('.png')).toBe(true)
  })

  it('encodes RFC 5987 values and ASCII fallbacks', () => {
    expect(encodeRfc5987("보고서 (최종)'s.pdf")).toBe('%EB%B3%B4%EA%B3%A0%EC%84%9C%20%28%EC%B5%9C%EC%A2%85%29%27s.pdf')
    expect(asciiFallbackName('보고서.pdf')).toBe('___.pdf')
    expect(asciiFallbackName('a"b\\c%d;e.png')).toBe('a_b_c_d_e.png')
    expect(asciiFallbackName('한')).toBe('_')
  })

  it('builds inline/attachment headers that cannot break out of the quoted string', () => {
    expect(contentDisposition('screen shot.png', true)).toBe(
      `inline; filename="screen shot.png"; filename*=UTF-8''screen%20shot.png`,
    )
    expect(contentDisposition('최종 보고서.pdf', false)).toBe(
      `attachment; filename="__ ___.pdf"; filename*=UTF-8''%EC%B5%9C%EC%A2%85%20%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf`,
    )
    const header = contentDisposition('x";\r\nSet-Cookie: a=b.pdf', false)
    expect(header).not.toMatch(/[\r\n]/)
    expect(header.match(/"/g)).toHaveLength(2)
    expect(contentDisposition('', false)).toContain('filename="download"')
  })
})
