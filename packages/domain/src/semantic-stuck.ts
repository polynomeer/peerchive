/**
 * 유사 막힘 의미 검색 규칙 (E-05, DELIVERY_PLAN §4.4, ADR 0055).
 *
 * - 임베딩할 글은 **공개 release 스냅샷**의 🧱막힘 로그(증상·키워드)와 그 막힘을 가리키는 같은 스냅샷의 💡해결 로그(해결 방법)뿐입니다.
 *   비공개 작업 공간의 로그·시도·오류 원문·사람 이름은 넣지 않습니다(스냅샷에 있어도 시도·오류 원문은 넣지 않음).
 * - 운영 조치로 가린 로그(막힘이든 해결이든)는 빼고 만듭니다.
 * - 런타임 의존성 없음(해시·공급자 호출은 @peerchive/embeddings).
 */
import { type HubSnapshot, extractStuckItems } from './course-hub'

/** 공급자로 보내는 글 하나의 최대 길이(문자). 넘으면 자릅니다. */
export const STUCK_EMBEDDING_TEXT_MAX = 2000
/** "비슷한 막힘" 결과 수 기본·최대. */
export const SIMILAR_STUCK_DEFAULT_LIMIT = 5
export const SIMILAR_STUCK_MAX_LIMIT = 10
/** 이 값보다 덜 비슷하면 결과에서 뺍니다(코사인). */
export const SIMILAR_STUCK_MIN_SCORE = 0.2

export interface StuckEmbeddingSource {
  /** 스냅샷 로그 키(공개마다 안정). */
  itemKey: string
  /** 공급자로 보낼 글. */
  text: string
}

const clip = (text: string, max: number) => ([...text].length > max ? [...text].slice(0, max).join('') : text)
const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

/** 공개 스냅샷 → 막힘 카드마다 임베딩할 글(가린 로그 제외). */
export function stuckEmbeddingSources(snapshot: HubSnapshot, hiddenLogKeys: ReadonlySet<string> = new Set()): StuckEmbeddingSource[] {
  const solutions = new Map<string, string[]>()
  for (const log of snapshot.logs) {
    if (log.tag !== 'solution' || !log.resolves || hiddenLogKeys.has(log.key)) continue
    const method = str(log.payload.method) || str(log.body)
    if (method) solutions.set(log.resolves, [...(solutions.get(log.resolves) ?? []), method])
  }
  return extractStuckItems(snapshot)
    .filter((item) => !hiddenLogKeys.has(item.key))
    .map((item) => {
      const parts = [`막힘: ${item.symptom.trim()}`]
      if (item.keywords.length) parts.push(`키워드: ${item.keywords.join(', ')}`)
      for (const method of solutions.get(item.key) ?? []) parts.push(`해결: ${method}`)
      return { itemKey: item.key, text: clip(parts.join('\n'), STUCK_EMBEDDING_TEXT_MAX) }
    })
}

/** 결과 수 해석(없으면 기본, 1~최대). 틀린 값은 null(422). */
export function parseSimilarLimit(raw: unknown): number | null {
  if (raw === undefined || raw === '' || raw === null) return SIMILAR_STUCK_DEFAULT_LIMIT
  const n = typeof raw === 'string' ? Number(raw) : raw
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= SIMILAR_STUCK_MAX_LIMIT ? n : null
}
