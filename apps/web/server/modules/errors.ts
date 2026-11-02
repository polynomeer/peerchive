/**
 * 서비스 계층 오류. handler가 HTTP 상태로 바꿉니다(server/utils/http.ts).
 *
 * - NOT_FOUND(404): 없거나 읽을 권한이 없는 대상. 비공개 객체의 존재를 드러내지 않도록 둘을 구분하지 않습니다(§8).
 * - FORBIDDEN(403): 읽을 수는 있지만 이 행동은 할 수 없음(예: viewer가 수정).
 * - CONFLICT(409): 낡은 version, 이미 멤버, owner 탈퇴 등 현재 상태와 충돌.
 * - GONE(410): 만료·사용·취소된 일회성 토큰(업로드 의도 포함). 어떤 경우인지 밝히지 않습니다.
 * - PAYLOAD_TOO_LARGE(413): 업로드 본문이 선언한 크기·파일 한도를 넘음(받던 내용은 지움).
 * - VALIDATION(422): 필드별 오류 코드.
 * - RATE_LIMITED(429): 사용자별 생성 한도(학교·과목·학기·개념 태그 만들기 등) 초과.
 * - UNAVAILABLE(503): 외부 공급자(AI 등)가 지금 답하지 못함. 이유 코드만 싣고 공급자 응답·입력 글은 싣지 않습니다(E-12).
 */
export type ServiceErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'

/** 오류 응답의 추가 값. 409 similar_exists의 후보 목록처럼 짧은 레코드 배열도 됩니다. 민감 정보 금지. */
export type ErrorDetailValue = string | number | null | ReadonlyArray<Readonly<Record<string, string | number | null>>>

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    /** 클라이언트가 분기할 수 있는 짧은 이유 코드(예: 'version_conflict'). 민감 정보 금지. */
    readonly reason?: string,
    /** VALIDATION일 때 필드별 오류 코드. */
    readonly fields?: Record<string, string>,
    /** 클라이언트가 복구에 쓰는 추가 값(예: 409의 currentRevision). 민감 정보 금지. */
    readonly details?: Record<string, ErrorDetailValue>,
  ) {
    super(reason ? `${code}: ${reason}` : code)
    this.name = 'ServiceError'
  }
}

export const notFound = () => new ServiceError('NOT_FOUND')
export const forbidden = (reason?: string) => new ServiceError('FORBIDDEN', reason)
export const conflict = (reason: string, details?: Record<string, ErrorDetailValue>) =>
  new ServiceError('CONFLICT', reason, undefined, details)
export const rateLimited = () => new ServiceError('RATE_LIMITED', 'rate_limited')
export const gone = (reason = 'link_unavailable') => new ServiceError('GONE', reason)
export const tooLarge = () => new ServiceError('PAYLOAD_TOO_LARGE', 'too_large')
export const unavailable = (reason: string) => new ServiceError('UNAVAILABLE', reason)
export const invalid = (fields: Record<string, string>) => new ServiceError('VALIDATION', 'validation_failed', fields)

/** drizzle가 감싼 오류에서 PostgreSQL SQLSTATE를 찾습니다. */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/** 요청 주체(로그인한 사용자). 서비스 함수의 두 번째 인자입니다. */
export interface Actor {
  userId: string
}
