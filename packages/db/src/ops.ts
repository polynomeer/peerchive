/**
 * 운영 공통 값(T-16, ADR 0016). 웹(분석 이벤트)과 worker(탈퇴 정리·삭제 장부·재적용)가 같은 규칙을 쓰도록 여기 둡니다.
 *
 * - pepper: 사용자·프로젝트 id를 HMAC-SHA256으로 가리는 서버 비밀. 분석용(PEERCHIVE_ANALYTICS_PEPPER)과 삭제 장부용
 *   (PEERCHIVE_DELETION_PEPPER)을 따로 둡니다. 분석 pepper는 바꿀 수 있지만(이전 이벤트와 이어지지 않음), 삭제 장부 pepper를 바꾸면
 *   재적용이 이전 장부를 맞추지 못하므로 바꾸지 않습니다.
 * - production(NODE_ENV가 development·test가 아님)에서는 32자 미만·자리표시 값이면 null을 돌려주고, 호출자가 기능을 끄거나 시작을 거부합니다.
 *   개발·테스트에서는 값이 없으면 고정 개발용 값을 씁니다(실제 데이터에 쓰지 마세요).
 */
import { createHash, createHmac } from 'node:crypto'

export const ANALYTICS_PEPPER_ENV = 'PEERCHIVE_ANALYTICS_PEPPER'
export const DELETION_PEPPER_ENV = 'PEERCHIVE_DELETION_PEPPER'

/** worker 프로세스의 상태 기록 이름(worker_heartbeats.name). 주기 작업은 `task:<이름>`입니다. */
export const WORKER_HEARTBEAT_NAME = 'worker'
export const taskHeartbeatName = (task: string) => `task:${task}`

const DEV_PEPPERS: Record<string, string> = {
  [ANALYTICS_PEPPER_ENV]: 'dev-only-analytics-pepper-not-for-real-data',
  [DELETION_PEPPER_ENV]: 'dev-only-deletion-pepper-not-for-real-data',
}

type Env = Readonly<Record<string, string | undefined>>

export function isProductionMode(env: Env): boolean {
  const mode = env.NODE_ENV?.trim()
  return mode !== 'development' && mode !== 'test'
}

/** 약한 값: 32자 미만이거나 개발용·자리표시 값. */
export function isWeakPepper(value: string): boolean {
  return value.length < 32 || /change-me|dev-only|placeholder|example/i.test(value)
}

/** pepper 값. production에서 없거나 약하면 null. */
export function resolvePepper(env: Env, name: typeof ANALYTICS_PEPPER_ENV | typeof DELETION_PEPPER_ENV): string | null {
  const value = env[name]?.trim() ?? ''
  if (isProductionMode(env)) return value && !isWeakPepper(value) ? value : null
  return value || DEV_PEPPERS[name]!
}

/** id의 HMAC-SHA256(소문자 hex 64자). id는 소문자로 정규화합니다. */
export function hashSubject(pepper: string, id: string): string {
  return createHmac('sha256', pepper).update(id.toLowerCase()).digest('hex')
}

/** pepper를 구분하는 짧은 값(SHA-256 앞 8자). pepper 자체는 드러나지 않습니다. */
export function pepperKeyId(pepper: string): string {
  return createHash('sha256').update(`peerchive-pepper-id:${pepper}`).digest('hex').slice(0, 8)
}
