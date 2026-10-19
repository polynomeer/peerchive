/**
 * zod 스키마로 입력을 검증하고 실패하면 필드별 오류 코드(422)를 던집니다.
 * 스키마의 오류 메시지 자리에 사람이 읽는 문장 대신 짧은 코드('too_long' 등)를 둡니다.
 */
import type { z } from 'zod'
import { invalid } from './errors'

export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input ?? {})
  if (result.success) return result.data
  throw invalid(issuesToFields(result.error.issues))
}

/**
 * zod 오류를 `{ 'a.b.0': 'code' }` 형태로 바꿉니다. 경로마다 첫 오류만 남깁니다.
 * `prefix`를 주면 경로 앞에 붙입니다(예: 태그별 payload를 따로 검증할 때 'payload').
 */
export function issuesToFields(issues: readonly z.core.$ZodIssue[], prefix?: string): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const issue of issues) {
    const parts = [...(prefix ? [prefix] : []), ...issue.path.map(String)]
    const path = parts.length > 0 ? parts.join('.') : '_'
    if (fields[path]) continue
    // 커스텀 코드가 없는 기본 메시지(영문 문장)는 일반 코드로 바꿉니다.
    fields[path] = /^[a-z_]+$/.test(issue.message) ? issue.message : 'invalid'
  }
  return fields
}
