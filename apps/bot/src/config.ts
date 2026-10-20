/**
 * 봇 설정. 웹 서버와 같은 PEERCHIVE_INTERNAL_SECRET을 씁니다(ADR 0009).
 *
 * production 판단은 worker와 같습니다: NODE_ENV가 development/test가 아니면 production.
 * production에서는 강한 공유 비밀(32자 이상, 자리표시 값 아님)이 없으면 시작하지 않고, 개발에서도 비밀은 필수입니다.
 * 토큰·비밀 값은 로그에 남기지 않습니다.
 */
import { resolveInternalSecret } from '@peerchive/bot-protocol'

export type Env = Record<string, string | undefined>

export interface BotConfig {
  production: boolean
  discordToken: string
  applicationId: string | null
  /** 명령을 한 서버에만 등록할 때(개발용, 즉시 반영). 없으면 전역 등록. */
  guildId: string | null
  /** 웹 서버 주소(내부 API를 부를 곳). */
  apiBaseUrl: string
  /** 사용자에게 보여 줄 사이트 주소(연결 안내 링크). 기본은 apiBaseUrl. */
  siteUrl: string
  internalSecret: string
  /** 예약 알림 확인 주기(ms). */
  noticeIntervalMs: number
}

export function isProductionEnv(env: Env): boolean {
  const mode = env.NODE_ENV?.trim()
  return mode !== 'development' && mode !== 'test'
}

function baseUrl(value: string | undefined, fallback: string | null, name: string): string {
  const raw = value?.trim() || fallback
  if (!raw) throw new Error(`${name} is not set`)
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be http(s)`)
  return url.origin
}

export function loadBotConfig(env: Env): BotConfig {
  const production = isProductionEnv(env)
  const discordToken = env.DISCORD_BOT_TOKEN?.trim() ?? ''
  if (!discordToken) throw new Error('DISCORD_BOT_TOKEN is not set')
  const internalSecret = resolveInternalSecret(env.PEERCHIVE_INTERNAL_SECRET, { production })
  if (!internalSecret) throw new Error('PEERCHIVE_INTERNAL_SECRET is not set')
  const apiBaseUrl = baseUrl(env.PEERCHIVE_API_BASE_URL, production ? null : 'http://localhost:3000', 'PEERCHIVE_API_BASE_URL')
  return {
    production,
    discordToken,
    applicationId: env.DISCORD_APPLICATION_ID?.trim() || null,
    guildId: env.DISCORD_GUILD_ID?.trim() || null,
    apiBaseUrl,
    siteUrl: baseUrl(env.PEERCHIVE_SITE_URL, apiBaseUrl, 'PEERCHIVE_SITE_URL'),
    internalSecret,
    noticeIntervalMs: 60_000,
  }
}
