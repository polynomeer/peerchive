<script setup lang="ts">
/**
 * 케이스 스터디 편집(T-14, PROOFU_EVOLUTION_PLAN §10.2, ADR 0014).
 * - 구역별 문장 목록: 글 고치기, ▲▼ 순서 바꾸기(드래그 없음), 지우기, 문장 더하기. 출처 칩은 고정한 공개 버전의 스냅샷 항목(종류 표시)에서 고릅니다.
 * - 출처 없는 문장은 글자로 표시하고("출처 없음") 게시를 막습니다. 한계·회고 구역에서만 "본인 회고"로 표시해 출처 없이 둘 수 있습니다.
 * - 저장은 문장 전체를 보냅니다(expectedVersion). 게시된 케이스를 고치면 초안으로 돌아가 다시 게시해야 합니다.
 * - 원본 사례가 철회·대체되면 고칠 수 없고 "새 버전으로 다시 만들기"만 보입니다.
 */
import type { CaseCitationRef, CaseSectionKey, CaseSentenceKind, CaseStudyDto, PublicationCheckDto } from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })

interface DraftSentence {
  uid: number
  text: string
  kind: CaseSentenceKind
  citations: CaseCitationRef[]
}

const route = useRoute()
const id = computed(() => String(route.params.id))
const requestFetch = useRequestFetch()
const { data, error, refresh } = await useAsyncData(() => `case-study:${id.value}`, () => requestFetch<CaseStudyDto>(`/api/v1/case-studies/${id.value}`))

useHead({ title: () => (data.value ? `${data.value.title} 편집 — Peerchive` : '케이스 스터디 — Peerchive') })

let uid = 0
const title = ref('')
const sections = ref<Array<{ key: CaseSectionKey; label: string; sentences: DraftSentence[] }>>([])
const dirty = ref(false)
function load(dto: CaseStudyDto) {
  title.value = dto.title
  sections.value = dto.sections.map((s) => ({
    key: s.key,
    label: s.label,
    sentences: s.sentences.map((x) => ({ uid: ++uid, text: x.text, kind: x.kind, citations: x.citations.map(({ releaseVersion, kind, key }) => ({ releaseVersion, kind, key })) })),
  }))
  dirty.value = false
}
watch(data, (dto) => dto && load(dto), { immediate: true })

const options = computed(() => (data.value?.snapshot ? citationOptions(data.value.snapshot, data.value.source.releaseVersion) : []))
const labelOf = (c: CaseCitationRef) => options.value.find((o) => citationId(o) === citationId(c))?.label ?? `${c.kind} ${c.key}`
const available = computed(() => data.value?.status !== 'unavailable')
const isUncited = (sectionKey: CaseSectionKey, s: DraftSentence) => s.citations.length === 0 && !(s.kind === 'reflection' && sectionKey === 'limits')
const uncitedCount = computed(() => sections.value.reduce((n, sec) => n + sec.sentences.filter((s) => isUncited(sec.key, s)).length, 0))

const touch = () => (dirty.value = true)
function move(list: DraftSentence[], index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= list.length) return
  const [item] = list.splice(index, 1)
  list.splice(target, 0, item!)
  touch()
}
function remove(list: DraftSentence[], index: number) {
  list.splice(index, 1)
  touch()
}
function add(sectionKey: CaseSectionKey) {
  sections.value.find((s) => s.key === sectionKey)!.sentences.push({ uid: ++uid, text: '', kind: sectionKey === 'limits' ? 'reflection' : 'evidence', citations: [] })
  touch()
}
const picking = reactive<Record<number, string>>({})
function addCitation(s: DraftSentence) {
  const choice = options.value.find((o) => citationId(o) === picking[s.uid])
  if (!choice || s.citations.some((c) => citationId(c) === citationId(choice))) return
  s.citations.push({ releaseVersion: choice.releaseVersion, kind: choice.kind, key: choice.key })
  picking[s.uid] = ''
  touch()
}
function removeCitation(s: DraftSentence, index: number) {
  s.citations.splice(index, 1)
  touch()
}

const saving = ref(false)
const confirmWarnings = ref(false)
const fieldErrors = ref<Record<string, string>>({})
const message = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

function body() {
  return {
    expectedVersion: data.value!.version,
    title: title.value,
    sections: sections.value.map((s) => ({ key: s.key, sentences: s.sentences.map((x) => ({ text: x.text, kind: x.kind, citations: x.citations })) })),
  }
}

async function save(): Promise<boolean> {
  saving.value = true
  message.value = null
  fieldErrors.value = {}
  try {
    const dto = await $fetch<CaseStudyDto>(`/api/v1/case-studies/${id.value}`, { method: 'PATCH', body: body() })
    data.value = dto
    message.value = { kind: 'ok', text: dto.status === 'draft' ? '저장했습니다(초안).' : '저장했습니다.' }
    return true
  } catch (e) {
    const err = apiError(e)
    fieldErrors.value = err.fields
    message.value = { kind: 'error', text: err.status === 422 ? '입력을 확인하세요. 표시된 문장을 고치세요.' : portfolioErrorMessage(err.code) }
    if (err.code === 'version_conflict' || err.code === 'unavailable') await refresh()
    return false
  } finally {
    saving.value = false
  }
}

async function publish() {
  if (dirty.value && !(await save())) return
  saving.value = true
  message.value = null
  try {
    data.value = await $fetch<CaseStudyDto>(`/api/v1/case-studies/${id.value}/publish`, {
      method: 'POST',
      body: { expectedVersion: data.value!.version, confirmWarnings: confirmWarnings.value },
    })
    message.value = { kind: 'ok', text: '게시했습니다. 포트폴리오 판에 넣을 수 있습니다.' }
  } catch (e) {
    message.value = { kind: 'error', text: portfolioErrorMessage(apiError(e).code) }
  } finally {
    saving.value = false
  }
}

async function unpublish() {
  saving.value = true
  try {
    data.value = await $fetch<CaseStudyDto>(`/api/v1/case-studies/${id.value}/unpublish`, { method: 'POST' })
    message.value = { kind: 'ok', text: '게시를 취소했습니다. 이 케이스가 들어 있는 판에서는 "볼 수 없음"으로 보입니다.' }
  } catch (e) {
    message.value = { kind: 'error', text: portfolioErrorMessage(apiError(e).code) }
  } finally {
    saving.value = false
  }
}

async function recreate() {
  if (!data.value?.recreateSlug) return
  try {
    const dto = await $fetch<CaseStudyDto>('/api/v1/case-studies', {
      method: 'POST',
      body: { releaseSlug: data.value.recreateSlug, jobTarget: data.value.jobTarget, revealSelf: data.value.source.revealSelf },
    })
    await navigateTo(`/portfolio/case-studies/${dto.id}`)
  } catch (e) {
    const err = apiError(e)
    message.value = { kind: 'error', text: err.status === 422 ? (fieldText(Object.values(err.fields)[0]) ?? '다시 만들 수 없습니다.') : portfolioErrorMessage(err.code) }
  }
}

const sentenceError = (si: number, i: number) => {
  const prefix = `sections.${si}.sentences.${i}`
  const code = Object.entries(fieldErrors.value).find(([k]) => k === prefix || k.startsWith(`${prefix}.`))?.[1]
  return fieldText(code)
}
const warningPlace = (w: PublicationCheckDto) =>
  w.location.field === 'title' ? '제목' : w.location.key ? (CASE_SECTION_LABELS[w.location.key as CaseSectionKey] ?? '문장') : '문장'
</script>

<template>
  <div>
    <p class="small"><NuxtLink to="/portfolio">← 포트폴리오</NuxtLink></p>
    <template v-if="error || !data">
      <h1>케이스 스터디를 찾을 수 없습니다</h1>
    </template>
    <template v-else>
      <h1>케이스 스터디 편집</h1>
      <p class="small">
        <span class="badge">{{ CASE_STATUS_LABELS[data.status] }}</span>
        · {{ CASE_JOB_TARGET_LABELS[data.jobTarget] }} 관점 · 템플릿 초안
        · 원본: <NuxtLink :to="data.source.path">{{ data.source.publicTitle || data.source.slug }}</NuxtLink> 공개 버전 v{{ data.source.releaseVersion }}
        <template v-if="data.source.selfLabel"> · 사례 속 내 표시: {{ data.source.selfLabel }}</template>
      </p>
      <p v-if="data.source.selfAnonymous" class="notice small" role="note">
        원래 익명으로 나오던 사례를 내 프로필과 연결했습니다. 다른 팀원의 표시는 스냅샷 그대로입니다.
      </p>

      <template v-if="!available">
        <div class="notice error" role="alert">
          <p><strong>원본 사례를 더 이상 볼 수 없습니다.</strong> {{ data.unavailableReason ? CASE_UNAVAILABLE_LABELS[data.unavailableReason] : '' }}</p>
          <p class="small">공개 프로필에서는 이 케이스가 글 없이 "원본 사례를 더 이상 볼 수 없습니다"로만 보입니다.</p>
          <p v-if="data.recreateSlug" class="actions"><button type="button" @click="recreate">새 버전으로 다시 만들기</button></p>
        </div>
      </template>

      <form v-else class="stack" novalidate @submit.prevent="save">
        <div class="field">
          <label for="case-title">제목</label>
          <input id="case-title" v-model="title" maxlength="80" :aria-invalid="!!fieldErrors.title" @input="touch" />
          <p v-if="fieldErrors.title" class="field-error">{{ fieldText(fieldErrors.title) }}</p>
        </div>
        <p class="hint">
          문장은 공개 스냅샷의 기록으로 만든 초안입니다. 고치거나 지우거나 더할 수 있지만, 공개하려면 모든 문장에 출처(공개 기록)가 있어야 합니다.
          <template v-if="uncitedCount"> 지금 출처 없는 문장: <strong>{{ uncitedCount }}개</strong>.</template>
        </p>

        <section v-for="(section, si) in sections" :key="section.key" class="case-edit-section" :aria-labelledby="`sec-${section.key}`">
          <h2 :id="`sec-${section.key}`">{{ section.label }}</h2>
          <p v-if="section.key === 'limits'" class="hint">이 구역에서는 "본인 회고"로 표시한 문장을 출처 없이 둘 수 있습니다(공개 화면에 "본인 회고"로 보임).</p>
          <ol class="plain">
            <li v-for="(s, i) in section.sentences" :key="s.uid" class="case-edit-sentence" :class="{ uncited: isUncited(section.key, s) }">
              <label :for="`s-${s.uid}`" class="visually-hidden">{{ section.label }} {{ i + 1 }}번째 문장</label>
              <textarea :id="`s-${s.uid}`" v-model="s.text" maxlength="500" rows="2" :aria-invalid="!!sentenceError(si, i)" @input="touch" />
              <p v-if="isUncited(section.key, s)" class="field-error small">출처 없음 — 게시하려면 출처를 붙이거나 지우세요.</p>
              <p v-if="sentenceError(si, i)" class="field-error small">{{ sentenceError(si, i) }}</p>
              <label v-if="section.key === 'limits'" class="check small">
                <input type="checkbox" :checked="s.kind === 'reflection'" @change="s.kind = ($event.target as HTMLInputElement).checked ? 'reflection' : 'evidence'; touch()" />
                본인 회고(출처 없이 둘 수 있음)
              </label>
              <p v-if="s.citations.length" class="chips">
                <span class="visually-hidden">출처:</span>
                <span v-for="(c, ci) in s.citations" :key="ci" class="chip static">
                  {{ labelOf(c) }}
                  <button type="button" class="link-button" :aria-label="`출처 빼기: ${labelOf(c)}`" @click="removeCitation(s, ci)">×</button>
                </span>
              </p>
              <div class="citation-picker">
                <label :for="`pick-${s.uid}`" class="visually-hidden">출처 고르기</label>
                <select :id="`pick-${s.uid}`" v-model="picking[s.uid]">
                  <option value="">출처 고르기…</option>
                  <option v-for="o in options" :key="citationId(o)" :value="citationId(o)">{{ o.label }}</option>
                </select>
                <button type="button" class="secondary" :disabled="!picking[s.uid]" @click="addCitation(s)">출처 붙이기</button>
              </div>
              <p class="actions">
                <button type="button" class="secondary icon-button" :disabled="i === 0" :aria-label="`${i + 1}번째 문장 위로`" @click="move(section.sentences, i, -1)">▲</button>
                <button type="button" class="secondary icon-button" :disabled="i === section.sentences.length - 1" :aria-label="`${i + 1}번째 문장 아래로`" @click="move(section.sentences, i, 1)">▼</button>
                <button type="button" class="danger" @click="remove(section.sentences, i)">지우기</button>
              </p>
            </li>
          </ol>
          <p v-if="!section.sentences.length" class="muted small">이 구역에 문장이 없습니다.</p>
          <p><button type="button" class="secondary" @click="add(section.key)">문장 더하기</button></p>
        </section>

        <div v-if="data.warnings.length" class="notice" role="note">
          <p><strong>공개 전 점검</strong>: 다음 내용이 공개되어도 괜찮은지 확인하세요(저장한 내용 기준).</p>
          <ul class="small">
            <li v-for="(w, i) in data.warnings" :key="i">{{ CHECK_RULE_LABELS[w.rule] }} — {{ warningPlace(w) }}: <span class="mono">{{ w.sample }}</span></li>
          </ul>
          <label class="check small"><input v-model="confirmWarnings" type="checkbox" /> 확인했고 이대로 게시합니다.</label>
        </div>

        <p v-if="message" class="notice" :class="message.kind" role="status">{{ message.text }}</p>
        <p class="actions">
          <button type="submit" class="secondary" :disabled="saving">저장</button>
          <button v-if="data.status !== 'published' || dirty" type="button" :disabled="saving || uncitedCount > 0" @click="publish">
            {{ dirty ? '저장하고 게시' : '게시' }}
          </button>
          <button v-if="data.status === 'published'" type="button" class="danger" :disabled="saving" @click="unpublish">게시 취소</button>
          <span v-if="dirty" class="save-status">저장하지 않은 변경이 있습니다.</span>
        </p>
        <p v-if="uncitedCount > 0" class="hint">출처 없는 문장이 있으면 게시할 수 없습니다.</p>
      </form>
    </template>
  </div>
</template>
