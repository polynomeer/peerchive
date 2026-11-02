<script setup lang="ts">
/**
 * AI 회고 인터뷰(E-12, PROOFU_EVOLUTION_PLAN §6.4, ADR 0057). 서버에 AI가 설정되어 있을 때만 과제 화면에 보입니다(features.ai).
 * - 학생이 이 과제에서 직접 켜야 씁니다(기본 꺼짐). 켜기 전에 무엇을 보내고 얼마나 두는지 먼저 보여 줍니다.
 * - 3분 안팎의 짧은 인터뷰(질문 3~5개) → 빌드 로그 초안 제안 → 초안마다 고쳐서 승인하거나 버립니다. 승인한 로그에는 `AI 초안`이 붙습니다.
 * - 인터뷰·초안은 나만 봅니다. 위의 폼 체크인은 AI와 상관없이 그대로 쓸 수 있습니다.
 */
import type { AiRetroApproveDto, AiRetroStateDto, LogDto, MemberDto } from '~~/shared/types/api'
import type { LogForm } from '~/utils/build-log'

const props = defineProps<{ projectId: string; members: MemberDto[]; retro?: boolean }>()

const base = `/api/v1/projects/${props.projectId}/ai-retro`
const state = ref<AiRetroStateDto | null>(null)
const loadError = ref(false)
const busy = ref(false)
const answer = ref('')
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const forms = reactive<Record<string, LogForm>>({})
const errors = reactive<Record<string, Record<string, string>>>({})
const logsChanged = useLogsChanged(props.projectId)
const artifacts = useProjectArtifacts(props.projectId)
const evidenceChoices = computed(() => evidenceOptions(artifacts.items.value))
const milestones = useProjectMilestones(props.projectId)
const noStuckLogs: LogDto[] = []

function apply(next: AiRetroStateDto) {
  state.value = next
  for (const draft of next.drafts) forms[draft.id] ??= aiDraftToForm(draft)
  for (const id of Object.keys(forms)) if (!next.drafts.some((d) => d.id === id)) delete forms[id]
  if (next.drafts.length > 0) {
    if (!artifacts.loaded.value) void artifacts.refresh()
    if (!milestones.loaded.value) void milestones.refresh()
  }
}

async function load() {
  try {
    apply(await $fetch<AiRetroStateDto>(base))
    loadError.value = false
  } catch {
    loadError.value = true
  }
}
onMounted(load)

async function run(action: () => Promise<AiRetroStateDto>, ok?: string) {
  busy.value = true
  notice.value = null
  try {
    const next = await action()
    apply(next)
    if (next.noDrafts) notice.value = { kind: 'ok', text: '이번 인터뷰에서는 남길 만한 초안이 없었습니다. 인터뷰 내용은 지웠습니다.' }
    else if (ok) notice.value = { kind: 'ok', text: ok }
    return true
  } catch (e) {
    const err = apiError(e)
    notice.value = { kind: 'error', text: aiRetroErrorMessage(err.status, err.code) }
    if (err.status === 409 || err.status === 404) await load()
    return false
  } finally {
    busy.value = false
  }
}

const setOptIn = (enabled: boolean) => {
  if (!enabled && !confirm('AI 회고 인터뷰를 끌까요? 진행 중인 인터뷰와 승인하지 않은 초안은 지워집니다.')) return
  void run(() => $fetch<AiRetroStateDto>(`${base}/opt-in`, { method: 'PUT', body: { enabled } }), enabled ? '켰습니다. 인터뷰를 시작해 보세요.' : '껐습니다.')
}
const start = () => void run(() => $fetch<AiRetroStateDto>(`${base}/session`, { method: 'POST' }))
const discardSession = () => {
  if (!confirm('이 인터뷰와 초안을 모두 버릴까요? 빌드 로그에는 아무것도 남지 않습니다.')) return
  void run(() => $fetch<AiRetroStateDto>(`${base}/session`, { method: 'DELETE' }), '인터뷰를 버렸습니다.')
}

async function send(finish: boolean) {
  const session = state.value?.session
  if (!session) return
  const text = answer.value.trim()
  if (!text && !finish) {
    notice.value = { kind: 'error', text: '답을 적어 주세요.' }
    return
  }
  const done = await run(() =>
    $fetch<AiRetroStateDto>(`${base}/answers`, { method: 'POST', body: { questionNo: session.questionCount, answer: text || null, finish } }),
  )
  if (done) answer.value = ''
}

async function approve(draftId: string) {
  const form = forms[draftId]
  if (!form || busy.value) return
  busy.value = true
  notice.value = null
  errors[draftId] = {}
  try {
    const res = await $fetch<AiRetroApproveDto>(`${base}/drafts/${draftId}/approve`, { method: 'POST', body: formRequest(form) })
    apply(res.state)
    logsChanged.notify()
    notice.value = { kind: 'ok', text: `${LOG_TAG_LABELS[res.log.tag]} 로그로 저장했습니다(AI 초안 표시).` }
  } catch (e) {
    const err = apiError(e)
    if (err.status === 422) {
      errors[draftId] = formFieldErrors(err.fields)
      notice.value = { kind: 'error', text: '입력을 확인하세요. 내용은 그대로 남아 있습니다.' }
    } else {
      notice.value = { kind: 'error', text: aiRetroErrorMessage(err.status, err.code) }
      if (err.status === 404) await load()
    }
  } finally {
    busy.value = false
  }
}
const discardDraft = (draftId: string) => void run(() => $fetch<AiRetroStateDto>(`${base}/drafts/${draftId}`, { method: 'DELETE' }), '초안을 버렸습니다.')

const currentQuestion = computed(() => {
  const turns = state.value?.session?.turns ?? []
  const last = turns.at(-1)
  return last && last.a === null ? last.q : null
})
const answered = computed(() => (state.value?.session?.turns ?? []).filter((t) => t.a !== null))
</script>

<template>
  <section id="ai-retro" class="card" aria-labelledby="ai-retro-heading" data-testid="ai-retro-section">
    <h2 id="ai-retro-heading">AI 회고 인터뷰 (선택)</h2>
    <p class="hint">3분 안팎의 짧은 질문에 답하면 빌드 로그 초안을 제안합니다. 초안은 내가 고치고 승인해야 저장되며 `AI 초안`으로 표시됩니다.</p>

    <p v-if="loadError" class="notice error" role="alert">
      불러오지 못했습니다. <button type="button" class="link-button" @click="load">다시 시도</button>
    </p>

    <template v-else-if="state">
      <p v-if="!state.canUse" class="muted">편집 권한(운영 책임자·편집자)이 있어야 쓸 수 있습니다.</p>

      <div v-else-if="!state.optedIn" class="stack">
        <details open>
          <summary>켜기 전에 확인하세요</summary>
          <ul>
            <li>AI(Anthropic Claude API)에 보내는 것: 이 과제 이름, 나의 이번 주 체크인, 내가 이 과제에 쓴 최근 기록 5개의 한 줄 요약, 인터뷰에서 내가 쓴 답.</li>
            <li>다른 팀원의 기록·체크인·이름과 다른 과제의 내용은 보내지 않습니다.</li>
            <li>질문·답변은 초안을 만들면 바로 지우고, 초안도 처리하거나 7일이 지나면 지웁니다.</li>
            <li>AI가 만든 초안은 내가 승인하기 전에는 빌드 로그에 저장되지 않습니다.</li>
          </ul>
        </details>
        <div class="actions">
          <button type="button" :disabled="busy" data-testid="ai-retro-opt-in" @click="setOptIn(true)">이 과제에서 켜기</button>
        </div>
      </div>

      <div v-else class="stack">
        <template v-if="!state.session">
          <div class="actions">
            <button type="button" :disabled="busy" @click="start">인터뷰 시작</button>
            <button type="button" class="link-button" :disabled="busy" @click="setOptIn(false)">이 과제에서 끄기</button>
          </div>
        </template>

        <template v-else-if="state.session.status === 'active'">
          <ol class="plain" aria-label="지금까지의 질문과 답">
            <li v-for="(turn, i) in answered" :key="i">
              <p><strong>Q{{ i + 1 }}.</strong> {{ turn.q }}</p>
              <p class="pre muted">{{ turn.a }}</p>
            </li>
          </ol>
          <form v-if="currentQuestion" class="stack" novalidate @submit.prevent="send(false)">
            <label for="ai-retro-answer"><strong>Q{{ state.session.questionCount }}.</strong> {{ currentQuestion }}</label>
            <textarea id="ai-retro-answer" v-model="answer" maxlength="1000" aria-describedby="ai-retro-answer-count" />
            <p id="ai-retro-answer-count" class="hint">{{ answer.length }} / 1000자</p>
            <div class="actions">
              <button type="submit" :disabled="busy">{{ busy ? 'AI가 생각하는 중…' : '답하기' }}</button>
              <button type="button" class="secondary" :disabled="busy || (answered.length === 0 && !answer.trim())" @click="send(true)">여기까지 정리</button>
              <button type="button" class="link-button" :disabled="busy" @click="discardSession">그만두기</button>
            </div>
          </form>
        </template>

        <template v-else>
          <p class="hint">초안 {{ state.drafts.length }}개. 고칠 곳을 고친 뒤 하나씩 승인하거나 버리세요. 인터뷰 질문·답변은 이미 지웠습니다.</p>
          <form
            v-for="draft in state.drafts"
            :key="draft.id"
            class="stack composer"
            novalidate
            :aria-label="`${LOG_TAG_LABELS[draft.tag]} 초안`"
            @submit.prevent="approve(draft.id)"
          >
            <p class="log-tag">{{ LOG_TAG_LABELS[draft.tag] }} <span class="badge">AI 초안</span></p>
            <LogFields
              v-if="forms[draft.id]"
              :form="forms[draft.id]!"
              :id-prefix="`ai-draft-${draft.id}`"
              :errors="errors[draft.id] ?? {}"
              :members="members"
              :stuck-logs="noStuckLogs"
              :evidence-options="evidenceChoices"
              :milestones="milestones.items.value"
              :retro="retro"
            />
            <div class="actions">
              <button type="submit" :disabled="busy">승인해서 빌드 로그로 저장</button>
              <button type="button" class="secondary" :disabled="busy" @click="discardDraft(draft.id)">버리기</button>
            </div>
          </form>
          <div class="actions">
            <button type="button" class="link-button" :disabled="busy" @click="discardSession">초안 모두 버리기</button>
          </div>
        </template>
      </div>

      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
    </template>
  </section>
</template>
