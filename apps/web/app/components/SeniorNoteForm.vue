<script setup lang="ts">
/**
 * 선배 노트 작성·수정 폼(T-13, supply-kit §2). 질문 4개 중 2개 이상, 각 1000자. 만들 때 "정답·답안·교수 개인 평가 없음" 확인이 필요합니다.
 * 저장하면 초안이며, 공개는 따로 게시합니다(공개 전 점검을 거침). 게시된 노트를 고치면 다시 게시할 때까지 공개에서 내려갑니다.
 */
import type { SeniorNoteDisplayMode, SeniorNoteDto, SeniorNoteTimeBucket } from '~~/shared/types/api'

const props = defineProps<{ courseId?: string; note?: SeniorNoteDto }>()
const emit = defineEmits<{ saved: [note: SeniorNoteDto]; cancel: [] }>()

const editing = computed(() => !!props.note)
const form = reactive({
  displayMode: (props.note?.displayMode ?? 'anonymous') as SeniorNoteDisplayMode,
  displayName: props.note?.displayMode === 'display' ? (props.note.displayName ?? '') : '',
  termLabel: props.note?.termLabel ?? '',
  totalTimeBucket: (props.note?.totalTimeBucket ?? '') as SeniorNoteTimeBucket | '',
  answers: Object.fromEntries(SENIOR_NOTE_QUESTIONS.map((q) => [q, props.note?.answers[q] ?? ''])) as Record<(typeof SENIOR_NOTE_QUESTIONS)[number], string>,
  confirmed: false,
})
const errors = ref<Record<string, string>>({})
const message = ref('')
const saving = ref(false)
const idBase = computed(() => (props.note ? `note-${props.note.id}` : 'note-new'))
const filled = computed(() => SENIOR_NOTE_QUESTIONS.filter((q) => form.answers[q].trim()).length)
const DISPLAY_MODES: SeniorNoteDisplayMode[] = ['anonymous', 'display', 'name']
const TIME_BUCKETS = Object.keys(SENIOR_NOTE_TIME_BUCKET_LABELS) as SeniorNoteTimeBucket[]

function body() {
  return {
    displayMode: form.displayMode,
    displayName: form.displayMode === 'display' ? form.displayName : null,
    termLabel: form.termLabel || null,
    totalTimeBucket: form.totalTimeBucket || null,
    answers: Object.fromEntries(SENIOR_NOTE_QUESTIONS.map((q) => [q, form.answers[q]])),
  }
}

async function save() {
  errors.value = {}
  message.value = ''
  saving.value = true
  try {
    const note = props.note
      ? await $fetch<SeniorNoteDto>(`/api/v1/senior-notes/${props.note.id}`, { method: 'PATCH', body: { ...body(), expectedVersion: props.note.version } })
      : await $fetch<SeniorNoteDto>(`/api/v1/courses/${props.courseId}/senior-notes`, { method: 'POST', body: { ...body(), noAnswersConfirmed: form.confirmed } })
    emit('saved', note)
  } catch (error) {
    const e = apiError(error)
    errors.value = e.fields
    message.value = e.status === 422 ? '입력한 내용을 확인하세요.' : courseHubErrorMessage(e.code)
  } finally {
    saving.value = false
  }
}
const fieldError = (key: string) => fieldMessage(errors.value[key])
</script>

<template>
  <form class="stack senior-note-form" novalidate @submit.prevent="save">
    <fieldset>
      <legend>작성자 표시</legend>
      <div class="inline-options">
        <label v-for="mode in DISPLAY_MODES" :key="mode" class="check">
          <input v-model="form.displayMode" type="radio" :name="`${idBase}-mode`" :value="mode" />
          {{ SENIOR_NOTE_DISPLAY_LABELS[mode] }}
        </label>
      </div>
      <p class="hint">익명이어도 운영자는 신고 처리를 위해 작성자를 알 수 있습니다. 학번·학과는 공개되지 않습니다.</p>
    </fieldset>
    <div v-if="form.displayMode === 'display'" class="field">
      <label :for="`${idBase}-display`">표시명</label>
      <input :id="`${idBase}-display`" v-model="form.displayName" maxlength="40" :aria-invalid="!!errors.displayName" />
      <p v-if="errors.displayName" class="field-error">{{ fieldError('displayName') }}</p>
    </div>
    <div class="field">
      <label :for="`${idBase}-term`">수강 학기 <span class="muted">(선택, 예: 2025년 2학기)</span></label>
      <input :id="`${idBase}-term`" v-model="form.termLabel" maxlength="30" :aria-invalid="!!errors.termLabel" />
      <p v-if="errors.termLabel" class="field-error">{{ fieldError('termLabel') }}</p>
    </div>
    <div class="field">
      <label :for="`${idBase}-time`">대략 총 소요 시간 <span class="muted">(선택)</span></label>
      <select :id="`${idBase}-time`" v-model="form.totalTimeBucket">
        <option value="">고르지 않음</option>
        <option v-for="b in TIME_BUCKETS" :key="b" :value="b">{{ SENIOR_NOTE_TIME_BUCKET_LABELS[b] }}</option>
      </select>
    </div>
    <p class="hint">아래 질문 중 2개 이상 답해 주세요(지금 {{ filled }}개). 답이 아니라 지도를 남겨 주세요: 과제 원문·정답 코드·교수 개인 평가는 쓰지 않습니다.</p>
    <p v-if="errors.answers" class="field-error" role="alert">{{ errors.answers === 'too_few' ? '질문 2개 이상에 답해야 합니다.' : fieldError('answers') }}</p>
    <div v-for="q in SENIOR_NOTE_QUESTIONS" :key="q" class="field">
      <label :for="`${idBase}-${q}`">{{ SENIOR_NOTE_QUESTION_LABELS[q] }}</label>
      <textarea :id="`${idBase}-${q}`" v-model="form.answers[q]" :maxlength="SENIOR_NOTE_ANSWER_MAX" :aria-invalid="!!errors[`answers.${q}`]" />
      <p class="hint">{{ [...form.answers[q]].length }} / {{ SENIOR_NOTE_ANSWER_MAX }}</p>
      <p v-if="errors[`answers.${q}`]" class="field-error">{{ fieldError(`answers.${q}`) }}</p>
    </div>
    <label v-if="!editing" class="check">
      <input v-model="form.confirmed" type="checkbox" :aria-invalid="!!errors.noAnswersConfirmed" />
      이 노트에 과제 정답·답안·교수 개인 평가가 포함되어 있지 않습니다.
    </label>
    <p v-if="errors.noAnswersConfirmed" class="field-error">{{ fieldError('noAnswersConfirmed') }}</p>
    <p v-if="editing && note?.status === 'published'" class="notice">공개 중인 노트를 고치면 다시 게시할 때까지 공개에서 내려갑니다.</p>
    <p v-if="message" class="notice error" role="alert">{{ message }}</p>
    <p class="actions">
      <button type="submit" :disabled="saving || (!editing && !form.confirmed)">{{ editing ? '고친 내용 저장' : '초안 저장' }}</button>
      <button v-if="editing" type="button" class="secondary" @click="emit('cancel')">취소</button>
    </p>
  </form>
</template>
