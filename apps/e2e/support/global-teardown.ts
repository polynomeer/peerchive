/**
 * E2E global teardown: global setup이 띄운 web·worker 프로세스 그룹만 멈추고 임시 저장소를 지웁니다.
 * DB(peerchive_e2e)는 다음 실행이 다시 만들므로 남겨 둡니다(실패 원인 조사용). 서버 로그도 `.e2e-state/`에 남습니다.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { STATE_FILE } from './env'
import type { E2eState } from './global-setup'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function stop(pid: number | null): Promise<void> {
  if (!pid) return
  // detached로 띄웠으므로 PID = 프로세스 그룹 id. 그룹(자식 포함)에만 신호를 보냅니다.
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      // 이미 끝남
    }
  }
  signal('SIGTERM')
  const deadline = Date.now() + 5000
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  if (alive(pid)) signal('SIGKILL')
}

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState
  await Promise.all([stop(state.webPid), stop(state.workerPid)])
  if (state.storageRoot && state.storageRoot.startsWith(tmpdir()) && state.storageRoot.includes('peerchive-e2e-objects-')) {
    rmSync(state.storageRoot, { recursive: true, force: true })
  }
}
