<script setup lang="ts">
/**
 * 신고 버튼 + 대화상자(T-15, ADR 0015). 공개 화면(사례·과목 허브 노트·공개 프로필)에서 씁니다.
 * - 로그인한 사람만 신고할 수 있습니다(파일럿). 버튼을 누르면 그때 클라이언트에서 로그인 여부를 확인하고, 아니면 로그인 안내를 보여 줍니다
 *   (공개 페이지 SSR은 로그인 상태를 읽지 않음).
 * - 대상이 여럿이면(사례 전체 / 그 안의 기록·선언·파일, 프로필 / 대표 케이스) 고를 수 있습니다.
 * - 신고 설명은 운영자만 보고, 신고한 사람은 게시자에게 알려지지 않습니다. 처리 상태는 `/me/reports`에서 봅니다.
 */
import type { ReportReason, ReportReceiptDto } from '~~/shared/types/api'
import type { ReportChoice } from '~/utils/moderation'

const props = withDefaults(defineProps<{ targets: ReportChoice[]; label?: string; idPrefix: string }>(), { label: '신고하기' })

const REASONS = Object.keys(REPORT_REASON_LABELS) as ReportReason[]
const dialog = ref<HTMLDialogElement | null>(null)
const loggedIn = ref<boolean | null>(null)
const choice = ref(props.targets[0]?.id ?? '')
const reason = ref<ReportReason | ''>('')
const details = ref('')
const busy = ref(false)
const error = ref('')
const done = ref<ReportReceiptDto | null>(null)
const hint = computed(() => {
  const target = props.targets.find((t) => t.id === choice.value)
  return target ? communityReportHint(target.targetType) : null
})

async function open() {
  error.value = ''
  done.value = null
  loggedIn.value = !!(await useAuth().ensure())
  dialog.value?.showModal()
}

function close() {
  dialog.value?.close()
}

async function submit() {
  error.value = ''
  const target = props.targets.find((t) => t.id === choice.value)
  if (!target) return
  if (!reason.value) {
    error.value = '신고 사유를 고르세요.'
    return
  }
  busy.value = true
  try {
    done.value = await $fetch<ReportReceiptDto>('/api/v1/reports', {
      method: 'POST',
      body: { targetType: target.targetType, targetRef: target.targetRef, reason: reason.value, details: details.value || null },
    })
    reason.value = ''
    details.value = ''
  } catch (e) {
    error.value = moderationErrorMessage(apiError(e).code)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <span class="report-button">
    <button type="button" class="link-button small" :aria-controls="`${idPrefix}-report-dialog`" @click="open">{{ label }}</button>
    <dialog :id="`${idPrefix}-report-dialog`" ref="dialog" class="confirm-dialog" :aria-labelledby="`${idPrefix}-report-title`">
      <div class="stack">
        <h2 :id="`${idPrefix}-report-title`">신고하기</h2>
        <template v-if="loggedIn === false">
          <p>신고는 로그인한 뒤 할 수 있습니다. 남용을 막고 처리 결과를 알려 드리기 위해서입니다.</p>
          <p class="actions">
            <NuxtLink to="/login">로그인하고 신고하기</NuxtLink>
            <button type="button" class="secondary" @click="close">닫기</button>
          </p>
        </template>
        <template v-else-if="done">
          <p role="status">
            {{ done.created ? '신고가 접수되었습니다.' : '이미 같은 대상을 신고했습니다.' }} 운영자가 검토합니다. 처리 상태는
            <NuxtLink to="/me/reports">내 신고</NuxtLink>에서 볼 수 있어요.
          </p>
          <p class="actions"><button type="button" @click="close">닫기</button></p>
        </template>
        <form v-else class="stack" @submit.prevent="submit">
          <div v-if="targets.length > 1" class="field">
            <label :for="`${idPrefix}-report-target`">무엇을 신고하나요?</label>
            <select :id="`${idPrefix}-report-target`" v-model="choice">
              <option v-for="t in targets" :key="t.id" :value="t.id">{{ t.label }}</option>
            </select>
          </div>
          <p v-else class="small">대상: {{ targets[0]?.label }}</p>
          <p v-if="hint" class="hint" data-testid="community-report-hint">{{ hint }}</p>
          <fieldset>
            <legend>사유</legend>
            <div v-for="r in REASONS" :key="r" class="radio-row">
              <input :id="`${idPrefix}-reason-${r}`" v-model="reason" type="radio" :value="r" :name="`${idPrefix}-reason`" />
              <label :for="`${idPrefix}-reason-${r}`">{{ REPORT_REASON_LABELS[r] }}</label>
              <p v-if="REPORT_REASON_HINTS[r]" class="hint">{{ REPORT_REASON_HINTS[r] }}</p>
            </div>
          </fieldset>
          <div class="field">
            <label :for="`${idPrefix}-report-details`">자세한 내용(선택)</label>
            <textarea :id="`${idPrefix}-report-details`" v-model="details" rows="4" maxlength="1000" :aria-describedby="`${idPrefix}-report-details-hint`" />
            <p :id="`${idPrefix}-report-details-hint`" class="hint">
              {{ details.length }}/1000자. 운영자만 봅니다. 신고한 사람은 게시자에게 알려지지 않습니다. 다른 사람의 개인정보는 다시 적지 마세요.
            </p>
          </div>
          <p v-if="error" class="field-error" role="alert">{{ error }}</p>
          <p class="actions">
            <button type="submit" :disabled="busy">신고 보내기</button>
            <button type="button" class="secondary" @click="close">취소</button>
          </p>
        </form>
      </div>
    </dialog>
  </span>
</template>
