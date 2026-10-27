<script setup lang="ts">
/**
 * 운영자 페르소나 주인 확인(S-07, ADR 0036). 신고 상세는 신고된 페르소나 자신의 handle·이름·내용만 보여 줍니다. 계정 단위 조치(정지 등 운영 절차)가
 * 필요할 때만 사유를 적고 확인하며, 확인할 때마다 확인 기록(사유)과 감사(id만)가 남습니다. 결과는 이 화면의 이 응답에만 있고 다시 나오지 않습니다.
 */
import type { PersonaOwnerLookupResultDto } from '~~/shared/types/api'

const props = defineProps<{ reportId: string; idPrefix: string }>()

const reason = ref('')
const result = ref<PersonaOwnerLookupResultDto | null>(null)
const busy = ref(false)
const message = ref<string | null>(null)
const fieldError = ref<string | null>(null)

async function lookup() {
  message.value = null
  fieldError.value = null
  if (!reason.value.trim()) {
    fieldError.value = 'required'
    message.value = '확인 사유를 적어야 합니다.'
    return
  }
  busy.value = true
  try {
    result.value = await $fetch<PersonaOwnerLookupResultDto>('/api/v1/operator/persona-owner-lookups', {
      method: 'POST',
      body: { reportId: props.reportId, reason: reason.value },
    })
    reason.value = ''
  } catch (e) {
    const err = apiError(e)
    fieldError.value = err.fields.reason ?? null
    message.value = err.code === 'validation_failed' ? '입력을 확인하세요.' : moderationErrorMessage(err.code)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack">
    <p v-if="message" class="notice error" role="alert">{{ message }}</p>
    <form v-if="!result" class="stack" @submit.prevent="lookup">
      <p class="hint">
        이 화면은 신고된 프로필 자신만 보여 줍니다. 같은 사람의 다른 프로필(실명·표시명)이나 계정은 계정 단위 조치가 필요할 때만 사유를 적고 확인하세요.
        확인할 때마다 사유와 함께 기록되고 감사 기록에 남습니다. 확인한 내용을 신고자·당사자에게 알리지 마세요.
      </p>
      <div class="field">
        <label :for="`${idPrefix}-reason`">확인 사유(필수, 운영자만 봄)</label>
        <textarea :id="`${idPrefix}-reason`" v-model="reason" rows="2" maxlength="1000" :aria-invalid="!!fieldError" />
      </div>
      <p class="actions"><button type="submit" class="secondary" :disabled="busy">주인 확인</button></p>
    </form>
    <div v-else class="notice" data-testid="persona-owner-result">
      <p>
        계정 <code>{{ result.owner.userId }}</code> · 상태 {{ result.owner.accountStatus }} · 연결 공개 {{ result.owner.linkVisible ? '켜짐' : '꺼짐' }} ·
        걸린 숨김 조치 {{ result.owner.activeActions }}건
      </p>
      <ul class="plain small">
        <li v-for="p in result.owner.personas" :key="p.handle">
          {{ p.kind === 'real' ? '실명' : '표시명' }} · {{ p.displayName }} @{{ p.handle }}<template v-if="p.hidden"> (숨김)</template>
        </li>
      </ul>
      <p class="hint">다른 프로필을 숨기려면 그 프로필의 신고로 따로 처리합니다. 계정 정지는 RUNBOOK의 계정 단위 조치 절차를 따릅니다.</p>
    </div>
  </div>
</template>
