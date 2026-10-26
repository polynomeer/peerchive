/**
 * 점검 모드(T-16, SYSTEM_DESIGN §11 "복구 시 최신 삭제를 재적용하기 전에는 외부 트래픽을 열지 않음", ADR 0016).
 *
 * `PEERCHIVE_MAINTENANCE=1`(또는 true/yes/on)로 web을 시작하면 `/api/v1/health`(얕은·상세 확인)를 뺀 모든 요청(화면·API·공개 조회·
 * 내부 API)이 DB를 건드리지 않고 503입니다. 복구 순서: 복구 → `pnpm ops:reapply-deletions` → 점검 모드 해제 후 재시작(RUNBOOK).
 * h3만 써서 테스트에서 그대로 조립합니다.
 */
import { createError, defineEventHandler, setResponseHeader, setResponseStatus, type EventHandler } from 'h3'

type Env = Readonly<Record<string, string | undefined>>
const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

export function maintenanceEnabled(env: Env): boolean {
  return TRUTHY.has((env.PEERCHIVE_MAINTENANCE ?? '').trim().toLowerCase())
}

/** 점검 모드에서도 여는 경로: 정확히 `/api/v1/health`(쿼리 허용). */
export function isMaintenanceExempt(path: string): boolean {
  const pathname = path.split('?')[0] ?? ''
  return pathname === '/api/v1/health'
}

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>점검 중 — Peerchive</title></head><body><main><h1>잠시 점검 중입니다</h1><p>곧 다시 열겠습니다. 잠시 뒤에 다시 시도해 주세요.</p></main></body></html>`

export function createMaintenanceGate(getEnv: () => Env = () => process.env): EventHandler {
  return defineEventHandler((event) => {
    if (!maintenanceEnabled(getEnv()) || isMaintenanceExempt(event.path)) return
    setResponseHeader(event, 'cache-control', 'no-store')
    setResponseHeader(event, 'retry-after', 600)
    setResponseHeader(event, 'x-robots-tag', 'noindex, nofollow')
    if (event.path.startsWith('/api/')) {
      throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', data: { code: 'maintenance' } })
    }
    setResponseStatus(event, 503, 'Service Unavailable')
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
    return PAGE
  })
}
