/**
 * 빌드 로그 규칙 (PROOFU_EVOLUTION_PLAN §6.2, SYSTEM_DESIGN §6.3).
 *
 * - 태그는 로그를 만들 때 정하고 바꾸지 않습니다. 내용 수정은 새 revision으로만 남깁니다.
 * - 💡해결(solution)은 같은 프로젝트의 🧱막힘(stuck) 로그 하나를 가리킵니다.
 *   한 막힘에 해결이 여럿 붙을 수 있고, 막힘이 끝내 해결되지 않아도 됩니다.
 * - payload 형식 검증은 서버(zod)가 하고, 여기서는 관계 규칙만 판정합니다.
 */

export const LOG_TAGS = ['progress', 'stuck', 'solution', 'decision', 'meeting', 'validation', 'retro'] as const
export type LogTag = (typeof LOG_TAGS)[number]

/** 본문이 꼭 있어야 하는 태그(구조화 필드가 없는 태그). */
export const BODY_REQUIRED_TAGS: readonly LogTag[] = ['progress', 'retro']

export function isLogTag(value: unknown): value is LogTag {
  return typeof value === 'string' && (LOG_TAGS as readonly string[]).includes(value)
}

/** 해결 대상으로 고른 로그. 없거나(또는 읽을 수 없으면) null. */
export interface ResolveTarget {
  id: string
  projectId: string
  tag: LogTag
}

export type ResolveCheck = 'ok' | 'not_found' | 'self' | 'not_stuck'

/**
 * 해결 연결 판정.
 *
 * - 대상이 없거나 다른 프로젝트의 로그면 `not_found`. 다른 프로젝트 로그의 존재를 드러내지 않도록 둘을 구분하지 않습니다.
 * - 자기 자신을 가리키면 `self`(revision에서 연결을 바꿀 때만 생길 수 있음).
 * - 대상이 막힘 로그가 아니면 `not_stuck`.
 */
export function checkResolveTarget(
  solution: { projectId: string; entryId?: string | null },
  target: ResolveTarget | null | undefined,
): ResolveCheck {
  if (!target || target.projectId !== solution.projectId) return 'not_found'
  if (solution.entryId && target.id === solution.entryId) return 'self'
  if (target.tag !== 'stuck') return 'not_stuck'
  return 'ok'
}

/** 태그는 만든 뒤 바꿀 수 없습니다. 요청에 태그가 없으면(그대로 두면) 허용합니다. */
export function isTagChangeAllowed(current: LogTag, requested: unknown): boolean {
  return requested === undefined || requested === current
}
