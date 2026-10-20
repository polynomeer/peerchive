<script setup lang="ts">
/**
 * 할 일 완료 프롬프트(T-07, PROOFU_EVOLUTION_PLAN §6.6): "막힌 적 있었나요? 결정할 게 있었나요?"를 한 번 묻습니다.
 *
 * - [🧱 막힘으로 남기기] [⚖️ 결정으로 남기기]를 고르면 빌드 로그 입력 필드(LogFields)를 할 일 제목으로 채워 열고,
 *   `/tasks/:id/convert`로 저장합니다(빌드 로그 검증 규칙 그대로, 422면 필드 오류 표시·입력 유지).
 * - [그냥 완료]나 ✕로 닫아도 완료는 이미 끝났습니다. 응답을 강요하지 않습니다.
 * - 열릴 때 질문에 포커스를 옮겨 키보드·화면 낭독기 사용자도 바로 고를 수 있게 합니다.
 */
import type { LogDto, MemberDto, TaskConvertDto, TaskDto } from '~~/shared/types/api'
import type { PromptTag } from '~/utils/tasks'

const props = defineProps<{ task: TaskDto; projectId: string; members: MemberDto[]; retro?: boolean }>()
const emit = defineEmits<{ converted: [result: TaskConvertDto]; dismiss: [] }>()

const base = computed(() => `task-prompt-${props.task.id}`)
const artifacts = useProjectArtifacts(props.projectId)
const evidenceChoices = computed(() => evidenceOptions(artifacts.items.value))
const milestones = useProjectMilestones(props.projectId)
const noStuckLogs: LogDto[] = []

const tag = ref<PromptTag | null>(null)
const form = reactive(emptyLogForm())
const errors = ref<Record<string, string>>({})
const saving = ref(false)
const failure = ref<string | null>(null)

function choose(next: PromptTag) {
  tag.value = next
  Object.assign(form, promptLogForm(next, props.task))
  errors.value = {}
  failure.value = null
  if (!artifacts.loaded.value) void artifacts.refresh()
  if (!milestones.loaded.value) void milestones.refresh()
  void nextTick(() => document.getElementById(`${base.value}-composer`)?.focus())
}

async function submit() {
  if (!tag.value || saving.value) return
  saving.value = true
  errors.value = {}
  failure.value = null
  try {
    const result = await $fetch<TaskConvertDto>(`/api/v1/tasks/${props.task.id}/convert`, {
      method: 'POST',
      body: { tag: form.tag, ...formRequest(form) },
    })
    emit('converted', result)
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) {
      errors.value = formFieldErrors(error.fields)
      failure.value = '입력을 확인하세요. 내용은 그대로 남아 있습니다.'
    } else if (error.status === 409) {
      failure.value = taskErrorMessage(error.code, '이미 처리된 할 일입니다.')
    } else {
      failure.value = '저장하지 못했습니다. 내용은 그대로 남아 있습니다. 다시 시도하세요.'
    }
  } finally {
    saving.value = false
  }
}

onMounted(() => document.getElementById(`${base.value}-question`)?.focus())
</script>

<template>
  <section class="task-prompt" :aria-labelledby="`${base}-question`">
    <div class="task-prompt-head">
      <p :id="`${base}-question`" class="task-prompt-question" tabindex="-1">
        ‘{{ task.title }}’ 완료! 막힌 적 있었나요? 결정할 게 있었나요?
      </p>
      <button type="button" class="link-button" aria-label="질문 닫기(그냥 완료)" @click="emit('dismiss')">✕</button>
    </div>

    <div v-if="!tag" class="actions">
      <button type="button" class="secondary" @click="choose('stuck')">🧱 막힘으로 남기기</button>
      <button type="button" class="secondary" @click="choose('decision')">⚖️ 결정으로 남기기</button>
      <button type="button" class="secondary" @click="emit('dismiss')">그냥 완료</button>
    </div>
    <p v-if="!tag" class="hint">남기면 빌드 로그에 이 할 일과 연결되어 기록됩니다. 남기지 않아도 완료는 그대로입니다.</p>

    <form
      v-else
      :id="`${base}-composer`"
      class="stack composer"
      novalidate
      tabindex="-1"
      :aria-label="`${LOG_TAG_LABELS[tag]} 로그로 남기기`"
      @submit.prevent="submit"
    >
      <p class="log-tag">{{ LOG_TAG_LABELS[tag] }}로 남기기</p>
      <LogFields
        :form="form"
        :id-prefix="base"
        :errors="errors"
        :members="members"
        :stuck-logs="noStuckLogs"
        :evidence-options="evidenceChoices"
        :milestones="milestones.items.value"
        :retro="retro"
      />
      <p v-if="failure" class="notice error" role="alert">{{ failure }}</p>
      <div class="actions">
        <button type="submit" :disabled="saving">{{ saving ? '저장 중…' : '빌드 로그로 남기기' }}</button>
        <button type="button" class="secondary" @click="tag = null">다른 걸로 고르기</button>
        <button type="button" class="secondary" @click="emit('dismiss')">그냥 완료</button>
      </div>
    </form>
  </section>
</template>
