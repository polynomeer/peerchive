/**
 * 악성코드 검사 어댑터(ADR 0007).
 *
 * - `clamav`: clamd의 INSTREAM 명령(TCP)으로 내용을 보내 검사합니다. 실제 운영에서 쓰는 검사기입니다.
 * - `signature-only`: 개발 전용. 형식 판별만 믿고 악성코드 검사는 하지 않습니다(EICAR 시험 문자열만 알아봄).
 *   production에서는 이 검사기로 worker가 시작되지 않습니다(config.ts).
 * - 검사기 오류(연결 실패·시간 초과·clamd ERROR)는 예외로 던져 작업 재시도에 맡깁니다.
 */
import { connect } from 'node:net'

export type MalwareVerdict = { infected: false } | { infected: true; signature: string }

export interface MalwareScanner {
  /** scan_engine 열에 남기는 이름. */
  readonly engine: string
  scan(content: AsyncIterable<Uint8Array>): Promise<MalwareVerdict>
}

/** EICAR 안티바이러스 시험 문자열(악성 아님). 개발용 검사기가 이것만 알아봅니다. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

export function createSignatureOnlyScanner(): MalwareScanner {
  return {
    engine: 'signature-only',
    async scan(content) {
      const chunks: Buffer[] = []
      for await (const chunk of content) chunks.push(Buffer.from(chunk))
      const found = Buffer.concat(chunks).includes(EICAR, 0, 'latin1')
      return found ? { infected: true, signature: 'EICAR-Test-File' } : { infected: false }
    },
  }
}

export interface ClamdOptions {
  host: string
  port: number
  /** 연결·응답 전체 제한(ms). 기본 60초. */
  timeoutMs?: number
}

/** INSTREAM 한 덩어리 최대 크기. clamd StreamMaxLength(기본 25MB)보다 파일 한도(20MB)가 작습니다. */
const CHUNK_BYTES = 64 * 1024

/** clamd에 명령 하나를 보내고 NUL로 끝나는 응답 한 줄을 받습니다. */
function clamdCommand(
  options: ClamdOptions,
  write: (socket: import('node:net').Socket) => Promise<void>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: options.host, port: options.port })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (error: Error | null, reply?: string) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve(reply ?? '')
    }
    socket.setTimeout(options.timeoutMs ?? 60_000, () => finish(new Error('clamd: timeout')))
    socket.on('error', (error) => finish(new Error(`clamd: ${error.message}`)))
    socket.on('data', (data) => {
      chunks.push(data)
      const all = Buffer.concat(chunks)
      const end = all.indexOf(0)
      if (end >= 0) finish(null, all.subarray(0, end).toString('utf8').trim())
    })
    socket.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()))
    socket.on('connect', () => {
      write(socket).catch((error: Error) => finish(error))
    })
  })
}

function writeAsync(socket: import('node:net').Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => socket.write(data, (error) => (error ? reject(error) : resolve())))
}

/** clamd 응답 해석. `stream: OK` / `stream: <이름> FOUND` / 그 밖(ERROR)은 예외. */
export function parseClamdReply(reply: string): MalwareVerdict {
  const body = reply.replace(/^\d+:\s*/, '') // IDSESSION 접두어(쓰지 않지만 방어)
  if (body === 'stream: OK') return { infected: false }
  const found = /^stream: (.+) FOUND$/.exec(body)
  if (found?.[1]) return { infected: true, signature: found[1] }
  throw new Error(`clamd: unexpected reply ${JSON.stringify(body.slice(0, 200))}`)
}

export function createClamdScanner(options: ClamdOptions): MalwareScanner & { ping(): Promise<void> } {
  return {
    engine: 'clamav',
    async scan(content) {
      const reply = await clamdCommand(options, async (socket) => {
        await writeAsync(socket, Buffer.from('zINSTREAM\0', 'latin1'))
        for await (const chunk of content) {
          for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) {
            const part = chunk.subarray(offset, offset + CHUNK_BYTES)
            const size = Buffer.alloc(4)
            size.writeUInt32BE(part.byteLength)
            await writeAsync(socket, size)
            await writeAsync(socket, part)
          }
        }
        await writeAsync(socket, Buffer.alloc(4)) // 길이 0 = 끝
      })
      return parseClamdReply(reply)
    },
    async ping() {
      const reply = await clamdCommand(options, (socket) => writeAsync(socket, Buffer.from('zPING\0', 'latin1')))
      if (reply !== 'PONG') throw new Error('clamd: ping failed')
    },
  }
}
