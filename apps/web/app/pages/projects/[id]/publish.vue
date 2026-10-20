<script setup lang="ts">
/**
 * 공개 준비(T-11, PROOFU_EVOLUTION_PLAN §9.3): 공개 수준 → 고르기 → 점검(경고) → 미리보기 → 팀원 동의.
 * - 후보는 owner/editor가 만들고, 나머지 멤버는 읽기만 합니다. 게시 버튼은 T-12에서 열립니다(지금은 비활성 + 안내).
 * - 미리보기는 서버가 저장한 공개 스냅샷만으로 그립니다(PublicSnapshotView).
 */
import type {
  CandidatePreviewDto,
  ExposureMode,
  PublicationCandidateDto,
  PublicationLevel,
  PublicationStateDto,
  UsageTerms,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })

const route = useRoute()
const id = computed(() => String(route.params.id))
const { me } = useAuth()

const { data: state, error, refresh } = await useFetch<PublicationStateDto>(() => `/api/v1/projects/${id.value}/publication`)
useHead({ title: '공개 준비 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const candidate = computed(() => state.value?.candidate ?? null)
const openCandidate = computed(() =>
  candidate.value && (candidate.value.status === 'awaiting_consent' || candidate.value.status === 'ready') ? candidate.value : null,
)
const embargoActive = computed(() => !!state.value?.embargo.active)
const canPrepare = computed(() => !!state.value?.canPrepare && !embargoActive.value)

// ── 폼 ──
type UsageKind = UsageTerms['kind']
const form = reactive({
  level: 'summary' as PublicationLevel,
  title: '',
  summary: '',
  slug: '',
  logIds: [] as string[],
  milestoneIds: [] as string[],
  claimIds: [] as string[],
  artifactVersionIds: [] as string[],
  exposure: {} as Record<string, ExposureMode>,
  usageKind: {} as Record<string, UsageKind>,
  usageSpdx: {} as Record<string, string>,
  usageSource: {} as Record<string, string>,
  consentSelf: false,
})
const errors = ref<Record<string, string>>({})
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const saving = ref(false)

function fillFrom(c: PublicationCandidateDto | null) {
  if (!c) return
  const s = c.selection
  Object.assign(form, {
    level: s.level,
    title: s.title,
    summary: s.summary,
    slug: s.slug,
    logIds: [...s.logIds],
    milestoneIds: [...s.milestoneIds],
    claimIds: [...s.claimIds],
    artifactVersionIds: [...s.artifactVersionIds],
    exposure: { ...s.exposure },
    consentSelf: false,
  })
  for (const [versionId, usage] of Object.entries(s.usageTerms)) {
    form.usageKind[versionId] = usage.kind
    if (usage.kind === 'license') form.usageSpdx[versionId] = usage.spdx
    if (usage.kind === 'external') form.usageSource[versionId] = usage.source
  }
}
fillFrom(candidate.value)
watch(candidate, (c, prev) => {
  if (!c || c.id === prev?.id) return
  fillFrom(c)
  for (const m of state.value?.options.members ?? []) form.exposure[m.userId] ??= 'anonymous'
})

const options = computed(() => state.value?.options)
const exposureMembers = computed(() => options.value?.members ?? [])
// 노출 방식 기본값은 익명.
watch(
  exposureMembers,
  (members) => {
    for (const m of members) form.exposure[m.userId] ??= 'anonymous'
  },
  { immediate: true },
)

function usageFor(versionId: string): UsageTerms {
  const kind = form.usageKind[versionId] ?? 'view_only'
  if (kind === 'license') return { kind, spdx: form.usageSpdx[versionId] ?? 'CC-BY-4.0' }
  if (kind === 'external') return { kind, source: (form.usageSource[versionId] ?? '').trim() }
  return { kind: 'view_only' }
}

async function submit() {
  errors.value = {}
  notice.value = null
  if (openCandidate.value && !confirm('새 후보를 만들면 지금 후보의 동의는 모두 무효가 되고 당사자에게 다시 요청합니다. 계속할까요?')) return
  saving.value = true
  try {
    const full = form.level === 'full'
    const usageTerms: Record<string, UsageTerms> = {}
    if (full) for (const v of form.artifactVersionIds) usageTerms[v] = usageFor(v)
    await $fetch<PublicationCandidateDto>(`/api/v1/projects/${id.value}/publication-candidates`, {
      method: 'POST',
      body: {
        level: form.level,
        title: form.title,
        summary: form.summary,
        slug: form.slug,
        logIds: form.logIds,
        milestoneIds: form.milestoneIds,
        claimIds: form.claimIds,
        artifactVersionIds: full ? form.artifactVersionIds : [],
        exposure: form.exposure,
        usageTerms,
        consentSelf: form.consentSelf,
      },
    })
    await refresh()
    await loadPreview()
    notice.value = { kind: 'ok', text: '공개 후보를 만들고 당사자에게 동의를 요청했습니다.' }
  } catch (e) {
    const err = apiError(e)
    if (err.status === 422) {
      errors.value = err.fields
      notice.value = { kind: 'error', text: '입력을 확인하세요.' }
    } else notice.value = { kind: 'error', text: PUBLICATION_ERROR_MESSAGES[err.code] ?? '후보를 만들지 못했습니다. 다시 시도하세요.' }
  } finally {
    saving.value = false
  }
}

const SELECTION_ERRORS: Record<string, string> = {
  not_found: '이 과제에서 찾을 수 없는 항목이 있습니다. 새로고침 후 다시 고르세요.',
  not_clean: '검사를 통과한(사용 가능) 파일만 고를 수 있습니다.',
  not_allowed: '요약 공개에는 파일을 넣을 수 없습니다.',
  not_member: '이 과제의 멤버가 아닌 사람이 있습니다.',
  taken: '이미 다른 공개가 쓰는 주소입니다.',
  reserved: '사용할 수 없는 주소입니다.',
  invalid_format: '영문 소문자·숫자·하이픈(-)만, 하이픈은 가운데에만 쓸 수 있습니다.',
}
const errorFor = (field: string) => {
  const code = errors.value[field] ?? Object.entries(errors.value).find(([k]) => k.startsWith(`${field}.`))?.[1]
  return code ? (SELECTION_ERRORS[code] ?? fieldMessage(code)) : undefined
}

// ── 미리보기 ──
const preview = ref<CandidatePreviewDto | null>(null)
async function loadPreview() {
  const c = state.value?.candidate
  preview.value = c ? await $fetch<CandidatePreviewDto>(`/api/v1/candidates/${c.id}/preview`).catch(() => null) : null
}
onMounted(loadPreview)

// ── 미동의자 제외 ──
async function excludeDeclined() {
  if (!openCandidate.value) return
  if (!confirm('동의하지 않은 사람의 로그·선언·파일·이름을 뺀 새 후보를 만듭니다. 자기 관련 내용이 그대로인 사람의 동의만 이어받고 나머지는 다시 요청합니다. 계속할까요?'))
    return
  try {
    await $fetch(`/api/v1/candidates/${openCandidate.value.id}/exclude-declined`, { method: 'POST', body: {} })
    await refresh()
    await loadPreview()
    notice.value = { kind: 'ok', text: '동의하지 않은 사람의 자료를 뺀 새 후보를 만들었습니다.' }
  } catch (e) {
    notice.value = { kind: 'error', text: PUBLICATION_ERROR_MESSAGES[apiError(e).code] ?? '새 후보를 만들지 못했습니다.' }
  }
}

const nameOf = (userId: string) => candidate.value?.subjects.find((s) => s.userId === userId)?.displayName ?? '팀원'
const shortHash = (hash: string) => `${hash.slice(0, 12)}…`
const bytes = (n: number) => formatBytes(n)
</script>

<template>
  <div>
    <p><NuxtLink :to="`/projects/${id}`">← 과제로 돌아가기</NuxtLink></p>
    <h1>공개 준비</h1>

    <template v-if="error || !state">
      <p>없는 과제이거나 볼 수 있는 권한이 없습니다.</p>
    </template>

    <template v-else>
      <p class="actions">
        <span class="badge private">🔒 지금은 팀만 보기</span>
        <span v-if="state.publication" class="badge">상태: {{ PUBLICATION_STATUS_LABELS[state.publication.status] }}</span>
        <span v-if="state.embargo.active && state.embargo.until" class="badge embargo">엠바고 {{ seoulDay(state.embargo.until) }}까지</span>
      </p>
      <p class="hint">
        공개는 지금 시점의 <strong>스냅샷</strong>입니다. 고른 로그·마일스톤·선언·파일 버전과 노출 이름만 담기고, 팀원이 그 내용에 동의해야 게시할 수 있습니다.
        작업 공간의 다른 기록·체크인·메모·이메일은 담기지 않습니다.
      </p>
      <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>
      <p v-if="embargoActive" class="notice error" role="status">
        이 과제는 엠바고 중이라 공개 후보를 만들 수 없습니다. 학기가 끝나도 자동으로 공개되지 않습니다.
      </p>

      <!-- 현재 후보 -->
      <section v-if="candidate" class="card" aria-labelledby="candidate-heading">
        <h2 id="candidate-heading">현재 후보 (버전 {{ candidate.version }})</h2>
        <dl class="kv">
          <dt>상태</dt>
          <dd><strong>{{ CANDIDATE_STATUS_LABELS[candidate.status] }}</strong></dd>
          <dt>공개 수준</dt>
          <dd>{{ LEVEL_LABELS[candidate.level] }}</dd>
          <dt>공개 주소 이름</dt>
          <dd class="mono">{{ candidate.slug }}</dd>
          <dt>내용 해시</dt>
          <dd class="mono" :title="candidate.manifestHash">{{ shortHash(candidate.manifestHash) }}</dd>
          <dt>만든 사람</dt>
          <dd>{{ candidate.createdBy.displayName }} · {{ formatDateTime(candidate.createdAt) }}</dd>
          <dt>담긴 것</dt>
          <dd>
            로그 {{ candidate.counts.logs }} · 마일스톤 {{ candidate.counts.milestones }} · 선언 {{ candidate.counts.claims }} · 파일
            {{ candidate.counts.artifacts }} · 사람 {{ candidate.counts.members }}
          </dd>
        </dl>

        <h3>공개 전 점검</h3>
        <p class="hint">경고일 뿐 게시를 막지 않습니다. 판단은 직접 하세요. 고친 뒤에는 새 후보를 만들어야 반영됩니다.</p>
        <p v-if="candidate.checks.length === 0" class="muted">발견된 경고가 없습니다.</p>
        <ul v-else class="plain check-list">
          <li v-for="(c, i) in candidate.checks" :key="i" class="check-item">
            <strong>⚠️ {{ CHECK_RULE_LABELS[c.rule] }}</strong>
            <span class="small"> — {{ CHECK_LOCATION_LABELS[c.location.kind] }}<template v-if="c.location.field !== c.location.kind"> ({{ c.location.field }})</template> · <span class="mono">{{ c.sample }}</span></span>
            <NuxtLink v-if="c.fixUrl" :to="c.fixUrl" class="small"> 고치러 가기</NuxtLink>
            <span v-else class="small muted"> 아래 폼에서 고치기</span>
          </li>
        </ul>

        <h3>동의 현황</h3>
        <ul class="plain">
          <li v-for="s in candidate.subjects" :key="s.userId" class="row">
            <span>
              {{ s.displayName }}<span v-if="!s.active" class="muted"> (나간 멤버)</span><span v-if="s.userId === me?.id" class="muted"> (나)</span>
              <br />
              <span class="small muted">{{ s.scope.map((x) => SCOPE_LABELS[x] ?? x).join(' · ') }}</span>
              <span v-if="s.note" class="small"><br />메모: “{{ s.note }}”</span>
            </span>
            <span class="small">
              <strong>{{ CONSENT_STATUS_LABELS[s.status] }}</strong><template v-if="s.carried"> (이전 동의 이어받음)</template>
            </span>
          </li>
        </ul>
        <p v-if="candidate.canDecide" class="actions">
          <NuxtLink :to="`/consents?candidate=${candidate.id}`">내 동의 결정하기 ({{ candidate.myConsent ? CONSENT_STATUS_LABELS[candidate.myConsent] : '' }})</NuxtLink>
        </p>

        <h3>게시를 막는 것</h3>
        <p v-if="candidate.blockers.length === 0" class="notice ok">모든 동의와 파일 검사가 끝났습니다. 게시 준비 완료.</p>
        <ul v-else>
          <li v-for="(b, i) in candidate.blockers" :key="i">{{ blockerLabel(b, nameOf) }}</li>
        </ul>
        <div class="actions">
          <button v-if="candidate.canExcludeDeclined" type="button" class="secondary" @click="excludeDeclined">동의하지 않은 사람 자료 빼고 새 후보</button>
          <button type="button" disabled aria-describedby="publish-later">게시</button>
        </div>
        <p id="publish-later" class="hint">{{ PUBLISH_LATER_NOTE }}</p>
      </section>

      <!-- 미리보기 -->
      <section v-if="preview" class="card" aria-labelledby="preview-heading">
        <h2 id="preview-heading">미리보기</h2>
        <p class="hint">공개 페이지가 보여 줄 내용 그대로입니다(저장된 스냅샷).</p>
        <PublicSnapshotView :snapshot="preview.snapshot" preview id-prefix="publish-preview" />
      </section>

      <!-- 후보 만들기 -->
      <section v-if="state.canPrepare" class="card" aria-labelledby="form-heading">
        <h2 id="form-heading">{{ openCandidate ? '새 후보로 바꾸기' : '공개 후보 만들기' }}</h2>
        <form class="stack" novalidate @submit.prevent="submit">
          <fieldset :disabled="!canPrepare">
            <legend>공개 수준</legend>
            <label v-for="level in (['summary', 'full'] as const)" :key="level" class="check">
              <input v-model="form.level" type="radio" name="level" :value="level" />
              <span>{{ LEVEL_LABELS[level] }}<br /><span class="hint">{{ LEVEL_HINTS[level] }}</span></span>
            </label>
          </fieldset>

          <div class="field">
            <label for="pub-title">공개 제목 ({{ form.title.length }}/{{ PUBLIC_TITLE_MAX }})</label>
            <input id="pub-title" v-model="form.title" :maxlength="PUBLIC_TITLE_MAX" :disabled="!canPrepare" :aria-invalid="errors.title ? 'true' : undefined" />
            <p v-if="errors.title" class="field-error">{{ fieldMessage(errors.title) }}</p>
          </div>
          <div class="field">
            <label for="pub-summary">학생이 쓴 요약 ({{ form.summary.length }}/{{ PUBLIC_SUMMARY_MAX }})</label>
            <textarea id="pub-summary" v-model="form.summary" :maxlength="PUBLIC_SUMMARY_MAX" :disabled="!canPrepare" :aria-invalid="errors.summary ? 'true' : undefined" />
            <p class="hint">과제 원문(문제지) 대신 내가 쓴 요약을 적어 주세요.</p>
            <p v-if="errors.summary" class="field-error">{{ fieldMessage(errors.summary) }}</p>
          </div>
          <div class="field">
            <label for="pub-slug">공개 주소</label>
            <input id="pub-slug" v-model="form.slug" class="mono" autocomplete="off" :disabled="!canPrepare" :aria-invalid="errors.slug ? 'true' : undefined" aria-describedby="pub-slug-hint" />
            <p id="pub-slug-hint" class="hint">영문 소문자·숫자·하이픈 3–60자. 예: library-crowd-2026</p>
            <p v-if="errors.slug" class="field-error">{{ errorFor('slug') }}</p>
          </div>

          <fieldset :disabled="!canPrepare">
            <legend>마일스톤·스냅샷</legend>
            <p v-if="!options?.milestones.length" class="muted small">마일스톤이 없습니다.</p>
            <label v-for="m in options?.milestones" :key="m.id" class="check">
              <input v-model="form.milestoneIds" type="checkbox" :value="m.id" />
              <span>{{ m.position }}. {{ m.title }} <span class="small muted">· 스냅샷 {{ m.snapshotCount }}개{{ form.level === 'summary' ? '(요약 공개에서는 빠짐)' : '' }}</span><span v-if="m.retrospective" class="badge retro">사후 작성</span></span>
            </label>
            <p v-if="errors.milestoneIds" class="field-error">{{ errorFor('milestoneIds') }}</p>
          </fieldset>

          <fieldset :disabled="!canPrepare">
            <legend>로그</legend>
            <p class="hint">고른 로그는 지금 버전으로 고정됩니다. 나중에 고쳐도 이 후보에는 반영되지 않습니다.</p>
            <p v-if="!options?.logs.length" class="muted small">로그가 없습니다.</p>
            <label v-for="l in options?.logs" :key="l.id" class="check">
              <input v-model="form.logIds" type="checkbox" :value="l.id" />
              <span>
                {{ LOG_TAG_LABELS[l.tag] }} {{ l.summary || '(내용 없음)' }}
                <span class="small muted">· {{ l.author.displayName || '이름 미설정' }} · {{ formatDateTime(l.createdAt) }} · 버전 {{ l.revisionNo }}</span>
                <span v-if="l.retrospective" class="badge retro">사후 작성</span>
              </span>
            </label>
            <p v-if="errors.logIds" class="field-error">{{ errorFor('logIds') }}</p>
          </fieldset>

          <fieldset :disabled="!canPrepare">
            <legend>역할 선언</legend>
            <p v-if="!options?.claims.length" class="muted small">역할 선언이 없습니다.</p>
            <label v-for="c in options?.claims" :key="c.id" class="check">
              <input v-model="form.claimIds" type="checkbox" :value="c.id" />
              <span>“{{ c.text }}” <span class="small muted">· {{ c.author.displayName || '이름 미설정' }} · {{ c.status === 'confirmed' ? '팀원 확인' : c.status === 'disputed' ? '이의 있음' : '미확인' }}</span></span>
            </label>
            <p v-if="errors.claimIds" class="field-error">{{ errorFor('claimIds') }}</p>
          </fieldset>

          <fieldset :disabled="!canPrepare || form.level !== 'full'">
            <legend>파일 (전체 공개만)</legend>
            <p v-if="form.level !== 'full'" class="hint">요약 공개에는 파일이 들어가지 않습니다.</p>
            <p v-else-if="!options?.artifactVersions.length" class="muted small">파일이 없습니다.</p>
            <div v-for="v in form.level === 'full' ? options?.artifactVersions : []" :key="v.versionId" class="file-choice">
              <label class="check">
                <input v-model="form.artifactVersionIds" type="checkbox" :value="v.versionId" :disabled="v.scanStatus !== 'clean'" />
                <span>
                  {{ v.fileName }} <span class="small muted">· 버전 {{ v.versionNo }} · {{ bytes(v.bytes) }} · {{ v.uploader.displayName || '이름 미설정' }}</span>
                  <span v-if="v.scanStatus !== 'clean'" class="small"> — {{ SCAN_STATUS_LABELS[v.scanStatus] }}(고를 수 없음)</span>
                </span>
              </label>
              <div v-if="form.artifactVersionIds.includes(v.versionId)" class="usage">
                <label :for="`usage-${v.versionId}`" class="small">사용 조건</label>
                <select :id="`usage-${v.versionId}`" v-model="form.usageKind[v.versionId]">
                  <option :value="undefined">열람만 허용(기본)</option>
                  <option value="license">명시한 라이선스로 재사용 허용</option>
                  <option value="external">외부 자료의 원래 조건</option>
                </select>
                <select v-if="form.usageKind[v.versionId] === 'license'" v-model="form.usageSpdx[v.versionId]" :aria-label="`${v.fileName} 라이선스`">
                  <option v-for="spdx in options?.licenses" :key="spdx" :value="spdx">{{ spdx }}</option>
                </select>
                <input v-if="form.usageKind[v.versionId] === 'external'" v-model="form.usageSource[v.versionId]" :aria-label="`${v.fileName} 출처`" placeholder="출처(URL·인용)" maxlength="200" />
              </div>
            </div>
            <p v-if="errors.artifactVersionIds" class="field-error">{{ errorFor('artifactVersionIds') }}</p>
            <p v-if="errorFor('usageTerms')" class="field-error">{{ errorFor('usageTerms') }}</p>
          </fieldset>

          <fieldset :disabled="!canPrepare">
            <legend>사람 표시</legend>
            <p class="hint">공개에 내용이 들어간 사람만 표시됩니다. 기본은 익명(팀원 A/B…)이며, 이름을 보이려면 그 사람의 동의가 필요합니다.</p>
            <div v-for="m in exposureMembers" :key="m.userId" class="row">
              <span>{{ m.displayName || '이름 미설정' }}<span v-if="m.status !== 'active'" class="muted small"> (나간 멤버)</span></span>
              <span class="inline-options">
                <label class="check"><input v-model="form.exposure[m.userId]" type="radio" :name="`exp-${m.userId}`" value="anonymous" /> 익명</label>
                <label class="check"><input v-model="form.exposure[m.userId]" type="radio" :name="`exp-${m.userId}`" value="name" /> 이름</label>
              </span>
            </div>
            <p v-if="errors.exposure" class="field-error">{{ errorFor('exposure') }}</p>
          </fieldset>

          <label class="check">
            <input v-model="form.consentSelf" type="checkbox" :disabled="!canPrepare" />
            <span>나도 이 공개 내용에 동의합니다. <span class="hint">(체크하지 않으면 내 동의도 ‘응답 대기’로 남습니다)</span></span>
          </label>

          <div class="actions">
            <button type="submit" :disabled="!canPrepare || saving">{{ saving ? '만드는 중…' : openCandidate ? '새 후보 만들기(동의 다시 요청)' : '후보 만들고 동의 요청' }}</button>
          </div>
        </form>
      </section>
      <p v-else class="hint">공개 후보는 운영 책임자·편집자가 만듭니다. 내 동의가 필요하면 <NuxtLink to="/consents">동의 요청</NuxtLink>에서 결정하세요.</p>
    </template>
  </div>
</template>
