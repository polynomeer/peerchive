<script setup lang="ts">
/**
 * 공개 준비·게시(T-11·T-12, PROOFU_EVOLUTION_PLAN §9.3): 공개 수준 → 고르기 → 점검(경고) → 미리보기 → 팀원 동의 → 게시 → (철회).
 * - 후보는 owner/editor가 만들고, 나머지 멤버는 읽기만 합니다. 게시·철회는 owner만(서버가 게시 때 모든 조건을 다시 검사).
 * - 게시 중에도 다음 버전 후보를 만들 수 있고, 새 버전을 게시하기 전까지 지금 공개 버전이 계속 보입니다.
 * - 미리보기는 서버가 저장한 공개 스냅샷만으로 그립니다(PublicSnapshotView).
 */
import type {
  CandidatePreviewDto,
  ExposureMode,
  PublicationCandidateDto,
  PublicationLevel,
  PublicationStateDto,
  PublicationSummaryDto,
  PublishResultDto,
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
  metadata_not_stripped: '메타데이터(위치 정보 등)를 아직 지우지 않은 이전 이미지가 있습니다. 운영자가 정리 작업을 마친 뒤 다시 시도하거나 새 버전으로 다시 올리세요.',
  not_allowed: '요약 공개에는 파일을 넣을 수 없습니다.',
  not_member: '이 과제의 멤버가 아닌 사람이 있습니다.',
  taken: '이미 다른 공개가 쓰는 주소입니다.',
  locked: '한 번 게시한 공개의 주소는 바꿀 수 없습니다.',
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
  const c = candidate.value
  if (!c?.canExcludeDeclined) return
  if (!confirm('동의하지 않은(또는 동의를 철회한) 사람의 로그·선언·파일·이름을 뺀 새 후보를 만듭니다. 자기 관련 내용이 그대로인 사람의 동의만 이어받고 나머지는 다시 요청합니다. 계속할까요?'))
    return
  try {
    await $fetch(`/api/v1/candidates/${c.id}/exclude-declined`, { method: 'POST', body: {} })
    await refresh()
    await loadPreview()
    notice.value = { kind: 'ok', text: '동의하지 않은 사람의 자료를 뺀 새 후보를 만들었습니다.' }
  } catch (e) {
    notice.value = { kind: 'error', text: PUBLICATION_ERROR_MESSAGES[apiError(e).code] ?? '새 후보를 만들지 못했습니다.' }
  }
}

// ── 게시 ──
const publishDialog = ref<HTMLDialogElement | null>(null)
const publishing = ref(false)
const exposedNames = computed(() => (preview.value?.snapshot.members ?? []).map((m) => m.label))
const fileNames = computed(() => (preview.value?.snapshot.artifacts ?? []).map((a) => a.displayName))

async function openPublishDialog() {
  if (!candidate.value?.canPublish) return
  if (!preview.value || preview.value.candidateId !== candidate.value.id) await loadPreview()
  publishDialog.value?.showModal()
}

async function publish() {
  const c = candidate.value
  if (!c) return
  publishing.value = true
  notice.value = null
  try {
    const result = await $fetch<PublishResultDto>(`/api/v1/candidates/${c.id}/publish`, {
      method: 'POST',
      // 내가 본 후보의 해시. 그 사이 내용이 바뀌었으면 서버가 409로 거부합니다. 재시도해도 한 번만 게시됩니다.
      body: { manifestHash: c.manifestHash, idempotencyKey: crypto.randomUUID() },
    })
    publishDialog.value?.close()
    await refresh()
    await loadPreview()
    notice.value = { kind: 'ok', text: `공개 버전 v${result.release.version}을 게시했습니다.` }
  } catch (e) {
    publishDialog.value?.close()
    const err = apiError(e)
    notice.value = { kind: 'error', text: PUBLICATION_ERROR_MESSAGES[err.code] ?? '게시하지 못했습니다. 다시 시도하세요.' }
    await refresh()
  } finally {
    publishing.value = false
  }
}

// ── 철회 ──
const withdrawDialog = ref<HTMLDialogElement | null>(null)
const withdrawReason = ref('')
const withdrawing = ref(false)
async function withdraw() {
  const pub = state.value?.publication
  if (!pub) return
  withdrawing.value = true
  notice.value = null
  try {
    await $fetch<PublicationSummaryDto>(`/api/v1/publications/${pub.id}/withdraw`, {
      method: 'POST',
      body: { reason: withdrawReason.value || null },
    })
    withdrawDialog.value?.close()
    withdrawReason.value = ''
    await refresh()
    notice.value = { kind: 'ok', text: '공개를 철회했습니다. 공개 페이지와 파일은 이제 열리지 않습니다.' }
  } catch (e) {
    withdrawDialog.value?.close()
    const err = apiError(e)
    notice.value = { kind: 'error', text: PUBLICATION_ERROR_MESSAGES[err.code] ?? (err.status === 422 ? '철회 사유는 300자까지 쓸 수 있습니다.' : '철회하지 못했습니다. 다시 시도하세요.') }
  } finally {
    withdrawing.value = false
  }
}

const published = computed(() => state.value?.publication?.status === 'published')
const isRelease = computed(() => candidate.value?.releaseNo != null)

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
        <span v-if="!published" class="badge private">🔒 지금은 팀만 보기</span>
        <span v-else class="badge">🌐 공개 중</span>
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
      <!-- 운영 조치·보류 안내(T-15): 당사자용 사유만, 이의제기는 owner만 -->
      <section v-if="state.moderation.length || state.holds.length" aria-label="운영 안내">
        <ModerationNotice v-for="n in state.moderation" :key="n.actionId" :notice="n" :id-prefix="`pub-${n.actionId}`" @appealed="refresh()" />
        <p v-if="state.holds.length" class="notice" role="status">
          신고({{ state.holds.map((h) => REPORT_REASON_LABELS[h.reason]).join(', ') }})를 운영자가 검토하는 중이라 새 게시가 보류되어 있습니다.
          지금 공개 중인 버전은 그대로 보입니다. 검토가 끝나면 다시 게시할 수 있습니다.
        </p>
      </section>

      <!-- 공개 상태(게시·철회) -->
      <section v-if="state.publication && (state.publication.firstPublishedAt || state.releases.length)" class="card" aria-labelledby="release-heading">
        <h2 id="release-heading">공개 상태</h2>
        <template v-if="state.publication.currentRelease && state.publication.publicPath">
          <p>
            <strong>공개 버전 v{{ state.publication.currentRelease.version }}</strong> 게시 중 · 게시일 {{ formatDateTime(state.publication.currentRelease.publishedAt) }}
          </p>
          <p>공개 주소: <NuxtLink :to="state.publication.publicPath" class="mono">{{ state.publication.publicPath }}</NuxtLink></p>
          <p class="hint">로그인하지 않은 사람도 이 주소로 볼 수 있습니다. 다음 버전 후보를 만들어도 새 버전을 게시하기 전까지 지금 버전이 보입니다.</p>
          <div v-if="state.canManage" class="actions">
            <button type="button" class="danger" @click="withdrawDialog?.showModal()">공개 철회</button>
          </div>
        </template>
        <template v-else-if="state.publication.status === 'restricted'">
          <p><strong>운영 조치로 비공개</strong></p>
          <p class="hint">공개 페이지와 파일은 열리지 않습니다. 위 안내의 사유를 확인하세요. 조치가 풀리면 새 후보를 만들어 동의를 다시 받고 게시해야 합니다.</p>
        </template>
        <template v-else-if="state.publication.status === 'withdrawn'">
          <p>
            <strong>철회됨</strong><template v-if="state.publication.withdrawnAt"> · {{ formatDateTime(state.publication.withdrawnAt) }}</template>
            <template v-if="state.publication.withdrawCause"> · {{ WITHDRAW_CAUSE_LABELS[state.publication.withdrawCause] }}</template>
          </p>
          <p v-if="state.publication.withdrawNote" class="small">사유: “{{ state.publication.withdrawNote }}”</p>
          <p class="hint">공개 페이지와 파일은 열리지 않습니다. 다시 공개하려면 새 후보를 만들어 동의를 받고 게시하세요.</p>
        </template>
        <h3>게시 이력</h3>
        <ol class="plain">
          <li v-for="r in state.releases" :key="r.candidateId" class="row">
            <span>v{{ r.version }} · {{ r.title }} <span class="small muted">· {{ LEVEL_LABELS[r.level] }} · 후보 {{ r.candidateVersion }}</span></span>
            <span class="small">
              {{ CANDIDATE_STATUS_LABELS[r.status] }} · 게시 {{ formatDateTime(r.publishedAt) }}
              <template v-if="r.replacedAt"> · 바뀜 {{ formatDateTime(r.replacedAt) }}</template>
              <template v-if="r.withdrawnAt"> · 철회 {{ formatDateTime(r.withdrawnAt) }}</template>
            </span>
          </li>
        </ol>
      </section>

      <dialog ref="withdrawDialog" class="confirm-dialog" aria-labelledby="withdraw-dialog-title">
        <form method="dialog" class="stack" @submit.prevent="withdraw">
          <h2 id="withdraw-dialog-title">공개를 철회할까요?</h2>
          <p>공개 페이지와 파일이 바로 닫히고, 다시 공개하려면 새 후보를 만들어 동의를 다시 받아야 합니다.</p>
          <p class="notice error">{{ COPY_RECALL_NOTICE }}</p>
          <div class="field">
            <label for="withdraw-reason">사유(선택, 300자, 팀에게만 보임)</label>
            <textarea id="withdraw-reason" v-model="withdrawReason" maxlength="300" />
          </div>
          <div class="actions">
            <button type="submit" class="danger" :disabled="withdrawing">{{ withdrawing ? '철회하는 중…' : '철회' }}</button>
            <button type="button" class="secondary" @click="withdrawDialog?.close()">취소</button>
          </div>
        </form>
      </dialog>

      <!-- 현재 후보 -->
      <section v-if="candidate" class="card" aria-labelledby="candidate-heading">
        <h2 id="candidate-heading">
          <template v-if="isRelease">공개 버전 v{{ candidate.releaseNo }} (후보 {{ candidate.version }})</template>
          <template v-else>현재 후보 (버전 {{ candidate.version }})</template>
        </h2>
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

        <template v-if="openCandidate">
          <h3>게시를 막는 것</h3>
          <p v-if="candidate.blockers.length === 0" class="notice ok">모든 동의와 파일 검사가 끝났습니다. 게시 준비 완료.</p>
          <ul v-else>
            <li v-for="(b, i) in candidate.blockers" :key="i">{{ blockerLabel(b, nameOf) }}</li>
          </ul>
        </template>
        <div class="actions">
          <button v-if="candidate.canExcludeDeclined" type="button" class="secondary" @click="excludeDeclined">
            {{ openCandidate ? '동의하지 않은 사람 자료 빼고 새 후보' : '동의를 철회·거절한 사람 자료 빼고 새 후보' }}
          </button>
          <button v-if="openCandidate && state.canManage" type="button" :disabled="!candidate.canPublish || publishing" aria-describedby="publish-note" @click="openPublishDialog">
            {{ published ? `새 버전으로 게시(v${(state.publication?.currentRelease?.version ?? 0) + 1})` : '게시' }}
          </button>
        </div>
        <p v-if="openCandidate" id="publish-note" class="hint">
          {{ state.canManage ? PUBLISH_NOTE : '게시는 운영 책임자(owner)가 합니다.' }}
        </p>
      </section>

      <dialog ref="publishDialog" class="confirm-dialog" aria-labelledby="publish-dialog-title">
        <form v-if="candidate" method="dialog" class="stack" @submit.prevent="publish">
          <h2 id="publish-dialog-title">이 내용으로 게시할까요?</h2>
          <dl class="kv">
            <dt>공개 수준</dt>
            <dd>{{ LEVEL_LABELS[candidate.level] }}</dd>
            <dt>공개 주소</dt>
            <dd class="mono">/p/{{ candidate.slug }}</dd>
            <dt>보이는 이름</dt>
            <dd>{{ exposedNames.length ? exposedNames.join(', ') : '없음(제목·요약만)' }}</dd>
            <dt>파일</dt>
            <dd>{{ fileNames.length ? fileNames.join(', ') : '없음' }}</dd>
          </dl>
          <p v-if="published" class="hint">게시하면 지금 공개 버전은 새 버전으로 바뀌고, 이전 버전의 파일은 더 이상 열리지 않습니다.</p>
          <p class="hint">로그인하지 않은 사람도 볼 수 있습니다. 언제든 철회할 수 있습니다.</p>
          <p class="notice error">{{ COPY_RECALL_NOTICE }}</p>
          <div class="actions">
            <button type="submit" :disabled="publishing">{{ publishing ? '게시하는 중…' : '게시' }}</button>
            <button type="button" class="secondary" @click="publishDialog?.close()">취소</button>
          </div>
        </form>
      </dialog>

      <!-- 미리보기 -->
      <section v-if="preview" class="card" aria-labelledby="preview-heading">
        <h2 id="preview-heading">미리보기</h2>
        <p class="hint">공개 페이지가 보여 줄 내용 그대로입니다(저장된 스냅샷).</p>
        <PublicSnapshotView :snapshot="preview.snapshot" preview id-prefix="publish-preview" />
      </section>

      <!-- 후보 만들기 -->
      <section v-if="state.canPrepare" class="card" aria-labelledby="form-heading">
        <h2 id="form-heading">{{ openCandidate ? '새 후보로 바꾸기' : published ? '다음 공개 버전 후보 만들기' : '공개 후보 만들기' }}</h2>
        <p v-if="published && !openCandidate" class="hint">새 버전을 게시하기 전까지 지금 공개 버전이 그대로 보입니다.</p>
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
            <input id="pub-slug" v-model="form.slug" class="mono" autocomplete="off" :disabled="!canPrepare" :readonly="state.publication?.slugLocked" :aria-invalid="errors.slug ? 'true' : undefined" aria-describedby="pub-slug-hint" />
            <p id="pub-slug-hint" class="hint">
              <template v-if="state.publication?.slugLocked">한 번 게시한 공개의 주소는 바꿀 수 없습니다.</template>
              <template v-else>영문 소문자·숫자·하이픈 3–60자. 예: library-crowd-2026</template>
            </p>
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
