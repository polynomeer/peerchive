/**
 * 할 일 화면 도우미(T-07): 상태 표시, 마감 표시, 오류 안내, 완료 프롬프트에서 여는 로그 폼.
 * 상태는 색이 아니라 텍스트로 보여 줍니다(시나리오 H).
 */
import type { LogTag, TaskDto, TaskStatus } from '~~/shared/types/api'
import { type LogForm, emptyLogForm } from './build-log'

/** 서버 한도와 같은 값(@peerchive/domain). 화면 안내용이며 최종 판정은 서버가 합니다. */
export const OPEN_TASK_MAX = 200

export const TASK_STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'done']

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '할 일',
  doing: '진행 중',
  done: '완료',
}

/** 완료 프롬프트에서 고르는 태그(서버의 TASK_CONVERT_TAGS 중 화면 버튼으로 내놓는 것). */
export type PromptTag = Extract<LogTag, 'stuck' | 'decision'>

/** 상태별로 묶은 목록(서버가 상태·순서대로 주지만, 한 건씩 바꿔 끼운 뒤에도 순서를 맞춥니다). */
export function groupTasks(items: TaskDto[]): Record<TaskStatus, TaskDto[]> {
  const groups: Record<TaskStatus, TaskDto[]> = { todo: [], doing: [], done: [] }
  for (const task of items) groups[task.status].push(task)
  for (const status of TASK_STATUS_ORDER) groups[status].sort((a, b) => a.position - b.position)
  return groups
}

/** 오늘(로컬 날짜) 기준 마감이 지났는지. 완료한 할 일은 지나도 표시하지 않습니다. */
export function isOverdue(task: Pick<TaskDto, 'dueAt' | 'status'>, today = new Date()): boolean {
  if (!task.dueAt || task.status === 'done') return false
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return task.dueAt < local
}

const TASK_ERRORS: Record<string, string> = {
  limit_reached: `열린 할 일은 과제마다 ${OPEN_TASK_MAX}개까지입니다. 끝난 일을 완료로 옮기세요.`,
  version_conflict: '다른 멤버가 먼저 바꿨습니다. 최신 목록을 불러왔으니 확인한 뒤 다시 시도하세요.',
  converted: '빌드 로그로 남긴 할 일은 그 로그의 출처라 지울 수 없습니다.',
  already_converted: '이미 빌드 로그로 남긴 할 일입니다.',
  not_done: '완료한 할 일만 빌드 로그로 남길 수 있습니다.',
}

/** 409 등 이유 코드 → 안내 문구. */
export function taskErrorMessage(code: string, fallback: string): string {
  return TASK_ERRORS[code] ?? fallback
}

/** 완료 프롬프트에서 고른 태그로 로그 폼을 채웁니다: 할 일 제목을 본문으로(막힘이면 증상 칸에도). */
export function promptLogForm(tag: PromptTag, task: Pick<TaskDto, 'title'>): LogForm {
  const form = emptyLogForm(tag)
  form.body = task.title
  if (tag === 'stuck') form.symptom = task.title
  return form
}
