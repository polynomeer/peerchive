import type { ApiErrorData, AssignableRole, ProjectRole } from '~~/shared/types/api'

export interface ApiError {
  status: number
  code: string
  fields: Record<string, string>
}

/** $fetch 오류를 상태 코드·이유 코드·필드별 코드로 풉니다. */
export function apiError(error: unknown): ApiError {
  const e = error as { statusCode?: number; status?: number; data?: { data?: ApiErrorData } }
  const data = e?.data?.data
  return { status: e?.statusCode ?? e?.status ?? 0, code: data?.code ?? 'unknown', fields: data?.fields ?? {} }
}

const FIELD_MESSAGES: Record<string, string> = {
  required: '필수 항목입니다.',
  too_short: '너무 짧습니다.',
  too_long: '너무 깁니다.',
  too_many: '항목이 너무 많습니다.',
  invalid_format: '형식이 올바르지 않습니다.',
  reserved: '사용할 수 없는 이름입니다.',
  taken: '이미 사용 중입니다.',
  not_found: '찾을 수 없습니다.',
  self: '자기 자신은 선택할 수 없습니다.',
  not_active_member: '현재 멤버가 아닙니다.',
  invalid: '값이 올바르지 않습니다.',
}

export function fieldMessage(code: string | undefined): string | undefined {
  return code ? (FIELD_MESSAGES[code] ?? FIELD_MESSAGES.invalid) : undefined
}

export const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: '운영 책임자(owner)',
  editor: '편집자(editor)',
  reviewer: '리뷰어(reviewer)',
  viewer: '열람자(viewer)',
}

export const ASSIGNABLE_ROLES: AssignableRole[] = ['editor', 'reviewer', 'viewer']
