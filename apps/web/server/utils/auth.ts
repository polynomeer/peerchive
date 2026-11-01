import type { H3Event } from 'h3'
import { parseAllowedOrigins } from '../modules/security/csrf'
import { parseTrustedProxies, resolveClientIp, type TrustedProxies } from '../modules/security/client-ip'
import { type MailTransport, resolveMailTransport } from '../modules/identity/mail'
import { SESSION_COOKIE_NAME, type SessionUser } from '../modules/identity/sessions'
import type { Actor } from '../modules/errors'

declare module 'h3' {
  interface H3EventContext {
    /** server/middleware/02.auth.ts가 채웁니다. 로그인하지 않았으면 null. */
    auth?: { sessionId: string; user: SessionUser } | null
  }
}

/**
 * production 여부. 빌드 산출물(.output)은 기본적으로 production으로 봅니다(배포 시 NODE_ENV를 빠뜨려도 안전).
 * 빌드한 서버를 로컬에서 점검할 때만 실행 시 `NODE_ENV=development`를 명시해 예외로 둘 수 있습니다.
 * 빌드 도구가 `process.env.NODE_ENV`를 상수로 바꾸므로 실행 시 값은 대괄호 접근으로 읽습니다.
 */
export function isProduction(): boolean {
  if (import.meta.dev) return false
  return globalThis.process?.env?.['NODE_ENV'] !== 'development'
}

/** 허용 사이트 origin 목록(NUXT_SITE_ORIGIN, 쉼표 구분). 첫 항목이 링크 생성 기준입니다. */
export function siteOrigins(): string[] {
  return parseAllowedOrigins(String(useRuntimeConfig().siteOrigin ?? ''))
}

export function primarySiteOrigin(): string {
  const origin = siteOrigins()[0]
  if (!origin) throw new Error('NUXT_SITE_ORIGIN is not configured')
  return origin
}

let mailTransport: MailTransport | undefined

/**
 * 메일 transport(프로세스당 하나). PEERCHIVE_MAIL_TRANSPORT가 있으면 그것을, 없으면 NUXT_MAIL_TRANSPORT(runtimeConfig)를 씁니다.
 * production에서는 올바르게 설정된 smtp만 허용하고 그 밖에는 예외(ADR 0017).
 */
export function useMailTransport(): MailTransport {
  const env = (globalThis.process?.env ?? {}) as Record<string, string | undefined>
  mailTransport ??= resolveMailTransport({
    transport: env['PEERCHIVE_MAIL_TRANSPORT']?.trim() || String(useRuntimeConfig().mailTransport ?? ''),
    production: isProduction(),
    env,
  })
  return mailTransport
}

export function setSessionCookie(event: H3Event, token: string, expiresAt: Date): void {
  setCookie(event, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction(),
    path: '/',
    expires: expiresAt,
  })
}

export function clearSessionCookie(event: H3Event): void {
  deleteCookie(event, SESSION_COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: isProduction(), path: '/' })
}

export function getSessionToken(event: H3Event): string | undefined {
  return getCookie(event, SESSION_COOKIE_NAME)
}

/** 로그인 필수 API. 세션이 없으면 401. */
export function requireActor(event: H3Event): Actor {
  const auth = event.context.auth
  if (!auth) throw createError({ statusCode: 401, statusMessage: 'Unauthorized', data: { code: 'unauthenticated' } })
  return { userId: auth.user.id }
}

let trustedProxies: TrustedProxies | undefined

/**
 * 신뢰 프록시 목록(PEERCHIVE_TRUSTED_PROXIES, 쉼표 구분 CIDR). 프로세스당 한 번 해석합니다.
 * 잘못된 항목이 있으면 production에서는 예외(server/plugins/trusted-proxies.ts에서 시작 시 확인).
 */
export function useTrustedProxies(): TrustedProxies {
  if (!trustedProxies) {
    const { proxies, invalid } = parseTrustedProxies(globalThis.process?.env?.['PEERCHIVE_TRUSTED_PROXIES'])
    if (invalid.length > 0) {
      const message = `PEERCHIVE_TRUSTED_PROXIES has ${invalid.length} invalid entr${invalid.length === 1 ? 'y' : 'ies'}`
      if (isProduction()) throw new Error(message)
      console.warn(`[security] ${message}; ignored`)
    }
    trustedProxies = proxies
  }
  return trustedProxies
}

/** 요청 IP(요청 한도 키 전용). 신뢰 프록시 뒤에서만 X-Forwarded-For를 봅니다(modules/security/client-ip.ts). */
export function requestIp(event: H3Event): string {
  return resolveClientIp({
    remoteAddress: event.node.req.socket?.remoteAddress,
    forwardedFor: getRequestHeader(event, 'x-forwarded-for'),
    proxies: useTrustedProxies(),
  })
}

/**
 * 같은 프로세스 안의 요청인지(SSR이 `useRequestFetch`·`$fetch`로 부른 API). nitro의 로컬 fetch는 unenv 가짜 요청 객체(`__unenv__`)를 쓰고,
 * 바깥에서 온 요청은 Node IncomingMessage라 이 표시를 만들 수 없습니다. 바깥 페이지 요청에서 이미 센 요청 한도를 다시 세지 않을 때만 씁니다(E-07).
 */
export function isInProcessRequest(event: H3Event): boolean {
  return '__unenv__' in event.node.req
}
