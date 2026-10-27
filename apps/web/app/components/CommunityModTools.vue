<script setup lang="ts">
/**
 * 방 운영진 도구(C-06, ADR 0023): 자기 공간의 글·댓글 가리기·되돌리기와 제재 요청. 방장·admin·moderator(공식 페이지 모더레이터)에게만 보입니다.
 * 운영진도 익명 작성자를 볼 수 없습니다. 제재가 필요하면 대상 글을 가리켜 요청하고, 운영자가 사유를 기록한 뒤 작성자를 확인해 결정합니다.
 */
import type { CommunityPostDto, ReportReason, SanctionRequestReceiptDto } from '~~/shared/types/api'

const props = defineProps<{ kind: 'post' | 'comment'; itemId: string; status: string; spaceHidden: boolean; idPrefix: string }>()
const emit = defineEmits<{ thread: [CommunityPostDto]; changed: []; error: [string]; status: [string] }>()

const REASONS = Object.keys(REPORT_REASON_LABELS) as ReportReason[]
const what = computed(() => (props.kind === 'post' ? '글' : '댓글'))
const base = computed(() => `/api/v1/community/${props.kind === 'post' ? 'posts' : 'comments'}/${props.itemId}`)

const hideDialog = ref<HTMLDialogElement | null>(null)
const requestDialog = ref<HTMLDialogElement | null>(null)
const busy = ref(false)
const formError = ref('')
const hide = reactive({ publicReason: '', note: '' })
const request = reactive({ reason: '' as ReportReason | '', details: '' })
const requested = ref<SanctionRequestReceiptDto | null>(null)

function fail(e: unknown) {
  const err = apiError(e)
  formError.value = err.code === 'validation_failed' ? '입력한 내용을 확인하세요.' : communityErrorMessage(err.code)
}

function openHide() {
  formError.value = ''
  hideDialog.value?.showModal()
}

async function submitHide() {
  formError.value = ''
  if (!hide.publicReason.trim()) {
    formError.value = '작성자에게 보일 사유를 적어 주세요.'
    return
  }
  busy.value = true
  try {
    emit('thread', await $fetch<CommunityPostDto>(`${base.value}/hide`, { method: 'POST', body: { publicReason: hide.publicReason, note: hide.note || null } }))
    hideDialog.value?.close()
    hide.publicReason = ''
    hide.note = ''
    emit('changed')
    emit('status', `${what.value}을 가렸습니다. 작성자에게 사유가 안내됩니다.`)
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function unhide() {
  if (!window.confirm(`방 운영진이 가린 이 ${what.value}을 다시 보이게 할까요?`)) return
  busy.value = true
  try {
    emit('thread', await $fetch<CommunityPostDto>(`${base.value}/unhide`, { method: 'POST', body: {} }))
    emit('changed')
    emit('status', `가린 ${what.value}을 되돌렸습니다.`)
  } catch (e) {
    emit('error', communityErrorMessage(apiError(e).code))
  } finally {
    busy.value = false
  }
}

function openRequest() {
  formError.value = ''
  requested.value = null
  requestDialog.value?.showModal()
}

async function submitRequest() {
  formError.value = ''
  if (!request.reason) {
    formError.value = '사유를 고르세요.'
    return
  }
  if (!request.details.trim()) {
    formError.value = '운영자가 판단할 수 있게 설명을 적어 주세요.'
    return
  }
  busy.value = true
  try {
    requested.value = await $fetch<SanctionRequestReceiptDto>('/api/v1/community/sanction-requests', {
      method: 'POST',
      body: { targetType: props.kind, targetId: props.itemId, reason: request.reason, details: request.details },
    })
    request.reason = ''
    request.details = ''
    emit('changed')
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span class="mod-tools">
    <button v-if="status === 'published'" type="button" class="link-button small" :aria-controls="`${idPrefix}-hide-dialog`" :disabled="busy" @click="openHide">
      {{ what }} 가리기(운영진)
    </button>
    <button v-if="spaceHidden" type="button" class="link-button small" :disabled="busy" @click="unhide">가리기 되돌리기</button>
    <button v-if="status !== 'deleted_by_author'" type="button" class="link-button small" :aria-controls="`${idPrefix}-request-dialog`" @click="openRequest">
      제재 요청
    </button>

    <dialog :id="`${idPrefix}-hide-dialog`" ref="hideDialog" class="confirm-dialog" :aria-labelledby="`${idPrefix}-hide-title`">
      <form class="stack" @submit.prevent="submitHide">
        <h2 :id="`${idPrefix}-hide-title`">{{ what }} 가리기</h2>
        <p class="hint">방 운영진이 가린 {{ what }}은 본문 대신 "운영 조치로 가려진 {{ what }}입니다"로 보입니다. 운영진 누구나 되돌릴 수 있고, 작성자는 이의를 제기할 수 있습니다.</p>
        <div class="field">
          <label :for="`${idPrefix}-hide-reason`">작성자에게 보일 사유</label>
          <input :id="`${idPrefix}-hide-reason`" v-model="hide.publicReason" maxlength="300" required />
        </div>
        <div class="field">
          <label :for="`${idPrefix}-hide-note`">운영자에게 남길 메모(선택)</label>
          <textarea :id="`${idPrefix}-hide-note`" v-model="hide.note" rows="2" maxlength="1000" />
        </div>
        <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
        <p class="actions">
          <button type="submit" :disabled="busy">가리기</button>
          <button type="button" class="secondary" @click="hideDialog?.close()">취소</button>
        </p>
      </form>
    </dialog>

    <dialog :id="`${idPrefix}-request-dialog`" ref="requestDialog" class="confirm-dialog" :aria-labelledby="`${idPrefix}-request-title`">
      <div class="stack">
        <h2 :id="`${idPrefix}-request-title`">제재 요청</h2>
        <template v-if="requested">
          <p role="status">
            {{ requested.created ? '제재 요청을 보냈습니다.' : '이미 이 대상에 보낸 요청이 있습니다.' }} 운영자가 사유를 기록하고 작성자를 확인한 뒤 결정합니다. 누구에게
            제재가 내려졌는지는 알려 드리지 않습니다.
          </p>
          <p class="actions"><button type="button" @click="requestDialog?.close()">닫기</button></p>
        </template>
        <form v-else class="stack" @submit.prevent="submitRequest">
          <p class="hint">
            방 운영진도 익명 작성자를 볼 수 없습니다. 이 {{ what }}을 가리켜 요청하면 운영자가 작성자를 확인해 경고·쓰기 제한을 결정합니다(이 방 범위 제한이어도
            누구인지는 보이지 않습니다).
          </p>
          <fieldset>
            <legend>사유</legend>
            <div v-for="r in REASONS" :key="r" class="radio-row">
              <input :id="`${idPrefix}-req-${r}`" v-model="request.reason" type="radio" :value="r" :name="`${idPrefix}-req-reason`" />
              <label :for="`${idPrefix}-req-${r}`">{{ REPORT_REASON_LABELS[r] }}</label>
            </div>
          </fieldset>
          <div class="field">
            <label :for="`${idPrefix}-req-details`">설명</label>
            <textarea :id="`${idPrefix}-req-details`" v-model="request.details" rows="3" maxlength="1000" :aria-describedby="`${idPrefix}-req-hint`" />
            <p :id="`${idPrefix}-req-hint`" class="hint">{{ request.details.length }}/1000자. 운영자만 봅니다.</p>
          </div>
          <p v-if="formError" class="field-error" role="alert">{{ formError }}</p>
          <p class="actions">
            <button type="submit" :disabled="busy">요청 보내기</button>
            <button type="button" class="secondary" @click="requestDialog?.close()">취소</button>
          </p>
        </form>
      </div>
    </dialog>
  </span>
</template>
