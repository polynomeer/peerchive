<script setup lang="ts">
/**
 * 과제 공간의 할 일(T-07, PROOFU_EVOLUTION_PLAN §6.6): 원본 ProofU Board/List/Card를 잇는 리스트 보기.
 *
 * - 상태별(할 일 → 진행 중 → 완료) 묶음 목록. 상태는 메뉴(select)로, 순서는 ▲▼ 버튼으로 바꿉니다(드래그 없음, 시나리오 H).
 *   순서 변경은 그 상태 목록 전체 순서를 보내고(서버는 전체 순열만 받음), 실패하면 최신 목록을 다시 불러옵니다.
 * - 완료로 바꾸면 `/complete`를 부르고, 응답에 프롬프트가 있으면 그 할 일 아래에 "막힌 적 있었나요? 결정할 게 있었나요?"를
 *   한 번 띄웁니다(TaskPrompt). 남기지 않고 닫아도 완료는 그대로입니다. 남기면 빌드 로그 타임라인을 다시 불러옵니다.
 * - 빠른 추가는 제목만으로 됩니다(담당자·마감일은 선택). 관리 버튼과 폼은 owner/editor에게만 보입니다.
 * - 보드 보기(E-09, ADR 0053): 리스트 ↔ 보드 전환(이 기기에 기억, localStorage). 보드의 드래그·키보드·버튼 이동은
 *   `planTaskMove`로 같은 요청 하나가 됩니다: 같은 열은 위의 순서 변경, 다른 열은 상태 변경 + `position`, 완료 열은 `/complete`
 *   (프롬프트 그대로). 열 사이 이동 뒤에는 다른 할 일의 순서도 바뀌므로 목록을 다시 불러옵니다.
 * - 성공 안내는 늘 DOM에 있는 role=status에, 오류는 role=alert에 둡니다(보드 이동 결과를 화면 낭독기가 읽음).
 */
import { type TaskColumns, type TaskMoveTarget, planTaskMove } from '@peerchive/domain'
import type { MemberDto, TaskCompleteDto, TaskConvertDto, TaskDto, TaskStatus } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; canWrite: boolean; members: MemberDto[]; retro?: boolean }>()

const items = ref<TaskDto[]>([])
const loaded = ref(false)
const loadError = ref(false)
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const say = (kind: 'ok' | 'error', text: string) => (notice.value = { kind, text })
const groups = computed(() => groupTasks(items.value))
const openCount = computed(() => groups.value.todo.length + groups.value.doing.length)
const logsChanged = useLogsChanged(props.projectId)

/** 완료 프롬프트를 띄운 할 일(한 번에 하나). */
const promptTaskId = ref<string | null>(null)

async function refresh() {
  try {
    items.value = await $fetch<TaskDto[]>(`/api/v1/projects/${props.projectId}/tasks`)
    loadError.value = false
  } catch {
    loadError.value = true
  } finally {
    loaded.value = true
  }
}

function replace(task: TaskDto) {
  const exists = items.value.some((item) => item.id === task.id)
  items.value = exists ? items.value.map((item) => (item.id === task.id ? task : item)) : [...items.value, task]
}

function focusTask(taskId: string, control: 'status' | 'up' | 'down' | 'title' | 'card') {
  void nextTick(() => document.getElementById(`task-${taskId}-${control}`)?.focus())
}

// ── 빠른 추가 ──
const form = reactive({ title: '', assigneeId: '', dueAt: '' })
const errors = ref<Record<string, string>>({})
const creating = ref(false)

async function create() {
  creating.value = true
  errors.value = {}
  try {
    const created = await $fetch<TaskDto>(`/api/v1/projects/${props.projectId}/tasks`, {
      method: 'POST',
      body: { title: form.title, assigneeId: form.assigneeId || null, dueAt: form.dueAt || null },
    })
    replace(created)
    // 담당자·마감일은 이어서 여러 개를 넣을 때가 많아 그대로 둡니다.
    form.title = ''
    say('ok', `‘${created.title}’을(를) 할 일에 추가했습니다.`)
    void nextTick(() => document.getElementById('new-task-title')?.focus())
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) errors.value = error.fields
    else say('error', taskErrorMessage(error.code, '추가하지 못했습니다. 다시 시도하세요.'))
    if (error.status === 409) await refresh()
  } finally {
    creating.value = false
  }
}

// ── 상태 변경·완료 ──
async function changeStatus(task: TaskDto, status: TaskStatus) {
  if (status === task.status || busy.value) return
  busy.value = true
  try {
    if (status === 'done') {
      const result = await $fetch<TaskCompleteDto>(`/api/v1/tasks/${task.id}/complete`, {
        method: 'POST',
        body: { expectedVersion: task.version },
      })
      replace(result.task)
      promptTaskId.value = result.prompt ? result.task.id : null
      say('ok', `‘${task.title}’을(를) 완료했습니다.`)
    } else {
      const updated = await $fetch<TaskDto>(`/api/v1/tasks/${task.id}`, {
        method: 'PATCH',
        body: { expectedVersion: task.version, status },
      })
      replace(updated)
      if (promptTaskId.value === task.id) promptTaskId.value = null
      say('ok', `‘${task.title}’을(를) ${TASK_STATUS_LABELS[status]}(으)로 옮겼습니다.`)
      focusTask(task.id, 'status')
    }
  } catch (e) {
    const error = apiError(e)
    say('error', taskErrorMessage(error.code, '상태를 바꾸지 못했습니다. 다시 시도하세요.'))
    await refresh()
  } finally {
    busy.value = false
  }
}

function onConverted(result: TaskConvertDto) {
  replace(result.task)
  promptTaskId.value = null
  say('ok', `‘${result.task.title}’을(를) ${LOG_TAG_LABELS[result.log.tag]} 로그로 남겼습니다.`)
  logsChanged.notify()
  focusTask(result.task.id, view.value === 'board' ? 'card' : 'status')
}

function dismissPrompt(task: TaskDto) {
  promptTaskId.value = null
  focusTask(task.id, view.value === 'board' ? 'card' : 'status')
}

// ── 순서 변경 ──
async function move(task: TaskDto, index: number, delta: -1 | 1) {
  const group = groups.value[task.status]
  const ids = moveId(
    group.map((t) => t.id),
    index,
    delta,
  )
  if (!ids || busy.value) return
  busy.value = true
  try {
    items.value = await $fetch<TaskDto[]>(`/api/v1/projects/${props.projectId}/tasks/order`, {
      method: 'PUT',
      body: { status: task.status, taskIds: ids },
    })
    const moved = items.value.find((t) => t.id === task.id)
    say('ok', `‘${task.title}’을(를) ${TASK_STATUS_LABELS[task.status]} ${moved?.position ?? index + 1 + delta}번째로 옮겼습니다.`)
  } catch (e) {
    const error = apiError(e)
    say('error', error.status === 422 ? '그 사이 목록이 바뀌었습니다. 최신 목록을 확인한 뒤 다시 시도하세요.' : '순서를 바꾸지 못했습니다. 다시 시도하세요.')
    await refresh()
  } finally {
    busy.value = false
  }
  // 옮긴 할 일의 같은 방향 버튼(끝에 닿았으면 반대 방향)에 포커스를 둡니다.
  const list = groups.value[task.status]
  const at = list.findIndex((t) => t.id === task.id)
  const edge = delta === -1 ? at === 0 : at === list.length - 1
  focusTask(task.id, (delta === -1) !== edge ? 'up' : 'down')
}

// ── 보기 전환(E-09) ──
type TaskView = 'list' | 'board'
const VIEW_KEY = 'peerchive:tasks-view'
const view = ref<TaskView>('list')
function setView(next: TaskView) {
  view.value = next
  try {
    localStorage.setItem(VIEW_KEY, next)
  } catch {
    // 저장할 수 없으면 이번 화면에서만 바꿉니다.
  }
}
onMounted(() => {
  try {
    if (localStorage.getItem(VIEW_KEY) === 'board') view.value = 'board'
  } catch {
    view.value = 'list'
  }
})

// ── 보드 이동(E-09) ──
const columns = computed<TaskColumns>(() => ({
  todo: groups.value.todo.map((t) => t.id),
  doing: groups.value.doing.map((t) => t.id),
  done: groups.value.done.map((t) => t.id),
}))
const promptTask = computed(() => items.value.find((t) => t.id === promptTaskId.value) ?? null)

async function moveOnBoard(taskId: string, target: TaskMoveTarget) {
  const task = items.value.find((t) => t.id === taskId)
  if (!task || busy.value || !props.canWrite) return
  const plan = planTaskMove(columns.value, taskId, target)
  if (plan.kind === 'none') return
  busy.value = true
  let refocus = true
  try {
    if (plan.kind === 'reorder') {
      items.value = await $fetch<TaskDto[]>(`/api/v1/projects/${props.projectId}/tasks/order`, {
        method: 'PUT',
        body: { status: plan.status, taskIds: plan.taskIds },
      })
    } else if (plan.status === 'done') {
      const result = await $fetch<TaskCompleteDto>(`/api/v1/tasks/${task.id}/complete`, {
        method: 'POST',
        body: { expectedVersion: task.version, position: plan.position },
      })
      replace(result.task)
      promptTaskId.value = result.prompt ? result.task.id : null
      // 프롬프트가 열리면 포커스는 프롬프트 질문으로 갑니다(TaskPrompt).
      refocus = !result.prompt
      await refresh()
    } else {
      const updated = await $fetch<TaskDto>(`/api/v1/tasks/${task.id}`, {
        method: 'PATCH',
        body: { expectedVersion: task.version, status: plan.status, position: plan.position },
      })
      replace(updated)
      if (promptTaskId.value === task.id) promptTaskId.value = null
      await refresh()
    }
    const moved = items.value.find((t) => t.id === task.id)
    const status = moved?.status ?? plan.status
    const place = moved ? groups.value[status].findIndex((t) => t.id === task.id) + 1 : 0
    say('ok', `‘${task.title}’을(를) ${TASK_STATUS_LABELS[status]} 열 ${place}번째로 옮겼습니다.${status === 'done' && plan.kind === 'status' ? ' 완료했습니다.' : ''}`)
  } catch (e) {
    const error = apiError(e)
    say(
      'error',
      error.status === 422 && plan.kind === 'reorder'
        ? '그 사이 목록이 바뀌었습니다. 최신 목록을 확인한 뒤 다시 시도하세요.'
        : taskErrorMessage(error.code, '옮기지 못했습니다. 다시 시도하세요.'),
    )
    await refresh()
  } finally {
    busy.value = false
  }
  if (refocus) focusTask(task.id, 'card')
}

// ── 삭제 ──
async function remove(task: TaskDto) {
  if (!confirm(`‘${task.title}’을(를) 삭제할까요?`)) return
  try {
    await $fetch(`/api/v1/tasks/${task.id}`, { method: 'DELETE' })
    items.value = items.value.filter((t) => t.id !== task.id)
    if (promptTaskId.value === task.id) promptTaskId.value = null
    say('ok', `‘${task.title}’을(를) 삭제했습니다.`)
  } catch (e) {
    say('error', taskErrorMessage(apiError(e).code, '삭제하지 못했습니다. 다시 시도하세요.'))
  }
  await refresh()
}

onMounted(refresh)
</script>

<template>
  <section class="card" aria-labelledby="tasks-heading">
    <h2 id="tasks-heading">할 일</h2>
    <p class="hint">
      담당자·마감·상태를 가진 가벼운 할 일 목록입니다. 완료할 때 막힘이나 결정이 있었는지 한 번 묻고, 원하면 빌드 로그로 남깁니다.
    </p>

    <!-- 성공 안내 영역은 늘 DOM에 두어(비어 있으면 숨김) 바뀔 때마다 화면 낭독기가 읽게 합니다. -->
    <p :class="notice?.kind === 'ok' ? 'notice ok' : 'visually-hidden'" role="status">{{ notice?.kind === 'ok' ? notice.text : '' }}</p>
    <p v-if="notice?.kind === 'error'" class="notice error" role="alert">{{ notice.text }}</p>
    <p v-if="loadError" class="notice error" role="alert">
      할 일을 불러오지 못했습니다. <button type="button" class="link-button" @click="refresh">다시 시도</button>
    </p>

    <form v-if="canWrite" class="task-quick-add" novalidate aria-label="할 일 빠른 추가" @submit.prevent="create">
      <div class="field task-quick-title">
        <label for="new-task-title">새 할 일 (120자 이내)</label>
        <input
          id="new-task-title"
          v-model="form.title"
          maxlength="120"
          placeholder="예: 로그인 화면 와이어프레임"
          :aria-invalid="errors.title ? 'true' : undefined"
          :aria-describedby="errors.title ? 'new-task-title-error' : undefined"
        />
        <p v-if="errors.title" id="new-task-title-error" class="field-error">{{ fieldMessage(errors.title) }}</p>
      </div>
      <div class="field">
        <label for="new-task-assignee">담당자 (선택)</label>
        <select id="new-task-assignee" v-model="form.assigneeId" :aria-invalid="errors.assigneeId ? 'true' : undefined" :aria-describedby="errors.assigneeId ? 'new-task-assignee-error' : undefined">
          <option value="">담당 없음</option>
          <option v-for="m in members" :key="m.userId" :value="m.userId">{{ m.displayName || m.handle || '이름 미설정' }}</option>
        </select>
        <p v-if="errors.assigneeId" id="new-task-assignee-error" class="field-error">{{ fieldMessage(errors.assigneeId) }}</p>
      </div>
      <div class="field">
        <label for="new-task-due">마감일 (선택)</label>
        <input id="new-task-due" v-model="form.dueAt" type="date" :aria-invalid="errors.dueAt ? 'true' : undefined" :aria-describedby="errors.dueAt ? 'new-task-due-error' : undefined" />
        <p v-if="errors.dueAt" id="new-task-due-error" class="field-error">{{ fieldMessage(errors.dueAt) }}</p>
      </div>
      <div class="actions">
        <button type="submit" :disabled="creating || openCount >= OPEN_TASK_MAX">{{ creating ? '추가 중…' : '추가' }}</button>
      </div>
    </form>
    <p v-else class="hint">이 과제의 할 일을 볼 수 있지만 바꿀 수는 없습니다(편집자 이상만 관리).</p>

    <p v-if="loaded && items.length === 0 && !loadError" class="muted">아직 할 일이 없습니다.</p>

    <div v-if="items.length" class="actions task-view-toggle" role="group" aria-label="할 일 보기 방식">
      <button type="button" class="secondary small" :aria-pressed="view === 'list' ? 'true' : 'false'" @click="setView('list')">리스트 보기</button>
      <button type="button" class="secondary small" :aria-pressed="view === 'board' ? 'true' : 'false'" @click="setView('board')">보드 보기</button>
    </div>

    <template v-if="view === 'board' && items.length">
      <TaskBoard :groups="groups" :can-write="canWrite" :members="members" :busy="busy" @move="moveOnBoard" />
      <TaskPrompt
        v-if="canWrite && promptTask"
        :key="promptTask.id"
        :task="promptTask"
        :project-id="projectId"
        :members="members"
        :retro="retro"
        @converted="onConverted"
        @dismiss="promptTask && dismissPrompt(promptTask)"
      />
    </template>

    <template v-else>
      <template v-for="status in TASK_STATUS_ORDER" :key="status">
        <div v-if="groups[status].length" class="task-group">
          <h3 :id="`tasks-${status}-heading`">{{ TASK_STATUS_LABELS[status] }} <span class="muted">({{ groups[status].length }})</span></h3>
          <ol class="plain task-list" :aria-labelledby="`tasks-${status}-heading`">
            <li v-for="(task, index) in groups[status]" :key="task.id">
              <TaskItem
                :task="task"
                :index="index"
                :total="groups[status].length"
                :can-write="canWrite"
                :members="members"
                :busy="busy"
                @move="move(task, index, $event)"
                @status="changeStatus(task, $event)"
                @remove="remove(task)"
                @updated="replace"
                @reload="refresh"
              />
              <TaskPrompt
                v-if="canWrite && promptTaskId === task.id"
                :task="task"
                :project-id="projectId"
                :members="members"
                :retro="retro"
                @converted="onConverted"
                @dismiss="dismissPrompt(task)"
              />
            </li>
          </ol>
        </div>
      </template>
    </template>
  </section>
</template>
