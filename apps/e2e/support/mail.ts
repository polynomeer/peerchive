/**
 * dev-console 메일 읽기. web 서버는 로그인 메일을 stdout에 다음 형태로 출력하고(ADR 0006), global setup이
 * 그 출력을 `.e2e-state/web.log`에 모읍니다.
 *
 *   ──── [dev-console mail] 개발용 메일 출력(production 금지) ────
 *   to: a***@example.com
 *   subject: …
 *   …본문(링크 `http://localhost:PORT/auth/verify#token=…`)…
 *
 * 수신 주소는 가려져 있으므로(첫 글자 + 도메인) 테스트마다 무작위 도메인을 써서 메일을 구분합니다.
 */
import { existsSync, readFileSync } from 'node:fs'
import { SERVER_LOG } from './env'

const MARKER = '[dev-console mail]'

/** 서버의 maskEmail과 같은 규칙(a***@example.com). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  return `${email[0]}***${email.slice(at)}`
}

function blocksFor(email: string): string[] {
  if (!existsSync(SERVER_LOG)) return []
  const masked = `to: ${maskEmail(email)}`
  return readFileSync(SERVER_LOG, 'utf8')
    .split(MARKER)
    .slice(1)
    .filter((block) => block.split('\n').some((line) => line.trim() === masked))
}

/** 지금까지 이 주소로 온 메일 수(새 메일을 기다릴 때 기준). */
export function mailCount(email: string): number {
  return blocksFor(email).length
}

/** `after`개 다음에 온 첫 로그인 링크를 기다립니다. */
export async function waitForMagicLink(email: string, after: number, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const blocks = blocksFor(email)
    if (blocks.length > after) {
      const match = /(https?:\/\/[^\s]+\/auth\/verify#token=[A-Za-z0-9_-]+)/.exec(blocks[after]!)
      if (match) return match[1]!
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`로그인 메일을 찾지 못했습니다: ${maskEmail(email)} (${SERVER_LOG})`)
}
