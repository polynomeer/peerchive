/**
 * AI 공급자 인터페이스와 오류 분류 (E-12, ADR 0057). E-13 회의 요약·E-14 케이스 다듬기도 같은 인터페이스를 씁니다.
 *
 * - 공급자는 "구조화 출력 한 번"만 압니다: 고정 system 프롬프트 + 대화(user로 시작·끝) + zod 스키마 → 검증된 값.
 *   무엇을 보낼지(어떤 데이터가 프롬프트에 들어가는지)는 부르는 쪽이 정하고 문서로 남깁니다.
 * - 프롬프트·출력은 어디에도 로그로 남기지 않습니다. 오류 메시지에는 종류·상태 코드만 싣습니다(응답 본문·입력 글 없음).
 * - 사용량(토큰 수)은 결과와 오류에 붙여 돌려주며, 집계는 부르는 쪽(웹 `ai_usage_daily`)이 합니다.
 */
import type { z } from 'zod'

/** 출력 깊이(Claude `output_config.effort`). 라우트마다 고정합니다(바꾸면 캐시가 깨짐). */
export type AiEffort = 'low' | 'medium' | 'high'

export interface AiMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface AiStructuredRequest<T> {
  /** 사용량 집계 이름(예: `retro_interview.turn`). 내용이 아니라 기능 이름입니다. */
  feature: string
  /** 요청마다 바뀌지 않는 system 프롬프트(캐시 대상). 날짜·사용자 id·과제 이름 같은 값을 넣지 마세요. */
  system: string
  /** user로 시작하고 user로 끝나야 합니다(assistant prefill 없음). 요청마다 바뀌는 내용은 여기에. */
  messages: readonly AiMessage[]
  /** 출력 스키마. 공급자는 이 스키마로 JSON을 검증한 값만 돌려줍니다. */
  schema: z.ZodType<T>
  /** 출력 상한(생각 토큰 포함). */
  maxTokens: number
  effort: AiEffort
}

export interface AiUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
}

export const ZERO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

export interface AiStructuredResult<T> {
  data: T
  usage: AiUsage
  /** 실제로 답한 모델(서버 쪽 거절 대체가 돌았으면 대체 모델). */
  model: string
  /** 서버 쪽 거절 대체(fallback)가 답했는지. */
  fallback: boolean
}

export interface AiProvider {
  /** `anthropic`·`fake`. */
  readonly name: string
  /** 요청 모델. */
  readonly model: string
  generateStructured<T>(request: AiStructuredRequest<T>): Promise<AiStructuredResult<T>>
}

/**
 * AI 호출 실패 종류.
 * - `refusal`: 모델(대체 모델 포함)이 거절(`stop_reason: refusal`). 부분 출력은 버립니다.
 * - `max_tokens`: 출력 상한에 걸려 JSON이 끝나지 않음.
 * - `invalid_output`: JSON이 아니거나 스키마에 맞지 않음.
 * - `rate_limited`: 공급자 429(재시도 뒤에도).
 * - `unavailable`: 네트워크·시간 초과·5xx·529·인증·권한·잘못된 요청 등 그 밖의 공급자 오류.
 */
export type AiErrorKind = 'refusal' | 'max_tokens' | 'invalid_output' | 'rate_limited' | 'unavailable'

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    /** 공급자 HTTP 상태(있을 때). */
    readonly status: number | null = null,
    /** 실패했어도 쓴 토큰(거절·상한·형식 오류). 공급자 오류면 null. */
    readonly usage: AiUsage | null = null,
    /** 거절 분류(`stop_details.category`, 있을 때). 정보용입니다. */
    readonly refusalCategory: string | null = null,
  ) {
    // 메시지에는 종류·상태만(입력·출력 글 없음).
    super(status === null ? `ai ${kind}` : `ai ${kind} (${status})`)
    this.name = 'AiError'
  }
}

/** user로 시작하고 user로 끝나는지(assistant prefill은 Claude Opus 5.5에서 400). */
export function checkMessages(messages: readonly AiMessage[]): void {
  if (messages.length === 0 || messages[0]!.role !== 'user' || messages.at(-1)!.role !== 'user') {
    throw new Error('ai messages must start and end with a user turn')
  }
}
