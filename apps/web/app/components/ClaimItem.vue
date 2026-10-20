<script setup lang="ts">
/**
 * 역할 선언 한 건(T-08): 작성자·문장·근거·상태(글자)·팀원 확인과 이의, 수정 이력.
 * - 다른 멤버(owner/editor/reviewer)는 [확인] 또는 [이의 제기 + 메모]를 남기고 바꾸거나 철회할 수 있습니다.
 * - 작성자는 [고치기]로 새 버전을 만듭니다(ClaimForm이 확인 초기화 안내를 보여 줌). owner도 남의 선언은 고칠 수 없습니다.
 */
import type { ClaimDto, ClaimRevisionDto, EndorsementStatus } from '~~/shared/types/api'

const props = defineProps<{ claim: ClaimDto; meId: string | null }>()
const emit = defineEmits<{ updated: [claim: ClaimDto]; reload: [] }>()

const base = computed(() => `claim-${props.claim.id}`)
const notice = ref<{ kind: 'ok' | 'error'; text: string } | null>(null)
const busy = ref(false)
const editing = ref(false)

// ── 확인·이의 ──
const disputing = ref(false)
const note = ref('')
const noteError = ref<string | null>(null)

function openDispute() {
  disputing.value = true
  note.value = props.claim.endorsements.find((e) => e.endorser.userId === props.meId)?.note ?? ''
  void nextTick(() => document.getElementById(`${base.value}-note`)?.focus())
}

async function endorse(status: EndorsementStatus) {
  busy.value = true
  noteError.value = null
  try {
    const updated = await $fetch<ClaimDto>(`/api/v1/claim-revisions/${props.claim.revisionId}/endorsement`, {
      method: 'PUT',
      body: { status, note: status === 'disputed' ? note.value : null },
    })
    disputing.value = false
    note.value = ''
    notice.value = { kind: 'ok', text: status === 'confirmed' ? '이 선언을 확인했습니다.' : '이의를 남겼습니다.' }
    emit('updated', updated)
  } catch (e) {
    const error = apiError(e)
    if (error.status === 422 && error.fields.note) noteError.value = error.fields.note === 'required' ? '무엇이 다른지 메모를 적어 주세요.' : fieldMessage(error.fields.note) ?? null
    else {
      notice.value = { kind: 'error', text: claimErrorMessage(error.code, '저장하지 못했습니다. 다시 시도하세요.') }
      if (error.status === 409) emit('reload')
    }
  } finally {
    busy.value = false
  }
}

async function withdraw() {
  busy.value = true
  try {
    await $fetch(`/api/v1/claim-revisions/${props.claim.revisionId}/endorsement`, { method: 'DELETE' })
    notice.value = { kind: 'ok', text: '내 응답을 철회했습니다.' }
    emit('reload')
  } catch (e) {
    notice.value = { kind: 'error', text: claimErrorMessage(apiError(e).code, '철회하지 못했습니다. 다시 시도하세요.') }
    emit('reload')
  } finally {
    busy.value = false
  }
}

// ── 수정 ──
function onSaved(updated: ClaimDto) {
  editing.value = false
  history.value = null
  notice.value = { kind: 'ok', text: `새 버전(${updated.revisionNo})으로 저장했습니다. 팀원 확인을 다시 받아야 합니다.` }
  emit('updated', updated)
}

// ── 이력 ──
const showHistory = ref(false)
const history = ref<ClaimRevisionDto[] | null>(null)
const historyError = ref(false)
async function toggleHistory() {
  showHistory.value = !showHistory.value
  if (!showHistory.value || history.value) return
  try {
    history.value = await $fetch<ClaimRevisionDto[]>(`/api/v1/claims/${props.claim.id}/revisions`)
    historyError.value = false
  } catch {
    historyError.value = true
  }
}
watch(
  () => props.claim.revisionNo,
  () => {
    history.value = null
    if (showHistory.value) {
      showHistory.value = false
      void toggleHistory()
    }
  },
)

const endorsementText = (status: EndorsementStatus) => (status === 'confirmed' ? '확인함' : '이의 제기')
</script>

<template>
  <article class="claim-item" :aria-labelledby="`${base}-text`">
    <p class="claim-head">
      <strong>{{ claim.author.displayName || '이름 미설정' }}</strong>
      <span v-if="!claim.authorActive" class="muted"> (나간 멤버)</span>
      <span v-if="claim.author.userId === meId" class="muted"> (나)</span>
      <span :class="['badge', `claim-${claim.status}`]">{{ claimStatusLabel(claim) }}</span>
    </p>
    <p :id="`${base}-text`" class="claim-text">{{ claim.text }}</p>
    <p class="muted small">
      버전 {{ claim.revisionNo }} · {{ formatDateTime(claim.recordedAt) }} 저장
    </p>

    <ul v-if="claim.evidence.length" class="chips plain-inline claim-evidence" aria-label="근거">
      <li v-for="(evidence, i) in claim.evidence" :key="i" class="chip">
        <a v-if="evidence.kind === 'artifact' && evidence.contentUrl" :href="evidence.contentUrl" target="_blank" rel="noopener">{{ evidenceLabel(evidence) }}</a>
        <span v-else>{{ evidenceLabel(evidence) }}</span>
      </li>
    </ul>
    <p v-else class="muted small">근거 없음</p>

    <ul v-if="claim.endorsements.length" class="plain claim-endorsements" aria-label="팀원 응답(이 버전)">
      <li v-for="e in claim.endorsements" :key="e.endorser.userId">
        {{ e.endorser.displayName || '이름 미설정' }} — {{ endorsementText(e.status) }}<template v-if="e.note">: “{{ e.note }}”</template>
      </li>
    </ul>

    <p v-if="notice" :class="['notice', notice.kind]" :role="notice.kind === 'error' ? 'alert' : 'status'">{{ notice.text }}</p>

    <div v-if="claim.canEndorse && !disputing" class="actions">
      <span v-if="claim.myEndorsement" class="muted">내 응답: {{ endorsementText(claim.myEndorsement) }}</span>
      <button v-if="claim.myEndorsement !== 'confirmed'" type="button" :disabled="busy" @click="endorse('confirmed')">확인</button>
      <button type="button" class="secondary" :disabled="busy" @click="openDispute">{{ claim.myEndorsement === 'disputed' ? '이의 메모 고치기' : '이의 제기' }}</button>
      <button v-if="claim.myEndorsement" type="button" class="secondary" :disabled="busy" @click="withdraw">철회</button>
    </div>
    <form v-if="disputing" class="stack" novalidate @submit.prevent="endorse('disputed')">
      <div class="field">
        <label :for="`${base}-note`">이의 메모 (필수, {{ ENDORSEMENT_NOTE_MAX }}자 이내)</label>
        <textarea
          :id="`${base}-note`"
          v-model="note"
          :maxlength="ENDORSEMENT_NOTE_MAX"
          rows="2"
          :aria-invalid="noteError ? 'true' : undefined"
          :aria-describedby="[`${base}-note-hint`, noteError ? `${base}-note-error` : ''].filter(Boolean).join(' ')"
        />
        <p :id="`${base}-note-hint`" class="hint">
          비난 대신 사실을 적어 주세요. 무엇이 다른지와 근거를 함께 쓰면 좋습니다. 예: “3장 표는 함께 만들었습니다(11/2 회의 로그).”
        </p>
        <p v-if="noteError" :id="`${base}-note-error`" class="field-error">{{ noteError }}</p>
      </div>
      <div class="actions">
        <button type="submit" :disabled="busy">이의 남기기</button>
        <button type="button" class="secondary" @click="disputing = false">취소</button>
      </div>
    </form>

    <div class="actions">
      <button v-if="claim.canRevise && !editing" type="button" class="secondary" @click="editing = true">고치기</button>
      <button type="button" class="link-button" :aria-expanded="showHistory" :aria-controls="`${base}-history`" @click="toggleHistory">
        수정 이력 {{ showHistory ? '닫기' : '보기' }} ({{ claim.revisionCount }}개 버전)
      </button>
    </div>

    <ClaimForm v-if="editing" :project-id="claim.projectId" :id-prefix="`${base}-edit`" :claim="claim" @saved="onSaved" @cancel="editing = false" />

    <div v-if="showHistory" :id="`${base}-history`" class="history">
      <p v-if="historyError" class="field-error">이력을 불러오지 못했습니다.</p>
      <p v-else-if="!history" class="muted">불러오는 중…</p>
      <ol v-else class="plain">
        <li v-for="rev in [...history].reverse()" :key="rev.id">
          <p>
            <strong>버전 {{ rev.revisionNo }}</strong><template v-if="rev.current"> (현재)</template>
            · {{ formatDateTime(rev.recordedAt) }} · 이 버전 기준 {{ claimStatusLabel({ status: rev.status, confirmedCount: rev.endorsements.filter((e) => e.status === 'confirmed').length, disputedCount: rev.endorsements.filter((e) => e.status === 'disputed').length }) }}
          </p>
          <p class="claim-text">{{ rev.text }}</p>
          <p v-if="rev.evidence.length" class="small">근거: {{ rev.evidence.map(evidenceLabel).join(' / ') }}</p>
          <ul v-if="rev.endorsements.length" class="plain small">
            <li v-for="e in rev.endorsements" :key="e.endorser.userId">
              {{ e.endorser.displayName || '이름 미설정' }} — {{ endorsementText(e.status) }}<template v-if="e.note">: “{{ e.note }}”</template>
            </li>
          </ul>
        </li>
      </ol>
    </div>
  </article>
</template>
