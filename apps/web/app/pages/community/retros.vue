<script setup lang="ts">
/**
 * 수료 회고(A-06, PROOFU_EVOLUTION_PLAN §8.9.10·§8.9.11, ADR 0043). 로그인 전용·noindex·제목 고정(C-05). P2 institutions 플래그가 꺼지면 404.
 * - 부트캠프·교육 프로그램·동아리 연합 수료생이 남긴 구조화된 회고입니다. 별점·연봉·추천 점수는 없습니다.
 * - 읽기: 학교·기관 인증이 하나라도 있는 계정. 쓰기: 대학이 아닌 기관의 인증된 수료생, 기관마다 하나(철회하면 다시 씀).
 * - 익명 회고의 기관 표시는 인증 수료생이 적으면 기관 유형으로 넓히거나 표시하지 않습니다(A-05 규칙). 넓혀졌는지는 나에게만 보입니다.
 */
import type {
  AffiliationLabelScope,
  CompletionRetroComposerDto,
  CompletionRetroDisplayMode,
  CompletionRetroListDto,
  CompletionRetroQuestion,
  MyCompletionRetroDto,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useCommunityPage()

const filter = reactive({ institution: '' })
const fetcher = useRequestFetch()
const { data, error, refresh } = await useAsyncData('completion-retros', () =>
  fetcher<CompletionRetroListDto>('/api/v1/completion-retros', { query: filter.institution ? { institution: filter.institution } : {} }),
)
const missing = computed(() => !!error.value || !data.value)
if (import.meta.server && missing.value) {
  const event = useRequestEvent()
  if (event) setResponseStatus(event, 404)
}
watch(() => filter.institution, () => refresh())

const composer = ref<CompletionRetroComposerDto | null>(null)
const mine = ref<MyCompletionRetroDto[]>([])
async function loadMine() {
  ;[composer.value, mine.value] = await Promise.all([
    $fetch<CompletionRetroComposerDto>('/api/v1/me/completion-retros/composer').catch(() => null),
    $fetch<MyCompletionRetroDto[]>('/api/v1/me/completion-retros').catch(() => []),
  ])
}
onMounted(loadMine)

const SCOPE_TEXT: Record<AffiliationLabelScope, string> = { institution: '기관 이름', institution_kind: '기관 유형만', none: '표시 안 함' }
const STATUS_TEXT: Record<MyCompletionRetroDto['status'], string> = { published: '게시 중', withdrawn: '철회함', hidden: '운영 조치로 숨김' }

const form = reactive({
  affiliationId: '',
  displayMode: 'anonymous' as CompletionRetroDisplayMode,
  labelScope: 'institution' as AffiliationLabelScope,
  showCohort: false,
  answers: Object.fromEntries(COMPLETION_RETRO_QUESTIONS.map((q) => [q, ''])) as Record<CompletionRetroQuestion, string>,
  guidelinesConfirmed: false,
  confirmWarnings: false,
})
const chosen = computed(() => composer.value?.options.find((o) => o.affiliationId === form.affiliationId) ?? null)
watch(composer, (c) => {
  if (c && !form.affiliationId) form.affiliationId = c.options.find((o) => !o.alreadyWritten)?.affiliationId ?? ''
})
const preview = computed(() => (chosen.value && form.displayMode === 'anonymous' ? chosen.value.anonymousPreviews[form.labelScope] : null))
const warnings = ref<Array<{ rule: string; field: string; sample: string }>>([])
const errors = ref<Record<string, string>>({})
const message = ref('')
const status = ref('')
const busy = ref(false)

async function submit() {
  errors.value = {}
  message.value = ''
  status.value = ''
  busy.value = true
  try {
    await $fetch<MyCompletionRetroDto>('/api/v1/me/completion-retros', {
      method: 'POST',
      body: {
        affiliationId: form.affiliationId,
        displayMode: form.displayMode,
        ...(form.displayMode === 'anonymous' ? { labelScope: form.labelScope } : { showCohort: form.showCohort }),
        answers: form.answers,
        guidelinesConfirmed: form.guidelinesConfirmed,
        confirmWarnings: form.confirmWarnings,
      },
    })
    status.value = '회고를 올렸습니다.'
    for (const q of COMPLETION_RETRO_QUESTIONS) form.answers[q] = ''
    warnings.value = []
    await Promise.all([refresh(), loadMine()])
  } catch (e) {
    const err = apiError(e)
    if (err.code === 'checks_unconfirmed') warnings.value = ((err.data as unknown as { warnings?: typeof warnings.value }).warnings ?? []) as typeof warnings.value
    errors.value = err.fields
    message.value = err.status === 422 ? '입력한 내용을 확인하세요.' : retroErrorMessage(err.code)
  } finally {
    busy.value = false
  }
}

async function withdraw(id: string) {
  if (!window.confirm('이 회고를 철회할까요? 목록에서 바로 빠집니다.')) return
  try {
    await $fetch(`/api/v1/me/completion-retros/${id}/withdraw`, { method: 'POST' })
    status.value = '회고를 철회했습니다.'
    await Promise.all([refresh(), loadMine()])
  } catch (e) {
    message.value = retroErrorMessage(apiError(e).code)
  }
}
const fieldError = (key: string) => fieldMessage(errors.value[key])
</script>

<template>
  <div class="community-page retros-page stack">
    <template v-if="missing">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
    <template v-else-if="data">
      <h1>수료 회고</h1>
      <p class="hint">
        부트캠프·교육 프로그램을 마친 사람들이 남긴 경험입니다. 별점·연봉·추천 점수는 받지 않고, 배운 것과 과정을 지나며 겪은 것을 남깁니다. 학교·기관 인증을 한 계정에게만
        보이고 검색엔진·공개 검색에는 나오지 않습니다.
      </p>
      <p v-if="status" class="notice" role="status">{{ status }}</p>
      <p v-if="message" class="notice error" role="alert">{{ message }}</p>

      <p v-if="!data.eligible" class="notice" data-testid="retros-need-affiliation">
        수료 회고는 학교·기관 인증을 한 계정만 읽습니다.
        <NuxtLink to="/settings/affiliations?return=/community/retros">인증하러 가기</NuxtLink>
      </p>
      <template v-else>
        <div v-if="data.institutions.length" class="field">
          <label for="retro-institution">기관</label>
          <select id="retro-institution" v-model="filter.institution">
            <option value="">전체</option>
            <option v-for="i in data.institutions" :key="i.id" :value="i.id">{{ i.name }} ({{ i.kindLabel }})</option>
          </select>
        </div>
        <ul v-if="data.items.length" class="plain hub-list" data-testid="retro-list">
          <li v-for="r in data.items" :key="r.id" class="hub-card" :data-testid="`retro-${r.id}`">
            <p class="small">
              <strong>{{ r.author }}</strong>
              <span v-if="r.institutionLabel"> · {{ r.institutionLabel }}</span>
              <span v-if="r.cohortLabel"> · {{ r.cohortLabel }}</span>
              <span v-if="r.mine" class="badge">내 회고</span>
              <span v-if="r.labelBroadened" class="hint"> (넓혀 표시됨 · 나에게만 보이는 안내)</span>
            </p>
            <dl>
              <template v-for="q in COMPLETION_RETRO_QUESTIONS" :key="q">
                <template v-if="r.answers[q]">
                  <dt>{{ COMPLETION_RETRO_QUESTION_LABELS[q] }}</dt>
                  <dd class="pre">{{ r.answers[q] }}</dd>
                </template>
              </template>
            </dl>
            <ReportButton
              v-if="r.canReport"
              :id-prefix="`retro-${r.id}`"
              :targets="[{ id: r.id, label: '이 회고', targetType: 'completion_retro', targetRef: { retroId: r.id } }]"
            />
          </li>
        </ul>
        <p v-else class="muted">아직 회고가 없습니다.</p>
      </template>

      <section v-if="composer" aria-labelledby="retro-write" class="stack">
        <h2 id="retro-write">회고 쓰기</h2>
        <p v-if="!composer.options.length" class="hint" data-testid="retro-not-eligible">
          부트캠프·교육 프로그램·동아리 연합의 <strong>수료생</strong>으로 인증하면 그 기관에 회고를 남길 수 있습니다.
        </p>
        <form v-else class="stack" novalidate data-testid="retro-form" @submit.prevent="submit">
          <div class="field">
            <label for="retro-affiliation">기관</label>
            <select id="retro-affiliation" v-model="form.affiliationId" :aria-invalid="!!errors.affiliationId">
              <option v-for="o in composer.options" :key="o.affiliationId" :value="o.affiliationId" :disabled="o.alreadyWritten">
                {{ o.title }}<template v-if="o.alreadyWritten"> — 이미 씀</template>
              </option>
            </select>
          </div>
          <fieldset>
            <legend>작성자 표시</legend>
            <div v-for="m in composer.displayModes" :key="m" class="radio-row">
              <input :id="`retro-mode-${m}`" v-model="form.displayMode" type="radio" name="retro-mode" :value="m" :disabled="m === 'display' && !composer.displayPersonaName" />
              <label :for="`retro-mode-${m}`">
                {{ COMPLETION_RETRO_DISPLAY_LABELS[m] }}
                <template v-if="m === 'name' && composer.accountName">({{ composer.accountName }})</template>
                <template v-if="m === 'display'">({{ composer.displayPersonaName ?? '표시명 프로필 없음' }})</template>
                <template v-if="m === 'anonymous'">("{{ ANONYMOUS_RETRO_LABEL }}")</template>
              </label>
            </div>
            <p class="hint">회고는 프로필 활동에 이어지지 않습니다.</p>
          </fieldset>
          <fieldset v-if="form.displayMode === 'anonymous'">
            <legend>기관 표시</legend>
            <div v-for="s in composer.scopes" :key="s" class="radio-row">
              <input :id="`retro-scope-${s}`" v-model="form.labelScope" type="radio" name="retro-scope" :value="s" />
              <label :for="`retro-scope-${s}`">{{ SCOPE_TEXT[s] }}</label>
            </div>
            <p v-if="preview" class="small" data-testid="retro-label-preview">
              이렇게 보입니다: <strong>{{ preview.label ?? '소속 표시 없음' }}</strong>
              <span v-if="preview.broadened" class="hint"> — {{ composer.broadenedNote }}</span>
            </p>
            <p class="hint">익명 회고는 기수를 보이지 않습니다. 기관 이름이 아닌 표시로 정해지면 그 기관 목록에도 나오지 않습니다.</p>
          </fieldset>
          <div v-else-if="chosen?.cohortLabel" class="radio-row">
            <input id="retro-show-cohort" v-model="form.showCohort" type="checkbox" />
            <label for="retro-show-cohort">기수({{ chosen.cohortLabel }}) 보이기</label>
          </div>
          <div v-for="q in COMPLETION_RETRO_QUESTIONS" :key="q" class="field">
            <label :for="`retro-${q}`">{{ COMPLETION_RETRO_QUESTION_LABELS[q] }}</label>
            <textarea :id="`retro-${q}`" v-model="form.answers[q]" rows="3" :maxlength="COMPLETION_RETRO_ANSWER_MAX" :data-testid="`retro-answer-${q}`" />
            <p v-if="errors[`answers.${q}`]" class="field-error">{{ fieldError(`answers.${q}`) }}</p>
          </div>
          <p v-if="errors.answers" class="field-error">질문 4개 중 2개 이상 답하세요.</p>
          <div v-if="warnings.length" class="notice" role="status">
            <ul>
              <li v-for="(w, i) in warnings" :key="i">{{ CHECK_RULE_LABELS[w.rule as keyof typeof CHECK_RULE_LABELS] ?? w.rule }} · {{ w.sample }}</li>
            </ul>
            <div class="radio-row">
              <input id="retro-confirm-warnings" v-model="form.confirmWarnings" type="checkbox" />
              <label for="retro-confirm-warnings">경고를 확인했습니다. 이대로 올립니다.</label>
            </div>
          </div>
          <div class="radio-row">
            <input id="retro-guidelines" v-model="form.guidelinesConfirmed" type="checkbox" data-testid="retro-guidelines" />
            <label for="retro-guidelines">{{ composer.guideline }}</label>
          </div>
          <p class="actions"><button type="submit" :disabled="busy || !form.affiliationId" data-testid="retro-submit">회고 올리기</button></p>
        </form>
      </section>

      <section v-if="mine.length" aria-labelledby="retro-mine" class="stack">
        <h2 id="retro-mine">내 회고</h2>
        <ul class="plain" data-testid="retro-mine">
          <li v-for="r in mine" :key="r.id">
            {{ r.institution?.name ?? r.institutionLabel ?? '기관' }} · {{ STATUS_TEXT[r.status] }}
            <ModerationNotice v-if="r.moderation" :notice="r.moderation" :id-prefix="`retro-notice-${r.id}`" />
            <button v-if="r.status !== 'withdrawn'" type="button" class="link-button" @click="withdraw(r.id)">철회</button>
          </li>
        </ul>
      </section>
      <p><NuxtLink to="/community">커뮤니티로 돌아가기</NuxtLink></p>
    </template>
  </div>
</template>

<style scoped>
.retros-page dd {
  margin: 0 0 0.5rem;
  overflow-wrap: anywhere;
}
</style>
