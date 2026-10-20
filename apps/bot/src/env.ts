import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 저장소 루트의 .env(로컬 전용)가 있으면 읽습니다. 이미 설정된 환경 변수가 우선합니다. */
export function loadRootEnv(): void {
  const rootEnv = fileURLToPath(new URL('../../../.env', import.meta.url))
  if (existsSync(rootEnv)) {
    const before = { ...process.env }
    process.loadEnvFile(rootEnv)
    for (const [key, value] of Object.entries(before)) process.env[key] = value
  }
}
