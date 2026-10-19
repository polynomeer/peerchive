<script setup lang="ts">
/**
 * 과제 공간의 빌드 로그(T-04): 빠른 작성 폼 + 최신순 타임라인.
 *
 * - 작성 폼은 owner/editor에게만 보입니다. reviewer/viewer는 타임라인만 봅니다.
 * - 입력은 프로젝트별로 localStorage에 임시 저장하고, 저장에 성공하면 지웁니다(시나리오 H: 실패해도 내용 보존).
 * - 재시도는 같은 clientId로 보내 네트워크 오류 뒤 중복 로그가 생기지 않게 합니다.
 * - 목록은 클라이언트에서 불러옵니다(필터·더 보기 상태를 화면이 가짐).
 */
import type { LogDto, LogPageDto, LogTag, MemberDto } from '~~/shared/types/api'

const props = defineProps<{ projectId: string; canWrite: boolean; members: MemberDto[]; meId: string | null }>()

// ── 타임라인 ──
type Filter = 'all' | 'stuck' | 'decision' | 'validation' | 'mine'
const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'stuck', label: '🧱 막힘' },
  { value: 'decision', label: '⚖️ 결정' },
  { value: 'validation', label: '✅ 검증' },
  { value: 'mine', label: '내 로그' },
]
const filter = ref<Filter>('all')
const items = ref<LogDto[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(false)
const loadError = ref(false)

async function load(reset: boolean) {
  loading.value = true
  loadError.value = false
  const query: Record<string, string> = { limit: '20' }
  if (filter.value === 'mine' && props.meId) query.author = props.meId
  else if (filter.value !== 'all' && filter.value !== 'mine') query.tag = filter.value
  if (!reset && nextCursor.value) query.cursor = nextCursor.value
  try {
    const page = await $fetch<LogPageDto>(`/api/v1/projects/${props.projectId}/logs`, { query })
    items.value = reset ? page.items : [...items.value, ...page.items]
    nextCursor.value = page.nextCursor
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}

function setFilter(value: Filter) {
  if (filter.value === value) return
  filter.value = value
  void load(true)
}

function replaceItem(log: LogDto) {
  items.value = items.value.map((item) => (item.id === log.id ? log : item))
  void loadStuckLogs()
}

// 💡해결이 연결할 막힘 후보(최근 50개).
const stuckLogs = ref<LogDto[]>([])
async function loadStuckLogs() {
  if (!props.canWrite) return
  try {
    const page = await $fetch<LogPageDto>(`/api/v1/projects/${props.projectId}/logs`, { query: { tag: 'stuck', limit: '50' } })
    stuckLogs.value = page.items
  } catch {
    // 목록이 비어 있으면 해결 폼에서 고를 수 없다는 안내가 보입니다.
  }
}

// ── 빠른 작성 ──
const form = reactive(emptyLogForm())
const clientId = ref('')
type SaveState = 'idle' | 'saving' | 'saved' | 'invalid' | 'error' | 'restored'
const saveState = ref<SaveState>('idle')
const errors = ref<Record<string, string>>({})
const composerReady = ref(false)

const SAVE_TEXT: Record<SaveState, string> = {
  idle: '',
  saving: '저장 중…',
  saved: '저장됨',
  invalid: '입력을 확인하세요. 내용은 이 기기에 임시 저장되어 있습니다.',
  error: '오류 — 재시도. 내용은 이 기기에 임시 저장되어 있습니다.',
  restored: '저장하지 못한 입력을 불러왔습니다.',
}

function chooseTag(tag: LogTag) {
  form.tag = tag
  errors.value = {}
}

watch(
  form,
  () => {
    if (!composerReady.value) return
    if (saveState.value === 'saved') saveState.value = 'idle'
    if (isLogFormEmpty(form)) clearLogDraft(props.projectId)
    else saveLogDraft(props.projectId, { form: { ...form, attendees: [...form.attendees] }, clientId: clientId.value })
  },
  { deep: true },
)

async function submit() {
  if (saveState.value === 'saving') return
  saveState.value = 'saving'
  errors.value = {}
  // 보내기 전에 한 번 더 저장해 두어, 응답 전에 창이 닫혀도 같은 clientId로 다시 보낼 수 있게 합니다.
  saveLogDraft(props.projectId, { form: { ...form, attendees: [...form.attendees] }, clientId: clientId.value })
  try {
    const created = await $fetch<LogDto>(`/api/v1/projects/${props.projectId}/logs`, {
      method: 'POST',
      body: { tag: form.tag, ...formRequest(form), clientId: clientId.value },
    })
    clearLogDraft(props.projectId)
    composerReady.value = false
    Object.assign(form, emptyLogForm(form.tag))
    clientId.value = newClientId()
    await nextTick()
    composerReady.value = true
    saveState.value = 'saved'
    if (created.tag === 'stuck' || created.tag === 'solution') void loadStuckLogs()
    await load(true)
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422) {
      errors.value = formFieldErrors(error.fields)
      saveState.value = 'invalid'
    } else {
      saveState.value = 'error'
    }
  }
}

onMounted(() => {
  const draft = props.canWrite ? loadLogDraft(props.projectId) : null
  if (draft) {
    Object.assign(form, draft.form)
    clientId.value = draft.clientId
    saveState.value = 'restored'
  } else {
    clientId.value = newClientId()
  }
  composerReady.value = true
  void load(true)
  void loadStuckLogs()
})
</script>

<template>
  <section class="card" aria-labelledby="buildlog-heading">
    <h2 id="buildlog-heading">빌드 로그</h2>

    <form v-if="canWrite" class="stack composer" novalidate aria-label="빌드 로그 쓰기" @submit.prevent="submit">
      <fieldset>
        <legend>태그</legend>
        <div class="chips">
          <label v-for="tag in LOG_TAG_ORDER" :key="tag" :class="['chip', { selected: form.tag === tag }]">
            <input type="radio" name="new-log-tag" :value="tag" :checked="form.tag === tag" @change="chooseTag(tag)" />
            {{ LOG_TAG_LABELS[tag] }}
          </label>
        </div>
      </fieldset>
      <p v-if="form.tag === 'solution' && stuckLogs.length === 0" class="hint">
        연결할 🧱 막힘 로그가 아직 없습니다. 먼저 막힘을 기록하세요.
      </p>
      <LogFields :form="form" id-prefix="new-log" :errors="errors" :members="members" :stuck-logs="stuckLogs" />
      <div class="actions">
        <button type="submit" :disabled="saveState === 'saving'">기록하기</button>
        <button v-if="saveState === 'error'" type="button" class="secondary" @click="submit">재시도</button>
        <p :class="['save-status', saveState]" role="status" aria-live="polite">{{ SAVE_TEXT[saveState] }}</p>
      </div>
    </form>
    <p v-else class="hint">이 과제에서 로그를 볼 수 있지만 쓸 수는 없습니다(편집자 이상만 작성).</p>

    <div class="chips filter" role="group" aria-label="로그 필터">
      <button
        v-for="f in FILTERS"
        :key="f.value"
        type="button"
        :class="['chip', { selected: filter === f.value }]"
        :aria-pressed="filter === f.value"
        @click="setFilter(f.value)"
      >
        {{ f.label }}
      </button>
    </div>

    <p v-if="loadError" class="notice error" role="alert">
      로그를 불러오지 못했습니다. <button type="button" class="link-button" @click="load(items.length === 0)">다시 시도</button>
    </p>
    <p v-else-if="!loading && items.length === 0" class="muted">아직 로그가 없습니다.</p>

    <ol class="plain timeline" aria-label="로그 목록 (최신순)">
      <li v-for="log in items" :key="log.id">
        <LogItem :log="log" :members="members" :stuck-logs="stuckLogs" @updated="replaceItem" />
      </li>
    </ol>
    <p v-if="loading" class="muted" role="status">불러오는 중…</p>
    <button v-if="nextCursor && !loading" type="button" class="secondary more" @click="load(false)">더 보기</button>
  </section>
</template>
