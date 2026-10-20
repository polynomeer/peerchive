<script setup lang="ts">
/**
 * 동의 요청(T-11, PROOFU_EVOLUTION_PLAN §9.3 "팀원 동의 요청"). 내가 결정할 공개 후보를 보고, 공개될 내용(미리보기)을 확인한 뒤
 * 동의하거나 동의하지 않습니다. 동의는 지금 보이는 내용(해시)에만 적용되며, 내용이 바뀌면 다시 묻습니다.
 * 나간 멤버도 자기 관련 공개라면 여기서 결정할 수 있습니다.
 * 게시된 공개(T-12)는 "내 동의 철회"로 언제든 공개를 닫을 수 있습니다(공개 페이지·파일이 바로 닫힘).
 */
import type {
  CandidatePreviewDto,
  ConsentRequestDto,
  ConsentRevokeResultDto,
  MyPublishedConsentDto,
  PublicationCandidateDto,
} from '~~/shared/types/api'

definePageMeta({ middleware: 'auth' })
useHead({ title: '동의 요청 — Peerchive', meta: [{ name: 'robots', content: 'noindex' }] })

const route = useRoute()
const selectedId = computed(() => (typeof route.query.candidate === 'string' ? route.query.candidate : null))

const { data: requests, refresh: refreshRequests } = await useFetch<ConsentRequestDto[]>('/api/v1/me/consent-requests', { default: () => [] })
const { data: published, refresh: refreshPublished } = await useFetch<MyPublishedConsentDto[]>('/api/v1/me/publication-consents', {
  default: () => [],
})

// ── 게시된 공개의 동의 철회 ──
const revokeDialog = ref<HTMLDialogElement | null>(null)
const revokeTarget = ref<MyPublishedConsentDto | null>(null)
const revokeNote = ref('')
const revoking = ref(false)
function askRevoke(item: MyPublishedConsentDto) {
  revokeTarget.value = item
  revokeNote.value = ''
  revokeDialog.value?.showModal()
}
async function revoke() {
  const item = revokeTarget.value
  if (!item) return
  revoking.value = true
  notice.value = null
  try {
    await $fetch<ConsentRevokeResultDto>(`/api/v1/publications/${item.publicationId}/consents/revoke`, {
      method: 'POST',
      body: { note: revokeNote.value || null },
    })
    revokeDialog.value?.close()
    notice.value = { kind: 'ok', text: `“${item.publicTitle}” 공개에 대한 동의를 철회했습니다. 공개 페이지와 파일은 이제 열리지 않습니다.` }
    await refreshPublished()
  } catch (e) {
    revokeDialog.value?.close()
    const err = apiError(e)
    notice.value = { kind: 'error', text: err.status === 422 ? '메모는 300자까지 쓸 수 있습니다.' : '동의를 철회하지 못했습니다. 다시 시도하세요.' }
  } finally {
    revoking.value = false
  }
}

const candidate = ref<PublicationCandidateDto | null>(null)
const preview = ref<CandidatePreviewDto | null>(null)
const loadError = ref(false)
const note = ref('')
const busy = ref(false)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)

async function load() {
  candidate.value = null
  preview.value = null
  loadError.value = false
  if (!selectedId.value) return
  try {
    const [c, p] = await Promise.all([
      $fetch<PublicationCandidateDto>(`/api/v1/candidates/${selectedId.value}`),
      $fetch<CandidatePreviewDto>(`/api/v1/candidates/${selectedId.value}/preview`),
    ])
    candidate.value = c
    preview.value = p
  } catch {
    loadError.value = true
  }
}
watch(selectedId, load)
onMounted(load)

const mySubject = computed(() => candidate.value?.subjects.find((s) => s.userId === useAuth().me.value?.id) ?? null)

async function decide(decision: 'granted' | 'declined') {
  if (!candidate.value || !preview.value) return
  busy.value = true
  notice.value = null
  try {
    candidate.value = await $fetch<PublicationCandidateDto>(`/api/v1/candidates/${candidate.value.id}/consents`, {
      method: 'POST',
      // 내가 본 미리보기의 해시를 보냅니다. 그 사이 내용이 바뀌었으면 서버가 409로 거부합니다.
      body: { decision, manifestHash: preview.value.manifestHash, note: note.value || null },
    })
    notice.value = { kind: 'ok', text: decision === 'granted' ? '동의했습니다.' : '동의하지 않음으로 기록했습니다. 운영 책임자가 내 자료를 뺀 새 후보를 만들 수 있습니다.' }
    await refreshRequests()
  } catch (e) {
    const err = apiError(e)
    notice.value = { kind: 'error', text: PUBLICATION_ERROR_MESSAGES[err.code] ?? (err.status === 422 ? fieldMessage(err.fields.note) ?? '입력을 확인하세요.' : '저장하지 못했습니다. 다시 시도하세요.') }
    if (err.code === 'stale_manifest' || err.code === 'superseded') await load()
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div>
    <h1>동의 요청</h1>
    <p class="hint">
      팀 과제를 공개하려면 이름·로그·역할 선언·회의 참석·올린 파일이 들어간 사람 모두의 동의가 필요합니다. 동의는 아래 미리보기 내용에만 적용되고, 내용이 바뀌면 다시 묻습니다.
      동의하지 않으면 내 자료는 빠지거나 공개가 보류됩니다.
    </p>

    <section class="card" aria-labelledby="pending-heading">
      <h2 id="pending-heading">결정을 기다리는 요청</h2>
      <p v-if="requests.length === 0" class="muted">기다리는 요청이 없습니다.</p>
      <ul v-else class="plain">
        <li v-for="r in requests" :key="r.candidateId" class="row">
          <span>
            <strong>{{ r.publicTitle }}</strong>
            <span class="small muted"> · 과제 “{{ r.projectTitle }}” · {{ LEVEL_LABELS[r.level] }} · {{ r.requestedBy }} 요청 · {{ formatDateTime(r.requestedAt) }}</span>
            <br />
            <span class="small">나와 관련된 것: {{ r.scope.map((x) => SCOPE_LABELS[x] ?? x).join(' · ') }}</span>
          </span>
          <NuxtLink :to="r.previewUrl" :aria-current="r.candidateId === selectedId ? 'page' : undefined">미리보기·결정</NuxtLink>
        </li>
      </ul>
    </section>

    <section class="card" aria-labelledby="published-heading">
      <h2 id="published-heading">내가 동의해 게시된 공개</h2>
      <p v-if="published.length === 0" class="muted">게시 중인 공개가 없습니다.</p>
      <ul v-else class="plain">
        <li v-for="p in published" :key="p.publicationId" class="row">
          <span>
            <NuxtLink :to="p.publicPath"><strong>{{ p.publicTitle }}</strong></NuxtLink>
            <span class="small muted"> · 과제 “{{ p.projectTitle }}” · 공개 버전 v{{ p.version }} · 게시 {{ formatDateTime(p.publishedAt) }}</span>
            <br />
            <span class="small">나와 관련된 것: {{ p.scope.map((x) => SCOPE_LABELS[x] ?? x).join(' · ') }}</span>
          </span>
          <button type="button" class="danger" @click="askRevoke(p)">내 동의 철회</button>
        </li>
      </ul>
    </section>

    <dialog ref="revokeDialog" class="confirm-dialog" aria-labelledby="revoke-dialog-title">
      <form v-if="revokeTarget" method="dialog" class="stack" @submit.prevent="revoke">
        <h2 id="revoke-dialog-title">“{{ revokeTarget.publicTitle }}” 공개에 대한 동의를 철회할까요?</h2>
        <p>철회하면 이 공개 전체가 바로 닫힙니다(공개 페이지·파일). 운영 책임자가 내 자료를 뺀 새 후보를 만들어 다시 공개할 수 있습니다.</p>
        <p class="notice error">{{ COPY_RECALL_NOTICE }}</p>
        <div class="field">
          <label for="revoke-note">메모(선택, {{ CONSENT_NOTE_MAX }}자) — 팀원에게 보입니다</label>
          <textarea id="revoke-note" v-model="revokeNote" :maxlength="CONSENT_NOTE_MAX" />
        </div>
        <div class="actions">
          <button type="submit" class="danger" :disabled="revoking">{{ revoking ? '철회하는 중…' : '동의 철회' }}</button>
          <button type="button" class="secondary" @click="revokeDialog?.close()">취소</button>
        </div>
      </form>
    </dialog>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <template v-if="selectedId">
      <p v-if="loadError" class="notice error" role="alert">이 요청을 열 수 없습니다. 없는 후보이거나 볼 수 있는 권한이 없습니다.</p>
      <template v-else-if="candidate && preview">
        <section class="card" aria-labelledby="decision-heading">
          <h2 id="decision-heading">내 결정</h2>
          <p>
            상태: <strong>{{ CANDIDATE_STATUS_LABELS[candidate.status] }}</strong>
            <template v-if="candidate.myConsent"> · 내 동의: <strong>{{ CONSENT_STATUS_LABELS[candidate.myConsent] }}</strong></template>
          </p>
          <p v-if="mySubject" class="small">
            나와 관련된 것: {{ mySubject.scope.map((x) => SCOPE_LABELS[x] ?? x).join(' · ') }}
            <template v-if="mySubject.memberKey"> · 공개 표시: {{ preview.snapshot.members.find((m) => m.key === mySubject!.memberKey)?.label }}</template>
          </p>
          <p class="small muted">내용 해시 <span class="mono">{{ preview.manifestHash.slice(0, 12) }}…</span> — 이 내용에 대한 결정입니다.</p>
          <template v-if="candidate.canDecide">
            <div class="field">
              <label for="consent-note">메모(선택, {{ CONSENT_NOTE_MAX }}자) — 팀원에게 보입니다</label>
              <textarea id="consent-note" v-model="note" :maxlength="CONSENT_NOTE_MAX" placeholder="예: 제 이름 대신 익명으로 해 주세요" />
            </div>
            <div class="actions">
              <button type="button" :disabled="busy" @click="decide('granted')">이 내용 공개에 동의</button>
              <button type="button" class="danger" :disabled="busy" @click="decide('declined')">동의하지 않음</button>
            </div>
            <p class="hint">게시 전까지는 결정을 바꿀 수 있습니다. 게시된 뒤에는 위 “내가 동의해 게시된 공개”에서 동의를 철회할 수 있습니다.</p>
          </template>
          <p v-else class="hint">
            {{
              candidate.status === 'superseded'
                ? '이 후보는 새 후보로 대체되었습니다. 결정할 수 없습니다.'
                : candidate.status === 'published'
                  ? '게시된 공개입니다. 동의를 철회하려면 위 목록의 “내 동의 철회”를 쓰세요.'
                  : candidate.status === 'withdrawn' || candidate.status === 'replaced'
                    ? '철회되었거나 새 버전으로 바뀐 공개입니다.'
                    : '이 후보에 결정할 당사자가 아닙니다.'
            }}
          </p>
        </section>

        <section class="card" aria-labelledby="consent-preview-heading">
          <h2 id="consent-preview-heading">공개될 내용 미리보기</h2>
          <PublicSnapshotView :snapshot="preview.snapshot" preview id-prefix="consent-preview" />
        </section>
      </template>
    </template>
  </div>
</template>
