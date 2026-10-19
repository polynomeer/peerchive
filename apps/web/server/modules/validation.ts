/**
 * zod 스키마로 입력을 검증하고 실패하면 필드별 오류 코드(422)를 던집니다.
 * 스키마의 오류 메시지 자리에 사람이 읽는 문장 대신 짧은 코드('too_long' 등)를 둡니다.
 */
import type { z } from 'zod'
import { invalid } from './errors'

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {})
  if (result.success) return result.data
  const fields: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '_'
    if (fields[path]) continue
    // 커스텀 코드가 없는 기본 메시지(영문 문장)는 일반 코드로 바꿉니다.
    fields[path] = /^[a-z_]+$/.test(issue.message) ? issue.message : 'invalid'
  }
  throw invalid(fields)
}
