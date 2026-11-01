<script setup lang="ts">
/**
 * 할 일 보드 보기(E-09, PROOFU_EVOLUTION_PLAN §6.6, ADR 0053): 상태별 열(할 일 → 진행 중 → 완료)에 카드(제목·담당자·마감일).
 *
 * - 옮기는 방법은 세 가지이고 모두 같은 자리 계산(@peerchive/domain `dropTarget`·`boardStep` → `planTaskMove`)을 거쳐
 *   상위(TasksSection)가 같은 API 요청 하나를 보냅니다: 같은 열 안은 리스트 ▲▼와 같은 순서 변경(전체 순열),
 *   다른 열은 상태 변경 + 자리(`position`), 완료 열이면 `/complete`(완료 프롬프트 그대로).
 *   1. 드래그(브라우저 기본 HTML5 끌어 놓기, 새 의존성 없음): 카드를 다른 카드 위(그 카드 앞) 또는 열의 빈 곳(맨 끝)에 놓습니다.
 *   2. 키보드: 카드에 포커스를 두고 Shift + ←/→(옆 열, 같은 줄), Shift + ↑/↓(열 안 한 칸).
 *   3. 버튼: 카드의 "옮기기" 메뉴의 왼쪽 열로·오른쪽 열로·위로·아래로.
 * - 결과 안내는 상위의 상태 알림(role=status, 늘 DOM에 있음)으로 읽힙니다. 옮긴 뒤 포커스는 그 카드로 돌아옵니다.
 * - 관리 권한(owner/editor)이 없으면 끌기·메뉴·단축키가 없고 카드만 보입니다. 수정·삭제는 리스트 보기에서 합니다.
 * - 좁은 화면에서는 보드만 가로로 스크롤합니다(페이지 가로 스크롤 없음). 스크롤 영역은 키보드로도 포커스할 수 있습니다.
 */
import { type BoardDirection, type TaskColumns, type TaskMoveTarget, boardStep, dropTarget } from '@peerchive/domain'
import type { MemberDto, TaskDto, TaskStatus } from '~~/shared/types/api'

const props = defineProps<{
  groups: Record<TaskStatus, TaskDto[]>
  canWrite: boolean
  members: MemberDto[]
  /** 요청 중이면 옮기기를 잠시 막습니다. */
  busy: boolean
}>()
const emit = defineEmits<{ move: [taskId: string, target: TaskMoveTarget] }>()

const columns = computed<TaskColumns>(() => ({
  todo: props.groups.todo.map((t) => t.id),
  doing: props.groups.doing.map((t) => t.id),
  done: props.groups.done.map((t) => t.id),
}))

function assigneeLabel(task: TaskDto): string {
  const a = task.assignee
  if (!a) return '담당 없음'
  const current = props.members.find((m) => m.userId === a.userId)
  return `담당 ${current ? current.displayName || current.handle || '이름 미설정' : `${a.displayName || '이름 미설정'} (이전 멤버)`}`
}

// ── 버튼·키보드 ──
const menuFor = ref<string | null>(null)

function canStep(task: TaskDto, direction: BoardDirection): boolean {
  return boardStep(columns.value, task.id, direction) !== null
}

function step(task: TaskDto, direction: BoardDirection) {
  const target = boardStep(columns.value, task.id, direction)
  if (!target || props.busy) return
  menuFor.value = null
  emit('move', task.id, target)
}

const KEY_DIRECTIONS: Record<string, BoardDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }

function onCardKeydown(event: KeyboardEvent, task: TaskDto) {
  // 카드 자체에 포커스가 있을 때만(안의 버튼·링크 조작과 섞지 않음).
  if (event.target !== event.currentTarget || !props.canWrite) return
  const direction = KEY_DIRECTIONS[event.key]
  if (!direction || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
  event.preventDefault()
  step(task, direction)
}

function toggleMenu(task: TaskDto) {
  menuFor.value = menuFor.value === task.id ? null : task.id
}

function closeMenu(task: TaskDto) {
  menuFor.value = null
  void nextTick(() => document.getElementById(`task-${task.id}-menu`)?.focus())
}

// ── 드래그 ──
const dragging = ref<string | null>(null)
const over = ref<{ status: TaskStatus; beforeId: string | null } | null>(null)

function onDragStart(event: DragEvent, task: TaskDto) {
  if (!props.canWrite || props.busy) {
    event.preventDefault()
    return
  }
  dragging.value = task.id
  menuFor.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', task.id)
  }
}

/** 포인터 높이로 그 열에서 바로 뒤에 올 카드(옮기는 카드는 빼고, 카드 가운데보다 위면 그 카드 앞). */
function beforeIdAt(list: HTMLElement, clientY: number): string | null {
  for (const el of list.querySelectorAll<HTMLElement>('[data-task-id]')) {
    if (el.dataset.taskId === dragging.value) continue
    const rect = el.getBoundingClientRect()
    if (clientY < rect.top + rect.height / 2) return el.dataset.taskId ?? null
  }
  return null
}

function onDragOver(event: DragEvent, status: TaskStatus) {
  if (!dragging.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const list = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.task-board-cards')
  over.value = { status, beforeId: list ? beforeIdAt(list, event.clientY) : null }
}

function onDragLeave(event: DragEvent, status: TaskStatus) {
  const next = event.relatedTarget as Node | null
  if (next && (event.currentTarget as HTMLElement).contains(next)) return
  if (over.value?.status === status) over.value = null
}

function onDrop(event: DragEvent, status: TaskStatus) {
  const taskId = dragging.value
  if (!taskId) return
  event.preventDefault()
  const list = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.task-board-cards')
  const beforeId = list ? beforeIdAt(list, event.clientY) : null
  dragging.value = null
  over.value = null
  emit('move', taskId, dropTarget(columns.value, taskId, status, beforeId))
}

function onDragEnd() {
  dragging.value = null
  over.value = null
}
</script>

<template>
  <div>
    <p v-if="canWrite" id="task-board-help" class="hint">
      카드를 끌어 다른 열이나 다른 카드 앞에 놓을 수 있습니다. 끌지 않아도 됩니다: 카드에 포커스를 두고 Shift + ←/→로 옆 열,
      Shift + ↑/↓로 열 안 순서를 바꾸거나, 카드의 "옮기기" 메뉴를 쓰세요. 결과는 같습니다. 수정·삭제는 리스트 보기에서 합니다.
    </p>
    <div class="task-board" role="region" aria-label="할 일 보드 (상태별 열)" tabindex="0">
      <section
        v-for="status in TASK_STATUS_ORDER"
        :key="status"
        :class="['task-board-column', { 'drop-target': over?.status === status }]"
        :aria-labelledby="`board-${status}-heading`"
        @dragover="onDragOver($event, status)"
        @dragleave="onDragLeave($event, status)"
        @drop="onDrop($event, status)"
      >
        <h3 :id="`board-${status}-heading`">
          {{ TASK_STATUS_LABELS[status] }} <span class="muted">({{ groups[status].length }})</span>
        </h3>
        <ol class="plain task-board-cards" :aria-labelledby="`board-${status}-heading`">
          <li
            v-for="task in groups[status]"
            :key="task.id"
            :data-task-id="task.id"
            :class="{ 'drop-before': over?.status === status && over.beforeId === task.id, dragging: dragging === task.id }"
          >
            <article
              :id="`task-${task.id}-card`"
              class="task-card"
              :aria-labelledby="`task-${task.id}-card-title`"
              :aria-describedby="canWrite ? 'task-board-help' : undefined"
              :tabindex="canWrite ? 0 : undefined"
              :draggable="canWrite && !busy ? 'true' : undefined"
              @keydown="onCardKeydown($event, task)"
              @dragstart="onDragStart($event, task)"
              @dragend="onDragEnd"
            >
              <h4 :id="`task-${task.id}-card-title`" class="task-title">{{ task.title }}</h4>
              <p class="muted small task-card-meta">
                <span class="visually-hidden">{{ TASK_STATUS_LABELS[task.status] }} 열 {{ groups[status].indexOf(task) + 1 }}번째 · </span>
                {{ assigneeLabel(task) }}
                <template v-if="task.dueAt">
                  · 마감 <time :datetime="task.dueAt">{{ formatDay(task.dueAt) }}</time>
                </template>
                <span v-if="isOverdue(task)" class="badge overdue">마감 지남</span>
              </p>
              <p v-if="task.log" class="relation small">
                ↳ <a :href="`#log-${task.log.id}`">빌드 로그로 남김</a> ({{ LOG_TAG_LABELS[task.log.tag] }})
              </p>
              <div v-if="canWrite" class="task-card-actions">
                <button
                  :id="`task-${task.id}-menu`"
                  type="button"
                  class="secondary small"
                  :aria-expanded="menuFor === task.id ? 'true' : 'false'"
                  :aria-controls="`task-${task.id}-moves`"
                  :aria-label="`${task.title} 옮기기`"
                  @click="toggleMenu(task)"
                >
                  옮기기
                </button>
                <div
                  v-if="menuFor === task.id"
                  :id="`task-${task.id}-moves`"
                  class="task-card-moves"
                  role="group"
                  :aria-label="`${task.title} 옮기기`"
                  @keydown.esc.prevent="closeMenu(task)"
                >
                  <button type="button" class="secondary small" :disabled="busy || !canStep(task, 'left')" @click="step(task, 'left')">← 왼쪽 열로</button>
                  <button type="button" class="secondary small" :disabled="busy || !canStep(task, 'right')" @click="step(task, 'right')">오른쪽 열로 →</button>
                  <button type="button" class="secondary small" :disabled="busy || !canStep(task, 'up')" @click="step(task, 'up')">↑ 위로</button>
                  <button type="button" class="secondary small" :disabled="busy || !canStep(task, 'down')" @click="step(task, 'down')">↓ 아래로</button>
                </div>
              </div>
            </article>
          </li>
        </ol>
        <p v-if="groups[status].length === 0" class="muted small task-board-empty">비어 있음{{ canWrite ? ' — 여기에 놓을 수 있습니다' : '' }}</p>
      </section>
    </div>
  </div>
</template>
