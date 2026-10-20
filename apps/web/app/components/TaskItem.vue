<script setup lang="ts">
/**
 * 할 일 한 건(T-07): 제목·담당자·마감일·상태(텍스트)·빌드 로그 연결, 상태 변경 메뉴(select)·순서 이동(▲▼)·수정·삭제.
 * 드래그 없이 키보드로 모두 조작합니다(시나리오 H). 상태 변경·순서 이동·삭제는 목록 전체가 바뀌므로 상위(TasksSection)가 처리하고,
 * 여기서는 제목·메모·담당자·마감일 수정만 직접 보냅니다(expectedVersion, 409면 목록을 다시 불러옴).
 */
import type { MemberDto, TaskDto, TaskStatus } from '~~/shared/types/api'

const props = defineProps<{
  task: TaskDto
  index: number
  total: number
  canWrite: boolean
  members: MemberDto[]
  /** 순서·상태 변경 요청 중이면 버튼을 잠시 막습니다. */
  busy: boolean
}>()
const emit = defineEmits<{
  move: [delta: -1 | 1]
  status: [status: TaskStatus]
  remove: []
  updated: [task: TaskDto]
  reload: []
}>()

const base = computed(() => `task-${props.task.id}`)
const overdue = computed(() => isOverdue(props.task))
const assigneeName = computed(() => {
  const a = props.task.assignee
  if (!a) return null
  const current = props.members.find((m) => m.userId === a.userId)
  return current ? current.displayName || current.handle || '이름 미설정' : `${a.displayName || '이름 미설정'} (이전 멤버)`
})

// ── 수정 ──
const editing = ref(false)
const form = reactive({ title: '', note: '', assigneeId: '', dueAt: '' })
const errors = ref<Record<string, string>>({})
const status = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const saving = ref(false)

function startEdit() {
  Object.assign(form, {
    title: props.task.title,
    note: props.task.note ?? '',
    assigneeId: props.task.assignee?.userId ?? '',
    dueAt: props.task.dueAt ?? '',
  })
  errors.value = {}
  status.value = null
  editing.value = true
}

async function saveEdit() {
  saving.value = true
  errors.value = {}
  status.value = null
  try {
    const updated = await $fetch<TaskDto>(`/api/v1/tasks/${props.task.id}`, {
      method: 'PATCH',
      body: {
        expectedVersion: props.task.version,
        title: form.title,
        note: form.note || null,
        assigneeId: form.assigneeId || null,
        dueAt: form.dueAt || null,
      },
    })
    editing.value = false
    emit('updated', updated)
    status.value = { kind: 'ok', text: '저장했습니다.' }
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) {
      errors.value = error.fields
      status.value = { kind: 'error', text: '입력을 확인하세요.' }
    } else if (error.status === 409) {
      // 입력은 남겨 두고 목록을 다시 불러옵니다. 다시 저장하면 최신 version 위에 저장됩니다.
      emit('reload')
      status.value = { kind: 'error', text: taskErrorMessage('version_conflict', '') }
    } else {
      status.value = { kind: 'error', text: '저장하지 못했습니다. 입력은 남아 있습니다. 다시 시도하세요.' }
    }
  } finally {
    saving.value = false
  }
}

// 지금 담당자가 나간 멤버라면 선택지에 남겨 둡니다(그대로 저장할 수 있게).
const assigneeChoices = computed(() => {
  const a = props.task.assignee
  const list = props.members.map((m) => ({ userId: m.userId, label: m.displayName || m.handle || '이름 미설정' }))
  if (a && !list.some((m) => m.userId === a.userId)) list.push({ userId: a.userId, label: `${a.displayName || '이름 미설정'} (이전 멤버)` })
  return list
})
</script>

<template>
  <article class="task-item" :aria-labelledby="`${base}-title`">
    <div class="task-main">
      <h4 :id="`${base}-title`" class="task-title">{{ task.title }}</h4>
      <span class="muted small">
        <span class="visually-hidden">상태: </span>{{ TASK_STATUS_LABELS[task.status] }}
        · {{ assigneeName ? `담당 ${assigneeName}` : '담당 없음' }}
        <template v-if="task.dueAt">
          · 마감 <time :datetime="task.dueAt">{{ formatDay(task.dueAt) }}</time>
        </template>
      </span>
      <span v-if="overdue" class="badge overdue">마감 지남</span>
    </div>
    <p v-if="task.note" class="pre small">{{ task.note }}</p>
    <p v-if="task.log" class="relation small">
      ↳ <a :href="`#log-${task.log.id}`">빌드 로그로 남김</a> ({{ LOG_TAG_LABELS[task.log.tag] }})
    </p>

    <div v-if="canWrite" class="actions task-controls">
      <label :for="`${base}-status`" class="visually-hidden">{{ task.title }} 상태</label>
      <select
        :id="`${base}-status`"
        class="task-status"
        :value="task.status"
        :disabled="busy"
        @change="emit('status', ($event.target as HTMLSelectElement).value as TaskStatus)"
      >
        <option v-for="s in TASK_STATUS_ORDER" :key="s" :value="s">{{ TASK_STATUS_LABELS[s] }}</option>
      </select>
      <button
        :id="`${base}-up`"
        type="button"
        class="secondary icon-button"
        :disabled="index === 0 || busy"
        :aria-label="`${task.title} 위로 이동`"
        @click="emit('move', -1)"
      >
        ▲
      </button>
      <button
        :id="`${base}-down`"
        type="button"
        class="secondary icon-button"
        :disabled="index === total - 1 || busy"
        :aria-label="`${task.title} 아래로 이동`"
        @click="emit('move', 1)"
      >
        ▼
      </button>
      <button v-if="!editing" type="button" class="secondary" :aria-label="`${task.title} 수정`" @click="startEdit">수정</button>
      <button v-if="!task.log" type="button" class="danger" :aria-label="`${task.title} 삭제`" @click="emit('remove')">삭제</button>
    </div>

    <p v-if="status" :class="['notice', status.kind]" :role="status.kind === 'error' ? 'alert' : 'status'">{{ status.text }}</p>

    <form v-if="editing" class="stack edit-form" novalidate :aria-label="`${task.title} 수정`" @submit.prevent="saveEdit">
      <div class="field">
        <label :for="`${base}-edit-title`">제목 (필수, 120자 이내)</label>
        <input :id="`${base}-edit-title`" v-model="form.title" maxlength="120" :aria-invalid="errors.title ? 'true' : undefined" :aria-describedby="errors.title ? `${base}-edit-title-error` : undefined" />
        <p v-if="errors.title" :id="`${base}-edit-title-error`" class="field-error">{{ fieldMessage(errors.title) }}</p>
      </div>
      <div class="field">
        <label :for="`${base}-edit-assignee`">담당자 (선택)</label>
        <select :id="`${base}-edit-assignee`" v-model="form.assigneeId" :aria-invalid="errors.assigneeId ? 'true' : undefined" :aria-describedby="errors.assigneeId ? `${base}-edit-assignee-error` : undefined">
          <option value="">담당 없음</option>
          <option v-for="m in assigneeChoices" :key="m.userId" :value="m.userId">{{ m.label }}</option>
        </select>
        <p v-if="errors.assigneeId" :id="`${base}-edit-assignee-error`" class="field-error">{{ fieldMessage(errors.assigneeId) }}</p>
      </div>
      <div class="field">
        <label :for="`${base}-edit-due`">마감일 (선택)</label>
        <input :id="`${base}-edit-due`" v-model="form.dueAt" type="date" :aria-invalid="errors.dueAt ? 'true' : undefined" :aria-describedby="errors.dueAt ? `${base}-edit-due-error` : undefined" />
        <p v-if="errors.dueAt" :id="`${base}-edit-due-error`" class="field-error">{{ fieldMessage(errors.dueAt) }}</p>
      </div>
      <div class="field">
        <label :for="`${base}-edit-note`">메모 (선택, 1000자 이내)</label>
        <textarea :id="`${base}-edit-note`" v-model="form.note" maxlength="1000" :aria-invalid="errors.note ? 'true' : undefined" />
        <p v-if="errors.note" class="field-error">{{ fieldMessage(errors.note) }}</p>
      </div>
      <div class="actions">
        <button type="submit" :disabled="saving">{{ saving ? '저장 중…' : '저장' }}</button>
        <button type="button" class="secondary" @click="editing = false">취소</button>
      </div>
    </form>
  </article>
</template>
