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
  too_few: '항목이 더 필요합니다.',
  unknown_key: '알 수 없는 항목이 있습니다.',
  invalid_url: 'http 또는 https 주소만 넣을 수 있습니다.',
  too_far_future: '수행일은 내일 이후로 정할 수 없습니다.',
  confirm_required: '확인란을 체크해야 저장할 수 있습니다.',
  not_member: '이 과제의 멤버가 아닌 사람이 있습니다.',
  not_stuck: '🧱 막힘 로그만 연결할 수 있습니다.',
  not_allowed: '이 태그에서는 쓸 수 없는 항목입니다.',
  immutable: '태그는 바꿀 수 없습니다.',
  no_changes: '바뀐 내용이 없습니다.',
  not_attachable: '격리되었거나 검사에 실패한 파일은 근거로 붙일 수 없습니다.',
  not_clean: '검사를 통과한(사용 가능) 파일만 스냅샷으로 지정할 수 있습니다.',
  metadata_not_stripped: '메타데이터(위치 정보 등)를 아직 지우지 않은 이전 이미지가 있습니다. 정리 작업 뒤 다시 시도하세요.',
  mismatch: '그 사이 마일스톤 목록이 바뀌었습니다. 최신 목록을 확인한 뒤 다시 시도하세요.',
  duplicate: '같은 항목이 두 번 들어 있습니다.',
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
