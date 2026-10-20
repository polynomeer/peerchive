/**
 * Peerchive 디스코드 봇 진입점(ADR 0009).
 *
 * 실행: `pnpm bot`(저장소 루트, 개발용) 또는 `pnpm --filter bot start`(production 기본: 강한 비밀 필수).
 * 업무 규칙은 웹 서버에 있고 봇은 서명한 내부 API 요청만 보냅니다. 1분마다 예약 알림(체크인 알림·주간 요약)을 확인합니다.
 * SIGINT/SIGTERM이면 알림 확인을 멈추고 gateway 연결을 닫습니다.
 */
import { createPeerchiveApi } from './api-client'
import { loadBotConfig } from './config'
import { createDiscordGateway } from './discord-gateway'
import { loadRootEnv } from './env'
import { createHandlers, wireGateway } from './handlers'

loadRootEnv()
const config = loadBotConfig(process.env)
const api = createPeerchiveApi({ baseUrl: config.apiBaseUrl, secret: config.internalSecret })
const handlers = createHandlers(api, { siteUrl: config.siteUrl })
const gateway = createDiscordGateway(config.discordToken)
wireGateway(gateway, handlers)
await gateway.start()

let ticking = false
const timer = setInterval(() => {
  if (ticking) return
  ticking = true
  handlers
    .tick(gateway)
    .catch((error: Error) => console.error('[bot] notice tick failed:', error.message))
    .finally(() => {
      ticking = false
    })
}, config.noticeIntervalMs)

console.info(`[bot] started (api=${config.apiBaseUrl}, production=${config.production})`)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.info(`[bot] ${signal} received, stopping…`)
  clearInterval(timer)
  await gateway.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
