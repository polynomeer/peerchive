/**
 * 할 일 규칙 (PROOFU_EVOLUTION_PLAN §6.6, SYSTEM_DESIGN §2.2 Card → Task, §6.3 Task, T-07).
 *
 * - 2019 ProofU의 List/Card(Todo/Doing/Done, pos)를 가벼운 할 일 목록으로 이어받습니다. 할 일 완료 자체를
 *   학습 기록으로 보지 않고, 완료할 때 "막힌 적 있었나요? 결정할 게 있었나요?"를 한 번 묻고 응답하면 빌드 로그로 전환합니다.
 *   응답하지 않아도 완료됩니다.
 * - 관리(만들기·수정·상태 변경·순서 변경·삭제·완료·로그 전환)는 active owner/editor. reviewer/viewer는 읽기만 하며,
 *   관리자라는 사실만으로는 아무 권한도 생기지 않습니다(§8).
 * - 순서(position)는 프로젝트 안의 상태별 목록마다 1부터 빈틈없이 이어집니다. 상태를 바꾸면 새 상태 목록의 맨 뒤로 갑니다.
 * - 한 할 일은 빌드 로그로 한 번만 전환할 수 있습니다. 전환한 할 일은 지우지 않습니다(로그의 출처로 남김).
 */
import { type Membership, type ProjectRef, type Viewer, canReadProjectWorkspace } from './permissions'
import { checkMilestoneOrder } from './milestones'

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 프로젝트당 열린(할 일·진행 중) 할 일 최대 개수. */
export const OPEN_TASK_LIMIT = 200
/** 프로젝트당 할 일 전체(완료 포함) 최대 개수. 상태별 순서 변경 요청 길이의 상한이기도 합니다. */
export const TASK_LIMIT = 500

/** 완료 프롬프트로 전환할 수 있는 로그 태그: 🧱막힘·⚖️결정, 그리고 막힘·결정이 없었던 경우의 🔨진행. */
export const TASK_CONVERT_TAGS = ['stuck', 'decision', 'progress'] as const
export type TaskConvertTag = (typeof TASK_CONVERT_TAGS)[number]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)
}

/** 할 일 관리: active owner/editor. 관리자 우회 없음. */
export function canManageTasks(viewer: Viewer, project: ProjectRef, membership: Membership | null | undefined): boolean {
  return canReadProjectWorkspace(viewer, project, membership) && (membership!.role === 'owner' || membership!.role === 'editor')
}

/** 열린 상태(완료 전)인지. 한도 계산에 씁니다. */
export function isOpenTaskStatus(status: TaskStatus): boolean {
  return status !== 'done'
}

/**
 * 상태 변경 결과. 세 상태 사이는 어느 방향이든 바꿀 수 있습니다(완료를 되돌리는 것 포함).
 * - `same`: 바뀌지 않음(순서·완료 정보 그대로)
 * - `complete`: 완료로 바뀜 → completed_at/by를 채움
 * - `reopen`: 완료에서 다른 상태로 → completed_at/by를 비움(로그 전환 연결은 그대로 남음)
 * - `move`: 완료와 무관한 이동(할 일 ↔ 진행 중)
 * same이 아니면 새 상태 목록의 맨 뒤로 옮기고, 원래 목록은 빈틈을 당깁니다.
 */
export type StatusChange = 'same' | 'complete' | 'reopen' | 'move'

export function statusChange(from: TaskStatus, to: TaskStatus): StatusChange {
  if (from === to) return 'same'
  if (to === 'done') return 'complete'
  if (from === 'done') return 'reopen'
  return 'move'
}

/**
 * 열린 할 일 한도 확인이 필요한 변경인지: 새로 열린 상태가 되는 경우(만들기는 호출자가 따로 확인).
 * 완료를 되돌릴 때 한도가 차 있으면 거부합니다.
 */
export function opensTask(from: TaskStatus, to: TaskStatus): boolean {
  return !isOpenTaskStatus(from) && isOpenTaskStatus(to)
}

/**
 * 상태별 순서 변경 판정. 마일스톤과 같은 규칙입니다: 요청은 그 상태 목록에 지금 있는 id 전체의 순열이어야 하며,
 * 중복은 `duplicate`, 빠지거나 모르는 id(다른 상태·다른 프로젝트 포함)는 `mismatch`입니다.
 */
export const checkTaskOrder = checkMilestoneOrder

export type TaskConvertCheck = 'ok' | 'not_done' | 'already_converted'

/**
 * 빌드 로그 전환 가능 여부. 완료한 할 일만, 한 번만 전환합니다.
 * (이미 전환한 할 일을 되돌렸다 다시 완료해도 두 번째 전환은 할 수 없습니다.)
 */
export function checkTaskConvert(task: { status: TaskStatus; logEntryId: string | null }): TaskConvertCheck {
  if (task.logEntryId) return 'already_converted'
  if (task.status !== 'done') return 'not_done'
  return 'ok'
}

/** 삭제 가능 여부: 빌드 로그로 전환한 할 일은 그 로그의 출처이므로 지우지 않습니다. */
export function canDeleteTask(task: { logEntryId: string | null }): boolean {
  return task.logEntryId === null
}
