/**
 * 결정적(canonical) JSON 직렬화 (T-11, SYSTEM_DESIGN §1 불변조건 2: 동의는 manifest 해시에 묶임).
 *
 * 같은 값이면 언제·어디서 만들어도 같은 문자열이 나와야 manifest 해시가 안정됩니다.
 * - 객체 키는 UTF-16 코드 단위 순으로 정렬합니다(`Array.prototype.sort` 기본). 값이 `undefined`인 키는 뺍니다.
 * - 배열은 순서를 그대로 둡니다(순서가 의미 없는 목록은 호출자가 먼저 정렬).
 * - 문자열은 `JSON.stringify`의 이스케이프를 따르고 유니코드 정규화는 하지 않습니다(보이는 내용 그대로를 해시).
 * - 숫자는 유한한 값만, `-0`은 `0`으로. `Date`·`Map`·`BigInt`·함수·클래스 인스턴스는 거부합니다(호출자가 ISO 문자열 등으로 바꿈).
 * 해시 계산(SHA-256)은 런타임 의존성이 없는 이 패키지 밖(서버 모듈)에서 합니다.
 */

export class CanonicalJsonError extends TypeError {
  constructor(readonly path: string, reason: string) {
    super(`canonicalJson: ${reason} at ${path || '$'}`)
    this.name = 'CanonicalJsonError'
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, 'non-finite number')
      return Object.is(value, -0) ? '0' : JSON.stringify(value)
    case 'object': {
      if (seen.has(value)) throw new CanonicalJsonError(path, 'cycle')
      seen.add(value)
      try {
        if (Array.isArray(value)) {
          return `[${value
            .map((item, index) => {
              if (item === undefined) throw new CanonicalJsonError(`${path}[${index}]`, 'undefined in array')
              return encode(item, `${path}[${index}]`, seen)
            })
            .join(',')}]`
        }
        if (!isPlainObject(value)) throw new CanonicalJsonError(path, 'not a plain object')
        const record = value as Record<string, unknown>
        const parts: string[] = []
        for (const key of Object.keys(record).sort()) {
          const item = record[key]
          if (item === undefined) continue
          parts.push(`${JSON.stringify(key)}:${encode(item, `${path}.${key}`, seen)}`)
        }
        return `{${parts.join(',')}}`
      } finally {
        seen.delete(value)
      }
    }
    default:
      throw new CanonicalJsonError(path, `unsupported ${typeof value}`)
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, '', new Set())
}
