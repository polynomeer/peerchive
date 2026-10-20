/**
 * 외부 이벤트 id → 빌드 로그 clientId(UUID v5, RFC 9562). 같은 디스코드 interaction·메시지·체크인은
 * 언제 다시 보내도 같은 clientId가 되어 logs.ts의 재전송 중복 방지(project, author, client_id)로 한 번만 저장됩니다.
 */
import { createHash } from 'node:crypto'

/** Peerchive 외부 수집용 이름공간(임의로 정한 고정 UUID). 바꾸면 기존 재전송 판별이 끊깁니다. */
export const PEERCHIVE_CLIENT_ID_NAMESPACE = '5d1f8a0e-3c47-4b9e-9a62-7f0d2c8e41b5'

export function uuidV5(name: string, namespace = PEERCHIVE_CLIENT_ID_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const bytes = createHash('sha1').update(ns).update(name, 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const discordInteractionClientId = (interactionId: string) => uuidV5(`discord:interaction:${interactionId}`)
export const discordMessageClientId = (messageId: string) => uuidV5(`discord:message:${messageId}`)
export const checkinClientId = (checkinId: string) => uuidV5(`checkin:${checkinId}`)
