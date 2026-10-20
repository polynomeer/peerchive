<script setup lang="ts">
/**
 * 과목 정보(T-10): 프로젝트에 연결된 학교·과목·개설 학기·개념 태그(읽기 전용, "학생 작성").
 * - 개념 태그는 로그인한 사람 누구나 과목에 붙일 수 있습니다(과목당 12개, 같은 이름은 같은 태그).
 * - 편집 권한이 있으면 과목을 연결하거나 바꿀 수 있습니다. 바꾸거나 떼도 이미 걸린 엠바고는 줄지 않습니다.
 */
import type { ConceptTagDto, CourseContextDto, EmbargoDto } from '~~/shared/types/api'

const props = defineProps<{
  context: CourseContextDto | null
  embargo: EmbargoDto
  canEdit: boolean
  saving: boolean
}>()
const emit = defineEmits<{ save: [courseTermId: string | null] }>()

const tags = ref<ConceptTagDto[]>(props.context?.tags ?? [])
watch(
  () => props.context,
  (ctx) => (tags.value = ctx?.tags ?? []),
)

// ── 개념 태그 추가 ──
const TAG_LIMIT = 12
const tagInput = ref('')
const suggestions = ref<ConceptTagDto[]>([])
const tagStatus = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const tagBusy = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
function suggest() {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    const q = tagInput.value.trim()
    if (!q) return (suggestions.value = [])
    try {
      suggestions.value = await $fetch<ConceptTagDto[]>('/api/v1/concept-tags', { query: { q } })
    } catch {
      suggestions.value = []
    }
  }, 250)
}
async function addTag() {
  if (!props.context || !tagInput.value.trim()) return
  tagBusy.value = true
  tagStatus.value = null
  try {
    const res = await $fetch<{ tags: ConceptTagDto[]; tag: ConceptTagDto; added: boolean }>(
      `/api/v1/courses/${props.context.course.id}/concept-tags`,
      { method: 'POST', body: { label: tagInput.value } },
    )
    tags.value = res.tags
    tagInput.value = ''
    suggestions.value = []
    tagStatus.value = { kind: 'ok', text: res.added ? `‘${res.tag.label}’ 태그를 붙였습니다.` : '이미 붙어 있는 태그입니다.' }
  } catch (e) {
    const err = apiError(e)
    tagStatus.value = {
      kind: 'error',
      text:
        err.code === 'limit_reached'
          ? `과목당 태그는 ${TAG_LIMIT}개까지입니다.`
          : err.status === 429
            ? (CATALOG_CONFLICT_MESSAGES.rate_limited ?? '잠시 뒤 다시 시도하세요.')
            : err.status === 422
              ? (fieldMessage(Object.values(err.fields)[0]) ?? '태그 이름을 확인하세요.')
              : '태그를 붙이지 못했습니다.',
    }
  } finally {
    tagBusy.value = false
  }
}

// ── 과목 연결/바꾸기 ──
const picking = ref(false)
const picked = ref<string | null>(props.context?.term.id ?? null)
function startPick() {
  picked.value = props.context?.term.id ?? null
  picking.value = true
}
function save() {
  emit('save', picked.value)
}
watch(
  () => props.saving,
  (now, before) => {
    if (before && !now) picking.value = false
  },
)
</script>

<template>
  <section class="card" aria-labelledby="course-heading">
    <h2 id="course-heading">과목 정보</h2>

    <template v-if="!picking">
      <p v-if="!context" class="muted">연결된 과목이 없습니다.</p>
      <dl v-else>
        <dt>학교</dt>
        <dd>{{ context.school.name }} <span class="badge student">학생 작성</span></dd>
        <dt>과목</dt>
        <dd>
          {{ context.course.title }}<span v-if="context.course.code" class="muted"> ({{ context.course.code }})</span>
          <span class="badge student">학생 작성</span>
        </dd>
        <dt>개설 학기</dt>
        <dd>{{ termLabel(context.term) }} · 종료 {{ seoulDay(context.term.endsAt) }}</dd>
        <dt>개념 태그</dt>
        <dd>
          <span v-if="tags.length === 0" class="muted">아직 없음</span>
          <ul v-else class="chips" aria-label="개념 태그(학생 작성)">
            <li v-for="t in tags" :key="t.id" class="chip">#{{ t.label }}</li>
          </ul>
        </dd>
      </dl>
      <p v-if="embargo.until" class="hint">
        엠바고: {{ seoulDay(embargo.until) }}까지{{ embargo.active ? ' 공개할 수 없습니다.' : ' (끝남). 학기가 끝나도 자동으로 공개되지 않습니다.' }}
      </p>

      <form v-if="context" class="actions" @submit.prevent="addTag">
        <label for="tag-input">개념 태그 추가</label>
        <input
          id="tag-input"
          v-model="tagInput"
          list="tag-suggestions"
          maxlength="40"
          autocomplete="off"
          placeholder="예: 프로세스 스케줄링"
          aria-describedby="tag-hint"
          @input="suggest"
        />
        <datalist id="tag-suggestions">
          <option v-for="s in suggestions" :key="s.id" :value="s.label" />
        </datalist>
        <button type="submit" class="secondary" :disabled="tagBusy || !tagInput.trim() || tags.length >= TAG_LIMIT">추가</button>
        <p id="tag-hint" class="hint">과목에서 다루는 개념을 적어 주세요. 다른 학교의 같은 개념과 이어집니다(과목당 {{ TAG_LIMIT }}개).</p>
      </form>
      <p v-if="tagStatus" :class="tagStatus.kind === 'error' ? 'field-error' : 'hint'" :role="tagStatus.kind === 'error' ? 'alert' : 'status'">
        {{ tagStatus.text }}
      </p>

      <div v-if="canEdit" class="actions">
        <button type="button" class="secondary" @click="startPick">{{ context ? '과목 바꾸기' : '과목 연결' }}</button>
      </div>
    </template>

    <form v-else class="stack" @submit.prevent="save">
      <CoursePicker v-model="picked" :initial="context" id-prefix="edit-course" />
      <p v-if="embargo.until" class="hint">
        과목을 바꾸거나 연결을 끊어도 이미 걸린 엠바고({{ seoulDay(embargo.until) }}까지)는 줄지 않습니다. 잘못 연결했다면 운영자에게 요청하세요.
      </p>
      <div class="actions">
        <button type="submit" :disabled="saving">{{ picked ? '저장' : '연결 없이 저장' }}</button>
        <button type="button" class="secondary" @click="picking = false">취소</button>
      </div>
    </form>
  </section>
</template>
