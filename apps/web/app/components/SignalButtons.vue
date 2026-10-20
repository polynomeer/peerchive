<script setup lang="ts">
/**
 * 유용성 신호 버튼(T-13): "나도 여기서 막혔어요"·"도움됐어요". 항목별 개수만 보여 주고(작성자별 합계 없음),
 * 누른 상태는 글자와 aria-pressed로 표시합니다. 로그인하지 않았으면 로그인 안내만 보여 줍니다.
 */
import type { SignalCountsDto, SignalKind, SignalStateDto } from '~~/shared/types/api'
import { type SignalTarget, signalKey, useMySignals } from '~/composables/useMySignals'

const props = defineProps<{ target: SignalTarget; counts: SignalCountsDto; kinds: SignalKind[] }>()

const LABELS: Record<SignalKind, string> = { me_too: '나도 여기서 막혔어요', helped: '도움됐어요' }
const { loggedIn, mine, setMine } = useMySignals()
const counts = ref<SignalCountsDto>({ ...props.counts })
const busy = ref(false)
const message = ref('')

const pressed = (kind: SignalKind) => mine.value.includes(signalKey(props.target, kind))
const countOf = (kind: SignalKind) => (kind === 'me_too' ? counts.value.meToo : counts.value.helped)

async function toggle(kind: SignalKind) {
  message.value = ''
  if (!loggedIn.value) {
    message.value = 'login'
    return
  }
  busy.value = true
  const on = !pressed(kind)
  try {
    const state = await $fetch<SignalStateDto>('/api/v1/signals', { method: on ? 'PUT' : 'DELETE', body: { target: props.target, kind } })
    counts.value = state.signals
    setMine(signalKey(props.target, 'me_too'), state.mine.meToo)
    setMine(signalKey(props.target, 'helped'), state.mine.helped)
  } catch (error) {
    message.value = courseHubErrorMessage(apiError(error).code)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="signal-buttons">
    <button
      v-for="kind in kinds"
      :key="kind"
      type="button"
      class="secondary small"
      :aria-pressed="pressed(kind)"
      :disabled="busy"
      @click="toggle(kind)"
    >
      {{ LABELS[kind] }} <span aria-hidden="true">·</span> {{ countOf(kind) }}<span v-if="pressed(kind)"> (표시함)</span>
    </button>
    <p v-if="message === 'login'" class="hint" role="status"><NuxtLink to="/login">로그인</NuxtLink>하면 표시할 수 있어요.</p>
    <p v-else-if="message" class="field-error" role="alert">{{ message }}</p>
  </div>
</template>
