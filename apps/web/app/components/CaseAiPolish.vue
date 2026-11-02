<script setup lang="ts">
/**
 * AI 케이스 다듬기(E-14, PROOFU_EVOLUTION_PLAN §10.3, ADR 0059). 서버에 AI가 설정되어 있을 때만 케이스 편집 화면에 보입니다(features.ai).
 * - "AI로 다듬기"를 누를 때마다 한 번 보냅니다(누르는 것이 그 한 번의 동의). 보내는 것은 이 케이스가 고정한 공개 사례의 기록(운영 조치로 가린 항목 제외)과
 *   지금 문장뿐입니다.
 * - 제안은 문장마다 지금 글과 나란히 보여 주고, 학생이 고르고(글도 고쳐서) 받아들인 문장만 케이스에 씁니다. 출처가 없는 제안은 강조해 보여 주며,
 *   받아들여도 출처를 붙이거나 지우기 전에는 게시할 수 없습니다.
 */
import type { CaseAiPolishApplyDto, CaseAiPolishStateDto, CaseAiSuggestionDto, CaseStudyDto } from '~~/shared/types/api'

const props = defineProps<{ caseStudyId: string; version: number; dirty: boolean }>()
const emit = defineEmits<{ applied: [dto: CaseStudyDto] }>()

const base = `/api/v1/case-studies/${props.caseStudyId}/ai-polish`
const state = ref<CaseAiPolishStateDto | null>(null)
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const choices = reactive<Record<string, { accept: boolean; text: string }>>({})

const idOf = (s: Pick<CaseAiSuggestionDto, 'section' | 'index'>) => `${s.section}:${s.index}`

function show(next: CaseAiPolishStateDto) {
  state.value = next
  for (const key of Object.keys(choices)) delete choices[key]
  for (const s of next.proposal?.suggestions ?? []) choices[idOf(s)] = { accept: !s.uncited, text: s.after.text }
}

async function load() {
  try {
    show(await $fetch<CaseAiPolishStateDto>(base))
  } catch {
    state.value = null
  }
}
onMounted(load)
watch(() => props.version, load)

function errorText(e: unknown): string {
  const err = apiError(e)
  if (err.status === 429) return '오늘은 이 케이스를 더 다듬을 수 없습니다(케이스마다 하루 5번, 서버 전체 한도 포함). 내일 다시 시도하세요.'
  return portfolioErrorMessage(err.code)
}

async function polish() {
  busy.value = true
  notice.value = null
  try {
    show(await $fetch<CaseAiPolishStateDto>(base, { method: 'POST', body: { expectedVersion: props.version } }))
    const n = state.value?.proposal?.suggestions.length ?? 0
    notice.value = { kind: 'ok', text: n ? `제안 ${n}개를 받았습니다. 문장마다 확인하고 받아들일 것만 고르세요.` : 'AI가 고칠 문장을 찾지 못했습니다. 케이스는 그대로입니다.' }
  } catch (e) {
    notice.value = { kind: 'error', text: errorText(e) }
  } finally {
    busy.value = false
  }
}

async function apply() {
  const suggestions = state.value?.proposal?.suggestions ?? []
  busy.value = true
  notice.value = null
  try {
    const accept = suggestions
      .filter((s) => choices[idOf(s)]?.accept)
      .map((s) => ({ section: s.section, index: s.index, ...(choices[idOf(s)]!.text !== s.after.text && { text: choices[idOf(s)]!.text }) }))
    const result = await $fetch<CaseAiPolishApplyDto>(`${base}/apply`, { method: 'POST', body: { expectedVersion: props.version, accept } })
    emit('applied', result.caseStudy)
    notice.value = {
      kind: 'ok',
      text: result.accepted ? `${result.accepted}개 문장을 바꿨습니다(나머지 ${result.rejected}개는 버림). 게시 중이었다면 초안으로 돌아갔습니다.` : '제안을 모두 버렸습니다. 케이스는 그대로입니다.',
    }
    await load()
  } catch (e) {
    notice.value = { kind: 'error', text: errorText(e) }
    await load()
  } finally {
    busy.value = false
  }
}

async function discard() {
  busy.value = true
  notice.value = null
  try {
    show(await $fetch<CaseAiPolishStateDto>(base, { method: 'DELETE' }))
    notice.value = { kind: 'ok', text: '제안을 모두 버렸습니다. 케이스는 그대로입니다.' }
  } catch (e) {
    notice.value = { kind: 'error', text: errorText(e) }
    await load()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section v-if="state" class="case-ai-polish" aria-labelledby="ai-polish-title" data-testid="ai-polish">
    <h2 id="ai-polish-title">AI로 다듬기 (선택)</h2>
    <p class="hint">
      누르면 이 케이스가 고정한 공개 사례의 기록(운영 조치로 가려진 항목 제외)과 지금 문장만 AI(Claude)에 보내 문장을 다듬은 제안을 받습니다.
      비공개 작업 기록·다른 팀원의 이름은 보내지 않습니다. 제안은 받아들이기 전에는 케이스를 바꾸지 않고, 받아들인 문장은 공개 화면에 "AI로 다듬음"으로 표시됩니다.
      "본인 회고" 문장은 다듬지 않습니다.
    </p>
    <p class="actions">
      <button type="button" class="secondary" :disabled="busy || dirty || !state.polishable || state.remainingToday === 0" @click="polish">
        {{ busy ? '처리 중…' : 'AI로 다듬기' }}
      </button>
      <span class="small muted">오늘 남은 횟수 {{ state.remainingToday }}</span>
    </p>
    <p v-if="dirty" class="hint">저장하지 않은 변경이 있습니다. 먼저 저장한 뒤 다듬을 수 있습니다.</p>
    <p v-else-if="!state.polishable" class="hint">다듬을 문장이 없습니다.</p>
    <p v-if="notice" class="notice" :class="notice.kind" role="status">{{ notice.text }}</p>

    <template v-if="state.proposal">
      <h3>제안 {{ state.proposal.suggestions.length }}개</h3>
      <p v-if="!state.proposal.suggestions.length" class="muted small">고칠 문장이 없다는 제안입니다.</p>
      <ol class="plain">
        <li
          v-for="s in state.proposal.suggestions"
          :key="idOf(s)"
          class="case-edit-sentence"
          :class="{ uncited: s.uncited }"
          :data-testid="`ai-suggestion-${idOf(s)}`"
        >
          <p class="small muted">{{ s.sectionLabel }} {{ s.index + 1 }}번째 문장</p>
          <p class="small"><span class="badge">지금</span> {{ s.before.text }}</p>
          <label :for="`ai-${idOf(s)}`" class="small"><span class="badge">AI 제안</span> (고쳐서 받아들일 수 있습니다)</label>
          <textarea :id="`ai-${idOf(s)}`" v-model="choices[idOf(s)]!.text" maxlength="500" rows="2" />
          <p v-if="s.uncited" class="field-error small">출처 없음 — 근거 기록과 연결되지 않은 문장입니다. 받아들여도 게시하려면 출처를 붙이거나 지워야 합니다.</p>
          <p v-else class="chips">
            <span class="visually-hidden">출처:</span>
            <a v-for="(c, ci) in s.after.citations" :key="ci" class="chip static" :href="c.path ?? undefined">{{ c.label ?? `${c.kind} ${c.key}` }}</a>
          </p>
          <label class="check small"><input v-model="choices[idOf(s)]!.accept" type="checkbox" /> 이 문장 받아들이기</label>
        </li>
      </ol>
      <p class="actions">
        <button type="button" :disabled="busy || dirty" @click="apply">고른 문장 받아들이기</button>
        <button type="button" class="secondary" :disabled="busy" @click="discard">모두 버리기</button>
      </p>
      <p class="small muted">제안은 {{ new Date(state.proposal.expiresAt).toLocaleDateString('ko-KR') }}까지 남고, 케이스를 고치면 사라집니다.</p>
    </template>
  </section>
</template>
